// TaskContinuation型定義
//
// 承認済み単一目的の永続的ハンドオフ（durable handoff）を表す。
// スケジューラ/キュー/一般ワークフロー用途のフィールドは持たない。

export type TaskContinuationStatus = 'pending' | 'completed' | 'failed'

export interface TaskContinuation {
  id: string
  sourceJobId: string
  projectId: string
  completedTaskId: string
  nextTaskId?: string
  status: TaskContinuationStatus
  error?: string
  createdAt: string
  completedAt?: string
}

/**
 * Worker が `POST /api/task-continuations/reconcile` の応答で受け取る、running Project の pending continuation
 * 1件分の事実。**API と Worker の wire contract** なので shared に置く。
 *
 * `stuckForMs` は「検証された前進が無い時間」（ms）で、API が永続化済みの記録から計算する
 * （`apps/api/src/state/continuationProgress.ts`）。Worker の独立した backstop の材料であり、権限は持たない。
 */
export interface ContinuationProgressReport {
  continuationId: string
  projectId: string
  taskId?: string
  stuckForMs: number
}
