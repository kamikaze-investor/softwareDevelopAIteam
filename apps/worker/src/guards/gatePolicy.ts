/**
 * Gate Policy
 *
 * ローカルの processGate() 結果と /api/gate/check のレスポンスを統合し、
 * 最終的な実行ポリシーを決定する純粋関数。
 *
 * 基本方針:
 *   - ローカルリスクが高い場合は API の判断より安全側へ escalate する
 *   - Gate API が落ちている場合も fail closed（安全側）で処理する
 *   - LOW/MEDIUM でも Gate API 不通時は safe work only に落とす
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
  /** Gate API に接続できたか。false の場合はローカルリスクのみで判断している */
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
 * @param localResult  processGate() の結果（必須）
 * @param checkResponse  /api/gate/check のレスポンス（API 通信成功時）
 * @param apiError  API 通信失敗時のエラー（checkResponse が undefined の場合）
 */
export function resolvePolicy(
  localResult: GateResult,
  checkResponse?: GateCheckResponse,
  apiError?: unknown,
): ResolvePolicyResult {
  // ── API 通信失敗時: fail closed ──
  if (apiError !== undefined || checkResponse === undefined) {
    const reason = apiError instanceof Error
      ? `Gate API unavailable: ${apiError.message}`
      : 'Gate API unavailable'

    if (localResult.finalRiskLevel === 'CRITICAL') {
      return { policy: 'block_until_approved', reason, apiAvailable: false }
    }
    // LOW / MEDIUM / HIGH: safe work only に落とす（完全 continue にしない）
    return { policy: 'continue_safe_work_only', reason, apiAvailable: false }
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

  // ── ローカルリスクによる escalation ──
  // API が continue でもローカルが HIGH/CRITICAL なら安全側へ上げる
  if (apiPolicy === 'continue') {
    if (localResult.finalRiskLevel === 'CRITICAL') {
      return {
        policy: 'block_until_approved',
        reason: `Local analysis: CRITICAL risk (${localResult.reason ?? 'no reason'}). Escalating from API 'continue'.`,
        apiAvailable: true,
      }
    }
    if (localResult.finalRiskLevel === 'HIGH') {
      return {
        policy: 'continue_safe_work_only',
        reason: `Local analysis: HIGH risk (${localResult.reason ?? 'no reason'}). Escalating from API 'continue'.`,
        apiAvailable: true,
      }
    }
  }

  if (apiPolicy === 'continue_safe_work_only' && localResult.finalRiskLevel === 'CRITICAL') {
    return {
      policy: 'block_until_approved',
      reason: `Local analysis: CRITICAL risk (${localResult.reason ?? 'no reason'}). Escalating from API 'continue_safe_work_only'.`,
      apiAvailable: true,
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
