/**
 * 既存の manual abort（park）経路を Mobile から辿るための API 呼び出しと判定（Mobile 側）。
 *
 * 経路そのものは既存で、ここでは新しい route・authority を作らない:
 *
 *   1. `POST /api/approval-requests` — Task に `abort_task` の ApprovalRequest を起票する（WAITING_FOR_USER）
 *   2. 人（CEO）が承認する（`PATCH /api/approval-requests/:id/status`、human-only。approval_actor=human を記録）
 *   3. `POST /api/tasks/:id/abort` — 人が承認した `abort_task` を使って park を要求する。
 *      `cleanup_requested` なら Worker が作業場所を観測し、clean のときだけ park が成立する
 *
 * Task 画面のボタンは「タスクを中止」1 つ（CEO 判断 2026-10-23）。AI/PL が起票した依頼は従来どおり承認一覧で扱う。
 *
 * ワンタップ中止（`runOneTapAbort()`）: CEO が Task 画面で自分から中止を始めたときは、起票そのものが CEO の判断なので、
 * 1 回の確認ダイアログの後ろで 1→2→3 を順に呼ぶ。authority は変えない —— 2 は承認一覧と同じ human-only PATCH・
 * 同じ body（`lib/approvalGateDecision.ts`）で、承認者は ADMIN 認証の人のまま。サーバの検査も同じ。
 * 承認するのは、この操作で作った依頼か、この Task の承認待ちの abort_task（確認ダイアログで依頼 id を示す）だけで、
 * 他の action の依頼には触れない。
 *
 * 承認状態は `TaskDetail.humanTaskDecisions`（API が期限・決定主体 approval_actor=human を確定した事実）
 * から読み、生の ApprovalRequest status から authority を組み立て直さない。
 * 実行可否の正本は API（`apps/api/src/pl/abortTask.ts`）で、ここは表示の目安と送信だけを行う。
 */

import { holdsWorkspaceWhenBlocked } from '@ai-team/shared'
import type { Job, Task, TaskDetail, TaskHumanDecisionFact } from '@ai-team/shared'

import { apiFetch } from './api'
import { approvalGateDecisionPath, buildApprovalGateDecisionBody } from './approvalGateDecision'
import {
  ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK,
  ABORT_ERROR_MESSAGE_FALLBACK,
  formatAbortErrorMessage,
  formatApprovalDecisionErrorMessage,
} from './resumeErrorMessage'
import { taskNumberLabel } from './taskNumber'
import { readApiRejection } from './taskRecovery'

/** backend の action 文字列（`requiredApprovalRequestAction('abort_task')`）。 */
export const ABORT_TASK_ACTION = 'abort_task'

/**
 * 起票と実行の監査理由（API の abort 側上限 2000 文字）。CEO に理由を書かせない ——
 * 「Mobile のボタンから CEO が実行した」こと自体が監査に残すべき事実である（`/recover` と同じ方針）。
 */
export const MOBILE_ABORT_REASON = 'CEO が Mobile の「タスクを中止」から実行'

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
 * 「タスクを中止」を出すか。
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

/**
 * ワンタップ中止で何を順に呼ぶか。
 *
 * - `create_approve_execute`: 中止の依頼が無い → 起票 → 承認 → 実行
 * - `approve_execute`: この Task に承認待ちの abort_task がある → それを承認 → 実行（もう 1 件作らない）
 * - `execute`: 人が承認した live な abort_task がある（承認一覧で承認済みなど）→ 実行だけ
 *   （新しく起票すると同じ action の APPROVED が置き換えられる（B-5）ので作らない）
 */
export type OneTapAbortPlan = 'create_approve_execute' | 'approve_execute' | 'execute'

/** ワンタップ中止ボタンの状態。描画から切り離してテストする。 */
export interface OneTapAbortView {
  approval: AbortApprovalState
  plan: OneTapAbortPlan
  note: string
}

export function oneTapAbortView(
  humanTaskDecisions: readonly TaskHumanDecisionFact[] | undefined,
): OneTapAbortView {
  const approval = abortApprovalState(humanTaskDecisions)
  if (approval.kind === 'approved') {
    return {
      approval,
      note: `中止の承認が下りています（承認依頼 ${approval.approvalRequestId}）。「${ONE_TAP_ABORT_BUTTON_LABEL}」を押すと、この承認を使って中止を実行します。`,
      plan: 'execute',
    }
  }
  if (approval.kind === 'waiting') {
    return {
      approval,
      note: `中止の承認依頼 ${approval.approvalRequestId} が承認待ちです。「${ONE_TAP_ABORT_BUTTON_LABEL}」を押すと、この依頼をあなたの承認として承認し、中止を実行します。`,
      plan: 'approve_execute',
    }
  }
  return {
    approval,
    note: `「${ONE_TAP_ABORT_BUTTON_LABEL}」を押すと、確認のあと承認依頼の作成・あなたの承認・中止の実行をまとめて行います。`,
    plan: 'create_approve_execute',
  }
}

