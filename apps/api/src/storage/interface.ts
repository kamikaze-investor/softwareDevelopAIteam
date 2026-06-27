/**
 * Storage Interface
 *
 * レビュー指摘(2026-05-28): Phase 2でのPostgreSQL移行を容易にするため
 * Repository Patternでインターフェースを分離
 *
 * 実装の差し替えはこのinterfaceを実装したクラスを切り替えるだけでよい
 */

import type { Project, Task, Approval, Job, ReviewResult, QAResult, PermissionGrant, WatchdogEvent, ApprovalRequest, ApprovalGateStatus } from '@ai-team/shared'
import type { KGNode, KGEdge, KGNodeType, KGEdgeType } from '@ai-team/shared'

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

export interface IPermissionGrantStorage {
  findActiveByTaskId(taskId: string): PermissionGrant[]
  findById(id: string): PermissionGrant | undefined
  create(grant: Omit<PermissionGrant, 'id' | 'createdAt'>): PermissionGrant
  markUsed(id: string): PermissionGrant | undefined
  delete(id: string): boolean
}

export interface IApprovalRequestStorage {
  findByTaskId(taskId: string): ApprovalRequest[]
  findById(id: string): ApprovalRequest | undefined
  /** task_id で WAITING_FOR_USER / APPROVED 状態のものを返す（CONSUMED は除外） */
  findActiveByTaskId(taskId: string): ApprovalRequest | undefined
  create(data: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest
  /** preserveReviewMeta=true のとき reason/reviewedAt を上書きしない（consume 用） */
  updateStatus(id: string, status: ApprovalGateStatus, reason?: string, preserveReviewMeta?: boolean): ApprovalRequest | undefined
}

export interface IWatchdogEventStorage {
  findAll(): WatchdogEvent[]
  findByJobId(jobId: string): WatchdogEvent[]
  findById(id: string): WatchdogEvent | undefined
  create(event: Omit<WatchdogEvent, 'id' | 'createdAt'>): WatchdogEvent
  update(id: string, data: Partial<Pick<WatchdogEvent, 'status' | 'aiAnalysis' | 'isStuck' | 'resolvedAt'>>): WatchdogEvent | undefined
}

export interface IKnowledgeGraphStorage {
  // Node CRUD
  findNodeById(id: string): KGNode | undefined
  findNodesByType(type: KGNodeType): KGNode[]
  findNodesByPhase(phase: string): KGNode[]
  findNodesByTag(tag: string): KGNode[]
  createNode(data: Omit<KGNode, 'id' | 'createdAt' | 'updatedAt'>): KGNode
  updateNode(id: string, data: Partial<Omit<KGNode, 'id' | 'createdAt'>>): KGNode | undefined
  deleteNode(id: string): boolean

  // Edge CRUD
  findEdgeById(id: string): KGEdge | undefined
  findEdgesByFromNode(fromNodeId: string): KGEdge[]
  findEdgesByToNode(toNodeId: string): KGEdge[]
  findEdgesByType(edgeType: KGEdgeType): KGEdge[]
  createEdge(data: Omit<KGEdge, 'id' | 'createdAt'>): KGEdge
  deleteEdge(id: string): boolean
}

export interface IStorage {
  projects: IProjectStorage
  tasks: ITaskStorage
  jobs: IJobStorage
  approvals: IApprovalStorage
  reviewResults: IReviewResultStorage
  qaResults: IQAResultStorage
  permissionGrants: IPermissionGrantStorage
  watchdogEvents: IWatchdogEventStorage
  approvalRequests: IApprovalRequestStorage
  knowledgeGraph: IKnowledgeGraphStorage
}
