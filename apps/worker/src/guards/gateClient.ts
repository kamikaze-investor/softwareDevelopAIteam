/**
 * Gate Client
 *
 * worker 側から Approval Gate API を呼ぶための HTTP クライアント。
 * gateProcessor.ts 本体は純粋関数のまま維持し、このファイルが HTTP 通信を担う。
 *
 * 接続先:
 *   POST /api/gate/check
 *   POST /api/approval-requests/:id/consume
 */

import type { AgentId, RoleId, ActionType } from '@ai-team/shared'

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000'
const FETCH_TIMEOUT_MS = 10_000

// ────────────────────────────────────────────────────────────
// Error
// ────────────────────────────────────────────────────────────

export class GateClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GateClientError'
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

export type GateOutcomeDecision = 'ALLOW' | 'PENDING_APPROVAL' | 'BLOCKED' | 'STALE'
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
// callGateCheck
// ────────────────────────────────────────────────────────────

/**
 * POST /api/gate/check を呼び出してリスク判定と継続方針を取得する。
 * 通信失敗・非 2xx は GateClientError をスロー（fail closed）。
 */
export async function callGateCheck(params: GateCheckParams): Promise<GateCheckResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}/api/gate/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    throw new GateClientError(
      `gate/check: network error — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  clearTimeout(timer)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new GateClientError(`gate/check: HTTP ${res.status} — ${text}`)
  }

  const body = await res.json() as GateCheckResponse
  logActorAction('gate_check', params.taskId, body.outcome.decision)
  return body
}

// ────────────────────────────────────────────────────────────
// callConsume
// ────────────────────────────────────────────────────────────

/**
 * POST /api/approval-requests/:id/consume を呼び出して承認を使用済みにする。
 *
 * - 409 + status='CONSUMED': 二重 consume。警告ログ + alreadyConsumed=true を返す（継続可）
 * - 409 その他 / 404 / ネットワーク失敗: GateClientError をスロー（fail closed）
 */
export async function callConsume(requestId: string, params: ConsumeParams): Promise<ConsumeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(
      `${API_BASE_URL}/api/approval-requests/${encodeURIComponent(requestId)}/consume`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      },
    )
  } catch (err) {
    clearTimeout(timer)
    throw new GateClientError(
      `consume(${requestId}): network error — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  clearTimeout(timer)

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
    throw new GateClientError(`consume(${requestId}): HTTP 409 — ${errMsg}`)
  }

  if (res.status === 404) {
    throw new GateClientError(`consume(${requestId}): HTTP 404 — approval request not found`)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new GateClientError(`consume(${requestId}): HTTP ${res.status} — ${text}`)
  }

  const data = await res.json().catch(() => undefined)
  logActorAction('consume_approval', requestId, 'consumed')
  return { ok: true, data }
}