/** ワンタップ中止のボタン文言。 */
export const ONE_TAP_ABORT_BUTTON_LABEL = 'タスクを中止'

/** 確認ダイアログの題。 */
export const ONE_TAP_ABORT_CONFIRM_TITLE = 'タスクを中止しますか？'

/**
 * 確認ダイアログの本文。対象 Task（タイトル + タスク番号）と効果を先に伝える。
 * このダイアログの「中止する」が CEO の承認判断そのものになるので、何を承認するかをここで言い切る。
 */
export function oneTapAbortConfirmMessage(
  task: { id: string; title?: string | null },
  view: Pick<OneTapAbortView, 'approval' | 'plan'>,
): string {
  const title = typeof task.title === 'string' && task.title.trim().length > 0 ? task.title.trim() : '（タイトルなし）'
  const number = taskNumberLabel(task.id)
  const lines = [
    `「${title}」${number === null ? '' : `（${number}）`}`,
    '',
    '・このTaskは完了扱いにならず、中止（park）されて現役から外れます。Roadmapの残作業は消えません。',
  ]
  if (view.plan === 'create_approve_execute') {
    lines.push(
      '・このTaskに他の承認待ちがある場合、それらは置き換えられます。',
      '・中止の承認依頼を作成し、あなた（CEO）の承認として記録してから実行します。',
    )
  } else if (view.plan === 'approve_execute' && view.approval.kind === 'waiting') {
    lines.push(`・承認待ちの中止依頼 ${view.approval.approvalRequestId} を、あなた（CEO）の承認として承認してから実行します。`)
  } else if (view.approval.kind === 'approved') {
    lines.push(`・承認済みの中止依頼 ${view.approval.approvalRequestId} を使って実行します。`)
  }
  return lines.join('\n')
}

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

/** ワンタップ中止の承認理由（approval の監査に残る）。 */
export const ONE_TAP_ABORT_APPROVE_REASON = 'CEO が Task 画面から中止を実行'

export const ABORT_APPROVE_FAILED_PREFIX = '中止の承認を記録できませんでした。'

export type ApproveAbortResult = { ok: true } | { ok: false; code?: string | null; message: string }

/** 承認の期限切れ（API は承認を記録せず依頼を期限切れにする。承認待ちとしては残らない）。 */
export const APPROVAL_EXPIRED_CODE = 'APPROVAL_EXPIRED'

/**
 * 承認一覧と同じ human-only `PATCH /api/approval-requests/:id/status` を、同じ body（`buildApprovalGateDecisionBody`）で送る。
 * 拒否 code の文言も承認一覧と同じ `formatApprovalDecisionErrorMessage()`。
 */
export async function approveAbortApprovalRequest(approvalRequestId: string): Promise<ApproveAbortResult> {
  try {
    const response = await apiFetch(approvalGateDecisionPath(approvalRequestId), {
      body: JSON.stringify(buildApprovalGateDecisionBody('APPROVED', ONE_TAP_ABORT_APPROVE_REASON)),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    })
    if (response.ok) return { ok: true }
    const { code } = await readApiRejection(response)
    return { code, message: `${ABORT_APPROVE_FAILED_PREFIX}${formatApprovalDecisionErrorMessage(code)}`, ok: false }
  } catch {
    return { message: `${ABORT_APPROVE_FAILED_PREFIX}${formatApprovalDecisionErrorMessage(null)}`, ok: false }
  }
}

export type OneTapAbortStage = 'create' | 'approve' | 'execute'

/** 実行中に画面へ出す進行状況。 */
export const ONE_TAP_ABORT_PROGRESS_TEXT: Readonly<Record<OneTapAbortStage, string>> = {
  approve: '承認を記録しています…',
  create: '中止の承認依頼を作成しています…',
  execute: '中止（park）を要求しています…',
}

export const ONE_TAP_ABORT_NOT_EXECUTED_NOTE = '中止は実行されていません。'

/** 承認で止まったときの追記。作った（または再利用した）依頼は承認待ちのまま承認一覧に残る。 */
export function oneTapAbortUnapprovedNote(approvalRequestId: string): string {
  return `中止の承認依頼 ${approvalRequestId} は承認されないまま承認一覧に残っています。${ONE_TAP_ABORT_NOT_EXECUTED_NOTE}`
    + '承認一覧で承認するか、もう一度このボタンを押してください。'
}

