import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { abortTask } from '../pl/abortTask'
import type { IStorage } from './interface'
import { CREATE_TABLES } from './schema'
import { createSQLiteStorage } from './sqlite'

// 本番の2行と同じ id。reconciliation は id 固定なので、テストもこの id で組み立てる。
const D5206 = 'd5206ab3-0751-4302-bf64-fa1ccd0d42ae'
const LATER_71B9 = '71b9ed29-b083-40e4-a572-3071e82c26b7'
const E8F04 = 'e8f04766-c80b-4571-99a0-ecd065736f98'
const LATER_8664 = '8664cddc-11bd-4560-897d-bb813ac74826'

const CREATED_AT = '2026-09-14T00:00:00.000Z'

function databasePath(): string {
  return path.join(os.tmpdir(), `historical-orphan-${randomUUID()}.db`)
}

function seed(dbPath: string, fn: (db: Database.Database) => void): void {
  const db = new Database(dbPath)
  try {
    db.exec(CREATE_TABLES)
    db.prepare(`
      INSERT INTO projects (id, name, goal, design_philosophy, status, created_at, updated_at)
      VALUES ('project', 'AIteamOS', 'goal', '[]', 'running', ?, ?)
    `).run(CREATED_AT, CREATED_AT)
    fn(db)
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
    workingDir?: string
    startedAt?: string | null
    completedAt?: string | null
    failureMetadata?: string
  },
): void {
  db.prepare(`
    INSERT INTO jobs (
      id, task_id, project_id, agent_role, status, safe_command, dry_run, changed_files,
      failure_metadata, started_at, completed_at, created_at
    ) VALUES (?, ?, 'project', 'developer_ai', ?, ?, 0, '[]', ?, ?, ?, ?)
  `).run(
    input.id,
    input.taskId,
    input.status,
    JSON.stringify({ kind: 'test', workingDir: input.workingDir ?? '/workspace/target', params: {} }),
    input.failureMetadata ?? null,
    input.startedAt === undefined ? '2026-09-14T14:45:08.818Z' : input.startedAt,
    input.completedAt === undefined ? '2026-09-14T14:50:13.304Z' : input.completedAt,
    CREATED_AT,
  )
}

/** 本番と同じ形: 2本の orphan と、それぞれの後に同じ workspace で始まった別 Task の Job。 */
function seedProductionShape(db: Database.Database): void {
  insertTask(db, 'task-76ea', 'done')
  insertTask(db, 'task-7bd4', 'done')
  insertTask(db, 'task-bd80', 'done')
  insertTask(db, 'task-1672', 'done')
  insertJob(db, {
    id: D5206, taskId: 'task-76ea', status: 'blocked',
    completedAt: '2026-09-14T14:50:13.304Z',
    failureMetadata: JSON.stringify({ kind: 'provider_timeout', workspaceState: 'changed' }),
  })
  insertJob(db, { id: LATER_71B9, taskId: 'task-bd80', status: 'failed', startedAt: '2026-09-14T17:29:06.239Z' })
  insertJob(db, {
    id: E8F04, taskId: 'task-7bd4', status: 'blocked',
    completedAt: '2026-09-15T05:08:00.031Z',
    failureMetadata: JSON.stringify({ kind: 'provider_timeout', workspaceState: 'changed' }),
  })
  insertJob(db, { id: LATER_8664, taskId: 'task-1672', status: 'failed', startedAt: '2026-09-15T08:11:01.348Z' })
}

