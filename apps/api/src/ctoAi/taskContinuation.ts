import type { IStorage } from '../storage/interface'
import { createInitialImplementWorkflow, type InitialImplementWorkflowResult } from './initialImplementWorkflow'

function initialStepKey(taskId: string): string {
  return `task:${taskId}:initial-implement`
}

/**
 * paused中に保留された（`retryable`なskipで残された）'pending' continuationを、対象Project
 * について再試行する。running遷移直後の1回だけでなく、`GET /api/projects`・
 * `GET /api/projects/:id`（Mobileが既に継続的にpollしている既存endpoint）からも呼ぶことで、
 * 1回の再試行が失敗しても「その後二度と拾われない」状態にしない。新しいQueue/daemon/pollingは
 * 追加せず、Mobileの既存poll cycleに相乗りする（Worker側`pollJobs()`がOutbox再送を自分の
 * poll cycleに相乗りさせているのと同じパターン）。個々の失敗はログのみで、呼び出し元の
 * レスポンスをブロックしない設計を前提に、呼び出し元でfire-and-forgetすること。
 */
export async function retryPendingContinuationsForProject(storage: IStorage, projectId: string): Promise<void> {
  const pending = storage.taskContinuations.findPendingByProjectId(projectId)
  await Promise.all(pending.map((continuation) => ensureTaskContinuation(storage, continuation.id)))
}

export async function ensureTaskContinuation(storage: IStorage, continuationId: string): Promise<void> {
  const continuation = storage.taskContinuations.findById(continuationId)
  if (!continuation || continuation.status !== 'pending') return

  if (!continuation.nextTaskId) {
    storage.taskContinuations.update(continuation.id, { status: 'completed', completedAt: new Date().toISOString() })
    return
  }

  try {
    const result = await createInitialImplementWorkflow(storage, continuation.nextTaskId)
    if (result.status === 'created' || hasInitialJob(storage, continuation.nextTaskId)) {
      storage.taskContinuations.update(continuation.id, { status: 'completed', completedAt: new Date().toISOString() })
      return
    }
    if (result.retryable) return
    failContinuation(storage, continuation.id, continuation.nextTaskId, result)
  } catch (error: unknown) {
    // Retryable infrastructure failure: leave the durable handoff pending for the next Outbox resend.
  }
}

function hasInitialJob(storage: IStorage, taskId: string): boolean {
  return storage.jobs.findByTaskId(taskId).some((job) => job.workflowStepKey === initialStepKey(taskId))
}

function failContinuation(
  storage: IStorage,
  continuationId: string,
  taskId: string,
  result: InitialImplementWorkflowResult,
): void {
  const reason = result.status === 'skipped' ? result.reason : 'initial workflow was not created'
  storage.taskContinuations.update(continuationId, {
    status: 'failed',
    error: reason,
    completedAt: new Date().toISOString(),
  })
  const task = storage.tasks.findById(taskId)
  if (task?.status !== 'blocked') storage.tasks.update(taskId, { status: 'blocked' })
  storage.auditLog.record({
    actor: 'api',
    operation: 'task_continuation_failed',
    entityType: 'task_continuation',
    entityId: continuationId,
    result: 'failure',
    detail: reason,
  })
}
