/**
 * SQLite Storage 実装
 *
 * Race Condition対応済み（better-sqlite3は同期APIでトランザクション管理が容易）
 * Phase 2でPostgreSQLに移行する際はこのファイルをPostgres実装に差し替える
 * → IStorage インターフェースを実装した別クラスに切り替えるだけでよい
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CREATE_TABLES, INDEX_STATEMENTS, MIGRATION_STATEMENTS } from './schema'
import type { IStorage, IProjectStorage, ITaskStorage, IJobStorage, IApprovalStorage, IReviewResultStorage, IQAResultStorage, IPermissionGrantStorage, IWatchdogEventStorage, IApprovalRequestStorage, IDesignReviewEvidenceStorage, IGateEvaluationStorage, GateEvaluationEvidence, IDesignReviewRunStorage, DesignReviewRun, ClaimDesignReviewRunResult, ISupervisedRunStorage, SupervisedRun, CreateSupervisedRunResult, ClaimSupervisedRunResult, IAuditLogStorage, IProjectRoadmapPhaseStorage, IKnowledgeGraphStorage, IDecisionCacheStorage, IIncidentDBStorage, IPatternLibraryStorage, IFeatureDNAStorage, ISelfReflectionStorage, ResumeBlockedTaskResult, RoadmapSyncResult, CreateApprovalForJobResult, ReviewApprovalAndResumeJobResult, ConsumeApprovalForJobResult, AdvanceWorkflowJobResult, FailIfRunningJobResult, FailAndPrepareRepairResult, PersistReviewWorkflowResult, OutboxEventInput, UpdateWithOutboxEventResult, PersistProviderTimeoutFailureResult, ClearWorkspaceQuarantineResult, CreateRepairJobWithHandoffResult } from './interface'
import { computeTaskDisplayStatus, SUPERVISED_RUN_STALE_THRESHOLD_MS, isSupervisedRunKind } from '@ai-team/shared'
import type { SupervisedRunKind } from '@ai-team/shared'
import type { Project, Task, Approval, Job, JobStatus, JobWorkspaceBaseline, JobWorkspaceBaselineEntry, ReviewResult, QAResult, PermissionGrant, WatchdogEvent, ApprovalRequest, ApprovalGateStatus, DesignReviewEvidence, DesignReviewKind, AuditLogEntry, ProjectRoadmapPhase, KGNode, KGEdge, KGNodeType, KGEdgeType, DecisionRecord, IncidentRecord, IncidentSeverity, DecisionStatus, PatternRecord, FeatureDNA, PatternTrigger, SelfReflectionEntry, ReflectionTrigger, TaskSummary } from '@ai-team/shared'
import type { ITaskContinuationStorage, PersistCommitSuccessWithContinuationResult } from './interface'
import type { TaskContinuation } from '@ai-team/shared'
import type { RoadmapSyncTaskInput, RoadmapTaskSpecConflict, RoadmapSyncPhaseInput, RoadmapPhaseSpecConflict } from './roadmapTaskValidation'
import { TARGET_WORKING_DIR } from '../config/targetWorkingDir'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import { escalateTaskToHuman, isWorkspaceQuarantined, prepareRepairFlow } from '../designReview/repairFlow'

export class SingleRunningProjectError extends Error {
  constructor() {
    super('Another project is already running')
    this.name = 'SingleRunningProjectError'
  }
}

export class ArchiveBlockedByRunningJobError extends Error {
  constructor() {
    super('Cannot archive project while a Job is running')
    this.name = 'ArchiveBlockedByRunningJobError'
  }
}

export class RoadmapTaskConflictError extends Error {
  constructor(
    public readonly conflicts: RoadmapTaskSpecConflict[],
    public readonly phaseConflicts: RoadmapPhaseSpecConflict[] = [],
  ) {
    super(
      [
        conflicts.length > 0
          ? `Roadmap task spec conflicts detected for started/completed tasks: ${
              conflicts.map((conflict) => `${conflict.roadmapTaskKey}.${conflict.field}`).join(', ')
            }`
          : undefined,
        phaseConflicts.length > 0
          ? `Roadmap phase spec conflicts detected for phases with started tasks: ${
              phaseConflicts.map((conflict) => `phase${conflict.phaseNumber}.${conflict.field}`).join(', ')
            }`
          : undefined,
      ].filter(Boolean).join('; '),
    )
    this.name = 'RoadmapTaskConflictError'
  }
}

const now = () => new Date().toISOString()

function selectNextContinuableTask(tasks: Task[]): Task | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return tasks
    .filter((task) => (
      task.roadmapActive &&
      task.status === 'pending' &&
      task.assignee === 'developer_ai' &&
      task.dependencies.every((dependencyId) => byId.get(dependencyId)?.status === 'done')
    ))
    .sort((left, right) => (
      (left.phase ?? Number.MAX_SAFE_INTEGER) - (right.phase ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    ))[0]
}

const PersistedTaskFailureExplanationV1Schema = z.object({
  schemaVersion: z.literal(1),
  inputVersion: z.literal(1),
  contentHash: z.string(),
  generatedAt: z.string(),
  aiAnalysis: z.object({
    classification: z.enum([
      'code',
      'environment',
      'configuration',
      'permission_or_safety',
      'approval_or_policy',
      'unknown',
    ]),
    likelyCause: z.string(),
    impact: z.string(),
    recommendedNextAction: z.string(),
  }),
})

interface AppliedOutboxEventRow {
  event_id: string
  job_id: string
  payload_hash: string
  applied_at: string
}

type OutboxDedupCheck =
  | { status: 'new' }
  | { status: 'deduplicated' }
  | { status: 'conflict'; reason: string }

function checkOutboxEvent(
  db: Database.Database,
  jobId: string,
  outboxEvent: OutboxEventInput | undefined,
): OutboxDedupCheck {
  if (!outboxEvent) return { status: 'new' }

  const applied = db.prepare(
    'SELECT * FROM outbox_applied_events WHERE event_id = ?',
  ).get(outboxEvent.eventId) as AppliedOutboxEventRow | undefined

  if (!applied) return { status: 'new' }
  if (applied.job_id !== jobId) {
    return { status: 'conflict', reason: 'Outbox event belongs to another Job' }
  }
  if (applied.payload_hash !== outboxEvent.payloadHash) {
    return { status: 'conflict', reason: 'Outbox event payload hash mismatch' }
  }

  return { status: 'deduplicated' }
}

function recordOutboxEvent(
  db: Database.Database,
  jobId: string,
  outboxEvent: OutboxEventInput | undefined,
): void {
  if (!outboxEvent) return

  db.prepare(`
    INSERT INTO outbox_applied_events (event_id, job_id, payload_hash, applied_at)
    VALUES (?, ?, ?, ?)
  `).run(outboxEvent.eventId, jobId, outboxEvent.payloadHash, now())
}

function findJobByWorkflowStepKey(db: Database.Database, workflowStepKey: string): Job | undefined {
  const row = db.prepare(
    'SELECT * FROM jobs WHERE workflow_step_key = ?',
  ).get(workflowStepKey) as any
  return row ? deserializeJob(row) : undefined
}

function isSingleRunningProjectConstraintError(err: unknown): boolean {
  const sqliteError = err as { code?: unknown; message?: unknown }
  if (sqliteError.code !== 'SQLITE_CONSTRAINT_UNIQUE') return false

  const message = typeof sqliteError.message === 'string' ? sqliteError.message : ''
  return message.includes('ux_projects_single_running') || message.includes('projects.status')
}

function throwSingleRunningProjectError(err: unknown): never {
  if (isSingleRunningProjectConstraintError(err)) {
    throw new SingleRunningProjectError()
  }

  throw err
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

const ACTIVE_JOB_STATUSES = new Set<JobStatus>(['queued', 'running', 'blocked'])

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftValues = left ?? []
  const rightValues = right ?? []
  if (leftValues.length !== rightValues.length) return false

  return leftValues.every((value, index) => value === rightValues[index])
}

function sameStringArrayAsSet(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftValues = [...(left ?? [])].sort()
  const rightValues = [...(right ?? [])].sort()
  if (leftValues.length !== rightValues.length) return false

  return leftValues.every((value, index) => value === rightValues[index])
}

/**
 * PR-C final blocker (BLOCKER B): quarantine 解除の再検証用に、提示された observation が
 * 永続化された workspace baseline と**完全一致**かを判定する。
 *
 * 比較は workspace 検証（verifyWorkspaceAgainstBaseline）と同じ semantics を使う:
 *   - mode（'clean' / 'dirty'）が一致
 *   - startCommitHash が一致
 *   - dirty の場合: entry 件数が一致し、各 entry の記録済みフィールドが
 *     path 昇順（同値なら oldPath 昇順）の並び順非依存で完全一致
 * 1つでも不一致なら false（＝quarantine は維持される。fail-closed）。
 */
function baselineEqualsObservation(
  baseline: JobWorkspaceBaseline,
  observation: JobWorkspaceBaseline,
): boolean {
  if (baseline.mode !== observation.mode) return false
  if (baseline.startCommitHash !== observation.startCommitHash) return false
  if (baseline.mode === 'clean') return true

  const a = baseline.entries
  const b = (observation as Extract<JobWorkspaceBaseline, { mode: 'dirty' }>).entries
  if (a.length !== b.length) return false

  const sortEntries = (entries: JobWorkspaceBaselineEntry[]): JobWorkspaceBaselineEntry[] =>
    [...entries].sort((x, y) => {
      if (x.path < y.path) return -1
      if (x.path > y.path) return 1
      const xOld = x.oldPath ?? ''
      const yOld = y.oldPath ?? ''
      if (xOld < yOld) return -1
      if (xOld > yOld) return 1
      return 0
    })

  const sortedA = sortEntries(a)
  const sortedB = sortEntries(b)
  for (let i = 0; i < sortedA.length; i += 1) {
    if (!baselineEntryEqual(sortedA[i], sortedB[i])) return false
  }
  return true
}

function baselineEntryEqual(a: JobWorkspaceBaselineEntry, b: JobWorkspaceBaselineEntry): boolean {
  if (a.path !== b.path) return false
  if (norm(a.oldPath) !== norm(b.oldPath)) return false
  if (a.kind !== b.kind) return false
  if (norm(a.xyStatus) !== norm(b.xyStatus)) return false
  if (norm(a.beforeType) !== norm(b.beforeType)) return false
  if (norm(a.afterType) !== norm(b.afterType)) return false
  if (norm(a.beforeMode) !== norm(b.beforeMode)) return false
  if (norm(a.afterMode) !== norm(b.afterMode)) return false
  if (norm(a.headHash) !== norm(b.headHash)) return false
  if (norm(a.indexHash) !== norm(b.indexHash)) return false
  if (a.worktreeHash !== b.worktreeHash) return false
  return true
}

function norm(value: string | undefined): string {
  return value ?? ''
}

function resolveDependencyKeysForConflictCheck(
  dependencyTaskIds: string[] | undefined,
  projectTaskIdToRoadmapTaskKey: Map<string, string>,
  inputKeys: Set<string>,
): string[] | undefined {
  const dependencyKeys: string[] = []

  for (const dependencyTaskId of dependencyTaskIds ?? []) {
    const dependencyKey = projectTaskIdToRoadmapTaskKey.get(dependencyTaskId)
    if (!dependencyKey || !inputKeys.has(dependencyKey)) {
      return undefined
    }
    dependencyKeys.push(dependencyKey)
  }

  return dependencyKeys
}

function collectRoadmapTaskSpecConflicts(
  existingRoadmapTasks: Task[],
  inputByKey: Map<string, RoadmapSyncTaskInput>,
  inputKeys: Set<string>,
  projectTaskIdToRoadmapTaskKey: Map<string, string>,
  jobsByTaskId: Map<string, Job[]>,
): RoadmapTaskSpecConflict[] {
  const conflicts: RoadmapTaskSpecConflict[] = []

  function addConflict(roadmapTaskKey: string, field: RoadmapTaskSpecConflict['field']): void {
    conflicts.push({ roadmapTaskKey, field })
  }

  for (const existingTask of existingRoadmapTasks) {
    const roadmapTaskKey = existingTask.roadmapTaskKey
    if (!roadmapTaskKey) continue

    const roadmapTask = inputByKey.get(roadmapTaskKey)
    if (!roadmapTask) continue

    const hasJobHistory = (jobsByTaskId.get(existingTask.id) ?? []).length > 0
    const specLocked = hasJobHistory || existingTask.status !== 'pending'
    if (!specLocked) continue

    if (existingTask.title !== roadmapTask.title) addConflict(roadmapTaskKey, 'title')
    if (existingTask.description !== roadmapTask.description) addConflict(roadmapTaskKey, 'description')
    if (existingTask.phase !== roadmapTask.phase) addConflict(roadmapTaskKey, 'phase')
    if (existingTask.assignee !== roadmapTask.assignee) addConflict(roadmapTaskKey, 'assignee')
    if (!sameStringArrayAsSet(existingTask.allowedPaths, roadmapTask.allowedPaths)) {
      addConflict(roadmapTaskKey, 'allowedPaths')
    }
    if (!sameStringArrayAsSet(existingTask.acceptanceCriteria, roadmapTask.acceptanceCriteria)) {
      addConflict(roadmapTaskKey, 'acceptanceCriteria')
    }

    const dependencyKeys = resolveDependencyKeysForConflictCheck(
      existingTask.dependencies,
      projectTaskIdToRoadmapTaskKey,
      inputKeys,
    )
    if (!dependencyKeys || !sameStringArrayAsSet(dependencyKeys, roadmapTask.dependencies)) {
      addConflict(roadmapTaskKey, 'dependencies')
    }
  }

  return conflicts
}

/** pending Taskのqueued Jobは未実行であり、Phase metadataをlockしない。 */
function isTaskStarted(task: Task, jobsByTaskId: Map<string, Job[]>): boolean {
  const hasJobHistory = (jobsByTaskId.get(task.id) ?? []).some((job) => job.status !== 'queued')
  return hasJobHistory || task.status !== 'pending'
}

function groupTasksByPhase(tasks: Task[]): Map<number, Task[]> {
  const grouped = new Map<number, Task[]>()
  for (const task of tasks) {
    if (task.phase === undefined) continue
    const group = grouped.get(task.phase) ?? []
    group.push(task)
    grouped.set(task.phase, group)
  }
  return grouped
}

/**
 * 既に着手されたTaskを持つPhaseのname/goalが変更される場合をconflictとして検出する。
 * 「Phase番号の意味が再割り当てされ、着手済みTaskが誤ったPhase metadataへ紐づく」事故を防ぐ。
 */
function collectRoadmapPhaseSpecConflicts(
  existingPhases: ProjectRoadmapPhase[],
  inputByNumber: Map<number, RoadmapSyncPhaseInput>,
  tasksByPhase: Map<number, Task[]>,
  jobsByTaskId: Map<string, Job[]>,
): RoadmapPhaseSpecConflict[] {
  const conflicts: RoadmapPhaseSpecConflict[] = []

  for (const existingPhase of existingPhases) {
    const inputPhase = inputByNumber.get(existingPhase.phaseNumber)
    if (!inputPhase) continue // 消失したPhaseは別途disappearedPhasesとして扱う

    const phaseTasks = tasksByPhase.get(existingPhase.phaseNumber) ?? []
    const hasStartedTask = phaseTasks.some((task) => isTaskStarted(task, jobsByTaskId))
    if (!hasStartedTask) continue

    if (existingPhase.name !== inputPhase.name) {
      conflicts.push({ phaseNumber: existingPhase.phaseNumber, field: 'name' })
    }
    if (existingPhase.goal !== inputPhase.goal) {
      conflicts.push({ phaseNumber: existingPhase.phaseNumber, field: 'goal' })
    }
  }

  return conflicts
}

const DEFAULT_SUMMARY_LIMIT = 50

/**
 * supervised run の recovery 上限（Contract C-6）。**system policy であり、呼び出し側の引数にしない。**
 *
 * 独立レビュー指摘(2026-09-08 第2ラウンド): 上限を引数で受けると「bounded であること」が
 * 呼び出し側の善意に依存する。大きな値を渡せば C-6 は無効化でき、0 を渡せば健全な run を
 * 即座に recovery_exhausted へ落とせてしまう。bound は一箇所で固定する。
 */
export const MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS = 3
const MAX_SUMMARY_LIMIT = 100

function normalizeSummaryLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_SUMMARY_LIMIT
  return Math.min(Math.trunc(limit), MAX_SUMMARY_LIMIT)
}

function buildInPlaceholders(values: string[]): string {
  return values.map(() => '?').join(', ')
}

function latestByTaskId<T extends { taskId: string }>(items: T[]): Map<string, T> {
  const latest = new Map<string, T>()
  for (const item of items) {
    if (!latest.has(item.taskId)) {
      latest.set(item.taskId, item)
    }
  }
  return latest
}

function groupByTaskId<T extends { taskId: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const group = grouped.get(item.taskId) ?? []
    group.push(item)
    grouped.set(item.taskId, group)
  }
  return grouped
}

function resolveDesignReviewSubject(data: {
  reviewKind?: DesignReviewKind
  subjectId?: string
  taskId?: string
}): { reviewKind: DesignReviewKind; subjectId: string; taskId?: string } {
  const reviewKind = data.reviewKind ?? 'task'
  const subjectId = data.subjectId ?? data.taskId
  if (!subjectId) {
    throw new Error('Design Review subjectId is required when taskId is not provided')
  }

  if (reviewKind === 'roadmap') {
    return { reviewKind, subjectId }
  }

  return { reviewKind, subjectId, taskId: data.taskId ?? subjectId }
}

function newestIso(values: Array<string | undefined>): string {
  const validValues = values.filter((value): value is string => value !== undefined)
  return validValues.reduce((newest, value) => (
    Date.parse(value) > Date.parse(newest) ? value : newest
  ))
}

function buildTaskSummary(
  task: Task,
  projectName: string,
  latestJob: Job | undefined,
  approvalRequests: ApprovalRequest[],
): TaskSummary {
  const latestApproval = approvalRequests[0]
  const linkedApproval = latestJob?.approvalId
    ? approvalRequests.find(request => request.id === latestJob.approvalId)
    : undefined
  const latestApprovalStatus = latestApproval?.status

  return {
    taskId: task.id,
    projectId: task.projectId,
    projectName,
    title: task.title,
    description: task.description,
    taskStatus: task.status,
    latestJob: latestJob ? {
      jobId: latestJob.id,
      status: latestJob.status,
      approvalId: latestJob.approvalId,
      startedAt: latestJob.startedAt,
      completedAt: latestJob.completedAt,
      // MOB-001: 既存の failureMetadata をそのまま公開する（新しい status は作らない）。
      // 一覧で quarantine を通常の blocked と区別するために必要。
      quarantined: latestJob.failureMetadata?.quarantined === true,
    } : undefined,
    approvalSummary: {
      hasWaitingApproval: approvalRequests.some(request => request.status === 'WAITING_FOR_USER'),
      hasRejectedApproval: approvalRequests.some(request => request.status === 'REJECTED'),
      latestApprovalRequestId: latestApproval?.id,
      latestApprovalStatus,
      latestApprovalRiskLevel: latestApproval?.riskLevel,
    },
    displayStatus: computeTaskDisplayStatus({
      taskStatus: task.status,
      latestJobStatus: latestJob?.status,
      linkedApprovalStatus: linkedApproval?.status,
    }),
    updatedAt: newestIso([
      task.updatedAt,
      latestJob?.completedAt,
      latestJob?.startedAt,
      latestApproval?.createdAt,
    ]),
  }
}

