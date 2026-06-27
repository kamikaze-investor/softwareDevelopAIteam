/**
 * Approval Gate
 *
 * 純粋関数群は packages/shared/src/approvalGateLogic.ts に移動済み。
 * このファイルは既存の import インターフェースを維持するための re-export のみ。
 *
 * 設計原則（詳細は shared/approvalGateLogic.ts を参照）:
 *   - 承認は「未来の権限」ではなく「特定 commit/diff に対する一回限りの許可」
 *   - 承認後に commit/diff が変わった場合は STALE として無効化する
 *   - LOW/MEDIUM は自動継続。HIGH/CRITICAL は人間承認が必要
 *   - 承認待ち中も安全な作業（LOW/MEDIUM）は継続可能
 *   - レビュー不能・承認待ちを APPROVED 扱いしない
 */

export {
  runRiskReview,
  computeDiffHash,
  resolveEffectiveStatus,
  decideGateOutcome,
  buildApprovalRequest,
} from '@ai-team/shared'
