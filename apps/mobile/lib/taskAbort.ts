/**
 * 既存の manual abort（park）経路を Mobile から辿るための API 呼び出しと判定（Mobile 側）。
 *
 * 経路そのものは既存で、ここでは新しい route・authority を作らない:
 *
 *   1. `POST /api/approval-requests` — Task に `abort_task` の ApprovalRequest を起票する（WAITING_FOR_USER）
 *   2. 人（CEO）が**既存の承認一覧**で承認する（`PATCH /api/approval-requests/:id/status`、human-only）。
 *      **この画面からは承認しない。** 起票と承認を連鎖させない
 *   3. `POST /api/tasks/:id/abort` — 人が承認した `abort_task` を使って park を要求する。
 *      `cleanup_requested` なら Worker が作業場所を観測し、clean のときだけ park が成立する
 *
 * 承認状態は `TaskDetail.humanTaskDecisions`（API が期限・決定主体 approval_actor=human を確定した事実）
 * から読み、生の ApprovalRequest status から authority を組み立て直さない。
 * 実行可否の正本は API（`apps/api/src/pl/abortTask.ts`）で、ここは表示の目安と送信だけを行う。
 */

import { holdsWorkspaceWhenBlocked } from '@ai-team/shared'
import type { Job, Task, TaskDetail, TaskHumanDecisionFact } from '@ai-team/shared'

import { apiFetch } from './api'
import {
  ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK,
  ABORT_ERROR_MESSAGE_FALLBACK,
  formatAbortErrorMessage,
} from './resumeErrorMessage'
import { readApiRejection } from './taskRecovery'

/** backend の action 文字列（`requiredApprovalRequestAction('abort_task')`）。 */
export const ABORT_TASK_ACTION = 'abort_task'

/**
 * 起票と実行の監査理由（API の abort 側上限 2000 文字）。CEO に理由を書かせない ——
 * 「Mobile のボタンから CEO が実行した」こと自体が監査に残すべき事実である（`/recover` と同じ方針）。
 */
export const MOBILE_ABORT_REASON = 'CEO が Mobile の「Task を中止（park）」から実行'

export interface AbortApprovalRequestBody {
  taskId: string
  targetBranch: string
  targetCommit: string
  targetDiffHash: string
  riskLevel: 'HIGH'
  requestedAction: typeof ABORT_TASK_ACTION
  invalidIf: string[]
  reason: string
}

/**
 * `POST /api/approval-requests` の body。
 *
 * `targetBranch` / `targetCommit` / `targetDiffHash` は schema が要求する**記述欄で、authorization の根拠ではない**
 * （abort_task の Gate が見るのは APPROVED・Task 束縛・requestedAction 一致・期限・human actor だけ。
 * `actionGate.ts` `checkApprovalGate()`）。stored-review recovery の `describeTarget()` と同じ扱い。
 * `expiresAt` はサーバが計算するので送らない。
 */
export function buildAbortApprovalRequestBody(taskId: string): AbortApprovalRequestBody {
  return {
    taskId,
    targetBranch: 'manual-abort',
    targetCommit: taskId,
    targetDiffHash: `${ABORT_TASK_ACTION}:${taskId}`,
    riskLevel: 'HIGH',
    requestedAction: ABORT_TASK_ACTION,
    invalidIf: [],
    reason: MOBILE_ABORT_REASON,
  }
}

export function buildAbortTaskBody(approvalRequestId: string): { approvalRequestId: string; reason: string } {
  return { approvalRequestId, reason: MOBILE_ABORT_REASON }
}

/** この Task の abort_task 承認の状態。 */
export type AbortApprovalState =
  | { kind: 'none' }
  | { kind: 'waiting'; approvalRequestId: string }
  | { kind: 'approved'; approvalRequestId: string }

/**
 * `humanTaskDecisions` だけから読む（期限切れ・主体の記録の無い APPROVED は API が既に除いている）。
 * 事実が無い（古い API）なら 'none' —— 実行ボタンを出さない側に倒す。
 */
export function abortApprovalState(
  humanTaskDecisions: readonly TaskHumanDecisionFact[] | undefined,
): AbortApprovalState {
  const related = (humanTaskDecisions ?? []).filter((decision) => decision.requestedAction === ABORT_TASK_ACTION)
  const approved = related.find((decision) => decision.state === 'approved')
  if (approved !== undefined) return { approvalRequestId: approved.approvalRequestId, kind: 'approved' }
  const waiting = related.find((decision) => decision.state === 'waiting')
  if (waiting !== undefined) return { approvalRequestId: waiting.approvalRequestId, kind: 'waiting' }
  return { kind: 'none' }
}

export type AbortSectionTask =
  Pick<Task, 'status' | 'roadmapActive'> & Partial<Pick<TaskDetail, 'parked' | 'humanTaskDecisions'>>

/**
 * 「Task を中止（park）」を出すか。
 *
 * API `abortTask()` の入口条件のうち、Task 行から読めるものだけを写す（admission の再実装ではない）:
 * done でない（`TASK_ALREADY_DONE`）・pending か blocked（`TASK_NOT_PARKABLE`）・roadmapActive（`TASK_NOT_ACTIVE`）・
 * 未 park。そのうえで「止まっている」ものに限る —— Task が blocked か、所有権を保持する blocked Job
 * （共有 `holdsWorkspaceWhenBlocked()`）がある。`parked` が読めない（古い API）なら出さない（fail-closed）。
 */
