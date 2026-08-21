import type { IStorage } from '../storage/interface'
import { createInitialImplementWorkflow, type InitialImplementWorkflowResult } from './initialImplementWorkflow'

function initialStepKey(taskId: string): string {
  return `task:${taskId}:initial-implement`
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
