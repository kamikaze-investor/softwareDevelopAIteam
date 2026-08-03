/**
 * Gate Client
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * worker 側から Approval Gate API を呼ぶための HTTP クライアント。
 * gateProcessor.ts 本体は純粋関数のまま維持し、このファイルが HTTP 通信を担う。
 *
 * 接続先:
 *   POST /api/gate/check
 *   POST /api/approval-requests/:id/consume
 *
 * 【技術障害と業務上の拒否の分離（2026-08-01）】
 * 通信障害・認証失敗・不正レスポンスを「承認待ち」へ変換しない。
 * `GateClientError.technicalFailure` で両者を区別し、呼び出し元（jobRunner）は
 *   - technicalFailure=true  → Job を failed（CEO 承認待ちとして通知しない）
 *   - technicalFailure=false → 既存の業務上の blocked（承認フロー）
 * として扱う。既定は true（未知の失敗は安全側＝自動 resume されない failed へ倒す）。
 */

import type { AgentId, RoleId, ActionType, RiskLevel } from '@ai-team/shared'
import { buildApiAuthHeaders } from '../utils/apiAuth.js'

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000'
const FETCH_TIMEOUT_MS = 10_000

// ────────────────────────────────────────────────────────────
// Error
// ────────────────────────────────────────────────────────────

interface GateClientErrorOptions extends ErrorOptions {
  /**
   * false のとき、API 契約上意味を持つ業務上の拒否（consume の 404 / 409 等）。
   * 省略時は技術障害として扱う（未知の失敗を承認フローへ流さない）。
   */
  technicalFailure?: boolean
}

export class GateClientError extends Error {
  /** 技術障害（通信・認証・タイムアウト・不正レスポンス）か */
  readonly technicalFailure: boolean

  constructor(message: string, options?: GateClientErrorOptions) {
    super(message, options)
    this.name = 'GateClientError'
    this.technicalFailure = options?.technicalFailure ?? true
  }
}

// ────────────────────────────────────────────────────────────
// 入力型
// ────────────────────────────────────────────────────────────

export interface GateCheckParams {
  taskId: string
  requestedAction: string
  targetBranch: string
  targetCommit: string
  targetDiffHash: string
  changedFiles: string[]
  /** 省略可能。送る場合はサーバー側でハッシュ照合される */
  diffText?: string
}

export interface ConsumeParams {
  currentCommit: string
  currentDiffHash: string
}

// ────────────────────────────────────────────────────────────
// レスポンス型（API の GateCheckResponse に対応）
// ────────────────────────────────────────────────────────────

// 'REJECTED' は API 側（routes/approvalGate.ts の computeNextAction）が実際に返しうる。
// 従来この型に含まれていなかったが、実挙動では policyMap 経由の一般経路を通っていたため
// 型だけが実態と乖離していた。schema 検証を入れるにあたり実態へ揃える（挙動は不変）。
export type GateOutcomeDecision = 'ALLOW' | 'PENDING_APPROVAL' | 'BLOCKED' | 'STALE' | 'REJECTED'
export type ContinuationPolicy = 'continue' | 'continue_safe_work_only' | 'block_until_approved'
export type NextActionKind = 'proceed' | 'call_consume' | 'wait_for_approval' | 're_check'

export interface GateCheckResponse {
  outcome: {
    decision: GateOutcomeDecision
    riskLevel?: string
    consumedRequestId?: string
    requestId?: string
    reason?: string
  }
  riskReview: {
    riskLevel: string
    triggeredRules: string[]
    requiresIndependentReview: boolean
  }
  sideEffects: Array<{
    type: string
    requestId: string
  }>
  continuationPolicy: ContinuationPolicy
  nextAction: {
    action: NextActionKind
    consumedRequestId?: string
    requestId?: string
    message: string
  }
  approvalRequest?: {
    id: string
    status: string
    expiresAt: string
    riskLevel: string
  }
}

export interface ConsumeResult {
  ok: boolean
  alreadyConsumed?: boolean
  data?: unknown
}

// ────────────────────────────────────────────────────────────
// ログ出力（ActorContext 形式）
// ────────────────────────────────────────────────────────────

function logActorAction(
  action: ActionType,
  targetId: string,
  result: string,
): void {
  const actor: AgentId = 'system'
  const role: RoleId = 'System'
  console.log(JSON.stringify({
    actor,
    role,
    action,
    targetId,
    result,
    timestamp: new Date().toISOString(),
  }))
}

// ────────────────────────────────────────────────────────────
// レスポンス形式の局所検証
//
// `res.json()` が成功しただけで型 cast すると、API が別形式を 200 で返した場合に
// undefined を含む値が Gate 判断へ流れ込む。判定に実際に使うフィールドだけを
// 検査する（共通 schema 基盤は作らない）。
// ────────────────────────────────────────────────────────────

