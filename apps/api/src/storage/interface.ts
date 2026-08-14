/**
 * Storage Interface
 *
 * レビュー指摘(2026-05-28): Phase 2でのPostgreSQL移行を容易にするため
 * Repository Patternでインターフェースを分離
 *
 * 実装の差し替えはこのinterfaceを実装したクラスを切り替えるだけでよい
 */

import type { Project, Task, Approval, Job, ReviewResult, QAResult, PermissionGrant, WatchdogEvent, ApprovalRequest, ApprovalGateStatus, TaskStatus, TaskSummary, DesignReviewEvidence, AuditLogEntry, ProjectRoadmapPhase } from '@ai-team/shared'
import type { KGNode, KGEdge, KGNodeType, KGEdgeType, DecisionRecord, IncidentRecord, IncidentSeverity, PatternRecord, FeatureDNA, PatternTrigger, SelfReflectionEntry, ReflectionTrigger } from '@ai-team/shared'
import type { RoadmapSyncTaskInput, RoadmapTaskSpecConflict, RoadmapSyncPhaseInput, RoadmapPhaseSpecConflict } from './roadmapTaskValidation'

export type { RoadmapSyncTaskInput, RoadmapTaskSpecConflict, RoadmapSyncPhaseInput, RoadmapPhaseSpecConflict } from './roadmapTaskValidation'

export type ResumeBlockedTaskResult =
  | { ok: true; job: Job }
  | { ok: false; code?: 'DESIGN_REVIEW_PRECONDITION_FAILED'; reason: string }

export type CreateTaskWithInitialImplementJobResult =
  | { ok: true; task: Task; job: Job }
  | { ok: false; code: 'STORAGE_ERROR'; reason: string }

export type AdvanceWorkflowJobResult =
  | { ok: true; job: Job; nextJob: Job; nextJobCreated: boolean; deduplicated?: boolean }
  | {
      ok: false
      code: 'JOB_NOT_FOUND' | 'NOT_WORKFLOW_JOB' | 'WORKFLOW_CONFLICT' | 'OUTBOX_HASH_MISMATCH' | 'STORAGE_ERROR'
      reason: string
    }

export interface OutboxEventInput {
  eventId: string
  payloadHash: string
}

export type UpdateWithOutboxEventResult =
  | { ok: true; job: Job; deduplicated: boolean }
  | {
      ok: false
      code: 'JOB_NOT_FOUND' | 'OUTBOX_HASH_MISMATCH' | 'STORAGE_ERROR'
      reason: string
    }

export type FailIfRunningJobResult =
  | { ok: true; updated: boolean; currentStatus: Job['status']; job: Job }
  | { ok: false; code: 'JOB_NOT_FOUND'; reason: string }

export type PersistReviewWorkflowResult =
  | {
      ok: true
      job: Job
      reviewResult: ReviewResult
      reviewResultCreated: boolean
      nextJob?: Job
      nextJobCreated: boolean
      deduplicated?: boolean
    }
  | {
      ok: false
      code:
        | 'JOB_NOT_FOUND'
        | 'NOT_WORKFLOW_JOB'
        | 'REVIEW_CONFLICT'
        | 'WORKFLOW_CONFLICT'
        | 'OUTBOX_HASH_MISMATCH'
        | 'STORAGE_ERROR'
      reason: string
    }

export type CreateApprovalForJobResult =
  | { ok: true; approvalRequest: ApprovalRequest }
  | { ok: false; code: 'JOB_NOT_FOUND' | 'JOB_MISMATCH' | 'JOB_ALREADY_LINKED'; reason: string }

export type ReviewApprovalAndResumeJobResult =
  | { ok: true; approvalRequest: ApprovalRequest; job: Job }
  | {
      ok: false
      code: 'NOT_FOUND' | 'STATUS_CONFLICT' | 'EXPIRED' | 'JOB_NOT_FOUND' | 'JOB_NOT_UNIQUE' | 'JOB_MISMATCH'
      reason: string
      approvalRequest?: ApprovalRequest
    }

export type ConsumeApprovalForJobResult =
  | { ok: true; approvalRequest: ApprovalRequest; jobId: string; alreadyConsumed: boolean }
  | {
      ok: false
      code:
        | 'NOT_FOUND'
        | 'STATUS_CONFLICT'
        | 'EXPIRED'
        | 'STALE'
        | 'JOB_NOT_FOUND'
        | 'JOB_NOT_UNIQUE'
        | 'JOB_MISMATCH'
      reason: string
      approvalRequest?: ApprovalRequest
      linkedJobId?: string
    }

