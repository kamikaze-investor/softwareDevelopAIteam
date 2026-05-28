// Task型定義

export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assignee: 'cto_ai' | 'context_manager' | 'developer' | 'reviewer' | 'qa'
  dependencies: string[]  // task ids
  branchName?: string
  commitHash?: string
  createdAt: string
  updatedAt: string
}