const GATE_DECISIONS: readonly string[] = ['ALLOW', 'PENDING_APPROVAL', 'BLOCKED', 'STALE', 'REJECTED']
const CONTINUATION_POLICIES: readonly string[] = ['continue', 'continue_safe_work_only', 'block_until_approved']
const NEXT_ACTIONS: readonly string[] = ['proceed', 'call_consume', 'wait_for_approval', 're_check']
// RiskLevel（@ai-team/shared）にはランタイム定数が存在しないため、ここが唯一の定義。
// 型 `RiskLevel` を import して compile 時に食い違いが検出されるようにする
// （他ファイルへ複製しない。gatePolicy 側は文字列比較のみで独自定義を持たない）。
const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function isValidRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
}

/**
 * gatePolicy / jobRunner が実際に読むフィールドだけを検証する。
 *
 * 【2026-08-01 強化】`riskReview.riskLevel` は「文字列であること」だけでなく
 * 既知の `RiskLevel` 値であることまで確認する。任意文字列を許可すると、
 * gatePolicy.ts の escalation 判定（`=== 'CRITICAL'` 等）が全て false になり、
 * 本来 escalate すべき壊れたレスポンスが `continue`/`safe_work_only` へ
 * すり抜けてしまう。
 *
 * `nextAction.action === 'call_consume'` のときは `consumedRequestId` が
 * 有効な非空文字列であることも必須にする。欠落すると jobRunner が
 * consume 対象を特定できないまま `blocked` + CEO 通知へ進んでしまうため
 * （technical failure として弾く）。
 */
function isGateCheckResponse(value: unknown): value is GateCheckResponse {
  const v = asRecord(value)
  if (!v) return false

  const outcome = asRecord(v.outcome)
  if (!outcome || typeof outcome.decision !== 'string') return false
  if (!GATE_DECISIONS.includes(outcome.decision)) return false
  if (outcome.riskLevel !== undefined && !isValidRiskLevel(outcome.riskLevel)) return false

  const riskReview = asRecord(v.riskReview)
  if (!riskReview || !isValidRiskLevel(riskReview.riskLevel)) return false

  if (typeof v.continuationPolicy !== 'string') return false
  if (!CONTINUATION_POLICIES.includes(v.continuationPolicy)) return false

  const nextAction = asRecord(v.nextAction)
  if (!nextAction || typeof nextAction.action !== 'string') return false
  if (!NEXT_ACTIONS.includes(nextAction.action)) return false
  if (typeof nextAction.message !== 'string') return false

  if (nextAction.action === 'call_consume') {
    if (typeof nextAction.consumedRequestId !== 'string' || nextAction.consumedRequestId.length === 0) {
      return false
    }
  }

  return true
}

/**
 * consume 成功レスポンスの検証。
 *
 * `status === 'CONSUMED'` まで確認する。ここを緩めると、200 でも実際には
 * 消費されていない（更新対象が見つからず undefined が返る等）ケースを
 * 「消費済み」として通してしまう。
 *
 * 【2026-08-01 強化】`id` が要求した `requestId` と一致することも確認する。
 * id だけを「文字列であること」で通すと、別の（無関係な）承認リクエストの
 * 更新結果を「この consume は成功した」として受理してしまう。
 */
function isConsumedApprovalRequest(value: unknown, requestId: string): boolean {
  const v = asRecord(value)
  if (!v) return false
  return v.id === requestId && v.status === 'CONSUMED'
}

/**
 * fetch エラーを固定分類へ変換する。
 *
 * 【2026-08-01 追加】`err.message` をそのまま例外メッセージへ入れると、
 * 環境依存の詳細（DNS 解決失敗の理由等）が漏れる可能性がある。
 * API 応答本文・Authorization header・token を例外メッセージへ含めないため、
 * 固定文字列だけを使う（permissionGuard.ts の classifyFetchError と同じ方針）。
 */
function classifyFetchError(err: unknown): 'timeout' | 'invalid_json' | 'network_error' {
  if (err instanceof Error && err.name === 'AbortError') return 'timeout'
  if (err instanceof SyntaxError) return 'invalid_json'
  return 'network_error'
}

// ────────────────────────────────────────────────────────────
// callGateCheck
// ────────────────────────────────────────────────────────────

