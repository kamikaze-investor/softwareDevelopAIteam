import type { ApprovalRequest } from './types/approval_gate'
import { COMMAND_ZONES } from './types/command'

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

/**
 * **その ApprovalRequest が「使える人の判断（APPROVED）」として生きているか。**
 *
 * `APPROVED` も期限は参照時の遅延判定で、期限切れを `EXPIRED` へ進める actor は居ない。
 * consume 側（`verifyAndConsumeForTaskAction` / `consumeForJob`）は期限切れ・読めない期限を
 * 使わせないので、そのような行はもう誰の authority にもならない。それを「生きた人の判断」と
 * 数えると、Technical Abort のように APPROVED の存在で拒否する経路が恒久的に塞がる（2026-10-16 監査 B-2）。
 * 期限の読み方は `isLiveWaitingApproval` と同じ（読めない期限は live にしない）。
 */
export function isLiveApprovedApproval<T extends Pick<ApprovalRequest, 'status' | 'expiresAt'>>(
  approval: T | undefined,
  nowMs: number = Date.now(),
): approval is T {
  if (approval?.status !== 'APPROVED') return false
  return new Date(approval.expiresAt).getTime() > nowMs
}

/**
 * **その承認行が Technical Abort を止める人の判断か**（H-2 / T-1。precheck と最終 transaction の唯一の判定）。
 *
 * - `WAITING_FOR_USER`: 期限内、**または期限が読めない**なら止める。読めない期限を「生きていない」と
 *   読むと、ここでは fail open になる（人の判断待ちを cleanup で上書きする）。
 * - `APPROVED`: **決定主体が human**（`approval_actor`）で、期限内または期限が読めないときだけ止める。
 *   主体の無い・AI の APPROVED は人の判断ではない。期限切れの APPROVED は consume できず、もう誰の
 *   authority でもない（2026-10-16 監査 B-2）。
 * - `CONSUMED`: cleanup 要求の**後に作られ**、決定主体が human のときだけ止める（承認→消費まで Worker の
 *   報告が届かなかった場合）。cleanup 要求が無い（precheck）ときは数えない。
 * - それ以外の状態は止めない。
 *
 * `approvalActor` は API が `approval_actor` audit から読んだ事実（shared は storage を読まない）。
 */
export function isApprovalBlockingTechnicalAbort(
  approval: Pick<ApprovalRequest, 'status' | 'expiresAt'> & {
    createdAt?: string
    approvalActor?: 'human' | 'ai' | 'unknown'
  },
  context: { nowMs: number; cleanupRequestedAt?: string },
): boolean {
  const expiresMs = Date.parse(approval.expiresAt)
  const liveOrUnreadable = !Number.isFinite(expiresMs) || expiresMs > context.nowMs
  switch (approval.status) {
    case 'WAITING_FOR_USER':
      return liveOrUnreadable
    case 'APPROVED':
      return approval.approvalActor === 'human' && liveOrUnreadable
    case 'CONSUMED':
      return approval.approvalActor === 'human'
        && context.cleanupRequestedAt !== undefined
        && approval.createdAt !== undefined
        && approval.createdAt >= context.cleanupRequestedAt
    default:
      return false
  }
}

/**
 * **その requestedAction が Task 単位の人の判断か**（abort_task / reconcile_external_completion /
 * repair_from_stored_review:* 等）。command kind（git_commit を含む）の承認は commit / diff / Job に
 * 束縛されており、Task 単位ではない。分類の唯一の出どころ（API storage の supersede / 拒否、
 * resume / recover の admission、Mobile が同じ関数を使う）。
 * `requestedAction` が分からない行は Task 単位と見なさない（Job 束縛側として従来どおり扱う）。
 */
export function isTaskScopedApprovalAction(requestedAction: string | undefined): boolean {
  if (requestedAction === undefined) return false
  return !Object.prototype.hasOwnProperty.call(COMMAND_ZONES, requestedAction)
}

/**
 * APPROVED の後も **人が実行する** Task 単位の判断か（abort_task は CEO の /abort、
 * reconcile_external_completion は CEO の reconcile route、repair_from_stored_review:* は再投入の route が使う）。
 * それ以外の Task 単位 APPROVED（retry_job / fail_stuck_job 等）は PL が自分の approval_gate 根拠として
 * 使う承認で、承認後に人を待っているわけではない（Codex round 2）。
 */
export function isHumanExecutedTaskDecision(requestedAction: string | undefined): boolean {
  if (requestedAction === undefined) return false
  return requestedAction === 'abort_task'
    || requestedAction === 'reconcile_external_completion'
    || requestedAction.startsWith('repair_from_stored_review:')
}

/**
 * **人の判断がいま Task を止めている**か: 未期限 WAITING の Task 単位 request（判断そのものを待っている）、
 * または未期限 APPROVED の、人が実行する Task 単位判断（実行を人が待っている）。
 * 人でない resume はこれがある間 `HUMAN_DECISION_PENDING`、systemState は `job_blocked` ではなく
 * `approval_waiting` として見せる。
 */
export function isLiveTaskScopedDecision<
  T extends Pick<ApprovalRequest, 'status' | 'expiresAt'> & { requestedAction?: string },
>(approval: T, nowMs: number = Date.now()): boolean {
  const action = approval.requestedAction
  if (!isTaskScopedApprovalAction(action)) return false
  if (isLiveWaitingApproval(approval, nowMs)) return true
  return isHumanExecutedTaskDecision(action) && isLiveApprovedApproval(approval, nowMs)
}
