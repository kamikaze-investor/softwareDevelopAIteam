/**
 * Storage Interface
 *
 * レビュー指摘(2026-05-28): Phase 2でのPostgreSQL移行を容易にするため
 * Repository Patternでインターフェースを分離
 *
 * 実装の差し替えはこのinterfaceを実装したクラスを切り替えるだけでよい
 */

import type { Project, Task, Approval, Job, ReviewResult, QAResult, PermissionGrant, WatchdogEvent, ApprovalRequest, ApprovalGateStatus, TaskStatus, TaskSummary, DesignReviewEvidence, AuditLogEntry, ProjectRoadmapPhase, PersistedTaskFailureExplanationV1 } from '@ai-team/shared'
import type { KGNode, KGEdge, KGNodeType, KGEdgeType, DecisionRecord, IncidentRecord, IncidentSeverity, PatternRecord, FeatureDNA, PatternTrigger, SelfReflectionEntry, ReflectionTrigger } from '@ai-team/shared'
import type { RoadmapSyncTaskInput, RoadmapTaskSpecConflict, RoadmapSyncPhaseInput, RoadmapPhaseSpecConflict } from './roadmapTaskValidation'

export type { RoadmapSyncTaskInput, RoadmapTaskSpecConflict, RoadmapSyncPhaseInput, RoadmapPhaseSpecConflict } from './roadmapTaskValidation'

export type ResumeBlockedTaskResult =
  | { ok: true; job: Job }
  | { ok: false; code?: 'DESIGN_REVIEW_PRECONDITION_FAILED'; reason: string }

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
  | { ok: true; job: Job; deduplicated: boolean; queuedDesignReviewRun?: DesignReviewRun }
  | {
      ok: false
      code: 'JOB_NOT_FOUND' | 'OUTBOX_HASH_MISMATCH' | 'STORAGE_ERROR'
      reason: string
    }

export type PersistProviderTimeoutFailureResult =
  | {
      ok: true
      job: Job
      retryJob?: Job
      retryJobCreated: boolean
      deduplicated: boolean
    }
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
      code:
        | 'NOT_FOUND'
        | 'STATUS_CONFLICT'
        | 'EXPIRED'
        | 'JOB_NOT_FOUND'
        | 'JOB_NOT_UNIQUE'
        | 'JOB_MISMATCH'
        | 'DESIGN_REVIEW_PRECONDITION_FAILED'
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
  findFailureExplanation(jobId: string): PersistedTaskFailureExplanationV1 | undefined
  saveFailureExplanation(jobId: string, envelope: PersistedTaskFailureExplanationV1): void
  create(job: Omit<Job, 'id' | 'createdAt'>): Job
  update(id: string, data: Partial<Job>): Job | undefined
  /**
   * Job更新（+Outbox冪等化）を行う。
   * `queueDesignReview` を渡すと、terminal Job state と queued な design_review_run を
   * **同一transaction**で確定させる。分離するとcrash時に
   * 「Jobはfailed / runは無い / duplicate PATCHも再起動しない」というlost-trigger windowができる。
   */
  updateWithOutboxEvent(
    id: string,
    data: Partial<Job>,
    outboxEvent?: OutboxEventInput,
    queueDesignReview?: QueuedDesignReviewRunInput,
  ): UpdateWithOutboxEventResult
  /** provider timeout結果の保存と、条件を満たす1回限りのretry Job作成を単一transactionで行う。 */
  persistProviderTimeoutFailure(input: {
    jobId: string
    update: Partial<Job>
    outboxEvent?: OutboxEventInput
  }): PersistProviderTimeoutFailureResult
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

/**
 * Design Review の実行単位。API（Control Plane）が所有し、review専用runnerは
 * 実行するだけでこの表を書かない。
 *
 * stale completion fencing: claim時に `claim_token` を新規発行し、completeは
 * `claim_token` 一致 + `status='running'` を条件にする。requeueはtokenをNULLに
 * するため、requeue後に遅れて完了した旧attemptのUPDATEは必ず0行になり破棄される。
 */
