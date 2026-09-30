import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { abortTask } from '../pl/abortTask'
import type { IStorage } from './interface'
import { CREATE_TABLES } from './schema'
import { createSQLiteStorage } from './sqlite'

const CREATED_AT = '2026-09-30T00:00:00.000Z'

function databasePath(): string {
  return path.join(os.tmpdir(), `resume-source-reconciliation-${randomUUID()}.db`)
}

function seedDatabase(
  dbPath: string,
  seed: (db: Database.Database) => void,
): void {
  const db = new Database(dbPath)
  try {
    db.exec(CREATE_TABLES)
    db.prepare(`
      INSERT INTO projects (id, name, goal, design_philosophy, status, created_at, updated_at)
      VALUES ('project', 'Project', 'goal', '[]', 'running', ?, ?)
    `).run(CREATED_AT, CREATED_AT)
    seed(db)
  } finally {
    db.close()
  }
}

function insertTask(
  db: Database.Database,
  id: string,
  status: 'pending' | 'done',
  roadmapActive = false,
): void {
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, assignee, dependencies,
      roadmap_active, created_at, updated_at
    ) VALUES (?, 'project', ?, '', ?, 'developer_ai', '[]', ?, ?, ?)
  `).run(id, id, status, roadmapActive ? 1 : 0, CREATED_AT, CREATED_AT)
}

function insertJob(
  db: Database.Database,
  input: {
    id: string
    taskId: string
    status: 'blocked' | 'failed' | 'success'
    workflowStepKey?: string
    failureMetadata?: string
  },
): void {
  db.prepare(`
    INSERT INTO jobs (
      id, task_id, project_id, workflow_step_key, agent_role, status,
      safe_command, dry_run, changed_files, failure_metadata, created_at
    ) VALUES (?, ?, 'project', ?, 'developer_ai', ?, ?, 0, '[]', ?, ?)
  `).run(
    input.id,
    input.taskId,
    input.workflowStepKey ?? null,
    input.status,
    JSON.stringify({ kind: 'test', workingDir: '/workspace/target', params: {} }),
    input.failureMetadata ?? null,
    CREATED_AT,
  )
}

function approveAbort(storage: IStorage, taskId: string): string {
  const approval = storage.approvalRequests.create({
    taskId,
    requestedAction: 'abort_task',
    riskLevel: 'HIGH',
    targetBranch: 'ai/test',
    targetCommit: 'abc123',
    targetDiffHash: 'diff',
    changedFiles: [],
    triggeredRules: [],
    invalidIf: [],
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as Parameters<IStorage['approvalRequests']['create']>[0])
  storage.approvalRequests.updateStatus(approval.id, 'APPROVED')
  return approval.id
}

describe('startup reconciliation of resumed blocked source Jobs', () => {
  it('terminalizes only same-task canonical resume sources, audits once, and skips no-proof/quarantined rows', () => {
    const dbPath = databasePath()
    seedDatabase(dbPath, (db) => {
      for (const taskId of ['proved', 'sole', 'repair', 'quarantined', 'other']) {
        insertTask(db, taskId, 'done')
      }

      insertJob(db, { id: 'source-proved', taskId: 'proved', status: 'blocked' })
      insertJob(db, {
        id: 'successor-proved', taskId: 'proved', status: 'success',
        workflowStepKey: 'resume:source-proved:1',
      })

      insertJob(db, {
        id: 'source-sole', taskId: 'sole', status: 'blocked',
        workflowStepKey: 'task:sole:initial-implement',
      })
      // A reference from another Task is not proof for source-sole.
      insertJob(db, {
        id: 'cross-task-reference', taskId: 'other', status: 'success',
        workflowStepKey: 'resume:source-sole:1',
      })

      insertJob(db, {
        id: 'source-repair', taskId: 'repair', status: 'blocked',
        workflowStepKey: 'repair:older:1',
      })

      insertJob(db, {
        id: 'source-quarantined', taskId: 'quarantined', status: 'blocked',
        failureMetadata: JSON.stringify({ quarantined: true }),
      })
      insertJob(db, {
        id: 'successor-quarantined', taskId: 'quarantined', status: 'success',
        workflowStepKey: 'resume:source-quarantined:1',
      })
    })

    const first = createSQLiteStorage(dbPath)
    expect(first.jobs.findById('source-proved')?.status).toBe('failed')
    expect(first.jobs.findById('source-sole')?.status).toBe('blocked')
    expect(first.jobs.findById('source-repair')?.status).toBe('blocked')
    expect(first.jobs.findById('source-quarantined')?.status).toBe('blocked')
    expect(first.auditLog.findByEntity('job', 'source-proved')).toEqual([
      expect.objectContaining({
        operation: 'resume_source_terminalized',
        result: 'success',
        detail: expect.stringContaining('successor_job_id=successor-proved mode=startup_reconciliation'),
      }),
    ])

    const second = createSQLiteStorage(dbPath)
    expect(second.jobs.findById('source-proved')?.status).toBe('failed')
    expect(second.auditLog.findByEntity('job', 'source-proved')).toHaveLength(1)
  })

  it('lets a zero-Job pending Task park after every historical blocked row has formal lineage', () => {
    const dbPath = databasePath()
    seedDatabase(dbPath, (db) => {
      insertTask(db, 'done-task', 'done')
      insertTask(db, 'pending-task', 'pending', true)
      insertJob(db, { id: 'historical-source', taskId: 'done-task', status: 'blocked' })
      insertJob(db, {
        id: 'historical-successor', taskId: 'done-task', status: 'success',
        workflowStepKey: 'resume:historical-source:7',
      })
    })
    const storage = createSQLiteStorage(dbPath)

    const result = abortTask(storage, {
      taskId: 'pending-task',
      approvalRequestId: approveAbort(storage, 'pending-task'),
      reason: 'park zero-Job task',
    })

    expect(storage.jobs.findById('historical-source')?.status).toBe('failed')
    expect(result).toMatchObject({ ok: true, status: 'parked', taskId: 'pending-task' })
  })

  it('still refuses to park for an active foreign blocked Job', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'Project', goal: 'goal', designPhilosophy: [], status: 'running',
    })
    const active = storage.tasks.create({
      projectId: project.id, title: 'active', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    storage.jobs.create({
      taskId: active.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    const target = storage.tasks.create({
      projectId: project.id, title: 'target', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])

    expect(abortTask(storage, {
      taskId: target.id,
      approvalRequestId: approveAbort(storage, target.id),
      reason: 'park',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
  })

  it('fails closed when a completed Task has a blocked row with no formal successor proof', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'Project', goal: 'goal', designPhilosophy: [], status: 'running',
    })
    const done = storage.tasks.create({
      projectId: project.id, title: 'done', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: false,
    } as Parameters<IStorage['tasks']['create']>[0])
    storage.jobs.create({
      taskId: done.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
      workflowStepKey: `task:${done.id}:initial-implement`,
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    const target = storage.tasks.create({
      projectId: project.id, title: 'target', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])

    expect(abortTask(storage, {
      taskId: target.id,
      approvalRequestId: approveAbort(storage, target.id),
      reason: 'park',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
    expect(storage.jobs.findByTaskId(done.id)[0]?.status).toBe('blocked')
  })
})

describe('startup reconciliation — rows it must leave alone', () => {
  it('skips a source whose failure_metadata cannot be parsed (quarantine cannot be ruled out)', () => {
    const dbPath = databasePath()
    seedDatabase(dbPath, (db) => {
      insertTask(db, 'malformed', 'done')
      insertJob(db, { id: 'source-malformed', taskId: 'malformed', status: 'blocked', failureMetadata: '{not json' })
      insertJob(db, {
        id: 'successor-malformed', taskId: 'malformed', status: 'success',
        workflowStepKey: 'resume:source-malformed:1',
      })
    })

    const storage = createSQLiteStorage(dbPath)
    // 壊れた metadata は storage の deserialize が読めないので、行そのものを直接見る。
    const raw = new Database(dbPath, { readonly: true })
    try {
      expect((raw.prepare("SELECT status FROM jobs WHERE id = 'source-malformed'").get() as { status: string }).status).toBe('blocked')
    } finally {
      raw.close()
    }
    expect(storage.auditLog.findByEntity('job', 'source-malformed')).toHaveLength(0)
  })

  it('skips a source still bound to a WAITING_FOR_USER approval, even with resume lineage', () => {
    const dbPath = databasePath()
    seedDatabase(dbPath, (db) => {
      insertTask(db, 'waiting', 'done')
      insertJob(db, { id: 'source-waiting', taskId: 'waiting', status: 'blocked' })
      insertJob(db, {
        id: 'successor-waiting', taskId: 'waiting', status: 'success',
        workflowStepKey: 'resume:source-waiting:1',
      })
      db.prepare(`
        INSERT INTO approval_requests (
          id, task_id, target_branch, target_commit, target_diff_hash, risk_level,
          requested_action, status, expires_at, created_at
        ) VALUES ('approval-waiting', 'waiting', 'b', 'c', 'd', 'HIGH', 'git_commit', 'WAITING_FOR_USER', ?, ?)
      `).run(new Date(Date.now() + 60_000).toISOString(), CREATED_AT)
      db.prepare("UPDATE jobs SET approval_id = 'approval-waiting' WHERE id = 'source-waiting'").run()
    })

    const storage = createSQLiteStorage(dbPath)
    expect(storage.jobs.findById('source-waiting')?.status).toBe('blocked')
    expect(storage.auditLog.findByEntity('job', 'source-waiting')).toHaveLength(0)
  })
})
