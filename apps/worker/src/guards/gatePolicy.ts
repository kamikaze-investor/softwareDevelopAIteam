/**
 * Gate Policy
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * ローカルの processGate() 結果と /api/gate/check のレスポンスを統合し、
 * 最終的な実行ポリシーを決定する純粋関数。
 *
 * 基本方針:
 *   - ローカルリスクが高い場合は API の判断より安全側へ escalate する
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

  // ── 人間承認を使い切る ALLOW（call_consume）── D2（2026-10-17）
  // API Gate は HIGH / CRITICAL を人間承認（ADMIN だけが APPROVED にできる・Job / Task / action /
  // commit / diff に束縛・未失効）へ変換したうえで ALLOW + call_consume を返す。ここで同じ
  // runRiskReview を同じ changedFiles に掛け直して「HIGH だから」と格下げすると、承認済みの
  // git_commit は consume 前に blocked になり、永遠に commit できなかった（D2）。
  // 「承認済みの対象を実行してよいか」の正本は API Gate であり、実行は直後の atomic consume
  // （束縛の再検証・不一致なら STALE / EXPIRED）が成功したときだけ進む。HIGH と CRITICAL は
  // 承認後は同じ扱い（同じ ADMIN 承認・同じ TTL。specs/22 1-3・14-3: Risk Level は誰が判断するかを決めない）。
  // 承認前の CRITICAL（PENDING_APPROVAL / BLOCKED → block_until_approved）は上で処理済みで不変。
  // 承認対象と現在のリスクの食い違い（rule drift）は API 側の risk floor が STALE にする。
  // tuple の整合（ALLOW / continue / 同じ consumedRequestId / APPROVED の approvalRequest）は
  // gateClient が応答検証で強制し、壊れた応答は技術障害としてここへ到達しない。
  if (
    checkResponse.outcome.decision === 'ALLOW' &&
    apiPolicy === 'continue' &&
    checkResponse.nextAction.action === 'call_consume' &&
    typeof checkResponse.nextAction.consumedRequestId === 'string' &&
    checkResponse.nextAction.consumedRequestId.length > 0
  ) {
    return {
      policy: 'continue',
      reason: checkResponse.nextAction.message,
      apiAvailable: true,
    }
  }

  // ── ローカルリスクによる escalation ──
  // API が continue（承認を使わない ALLOW + proceed）でもローカルが HIGH/CRITICAL なら安全側へ上げる
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
