/**
 * Gate Policy
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * ローカルの processGate() 結果と /api/gate/check のレスポンスを統合し、
 * 最終的な実行ポリシーを決定する純粋関数。
 *
 * 基本方針:
 *   - 実行可否の正本は API の Gate 判断（承認状態を知っているのは API だけ）。ローカルの GateResult は
 *     production では runRiskReview だけから作られる（processGate / AlignmentReport は通らない）
 *   - API と食い違ったとき（ルールの版ずれ・承認契約違反・不正な riskLevel）だけ fail-closed で止める。
 *     承認済み（ALLOW + call_consume）の HIGH / CRITICAL を一律に止めることはしない（lifecycle repair D2）
 *   - **有効な Gate レスポンスがあるときだけ呼ぶ**
 *
 * 【技術障害の扱い（2026-08-01 変更）】
 * 以前はここで `apiError` を受け取り、API 不通を `continue_safe_work_only`
 * （CRITICAL のみ `block_until_approved`）へ縮退させていた。しかしこれは
 *   - 認証失敗・API 停止でも safe work を継続してしまう
 *   - 技術障害を「CEO 承認待ち」として通知してしまう
 * という問題があった。現在、Gate API の技術障害は呼び出し元（jobRunner）が
 * Job を failed で停止させ、この関数へは到達しない。
 * よってこの関数は **成功した Gate レスポンスの解釈だけ**を責務とする。
 */

import type { GateResult } from './gateProcessor.js'
import type { GateCheckResponse, ContinuationPolicy } from './gateClient.js'
import type { CommandKind } from '@ai-team/shared'

// ────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────

export type EffectivePolicy =
  | 'continue'
  | 'continue_safe_work_only'
  | 'block_until_approved'
  | 're_check'

export interface ResolvePolicyResult {
  policy: EffectivePolicy
  reason: string
  /**
   * Gate API の有効なレスポンスに基づく判断か。
   * この関数は成功レスポンスがある場合しか呼ばれないため常に true になる
   * （API 不通時にローカルリスクだけで縮退判断する経路は 2026-08-01 に撤去した）。
   */
  apiAvailable: boolean
  /**
   * Worker と API の Gate 判断が食い違ったため fail-closed で止めたときの技術的な原因。
   * 人の承認待ちではないので、呼び出し元は承認待ちとして通知しない。
   */
  technicalCause?: GateTechnicalCause
}

export type GateTechnicalCause = 'risk_rule_skew' | 'approval_contract_violation' | 'invalid_risk_level'

const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const

/** 既知の RiskLevel だけを順位に写す（prototype のキー等は undefined）。 */
function riskOrder(level: unknown): number | undefined {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(RISK_ORDER, level)
    ? RISK_ORDER[level as keyof typeof RISK_ORDER]
    : undefined
}

// ────────────────────────────────────────────────────────────
// Safe work 定義
// ────────────────────────────────────────────────────────────

/**
 * safe work only 時に許可する CommandKind。
 * 読み取り・テスト・品質チェックのみ。コード変更・commit は禁止。
 */
export const SAFE_WORK_ALLOWED_COMMAND_KINDS: readonly CommandKind[] = [
  'git_status',
  'git_diff',
  'git_log',
  'typecheck',
  'test',
  'lint',
] as const

// ────────────────────────────────────────────────────────────
// resolvePolicy
// ────────────────────────────────────────────────────────────

/**
 * ローカル GateResult と API GateCheckResponse を統合し最終ポリシーを返す。
 *
 * @param localResult  processGate() の結果（必須）
 * @param checkResponse  /api/gate/check の**成功**レスポンス（必須）。
 *   API 通信失敗・認証失敗・不正レスポンスの場合は呼び出さず、
 *   呼び出し元が技術障害として Job を failed にすること。
 */