function approveAbort(storage: IStorage, taskId: string): string {
  const approval = storage.approvalRequests.create({
    taskId,
    requestedAction: 'abort_task',
    riskLevel: 'HIGH',
    targetBranch: 'candidate/self-dev',
    targetCommit: 'none',
    targetDiffHash: 'none',
    changedFiles: [],
    triggeredRules: [],
    invalidIf: [],
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as Parameters<IStorage['approvalRequests']['create']>[0])
  storage.approvalRequests.updateStatus(approval.id, 'APPROVED')
  return approval.id
}

describe('one-time historical orphan reconciliation (CEO 2026-09-30)', () => {
  it('terminalizes exactly the two listed rows with their evidence, audits, and lets a 0-Job Task park', () => {
    const dbPath = databasePath()
    seed(dbPath, (db) => {
      seedProductionShape(db)
      insertTask(db, 'ca94', 'pending', true)
    })

    const storage = createSQLiteStorage(dbPath)
    expect(storage.jobs.findById(D5206)?.status).toBe('failed')
    expect(storage.jobs.findById(E8F04)?.status).toBe('failed')
    expect(storage.auditLog.findByEntity('job', D5206)).toEqual([
      expect.objectContaining({
        operation: 'historical_orphan_terminalized',
        detail: expect.stringContaining(`later_foreign_job_id=${LATER_71B9}`),
      }),
    ])
    expect(storage.auditLog.findByEntity('job', E8F04)).toEqual([
      expect.objectContaining({
        operation: 'historical_orphan_terminalized',
        detail: expect.stringContaining(`later_foreign_job_id=${LATER_8664}`),
      }),
    ])

    const approvalRequestId = approveAbort(storage, 'ca94')
    expect(abortTask(storage, { taskId: 'ca94', approvalRequestId, reason: 'park' }))
      .toMatchObject({ ok: true, status: 'parked' })
  })

  it('is idempotent across restarts', () => {
    const dbPath = databasePath()
    seed(dbPath, seedProductionShape)

    createSQLiteStorage(dbPath)
    const second = createSQLiteStorage(dbPath)
    expect(second.auditLog.findByEntity('job', D5206)).toHaveLength(1)
    expect(second.auditLog.findByEntity('job', E8F04)).toHaveLength(1)
  })

  it('does not touch an unlisted row of the same shape (not a general rule)', () => {
    const dbPath = databasePath()
    seed(dbPath, (db) => {
      seedProductionShape(db)
      insertTask(db, 'task-other', 'done')
      insertJob(db, { id: 'other-orphan', taskId: 'task-other', status: 'blocked' })
    })

    const storage = createSQLiteStorage(dbPath)
    expect(storage.jobs.findById('other-orphan')?.status).toBe('blocked')
  })

  it.each([
    ['the later Job belongs to the same Task', (db: Database.Database) => {
      db.prepare("UPDATE jobs SET task_id = 'task-76ea' WHERE id = ?").run(LATER_71B9)
    }],
    ['the later Job ran in a different workingDir', (db: Database.Database) => {
      db.prepare('UPDATE jobs SET safe_command = ? WHERE id = ?')
        .run(JSON.stringify({ kind: 'test', workingDir: '/elsewhere', params: {} }), LATER_71B9)
    }],
    ['the later Job started before the orphan finished', (db: Database.Database) => {
      db.prepare("UPDATE jobs SET started_at = '2026-09-14T14:49:00.000Z' WHERE id = ?").run(LATER_71B9)
    }],
    ['the later Job never started', (db: Database.Database) => {
      db.prepare('UPDATE jobs SET started_at = NULL WHERE id = ?').run(LATER_71B9)
    }],
    ['the later Job does not exist', (db: Database.Database) => {
      db.prepare('DELETE FROM jobs WHERE id = ?').run(LATER_71B9)
    }],
    ['the orphan Task is not done', (db: Database.Database) => {
      db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-76ea'").run()
    }],
    ['the orphan is quarantined', (db: Database.Database) => {
      db.prepare('UPDATE jobs SET failure_metadata = ? WHERE id = ?')
        .run(JSON.stringify({ quarantined: true }), D5206)
    }],
    ['the orphan metadata cannot be parsed', (db: Database.Database) => {
      db.prepare("UPDATE jobs SET failure_metadata = '{bad' WHERE id = ?").run(D5206)
    }],
    ['the orphan is bound to a missing approval row', (db: Database.Database) => {
      db.prepare("UPDATE jobs SET approval_id = 'approval-missing' WHERE id = ?").run(D5206)
    }],
  ])('fails closed when %s', (_label, mutate) => {
    const dbPath = databasePath()
    seed(dbPath, (db) => {
      seedProductionShape(db)
      mutate(db)
    })

    createSQLiteStorage(dbPath)
    const raw = new Database(dbPath, { readonly: true })
    try {
      const row = raw.prepare('SELECT status FROM jobs WHERE id = ?').get(D5206) as { status: string } | undefined
      if (row) expect(row.status).toBe('blocked')
      expect(raw.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity_id = ?").get(D5206)).toEqual({ c: 0 })
      // もう一方の行は自分の証拠で独立に判定される。
      expect((raw.prepare('SELECT status FROM jobs WHERE id = ?').get(E8F04) as { status: string }).status)
        .toBe('failed')
    } finally {
      raw.close()
    }
  })

  it('still fails closed on abort while an unrelated active foreign blocked Job exists', () => {
    const dbPath = databasePath()
    seed(dbPath, (db) => {
      seedProductionShape(db)
      insertTask(db, 'active', 'pending')
      insertJob(db, { id: 'active-blocked', taskId: 'active', status: 'blocked' })
      insertTask(db, 'ca94', 'pending', true)
    })

    const storage = createSQLiteStorage(dbPath)
    const approvalRequestId = approveAbort(storage, 'ca94')
    expect(abortTask(storage, { taskId: 'ca94', approvalRequestId, reason: 'park' }))
      .toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
  })
})
