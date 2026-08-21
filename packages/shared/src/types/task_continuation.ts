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
