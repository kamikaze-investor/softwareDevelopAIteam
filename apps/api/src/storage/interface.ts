/**
 * Storage Interface
 *
 * レビュー指摘(2026-05-28): Phase 2でのPostgreSQL移行を容易にするため
 * Repository Patternでインターフェースを分離
 *
 * 実装の差し替えはこのinterfaceを実装したクラスを切り替えるだけでよい
 */

import type { Project, Task, Approval, Job, ReviewResult, QAResult } from '@ai-team/shared'

export interface IProjectStorage {
  findAll(): Project[]
  findById(id: string): Project | undefined
  create(project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Project
  update(id: string, data: Partial<Project>): Project | undefined
}

export interface ITaskStorage {
  findByProjectId(projectId: string): Task[]
  findById(id: string): Task | undefined
  create(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task
  update(id: string, data: Partial<Task>): Task | undefined
}

export interface IJobStorage {
  findByTaskId(taskId: string): Job[]
  findById(id: string): Job | undefined
  create(job: Omit<Job, 'id' | 'createdAt'>): Job
  update(id: string, data: Partial<Job>): Job | undefined
}

export interface IApprovalStorage {
  findPendingByProjectId(projectId: string): Approval[]
  findById(id: string): Approval | undefined
  create(approval: Omit<Approval, 'id' | 'createdAt'>): Approval
  update(id: string, data: Partial<Approval>): Approval | undefined
}

export interface IReviewResultStorage {
  findByTaskId(taskId: string): ReviewResult[]
  findById(id: string): ReviewResult | undefined
  create(data: Omit<ReviewResult, 'id' | 'createdAt'>): ReviewResult
}

export interface IQAResultStorage {
  findByTaskId(taskId: string): QAResult[]
  findById(id: string): QAResult | undefined
  create(data: Omit<QAResult, 'id' | 'createdAt'>): QAResult
}

export interface IStorage {
  projects: IProjectStorage
  tasks: ITaskStorage
  jobs: IJobStorage
  approvals: IApprovalStorage
  reviewResults: IReviewResultStorage
  qaResults: IQAResultStorage
}
