/**
 * SQLite Storage 実装
 *
 * Race Condition対応済み（better-sqlite3は同期APIでトランザクション管理が容易）
 * Phase 2でPostgreSQLに移行する際はこのファイルをPostgres実装に差し替える
 * → IStorage インターフェースを実装した別クラスに切り替えるだけでよい
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { CREATE_TABLES, MIGRATION_STATEMENTS } from './schema'
import type { IStorage, IProjectStorage, ITaskStorage, IJobStorage, IApprovalStorage } from './interface'
import type { Project, Task, Approval, Job, SafeCommand } from '@ai-team/shared'

const now = () => new Date().toISOString()

export function createSQLiteStorage(dbPath: string): IStorage {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(CREATE_TABLES)
  runMigrations(db)

  const projects: IProjectStorage = {
    findAll() {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[]
      return rows.map(deserializeProject)
    },
    findById(id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
      return row ? deserializeProject(row) : undefined
    },
    create(data) {
      const project: Project = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
        updatedAt: now(),
      }
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
      return project
    },
    update(id, data) {
      const existing = projects.findById(id)
      if (!existing) return undefined
      const updated = { ...existing, ...data, updatedAt: now() }
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
    create(data) {
      const task: Task = {
        ...data,
        id: randomUUID(),
        createdAt: now(),
        updatedAt: now(),
      }
      db.prepare(`
        INSERT INTO tasks
          (id, project_id, title, description, status, assignee, provider, dependencies,
           allowed_paths, forbidden_paths, acceptance_criteria, expected_outputs,
           branch_name, commit_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const updated = { ...existing, ...data, updatedAt: now() }
      db.prepare(`
        UPDATE tasks SET
          title=?, description=?, status=?, assignee=?, provider=?, dependencies=?,
          allowed_paths=?, forbidden_paths=?, acceptance_criteria=?, expected_outputs=?,
          branch_name=?, commit_hash=?, updated_at=?
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
        updated.branchName ?? null,
        updated.commitHash ?? null,
        updated.updatedAt,
        id,
      )
      return updated
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
          (id, task_id, project_id, agent_role, status, safe_command, dry_run, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.taskId,
        job.projectId,
        job.agentRole,
        job.status,
        JSON.stringify(job.safeCommand),
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
  }

  const approvals: IApprovalStorage = {
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

  return { projects, tasks, jobs, approvals }
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
    // マイグレーション後の既存行は safe_command が NULL の可能性がある
    // Phase 1 では新規rowのみだが、防御的にフォールバックを設ける
    safeCommand: row.safe_command
      ? (JSON.parse(row.safe_command) as SafeCommand)
      : ({ kind: 'git_status', workingDir: '/workspace/target' } satisfies SafeCommand),
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

function runMigrations(db: Database.Database): void {
  for (const { table, column, definition } of MIGRATION_STATEMENTS) {
    const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }
}
