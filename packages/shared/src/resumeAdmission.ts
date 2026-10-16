import type { JobStatus } from './types/job'
import type { ProjectStatus } from './types/project'
import type { TaskStatus } from './types/task'
import {
  isLiveTaskScopedDecision,
  isLiveWaitingApproval,
  isTaskScopedApprovalAction,
  type TaskDecisionApprovalInput,
} from './approvalLiveness'

/**
 * **Human Resume を受け付けてよいかの前提条件**（純関数・唯一の定義）。
 *
 * API の `resumeBlockedTask()` は transaction の中でこれを呼び、Mobile は Resume ボタンを出すかを
 * 同じ関数で決める。条件を 2 箇所に書くと、2026-10-16 監査 A2 のように「Mobile は Resume を出すのに
 * API は断る」不一致が再発する。ここで判るのは保存済み状態だけで決まる前提までで、
 * git_commit lineage・Design Review evidence のような作成時の判定は storage 側に残る。
 */

/** 判定に使う Job の事実。`Job` をそのまま渡せる形にしてある。 */
export interface ResumeAdmissionJob {
  status: JobStatus | string
  failureMetadata?: { quarantined?: boolean }
  aiCliMode?: string
  aiCliProvider?: string
  safeCommand: { kind: string }
}

export interface ResumeAdmissionInput {
  taskStatus: TaskStatus | string
  /** abort_task で park されているか（`ITaskStorage.isParked()`）。 */
  parked: boolean
  projectStatus: ProjectStatus | string | undefined
  /** Task の Job。**新しい順**（先頭が最新）。 */
  jobs: readonly ResumeAdmissionJob[]
  /**
   * Task の ApprovalRequest（順不同）。Job 束縛（command kind）の live な承認待ちが 1 件でもあれば断る。
   * Task 単位の判断（`isTaskScopedApprovalAction`）は `resumedByHuman` で扱いが分かれる。
   */
  /**
   * `approvalActor` は API が `approval_actor` audit から計算した型付きの事実（`TaskDecisionApprovalInput`）。
   * APPROVED の Task 単位判断は `approvalActor === 'human'` のときだけ人の判断として数える。
   */
  approvals: readonly TaskDecisionApprovalInput[]
  nowMs: number
  /**
   * 再開するのが人（ADMIN credential）か。人の resume は新しい人の判断として、生きた Task 単位の判断
   * （WAITING / APPROVED）を置き換える（storage が同じ transaction で SUPERSEDED にする）。
   * 人でない resume（PL / AI / 主体不明）は、それがある間は `HUMAN_DECISION_PENDING` で再開しない。
   * 既定は false（主体を証明できないものを人扱いしない）。Mobile は CEO の操作なので true を渡す。
   */
  resumedByHuman?: boolean
}

export type ResumeAdmissionCode =
  | 'TASK_DONE'
  | 'PROJECT_NOT_RUNNING'
  | 'NO_JOBS'
  | 'LATEST_JOB_NOT_BLOCKED'
  | 'TASK_PARKED'
  | 'WORKSPACE_QUARANTINED'
  | 'LIVE_JOB_EXISTS'
  | 'APPROVAL_WAITING'
  /** 生きた Task 単位の人の判断がある。人の resume だけがそれを置き換えられる。 */
  | 'HUMAN_DECISION_PENDING'
  | 'AI_CLI_MODE_MISSING'
  | 'AI_CLI_PROVIDER_MISSING'

export type ResumeAdmission = { ok: true } | { ok: false; code: ResumeAdmissionCode }

export function evaluateResumeAdmission(input: ResumeAdmissionInput): ResumeAdmission {
  // **完了した Task は再開しない。** done の Task に Job を作ると、commit 済みの成果の上で
  // 自律実行が再び始まる（b8d0fc5d 監査）。
  if (input.taskStatus === 'done') return { ok: false, code: 'TASK_DONE' }
  // **running でない Project では再開しない。** Worker は running Project の Job しか拾わないので、
  // 作った Job は queued のまま誰にも実行されず、Task は queued Job を抱えたまま止まる。
  if (input.projectStatus !== 'running') return { ok: false, code: 'PROJECT_NOT_RUNNING' }

  const latestJob = input.jobs[0]
  if (latestJob === undefined) return { ok: false, code: 'NO_JOBS' }

  // Job 自体が blocked、または repair flow が Task だけを blocked にした（最新 Job は failed）場合。
  const isJobDirectlyBlocked = latestJob.status === 'blocked'
  const isEscalatedFailure = input.taskStatus === 'blocked' && latestJob.status === 'failed'
  if (!isJobDirectlyBlocked && !isEscalatedFailure) return { ok: false, code: 'LATEST_JOB_NOT_BLOCKED' }

  if (input.parked) return { ok: false, code: 'TASK_PARKED' }
  if (input.jobs.some((job) => job.failureMetadata?.quarantined === true)) {
    return { ok: false, code: 'WORKSPACE_QUARANTINED' }
  }
  if (input.jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    return { ok: false, code: 'LIVE_JOB_EXISTS' }
  }
  // 期限切れの WAITING は誰も待っていない（`isLiveWaitingApproval()`）。それで resume を
  // 恒久拒否すると Task はどこからも復旧できなくなる（2026-09-12 Production）。
  // Task 単位の判断はここでは数えない（下で人 / 人でないで分ける）。Job 束縛の承認待ちは従来どおり断る。
  if (input.approvals.some((approval) =>
    !isTaskScopedApprovalAction(approval.requestedAction) && isLiveWaitingApproval(approval, input.nowMs))) {
    return { ok: false, code: 'APPROVAL_WAITING' }
  }
  if (
    input.resumedByHuman !== true
    && input.approvals.some((approval) => isLiveTaskScopedDecision(approval, input.nowMs))
  ) {
    return { ok: false, code: 'HUMAN_DECISION_PENDING' }
  }
  // AI CLI Job の resume は provider と mode をそのまま引き継ぐので、どちらかが欠けると作れない。
  // storage 側に同じ検査を二重に持たない（API と Mobile の判定を一致させる）。
  if (latestJob.safeCommand.kind !== 'git_commit') {
    if (!latestJob.aiCliMode) return { ok: false, code: 'AI_CLI_MODE_MISSING' }
    if (!latestJob.aiCliProvider) return { ok: false, code: 'AI_CLI_PROVIDER_MISSING' }
  }
  return { ok: true }
}