export interface RoadmapSyncResult {
  ok: boolean
  createdTaskIds: string[]
  updatedTaskIds: string[]
  reactivatedTaskIds: string[]
  deactivatedTaskIds: string[]
  createdPhaseNumbers: number[]
  updatedPhaseNumbers: number[]
  reactivatedPhaseNumbers: number[]
  deactivatedPhaseNumbers: number[]
  failureReason?: string
  conflicts?: RoadmapTaskSpecConflict[]
  phaseConflicts?: RoadmapPhaseSpecConflict[]
}

export interface IProjectRoadmapPhaseStorage {
  /** roadmapActive=false（過去に消えたPhase）も含めて、phaseNumber昇順で全件返す */
  findByProjectId(projectId: string): ProjectRoadmapPhase[]
}

export interface IProjectStorage {
  findAll(): Project[]
  findById(id: string): Project | undefined
  /** status='running' のProjectを返す（MVPでは最大1件。存在しなければundefined） */
  findRunning(): Project | undefined
  create(project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Project
  update(id: string, data: Partial<Project>): Project | undefined
}

export interface ITaskStorage {
  findByProjectId(projectId: string): Task[]
  findById(id: string): Task | undefined
  findSummaries(options?: { limit?: number; projectId?: string; status?: TaskStatus }): TaskSummary[]
  /**
   * roadmapActive は省略可能で、省略時は false（＝現行ロードマップに属さない手動Task）として保存する。
   * roadmapTaskKey / phase / roadmapActive は内部のロードマップ同期処理のみが指定し、
   * 公開API（POST /api/tasks）からは設定できない。
   */
  create(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'roadmapActive'> & { roadmapActive?: boolean }): Task
  /** 手動Taskと、そのTask専用のinitial implement Jobを単一transactionで作成する。 */
  createWithInitialImplementJob(
    task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'roadmapActive'> & { roadmapActive?: boolean },
  ): CreateTaskWithInitialImplementJobResult
  update(id: string, data: Partial<Task>): Task | undefined
  /**
   * 検証済みロードマップTask一覧（と、あればPhase一覧）を、単一トランザクションでDBへ同期する。
   * 呼び出し前に validateRoadmapTasks() / validateRoadmapPhases() で自己整合性検証が済んでいる前提。
   * 失敗時はDBを一切変更しない。
   * phasesを省略した場合はTask同期のみ行い、Phase同期は行わない（既存呼び出し元の後方互換用）。
   */
  syncRoadmapTasks(input: {
    projectId: string
    tasks: RoadmapSyncTaskInput[]
    phases?: RoadmapSyncPhaseInput[]
  }): RoadmapSyncResult
}

export interface IJobStorage {
  findByTaskId(taskId: string): Job[]
  findById(id: string): Job | undefined
  create(job: Omit<Job, 'id' | 'createdAt'>): Job
  update(id: string, data: Partial<Job>): Job | undefined
  updateWithOutboxEvent(
    id: string,
    data: Partial<Job>,
    outboxEvent?: OutboxEventInput,
  ): UpdateWithOutboxEventResult
  failIfRunning(
    jobId: string,
    failure: { stderr: string; completedAt: string },
  ): FailIfRunningJobResult
  /** workflow Jobの結果保存と次step Jobの作成を単一transactionで冪等に行う。 */
  updateAndCreateNextWorkflowJob(input: {
    jobId: string
    update: Partial<Job>
    nextJob: Omit<Job, 'id' | 'createdAt' | 'workflowStepKey'> & { workflowStepKey: string }
    outboxEvent?: OutboxEventInput
  }): AdvanceWorkflowJobResult
  /** structured review保存・review Job更新・任意のworkflow次Job作成を原子的に行う。 */
  persistReviewWorkflowResult(input: {
    jobId: string
    update: Partial<Job>
    reviewResult: Pick<ReviewResult, 'status' | 'summary' | 'findings'>
    nextJob?: Omit<Job, 'id' | 'createdAt' | 'workflowStepKey'> & { workflowStepKey: string }
    outboxEvent?: OutboxEventInput
  }): PersistReviewWorkflowResult
  resumeBlockedTask(input: {
    taskId: string
    instructionPrompt: string
  }): ResumeBlockedTaskResult
}

export interface IApprovalStorage {
  /** 全Project横断でpending状態の承認のみを1クエリで取得する（N+1回避用） */
  findAllPending(): Approval[]
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
  /** status = WAITING_FOR_USER の全件を返す（health-score 用） */
  findWaiting(): ApprovalRequest[]
  create(data: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest
  /** git_commit Approval の作成と jobs.approval_id 設定を単一transactionで行う。 */
  createForJob(
    data: Omit<ApprovalRequest, 'id' | 'createdAt'>,
    jobId: string,
  ): CreateApprovalForJobResult
  /** WAITING_FOR_USER の git_commit Approval をCAS更新し、同一Jobをqueuedへ戻す。 */
  approveAndResumeJob(id: string, reason?: string): ReviewApprovalAndResumeJobResult
  /** Job/Task/Action/baselineを検証して git_commit Approval を一度だけconsumeする。 */
  consumeForJob(input: {
    id: string
    jobId: string
    currentCommit: string
    currentDiffHash: string
  }): ConsumeApprovalForJobResult
  /** preserveReviewMeta=true のとき reason/reviewedAt を上書きしない（consume 用） */
  updateStatus(id: string, status: ApprovalGateStatus, reason?: string, preserveReviewMeta?: boolean): ApprovalRequest | undefined
  /** 人間による APPROVED/REJECTED 決定を更新し、同一transactionでaudit_logへ記録する（PATCH /status 用） */
  recordDecision(id: string, status: 'APPROVED' | 'REJECTED', reason?: string): ApprovalRequest | undefined
}

export interface IDesignReviewEvidenceStorage {
  findById(id: string): DesignReviewEvidence | undefined
  findByTaskId(taskId: string): DesignReviewEvidence[]
  findLatestByTaskId(taskId: string): DesignReviewEvidence | undefined
  create(data: Omit<DesignReviewEvidence, 'id' | 'createdAt'>): DesignReviewEvidence
}

export interface IAuditLogStorage {
  findByEntity(entityType: string, entityId: string): AuditLogEntry[]
  findAll(): AuditLogEntry[]
  record(data: Omit<AuditLogEntry, 'id' | 'createdAt'>): AuditLogEntry
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

export interface IDecisionCacheStorage {
  findById(id: string): DecisionRecord | undefined
  findByKeywords(keywords: string[]): DecisionRecord[]
  findAll(): DecisionRecord[]
  create(data: Omit<DecisionRecord, 'id' | 'createdAt' | 'updatedAt'>): DecisionRecord
  update(id: string, data: Partial<Omit<DecisionRecord, 'id' | 'createdAt'>>): DecisionRecord | undefined
  delete(id: string): boolean
}

export interface IIncidentDBStorage {
  findById(id: string): IncidentRecord | undefined
  findByKeywords(keywords: string[]): IncidentRecord[]
  findBySeverity(severity: IncidentSeverity): IncidentRecord[]
  findAll(): IncidentRecord[]
  create(data: Omit<IncidentRecord, 'id' | 'createdAt'>): IncidentRecord
  delete(id: string): boolean
}

export interface IPatternLibraryStorage {
  findById(id: string): PatternRecord | undefined
  findByKeywords(keywords: string[]): PatternRecord[]
  findByFeatureType(featureType: string): PatternRecord[]
  findAll(): PatternRecord[]
  create(data: Omit<PatternRecord, 'id' | 'createdAt' | 'updatedAt'>): PatternRecord
  update(id: string, data: Partial<Omit<PatternRecord, 'id' | 'createdAt'>>): PatternRecord | undefined
  incrementUsage(id: string): PatternRecord | undefined
  delete(id: string): boolean
}

export interface IFeatureDNAStorage {
  findByNodeId(nodeId: string): FeatureDNA | undefined
  findAll(): FeatureDNA[]
  create(data: Omit<FeatureDNA, 'createdAt' | 'updatedAt'>): FeatureDNA
  update(nodeId: string, data: Partial<Omit<FeatureDNA, 'nodeId' | 'createdAt'>>): FeatureDNA | undefined
  appendHistory(nodeId: string, note: string): FeatureDNA | undefined
  delete(nodeId: string): boolean
}

export interface ISelfReflectionStorage {
  findById(id: string): SelfReflectionEntry | undefined
  findByTaskId(taskId: string): SelfReflectionEntry[]
  findByTrigger(trigger: ReflectionTrigger): SelfReflectionEntry[]
  findAll(): SelfReflectionEntry[]
  create(data: Omit<SelfReflectionEntry, 'id' | 'createdAt'>): SelfReflectionEntry
  delete(id: string): boolean
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
  designReviewEvidence: IDesignReviewEvidenceStorage
  auditLog: IAuditLogStorage
  projectRoadmapPhases: IProjectRoadmapPhaseStorage
  knowledgeGraph: IKnowledgeGraphStorage
  decisionCache: IDecisionCacheStorage
  incidentDB: IIncidentDBStorage
  patternLibrary: IPatternLibraryStorage
  featureDNA: IFeatureDNAStorage
  selfReflection: ISelfReflectionStorage
}