function makeDecisionId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
  return `dc-${ymd}-${randomUUID().slice(0,3)}`
}

function makeIncidentId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
  return `inc-${ymd}-${randomUUID().slice(0,3)}`
}

function makePatternId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
  return `pat-${ymd}-${randomUUID().slice(0,3)}`
}

function makeReflectionId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
  return `ref-${ymd}-${randomUUID().slice(0,3)}`
}

export function createSQLiteStorage(dbPath: string): IStorage {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(CREATE_TABLES)
  runMigrations(db)
  runDesignReviewSubjectMigration(db)
  runIndexMigrations(db)

  // 各サブストレージのメソッド（jobs の repair decision 算出など）は呼び出し時に
  // `storage` 全体へアクセスする必要がある。クロージャ経由で late-assign する。
  let storage: IStorage

  const projects: IProjectStorage = {
    findAll() {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeProject)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
      return row ? deserializeProject(row) : undefined
    },
    findRunning() {
      const row = db.prepare("SELECT * FROM projects WHERE status = 'running' LIMIT 1").get() as any
      return row ? deserializeProject(row) : undefined
    },
    create(data) {
      const project: Project = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
        updatedAt: now(),
      }
      try {
        db.prepare(`
          INSERT INTO projects (id, name, goal, design_philosophy, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          project.id,
          project.name,
          project.goal,
          JSON.stringify(project.designPhilosophy),
          project.status,
          project.createdAt,
          project.updatedAt,
        )
      } catch (err: unknown) {
        throwSingleRunningProjectError(err)
      }
      return project
    },
    update(id, data) {
      const existing = projects.findById(id)
      if (!existing) return undefined

      if (data.status === 'archived') {
        const runningJob = db.prepare(
          `SELECT id FROM jobs WHERE project_id = ? AND status = 'running' LIMIT 1`
        ).get(id)
        if (runningJob) {
          throw new ArchiveBlockedByRunningJobError()
        }
      }

      const updated = { ...existing, ...data, updatedAt: now() }
      // startStageを同じUPDATEで書けるようにする。status='running'への遷移と開始stageの
      // 永続化を別writeにすると、その間のcrashで「runningだがstageが無い」Projectが残り、
      // recoveryがそれを推測で拾わざるを得なくなる。推測に頼ると、start_stage列導入前から
      // 存在するlegacy runningまで巻き込んで再初期化しかねない（独立レビュー指摘、2026-09-07）。
      const writesStage = Object.prototype.hasOwnProperty.call(data, 'startStage')
      try {
        db.prepare(`
          UPDATE projects SET name=?, goal=?, design_philosophy=?, status=?, updated_at=?${
            writesStage ? ', start_stage=?, start_stage_updated_at=?, start_blocked_reason=NULL' : ''
          } WHERE id=?
        `).run(
          updated.name,
          updated.goal,
          JSON.stringify(updated.designPhilosophy),
          updated.status,
          updated.updatedAt,
          ...(writesStage ? [updated.startStage ?? null, updated.updatedAt] : []),
          id,
        )
      } catch (err: unknown) {
        throwSingleRunningProjectError(err)
      }
      return updated
    },

    updateStartStage(id, stage, blockedReason) {
      const existing = this.findById(id)
      if (!existing) return undefined

      // blocked以外へ遷移するときは前回のblocked理由を必ず消す。残すと、進行中のstageに
      // 古い停止理由が張り付いたままMobileへ表示される。
      const reason = stage === 'blocked' ? (blockedReason ?? null) : null
      const stageUpdatedAt = now()
      db.prepare(`
        UPDATE projects SET start_stage=?, start_stage_updated_at=?, start_blocked_reason=? WHERE id=?
      `).run(stage, stageUpdatedAt, reason, id)

      return this.findById(id)
    },

    findInterruptedStarts() {
      // 終端stage（completed / blocked）は除外する。blockedはCEO判断待ちの安全停止であり、
      // 自動再開してはいけない（fail-closed）。
      //
      // stageが設定されていること自体が「開始要求を受理した」証拠になる。running遷移と
      // 開始stageは同一UPDATEで書かれるため、その間にcrash windowは存在しない。
      // stageがNULLのProjectは開始要求を受けていない（start_stage列導入前から存在する
      // legacy runningを含む）ので、推測で拾わない。
      const rows = db.prepare(`
        SELECT * FROM projects
        WHERE start_stage IS NOT NULL
          AND start_stage NOT IN ('completed', 'blocked')
        ORDER BY start_stage_updated_at
      `).all()
      return rows.map(deserializeProject)
    },
  }

  const tasks: ITaskStorage = {
    findByProjectId(projectId) {
      const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as any[]
      return rows.map(deserializeTask)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
      return row ? deserializeTask(row) : undefined
    },
    findSummaries(options) {
      const conditions: string[] = []
      const params: Array<string | number> = []

      if (options?.projectId) {
        conditions.push('t.project_id = ?')
        params.push(options.projectId)
      }
      if (options?.status) {
        conditions.push('t.status = ?')
        params.push(options.status)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      // 「最近作成されたTask」ではなく「最近活動があったTask」を上位に出すため、
      // Task本体・最新Job・最新ApprovalRequestの各活動時刻の最大値でORDER BYしてからLIMITする。
      // 相関サブクエリ2本＋本体1クエリの単一SQL文であり、Task件数分のクエリ発行や
      // 全Task IDを巨大なIN句へ詰める実装にはしていない。
      const taskRows = db.prepare(`
        SELECT t.*,
          MAX(
            t.updated_at,
            COALESCE((SELECT MAX(created_at) FROM jobs j WHERE j.task_id = t.id), ''),
            COALESCE((SELECT MAX(created_at) FROM approval_requests a WHERE a.task_id = t.id), '')
          ) AS last_activity_at
        FROM tasks t
        ${whereClause}
        ORDER BY last_activity_at DESC, t.id ASC
        LIMIT ?
      `).all(...params, normalizeSummaryLimit(options?.limit)) as any[]
      const taskList = taskRows.map(deserializeTask)
      if (taskList.length === 0) return []

      const taskIds = taskList.map(task => task.id)
      const placeholders = buildInPlaceholders(taskIds)
      const jobRows = db.prepare(`
        SELECT * FROM jobs
        WHERE task_id IN (${placeholders})
        ORDER BY task_id ASC, created_at DESC
      `).all(...taskIds) as any[]
      const latestJobs = latestByTaskId(jobRows.map(deserializeJob))

      const projectNameById = new Map(
        projects.findAll().map(project => [project.id, project.name] as const),
      )

      const approvalRows = db.prepare(`
        SELECT * FROM approval_requests
        WHERE task_id IN (${placeholders})
        ORDER BY task_id ASC, created_at DESC
      `).all(...taskIds) as any[]
      const approvalsByTaskId = groupByTaskId(approvalRows.map(deserializeApprovalRequest))

      return taskList.map(task => buildTaskSummary(
        task,
        projectNameById.get(task.projectId) ?? '',
        latestJobs.get(task.id),
        approvalsByTaskId.get(task.id) ?? [],
      ))
    },
    create(data) {
      const task: Task = {
        ...data,
        // 未指定は false（手動Task）。DBへは常に0/1のみを書き込む。
        roadmapActive: data.roadmapActive === true,
        id: randomUUID(),
        createdAt: now(),
        updatedAt: now(),
      }
      db.prepare(`
        INSERT INTO tasks
          (id, project_id, title, description, status, assignee, provider, dependencies,
           allowed_paths, forbidden_paths, acceptance_criteria, expected_outputs,
           roadmap_task_key, phase, roadmap_active, branch_name, commit_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.projectId,
        task.title,
        task.description,
        task.status,
        task.assignee,
        task.provider ?? null,
        JSON.stringify(task.dependencies),
        JSON.stringify(task.allowedPaths ?? []),
        JSON.stringify(task.forbiddenPaths ?? []),
        JSON.stringify(task.acceptanceCriteria ?? []),
        JSON.stringify(task.expectedOutputs ?? []),
        task.roadmapTaskKey ?? null,
        task.phase ?? null,
        task.roadmapActive ? 1 : 0,
        task.branchName ?? null,
        task.commitHash ?? null,
        task.createdAt,
        task.updatedAt,
      )
      return task
    },
    update(id, data) {
      const existing = tasks.findById(id)
      if (!existing) return undefined
      const updated: Task = {
        ...existing,
        ...data,
        // 未指定時は既存値を保持する（=== true で潰すと部分更新で暗黙にfalse化する）。
        // 指定時のみ厳密に真偽へ正規化し、DBへは常に0/1のみを書き込む。
        roadmapActive: data.roadmapActive === undefined
          ? existing.roadmapActive === true
          : data.roadmapActive === true,
        updatedAt: now(),
      }
      db.prepare(`
        UPDATE tasks SET
          title=?, description=?, status=?, assignee=?, provider=?, dependencies=?,
          allowed_paths=?, forbidden_paths=?, acceptance_criteria=?, expected_outputs=?,
          roadmap_task_key=?, phase=?, roadmap_active=?, branch_name=?, commit_hash=?, updated_at=?
        WHERE id=?
      `).run(
        updated.title,
        updated.description,
        updated.status,
        updated.assignee,
        updated.provider ?? null,
        JSON.stringify(updated.dependencies),
        JSON.stringify(updated.allowedPaths ?? []),
        JSON.stringify(updated.forbiddenPaths ?? []),
        JSON.stringify(updated.acceptanceCriteria ?? []),
        JSON.stringify(updated.expectedOutputs ?? []),
        updated.roadmapTaskKey ?? null,
        updated.phase ?? null,
        updated.roadmapActive ? 1 : 0,
        updated.branchName ?? null,
        updated.commitHash ?? null,
        updated.updatedAt,
        id,
      )
      return updated
    },
    syncRoadmapTasks(input) {
      const emptyFailureResult = (
        failureReason: string,
        conflicts?: RoadmapTaskSpecConflict[],
        phaseConflicts?: RoadmapPhaseSpecConflict[],
      ): RoadmapSyncResult => ({
        ok: false,
        createdTaskIds: [],
        updatedTaskIds: [],
        reactivatedTaskIds: [],
        deactivatedTaskIds: [],
        createdPhaseNumbers: [],
        updatedPhaseNumbers: [],
        reactivatedPhaseNumbers: [],
        deactivatedPhaseNumbers: [],
        failureReason,
        conflicts,
        phaseConflicts,
      })

      const syncTransaction = db.transaction((
        projectId: string,
        roadmapTasks: RoadmapSyncTaskInput[],
        roadmapPhases: RoadmapSyncPhaseInput[],
      ): RoadmapSyncResult => {
        const createdTaskIds: string[] = []
        const updatedTaskIdSet = new Set<string>()
        const reactivatedTaskIds: string[] = []
        const deactivatedTaskIds: string[] = []
        const createdPhaseNumbers: number[] = []
        const updatedPhaseNumbers: number[] = []
        const reactivatedPhaseNumbers: number[] = []
        const deactivatedPhaseNumbers: number[] = []
        const inputByKey = new Map(
          roadmapTasks.map((roadmapTask) => [roadmapTask.roadmapTaskKey, roadmapTask] as const),
        )
        const inputKeys = new Set(inputByKey.keys())
        const inputPhaseByNumber = new Map(
          roadmapPhases.map((phase) => [phase.phaseNumber, phase] as const),
        )
        const inputPhaseNumbers = new Set(inputPhaseByNumber.keys())

        const projectTaskRows = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId) as any[]
        const projectTasks = projectTaskRows.map(deserializeTask)
        const existingRoadmapTasks = projectTasks.filter((task) => task.roadmapTaskKey !== undefined)
        const projectJobs = (db.prepare('SELECT * FROM jobs WHERE project_id = ?').all(projectId) as any[])
          .map(deserializeJob)
        const jobsByTaskId = groupByTaskId(projectJobs)
        const projectTaskIdToRoadmapTaskKey = new Map(
          projectTasks
            .filter((task) => task.roadmapTaskKey !== undefined)
            .map((task) => [task.id, task.roadmapTaskKey as string] as const),
        )
        const disappearedTasks = existingRoadmapTasks.filter((task) => (
          task.roadmapTaskKey !== undefined && !inputKeys.has(task.roadmapTaskKey)
        ))
        const tasksByPhase = groupTasksByPhase(projectTasks)

        const existingPhaseRows = db.prepare(
          'SELECT * FROM project_roadmap_phases WHERE project_id = ?',
        ).all(projectId) as any[]
        const existingPhases = existingPhaseRows.map(deserializeProjectRoadmapPhase)
        const disappearedPhases = existingPhases.filter((phase) => (
          phase.roadmapActive && !inputPhaseNumbers.has(phase.phaseNumber)
        ))

        for (const task of disappearedTasks) {
          const activeJob = (jobsByTaskId.get(task.id) ?? [])
            .find((job) => ACTIVE_JOB_STATUSES.has(job.status))

          if (activeJob) {
            throw new Error(
              `Cannot deactivate roadmap task ${task.roadmapTaskKey} because job ${activeJob.id} is ${activeJob.status}`,
            )
          }
        }

        for (const phase of disappearedPhases) {
          const phaseTasks = tasksByPhase.get(phase.phaseNumber) ?? []
          const activeJobTask = phaseTasks.find((task) => (
            (jobsByTaskId.get(task.id) ?? []).some((job) => ACTIVE_JOB_STATUSES.has(job.status))
          ))

          if (activeJobTask) {
            throw new Error(
              `Cannot deactivate roadmap phase ${phase.phaseNumber} because task ${activeJobTask.id} has an active job`,
            )
          }
        }

        const conflicts = collectRoadmapTaskSpecConflicts(
          existingRoadmapTasks,
          inputByKey,
          inputKeys,
          projectTaskIdToRoadmapTaskKey,
          jobsByTaskId,
        )
        const phaseConflicts = collectRoadmapPhaseSpecConflicts(
          existingPhases,
          inputPhaseByNumber,
          tasksByPhase,
          jobsByTaskId,
        )
        if (conflicts.length > 0 || phaseConflicts.length > 0) {
          throw new RoadmapTaskConflictError(conflicts, phaseConflicts)
        }

        for (const inputPhase of roadmapPhases) {
          const existingPhase = existingPhases.find((phase) => phase.phaseNumber === inputPhase.phaseNumber)

          if (!existingPhase) {
            db.prepare(`
              INSERT INTO project_roadmap_phases
                (project_id, phase_number, name, goal, roadmap_active, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?)
            `).run(projectId, inputPhase.phaseNumber, inputPhase.name, inputPhase.goal, now(), now())
            createdPhaseNumbers.push(inputPhase.phaseNumber)
            continue
          }

          const specChanged = existingPhase.name !== inputPhase.name || existingPhase.goal !== inputPhase.goal
          const reactivating = !existingPhase.roadmapActive

          if (specChanged || reactivating) {
            db.prepare(`
              UPDATE project_roadmap_phases SET name=?, goal=?, roadmap_active=1, updated_at=?
              WHERE project_id=? AND phase_number=?
            `).run(inputPhase.name, inputPhase.goal, now(), projectId, inputPhase.phaseNumber)

            if (specChanged) updatedPhaseNumbers.push(inputPhase.phaseNumber)
            if (reactivating) reactivatedPhaseNumbers.push(inputPhase.phaseNumber)
          }
        }

        for (const phase of disappearedPhases) {
          db.prepare(`
            UPDATE project_roadmap_phases SET roadmap_active=0, updated_at=?
            WHERE project_id=? AND phase_number=?
          `).run(now(), projectId, phase.phaseNumber)
          deactivatedPhaseNumbers.push(phase.phaseNumber)
        }

        const roadmapTaskKeyToTaskId = new Map<string, string>()
        const dependencyUpdateKeys = new Set<string>()

        for (const roadmapTask of roadmapTasks) {
          const existingRow = db.prepare(
            'SELECT * FROM tasks WHERE project_id = ? AND roadmap_task_key = ?',
          ).get(projectId, roadmapTask.roadmapTaskKey) as any
          const existingTask = existingRow ? deserializeTask(existingRow) : undefined

          if (!existingTask) {
            const created = tasks.create({
              projectId,
              title: roadmapTask.title,
              description: roadmapTask.description,
              status: 'pending',
              assignee: roadmapTask.assignee,
              dependencies: [],
              allowedPaths: roadmapTask.allowedPaths,
              acceptanceCriteria: roadmapTask.acceptanceCriteria,
              roadmapTaskKey: roadmapTask.roadmapTaskKey,
              phase: roadmapTask.phase,
              roadmapActive: true,
            })
            createdTaskIds.push(created.id)
            roadmapTaskKeyToTaskId.set(roadmapTask.roadmapTaskKey, created.id)
            dependencyUpdateKeys.add(roadmapTask.roadmapTaskKey)
            continue
          }

          roadmapTaskKeyToTaskId.set(roadmapTask.roadmapTaskKey, existingTask.id)

          const taskJobs = jobsByTaskId.get(existingTask.id) ?? []
          const isUnstarted = taskJobs.length === 0 && existingTask.status === 'pending'

          if (isUnstarted) {
            dependencyUpdateKeys.add(roadmapTask.roadmapTaskKey)

            const specChanged =
              existingTask.title !== roadmapTask.title ||
              existingTask.description !== roadmapTask.description ||
              existingTask.phase !== roadmapTask.phase ||
              existingTask.assignee !== roadmapTask.assignee ||
              !sameStringArray(existingTask.allowedPaths, roadmapTask.allowedPaths) ||
              !sameStringArray(existingTask.acceptanceCriteria, roadmapTask.acceptanceCriteria) ||
              existingTask.roadmapActive !== true

            if (specChanged) {
              tasks.update(existingTask.id, {
                title: roadmapTask.title,
                description: roadmapTask.description,
                phase: roadmapTask.phase,
                assignee: roadmapTask.assignee,
                allowedPaths: roadmapTask.allowedPaths,
                acceptanceCriteria: roadmapTask.acceptanceCriteria,
                roadmapActive: true,
              })
              updatedTaskIdSet.add(existingTask.id)
            }
            continue
          }

          if (!existingTask.roadmapActive) {
            tasks.update(existingTask.id, { roadmapActive: true })
            reactivatedTaskIds.push(existingTask.id)
          }
        }

        for (const task of disappearedTasks) {
          if (task.roadmapActive) {
            tasks.update(task.id, { roadmapActive: false })
            deactivatedTaskIds.push(task.id)
          }
        }

        for (const roadmapTaskKey of dependencyUpdateKeys) {
          const roadmapTask = inputByKey.get(roadmapTaskKey)
          const taskId = roadmapTaskKeyToTaskId.get(roadmapTaskKey)

          if (!roadmapTask || !taskId) {
            throw new Error(`Cannot resolve roadmap task ${roadmapTaskKey}`)
          }

          const dependencyTaskIds = roadmapTask.dependencies.map((dependencyKey) => {
            const dependencyTaskId = roadmapTaskKeyToTaskId.get(dependencyKey)
            if (!dependencyTaskId) {
              throw new Error(`Cannot resolve dependency ${dependencyKey} for ${roadmapTaskKey}`)
            }
            return dependencyTaskId
          })
          const currentTask = tasks.findById(taskId)
          if (!currentTask) {
            throw new Error(`Cannot find task ${taskId} while resolving dependencies`)
          }

          if (!sameStringArray(currentTask.dependencies, dependencyTaskIds)) {
            tasks.update(taskId, { dependencies: dependencyTaskIds })
            if (!createdTaskIds.includes(taskId)) {
              updatedTaskIdSet.add(taskId)
            }
          }
        }

        return {
          ok: true,
          createdTaskIds,
          updatedTaskIds: [...updatedTaskIdSet],
          reactivatedTaskIds,
          deactivatedTaskIds,
          createdPhaseNumbers,
          updatedPhaseNumbers,
          reactivatedPhaseNumbers,
          deactivatedPhaseNumbers,
        }
      })

      try {
        return syncTransaction(input.projectId, input.tasks, input.phases ?? [])
      } catch (err: unknown) {
        if (err instanceof RoadmapTaskConflictError) {
          return emptyFailureResult(err.message, err.conflicts, err.phaseConflicts)
        }

        const message = err instanceof Error ? err.message : String(err)
        return emptyFailureResult(message)
      }
    },
  }

  const projectRoadmapPhases: IProjectRoadmapPhaseStorage = {
    findByProjectId(projectId) {
      const rows = db.prepare(
        'SELECT * FROM project_roadmap_phases WHERE project_id = ? ORDER BY phase_number ASC',
      ).all(projectId) as any[]
      return rows.map(deserializeProjectRoadmapPhase)
    },
  }

  const jobs: IJobStorage = {
    findByTaskId(taskId) {
      const rows = db.prepare('SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC').all(taskId) as any[]
      return rows.map(deserializeJob)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any
      return row ? deserializeJob(row) : undefined
    },
    findFailureExplanation(jobId) {
      const row = db.prepare(
        'SELECT failure_explanation_json FROM jobs WHERE id = ?',
      ).get(jobId) as { failure_explanation_json: string | null } | undefined
      if (!row?.failure_explanation_json) return undefined

      try {
        const savedValue: unknown = JSON.parse(row.failure_explanation_json)
        const parsed = PersistedTaskFailureExplanationV1Schema.safeParse(savedValue)
        return parsed.success
          ? parsed.data
          : undefined
      } catch {
        return undefined
      }
    },
    saveFailureExplanation(jobId, envelope) {
      db.prepare(
        'UPDATE jobs SET failure_explanation_json = ? WHERE id = ?',
      ).run(JSON.stringify(envelope), jobId)
    },
    create(data) {
      const job: Job = { ...data, id: randomUUID(), createdAt: now() }
      db.prepare(`
        INSERT INTO jobs
          (id, task_id, project_id, workflow_step_key, agent_role, status, safe_command,
           ai_cli_provider, ai_cli_prompt, ai_cli_mode, dry_run, failure_metadata,
           workspace_baseline, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.taskId,
        job.projectId,
        job.workflowStepKey ?? null,
        job.agentRole,
        job.status,
        JSON.stringify(job.safeCommand),
        job.aiCliProvider ?? null,
        job.aiCliPrompt ?? null,
        job.aiCliMode ?? null,
        job.dryRun ? 1 : 0,
        job.failureMetadata ? JSON.stringify(job.failureMetadata) : null,
        job.workspaceBaseline ? JSON.stringify(job.workspaceBaseline) : null,
        job.createdAt,
      )
      return job
    },
    update(id, data) {
      const existing = jobs.findById(id)
      if (!existing) return undefined


      // PR-C: quarantine 中の claim（queued -> running）は書き込み自体を成立させない。
      // listing 側の除外フィルタだけでは、取得後・claim前に quarantine された場合を
      // 取りこぼす（TOCTOU）。ここは generic PATCH も updateWithOutboxEvent も必ず通る
      // 単一の choke point であり、後者では同methodのtransaction内で評価されるため、
      // 「quarantine された workspace へ実際に claim が書かれる」ことが起こり得ない。
      if (data.status === 'running' && existing.status === 'queued') {
        if (isWorkspaceQuarantined(jobs.findByTaskId(existing.taskId))) {
          // 承認競合時（下記）と同じく、状態を変えずに現在値を返す。
          return existing
        }
      }
      // Approval承認とWorkerのblocked結果保存が競合した場合、承認transactionがqueuedへ
      // 戻したJobを古いblocked結果で巻き戻さない。実行結果も再注入せず、現在値を返す。
      if (data.status === 'blocked' && existing.approvalId) {
        const approvalRow = db.prepare(
          'SELECT status FROM approval_requests WHERE id = ?'
        ).get(existing.approvalId) as { status: ApprovalGateStatus } | undefined
        if (approvalRow?.status === 'APPROVED' || approvalRow?.status === 'CONSUMED') {
          return existing
        }
      }

      const updated = { ...existing, ...data }
      db.prepare(`
        UPDATE jobs SET
          status=?, started_at=?, completed_at=?, exit_code=?,
          stdout=?, stderr=?, stdout_path=?, stderr_path=?, changed_files=?, commit_hash=?,
          rollback_info=?, guard_result=?, failure_metadata=?, approval_id=?, workspace_baseline=?
        WHERE id=?
      `).run(
        updated.status,
        updated.startedAt ?? null,
        updated.completedAt ?? null,
        updated.exitCode ?? null,
        updated.stdout ?? null,
        updated.stderr ?? null,
        updated.stdoutPath ?? null,
        updated.stderrPath ?? null,
        JSON.stringify(updated.changedFiles ?? []),
        updated.commitHash ?? null,
        updated.rollbackInfo ? JSON.stringify(updated.rollbackInfo) : null,
        updated.guardResult ? JSON.stringify(updated.guardResult) : null,
        updated.failureMetadata ? JSON.stringify(updated.failureMetadata) : null,
        updated.approvalId ?? null,
        updated.workspaceBaseline ? JSON.stringify(updated.workspaceBaseline) : null,
        id,
      )
      return updated
    },
    updateWithOutboxEvent(id, data, outboxEvent, queueDesignReview) {
      const updateTransaction = db.transaction((): UpdateWithOutboxEventResult => {
        const dedup = checkOutboxEvent(db, id, outboxEvent)
        if (dedup.status === 'conflict') {
          return { ok: false, code: 'OUTBOX_HASH_MISMATCH', reason: dedup.reason }
        }
        if (dedup.status === 'deduplicated') {
          const job = jobs.findById(id)
          if (!job) {
            return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
          }
          return { ok: true, job, deduplicated: true }
        }

        const updated = jobs.update(id, data)
        if (!updated) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }
        recordOutboxEvent(db, id, outboxEvent)

        // Stage 2 の起動条件が満たされている場合、terminal Job state と
        // queued な design_review_run を**同一transaction**で確定させる。
        // これを分けると「Jobはfailed / runは無い」というlost-trigger windowができる。
        let queuedDesignReviewRun: DesignReviewRun | undefined
        if (queueDesignReview) {
          queuedDesignReviewRun = designReviewRuns.create(queueDesignReview)
        }

        return { ok: true, job: updated, deduplicated: false, queuedDesignReviewRun }
      })

      try {
        // PR-C: claim（queued -> running）を含むこのtransactionは IMMEDIATE で開始する。
        // deferred のままだと最初の書き込みまで write lock を取らないため、quarantine 判定を
        // 読んだ後・claim を書く前に別connectionが quarantine を書ける隙が残る。
        // IMMEDIATE なら BEGIN 時点で write lock を取るので、判定と書き込みが直列化される。
        return updateTransaction.immediate()
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
    persistCommitSuccessWithContinuation(input) {
      const persistTransaction = db.transaction((): PersistCommitSuccessWithContinuationResult => {
        const dedup = checkOutboxEvent(db, input.jobId, input.outboxEvent)
        if (dedup.status === 'conflict') {
          return { ok: false, code: 'OUTBOX_HASH_MISMATCH', reason: dedup.reason }
        }

        const source = jobs.findById(input.jobId)
        if (!source) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }

        if (dedup.status === 'deduplicated') {
          const continuation = taskContinuations.findBySourceJobId(input.jobId)
          if (!continuation) {
            return { ok: false, code: 'STORAGE_ERROR', reason: 'Applied commit result is missing its continuation' }
          }
          return { ok: true, job: source, continuation, deduplicated: true }
        }

        const sourceTask = tasks.findById(source.taskId)
        if (!sourceTask) {
          return { ok: false, code: 'STORAGE_ERROR', reason: 'Source Task not found' }
        }

        const updated = jobs.update(input.jobId, input.update)
        if (!updated) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }
        recordOutboxEvent(db, input.jobId, input.outboxEvent)

        if (sourceTask.status !== 'done') {
          tasks.update(sourceTask.id, { status: 'done' })
        }

        const project = projects.findById(sourceTask.projectId)
        const nextTask = project?.status === 'archived'
          ? undefined
          : selectNextContinuableTask(tasks.findByProjectId(sourceTask.projectId))
        const continuation = taskContinuations.findByCompletedTaskId(sourceTask.id)
          ?? taskContinuations.create({
            sourceJobId: source.id,
            projectId: sourceTask.projectId,
            completedTaskId: sourceTask.id,
            nextTaskId: nextTask?.id,
            status: nextTask ? 'pending' : 'completed',
          })

        return { ok: true, job: updated, continuation, deduplicated: false }
      })

      try {
        return persistTransaction()
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },

    persistProviderTimeoutFailure(input) {
      const persistTransaction = db.transaction((): PersistProviderTimeoutFailureResult => {
        const dedup = checkOutboxEvent(db, input.jobId, input.outboxEvent)
        if (dedup.status === 'conflict') {
          return { ok: false, code: 'OUTBOX_HASH_MISMATCH', reason: dedup.reason }
        }
        if (dedup.status === 'deduplicated') {
          const job = jobs.findById(input.jobId)
          if (!job) {
            return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Source Job not found' }
          }
          const retryJob = findJobByWorkflowStepKey(db, `retry:${job.id}:1`)
          return {
            ok: true,
            job,
            retryJob,
            retryJobCreated: false,
            deduplicated: true,
          }
        }

        const source = jobs.findById(input.jobId)
        if (!source) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Source Job not found' }
        }

        if (source.status !== 'running') {
          return {
            ok: true,
            job: source,
            retryJobCreated: false,
            deduplicated: false,
          }
        }

        const updated = jobs.update(source.id, input.update)
        if (!updated) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Source Job not found' }
        }

        const finishWithoutRetry = (): PersistProviderTimeoutFailureResult => {
          recordOutboxEvent(db, source.id, input.outboxEvent)
          return {
            ok: true,
            job: updated,
            retryJobCreated: false,
            deduplicated: false,
          }
        }

        if (
          updated.status !== 'failed' ||
          updated.failureMetadata?.kind !== 'provider_timeout' ||
          updated.failureMetadata.workspaceState !== 'unchanged' ||
          updated.aiCliMode !== 'implement' ||
          updated.workflowStepKey?.startsWith('retry:') === true
        ) {
          return finishWithoutRetry()
        }

        const retryWorkflowStepKey = `retry:${source.id}:1`
        const existingRetry = findJobByWorkflowStepKey(db, retryWorkflowStepKey)
        if (existingRetry) {
          recordOutboxEvent(db, source.id, input.outboxEvent)
          return {
            ok: true,
            job: updated,
            retryJob: existingRetry,
            retryJobCreated: false,
            deduplicated: false,
          }
        }

        const activeJob = db.prepare(`
          SELECT id FROM jobs
          WHERE task_id = ? AND status IN ('queued', 'running')
          LIMIT 1
        `).get(source.taskId) as { id: string } | undefined
        if (activeJob) {
          return finishWithoutRetry()
        }

        const task = tasks.findById(source.taskId)
        const project = projects.findById(source.projectId)
        if (
          !task ||
          task.projectId !== source.projectId ||
          task.status === 'blocked' ||
          task.status === 'done' ||
          !project ||
          project.status !== 'running'
        ) {
          return finishWithoutRetry()
        }

        const latestApprovalRow = db.prepare(`
          SELECT status FROM approval_requests
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(source.taskId) as { status: ApprovalGateStatus } | undefined
        if (
          latestApprovalRow?.status === 'WAITING_FOR_USER' ||
          latestApprovalRow?.status === 'REJECTED'
        ) {
          return finishWithoutRetry()
        }

        const latestJobRow = db.prepare(`
          SELECT id, status FROM jobs
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `).get(source.taskId) as { id: string; status: JobStatus } | undefined
        if (latestJobRow?.id !== source.id && latestJobRow?.status === 'blocked') {
          return finishWithoutRetry()
        }

        const designReviewCheck = checkImplementJobDesignReviewEvidence(updated, designReviewEvidence)
        if (!designReviewCheck.ok) {
          return finishWithoutRetry()
        }

        const retryJob = jobs.create({
          taskId: source.taskId,
          projectId: source.projectId,
          workflowStepKey: retryWorkflowStepKey,
          agentRole: source.agentRole,
          status: 'queued',
          safeCommand: source.safeCommand,
          dryRun: source.dryRun,
          aiCliProvider: source.aiCliProvider,
          aiCliPrompt: source.aiCliPrompt,
          aiCliMode: source.aiCliMode,
        })
        recordOutboxEvent(db, source.id, input.outboxEvent)
        return {
          ok: true,
          job: updated,
          retryJob,
          retryJobCreated: true,
          deduplicated: false,
        }
      })

      try {
        return persistTransaction()
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
    failIfRunning(jobId, failure) {
      const transition = db.transaction((): FailIfRunningJobResult => {
        const updateResult = db.prepare(`
          UPDATE jobs
          SET status = 'failed', stderr = ?, completed_at = ?
          WHERE id = ? AND status = 'running'
        `).run(failure.stderr, failure.completedAt, jobId)

        const job = jobs.findById(jobId)
        if (!job) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }

        return {
          ok: true,
          updated: updateResult.changes === 1,
          currentStatus: job.status,
          job,
        }
      })

      return transition()
    },
    failAndPrepareRepair(input) {
      const transition = db.transaction((): FailAndPrepareRepairResult => {
        const dedup = checkOutboxEvent(db, input.jobId, input.outboxEvent)
        if (dedup.status === 'conflict') {
          return { ok: false, code: 'OUTBOX_HASH_MISMATCH', reason: dedup.reason }
        }

        const existing = jobs.findById(input.jobId)
        if (!existing) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }

        if (dedup.status === 'deduplicated') {
          // dedup で既に適用済みの結果が見つかった場合は、CAS loser のように振る舞わず
          // 元の durable outcome（現在のJob状態）をそのまま返す。
          return {
            ok: true,
            updated: true,
            currentStatus: existing.status,
            job: existing,
            quarantined: existing.failureMetadata?.quarantined === true,
            deduplicated: true,
          }
        }

        // F9: pre-transition quarantine guard（fail-closed）。
        // このTaskの任意のJobが quarantine（未検証 workspace）状態にある場合、
        // その所有権を荒らす遷移・介入を一切受け付けない。dedup replay（read-only）は
        // 上の早回りで処理済みのため、ここで拒否されるのは常に「新しい遷移」のみ。
        if (isWorkspaceQuarantined(jobs.findByTaskId(existing.taskId))) {
          return {
            ok: false,
            code: 'WORKSPACE_QUARANTINED',
            reason: 'Task has a quarantined (un-verified) workspace; refusing to transition, fail-closed',
          }
        }

        // CAS WINNER のみここへ到達する。
        // 目的語の状態は workspace 検証結果で決まる:
        //   - verified safe → `failed`（所有権解放してよい。workspace はクリーンと証明済み）
        //   - NOT verified → `blocked`（所有権を保持する。未検証 workspace は他人に渡さない）
        // 「未検証 workspace で所有権を解放してはならない」が load-bearing rule。
        const targetStatus: Job['status'] = input.workspaceVerified ? 'failed' : 'blocked'

        const failureMetadata = input.workspaceVerified
          ? (input.failureMetadata ?? {})
          : {
              ...(input.failureMetadata ?? {}),
              quarantined: true,
              quarantineReason: input.quarantineReason ?? 'workspace not verified safe after crash',
            }

        const casResult = db.prepare(`
          UPDATE jobs SET status = ?, stderr = ?, completed_at = ?, failure_metadata = ?
          WHERE id = ? AND status = 'running'
        `).run(
          targetStatus,
          input.failure.stderr,
          input.failure.completedAt,
          Object.keys(failureMetadata).length > 0 ? JSON.stringify(failureMetadata) : null,
          input.jobId,
        )

        if (casResult.changes !== 1) {
          // CAS loser: 副作用は一切発生させない。
          const current = jobs.findById(input.jobId)!
          return {
            ok: true,
            updated: false,
            currentStatus: current.status,
            job: current,
            quarantined: false,
          }
        }

        recordOutboxEvent(db, input.jobId, input.outboxEvent)

        // CAS WINNER 限定で、この transaction 内の read から修復決定を算出して適用する
        // （関数外で計算した決定を受け取らない — 古い可能性があるため）。
        const winner = jobs.findById(input.jobId)!

        if (input.workspaceVerified) {
          const preparation = prepareRepairFlow(storage, { failedJob: winner })
          if (preparation.action === 'escalate') {
            escalateTaskToHuman(storage, winner.taskId)
          } else if (preparation.action === 'queue') {
            // Job の終端状態と queued design_review_run を同一 transaction で確定し、
            // lost-trigger window（Job は failed / run は無い）を生まない。
            designReviewRuns.create(preparation.run)
            // F8: queue intent は所有権を解放しない（Job を blocked に保つ）。
            // run と repair Job の間に crash しても、workspace が進行中Jobのどれにも
            // 属さない孤児になるのを防ぐ。repair Job が実体化した後の遷移に任せる。
            jobs.update(input.jobId, { status: 'blocked' })
          }
          // 'skip' → 追加の修復意図は作らない。
        } else {
          // workspace が quarantine された（='blocked'）ため、自律修復 Job は作れない。
          // fail-closed に Human escalation（Task blocked）で所有権を保持する。
          escalateTaskToHuman(storage, winner.taskId)
        }

        const final = jobs.findById(input.jobId)!
        return {
          ok: true,
          updated: true,
          currentStatus: final.status,
          job: final,
          quarantined: final.failureMetadata?.quarantined === true,
        }
      })

      try {
        return transition()
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
    createRepairJobWithHandoff(input) {
      const handoffTransaction = db.transaction((): CreateRepairJobWithHandoffResult => {
        // 1) 後続 repair Job を**先に**作成する。所有権保持（queued + non-initial
        //    workflowStepKey）であり、source Job を解放する前に workspace の所有者が
        //    1本でも存在することを保証する。
        //    Job 作成が一意制約等で失敗したら例外が throw され、transaction 全体が
        //    rollback して source Job は `blocked`（所有権保持）のまま残る。
        const repairJob = jobs.create({
          ...input.repairJob,
          status: 'queued',
        } as never)

        // 2) source Job を所有権保持状態（`blocked` 等）から `failed` へ解放する。
        //    `failed` は所有権を持たない（Job status からの所有権導出: running | blocked
        //    | non-initial queued のみが所有）。既に failed なら no-op になる。
        const source = jobs.findById(input.sourceJobId)
        if (!source) {
          // 所有権を保持し続けてよい repair Job が既に作られた後では rollback する
          // （throw で transaction を abort し、repair Job の作成も巻き戻す）。
          throw new Error(`source job ${input.sourceJobId} not found for repair handoff`)
        }
        jobs.update(source.id, { status: 'failed' })

        // 3) この handoff に属する Task / recovery 状態更新を適用する。
        if (input.taskUpdate) {
          tasks.update(source.taskId, input.taskUpdate)
        }

        return { ok: true, repairJob }
      })

      try {
        return handoffTransaction()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (/not found for repair handoff/.test(message)) {
          return {
            ok: false,
            code: 'SOURCE_JOB_NOT_FOUND',
            reason: message,
          }
        }
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: message,
        }
      }
    },
    updateAndCreateNextWorkflowJob(input) {
      const transition = db.transaction((): AdvanceWorkflowJobResult => {
        const dedup = checkOutboxEvent(db, input.jobId, input.outboxEvent)
        if (dedup.status === 'conflict') {
          return { ok: false, code: 'OUTBOX_HASH_MISMATCH', reason: dedup.reason }
        }
        if (dedup.status === 'deduplicated') {
          const job = jobs.findById(input.jobId)
          if (!job) {
            return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Source Job not found' }
          }
          const nextJob = findJobByWorkflowStepKey(db, input.nextJob.workflowStepKey)
          if (!nextJob) {
            return { ok: false, code: 'STORAGE_ERROR', reason: 'Applied Outbox event is missing its next workflow Job' }
          }
          return { ok: true, job, nextJob, nextJobCreated: false, deduplicated: true }
        }

        const source = jobs.findById(input.jobId)
        if (!source) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Source Job not found' }
        }
        if (!source.workflowStepKey) {
          return { ok: false, code: 'NOT_WORKFLOW_JOB', reason: 'Manual Job cannot advance the automatic workflow' }
        }

        const existingRow = db.prepare(
          'SELECT * FROM jobs WHERE workflow_step_key = ?',
        ).get(input.nextJob.workflowStepKey) as any
        const existingNext = existingRow ? deserializeJob(existingRow) : undefined
        if (
          existingNext &&
          (existingNext.taskId !== input.nextJob.taskId || existingNext.projectId !== input.nextJob.projectId)
        ) {
          return { ok: false, code: 'WORKFLOW_CONFLICT', reason: 'Workflow step key belongs to another Task or Project' }
        }

        const updated = jobs.update(input.jobId, input.update)
        if (!updated) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Source Job not found' }
        }
        if (existingNext) {
          recordOutboxEvent(db, input.jobId, input.outboxEvent)
          return { ok: true, job: updated, nextJob: existingNext, nextJobCreated: false, deduplicated: false }
        }

        const nextJob = jobs.create(input.nextJob)
        recordOutboxEvent(db, input.jobId, input.outboxEvent)
        return { ok: true, job: updated, nextJob, nextJobCreated: true, deduplicated: false }
      })

      try {
        return transition()
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
    persistReviewWorkflowResult(input) {
      const persistTransaction = db.transaction((): PersistReviewWorkflowResult => {
        const dedup = checkOutboxEvent(db, input.jobId, input.outboxEvent)
        if (dedup.status === 'conflict') {
          return { ok: false, code: 'OUTBOX_HASH_MISMATCH', reason: dedup.reason }
        }
        if (dedup.status === 'deduplicated') {
          const job = jobs.findById(input.jobId)
          if (!job) {
            return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Review Job not found' }
          }
          const existingReviewRow = db.prepare(
            'SELECT * FROM review_results WHERE job_id = ?',
          ).get(input.jobId) as any
          const reviewResult = existingReviewRow
            ? deserializeReviewResult(existingReviewRow)
            : undefined
          if (!reviewResult) {
            return { ok: false, code: 'STORAGE_ERROR', reason: 'Applied Outbox event is missing its ReviewResult' }
          }
          const nextJob = input.nextJob
            ? findJobByWorkflowStepKey(db, input.nextJob.workflowStepKey)
            : undefined
          if (input.nextJob && !nextJob) {
            return { ok: false, code: 'STORAGE_ERROR', reason: 'Applied Outbox event is missing its next workflow Job' }
          }
          return {
            ok: true,
            job,
            reviewResult,
            reviewResultCreated: false,
            nextJob,
            nextJobCreated: false,
            deduplicated: true,
          }
        }

        const source = jobs.findById(input.jobId)
        if (!source) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Review Job not found' }
        }
        if (source.aiCliMode !== 'review') {
          return { ok: false, code: 'NOT_WORKFLOW_JOB', reason: 'Only review Jobs can persist structured reviews' }
        }

        const existingReviewRow = db.prepare(
          'SELECT * FROM review_results WHERE job_id = ?',
        ).get(source.id) as any
        const existingReview = existingReviewRow
          ? deserializeReviewResult(existingReviewRow)
          : undefined
        if (
          existingReview &&
          (existingReview.status !== input.reviewResult.status ||
            existingReview.summary !== input.reviewResult.summary ||
            JSON.stringify(existingReview.findings) !== JSON.stringify(input.reviewResult.findings))
        ) {
          return { ok: false, code: 'REVIEW_CONFLICT', reason: 'Review result resend does not match the saved result' }
        }

        let existingNext: Job | undefined
        if (input.nextJob) {
          const existingNextRow = db.prepare(
            'SELECT * FROM jobs WHERE workflow_step_key = ?',
          ).get(input.nextJob.workflowStepKey) as any
          existingNext = existingNextRow ? deserializeJob(existingNextRow) : undefined
          if (
            existingNext &&
            (existingNext.taskId !== input.nextJob.taskId || existingNext.projectId !== input.nextJob.projectId)
          ) {
            return { ok: false, code: 'WORKFLOW_CONFLICT', reason: 'Workflow step key belongs to another Task or Project' }
          }
        }

        const updated = jobs.update(source.id, input.update)
        if (!updated) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Review Job not found' }
        }
        const reviewResult = existingReview ?? reviewResults.create({
          taskId: source.taskId,
          jobId: source.id,
          reviewer: source.agentRole,
          ...input.reviewResult,
        })
        const nextJob = existingNext ?? (input.nextJob ? jobs.create(input.nextJob) : undefined)

        recordOutboxEvent(db, source.id, input.outboxEvent)
        return {
          ok: true,
          job: updated,
          reviewResult,
          reviewResultCreated: existingReview === undefined,
          nextJob,
          nextJobCreated: input.nextJob !== undefined && existingNext === undefined,
          deduplicated: false,
        }
      })

      try {
        return persistTransaction()
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
    resumeBlockedTask(input) {
      const resumeTransaction = db.transaction((taskId: string, instructionPrompt: string): ResumeBlockedTaskResult => {
        const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any
        if (!taskRow) {
          return { ok: false, reason: 'Task not found' }
        }

        const jobRows = db.prepare(
          'SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at DESC'
        ).all(taskId) as any[]
        const taskJobs = jobRows.map(deserializeJob)
        const latestJob = taskJobs[0]

        if (!latestJob) {
          return { ok: false, reason: 'No jobs exist for this task' }
        }

        // 通常はJob自体がblockedの場合のみ再開対象（guard違反等）。
        // それに加え、Design Review CONFLICT/NOT_ALIGNED等でrepair flowが
        // Taskをblockedへescalateしたケース（`escalateTaskToHuman`）も受理する。
        // このescalationはJobを更新せずTask.statusだけをblockedにするため、
        // 最新Jobはfailedのまま残る。これを「blockedでない」として拒否すると、
        // 正式にescalateされたTaskが既存のresume経路から一切復旧できなくなる。
        const isJobDirectlyBlocked = latestJob.status === 'blocked'
        const isEscalatedFailure = taskRow.status === 'blocked' && latestJob.status === 'failed'
        if (!isJobDirectlyBlocked && !isEscalatedFailure) {
          return { ok: false, reason: `Latest job status is ${latestJob.status}, not blocked` }
        }

        // PR-C Tranche 3: workspace quarantine は fail-closed に resume を拒否する。
        // 最新Jobだけを見ず、このTaskの**任意の**未解除quarantine Jobから判定する
        // （quarantine は `running -> blocked` と同一transactionで一度だけ設定され、解除機構はない）。
        // 未検証 workspace を持つ Task へ新しい Job を生成してはならない。
        if (taskJobs.some((job) => job.failureMetadata?.quarantined === true)) {
          const reason = taskJobs.find((job) => job.failureMetadata?.quarantined === true)
            ?.failureMetadata?.quarantineReason ?? 'workspace is quarantined'
          return { ok: false, code: 'WORKSPACE_QUARANTINED', reason: `Cannot resume: ${reason}` }
        }

        if (taskJobs.some((job) => job.status === 'queued' || job.status === 'running')) {
          return { ok: false, reason: 'A queued or running job already exists for this task' }
        }

        const latestApprovalRow = db.prepare(
          'SELECT * FROM approval_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(taskId) as any
        const latestApproval = latestApprovalRow ? deserializeApprovalRequest(latestApprovalRow) : undefined

        // 有効な承認待ちがあるうちは resume しない（承認と resume の二重駆動を避ける）。
        //
        // ただし `WAITING_FOR_USER` は**期限切れでも行として残る**（expiry は参照時の遅延判定で、
        // 定期的に掃除する actor はいない）。期限切れまで「承認待ち」として扱うと、Task は
        // どこからも復旧できなくなる:
        //   - `GET /api/approval-requests/waiting` は `findWaiting()` が `expires_at > now` で
        //     除外するため、Mobile の承認画面に出ない = CEO は承認ボタンに到達できない
        //   - `approveAndResumeJob()` は期限切れを `EXPIRED` として拒否する（正しい fail-closed）
        //   - つまり行を `EXPIRED` へ進める actor が居らず、resume も永久に拒否され続ける
        // 2026-09-12 に Production で実際にこの状態に入った（Job は blocked、承認一覧は 0 件）。
        //
        // したがって「有効な承認待ち」は **未期限の `WAITING_FOR_USER` だけ**とする。
        //
        // この判定は git_commit 分岐より手前にあるため、**非 git_commit（AI CLI）の resume にも
        // 等しく効く。これは意図した適用範囲である** —— 罠は `requestedAction` ではなく
        // 「期限切れ行を `EXPIRED` へ進める actor が居ない」ことに由来しており、非 git_commit の
        // 承認待ち（`POST /api/approval-requests` 由来）でも同じく復旧不能になるため。
        // 迂回にはならない: 下流の Design Review evidence 判定も、再実行される Gate も
        // そのまま効き続ける（`resumeExpiredApproval.test.ts` の 9〜11 で固定）。
        // 期限切れの承認は resume を妨げない。resume は Approval Gate を迂回せず、
        // 古い行を承認・削除もしない: 新 Job が `/gate/check` で**新しい**Approval Request を
        // 発行し、CEO が Mobile からそれを承認する、という正規経路へ戻すだけである。
        if (latestApproval?.status === 'WAITING_FOR_USER' && new Date(latestApproval.expiresAt) > new Date(now())) {
          return { ok: false, reason: 'The latest approval request is waiting for user review' }
        }

        // git_commit SafeCommand Job（AI CLIを介さない）の resume。
        // STALE化した古いapprovalは再利用・再承認しない: 新Jobはworkflow_step_keyを
        // 変えて作成するため approvalId を引き継がず、/gate/check が現在のdiffに対して
        // 新しいapprovalを発行する（既存の git_commit Job生成と同じ形、既存のGate/Queueのまま）。
        if (latestJob.safeCommand.kind === 'git_commit') {
          const job = jobs.create({
            taskId,
            projectId: latestJob.projectId,
            agentRole: latestJob.agentRole,
            status: 'queued',
            workflowStepKey: `resume:${latestJob.id}:1`,
            safeCommand: { ...latestJob.safeCommand, workingDir: TARGET_WORKING_DIR },
            dryRun: latestJob.dryRun,
          })
          return { ok: true, job }
        }

        if (!latestJob.aiCliProvider || !latestJob.aiCliMode) {
          return { ok: false, reason: 'Latest blocked job is missing AI CLI provider or mode' }
        }

        const designReviewCheck = checkImplementJobDesignReviewEvidence({
          taskId,
          aiCliMode: latestJob.aiCliMode,
          aiCliPrompt: instructionPrompt,
        }, designReviewEvidence)
        if (!designReviewCheck.ok) {
          return {
            ok: false,
            code: 'DESIGN_REVIEW_PRECONDITION_FAILED',
            reason: designReviewCheck.reason,
          }
        }

        const job = jobs.create({
          taskId,
          projectId: latestJob.projectId,
          agentRole: latestJob.agentRole,
          status: 'queued',
          // workingDir は元Jobの値をそのまま引き継がず、常に正規workingDirへ上書きする
          // （MVP-Aは単一Repository固定。POST /api/jobsでのJob作成と同じ定義を再利用する）
          safeCommand: { ...latestJob.safeCommand, workingDir: TARGET_WORKING_DIR },
          dryRun: latestJob.dryRun,
          aiCliProvider: latestJob.aiCliProvider,
          aiCliPrompt: instructionPrompt,
          aiCliMode: latestJob.aiCliMode,
          // 上のgit_commit分岐と同じ `resume:<元Job>:1` 規約（既存のretry:/repair:と同じ
          // 「anchorはsourceJobId、末尾は常に:1」パターン）。これが無いとupdateAndCreateNextWorkflowJob
          // が「手動Jobなのでworkflowを進められない」としてreview自動生成を拒否し、成功しても
          // review→git_commit→Task done→continuationへ自動的に戻れない
          // （routes/jobs.ts の isResumeImplementJob がこの文字列を判定に使う。変更時は両方直すこと）。
          workflowStepKey: `resume:${latestJob.id}:1`,
        })

        return { ok: true, job }
      })

      return resumeTransaction(input.taskId, input.instructionPrompt)
    },
    clearWorkspaceQuarantine(input) {
      const clearTransaction = db.transaction((
        jobId: string,
        observation: JobWorkspaceBaseline,
        knownGood: { gitOperationMarkers: string[]; worktreeClean: boolean; indexClean: boolean; headValid: boolean; blindSpotsAbsent: boolean },
        reason: string | undefined,
      ): ClearWorkspaceQuarantineResult => {
        const target = jobs.findById(jobId)
        if (!target) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }

        // この Task の**任意の**未解除 quarantine Job を解除するのは対象 Job と
        // **同一 workingDir** のものだけに限定する（無関係な兄弟を一律解除しない）。
        // resumeBlockedTask / isWorkspaceQuarantined が「いずれかの quarantine Job」で
        // 判定するため、同一 workspace（同一 workingDir）の quarantine をまとめて解除する。
        const workingDir = target.safeCommand?.workingDir
        const taskJobs = jobs.findByTaskId(target.taskId)
        const quarantinedJobs = taskJobs.filter(
          (job) =>
            job.failureMetadata?.quarantined === true &&
            job.safeCommand?.workingDir === workingDir,
        )
        if (quarantinedJobs.length === 0) {
          if (target.failureMetadata?.quarantined === true) {
            // 対象 Job 自体が quarantine だが、同一 workingDir 判定で外れた／他に無い —
            // ここへ来るのは target が quarantine で、workingDir 不一致の兄弟だけしか
            // 無い場合。これは検証対象と workspace が異なる可能性があるため fail-closed。
            return {
              ok: false,
              code: 'VERIFICATION_FAILED',
              reason: 'the quarantined target does not match the verified workspace (workingDir)',
            }
          }
          // 既に解除済み（冪等）。
          return {
            ok: true,
            job: target,
            clearedJobCount: 0,
            alreadyCleared: true,
          }
        }

        // ── 再検証（サーバーが observation を自ら検査する。assert しない）──
        //
        // この clearance は「workspace を以前の状態へ戻した」ではなく、
        // **「安全な新しい参照点へ reconcile した」** ことを意味する。
        const baseline = target.workspaceBaseline
        let verified: boolean
        if (baseline) {
          // has-baseline: observation が baseline と完全一致（検証と同じ比較 semantics）。
          verified = baselineEqualsObservation(baseline, observation)
        } else {
          // 無 baseline（baseline 計算失敗で quarantine された場合）:
          // 過去との一致は証明できないため、known-good 状態を要求し、observation を
          // 新しい durable baseline として永続化する。
          verified =
            knownGood.gitOperationMarkers.length === 0 &&
            knownGood.worktreeClean &&
            knownGood.indexClean &&
            knownGood.headValid &&
            knownGood.blindSpotsAbsent &&
            observation.mode === 'clean'
        }

        if (!verified) {
          // 検証に失敗したら quarantine を**維持**し、解除しない。fail-closed。
          return {
            ok: false,
            code: 'VERIFICATION_FAILED',
            reason: baseline
              ? 'submitted observation does not exactly match the persisted workspace baseline'
              : 'no persisted baseline and observation/knownGood do not prove a known-good clean workspace',
          }
        }

        // 検証成功。同一 workingDir の quarantine を解除し、解除を「記録」する
        // （quarantineClearedAt / quarantineClearedReason。削除ではなく履歴として残す）。
        const clearedAt = now()
        for (const quarantined of quarantinedJobs) {
          const metadata = quarantined.failureMetadata ?? {}
          jobs.update(quarantined.id, {
            failureMetadata: {
              ...metadata,
              quarantined: false,
              quarantineClearedAt: clearedAt,
              ...(reason !== undefined ? { quarantineClearedReason: reason } : {}),
            },
            // 無 baseline の場合は observation を新しい durable な参照点として永続化する。
            ...(baseline ? {} : { workspaceBaseline: observation }),
          })
        }

        const final = jobs.findById(jobId)!
        return {
          ok: true,
          job: final,
          clearedJobCount: quarantinedJobs.length,
          alreadyCleared: false,
        }
      })

      try {
        return clearTransaction(input.jobId, input.observation, input.knownGood, input.reason)
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'STORAGE_ERROR',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }

  const approvals: IApprovalStorage = {
    findAllPending() {
      const rows = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all() as any[]
      return rows.map(deserializeApprovalWithProjectId)
    },
    findPendingByProjectId(projectId) {
      const rows = db.prepare("SELECT * FROM approvals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC").all(projectId) as any[]
      return rows.map(deserializeApproval)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any
      return row ? deserializeApproval(row) : undefined
    },
    create(data) {
      const approval: Approval = { ...data, id: randomUUID(), createdAt: now() }
      db.prepare(`
        INSERT INTO approvals (id, project_id, title, reason, type, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        approval.id,
        (approval as any).projectId,
        approval.title,
        approval.reason,
        approval.type,
        approval.status,
        approval.createdAt,
      )
      return approval
    },
    update(id, data) {
      const updateTransaction = db.transaction((): Approval | undefined => {
        const existing = approvals.findById(id)
        if (!existing) return undefined
        const updated = { ...existing, ...data }
        db.prepare(`
          UPDATE approvals SET status=?, reviewed_at=?, review_note=? WHERE id=?
        `).run(updated.status, updated.reviewedAt ?? null, updated.reviewNote ?? null, id)
        if (data.status && data.status !== existing.status) {
          auditLog.record({
            actor: 'api',
            operation: data.status === 'approved' ? 'approve' : data.status === 'rejected' ? 'reject' : 'expire',
            entityType: 'approval',
            entityId: id,
            result: 'success',
          })
        }
        return updated
      })
      return updateTransaction()
    },
  }

  const reviewResults: IReviewResultStorage = {
    findByTaskId(taskId) {
      const rows = db.prepare('SELECT * FROM review_results WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as any[]
      return rows.map(deserializeReviewResult)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM review_results WHERE id = ?').get(id) as any
      return row ? deserializeReviewResult(row) : undefined
    },
    create(data) {
      const result: ReviewResult = { ...data, id: randomUUID(), createdAt: now() }
      db.prepare(`
        INSERT INTO review_results (id, task_id, job_id, reviewer, status, summary, findings, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id,
        result.taskId,
        result.jobId,
        result.reviewer,
        result.status,
        result.summary,
        JSON.stringify(result.findings),
        result.createdAt,
      )
      return result
    },
  }

  const qaResults: IQAResultStorage = {
    findByTaskId(taskId) {
      const rows = db.prepare('SELECT * FROM qa_results WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as any[]
      return rows.map(deserializeQAResult)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM qa_results WHERE id = ?').get(id) as any
      return row ? deserializeQAResult(row) : undefined
    },
    create(data) {
      const result: QAResult = { ...data, id: randomUUID(), createdAt: now() }
      db.prepare(`
        INSERT INTO qa_results (id, task_id, job_id, type, status, summary, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id,
        result.taskId,
        result.jobId,
        result.type,
        result.status,
        result.summary,
        result.details ?? null,
        result.createdAt,
      )
      return result
    },
  }

  const permissionGrants: IPermissionGrantStorage = {
    findActiveByTaskId(taskId) {
      const nowIso = new Date().toISOString()
      const rows = db.prepare(`
        SELECT * FROM permission_grants
        WHERE task_id = ? AND scope = 'task' AND used = 0
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
      `).all(taskId, nowIso) as any[]
      return rows.map(deserializePermissionGrant)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM permission_grants WHERE id = ?').get(id) as any
      return row ? deserializePermissionGrant(row) : undefined
    },
    create(data) {
      const grant: PermissionGrant = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO permission_grants
          (id, task_id, job_id, allowed_command_kinds, agent_role, scope, expires_at, reason, used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        grant.id,
        grant.taskId ?? null,
        grant.jobId ?? null,
        JSON.stringify(grant.allowedCommandKinds ?? []),
        grant.agentRole,
        grant.scope,
        grant.expiresAt ?? null,
        grant.reason ?? null,
        grant.used ? 1 : 0,
        grant.createdAt,
      )
      return grant
    },
    markUsed(id) {
      const existing = permissionGrants.findById(id)
      if (!existing) return undefined
      db.prepare('UPDATE permission_grants SET used = 1 WHERE id = ?').run(id)
      return { ...existing, used: true }
    },
    delete(id) {
      const deleteTransaction = db.transaction((): boolean => {
        const result = db.prepare('DELETE FROM permission_grants WHERE id = ?').run(id)
        const deleted = result.changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'permission_grant', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  function insertWatchdogEventRow(event: WatchdogEvent): void {
      db.prepare(`
        INSERT INTO watchdog_events
          (id, job_id, task_id, command_kind, working_dir, started_at, detected_at,
           stall_duration_ms, status, ai_analysis, is_stuck, resolved_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.jobId,
        event.taskId,
        event.commandKind,
        event.workingDir,
        event.startedAt,
        event.detectedAt,
        event.stallDurationMs,
        event.status,
        event.aiAnalysis ?? null,
        event.isStuck === undefined ? null : (event.isStuck ? 1 : 0),
        event.resolvedAt ?? null,
        event.createdAt,
      )
  }

  const watchdogEvents: IWatchdogEventStorage = {
    findAll() {
      const rows = db.prepare('SELECT * FROM watchdog_events ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeWatchdogEvent)
    },
    findByJobId(jobId) {
      const rows = db.prepare('SELECT * FROM watchdog_events WHERE job_id = ? ORDER BY created_at DESC').all(jobId) as any[]
      return rows.map(deserializeWatchdogEvent)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM watchdog_events WHERE id = ?').get(id) as any
      return row ? deserializeWatchdogEvent(row) : undefined
    },
    /**
     * DB-007: stall episode 単位で冪等に作成する。
     *
     * dedup key は `(job_id, started_at)`。Job は `failed -> queued` /
     * `blocked -> queued` を経て再び `running` になり得る（jobStateManager の
     * ALLOWED_TRANSITIONS）。そのたびに `startedAt` は付け直されるので、
     * これは「この実行の、この stall」を一意に指す。
     *
     * `(job_id)` や `(job_id, event_type)` を key にすると、復旧後に**正当に再発した**
     * stall まで潰してしまう。将来の再 stall は記録されなければならない。
     *
     * 既存 event があればそれを返す。Worker が restart して同じ stall を再検出しても、
     * また event 作成の retry が起きても、行が増えないのはここで保証する
     * （in-memory の alertedJobs は速度のための最適化であって、正しさの根拠ではない）。
     */
    findByEpisode(jobId, startedAt) {
      const row = db.prepare(
        'SELECT * FROM watchdog_events WHERE job_id = ? AND started_at = ? LIMIT 1',
      ).get(jobId, startedAt) as any
      return row ? deserializeWatchdogEvent(row) : undefined
    },
    create(data) {
      const existing = watchdogEvents.findByEpisode(data.jobId, data.startedAt)
      if (existing) return existing

      const event: WatchdogEvent = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
      }
      try {
        insertWatchdogEventRow(event)
      } catch (err) {
        // UNIQUE 制約違反 = 同じ episode を別経路が先に作った（並行 POST / retry）。
        // competing writer の行を返す。ここが CAS の役割を果たすので、
        // 汎用 CAS framework は要らない。
        const raced = watchdogEvents.findByEpisode(data.jobId, data.startedAt)
        if (raced) return raced
        throw err
      }
      return event
    },
    update(id, data) {
      const existing = watchdogEvents.findById(id)
      if (!existing) return undefined
      const updated: WatchdogEvent = {
        ...existing,
        ...data,
      }
      db.prepare(`
        UPDATE watchdog_events
        SET status=?, ai_analysis=?, is_stuck=?, resolved_at=?
        WHERE id=?
      `).run(
        updated.status,
        updated.aiAnalysis ?? null,
        updated.isStuck === undefined ? null : (updated.isStuck ? 1 : 0),
        updated.resolvedAt ?? null,
        id,
      )
      return updated
    },
  }

  const approvalRequests: IApprovalRequestStorage = {
    findByTaskId(taskId) {
      const rows = db.prepare(
        'SELECT * FROM approval_requests WHERE task_id = ? ORDER BY created_at DESC'
      ).all(taskId) as any[]
      return rows.map(deserializeApprovalRequest)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as any
      return row ? deserializeApprovalRequest(row) : undefined
    },
    findActiveByTaskId(taskId) {
      // CONSUMED は除外: 消費済み承認を再利用しないよう IN ('WAITING_FOR_USER', 'APPROVED') のみ対象
      const row = db.prepare(`
        SELECT * FROM approval_requests
        WHERE task_id = ? AND status IN ('WAITING_FOR_USER', 'APPROVED')
        ORDER BY created_at DESC LIMIT 1
      `).get(taskId) as any
      return row ? deserializeApprovalRequest(row) : undefined
    },
    findWaiting() {
      const rows = db.prepare(`
        SELECT * FROM approval_requests
        WHERE status = 'WAITING_FOR_USER' AND expires_at > ?
        ORDER BY created_at DESC
      `).all(now()) as any[]
      return rows.map(deserializeApprovalRequest)
    },
    create(data) {
      const req: ApprovalRequest = {
        ...data,
        changedFiles: data.changedFiles ?? [],
        triggeredRules: data.triggeredRules ?? [],
        id: `approval-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`,
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO approval_requests
          (id, task_id, target_branch, target_commit, target_diff_hash, risk_level,
           requested_action, status, expires_at, invalid_if, changed_files, triggered_rules,
           reason, created_at, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.id,
        req.taskId,
        req.targetBranch,
        req.targetCommit,
        req.targetDiffHash,
        req.riskLevel,
        req.requestedAction,
        req.status,
        req.expiresAt,
        JSON.stringify(req.invalidIf),
        JSON.stringify(req.changedFiles ?? []),
        JSON.stringify(req.triggeredRules ?? []),
        req.reason ?? null,
        req.createdAt,
        req.reviewedAt ?? null,
      )
      return req
    },
    createForJob(data, jobId): CreateApprovalForJobResult {
      const createTransaction = db.transaction((): CreateApprovalForJobResult => {
        const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
        if (!jobRow) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }

        const job = deserializeJob(jobRow)
        if (
          job.taskId !== data.taskId ||
          job.safeCommand.kind !== 'git_commit' ||
          data.requestedAction !== job.safeCommand.kind
        ) {
          return {
            ok: false,
            code: 'JOB_MISMATCH',
            reason: 'Job task or requested action does not match the approval request',
          }
        }
        if (job.approvalId !== undefined) {
          return {
            ok: false,
            code: 'JOB_ALREADY_LINKED',
            reason: 'Job is already linked to an approval request',
          }
        }

        const approvalRequest = approvalRequests.create(data)
        const linked = db.prepare(
          'UPDATE jobs SET approval_id = ? WHERE id = ? AND approval_id IS NULL'
        ).run(approvalRequest.id, jobId)
        if (linked.changes !== 1) {
          throw new Error('Failed to atomically link approval request to job')
        }

        return { ok: true, approvalRequest }
      })

      return createTransaction()
    },
    approveAndResumeJob(id, reason): ReviewApprovalAndResumeJobResult {
      const approveTransaction = db.transaction((): ReviewApprovalAndResumeJobResult => {
        const record = (result: ReviewApprovalAndResumeJobResult): ReviewApprovalAndResumeJobResult => {
          auditLog.record({
            actor: 'api', operation: 'approve', entityType: 'approval_request', entityId: id,
            result: result.ok ? 'success' : 'failure',
          })
          return result
        }

        const existing = approvalRequests.findById(id)
        if (!existing) {
          return record({ ok: false, code: 'NOT_FOUND', reason: 'Approval request not found' })
        }
        if (existing.status !== 'WAITING_FOR_USER') {
          return record({
            ok: false,
            code: 'STATUS_CONFLICT',
            reason: `Cannot approve: current status is '${existing.status}'`,
            approvalRequest: existing,
          })
        }

        const reviewedAt = now()
        if (new Date(existing.expiresAt) <= new Date(reviewedAt)) {
          const expired = db.prepare(`
            UPDATE approval_requests
            SET status = 'EXPIRED'
            WHERE id = ? AND status = 'WAITING_FOR_USER'
          `).run(id)
          if (expired.changes !== 1) {
            return record({
              ok: false,
              code: 'STATUS_CONFLICT',
              reason: 'Approval request status changed concurrently',
            })
          }
          return record({
            ok: false,
            code: 'EXPIRED',
            reason: 'Approval request has expired',
            approvalRequest: { ...existing, status: 'EXPIRED' },
          })
        }

        const jobRows = db.prepare('SELECT * FROM jobs WHERE approval_id = ?').all(id) as Array<Record<string, unknown>>
        if (jobRows.length === 0) {
          return record({
            ok: false,
            code: 'JOB_NOT_FOUND',
            reason: 'No Job is linked to this approval request',
          })
        }
        if (jobRows.length !== 1) {
          return record({
            ok: false,
            code: 'JOB_NOT_UNIQUE',
            reason: 'Approval request is linked to multiple Jobs',
          })
        }

        const job = deserializeJob(jobRows[0])
        if (
          job.taskId !== existing.taskId ||
          job.safeCommand.kind !== 'git_commit' ||
          existing.requestedAction !== job.safeCommand.kind ||
          (job.status !== 'running' && job.status !== 'blocked')
        ) {
          return record({
            ok: false,
            code: 'JOB_MISMATCH',
            reason: 'Linked Job does not match the approval request or cannot be resumed',
          })
        }

        if (job.aiCliMode === 'implement') {
          const designReviewCheck = checkImplementJobDesignReviewEvidence(job, designReviewEvidence)
          if (!designReviewCheck.ok) {
            return record({
              ok: false,
              code: 'DESIGN_REVIEW_PRECONDITION_FAILED',
              reason: designReviewCheck.reason,
            })
          }
        }

        const approvalUpdated = db.prepare(`
          UPDATE approval_requests
          SET status = 'APPROVED', reason = ?, reviewed_at = ?
          WHERE id = ? AND status = 'WAITING_FOR_USER' AND expires_at > ?
        `).run(reason ?? existing.reason ?? null, reviewedAt, id, reviewedAt)
        if (approvalUpdated.changes !== 1) {
          return record({
            ok: false,
            code: 'STATUS_CONFLICT',
            reason: 'Approval request status changed concurrently',
          })
        }

        const jobUpdated = db.prepare(`
          UPDATE jobs SET
            status = 'queued', started_at = NULL, completed_at = NULL, exit_code = NULL,
            stdout = NULL, stderr = NULL, stdout_path = NULL, stderr_path = NULL,
            changed_files = '[]', commit_hash = NULL, rollback_info = NULL, guard_result = NULL
          WHERE id = ? AND approval_id = ? AND status IN ('running', 'blocked')
        `).run(job.id, id)
        if (jobUpdated.changes !== 1) {
          throw new Error('Failed to atomically resume the linked Job')
        }

        const approvalRequest = approvalRequests.findById(id)
        const resumedJob = jobs.findById(job.id)
        if (!approvalRequest || !resumedJob) {
          throw new Error('Failed to read atomically resumed approval and Job')
        }
        return record({ ok: true, approvalRequest, job: resumedJob })
      })

      return approveTransaction()
    },
    consumeForJob(input): ConsumeApprovalForJobResult {
      const consumeTransaction = db.transaction((): ConsumeApprovalForJobResult => {
        const existing = approvalRequests.findById(input.id)
        if (!existing) {
          return { ok: false, code: 'NOT_FOUND', reason: 'Approval request not found' }
        }

        const requestedJob = jobs.findById(input.jobId)
        if (!requestedJob) {
          return { ok: false, code: 'JOB_NOT_FOUND', reason: 'Job not found' }
        }

        const linkedJobRows = db.prepare('SELECT * FROM jobs WHERE approval_id = ?').all(input.id) as Array<Record<string, unknown>>
        if (linkedJobRows.length !== 1) {
          return {
            ok: false,
            code: 'JOB_NOT_UNIQUE',
            reason: linkedJobRows.length === 0
              ? 'No Job is linked to this approval request'
              : 'Approval request is linked to multiple Jobs',
          }
        }

        const linkedJob = deserializeJob(linkedJobRows[0])
        if (linkedJob.id !== input.jobId) {
          return {
            ok: false,
            code: 'JOB_MISMATCH',
            reason: 'Approval request is linked to a different Job',
            approvalRequest: existing,
            linkedJobId: linkedJob.id,
          }
        }
        if (
          requestedJob.approvalId !== existing.id ||
          requestedJob.taskId !== existing.taskId ||
          requestedJob.safeCommand.kind !== 'git_commit' ||
          existing.requestedAction !== requestedJob.safeCommand.kind
        ) {
          return {
            ok: false,
            code: 'JOB_MISMATCH',
            reason: 'Job task or requested action does not match the approval request',
            approvalRequest: existing,
            linkedJobId: linkedJob.id,
          }
        }

        if (existing.targetCommit !== input.currentCommit || existing.targetDiffHash !== input.currentDiffHash) {
          if (existing.status === 'APPROVED') {
            db.prepare(`
              UPDATE approval_requests SET status = 'STALE'
              WHERE id = ? AND status = 'APPROVED'
            `).run(input.id)
          }
          return {
            ok: false,
            code: 'STALE',
            reason: 'Approval request is stale: commit or diff has changed',
            approvalRequest: existing.status === 'APPROVED'
              ? { ...existing, status: 'STALE' }
              : existing,
            linkedJobId: linkedJob.id,
          }
        }

        if (existing.status === 'CONSUMED') {
          return {
            ok: true,
            approvalRequest: existing,
            jobId: linkedJob.id,
            alreadyConsumed: true,
          }
        }
        if (existing.status !== 'APPROVED') {
          return {
            ok: false,
            code: 'STATUS_CONFLICT',
            reason: `Cannot consume: current status is '${existing.status}' (must be APPROVED)`,
            approvalRequest: existing,
            linkedJobId: linkedJob.id,
          }
        }

        if (new Date(existing.expiresAt) <= new Date()) {
          db.prepare(`
            UPDATE approval_requests SET status = 'EXPIRED'
            WHERE id = ? AND status = 'APPROVED'
          `).run(input.id)
          return {
            ok: false,
            code: 'EXPIRED',
            reason: 'Approval request has expired',
            approvalRequest: { ...existing, status: 'EXPIRED' },
            linkedJobId: linkedJob.id,
          }
        }

        const consumed = db.prepare(`
          UPDATE approval_requests SET status = 'CONSUMED'
          WHERE id = ? AND status = 'APPROVED'
        `).run(input.id)
        if (consumed.changes !== 1) {
          return {
            ok: false,
            code: 'STATUS_CONFLICT',
            reason: 'Approval request status changed concurrently',
            linkedJobId: linkedJob.id,
          }
        }

        const approvalRequest = approvalRequests.findById(input.id)
        if (!approvalRequest) {
          throw new Error('Failed to read consumed approval request')
        }
        return {
          ok: true,
          approvalRequest,
          jobId: linkedJob.id,
          alreadyConsumed: false,
        }
      })

      return consumeTransaction()
    },
    updateStatus(id, status, reason, preserveReviewMeta = false) {
      const existing = approvalRequests.findById(id)
      if (!existing) return undefined
      // preserveReviewMeta=true（consume 時）: CEO が記録した reason/reviewedAt を上書きしない
      // Codex: reviewedAt が NULL の行に consume 時刻を書かないよう undefined のまま保持
      const newReason = preserveReviewMeta ? (existing.reason ?? null) : (reason ?? existing.reason ?? null)
      const newReviewedAt = preserveReviewMeta ? (existing.reviewedAt ?? null) : now()
      db.prepare(`
        UPDATE approval_requests
        SET status = ?, reason = ?, reviewed_at = ?
        WHERE id = ?
      `).run(status, newReason, newReviewedAt, id)
      return { ...existing, status, reason: newReason ?? undefined, reviewedAt: newReviewedAt ?? undefined }
    },
    recordDecision(id, status, reason) {
      const decisionTransaction = db.transaction((): ApprovalRequest | undefined => {
        const updated = approvalRequests.updateStatus(id, status, reason)
        if (updated) {
          auditLog.record({
            actor: 'api',
            operation: status === 'APPROVED' ? 'approve' : 'reject',
            entityType: 'approval_request',
            entityId: id,
            result: 'success',
          })
        }
        return updated
      })
      return decisionTransaction()
    },
  }

  // ────────────────────────────────────────────────────────────
  // KnowledgeGraph Storage
  // ────────────────────────────────────────────────────────────

  const designReviewEvidence: IDesignReviewEvidenceStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM design_review_evidence WHERE id = ?').get(id) as any
      return row ? deserializeDesignReviewEvidence(row) : undefined
    },
    findByTaskId(taskId) {
      const rows = db.prepare(
        'SELECT * FROM design_review_evidence WHERE task_id = ? ORDER BY created_at DESC, rowid DESC'
      ).all(taskId) as any[]
      return rows.map(deserializeDesignReviewEvidence)
    },
    findLatestByTaskId(taskId) {
      const row = db.prepare(
        'SELECT * FROM design_review_evidence WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(taskId) as any
      return row ? deserializeDesignReviewEvidence(row) : undefined
    },
    findLatestBySubjectId(reviewKind, subjectId) {
      const row = db.prepare(
        'SELECT * FROM design_review_evidence WHERE review_kind = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(reviewKind, subjectId) as any
      return row ? deserializeDesignReviewEvidence(row) : undefined
    },
    create(data) {
      const subject = resolveDesignReviewSubject(data)
      const evidence: DesignReviewEvidence = {
        ...data,
        reviewKind: subject.reviewKind,
        subjectId: subject.subjectId,
        taskId: subject.taskId,
        id: randomUUID(),
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO design_review_evidence
          (id, review_kind, subject_id, task_id, design_text_hash, review_load, decision,
           independent_review_required, independent_review_verdict, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.id,
        evidence.reviewKind,
        evidence.subjectId,
        evidence.taskId ?? null,
        evidence.designTextHash,
        evidence.reviewLoad,
        evidence.decision,
        evidence.independentReviewRequired ? 1 : 0,
        evidence.independentReviewVerdict ?? null,
        evidence.createdAt,
      )
      return evidence
    },
  }

  const gateEvaluations: IGateEvaluationStorage = {
    create(data) {
      const evidence: GateEvaluationEvidence = { ...data, id: randomUUID(), createdAt: now() }
      db.prepare(`
        INSERT INTO gate_evaluations
          (id, task_id, job_id, target_branch, target_commit, target_diff_hash,
           decision, risk_level, triggered_rules, policy_version, binding_verification,
           approved_content_hash, resulting_commit, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.id, evidence.taskId, evidence.jobId ?? null, evidence.targetBranch,
        evidence.targetCommit, evidence.targetDiffHash, evidence.decision, evidence.riskLevel,
        JSON.stringify(evidence.triggeredRules), evidence.policyVersion,
        evidence.bindingVerification, evidence.approvedContentHash ?? null,
        evidence.resultingCommit ?? null, evidence.createdAt,
      )
      return evidence
    },
    findByTaskId(taskId) {
      const rows = db.prepare(
        'SELECT * FROM gate_evaluations WHERE task_id = ? ORDER BY created_at DESC, rowid DESC'
      ).all(taskId) as any[]
      return rows.map(deserializeGateEvaluation)
    },
    findByJobId(jobId) {
      const rows = db.prepare(
        'SELECT * FROM gate_evaluations WHERE job_id = ? ORDER BY created_at DESC, rowid DESC'
      ).all(jobId) as any[]
      return rows.map(deserializeGateEvaluation)
    },
    findByResultingCommit(resultingCommit) {
      const rows = db.prepare(
        'SELECT * FROM gate_evaluations WHERE resulting_commit = ? ORDER BY created_at DESC, rowid DESC'
      ).all(resultingCommit) as any[]
      return rows.map(deserializeGateEvaluation)
    },
    bindResultingCommit({ evidenceId, jobId, resultingCommit }) {
      // CAS: resulting_commit IS NULL のときだけ書く。
      // at-least-once PATCHで何度呼ばれてもbindingは1回だけ成立し、
      // 既にbind済みのevidenceを別commitへ付け替えない。
      // 併せてbind可能な条件（ALLOW / authoritative / hash有り / jobId一致）もSQLで強制する。
      // 一意制約違反（同一commitへ別evidenceが既にbind済み）は例外になるため、
      // bind失敗として扱う。曖昧なbindを黙って成立させない。
      try {
      const result = db.prepare(`
        UPDATE gate_evaluations
        SET resulting_commit = ?
        WHERE id = ?
          AND job_id = ?
          AND resulting_commit IS NULL
          AND decision = 'ALLOW'
          AND binding_verification = 'authoritative'
          AND approved_content_hash IS NOT NULL
      `).run(resultingCommit, evidenceId, jobId)
      return result.changes === 1
      } catch {
        return false
      }
    },
    findByTarget(targetCommit, targetDiffHash) {
      const rows = db.prepare(
        'SELECT * FROM gate_evaluations WHERE target_commit = ? AND target_diff_hash = ? ORDER BY created_at DESC, rowid DESC'
      ).all(targetCommit, targetDiffHash) as any[]
      return rows.map(deserializeGateEvaluation)
    },
  }

  /**
   * Supervised Run storage — Background Task Supervision Contract の共通run state（C-10）。
   *
   * 所有権は claim_token で表す。create が最初のtokenを発行し（launchとsupervision登録が不可分）、
   * recovery で所有権が移ると新しいtokenが発行されて旧所有者の書き込みは恒久的に無効になる。
   * これにより「死んだwrapperが後から成功を書く」経路が塞がれる。
   */
  const supervisedRuns: ISupervisedRunStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM supervised_runs WHERE id = ?').get(id) as any
      return row ? deserializeSupervisedRun(row) : undefined
    },
    findActive(kind, subjectId) {
      const row = db.prepare(
        "SELECT * FROM supervised_runs WHERE kind = ? AND subject_id = ? AND status IN ('running','stalled') LIMIT 1"
      ).get(kind, subjectId) as any
      return row ? deserializeSupervisedRun(row) : undefined
    },
    findActiveRuns() {
      const rows = db.prepare(
        "SELECT * FROM supervised_runs WHERE status IN ('running','stalled') ORDER BY last_progress_at ASC, rowid ASC"
      ).all() as any[]
      return rows.map(deserializeSupervisedRun)
    },
    create(input) {
      const createTransaction = db.transaction((): CreateSupervisedRunResult => {
        const findActive = () => db.prepare(
          "SELECT * FROM supervised_runs WHERE kind = ? AND subject_id = ? AND status IN ('running','stalled') LIMIT 1"
        ).get(input.kind, input.subjectId) as any

        // 二重起票ではなく既存runを返す。**claimTokenは発行しない** —
        // 既にactiveな所有者がいるので、その所有権を奪ってはならない。
        const existing = findActive()
        if (existing) {
          return { run: deserializeSupervisedRun(existing), created: false }
        }

        const timestamp = now()
        const claimToken = randomUUID()
        const run: SupervisedRun = {
          id: randomUUID(),
          kind: input.kind,
          subjectId: input.subjectId,
          status: 'running',
          predicateKey: input.predicateKey,
          predicateVersion: input.predicateVersion,
          progressEvidence: input.progressEvidence,
          progressSource: input.progressSource,
          currentStage: input.currentStage,
          supervisor: input.supervisor,
          recoveryAttemptCount: 0,
          claimToken,
          createdAt: timestamp,
          startedAt: timestamp,
          lastProgressAt: timestamp,
        }

        try {
          db.prepare(`
            INSERT INTO supervised_runs
              (id, kind, subject_id, status, predicate_key, predicate_version, progress_evidence,
               completion_evidence, progress_source, current_stage, supervisor, recovery_attempt_count,
               claim_token, terminal_verdict, error, created_at, started_at, last_progress_at, completed_at)
            VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, NULL)
          `).run(
            run.id, run.kind, run.subjectId, run.predicateKey, run.predicateVersion,
            run.progressEvidence ? JSON.stringify(run.progressEvidence) : null,
            run.progressSource ?? null, run.currentStage ?? null, run.supervisor ?? null,
            claimToken, run.createdAt, run.startedAt, run.lastProgressAt,
          )
        } catch (err) {
          // partial unique index 違反 = 別経路が先にactive runを作った。例外にせず既存を返す。
          const existingAfterConflict = findActive()
          if (!existingAfterConflict) throw err
          return { run: deserializeSupervisedRun(existingAfterConflict), created: false }
        }

        return { run, created: true, claimToken }
      })
      return createTransaction()
    },
    recordProgress(id, claimToken, input) {
      // 進捗が観測できたということは stalled ではない。stalled から running へ戻す
      // （C-12: 生きているのに停止扱いのまま放置しない）。
      const result = db.prepare(`
        UPDATE supervised_runs
        SET last_progress_at = ?,
            status = 'running',
            current_stage = COALESCE(?, current_stage),
            progress_source = COALESCE(?, progress_source),
            progress_evidence = COALESCE(?, progress_evidence)
        WHERE id = ? AND claim_token = ? AND status IN ('running','stalled')
      `).run(
        now(),
        input.currentStage ?? null,
        input.progressSource ?? null,
        input.progressEvidence ? JSON.stringify(input.progressEvidence) : null,
        id, claimToken,
      )
      return result.changes === 1
    },
    markStalled(id, claimToken, reason) {
      const result = db.prepare(`
        UPDATE supervised_runs
        SET status = 'stalled', error = ?
        WHERE id = ? AND claim_token = ? AND status = 'running'
      `).run(reason, id, claimToken)
      return result.changes === 1
    },
    complete(id, claimToken, status, input) {
      // 独立レビュー指摘(2026-09-08 Step 3 #5): storage 境界でも terminal verdict を必須にする。
      // 以前は terminalVerdict 省略時に status 文字列で埋めていたため、
      // 「formal verdict も evidence も無い succeeded」を storage 層から作れてしまった。
      // completion の正しさを observeAndAdvance 側だけに依存させない。
      // status 文字列の verdict 代用は行わない（'succeeded' は verdict ではない）。
      if (status === 'succeeded') {
        const verdict = input?.terminalVerdict?.trim()
        if (!verdict || verdict === status) {
          throw new Error(
            `supervisedRuns.complete: 'succeeded' requires an explicit terminalVerdict ` +
            `(status strings are not verdicts); run=${id}`,
          )
        }
        if (!input?.completionEvidence || Object.keys(input.completionEvidence).length === 0) {
          throw new Error(
            `supervisedRuns.complete: 'succeeded' requires completionEvidence; run=${id}`,
          )
        }
      }

      const result = db.prepare(`
        UPDATE supervised_runs
        SET status = ?, terminal_verdict = ?, completion_evidence = ?, error = ?,
            completed_at = ?, claim_token = NULL
        WHERE id = ? AND claim_token = ? AND status IN ('running','stalled')
      `).run(
        status,
        input?.terminalVerdict ?? status,
        input?.completionEvidence ? JSON.stringify(input.completionEvidence) : null,
        input?.error ?? null,
        now(), id, claimToken,
      )
      return result.changes === 1
    },
    claimForRecovery(id, supervisor) {
      const maxRecoveryAttempts = MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS
      const claimTransaction = db.transaction((): ClaimSupervisedRunResult => {
        const current = db.prepare('SELECT * FROM supervised_runs WHERE id = ?').get(id) as any
        if (!current || current.status !== 'stalled') {
          return {}
        }

        // bounded recovery（C-6）: 超過分は引き取らず failed で終端させる。
        // 無期限RUNNINGにしないことがここでの load-bearing な性質である。
        if (current.recovery_attempt_count >= maxRecoveryAttempts) {
          db.prepare(`
            UPDATE supervised_runs
            SET status = 'failed', terminal_verdict = 'recovery_exhausted', error = ?,
                completed_at = ?, claim_token = NULL
            WHERE id = ? AND status = 'stalled'
          `).run(`recovery attempts exhausted (max ${maxRecoveryAttempts})`, now(), id)
          return { exhausted: true }
        }

        // 新しいtokenを発行して旧所有者を無効化する。
        const claimToken = randomUUID()
        const result = db.prepare(`
          UPDATE supervised_runs
          SET status = 'running', recovery_attempt_count = recovery_attempt_count + 1,
              claim_token = ?, supervisor = ?, last_progress_at = ?, error = NULL
          WHERE id = ? AND status = 'stalled'
        `).run(claimToken, supervisor, now(), id)

        if (result.changes !== 1) return {}

        const claimed = db.prepare('SELECT * FROM supervised_runs WHERE id = ?').get(id) as any
        return { run: deserializeSupervisedRun(claimed), claimToken }
      })
      return claimTransaction()
    },
    failClosed(id, claimToken, error) {
      // D-2: predicate を解決できない run を RUNNING のまま残さないための経路。
      //
      // 独立レビュー指摘(2026-09-08)で claim_token 要求を追加した。終端書き込みである以上、
      // fencing を免除してはならない。免除すると claimForRecovery で所有権を奪われた旧所有者が
      // この経路から終端を書けてしまい、「死んだwrapperが後から結果を書けない」という
      // 不変条件そのものが崩れる。
      //
      // 所有者が死んでtokenの持ち主がいない run は、markStalledBySupervisor() →
      // claimForRecovery() で正当に所有権を取得してから終端させる。
      const result = db.prepare(`
        UPDATE supervised_runs
        SET status = 'failed', terminal_verdict = 'fail_closed', error = ?,
            completed_at = ?, claim_token = NULL
        WHERE id = ? AND claim_token = ? AND status IN ('running','stalled')
      `).run(error, now(), id, claimToken)
      return result.changes === 1
    },
    markStalledBySupervisor(id, reason) {
      // 監視側が所有者に到達できない run へ旗を立てる。**終端書き込みではない**ので
      // claim_token を要求しない（fencing の対象は終端の確定であって、停止の疑いではない）。
      // これが無いと、所有者が死んだ run は stalled にできず recovery にも入れないまま
      // running で残り続ける（実障害ケース1と同じ結末）。
      //
      // ただし無条件の旗立ては許さない: **進捗が観測できている run は stalled にできない**。
      // 停止の主張は観測可能な事実に裏付けられていなければならず、これが無いと健全に
      // 進行中の run を誰でも stalled にして所有権を奪えてしまう。
      // C-2a（進捗を見ずに停止と判定しない）と C-5（診断してから動く）の実装である。
      //
      // **cutoff は呼び出し側から受け取らない**（独立レビュー指摘 2026-09-08 第3ラウンド）。
      // 引数にすると未来時刻を渡すだけで条件を素通りでき、ガードとして何も証明しない。
      // ここでは kind ごとの policy（SUPERVISED_RUN_STALE_THRESHOLD_MS）と現在時刻から
      // storage 内部で算出する。閾値を kind 別にするのは C-4（正常な無出力時間は task ごとに
      // 異なるので一律の短い timeout で判定しない）に従うためである。
      const sweepTransaction = db.transaction((): boolean => {
        const current = db.prepare('SELECT kind, status FROM supervised_runs WHERE id = ?').get(id) as any
        if (!current || current.status !== 'running') return false

        // kind は schema 上ただの TEXT なので、DB から来た値を素の object index で引かない
        // （独立レビュー指摘 2026-09-08 第4ラウンド: `toString` や `constructor` のような値は
        // prototype 由来のプロパティに解決されてしまい、undefined 判定を素通りして
        // `new Date(Date.now() - <function>)` が Invalid Date として throw する）。
        // 既知 kind の集合に対する明示的なメンバーシップ判定だけを信用する。
        const kind: string = String(current.kind)
        if (!isSupervisedRunKind(kind)) {
          // 未知の kind は閾値を決められない。勝手に stalled にはせず、判定を見送る
          // （fail-closed 側の判断は predicate 解決経路が担当する）。
          return false
        }
        const threshold = SUPERVISED_RUN_STALE_THRESHOLD_MS[kind]

        const staleCutoff = new Date(Date.now() - threshold).toISOString()
        const result = db.prepare(`
          UPDATE supervised_runs
          SET status = 'stalled', error = ?
          WHERE id = ? AND status = 'running' AND last_progress_at < ?
        `).run(reason, id, staleCutoff)
        return result.changes === 1
      })
      return sweepTransaction()
    },
    markOrphanedRunsStalledAtStartup(startedBefore) {
      const sweepTransaction = db.transaction((): SupervisedRun[] => {
        const orphans = db.prepare(
          "SELECT * FROM supervised_runs WHERE status = 'running' AND started_at < ?"
        ).all(startedBefore) as any[]

        for (const orphan of orphans) {
          // failed ではなく stalled にする（C-5: 診断を先に行う）。completion predicate を
          // 既に満たしている可能性があり（C-12 / Case C）、生死だけで失敗と決めつけない。
          // claim_token は**残す** — 前プロセスとは無関係に supervisor がまだ生きている場合、
          // その supervisor が recordProgress で running へ戻せるようにするため。
          db.prepare(`
            UPDATE supervised_runs SET status = 'stalled', error = ?
            WHERE id = ? AND status = 'running'
          `).run('orphaned by process restart; needs diagnosis before recovery', orphan.id)
        }

        return orphans.map((row) => deserializeSupervisedRun({ ...row, status: 'stalled' }))
      })
      return sweepTransaction()
    },
  }

  const designReviewRuns: IDesignReviewRunStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM design_review_runs WHERE id = ?').get(id) as any
      return row ? deserializeDesignReviewRun(row) : undefined
    },
    findActiveByTaskId(taskId) {
      const row = db.prepare(
        "SELECT * FROM design_review_runs WHERE task_id = ? AND status IN ('queued','running') LIMIT 1"
      ).get(taskId) as any
      return row ? deserializeDesignReviewRun(row) : undefined
    },
    findQueued() {
      const rows = db.prepare(
        "SELECT * FROM design_review_runs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC"
      ).all() as any[]
      return rows.map(deserializeDesignReviewRun)
    },
    create(data) {
      const subject = resolveDesignReviewSubject(data)
      const { designText, designTextHash, taskTitle, changedFiles } = data
      const createTransaction = db.transaction((): DesignReviewRun => {
        // partial unique index (review_kind, subject_id) WHERE status IN ('queued','running') と同じ条件で
        // 事前に確認し、二重起票ではなく既存runを返す。
        const existing = db.prepare(
          "SELECT * FROM design_review_runs WHERE review_kind = ? AND subject_id = ? AND status IN ('queued','running') LIMIT 1"
        ).get(subject.reviewKind, subject.subjectId) as any
        if (existing) {
          return deserializeDesignReviewRun(existing)
        }

        const run: DesignReviewRun = {
          id: randomUUID(),
          reviewKind: subject.reviewKind,
          subjectId: subject.subjectId,
          taskId: subject.taskId,
          designText,
          designTextHash,
          taskTitle,
          changedFiles,
          status: 'queued',
          attemptCount: 0,
          createdAt: now(),
        }
        try {
          db.prepare(`
            INSERT INTO design_review_runs
              (id, review_kind, subject_id, task_id, design_text, design_text_hash, task_title, changed_files, status,
               attempt_count, claim_token, result_json, error, created_at, started_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)
          `).run(
            run.id, run.reviewKind, run.subjectId, run.taskId ?? null, run.designText, run.designTextHash, run.taskTitle,
            JSON.stringify(run.changedFiles), run.status, run.attemptCount, run.createdAt,
          )
        } catch (err) {
          // partial unique index (ux_design_review_runs_subject_active) 違反は「別経路が先に
          // active runを作った」ことを意味するので、例外にせず既存runを返す。
          const existingAfterConflict = db.prepare(
            "SELECT * FROM design_review_runs WHERE review_kind = ? AND subject_id = ? AND status IN ('queued','running') LIMIT 1"
          ).get(subject.reviewKind, subject.subjectId) as any
          if (!existingAfterConflict) {
            throw err
          }
          return deserializeDesignReviewRun(existingAfterConflict)
        }
        return run
      })
      return createTransaction()
    },
    claim(id, maxAttempts) {
      const claimTransaction = db.transaction((): ClaimDesignReviewRunResult => {
        const current = db.prepare('SELECT * FROM design_review_runs WHERE id = ?').get(id) as any
        if (!current || current.status !== 'queued') {
          return {}
        }

        // bounded attempt: 超過分はclaimせずfailedで終端させ、再実行しない。
        if (current.attempt_count >= maxAttempts) {
          db.prepare(`
            UPDATE design_review_runs
            SET status = 'failed', claim_token = NULL, error = ?, completed_at = ?
            WHERE id = ? AND status = 'queued'
          `).run(`max attempts (${maxAttempts}) exceeded`, now(), id)
          return {}
        }

        const claimToken = randomUUID()
        const result = db.prepare(`
          UPDATE design_review_runs
          SET status = 'running', attempt_count = attempt_count + 1, claim_token = ?, started_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(claimToken, now(), id)

        if (result.changes !== 1) {
          return {}
        }

        const claimed = db.prepare('SELECT * FROM design_review_runs WHERE id = ?').get(id) as any
        return { run: deserializeDesignReviewRun(claimed), claimToken }
      })
      return claimTransaction()
    },
    complete(id, claimToken, status, resultJson, error) {
      const result = db.prepare(`
        UPDATE design_review_runs
        SET status = ?, result_json = ?, error = ?, completed_at = ?, claim_token = NULL
        WHERE id = ? AND claim_token = ? AND status = 'running'
      `).run(status, resultJson ?? null, error ?? null, now(), id, claimToken)
      return result.changes === 1
    },
    completeWithEvidence(id, claimToken, resultJson, evidenceData) {
      const completeTransaction = db.transaction((): DesignReviewEvidence | undefined => {
        const fenced = db.prepare(`
          UPDATE design_review_runs
          SET status = 'succeeded', result_json = ?, error = NULL, completed_at = ?, claim_token = NULL
          WHERE id = ? AND claim_token = ? AND status = 'running'
        `).run(resultJson, now(), id, claimToken)

        // stale attempt: 既にrequeue/別attemptで進行しているため、evidenceを登録してはならない。
        if (fenced.changes !== 1) {
          return undefined
        }

        return designReviewEvidence.create(evidenceData)
      })
      return completeTransaction()
    },
    requeue(id, claimToken, error) {
      const result = db.prepare(`
        UPDATE design_review_runs
        SET status = 'queued', claim_token = NULL, error = ?, started_at = NULL
        WHERE id = ? AND claim_token = ? AND status = 'running'
      `).run(error, id, claimToken)
      return result.changes === 1
    },
    recoverStaleRunningAtStartup(maxAttempts, startedBefore) {
      const recoverTransaction = db.transaction((): DesignReviewRun[] => {
        // startedBefore（＝現プロセス起動時刻）より後に開始したrunは現プロセスが実行中の
        // ものなので回収対象にしない。稼働中に誤って呼ばれても実行中attemptを壊さない。
        const rows = db.prepare(
          "SELECT * FROM design_review_runs WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)"
        ).all(startedBefore) as any[]
        const recovered: DesignReviewRun[] = []

        for (const row of rows) {
          if (row.attempt_count >= maxAttempts) {
            db.prepare(`
              UPDATE design_review_runs
              SET status = 'failed', claim_token = NULL, error = ?, completed_at = ?
              WHERE id = ? AND status = 'running'
            `).run(`max attempts (${maxAttempts}) exceeded after API restart`, now(), row.id)
            continue
          }

          // claim_tokenをNULLにするため、旧processの遅延completeはこの後必ず0行になる。
          db.prepare(`
            UPDATE design_review_runs
            SET status = 'queued', claim_token = NULL, error = ?, started_at = NULL
            WHERE id = ? AND status = 'running'
          `).run('recovered from stale running at API startup', row.id)

          const requeued = db.prepare('SELECT * FROM design_review_runs WHERE id = ?').get(row.id) as any
          recovered.push(deserializeDesignReviewRun(requeued))
        }

        return recovered
      })
      return recoverTransaction()
    },
  }

  const taskContinuations: ITaskContinuationStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM task_continuations WHERE id = ?').get(id) as any
      return row ? deserializeTaskContinuation(row) : undefined
    },
    findBySourceJobId(sourceJobId) {
      const row = db.prepare(
        'SELECT * FROM task_continuations WHERE source_job_id = ?'
      ).get(sourceJobId) as any
      return row ? deserializeTaskContinuation(row) : undefined
    },
    findByCompletedTaskId(completedTaskId) {
      const row = db.prepare(
        'SELECT * FROM task_continuations WHERE completed_task_id = ?'
      ).get(completedTaskId) as any
      return row ? deserializeTaskContinuation(row) : undefined
    },
    findPendingByProjectId(projectId) {
      const rows = db.prepare(
        "SELECT * FROM task_continuations WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC"
      ).all(projectId) as any[]
      return rows.map(deserializeTaskContinuation)
    },
    create(data) {
      const continuation: TaskContinuation = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO task_continuations
          (id, source_job_id, project_id, completed_task_id, next_task_id, status, error, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        continuation.id,
        continuation.sourceJobId,
        continuation.projectId,
        continuation.completedTaskId,
        continuation.nextTaskId ?? null,
        continuation.status,
        continuation.error ?? null,
        continuation.createdAt,
        continuation.completedAt ?? null,
      )
      return continuation
    },
    update(id, data) {
      const existing = taskContinuations.findById(id)
      if (!existing) return undefined
      const updated: TaskContinuation = { ...existing, ...data }
      db.prepare(
        'UPDATE task_continuations SET status = ?, error = ?, completed_at = ? WHERE id = ?'
      ).run(updated.status, updated.error ?? null, updated.completedAt ?? null, id)
      return updated
    },
  }

  const auditLog: IAuditLogStorage = {
    findByEntity(entityType, entityId) {
      const rows = db.prepare(
        'SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, rowid DESC'
      ).all(entityType, entityId) as any[]
      return rows.map(deserializeAuditLogEntry)
    },
    findAll() {
      const rows = db.prepare(
        'SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC'
      ).all() as any[]
      return rows.map(deserializeAuditLogEntry)
    },
    record(data) {
      const entry: AuditLogEntry = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO audit_log (id, actor, operation, entity_type, entity_id, result, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.actor,
        entry.operation,
        entry.entityType,
        entry.entityId,
        entry.result,
        entry.detail ?? null,
        entry.createdAt,
      )
      return entry
    },
  }

  function generateKGNodeId(): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const rows = db.prepare(
      "SELECT id FROM knowledge_graph_nodes WHERE id LIKE ? ORDER BY id DESC LIMIT 1"
    ).all(`kg-${date}-%`) as Array<{ id: string }>
    if (rows.length === 0) {
      return `kg-${date}-001`
    }
    const last = rows[0].id
    const seq = parseInt(last.split('-')[2] ?? '0', 10)
    return `kg-${date}-${String(seq + 1).padStart(3, '0')}`
  }

  function generateKGEdgeId(): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const rows = db.prepare(
      "SELECT id FROM knowledge_graph_edges WHERE id LIKE ? ORDER BY id DESC LIMIT 1"
    ).all(`kge-${date}-%`) as Array<{ id: string }>
    if (rows.length === 0) {
      return `kge-${date}-001`
    }
    const last = rows[0].id
    const parts = last.split('-')
    const seq = parseInt(parts[2] ?? '0', 10)
    return `kge-${date}-${String(seq + 1).padStart(3, '0')}`
  }

  const knowledgeGraph: IKnowledgeGraphStorage = {
    findNodeById(id) {
      const row = db.prepare('SELECT * FROM knowledge_graph_nodes WHERE id = ?').get(id) as any
      return row ? deserializeKGNode(row) : undefined
    },
    findNodesByType(type: KGNodeType) {
      const rows = db.prepare('SELECT * FROM knowledge_graph_nodes WHERE type = ? ORDER BY created_at DESC').all(type) as any[]
      return rows.map(deserializeKGNode)
    },
    findNodesByPhase(phase: string) {
      const rows = db.prepare('SELECT * FROM knowledge_graph_nodes WHERE phase = ? ORDER BY created_at DESC').all(phase) as any[]
      return rows.map(deserializeKGNode)
    },
    findNodesByTag(tag: string) {
      // JSON contains search: simple LIKE approach
      const rows = db.prepare(
        "SELECT * FROM knowledge_graph_nodes WHERE tags LIKE ? ORDER BY created_at DESC"
      ).all(`%${tag}%`) as any[]
      return rows.map(deserializeKGNode).filter((n) => n.tags.includes(tag))
    },
    createNode(data) {
      const node: KGNode = {
        ...data,
        id: generateKGNodeId(),
        createdAt: now(),
        updatedAt: now(),
      }
      db.prepare(`
        INSERT INTO knowledge_graph_nodes
          (id, type, title, tags, phase, status, risk, priority, summary,
           related_docs, related_files, depends_on, blocks,
           related_features, related_incidents, related_decisions, history_refs,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        node.id,
        node.type,
        node.title,
        JSON.stringify(node.tags),
        node.phase ?? null,
        node.status,
        node.risk,
        node.priority,
        node.summary ?? null,
        JSON.stringify(node.relatedDocs),
        JSON.stringify(node.relatedFiles),
        JSON.stringify(node.dependsOn),
        JSON.stringify(node.blocks),
        JSON.stringify(node.relatedFeatures),
        JSON.stringify(node.relatedIncidents),
        JSON.stringify(node.relatedDecisions),
        JSON.stringify(node.historyRefs),
        node.createdAt,
        node.updatedAt,
      )
      return node
    },
    updateNode(id, data) {
      const existing = knowledgeGraph.findNodeById(id)
      if (!existing) return undefined
      const updated: KGNode = { ...existing, ...data, updatedAt: now() }
      db.prepare(`
        UPDATE knowledge_graph_nodes SET
          type=?, title=?, tags=?, phase=?, status=?, risk=?, priority=?, summary=?,
          related_docs=?, related_files=?, depends_on=?, blocks=?,
          related_features=?, related_incidents=?, related_decisions=?, history_refs=?,
          updated_at=?
        WHERE id=?
      `).run(
        updated.type,
        updated.title,
        JSON.stringify(updated.tags),
        updated.phase ?? null,
        updated.status,
        updated.risk,
        updated.priority,
        updated.summary ?? null,
        JSON.stringify(updated.relatedDocs),
        JSON.stringify(updated.relatedFiles),
        JSON.stringify(updated.dependsOn),
        JSON.stringify(updated.blocks),
        JSON.stringify(updated.relatedFeatures),
        JSON.stringify(updated.relatedIncidents),
        JSON.stringify(updated.relatedDecisions),
        JSON.stringify(updated.historyRefs),
        updated.updatedAt,
        id,
      )
      return updated
    },
    deleteNode(id) {
      const deleteTransaction = db.transaction((): boolean => {
        // 接続する edge を先に削除（orphan 防止）
        db.prepare('DELETE FROM knowledge_graph_edges WHERE from_node_id = ? OR to_node_id = ?').run(id, id)
        const result = db.prepare('DELETE FROM knowledge_graph_nodes WHERE id = ?').run(id)
        const deleted = result.changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'kg_node', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
    findEdgeById(id) {
      const row = db.prepare('SELECT * FROM knowledge_graph_edges WHERE id = ?').get(id) as any
      return row ? deserializeKGEdge(row) : undefined
    },
    findEdgesByFromNode(fromNodeId: string) {
      const rows = db.prepare('SELECT * FROM knowledge_graph_edges WHERE from_node_id = ? ORDER BY created_at DESC').all(fromNodeId) as any[]
      return rows.map(deserializeKGEdge)
    },
    findEdgesByToNode(toNodeId: string) {
      const rows = db.prepare('SELECT * FROM knowledge_graph_edges WHERE to_node_id = ? ORDER BY created_at DESC').all(toNodeId) as any[]
      return rows.map(deserializeKGEdge)
    },
    findEdgesByType(edgeType: KGEdgeType) {
      const rows = db.prepare('SELECT * FROM knowledge_graph_edges WHERE edge_type = ? ORDER BY created_at DESC').all(edgeType) as any[]
      return rows.map(deserializeKGEdge)
    },
    createEdge(data) {
      const edge: KGEdge = {
        ...data,
        id: generateKGEdgeId(),
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO knowledge_graph_edges (id, from_node_id, to_node_id, edge_type, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        edge.id,
        edge.fromNodeId,
        edge.toNodeId,
        edge.edgeType,
        edge.label ?? null,
        edge.createdAt,
      )
      return edge
    },
    deleteEdge(id) {
      const deleteTransaction = db.transaction((): boolean => {
        const result = db.prepare('DELETE FROM knowledge_graph_edges WHERE id = ?').run(id)
        const deleted = result.changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'kg_edge', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  const decisionCache: IDecisionCacheStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM decision_records WHERE id = ?').get(id) as any
      return row ? deserializeDecisionRecord(row) : undefined
    },
    findByKeywords(keywords) {
      const all = db.prepare('SELECT * FROM decision_records').all() as any[]
      return all
        .map(deserializeDecisionRecord)
        .filter(rec =>
          keywords.some(kw =>
            rec.keywords.some(rk => rk.toLowerCase().includes(kw.toLowerCase()))
          )
        )
    },
    findAll() {
      const rows = db.prepare('SELECT * FROM decision_records ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeDecisionRecord)
    },
    create(data) {
      const record: DecisionRecord = {
        ...data,
        id: makeDecisionId(),
        createdAt: now(),
        updatedAt: now(),
      }
      db.prepare(`
        INSERT INTO decision_records
          (id, title, keywords, decision, rationale, status, context, related_node_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.title,
        JSON.stringify(record.keywords),
        record.decision,
        record.rationale,
        record.status,
        JSON.stringify(record.context),
        JSON.stringify(record.relatedNodeIds),
        record.createdAt,
        record.updatedAt,
      )
      return record
    },
    update(id, data) {
      const existing = decisionCache.findById(id)
      if (!existing) return undefined
      const updated = { ...existing, ...data, updatedAt: now() }
      db.prepare(`
        UPDATE decision_records
        SET title=?, keywords=?, decision=?, rationale=?, status=?, context=?, related_node_ids=?, updated_at=?
        WHERE id=?
      `).run(
        updated.title,
        JSON.stringify(updated.keywords),
        updated.decision,
        updated.rationale,
        updated.status,
        JSON.stringify(updated.context),
        JSON.stringify(updated.relatedNodeIds),
        updated.updatedAt,
        id,
      )
      return updated
    },
    delete(id) {
      const deleteTransaction = db.transaction((): boolean => {
        const result = db.prepare('DELETE FROM decision_records WHERE id = ?').run(id)
        const deleted = result.changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'decision_record', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  const incidentDB: IIncidentDBStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM incident_records WHERE id = ?').get(id) as any
      return row ? deserializeIncidentRecord(row) : undefined
    },
    findByKeywords(keywords) {
      const all = db.prepare('SELECT * FROM incident_records').all() as any[]
      return all
        .map(deserializeIncidentRecord)
        .filter(rec =>
          keywords.some(kw =>
            rec.keywords.some(rk => rk.toLowerCase().includes(kw.toLowerCase()))
          )
        )
    },
    findBySeverity(severity) {
      const rows = db.prepare('SELECT * FROM incident_records WHERE severity = ? ORDER BY created_at DESC').all(severity) as any[]
      return rows.map(deserializeIncidentRecord)
    },
    findAll() {
      const rows = db.prepare('SELECT * FROM incident_records ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeIncidentRecord)
    },
    create(data) {
      const record: IncidentRecord = {
        ...data,
        id: makeIncidentId(),
        createdAt: now(),
      }
      db.prepare(`
        INSERT INTO incident_records
          (id, title, keywords, description, root_cause, prevention, severity, related_node_ids, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.title,
        JSON.stringify(record.keywords),
        record.description,
        record.rootCause,
        record.prevention,
        record.severity,
        JSON.stringify(record.relatedNodeIds),
        record.taskId ?? null,
        record.createdAt,
      )
      return record
    },
    delete(id) {
      const deleteTransaction = db.transaction((): boolean => {
        const result = db.prepare('DELETE FROM incident_records WHERE id = ?').run(id)
        const deleted = result.changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'incident_record', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  const patternLibrary: IPatternLibraryStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM pattern_records WHERE id = ?').get(id) as any
      return row ? deserializePatternRecord(row) : undefined
    },
    findByKeywords(keywords) {
      const all = db.prepare('SELECT * FROM pattern_records').all() as any[]
      return all
        .map(deserializePatternRecord)
        .filter(rec =>
          keywords.some(kw =>
            rec.keywords.some(rk => rk.toLowerCase().includes(kw.toLowerCase()))
          )
        )
    },
    findByFeatureType(featureType) {
      const rows = db.prepare('SELECT * FROM pattern_records WHERE feature_type = ? ORDER BY usage_count DESC').all(featureType) as any[]
      return rows.map(deserializePatternRecord)
    },
    findAll() {
      const rows = db.prepare('SELECT * FROM pattern_records ORDER BY usage_count DESC, created_at DESC').all() as any[]
      return rows.map(deserializePatternRecord)
    },
    create(data) {
      const record: PatternRecord = { ...data, id: makePatternId(), createdAt: now(), updatedAt: now() }
      db.prepare(`
        INSERT INTO pattern_records
          (id, title, keywords, description, steps, feature_type, trigger, related_node_ids, usage_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.title, JSON.stringify(record.keywords), record.description,
        JSON.stringify(record.steps), record.featureType, record.trigger,
        JSON.stringify(record.relatedNodeIds), record.usageCount, record.createdAt, record.updatedAt,
      )
      return record
    },
    update(id, data) {
      const existing = this.findById(id)
      if (!existing) return undefined
      const updated = { ...existing, ...data, updatedAt: now() }
      db.prepare(`
        UPDATE pattern_records
        SET title=?, keywords=?, description=?, steps=?, feature_type=?, trigger=?, related_node_ids=?, usage_count=?, updated_at=?
        WHERE id=?
      `).run(
        updated.title, JSON.stringify(updated.keywords), updated.description,
        JSON.stringify(updated.steps), updated.featureType, updated.trigger,
        JSON.stringify(updated.relatedNodeIds), updated.usageCount, updated.updatedAt, id,
      )
      return updated
    },
    incrementUsage(id) {
      db.prepare('UPDATE pattern_records SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?').run(now(), id)
      return this.findById(id)
    },
    delete(id) {
      const deleteTransaction = db.transaction((): boolean => {
        const deleted = db.prepare('DELETE FROM pattern_records WHERE id = ?').run(id).changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'pattern_record', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  const featureDNA: IFeatureDNAStorage = {
    findByNodeId(nodeId) {
      const row = db.prepare('SELECT * FROM feature_dna WHERE node_id = ?').get(nodeId) as any
      return row ? deserializeFeatureDNA(row) : undefined
    },
    findAll() {
      const rows = db.prepare('SELECT * FROM feature_dna ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeFeatureDNA)
    },
    create(data) {
      const record: FeatureDNA = { ...data, createdAt: now(), updatedAt: now() }
      db.prepare(`
        INSERT INTO feature_dna
          (node_id, reason, source_task_id, related_task_ids, ai_notes, history, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.nodeId, record.reason, record.sourceTaskId ?? null,
        JSON.stringify(record.relatedTaskIds), JSON.stringify(record.aiNotes),
        JSON.stringify(record.history), record.createdAt, record.updatedAt,
      )
      return record
    },
    update(nodeId, data) {
      const existing = this.findByNodeId(nodeId)
      if (!existing) return undefined
      const updated = { ...existing, ...data, updatedAt: now() }
      db.prepare(`
        UPDATE feature_dna
        SET reason=?, source_task_id=?, related_task_ids=?, ai_notes=?, history=?, updated_at=?
        WHERE node_id=?
      `).run(
        updated.reason, updated.sourceTaskId ?? null,
        JSON.stringify(updated.relatedTaskIds), JSON.stringify(updated.aiNotes),
        JSON.stringify(updated.history), updated.updatedAt, nodeId,
      )
      return updated
    },
    appendHistory(nodeId, note) {
      const existing = this.findByNodeId(nodeId)
      if (!existing) return undefined
      const history = [...existing.history, { at: now(), note }]
      return this.update(nodeId, { history })
    },
    delete(nodeId) {
      const deleteTransaction = db.transaction((): boolean => {
        const deleted = db.prepare('DELETE FROM feature_dna WHERE node_id = ?').run(nodeId).changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'feature_dna', entityId: nodeId,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  const selfReflection: ISelfReflectionStorage = {
    findById(id) {
      const row = db.prepare('SELECT * FROM self_reflections WHERE id = ?').get(id) as any
      return row ? deserializeSelfReflection(row) : undefined
    },
    findByTaskId(taskId) {
      const rows = db.prepare('SELECT * FROM self_reflections WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as any[]
      return rows.map(deserializeSelfReflection)
    },
    findByTrigger(trigger) {
      const rows = db.prepare('SELECT * FROM self_reflections WHERE trigger = ? ORDER BY created_at DESC').all(trigger) as any[]
      return rows.map(deserializeSelfReflection)
    },
    findAll() {
      const rows = db.prepare('SELECT * FROM self_reflections ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeSelfReflection)
    },
    create(data) {
      const record: SelfReflectionEntry = { ...data, id: makeReflectionId(), createdAt: now() }
      db.prepare(`
        INSERT INTO self_reflections
          (id, trigger, summary, root_cause, improvement, task_id, related_node_ids, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.trigger, record.summary,
        record.rootCause ?? null, record.improvement,
        record.taskId ?? null, JSON.stringify(record.relatedNodeIds), record.createdAt,
      )
      return record
    },
    delete(id) {
      const deleteTransaction = db.transaction((): boolean => {
        const deleted = db.prepare('DELETE FROM self_reflections WHERE id = ?').run(id).changes > 0
        auditLog.record({
          actor: 'api', operation: 'delete', entityType: 'self_reflection', entityId: id,
          result: deleted ? 'success' : 'failure',
        })
        return deleted
      })
      return deleteTransaction()
    },
  }

  storage = { projects, tasks, jobs, approvals, reviewResults, qaResults, permissionGrants, watchdogEvents, approvalRequests, designReviewEvidence, designReviewRuns, supervisedRuns, gateEvaluations, auditLog, taskContinuations, projectRoadmapPhases, knowledgeGraph, decisionCache, incidentDB, patternLibrary, featureDNA, selfReflection }
  return storage
}

function deserializeProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    designPhilosophy: JSON.parse(row.design_philosophy),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.start_stage ? { startStage: row.start_stage } : {}),
    ...(row.start_stage_updated_at ? { startStageUpdatedAt: row.start_stage_updated_at } : {}),
    ...(row.start_blocked_reason ? { startBlockedReason: row.start_blocked_reason } : {}),
  }
}

function deserializeTask(row: any): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    provider: row.provider ?? undefined,
    dependencies: JSON.parse(row.dependencies),
    allowedPaths: JSON.parse(row.allowed_paths ?? '[]'),
    forbiddenPaths: JSON.parse(row.forbidden_paths ?? '[]'),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria ?? '[]'),
    expectedOutputs: JSON.parse(row.expected_outputs ?? '[]'),
    roadmapTaskKey: row.roadmap_task_key ?? undefined,
    phase: row.phase ?? undefined,
    roadmapActive: row.roadmap_active === 1,
    branchName: row.branch_name ?? undefined,
    commitHash: row.commit_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeProjectRoadmapPhase(row: any): ProjectRoadmapPhase {
  return {
    projectId: row.project_id,
    phaseNumber: row.phase_number,
    name: row.name,
    goal: row.goal,
    roadmapActive: row.roadmap_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeJob(row: any): Job {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    workflowStepKey: row.workflow_step_key ?? undefined,
    agentRole: row.agent_role,
    status: row.status,
    safeCommand: row.safe_command
      ? JSON.parse(row.safe_command)
      : { kind: 'git_status', workingDir: TARGET_WORKING_DIR },
    dryRun: row.dry_run === 1 ? true : undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    stdout: row.stdout ?? undefined,
    stderr: row.stderr ?? undefined,
    stdoutPath: row.stdout_path ?? undefined,
    stderrPath: row.stderr_path ?? undefined,
    changedFiles: JSON.parse(row.changed_files ?? '[]'),
    commitHash: row.commit_hash ?? undefined,
    rollbackInfo: row.rollback_info ? JSON.parse(row.rollback_info) : undefined,
    guardResult: row.guard_result ? JSON.parse(row.guard_result) : undefined,
    failureMetadata: row.failure_metadata ? JSON.parse(row.failure_metadata) : undefined,
    workspaceBaseline: row.workspace_baseline ? JSON.parse(row.workspace_baseline) : undefined,
    approvalId: row.approval_id ?? undefined,
    aiCliProvider: row.ai_cli_provider ?? undefined,
    aiCliPrompt: row.ai_cli_prompt ?? undefined,
    aiCliMode: row.ai_cli_mode ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializeReviewResult(row: any): ReviewResult {
  return {
    id: row.id,
    taskId: row.task_id,
    jobId: row.job_id,
    reviewer: row.reviewer,
    status: row.status,
    summary: row.summary,
    findings: JSON.parse(row.findings ?? '[]'),
    createdAt: row.created_at,
  }
}

function deserializeQAResult(row: any): QAResult {
  return {
    id: row.id,
    taskId: row.task_id,
    jobId: row.job_id,
    type: row.type,
    status: row.status,
    summary: row.summary,
    details: row.details ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializePermissionGrant(row: any): PermissionGrant {
  return {
    id: row.id,
    taskId: row.task_id ?? undefined,
    jobId: row.job_id ?? undefined,
    allowedCommandKinds: JSON.parse(row.allowed_command_kinds ?? '[]'),
    agentRole: row.agent_role,
    scope: row.scope,
    expiresAt: row.expires_at ?? undefined,
    reason: row.reason ?? undefined,
    used: row.used === 1,
    createdAt: row.created_at,
  }
}

function deserializeWatchdogEvent(row: any): WatchdogEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    taskId: row.task_id,
    commandKind: row.command_kind,
    workingDir: row.working_dir,
    startedAt: row.started_at,
    detectedAt: row.detected_at,
    stallDurationMs: row.stall_duration_ms,
    status: row.status,
    aiAnalysis: row.ai_analysis ?? undefined,
    isStuck: row.is_stuck === null ? undefined : row.is_stuck === 1,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializeApproval(row: any): Approval {
  return {
    id: row.id,
    title: row.title,
    reason: row.reason,
    type: row.type,
    status: row.status,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewNote: row.review_note ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializeApprovalWithProjectId(row: any): Approval {
  const approval: Approval & { projectId: string } = {
    ...deserializeApproval(row),
    projectId: row.project_id,
  }
  return approval
}

function deserializeApprovalRequest(row: any): ApprovalRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    targetBranch: row.target_branch,
    targetCommit: row.target_commit,
    targetDiffHash: row.target_diff_hash,
    riskLevel: row.risk_level as ApprovalRequest['riskLevel'],
    requestedAction: row.requested_action,
    changedFiles: parseStringArray(row.changed_files),
    triggeredRules: parseStringArray(row.triggered_rules),
    status: row.status as ApprovalGateStatus,
    expiresAt: row.expires_at,
    invalidIf: JSON.parse(row.invalid_if ?? '[]') as string[],
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
  }
}

function deserializeDesignReviewEvidence(row: any): DesignReviewEvidence {
  return {
    id: row.id,
    reviewKind: row.review_kind as DesignReviewEvidence['reviewKind'],
    subjectId: row.subject_id,
    taskId: row.task_id ?? undefined,
    designTextHash: row.design_text_hash,
    reviewLoad: row.review_load as DesignReviewEvidence['reviewLoad'],
    decision: row.decision as DesignReviewEvidence['decision'],
    independentReviewRequired: row.independent_review_required === 1,
    independentReviewVerdict: (row.independent_review_verdict ?? undefined) as DesignReviewEvidence['independentReviewVerdict'] | undefined,
    createdAt: row.created_at,
  }
}

function deserializeGateEvaluation(row: any): GateEvaluationEvidence {
  return {
    id: row.id,
    taskId: row.task_id,
    jobId: row.job_id ?? undefined,
    targetBranch: row.target_branch,
    targetCommit: row.target_commit,
    targetDiffHash: row.target_diff_hash,
    decision: row.decision,
    riskLevel: row.risk_level,
    triggeredRules: JSON.parse(row.triggered_rules ?? '[]') as string[],
    policyVersion: row.policy_version,
    bindingVerification: (row.binding_verification ?? 'unverified') as GateEvaluationEvidence['bindingVerification'],
    approvedContentHash: row.approved_content_hash ?? undefined,
    resultingCommit: row.resulting_commit ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializeSupervisedRun(row: any): SupervisedRun {
  return {
    id: row.id,
    kind: row.kind as SupervisedRun['kind'],
    subjectId: row.subject_id,
    status: row.status as SupervisedRun['status'],
    predicateKey: row.predicate_key,
    predicateVersion: row.predicate_version,
    progressEvidence: parseJsonObject(row.progress_evidence),
    completionEvidence: parseJsonObject(row.completion_evidence),
    progressSource: row.progress_source ?? undefined,
    currentStage: row.current_stage ?? undefined,
    supervisor: row.supervisor ?? undefined,
    recoveryAttemptCount: row.recovery_attempt_count,
    claimToken: row.claim_token ?? undefined,
    terminalVerdict: row.terminal_verdict ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastProgressAt: row.last_progress_at,
    completedAt: row.completed_at ?? undefined,
  }
}

/**
 * evidence列のJSONを読む。壊れた値で行全体を読めなくしないため、
 * parse失敗時は undefined を返す（evidence は監査情報であり、判定の根拠ではない）。
 */
function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function deserializeDesignReviewRun(row: any): DesignReviewRun {
  return {
    id: row.id,
    reviewKind: row.review_kind as DesignReviewRun['reviewKind'],
    subjectId: row.subject_id,
    taskId: row.task_id ?? undefined,
    designText: row.design_text,
    designTextHash: row.design_text_hash,
    taskTitle: row.task_title ?? '',
    changedFiles: JSON.parse(row.changed_files ?? '[]') as string[],
    status: row.status as DesignReviewRun['status'],
    attemptCount: row.attempt_count,
    claimToken: row.claim_token ?? undefined,
    resultJson: row.result_json ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }
}

function deserializeTaskContinuation(row: any): TaskContinuation {
  return {
    id: row.id,
    sourceJobId: row.source_job_id,
    projectId: row.project_id,
    completedTaskId: row.completed_task_id,
    nextTaskId: row.next_task_id ?? undefined,
    status: row.status as TaskContinuation['status'],
    error: row.error ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  }
}

function deserializeAuditLogEntry(row: any): AuditLogEntry {
  return {
    id: row.id,
    actor: row.actor as AuditLogEntry['actor'],
    operation: row.operation,
    entityType: row.entity_type,
    entityId: row.entity_id,
    result: row.result,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializeKGNode(row: any): KGNode {
  return {
    id: row.id,
    type: row.type as KGNodeType,
    title: row.title,
    tags: JSON.parse(row.tags ?? '[]'),
    phase: row.phase ?? undefined,
    status: row.status,
    risk: row.risk,
    priority: row.priority,
    summary: row.summary ?? undefined,
    relatedDocs: JSON.parse(row.related_docs ?? '[]'),
    relatedFiles: JSON.parse(row.related_files ?? '[]'),
    dependsOn: JSON.parse(row.depends_on ?? '[]'),
    blocks: JSON.parse(row.blocks ?? '[]'),
    relatedFeatures: JSON.parse(row.related_features ?? '[]'),
    relatedIncidents: JSON.parse(row.related_incidents ?? '[]'),
    relatedDecisions: JSON.parse(row.related_decisions ?? '[]'),
    historyRefs: JSON.parse(row.history_refs ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeDecisionRecord(row: any): DecisionRecord {
  return {
    id: row.id,
    title: row.title,
    keywords: JSON.parse(row.keywords ?? '[]'),
    decision: row.decision,
    rationale: row.rationale,
    status: row.status as DecisionStatus,
    context: JSON.parse(row.context ?? '[]'),
    relatedNodeIds: JSON.parse(row.related_node_ids ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeIncidentRecord(row: any): IncidentRecord {
  return {
    id: row.id,
    title: row.title,
    keywords: JSON.parse(row.keywords ?? '[]'),
    description: row.description,
    rootCause: row.root_cause,
    prevention: row.prevention,
    severity: row.severity as IncidentSeverity,
    relatedNodeIds: JSON.parse(row.related_node_ids ?? '[]'),
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializeKGEdge(row: any): KGEdge {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    edgeType: row.edge_type as KGEdgeType,
    label: row.label ?? undefined,
    createdAt: row.created_at,
  }
}

function deserializePatternRecord(row: any): PatternRecord {
  return {
    id: row.id,
    title: row.title,
    keywords: JSON.parse(row.keywords ?? '[]'),
    description: row.description,
    steps: JSON.parse(row.steps ?? '[]'),
    featureType: row.feature_type,
    trigger: row.trigger as PatternTrigger,
    relatedNodeIds: JSON.parse(row.related_node_ids ?? '[]'),
    usageCount: row.usage_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeFeatureDNA(row: any): FeatureDNA {
  return {
    nodeId: row.node_id,
    reason: row.reason,
    sourceTaskId: row.source_task_id ?? undefined,
    relatedTaskIds: JSON.parse(row.related_task_ids ?? '[]'),
    aiNotes: JSON.parse(row.ai_notes ?? '[]'),
    history: JSON.parse(row.history ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deserializeSelfReflection(row: any): SelfReflectionEntry {
  return {
    id: row.id,
    trigger: row.trigger as ReflectionTrigger,
    summary: row.summary,
    rootCause: row.root_cause ?? undefined,
    improvement: row.improvement,
    taskId: row.task_id ?? undefined,
    relatedNodeIds: JSON.parse(row.related_node_ids ?? '[]'),
    createdAt: row.created_at,
  }
}

function runMigrations(db: Database.Database): void {
  for (const { table, column, definition } of MIGRATION_STATEMENTS) {
    const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }
}

function runDesignReviewSubjectMigration(db: Database.Database): void {
  const evidenceColumns = (db.pragma('table_info(design_review_evidence)') as Array<{ name: string }>)
    .map((column) => column.name)
  if (evidenceColumns.includes('review_kind')) {
    return
  }

  const migrate = db.transaction((): void => {
    db.exec(`
      CREATE TABLE design_review_evidence_new (
        id TEXT PRIMARY KEY,
        review_kind TEXT NOT NULL DEFAULT 'task',
        subject_id TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        design_text_hash TEXT NOT NULL,
        review_load TEXT NOT NULL,
        decision TEXT NOT NULL,
        independent_review_required INTEGER NOT NULL DEFAULT 0,
        independent_review_verdict TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      INSERT INTO design_review_evidence_new
        (id, review_kind, subject_id, task_id, design_text_hash, review_load, decision,
         independent_review_required, independent_review_verdict, created_at)
      SELECT
        id, 'task', task_id, task_id, design_text_hash, review_load, decision,
        independent_review_required, independent_review_verdict, created_at
      FROM design_review_evidence;

      DROP TABLE design_review_evidence;
      ALTER TABLE design_review_evidence_new RENAME TO design_review_evidence;

      CREATE TABLE design_review_runs_new (
        id TEXT PRIMARY KEY,
        review_kind TEXT NOT NULL DEFAULT 'task',
        subject_id TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        design_text TEXT NOT NULL,
        design_text_hash TEXT NOT NULL,
        task_title TEXT NOT NULL DEFAULT '',
        changed_files TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      INSERT INTO design_review_runs_new
        (id, review_kind, subject_id, task_id, design_text, design_text_hash, task_title,
         changed_files, status, attempt_count, claim_token, result_json, error, created_at,
         started_at, completed_at)
      SELECT
        id, 'task', task_id, task_id, design_text, design_text_hash, task_title,
        changed_files, status, attempt_count, claim_token, result_json, error, created_at,
        started_at, completed_at
      FROM design_review_runs;

      DROP TABLE design_review_runs;
      ALTER TABLE design_review_runs_new RENAME TO design_review_runs;

      CREATE INDEX IF NOT EXISTS ix_design_review_evidence_task_created_at
        ON design_review_evidence(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_design_review_evidence_subject_created_at
        ON design_review_evidence(review_kind, subject_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_design_review_runs_subject_active
        ON design_review_runs(review_kind, subject_id) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS ix_design_review_runs_status_started_at
        ON design_review_runs(status, started_at);
    `)
  })

  migrate()
}

function runIndexMigrations(db: Database.Database): void {
  for (const statement of INDEX_STATEMENTS) {
    db.exec(statement)
  }
}