export const ONE_TAP_ABORT_EXPIRED_NOTE =
  `${ONE_TAP_ABORT_NOT_EXECUTED_NOTE}画面を更新してからもう一度このボタンを押すと、新しい承認依頼を作成して中止します。`

/** 依存（API 呼び出し）は注入する。画面からは既存の関数を渡し、テストでは fake を渡す。 */
export interface OneTapAbortDeps {
  createRequest: (taskId: string) => Promise<CreateAbortApprovalResult>
  approveRequest: (approvalRequestId: string) => Promise<ApproveAbortResult>
  executeAbort: (taskId: string, approvalRequestId: string) => Promise<SubmitAbortResult>
  onProgress?: (stage: OneTapAbortStage) => void
}

export const ONE_TAP_ABORT_DEFAULT_DEPS: Omit<OneTapAbortDeps, 'onProgress'> = {
  approveRequest: approveAbortApprovalRequest,
  createRequest: createAbortApprovalRequest,
  executeAbort: submitTaskAbort,
}

export type OneTapAbortResult =
  | { ok: true; approvalRequestId: string; message: string; status: 'parked' | 'cleanup_requested' }
  | { ok: false; stage: OneTapAbortStage; approvalRequestId?: string; message: string }

const STAGE_FALLBACK_MESSAGE: Readonly<Record<OneTapAbortStage, string>> = {
  approve: `${ABORT_APPROVE_FAILED_PREFIX}${formatApprovalDecisionErrorMessage(null)}`,
  create: ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK,
  execute: ABORT_ERROR_MESSAGE_FALLBACK,
}

/**
 * 起票 → 承認 → 実行を順に呼び、最初の失敗で止める。`approval` は画面が `abortApprovalState()` で読んだ状態で、
 * 既に人の承認があれば実行だけ、承認待ちがあればそれを承認して実行する（もう 1 件作らない）。
 * 承認するのは「この呼び出しで作った依頼」か「この Task の承認待ち abort_task」（確認ダイアログで id を示したもの）だけ。
 */
export async function runOneTapAbort(
  taskId: string,
  approval: AbortApprovalState,
  deps: OneTapAbortDeps,
): Promise<OneTapAbortResult> {
  let stage: OneTapAbortStage = 'create'
  let approvalRequestId: string | undefined
  try {
    if (approval.kind === 'none') {
      deps.onProgress?.('create')
      const created = await deps.createRequest(taskId)
      if (!created.ok) {
        return { message: `${created.message}\n${ONE_TAP_ABORT_NOT_EXECUTED_NOTE}`, ok: false, stage }
      }
      approvalRequestId = created.approvalRequestId
    } else {
      approvalRequestId = approval.approvalRequestId
    }

    if (approval.kind !== 'approved') {
      stage = 'approve'
      deps.onProgress?.('approve')
      const approved = await deps.approveRequest(approvalRequestId)
      if (!approved.ok) {
        const note = approved.code === APPROVAL_EXPIRED_CODE
          ? ONE_TAP_ABORT_EXPIRED_NOTE
          : oneTapAbortUnapprovedNote(approvalRequestId)
        return {
          approvalRequestId,
          message: `${approved.message}\n${note}`,
          ok: false,
          stage,
        }
      }
    }

    stage = 'execute'
    deps.onProgress?.('execute')
    const result = await deps.executeAbort(taskId, approvalRequestId)
    if (!result.ok) return { approvalRequestId, message: result.message, ok: false, stage }
    return { approvalRequestId, message: result.message, ok: true, status: result.status }
  } catch {
    const message = stage === 'approve' && approvalRequestId !== undefined
      ? `${STAGE_FALLBACK_MESSAGE.approve}\n${oneTapAbortUnapprovedNote(approvalRequestId)}`
      : STAGE_FALLBACK_MESSAGE[stage]
    return { ...(approvalRequestId === undefined ? {} : { approvalRequestId }), message, ok: false, stage }
  }
}

/**
 * 二重送信を防ぐ runner。実行中にもう一度呼ばれたら API を呼ばずに `null` を返す
 * （ボタンの disabled は描画の反映前に 2 回押されると効かないので、ここでも止める）。
 */
export function createOneTapAbortRunner(deps: OneTapAbortDeps): {
  isRunning: () => boolean
  run: (taskId: string, approval: AbortApprovalState) => Promise<OneTapAbortResult | null>
} {
  let running = false
  return {
    isRunning: () => running,
    run: async (taskId, approval) => {
      if (running) return null
      running = true
      try {
        return await runOneTapAbort(taskId, approval, deps)
      } finally {
        running = false
      }
    },
  }
}
