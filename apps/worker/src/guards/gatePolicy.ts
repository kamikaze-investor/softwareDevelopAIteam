/**
 * Gate Policy
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * ローカルの processGate() 結果と /api/gate/check のレスポンスを統合し、
 * 最終的な実行ポリシーを決定する純粋関数。
 *
 * 基本方針（2026-10-17 D2 v4 で改訂）:
 *   - 「承認済みの対象を実行してよいか」の正本は API Gate。ALLOW（proceed / call_consume）を
 *     ローカルの HIGH / CRITICAL で格下げしない（以前の local escalation は、承認済み ALLOW + call_consume の
 *     HIGH / CRITICAL git_commit を consume 前に止めていた: D2）。実行は直後の atomic consume が成功したときだけ進む
 *   - ローカルのリスクが API の評価より高い（Worker / API の rule の版ずれ。ローカルの過小評価は fail closed）か、
 *     応答の decision / continuationPolicy / nextAction の組が API の契約に無いときは、**承認の判断ではなく
 *     技術的な不整合**として re_check で止める（理由コード risk_rule_skew / approval_contract_violation。
 *     `@ai-team/shared` の GATE_TECHNICAL_STOP_CODES）。block_until_approved（＝承認待ち通知）にも
 *     safe work にもしない。新しい safe work の経路を足さない
 *   - それ以外の PENDING_APPROVAL / BLOCKED / REJECTED の扱いは従来どおり
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
import type { CommandKind, GateTechnicalStopCode, RiskLevel } from '@ai-team/shared'

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
 * 判定順（D2 v4）:
 *   1. 応答の組の整合（崩れていれば re_check approval_contract_violation）
 *   2. STALE → re_check（従来どおり）
 *   3. ローカルのリスク > API のリスク → re_check risk_rule_skew（continue でも非 continue でも、safe work より前）
 *   4. continue（ALLOW）→ continue。非 continue → 従来の PENDING / BLOCKED / REJECTED の扱い
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

  const { outcome, nextAction, continuationPolicy: apiPolicy } = checkResponse

  // ── 1. 応答の組の整合 ──
  // 崩れた組を写すと誤った「承認待ち」や実行になる。承認の判断ではないので block_until_approved にはしない。
  if (!isCoherentGateResponse(checkResponse)) {
    return technicalStop(
      'approval_contract_violation',
      `decision=${outcome.decision} continuationPolicy=${apiPolicy} nextAction=${nextAction.action}`,
    )
  }

  // ── 2. STALE ──
  if (outcome.decision === 'STALE') {
    return {
      policy: 're_check',
      reason: 'Approval is stale. Re-run gate/check to start a new approval flow.',
      apiAvailable: true,
    }
  }

  // ── 3. ローカルのリスク > API のリスク（Worker / API の rule の版ずれ）──
  // 実行可否の判定には使わない。食い違う評価のまま実行・safe work・consume をしない。
  const localRisk = localResult.finalRiskLevel
  const apiRisk = checkResponse.riskReview.riskLevel as RiskLevel
  if (RISK_RANK[localRisk] > RISK_RANK[apiRisk]) {
    return technicalStop('risk_rule_skew', `local ${localRisk} > API ${apiRisk} (worker/api rule skew)`)
  }

  // ── 4a. continue（ALLOW）── 承認済み（call_consume）も Evidence / LOW（proceed）も API の判断どおり続ける
  if (apiPolicy === 'continue') {
    return {
      policy: 'continue',
      reason: nextAction.message,
      apiAvailable: true,
    }
  }

  // ── 4b. PENDING_APPROVAL / BLOCKED はリスクレベルで分岐（従来どおり）──
  const requestId = nextAction.requestId ?? outcome.requestId ?? ''
  if (outcome.decision === 'PENDING_APPROVAL' || outcome.decision === 'BLOCKED') {
    if (apiRisk === 'CRITICAL') {
      return {
        policy: 'block_until_approved',
        reason: `${outcome.decision}: CRITICAL risk — waiting for CEO approval. requestId=${requestId}`,
        apiAvailable: true,
      }
    }
    // HIGH（および policy 起因で承認必須の LOW / MEDIUM）: safe work のみ継続
    return {
      policy: 'continue_safe_work_only',
      reason: `${outcome.decision}: ${apiRisk} risk — safe work only until approved. requestId=${requestId}`,
      apiAvailable: true,
    }
  }

  // ── 4c. REJECTED: API の policy を採用。safe work only でもローカルが CRITICAL なら止める（従来どおり）──
  if (apiPolicy === 'continue_safe_work_only' && localRisk === 'CRITICAL') {
    return {
      policy: 'block_until_approved',
      reason: `Local analysis: CRITICAL risk (${localResult.reason ?? 'no reason'}). Escalating from API 'continue_safe_work_only'.`,
      apiAvailable: true,
    }
  }

  const policyMap: Record<ContinuationPolicy, EffectivePolicy> = {
    continue:               'continue',
    continue_safe_work_only: 'continue_safe_work_only',
    block_until_approved:   'block_until_approved',
  }

  return {
    policy: policyMap[apiPolicy],
    reason: nextAction.message,
    apiAvailable: true,
  }
}

// 比較専用の順位。Record<RiskLevel, …> なので RiskLevel が増えれば compile で検出される。
// 値の妥当性（既知の RiskLevel か）は gateClient の応答検証が保証する。
const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }

/** 技術的な不整合による停止（re_check）。理由は `<code>: ...` で始め、Worker が stderr に残す。 */
function technicalStop(code: GateTechnicalStopCode, detail: string): ResolvePolicyResult {
  return {
    policy: 're_check',
    reason: `${code}: ${detail}; technical Gate inconsistency, not an approval decision`,
    apiAvailable: true,
  }
}

