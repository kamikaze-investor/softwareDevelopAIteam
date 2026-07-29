/**
 * SQLite Storage 実装
 *
 * Race Condition対応済み（better-sqlite3は同期APIでトランザクション管理が容易）
 * Phase 2でPostgreSQLに移行する際はこのファイルをPostgres実装に差し替える
 * → IStorage インターフェースを実装した別クラスに切り替えるだけでよい
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { CREATE_TABLES, INDEX_STATEMENTS, MIGRATION_STATEMENTS } from './schema'
import type { IStorage, IProjectStorage, ITaskStorage, IJobStorage, IApprovalStorage, IReviewResultStorage, IQAResultStorage, IPermissionGrantStorage, IWatchdogEventStorage, IApprovalRequestStorage, IKnowledgeGraphStorage, IDecisionCacheStorage, IIncidentDBStorage, IPatternLibraryStorage, IFeatureDNAStorage, ISelfReflectionStorage, ResumeBlockedTaskResult, RoadmapSyncResult } from './interface'
import { computeTaskDisplayStatus } from '@ai-team/shared'
import type { Project, Task, Approval, Job, JobStatus, ReviewResult, QAResult, PermissionGrant, WatchdogEvent, ApprovalRequest, ApprovalGateStatus, KGNode, KGEdge, KGNodeType, KGEdgeType, DecisionRecord, IncidentRecord, IncidentSeverity, DecisionStatus, PatternRecord, FeatureDNA, PatternTrigger, SelfReflectionEntry, ReflectionTrigger, TaskSummary } from '@ai-team/shared'
import type { RoadmapSyncTaskInput } from './roadmapTaskValidation'

export class SingleRunningProjectError extends Error {
  constructor() {
    super('Another project is already running')
    this.name = 'SingleRunningProjectError'
  }
}

const now = () => new Date().toISOString()

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

const DEFAULT_SUMMARY_LIMIT = 50
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
  // Approval correlation is intentionally taskId-only for this lightweight view.
  // It does not identify which Job maps to which ApprovalRequest; Job.approvalId wiring is a later task.
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
      startedAt: latestJob.startedAt,
      completedAt: latestJob.completedAt,
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
      latestJobCreatedAt: latestJob?.createdAt,
      latestApprovalStatus,
      latestApprovalCreatedAt: latestApproval?.createdAt,
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
  runIndexMigrations(db)

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
      const updated = { ...existing, ...data, updatedAt: now() }
      try {
        db.prepare(`
          UPDATE projects SET name=?, goal=?, design_philosophy=?, status=?, updated_at=? WHERE id=?
        `).run(
          updated.name,
          updated.goal,
          JSON.stringify(updated.designPhilosophy),
          updated.status,
          updated.updatedAt,
          id,
        )
      } catch (err: unknown) {
        throwSingleRunningProjectError(err)
      }
      return updated
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
      const emptyFailureResult = (failureReason: string): RoadmapSyncResult => ({
        ok: false,
        createdTaskIds: [],
        updatedTaskIds: [],
        reactivatedTaskIds: [],
        deactivatedTaskIds: [],
        failureReason,
      })

      const syncTransaction = db.transaction((
        projectId: string,
        roadmapTasks: RoadmapSyncTaskInput[],
      ): RoadmapSyncResult => {
        const createdTaskIds: string[] = []
        const updatedTaskIdSet = new Set<string>()
        const reactivatedTaskIds: string[] = []
        const deactivatedTaskIds: string[] = []
        const inputByKey = new Map(
          roadmapTasks.map((roadmapTask) => [roadmapTask.roadmapTaskKey, roadmapTask] as const),
        )
        const inputKeys = new Set(inputByKey.keys())

        const existingRows = db.prepare(
          'SELECT * FROM tasks WHERE project_id = ? AND roadmap_task_key IS NOT NULL',
        ).all(projectId) as any[]
        const existingRoadmapTasks = existingRows.map(deserializeTask)
        const disappearedTasks = existingRoadmapTasks.filter((task) => (
          task.roadmapTaskKey !== undefined && !inputKeys.has(task.roadmapTaskKey)
        ))

        for (const task of disappearedTasks) {
          const activeJob = (db.prepare('SELECT * FROM jobs WHERE task_id = ?').all(task.id) as any[])
            .find((jobRow) => ACTIVE_JOB_STATUSES.has(jobRow.status as JobStatus))

          if (activeJob) {
            return emptyFailureResult(
              `Cannot deactivate roadmap task ${task.roadmapTaskKey} because job ${activeJob.id} is ${activeJob.status}`,
            )
          }
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

          const jobRows = db.prepare('SELECT * FROM jobs WHERE task_id = ?').all(existingTask.id) as any[]
          const isUnstarted = jobRows.length === 0 && existingTask.status === 'pending'

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
        }
      })

      try {
        return syncTransaction(input.projectId, input.tasks)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return emptyFailureResult(message)
      }
    },
  }

  const jobs: IJobStorage = {
    findByTaskId(taskId) {
      const rows = db.prepare('SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as any[]
      return rows.map(deserializeJob)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any
      return row ? deserializeJob(row) : undefined
    },
    create(data) {
      const job: Job = { ...data, id: randomUUID(), createdAt: now() }
      db.prepare(`
        INSERT INTO jobs
          (id, task_id, project_id, agent_role, status, safe_command,
           ai_cli_provider, ai_cli_prompt, ai_cli_mode, dry_run, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.taskId,
        job.projectId,
        job.agentRole,
        job.status,
        JSON.stringify(job.safeCommand),
        job.aiCliProvider ?? null,
        job.aiCliPrompt ?? null,
        job.aiCliMode ?? null,
        job.dryRun ? 1 : 0,
        job.createdAt,
      )
      return job
    },
    update(id, data) {
      const existing = jobs.findById(id)
      if (!existing) return undefined
      const updated = { ...existing, ...data }
      db.prepare(`
        UPDATE jobs SET
          status=?, started_at=?, completed_at=?, exit_code=?,
          stdout=?, stderr=?, stdout_path=?, stderr_path=?, changed_files=?, commit_hash=?,
          rollback_info=?, guard_result=?, approval_id=?
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
        updated.approvalId ?? null,
        id,
      )
      return updated
    },
    resumeBlockedTask(input) {
      const resumeTransaction = db.transaction((taskId: string, instructionPrompt: string): ResumeBlockedTaskResult => {
        const jobRows = db.prepare(
          'SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at DESC'
        ).all(taskId) as any[]
        const taskJobs = jobRows.map(deserializeJob)
        const latestJob = taskJobs[0]

        if (!latestJob) {
          return { ok: false, reason: 'No jobs exist for this task' }
        }

        if (latestJob.status !== 'blocked') {
          return { ok: false, reason: `Latest job status is ${latestJob.status}, not blocked` }
        }

        if (taskJobs.some((job) => job.status === 'queued' || job.status === 'running')) {
          return { ok: false, reason: 'A queued or running job already exists for this task' }
        }

        const latestApprovalRow = db.prepare(
          'SELECT * FROM approval_requests WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(taskId) as any
        const latestApproval = latestApprovalRow ? deserializeApprovalRequest(latestApprovalRow) : undefined

        if (latestApproval?.status === 'WAITING_FOR_USER') {
          return { ok: false, reason: 'The latest approval request is waiting for user review' }
        }

        if (!latestJob.aiCliProvider || !latestJob.aiCliMode) {
          return { ok: false, reason: 'Latest blocked job is missing AI CLI provider or mode' }
        }

        const job = jobs.create({
          taskId,
          projectId: latestJob.projectId,
          agentRole: latestJob.agentRole,
          status: 'queued',
          safeCommand: latestJob.safeCommand,
          dryRun: latestJob.dryRun,
          aiCliProvider: latestJob.aiCliProvider,
          aiCliPrompt: instructionPrompt,
          aiCliMode: latestJob.aiCliMode,
        })

        return { ok: true, job }
      })

      return resumeTransaction(input.taskId, input.instructionPrompt)
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
      const existing = approvals.findById(id)
      if (!existing) return undefined
      const updated = { ...existing, ...data }
      db.prepare(`
        UPDATE approvals SET status=?, reviewed_at=?, review_note=? WHERE id=?
      `).run(updated.status, updated.reviewedAt ?? null, updated.reviewNote ?? null, id)
      return updated
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
      const result = db.prepare('DELETE FROM permission_grants WHERE id = ?').run(id)
      return result.changes > 0
    },
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
    create(data) {
      const event: WatchdogEvent = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
      }
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
      const rows = db.prepare(
        `SELECT * FROM approval_requests WHERE status = 'WAITING_FOR_USER' ORDER BY created_at DESC`
      ).all() as any[]
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
  }

  // ────────────────────────────────────────────────────────────
  // KnowledgeGraph Storage
  // ────────────────────────────────────────────────────────────

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
      // 接続する edge を先に削除（orphan 防止）
      db.prepare('DELETE FROM knowledge_graph_edges WHERE from_node_id = ? OR to_node_id = ?').run(id, id)
      const result = db.prepare('DELETE FROM knowledge_graph_nodes WHERE id = ?').run(id)
      return result.changes > 0
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
      const result = db.prepare('DELETE FROM knowledge_graph_edges WHERE id = ?').run(id)
      return result.changes > 0
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
      const result = db.prepare('DELETE FROM decision_records WHERE id = ?').run(id)
      return result.changes > 0
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
      const result = db.prepare('DELETE FROM incident_records WHERE id = ?').run(id)
      return result.changes > 0
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
      return db.prepare('DELETE FROM pattern_records WHERE id = ?').run(id).changes > 0
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
      return db.prepare('DELETE FROM feature_dna WHERE node_id = ?').run(nodeId).changes > 0
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
      return db.prepare('DELETE FROM self_reflections WHERE id = ?').run(id).changes > 0
    },
  }

  return { projects, tasks, jobs, approvals, reviewResults, qaResults, permissionGrants, watchdogEvents, approvalRequests, knowledgeGraph, decisionCache, incidentDB, patternLibrary, featureDNA, selfReflection }
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

function deserializeJob(row: any): Job {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    agentRole: row.agent_role,
    status: row.status,
    safeCommand: row.safe_command
      ? JSON.parse(row.safe_command)
      : { kind: 'git_status', workingDir: '/workspace/target' },
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

function runIndexMigrations(db: Database.Database): void {
  for (const statement of INDEX_STATEMENTS) {
    db.exec(statement)
  }
}
