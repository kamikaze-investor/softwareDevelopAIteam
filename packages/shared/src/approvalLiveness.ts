import type { ApprovalRequest } from './types/approval_gate'

/**
 * **その ApprovalRequest が「いま人の判断を待っている」か。**
 *
 * `status === 'WAITING_FOR_USER'` だけでは足りない。`expires_at` は**参照時の遅延判定**で、
 * 期限切れ行を `EXPIRED` へ進める actor は存在しない（writer は
 * `approveAndResumeJob` / `consumeForJob` / `gate/check` / 承認 PATCH のいずれも request 駆動）。
 * よって「誰も待っていない承認」が `WAITING_FOR_USER` のまま残り続ける。
 *
 * **この関数が expiry 解釈の唯一の出どころである。** API（systemState・resume・abort・集計）と
 * Mobile が同じ事実を別々に判定すると、2026-09-23 の「片方だけ status を見て片方だけ expiry も見る」
 * 不一致と、2026-10-16 監査 A2（期限切れ WAITING が Technical Abort を恒久拒否し、Mobile は
 * Resume ボタンを API と逆に出す）が再発する。新しい expiry 判定を別の場所へ書き足さないこと。
 */
export function isLiveWaitingApproval<T extends Pick<ApprovalRequest, 'status' | 'expiresAt'>>(
  approval: T | undefined,
  nowMs: number = Date.now(),
): approval is T {
  if (approval?.status !== 'WAITING_FOR_USER') return false
  return new Date(approval.expiresAt).getTime() > nowMs
}
