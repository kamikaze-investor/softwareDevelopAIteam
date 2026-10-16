/**
 * Gate Policy
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * ローカルの processGate() 結果と /api/gate/check のレスポンスを統合し、
 * 最終的な実行ポリシーを決定する純粋関数。
 *
 * 基本方針（2026-10-17 D2 で改訂）:
 *   - 「この対象を実行してよいか」の正本は API Gate（承認・人の決定・期限・commit / diff 束縛・
 *     Safety Evidence を全部見て continuationPolicy を返す）。ここではそれを**そのまま写す**。
 *     ローカルのリスク値から実行可否を再判定しない（以前の local escalation は、API が承認済み
 *     ALLOW + call_consume を返した HIGH / CRITICAL の git_commit を consume 前に止めていた: D2。
 *     specs/21 Canonical Semantic Ownership: 重複した意味の持ち主を消す）
 *   - Worker 側で行うのは**消費者側の整合確認**だけ: 応答の項目間の整合（decision / continuationPolicy /
 *     nextAction / consumedRequestId。gateClient が応答検証で全組を強制済みで、ここは二重の防御）と、
 *     ローカルのリスクが API の評価を上回っていないこと（Worker / API の rule の版ずれ）。
 *     どちらかが破れていれば既存の block_until_approved（理由つき）を返す。例外にはしない:
 *     例外は Job を running のまま poll loop へ抜けさせ、見えない停止になる。blocked なら
 *     attention に出て、版が揃った後は既存の resume が出口になる
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
import type { CommandKind, RiskLevel } from '@ai-team/shared'

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

  // ── 消費者側の整合確認（gateClient が全組を検証済み。ここは二重の防御）──
  const incoherence = describeIncoherentGateResponse(checkResponse)
  if (incoherence !== undefined) {
    return {
      policy: 'block_until_approved',
      reason: `incoherent Gate response: ${incoherence}`,
      apiAvailable: true,
    }
  }

  // ── ローカルのリスクが API の評価を上回る ＝ Worker / API の rule の版ずれ ──
  // 実行可否の判定には使わない（API の判断を上書きしない）。食い違う評価のまま実行・safe work・
  // consume をしないよう、既存の block_until_approved で見える形で止める。
  const localRank = riskRank(localResult.finalRiskLevel)
  const apiRank = riskRank(checkResponse.riskReview.riskLevel)
  if (localRank === undefined || apiRank === undefined || localRank > apiRank) {
    return {
      policy: 'block_until_approved',
      reason:
        `risk inconsistency: local ${String(localResult.finalRiskLevel)} > API ${String(checkResponse.riskReview.riskLevel)} ` +
        '(worker/api rule skew)',
      apiAvailable: true,
    }
  }

  const apiPolicy = checkResponse.continuationPolicy

  // ── API の policy をそのまま採用 ──
  const policyMap: Record<ContinuationPolicy, EffectivePolicy> = {
    continue:               'continue',
    continue_safe_work_only: 'continue_safe_work_only',
    block_until_approved:   'block_until_approved',
  }

  const requestId = checkResponse.nextAction.requestId ?? checkResponse.outcome.requestId
  return {
    policy: policyMap[apiPolicy],
    reason: apiPolicy === 'continue'
      ? checkResponse.nextAction.message
      : `${checkResponse.outcome.decision} (${checkResponse.riskReview.riskLevel}): ${checkResponse.nextAction.message}` +
        (requestId ? ` requestId=${requestId}` : ''),
    apiAvailable: true,
  }
}

// 比較専用の順位。Record<RiskLevel, …> なので RiskLevel が増えれば compile で検出される。
const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }

function riskRank(value: unknown): number | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RISK_RANK, value)
    ? RISK_RANK[value as RiskLevel]
    : undefined
}

/**
 * API の gate/check が返しうる組か（computeContinuationPolicy / computeNextAction と同じ対応）。
 *   - ALLOW            → continuationPolicy=continue、nextAction は proceed か call_consume
 *   - call_consume     → decision=ALLOW、consumedRequestId が非空で outcome.consumedRequestId と一致
 *   - PENDING_APPROVAL / BLOCKED / REJECTED → continuationPolicy は continue 以外、nextAction=wait_for_approval
 * STALE / re_check はこの前に処理済み。整合なら undefined、食い違いならその説明を返す。
 */
function describeIncoherentGateResponse(checkResponse: GateCheckResponse): string | undefined {
  const { outcome, nextAction, continuationPolicy } = checkResponse
  const at = ` (decision=${outcome.decision} continuationPolicy=${continuationPolicy} nextAction=${nextAction.action})`
  if (nextAction.action === 'call_consume') {
    if (outcome.decision !== 'ALLOW') return 'call_consume without ALLOW' + at
    if (typeof nextAction.consumedRequestId !== 'string' || nextAction.consumedRequestId.length === 0) {
      return 'call_consume without consumedRequestId' + at
    }
    if (outcome.consumedRequestId !== nextAction.consumedRequestId) return 'consumedRequestId mismatch' + at
  }
  if (outcome.decision === 'ALLOW') {
    if (continuationPolicy !== 'continue') return 'ALLOW without continue' + at
    if (nextAction.action !== 'proceed' && nextAction.action !== 'call_consume') return 'ALLOW with a waiting nextAction' + at
    return undefined
  }
  if (continuationPolicy === 'continue') return `${outcome.decision} with continue` + at
  if (nextAction.action !== 'wait_for_approval') return `${outcome.decision} without wait_for_approval` + at
  return undefined
}
