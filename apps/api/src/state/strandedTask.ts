import { isLiveTaskScopedDecision, isLiveWaitingApproval, type Task } from '@ai-team/shared'
import { withApprovalActorFacts } from '../designReview/resumeActor'
import type { IStorage } from '../storage/interface'
import { findBlockedRowsHoldingWorkspace } from './blockedRowOwnership'

/**
 * **lifecycle が所有する status（in_progress / review）なのに、動かすものが何も無い Task か**
 * （lifecycle repair C3。唯一の定義）。
 *
 * 次をすべて満たすとき stranded:
 *   - status が in_progress / review（Project を占有する lifecycle 状態）
 *   - live な Job（queued / running）が無い
 *   - workspace を所有する blocked 行が無い（`findBlockedRowsHoldingWorkspace`。claim guard と同じ意味）
 *   - queued / running の Design Review run が無い
 *   - 生きた人の判断が無い（live WAITING、または human が決めた APPROVED の Task 単位判断）
 *
 * 使うのは 2 箇所だけ: systemState の stranded attention（`task_ready_without_job`）と、
 * 汎用 PATCH の出口（owned → pending）。PATCH は storage transaction の中でこれを呼び直すので、
 * driver（Job / review / 人の判断）が居る Task から Project の占有を外すことはない。
 *
 * 戻り値は stranded でない理由（stranded なら undefined）。
 */
export function strandedLifecycleRefusal(
  storage: IStorage,
  task: Task,
  nowMs: number = Date.now(),
): string | undefined {
  if (task.status !== 'in_progress' && task.status !== 'review') {
    return `task is ${task.status}, not a lifecycle-owned in_progress / review state`
  }
  const jobs = storage.jobs.findByTaskId(task.id)
  const live = jobs.find((job) => job.status === 'queued' || job.status === 'running')
  if (live !== undefined) return `job ${live.id} is ${live.status}`
  const holding = findBlockedRowsHoldingWorkspace(storage, task, jobs)[0]
  if (holding !== undefined) return `blocked job ${holding.id} still holds the shared workspace`
  const run = storage.designReviewRuns.findActiveByTaskId(task.id)
  if (run !== undefined) return `design review run ${run.id} is ${run.status}`
  const decision = withApprovalActorFacts(storage, storage.approvalRequests.findByTaskId(task.id))
    .find((request) => isLiveWaitingApproval(request, nowMs) || isLiveTaskScopedDecision(request, nowMs))
  if (decision !== undefined) return `approval request ${decision.id} is a live human decision`
  return undefined
}
