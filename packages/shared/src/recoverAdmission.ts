import type { ApprovalRequest } from './types/approval_gate'
import type { ProjectStatus } from './types/project'
import type { TaskStatus } from './types/task'
import { isLiveWaitingApproval } from './approvalLiveness'

/**
 * **Human Recovery（`POST /api/tasks/:id/recover`）を受け付けてよいかの前提条件**（純関数・唯一の定義）。
 *
 * API の `recoverBlockedTask()` の precheck と、storage の `recoverFromBlocked()` の
 * transaction 内の再確認（読み直した値で）が両方これを呼び、Mobile は「復旧」ボタンを出すかを
 * 同じ関数で決める。`evaluateResumeAdmission()` と同じ理由で、条件を複数箇所に書かない。
 */
export interface RecoverAdmissionInput {
  taskStatus: TaskStatus | string
  /** abort_task で park されているか（`ITaskStorage.isParked()`）。 */
  parked: boolean
  /** Project が見つからなければ `undefined` / `null`。 */
  projectStatus: ProjectStatus | string | null | undefined
  /** Task の Job 件数。Job がある Task は `/resume` の担当。 */
  jobCount: number
  /** Task の ApprovalRequest（順不同）。live な承認待ちが 1 件でもあれば断る。 */
  approvals: readonly Pick<ApprovalRequest, 'status' | 'expiresAt'>[]
  nowMs: number
}

export type RecoverAdmissionCode =
  | 'PROJECT_UNAVAILABLE'
  | 'PROJECT_NOT_RUNNING'
  | 'TASK_NOT_BLOCKED'
  | 'TASK_HAS_JOBS'
  | 'TASK_PARKED'
  | 'APPROVAL_WAITING'

export type RecoverAdmission = { ok: true } | { ok: false; code: RecoverAdmissionCode }

/** 判定の順序は API の拒否 code の優先順位そのもの（各前提の理由は `recoverBlockedTask.ts`）。 */
export function evaluateRecoverAdmission(input: RecoverAdmissionInput): RecoverAdmission {
  if (input.projectStatus === undefined || input.projectStatus === null || input.projectStatus === 'archived') {
    return { ok: false, code: 'PROJECT_UNAVAILABLE' }
  }
  if (input.projectStatus !== 'running') return { ok: false, code: 'PROJECT_NOT_RUNNING' }
  if (input.taskStatus !== 'blocked') return { ok: false, code: 'TASK_NOT_BLOCKED' }
  if (input.jobCount > 0) return { ok: false, code: 'TASK_HAS_JOBS' }
  if (input.parked) return { ok: false, code: 'TASK_PARKED' }
  // **人の判断が既に1件待っているなら、2本目の駆動を始めない**（新しい Approval Gate ではなく、
  // `approval_waiting` と `task_ready_without_job` を同時に立てないための整合性条件）。
  // live な WAITING が 1 行でもあれば断る。APPROVED では断らない。**期限切れの WAITING でも
  // 断らない** —— 行を EXPIRED へ進める actor が居ないので、断ると Task がどこからも
  // 復旧できなくなる（2026-09-12 Production）。expiry 解釈は `isLiveWaitingApproval()` だけ。
  if (input.approvals.some((approval) => isLiveWaitingApproval(approval, input.nowMs))) {
    return { ok: false, code: 'APPROVAL_WAITING' }
  }
  return { ok: true }
}
