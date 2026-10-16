import type { ApprovalRequest } from './types/approval_gate'
import type { JobStatus } from './types/job'
import type { ProjectStatus } from './types/project'
import type { TaskStatus } from './types/task'
import { isLiveWaitingApproval } from './approvalLiveness'

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
  safeCommand: { kind: string }
}

export interface ResumeAdmissionInput {
  taskStatus: TaskStatus | string
  /** abort_task で park されているか（`ITaskStorage.isParked()`）。 */
  parked: boolean
  projectStatus: ProjectStatus | string | undefined
  /** Task の Job。**新しい順**（先頭が最新）。 */
  jobs: readonly ResumeAdmissionJob[]
  /** Task の ApprovalRequest（順不同）。live な承認待ちが 1 件でもあれば断る。 */
  approvals: readonly Pick<ApprovalRequest, 'status' | 'expiresAt'>[]
  nowMs: number
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
  | 'AI_CLI_MODE_MISSING'

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
  if (input.approvals.some((approval) => isLiveWaitingApproval(approval, input.nowMs))) {
    return { ok: false, code: 'APPROVAL_WAITING' }
  }
  if (latestJob.safeCommand.kind !== 'git_commit' && !latestJob.aiCliMode) {
    return { ok: false, code: 'AI_CLI_MODE_MISSING' }
  }
  return { ok: true }
}
