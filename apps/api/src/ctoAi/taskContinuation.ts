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

export interface TaskContinuationReconcileSummary {
  /** 走査したpending continuationの件数。 */
  scanned: number
  /** このsweepで'pending'から'completed'へ回収できた件数。 */
  recovered: number
  /** このsweepで'failed'が確定した件数（非retryableなskip）。 */
  failed: number
  /** retryable skipのため'pending'のまま残した件数。次cycleで再試行される。 */
  stillPending: number
}

/**
 * running Projectのpending continuationを1巡する。**backend専用のliveness driver**。
 *
 * 経路は Worker poll cycle → `POST /api/task-continuations/reconcile` → 本関数であり、
 * Mobileの`GET /api/projects`系が持つretry副作用（routes/projects.ts）と同じ回収を、
 * clientが閉じていても成立させる。新しいqueue/daemon/schedulerは追加せず、
 * `reconcileSupervisedDelegations()`が既存poll cycleに相乗りしているのと同じ形を採る。
 *
 * **gateは一切追加も迂回もしない。** paused/blocked/dependency未達/approval・design review
 * evidence未成立の判定はすべて`createInitialImplementWorkflow()`の内側にあり、
 * 呼び出し元を増やしても自動的に継承される。ここが独自に持つ条件は
 * 「running Projectのみ対象」という既存`retryRunningProjectContinuations()`と同じ絞り込みだけ。
 *
 * 逐次実行する。`ux_projects_single_running`により running Projectは最大1件で、
 * その pending continuation も通常0〜1件であるため、並列化する必要が無い。
 * 逆に並列化すると design review の同時起動やworkspace競合を招きうる。
 */
export async function reconcileTaskContinuations(storage: IStorage): Promise<TaskContinuationReconcileSummary> {
  const summary: TaskContinuationReconcileSummary = { scanned: 0, recovered: 0, failed: 0, stillPending: 0 }

  for (const project of storage.projects.findAll()) {
    // paused/draft/archivedは「CEOがまだ進めると決めていない」状態であり、sweepで突破しない。
    if (project.status !== 'running') continue

    for (const continuation of storage.taskContinuations.findPendingByProjectId(project.id)) {
      summary.scanned += 1
      // ensureTaskContinuation()は個々の失敗を内部で吸収する（retryableならpendingのまま残す）。
      await ensureTaskContinuation(storage, continuation.id)
      const settled = storage.taskContinuations.findById(continuation.id)
      if (settled?.status === 'completed') summary.recovered += 1
      else if (settled?.status === 'failed') summary.failed += 1
      else summary.stillPending += 1
    }
  }

  return summary
}