export function resolvePolicy(
  localResult: GateResult,
  checkResponse: GateCheckResponse,
): ResolvePolicyResult {
  // 有効なレスポンスなしでポリシーを決めない。
  // 型の上では到達しないが、JS からの誤用でも安全側（例外）へ倒す。
  if (checkResponse === undefined || checkResponse === null) {
    throw new Error(
      'resolvePolicy: checkResponse is required. ' +
      'Gate API failures must be handled as technical failures by the caller, not degraded into a policy.',
    )
  }

  // ── STALE / re_check ──
  if (
    checkResponse.outcome.decision === 'STALE' ||
    checkResponse.nextAction.action === 're_check'
  ) {
    return {
      policy: 're_check',
      reason: 'Approval is stale. Re-run gate/check to start a new approval flow.',
      apiAvailable: true,
    }
  }

  // ── API の continuationPolicy をベースにする ──
  const apiPolicy = checkResponse.continuationPolicy
  const apiRisk = checkResponse.riskReview.riskLevel as string

  // ── Worker 側に残す防御（lifecycle repair D2） ──
  // ローカルリスクは API と同じ runRiskReview を同じ changedFiles に掛けた値なので、
  // 「API が continue なのにローカルが HIGH 以上」は、人が承認して API が ALLOW + call_consume を
  // 返したときにしか起きなかった。ここで一律に上げると、承認済みの HIGH / CRITICAL が consume まで
  // 届かず永久に止まる（D2）。Worker に残すのは API の判断と食い違ったときの fail-closed だけである。
  // **どの decision でも**（PENDING_APPROVAL / BLOCKED を含む）先に評価する:
  //   - API の riskLevel が不正                          → re_check（invalid_risk_level）
  //   - ローカル CRITICAL > API（ルールの版ずれ）        → re_check（risk_rule_skew）
  //   - API CRITICAL を承認の consume なしに続行させる    → re_check（approval_contract_violation）
  //     （API の契約上 CRITICAL は block_until_approved か、承認済み ALLOW + call_consume しか無い）
  //   - API HIGH を承認の consume なしに continue させる → re_check（approval_contract_violation）
  //   - ローカル HIGH > API で API が continue           → continue_safe_work_only（risk_rule_skew）
  // 止める範囲は従来以上で、承認待ち（block_until_approved）には見せない。
  // ローカルが未知の値なら CRITICAL とみなす（fail-closed）
  const localOrder = riskOrder(localResult.finalRiskLevel) ?? RISK_ORDER.CRITICAL
  const apiOrder = riskOrder(apiRisk)
  if (apiOrder === undefined) {
    return {
      policy: 're_check',
      reason: `invalid_risk_level: api=${apiRisk} decision=${checkResponse.outcome.decision}`,
      apiAvailable: true,
      technicalCause: 'invalid_risk_level',
    }
  }

  const skewReason =
    `risk_rule_skew: local=${localResult.finalRiskLevel} api=${apiRisk} decision=${checkResponse.outcome.decision}`
    + ` (${localResult.reason ?? 'no reason'})`
  if (localOrder > apiOrder && localOrder >= RISK_ORDER.CRITICAL) {
    return { policy: 're_check', reason: skewReason, apiAvailable: true, technicalCause: 'risk_rule_skew' }
  }

  const isApprovedConsume =
    checkResponse.outcome.decision === 'ALLOW'
    && checkResponse.nextAction.action === 'call_consume'
    && typeof checkResponse.nextAction.consumedRequestId === 'string'
    && checkResponse.nextAction.consumedRequestId.length > 0
  const contractViolation =
    !isApprovedConsume
    && (
      (apiOrder >= RISK_ORDER.CRITICAL && apiPolicy !== 'block_until_approved')
      || (apiOrder >= RISK_ORDER.HIGH && apiPolicy === 'continue')
    )
  if (contractViolation) {
    return {
      policy: 're_check',
      reason:
        `approval_contract_violation: api=${apiRisk} policy=${apiPolicy}`
        + ` decision=${checkResponse.outcome.decision} action=${checkResponse.nextAction.action}`,
      apiAvailable: true,
      technicalCause: 'approval_contract_violation',
    }
  }

  // PENDING_APPROVAL の場合はリスクレベルで分岐
  if (
    checkResponse.outcome.decision === 'PENDING_APPROVAL' ||
    checkResponse.outcome.decision === 'BLOCKED'
  ) {
    if (apiRisk === 'CRITICAL') {
      return {
        policy: 'block_until_approved',
        reason: `${checkResponse.outcome.decision}: CRITICAL risk — waiting for CEO approval. requestId=${checkResponse.nextAction.requestId ?? checkResponse.outcome.requestId ?? ''}`,
        apiAvailable: true,
      }
    }
    // HIGH: safe work のみ継続
    return {
      policy: 'continue_safe_work_only',
      reason: `${checkResponse.outcome.decision}: HIGH risk — safe work only until approved. requestId=${checkResponse.nextAction.requestId ?? checkResponse.outcome.requestId ?? ''}`,
      apiAvailable: true,
    }
  }

  // ローカル HIGH > API で API が continue（ルールの版ずれ）→ 従来どおり safe work だけに絞る
  if (localOrder > apiOrder && localOrder >= RISK_ORDER.HIGH && apiPolicy === 'continue') {
    return {
      policy: 'continue_safe_work_only',
      reason: skewReason,
      apiAvailable: true,
      technicalCause: 'risk_rule_skew',
    }
  }

  // ── API の policy をそのまま採用 ──
  const policyMap: Record<ContinuationPolicy, EffectivePolicy> = {
    continue:               'continue',
    continue_safe_work_only: 'continue_safe_work_only',
    block_until_approved:   'block_until_approved',
  }

  return {
    policy: policyMap[apiPolicy],
    reason: checkResponse.nextAction.message,
    apiAvailable: true,
  }
}