export interface DesignReviewRun {
  id: string
  taskId: string
  designText: string
  designTextHash: string
  /** startup recovery後の再kickをrunだけで完結させるため、レビュー入力を自己完結で保持する。 */
  taskTitle: string
  changedFiles: string[]
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  attemptCount: number
  claimToken?: string
  resultJson?: string
  error?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

/** claim結果。claimできなかった場合は run=undefined。 */
export interface ClaimDesignReviewRunResult {
  run?: DesignReviewRun
  claimToken?: string
}

/** terminal Job update と同一transactionでqueue するDesign Review run の内容。 */
export interface QueuedDesignReviewRunInput {
  taskId: string
  taskTitle: string
  designText: string
  designTextHash: string
  changedFiles: string[]
}

export interface IDesignReviewRunStorage {
  findById(id: string): DesignReviewRun | undefined
  findActiveByTaskId(taskId: string): DesignReviewRun | undefined
  /** 同一Taskにqueued/running中のrunがある場合は作成せず既存を返す（partial unique index準拠）。 */
  create(input: Omit<DesignReviewRun, 'id' | 'status' | 'attemptCount' | 'claimToken' | 'resultJson' | 'error' | 'createdAt' | 'startedAt' | 'completedAt'>): DesignReviewRun
  /** startup recovery後に再kick対象となるqueued run一覧。 */
  findQueued(): DesignReviewRun[]
  /** queuedのrunをrunningへ遷移し、attempt_countを加算して新しいclaim_tokenを発行する。 */
  claim(id: string, maxAttempts: number): ClaimDesignReviewRunResult
  /** claim_token一致時のみ終端へ遷移する。不一致（stale）ならfalseを返し、呼び出し側は結果を破棄する。 */
  complete(id: string, claimToken: string, status: 'succeeded' | 'failed', resultJson?: string, error?: string): boolean
  /**
   * fencingに成功した場合のみ、run終端とevidence登録を単一transactionで行う。
   * claim_token不一致（stale attempt）のときはevidenceを登録せずfalseを返す。
   */
  completeWithEvidence(
    id: string,
    claimToken: string,
    resultJson: string,
    evidence: Omit<DesignReviewEvidence, 'id' | 'createdAt'>,
  ): DesignReviewEvidence | undefined
  /** claim_token一致時のみqueuedへ戻し、tokenを無効化する。 */
  requeue(id: string, claimToken: string, error: string): boolean
  /**
   * API process crash後の起動時回収専用。runningのまま残った行をqueuedへ戻す。
   * attempt_countがmaxAttempts以上の行はrequeueせずfailedで終端させる。
   * 通常のread経路からは呼ばない（GET/readは状態を変更しない）。
   *
   * `startedBefore` より後に開始したrunは対象外にする。現プロセスが起動した時刻を渡すことで、
   * 「今動いているrun」を巻き込まないことを保証し、誤って稼働中に呼ばれても実行中attemptを
   * 壊さない。回収対象は必ず前プロセスの残骸だけになる。
   */
  recoverStaleRunningAtStartup(maxAttempts: number, startedBefore: string): DesignReviewRun[]
}

/**
 * Gate評価のdurable evidence。
 *
 * 目的は「このcommit/diffに対してGate評価が実行され、結果がこうだった」ことを
 * API/DB側で独立に証明できるようにすることだけである。Gateの権限（Authority）は増やさない。
 *
 * ApprovalRequestは流用しない。あちらのstatus（WAITING_FOR_USER / APPROVED / REJECTED /
 * EXPIRED / SUPERSEDED / STALE / CONSUMED）とexpiresAt・requestedActionは
 * **人間承認専用のsemantics**であり、自動ALLOWを混ぜると承認待ち一覧・期限・consumeの
 * 意味が壊れるため。既存の`design_review_evidence`と同じ「決定のevidence」パターンに倣う。
 *
 * Workerの自己申告（`Job.guardResult`）はevidenceにしない。ここへ記録するのは
 * API側がGate評価を実行したその場の結果だけである。
 */
export interface GateEvaluationEvidence {
  id: string
  taskId: string
  jobId?: string
  targetBranch: string
  targetCommit: string
  targetDiffHash: string
  decision: string
  riskLevel: string
  triggeredRules: string[]
  /** どのGate policyで判断したかを後から一意に特定するための版。 */
  policyVersion: string
  /**
   * targetCommit / targetDiffHash がどこまで検証済みかを表す。
   *
   * - `authoritative`: 実worktreeのHEADとdiff hashへ照合済み（caller申告値ではない）。
   *   **保証範囲は targetCommit + targetDiffHash のみで、targetBranch は含まない**
   *   （`readExactApprovalDiff`は`rev-parse HEAD`と`git diff HEAD`だけを見る）。
   *   trust判断はcommit+diffで一意に成立し、branchは監査metadataとして保持するだけ。
   *   外部境界がevidenceを照合するときも commit+diff を対象にする
   * - `diff_text_hash`: callerが渡したdiff本文からAPIがhashを算出して一致を確認した
   *   （diff内容とhashは結び付くが、commitはcaller申告のまま）
   * - `unverified`: caller申告値のまま。**trusted bindingとして扱ってはならない**
   *
   * 外部境界（GitHub Actions等）がevidenceを機械検証する際は、
   * 少なくとも `unverified` を信頼してはならない。
   */
  bindingVerification: 'authoritative' | 'diff_text_hash' | 'unverified'
  /**
   * ALLOWした変更集合のcanonical change manifest hash。
   * API側がauthoritative repositoryから算出したときだけ入る。
   */
  approvedContentHash?: string
  /**
   * このALLOWを根拠に実際に作られたcommit。
   *
   * API/Control Plane自身がauthoritative repositoryで
   * (1) commitの実在 (2) parent === targetCommit (3) canonical manifest hash一致
   * を全て検証できた場合だけ非NULLになる。WorkerのcommitHashはtrust sourceにしない。
   *
   * 一度非NULLになったら別commitへbindし直さない（binding updateはCASで1回だけ）。
   */
  resultingCommit?: string
  createdAt: string
}

export interface IGateEvaluationStorage {
  create(data: Omit<GateEvaluationEvidence, 'id' | 'createdAt'>): GateEvaluationEvidence
  findByTaskId(taskId: string): GateEvaluationEvidence[]
  /** 対象commit/diffに対して実際に記録されたGate評価を引く（機械検証用）。 */
  findByTarget(targetCommit: string, targetDiffHash: string): GateEvaluationEvidence[]
  /** そのJob自身のGate評価を引く（「最新ALLOW」のような曖昧な選択をしないため）。 */
  findByJobId(jobId: string): GateEvaluationEvidence[]
  /** PR HEADから照合するための引き当て（ACTIONS_READONLY検証用）。 */
  findByResultingCommit(resultingCommit: string): GateEvaluationEvidence[]
  /**
   * authoritative verification成功時にresulting_commitをbindする。
   *
   * `resulting_commit IS NULL`をCAS条件にするため、at-least-once PATCHでも
   * bindingは1回だけ成立する。bind可能なのは
   * decision=ALLOW / binding_verification=authoritative / approved_content_hash有り /
   * jobId一致 のevidenceのみ。
   */
  bindResultingCommit(input: {
    evidenceId: string
    jobId: string
    resultingCommit: string
  }): boolean
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
  designReviewRuns: IDesignReviewRunStorage
  gateEvaluations: IGateEvaluationStorage
  auditLog: IAuditLogStorage
  projectRoadmapPhases: IProjectRoadmapPhaseStorage
  knowledgeGraph: IKnowledgeGraphStorage
  decisionCache: IDecisionCacheStorage
  incidentDB: IIncidentDBStorage
  patternLibrary: IPatternLibraryStorage
  featureDNA: IFeatureDNAStorage
  selfReflection: ISelfReflectionStorage
}
