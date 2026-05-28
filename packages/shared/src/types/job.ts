// Job型定義 (Worker実行単位)

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'blocked'

export interface Job {
  id: string
  taskId: string
  projectId: string
  status: JobStatus
  command: string
  workingDir: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  changedFiles?: string[]
  commitHash?: string
  rollbackInfo?: RollbackInfo
  createdAt: string
}

export interface RollbackInfo {
  previousCommitHash: string
  changedFiles: string[]
  rollbackCommand: string
}