export function canShowAbortUI(task: AbortSectionTask, jobs: readonly Job[]): boolean {
  if (typeof task.parked !== 'boolean' || task.parked) return false
  if (task.roadmapActive !== true) return false
  if (task.status === 'blocked') return true
  if (task.status !== 'pending') return false
  return jobs.some((job) => holdsWorkspaceWhenBlocked({ parked: task.parked, status: task.status }, job))
}

/** 画面が出すボタンの状態。描画から切り離してテストする。 */
export interface AbortActionView {
  approval: AbortApprovalState
  /** Step A「中止の承認依頼を作成」を押せるか。承認待ち・承認済みがあるときは押させない */
  canCreateRequest: boolean
  /** Step B「承認済みの中止を実行」を押せるか。人が承認した live な abort_task があるときだけ */
  canExecute: boolean
  note: string
}

export function abortActionView(
  humanTaskDecisions: readonly TaskHumanDecisionFact[] | undefined,
): AbortActionView {
  const approval = abortApprovalState(humanTaskDecisions)
  if (approval.kind === 'approved') {
    return {
      approval,
      canCreateRequest: false,
      canExecute: true,
      // 新しい依頼を作ると同じ action の APPROVED が置き換えられる（B-5）ので、ここでは作らせない。
      note: `中止の承認が下りています（承認依頼 ${approval.approvalRequestId}）。「承認済みの中止を実行」を押すと park を要求します。`,
    }
  }
  if (approval.kind === 'waiting') {
    return {
      approval,
      canCreateRequest: false,
      canExecute: false,
      note: `中止の承認依頼 ${approval.approvalRequestId} が承認待ちです。承認一覧で承認したあと、この画面に戻って実行してください。承認だけでは中止されません。`,
    }
  }
  return {
    approval,
    canCreateRequest: true,
    canExecute: false,
    note: 'このTaskを完了扱いにせず現役から外します（Roadmapの残作業は消えません）。'
      + 'まず承認依頼を作成し、承認一覧で承認してから実行してください。',
  }
}

/** 起票の確認ダイアログ文言。起票は同じ Task の他の承認待ちを置き換える（B-5）ことを先に伝える。 */
export const ABORT_REQUEST_CONFIRM_MESSAGE =
  'このTaskの中止（park）の承認依頼を作成しますか？\n'
  + 'このTaskに他の承認待ちがある場合、それらは置き換えられます。'
  + '作成後、承認一覧で承認してください（この画面からは承認しません）。'

export type CreateAbortApprovalResult =
  | { ok: true; approvalRequestId: string }
  | { ok: false; message: string }

export const ABORT_APPROVAL_REQUEST_UNREADABLE_MESSAGE =
  '承認依頼は作成されましたが、応答を読み取れませんでした。承認一覧を確認してください。'

async function readCreatedId(response: Response): Promise<string | undefined> {
  try {
    const id = ((await response.json()) as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

export async function createAbortApprovalRequest(taskId: string): Promise<CreateAbortApprovalResult> {
  try {
    const response = await apiFetch('/api/approval-requests', {
      body: JSON.stringify(buildAbortApprovalRequestBody(taskId)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (response.status === 201) {
      const id = await readCreatedId(response)
      if (id !== undefined) return { approvalRequestId: id, ok: true }
      // 201 = 作成済み。id が読めなくても「失敗」とは言わない（もう一度押すと作り直して置き換えてしまう）。
      return { message: ABORT_APPROVAL_REQUEST_UNREADABLE_MESSAGE, ok: false }
    }
    return { message: ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK, ok: false }
  } catch {
    return { message: ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK, ok: false }
  }
}

export const ABORT_CLEANUP_REQUESTED_MESSAGE =
  '中止を受け付けました。Worker が作業場所を確認し、clean なら park されます。'
  + '少し待ってから画面を更新して状態を確認してください。'

export const ABORT_PARKED_MESSAGE = 'Taskを中止（park）しました。Roadmapの残作業は消えていません。'

export const ABORT_UNREADABLE_SUCCESS_MESSAGE =
  '中止の要求は受け付けられましたが、結果を読み取れませんでした。画面を更新して状態を確認してください。'

async function readAbortStatus(response: Response): Promise<unknown> {
  try {
    return ((await response.json()) as { status?: unknown }).status
  } catch {
    return undefined
  }
}

export type SubmitAbortResult =
  | { ok: true; status: 'parked' | 'cleanup_requested'; message: string }
  | { ok: false; message: string }

export async function submitTaskAbort(taskId: string, approvalRequestId: string): Promise<SubmitAbortResult> {
  try {
    const response = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/abort`, {
      body: JSON.stringify(buildAbortTaskBody(approvalRequestId)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (response.status === 200) {
      // 200 は API が受理した後。読めなくても「失敗」とは言わない（実際には進んでいるかもしれない）。
      const status = await readAbortStatus(response)
      if (status === 'cleanup_requested') {
        return { message: ABORT_CLEANUP_REQUESTED_MESSAGE, ok: true, status: 'cleanup_requested' }
      }
      if (status === 'parked') return { message: ABORT_PARKED_MESSAGE, ok: true, status: 'parked' }
      return { message: ABORT_UNREADABLE_SUCCESS_MESSAGE, ok: false }
    }
    const { code } = await readApiRejection(response)
    return { message: formatAbortErrorMessage(code), ok: false }
  } catch {
    return { message: ABORT_ERROR_MESSAGE_FALLBACK, ok: false }
  }
}
