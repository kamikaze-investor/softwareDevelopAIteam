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
 * 承認の決定主体（API が `approval_actor` audit から読んだ事実。`readApprovalActorClass()` の結果）。
 * **shared の純関数は storage を読まない。** API がこの事実を計算して渡す（Mobile へは
 * `TaskDetail.humanTaskDecisions` として届く）。渡されない（undefined）行は human ではない。
 */
export type ApprovalActorFact = 'human' | 'ai' | 'unknown'

/** Task 単位の人の判断の判定に使う入力。`approvalActor` は API が付ける型付きの事実。 */
export type TaskDecisionApprovalInput = Pick<ApprovalRequest, 'status' | 'expiresAt'> & {
  requestedAction?: string
  approvalActor?: ApprovalActorFact
}

/** 生きた Task 単位の人の判断の状態。waiting = 判断を待っている / approved = 人の実行を待っている。 */
export type LiveTaskDecisionState = 'waiting' | 'approved'

/**
 * **Task 単位の人の判断の唯一の事実**（lifecycle repair C3）。
 *
 * - 未期限 WAITING の Task 単位 request → `waiting`（判断そのものを待っている）。
 * - 未期限 APPROVED の、人が実行する Task 単位判断 → **決定主体が human のときだけ** `approved`。
 *   実行側（storage `verifyAndConsumeTaskApproval`）は approval_actor=human の無い APPROVED を
 *   authority として使わず SUPERSEDED にする。主体の無い legacy 行をここで「人の判断」と数えると、
 *   authority の無い行が HUMAN_DECISION_PENDING・job_blocked の抑止・Mobile の「承認済み」を生む
 *   （C3 独立レビュー P1）。
 * - それ以外 → undefined。
 */
export function liveTaskDecisionState(
  approval: TaskDecisionApprovalInput,
  nowMs: number = Date.now(),
): LiveTaskDecisionState | undefined {
  const action = approval.requestedAction
  // 型ガードの否定分岐で narrowing が never にならないよう、先に読む。
  const actor = approval.approvalActor
  if (!isTaskScopedApprovalAction(action)) return undefined
  if (isLiveWaitingApproval(approval, nowMs)) return 'waiting'
  if (
    isHumanExecutedTaskDecision(action)
    && isLiveApprovedApproval(approval, nowMs)
    && actor === 'human'
  ) {
    return 'approved'
  }
  return undefined
}

/**
 * **人の判断がいま Task を止めている**か（`liveTaskDecisionState()` が状態を返すか）。
 * 人でない resume はこれがある間 `HUMAN_DECISION_PENDING`、systemState は `job_blocked` ではなく
 * `approval_waiting` として見せる。APPROVED は `approvalActor === 'human'` のときだけ数える。
 */
export function isLiveTaskScopedDecision(
  approval: TaskDecisionApprovalInput,
  nowMs: number = Date.now(),
): boolean {
  return liveTaskDecisionState(approval, nowMs) !== undefined
}