/**
 * API の gate/check が返しうる組か（computeContinuationPolicy / computeNextAction と同じ対応）。
 *   - ALLOW                       → continue + (call_consume | proceed は riskLevel が LOW / MEDIUM のときだけ)
 *   - PENDING_APPROVAL / BLOCKED  → wait_for_approval + (continue_safe_work_only | block_until_approved)
 *   - REJECTED                    → wait_for_approval + (continue_safe_work_only | block_until_approved)
 *   - STALE                       → re_check
 *   - outcome.riskLevel があれば riskReview.riskLevel と一致すること
 * call_consume の id 一致・RiskLevel の妥当性は gateClient が応答検証で保証する。
 */
function isCoherentGateResponse(checkResponse: GateCheckResponse): boolean {
  const decision = checkResponse.outcome.decision
  const policy = checkResponse.continuationPolicy
  const action = checkResponse.nextAction.action
  // API は outcome.riskLevel を riskReview.riskLevel と同じ値で返す（decideGateOutcome）。両方あって食い違うなら契約外。
  const outcomeRisk = checkResponse.outcome.riskLevel
  if (outcomeRisk !== undefined && outcomeRisk !== checkResponse.riskReview.riskLevel) return false
  switch (decision) {
    case 'ALLOW': {
      if (policy !== 'continue') return false
      if (action === 'call_consume') return true
      // HIGH / CRITICAL の ALLOW は承認を使い切るとき（call_consume）だけ。decideGateOutcome は HIGH / CRITICAL を
      // consumedRequestId 付きでしか ALLOW しない。HIGH / CRITICAL の ALLOW + proceed は consume 無しの実行になるので契約外。
      const risk = checkResponse.riskReview.riskLevel
      return action === 'proceed' && (risk === 'LOW' || risk === 'MEDIUM')
    }
    case 'PENDING_APPROVAL':
    case 'BLOCKED':
    case 'REJECTED':
      return action === 'wait_for_approval'
        && (policy === 'continue_safe_work_only' || policy === 'block_until_approved')
    case 'STALE':
      return action === 're_check'
    default:
      return false
  }
}