/**
 * POST /api/gate/check を呼び出してリスク判定と継続方針を取得する。
 *
 * 実 route 契約（`apps/api/src/routes/approvalGate.ts`）: 200 / 400（validation）のみ。
 * 404・409 のような業務上の意味を持つ status は定義されていない。
 * よって **200 + JSON parse 成功 + 期待 schema 一致**のときだけ Gate 判断を返し、
 * それ以外は全て技術障害（technicalFailure=true）としてスローする。
 * 呼び出し元は safe work 継続や承認待ちへ変換してはならない。
 */
export async function callGateCheck(params: GateCheckParams): Promise<GateCheckResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    let res: Response
    try {
      res = await fetch(`${API_BASE_URL}/api/gate/check`, {
        method: 'POST',
        headers: { ...buildApiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      })
    } catch (err) {
      throw new GateClientError(`gate/check: ${classifyFetchError(err)}`, { cause: err })
    }

    // レスポンス本文はエラーメッセージへ含めない（認証情報が混入する経路を作らない）
    if (res.status !== 200) {
      throw new GateClientError(`gate/check: HTTP ${res.status}`)
    }

    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      throw new GateClientError(`gate/check: ${classifyFetchError(err)}`, { cause: err })
    }

    if (!isGateCheckResponse(body)) {
      throw new GateClientError('gate/check: invalid response (unexpected shape)')
    }

    logActorAction('gate_check', params.taskId, body.outcome.decision)
    return body
  } finally {
    // timeout は本文読み取り・schema 検証が終わるまで有効にする
    clearTimeout(timer)
  }
}

// ────────────────────────────────────────────────────────────
// callConsume
// ────────────────────────────────────────────────────────────

/**
 * POST /api/approval-requests/:id/consume を呼び出して承認を使用済みにする。
 *
 * 実 route 契約（`apps/api/src/routes/approvalGate.ts`）:
 *   404 → approval request 不存在        : **業務上の block**（technicalFailure=false）
 *   409 → 非APPROVED / 期限切れ / stale    : **業務上の block**（technicalFailure=false）
 *   409 + status='CONSUMED'               : 二重 consume。冪等成功として継続（既存動作）
 *   200 → 更新後の ApprovalRequest        : 成功（status='CONSUMED' まで確認する）
 *   上記以外（400 / 401 / 403 / 429 / 5xx / 通信障害 / 不正 JSON / schema 不一致）
 *                                         : **技術障害**（technicalFailure=true）
 *
 * consume の結果を確認できない場合は、消費済みとみなして継続してはならない。
 */
export async function callConsume(requestId: string, params: ConsumeParams): Promise<ConsumeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    let res: Response
    try {
      res = await fetch(
        `${API_BASE_URL}/api/approval-requests/${encodeURIComponent(requestId)}/consume`,
        {
          method: 'POST',
          headers: { ...buildApiAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal,
        },
      )
    } catch (err) {
      throw new GateClientError(`consume(${requestId}): ${classifyFetchError(err)}`, { cause: err })
    }

    // ── API 契約上の意味を持つ status（業務上の block） ──
    // 409 の JSON parse 失敗時の扱い（{} へフォールバック）は今回のclosure対象外。
    // 既存どおり維持する。
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      const errMsg = body.error ?? ''

      // 二重 consume: "Cannot consume: current status is 'CONSUMED'"
      if (errMsg.includes("'CONSUMED'")) {
        console.warn(`[gateClient] consume(${requestId}): already consumed (ignoring)`)
        logActorAction('consume_approval', requestId, 'already_consumed')
        return { ok: true, alreadyConsumed: true }
      }

      // それ以外の 409 (expired / stale / non-APPROVED)
      throw new GateClientError(
        `consume(${requestId}): HTTP 409 — ${errMsg}`,
        { technicalFailure: false },
      )
    }

    if (res.status === 404) {
      throw new GateClientError(
        `consume(${requestId}): HTTP 404 — approval request not found`,
        { technicalFailure: false },
      )
    }

    // ── 上記以外の非 200 は全て技術障害 ──
    // レスポンス本文はエラーメッセージへ含めない（認証情報が混入する経路を作らない）
    if (res.status !== 200) {
      throw new GateClientError(`consume(${requestId}): HTTP ${res.status}`)
    }

    let data: unknown
    try {
      data = await res.json()
    } catch (err) {
      throw new GateClientError(`consume(${requestId}): ${classifyFetchError(err)}`, { cause: err })
    }

    if (!isConsumedApprovalRequest(data, requestId)) {
      throw new GateClientError(
        `consume(${requestId}): invalid response (consumption unconfirmed)`,
      )
    }

    logActorAction('consume_approval', requestId, 'consumed')
    return { ok: true, data }
  } finally {
    // timeout は本文読み取り・schema 検証が終わるまで有効にする
    clearTimeout(timer)
  }
}
