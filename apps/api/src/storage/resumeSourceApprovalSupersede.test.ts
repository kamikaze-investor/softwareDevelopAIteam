import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApprovalGateStatus } from '@ai-team/shared'
import type { IStorage } from './interface'
import { CREATE_TABLES } from './schema'
import { createSQLiteStorage } from './sqlite'

/**
 * invariant: ApprovalRequest が紐づく Job が terminal になった時点で、その request は
 * actionable state（WAITING_FOR_USER / APPROVED）に残ってはならない。
 *
 * 2026-10-09〜14 production（Task b6d4097a）: 期限切れ承認を PL が毎日 resume し、
 * source の git_commit Job は failed へ終端化されたのに、紐づく request は
 * WAITING_FOR_USER のまま残り、同一 commit / diff の request が毎日1件ずつ積み上がった。
 */

const HOUR = 60 * 60 * 1000
const CREATED_AT = '2026-10-01T00:00:00.000Z'

function tempDbPath(): string {
  return path.join(os.tmpdir(), `resume-approval-supersede-${randomUUID()}.db`)
}

// ── completeResumeHandoff（resumeBlockedTask）──────────────────────────────

function seedBlockedGitCommit(
  storage: IStorage,
  approval: { status: ApprovalGateStatus; expiresInMs: number },
): { taskId: string; jobId: string; approvalId: string } {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'pending',
    assignee: 'developer_ai', dependencies: [],
  } as Parameters<IStorage['tasks']['create']>[0])
  const job = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' }, dryRun: false,
    workflowStepKey: 'review:some-review-job:git-commit',
  } as Parameters<IStorage['jobs']['create']>[0])
  const created = storage.approvalRequests.createForJob({
    taskId: task.id,
    requestedAction: 'git_commit',
    riskLevel: 'LOW',
    targetBranch: 'main',
    targetCommit: 'c0ffee',
    targetDiffHash: 'd1ff',
    changedFiles: ['src/a.ts'],
    triggeredRules: [],
    invalidIf: [],
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + approval.expiresInMs).toISOString(),
  } as Parameters<IStorage['approvalRequests']['create']>[0], job.id)
  if (!created.ok) throw new Error(`fixture createForJob failed: ${created.reason}`)
  if (approval.status !== 'WAITING_FOR_USER') {
    storage.approvalRequests.updateStatus(created.approvalRequest.id, approval.status)
  }
  return { taskId: task.id, jobId: job.id, approvalId: created.approvalRequest.id }
}

describe('resumeBlockedTask — 終端化した source の request を actionable に残さない', () => {
  it.each<ApprovalGateStatus>(['WAITING_FOR_USER', 'APPROVED'])(
    '%s の request は source の終端化と同時に SUPERSEDED になり、audit に記録される',
    (status) => {
      const storage = createSQLiteStorage(':memory:')
      const seeded = seedBlockedGitCommit(storage, { status, expiresInMs: -HOUR })

      const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume' })
      expect(resumed.ok).toBe(true)
      if (!resumed.ok) return

      expect(storage.jobs.findById(seeded.jobId)?.status).toBe('failed')
      expect(storage.approvalRequests.findById(seeded.approvalId)?.status).toBe('SUPERSEDED')
      // successor は approval を継承しない（新しい承認サイクルは /gate/check が始める）
      expect(resumed.job.approvalId).toBeUndefined()
      expect(storage.auditLog.findByEntity('job', seeded.jobId)).toEqual([
        expect.objectContaining({
          operation: 'resume_source_terminalized',
          detail: expect.stringContaining(`superseded_approval_id=${seeded.approvalId}`),
        }),
      ])
    },
  )

  it.each<ApprovalGateStatus>(['CONSUMED', 'STALE', 'EXPIRED'])(
    '%s の request は変えず、audit に superseded_approval_id を書かない',
    (status) => {
      const storage = createSQLiteStorage(':memory:')
      const seeded = seedBlockedGitCommit(storage, { status, expiresInMs: -HOUR })

      const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume' })
      expect(resumed.ok).toBe(true)

      expect(storage.jobs.findById(seeded.jobId)?.status).toBe('failed')
      expect(storage.approvalRequests.findById(seeded.approvalId)?.status).toBe(status)
      const [audit] = storage.auditLog.findByEntity('job', seeded.jobId)
      expect(audit?.detail).not.toContain('superseded_approval_id')
    },
  )

  it('REJECTED（CEO の却下の記録）は resume の結果に関係なく変えない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedGitCommit(storage, { status: 'REJECTED', expiresInMs: HOUR })

    storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume' })

    expect(storage.approvalRequests.findById(seeded.approvalId)?.status).toBe('REJECTED')
  })

  it('未期限の WAITING_FOR_USER では resume 自体を拒否し、Job も request も変えない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedGitCommit(storage, { status: 'WAITING_FOR_USER', expiresInMs: HOUR })

    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume' })

    expect(resumed.ok).toBe(false)
    expect(storage.jobs.findById(seeded.jobId)?.status).toBe('blocked')
    expect(storage.approvalRequests.findById(seeded.approvalId)?.status).toBe('WAITING_FOR_USER')
  })

  it('atomicity: 同じ transaction 内の後続が失敗したら、Job の終端化も request の supersede も戻る', () => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const seeded = seedBlockedGitCommit(storage, { status: 'WAITING_FOR_USER', expiresInMs: -HOUR })

    // 終端化の audit 書き込みだけを失敗させる（supersede はその直前に実行されている）
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TRIGGER fail_resume_audit BEFORE INSERT ON audit_log
      WHEN NEW.operation = 'resume_source_terminalized'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
    `)
    raw.close()

    expect(() => storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume' }))
      .toThrow(/forced audit failure/)

    expect(storage.jobs.findById(seeded.jobId)?.status).toBe('blocked')
    expect(storage.approvalRequests.findById(seeded.approvalId)?.status).toBe('WAITING_FOR_USER')
    expect(storage.jobs.findByTaskId(seeded.taskId)).toHaveLength(1)
  })
})

// ── startup reconciliation（reconcileResumedBlockedSourceJobs）──────────────

function seedRaw(dbPath: string, seed: (db: Database.Database) => void): void {
  const db = new Database(dbPath)
  try {
    db.exec(CREATE_TABLES)
    const insertProject = db.prepare(`
      INSERT INTO projects (id, name, goal, design_philosophy, status, created_at, updated_at)
      VALUES (?, ?, 'goal', '[]', ?, ?, ?)
    `)
    // running な Project は1つだけ（single-running-Project interlock）
    insertProject.run('project', 'Project', 'running', CREATED_AT, CREATED_AT)
    insertProject.run('project-2', 'Project 2', 'archived', CREATED_AT, CREATED_AT)
    seed(db)
  } finally {
    db.close()
  }
}

function insertTask(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, assignee, dependencies, roadmap_active, created_at, updated_at)
    VALUES (?, 'project', ?, '', 'blocked', 'developer_ai', '[]', 1, ?, ?)
  `).run(id, id, CREATED_AT, CREATED_AT)
}

function insertJob(
  db: Database.Database,
  input: {
    id: string
    taskId: string
    status: 'blocked' | 'failed' | 'success' | 'queued'
    kind?: string
    projectId?: string
    workflowStepKey?: string
    approvalId?: string
  },
): void {
  db.prepare(`
    INSERT INTO jobs (id, task_id, project_id, workflow_step_key, agent_role, status, safe_command, dry_run, changed_files, approval_id, created_at)
    VALUES (?, ?, ?, ?, 'developer_ai', ?, ?, 0, '[]', ?, ?)
  `).run(
    input.id,
    input.taskId,
    input.projectId ?? 'project',
    input.workflowStepKey ?? null,
    input.status,
    JSON.stringify({ kind: input.kind ?? 'git_commit', workingDir: '/workspace/target' }),
    input.approvalId ?? null,
    CREATED_AT,
  )
}

function insertApproval(db: Database.Database, id: string, taskId: string, status: ApprovalGateStatus): void {
  db.prepare(`
    INSERT INTO approval_requests (id, task_id, target_branch, target_commit, target_diff_hash, risk_level, requested_action, status, expires_at, created_at)
    VALUES (?, ?, 'main', 'c0ffee', 'd1ff', 'LOW', 'git_commit', ?, '2026-10-02T00:00:00.000Z', ?)
  `).run(id, taskId, status, CREATED_AT)
}

/** failed な source（approval 付き）と、その exact な resume 後継を1件置く。 */
function seedTerminalSource(
  db: Database.Database,
  name: string,
  approvalStatus: ApprovalGateStatus,
  successor: {
    taskId?: string
    projectId?: string
    kind?: string
    count?: number
    startGeneration?: number
  } | 'none' = {},
): void {
  insertTask(db, name)
  insertApproval(db, `approval-${name}`, name, approvalStatus)
  insertJob(db, {
    id: `source-${name}`,
    taskId: name,
    status: 'failed',
    approvalId: `approval-${name}`,
    workflowStepKey: `review:review-${name}:git-commit`,
  })
  if (successor === 'none') return
  const startGeneration = successor.startGeneration ?? 1
  const endGeneration = startGeneration + (successor.count ?? 1) - 1
  for (let n = startGeneration; n <= endGeneration; n += 1) {
    if (successor.taskId !== undefined && successor.taskId !== name) insertTask(db, successor.taskId)
    insertJob(db, {
      id: `successor-${name}-${n}`,
      taskId: successor.taskId ?? name,
      projectId: successor.projectId,
      kind: successor.kind,
      status: 'blocked',
      workflowStepKey: `resume:source-${name}:${n}`,
    })
  }
}

function approvalStatusOf(storage: IStorage, id: string): ApprovalGateStatus | undefined {
  return storage.approvalRequests.findById(id)?.status
}

describe('startup reconciliation — 終端化済み source に紐づいたまま残った request の回収', () => {
  it('exact な resume 後継がある failed source の WAITING / APPROVED を SUPERSEDED にし、audit を1回だけ残す（冪等）', () => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => {
      seedTerminalSource(db, 'waiting', 'WAITING_FOR_USER')
      seedTerminalSource(db, 'approved', 'APPROVED')
    })

    const first = createSQLiteStorage(dbPath)
    for (const name of ['waiting', 'approved']) {
      expect(approvalStatusOf(first, `approval-${name}`)).toBe('SUPERSEDED')
      expect(first.auditLog.findByEntity('approval_request', `approval-${name}`)).toEqual([
        expect.objectContaining({
          operation: 'supersede',
          detail: expect.stringContaining(`source_job_id=source-${name} successor_job_id=successor-${name}-1 mode=startup_reconciliation`),
        }),
      ])
    }

    const second = createSQLiteStorage(dbPath)
    for (const name of ['waiting', 'approved']) {
      expect(approvalStatusOf(second, `approval-${name}`)).toBe('SUPERSEDED')
      expect(second.auditLog.findByEntity('approval_request', `approval-${name}`)).toHaveLength(1)
    }
  })

  it('fixed generations reconcile only the exact predecessor (n=1 anchor, n>1 generation n-1)', () => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => {
      insertTask(db, 'exact-predecessor')
      insertJob(db, {
        id: 'anchor-exact', taskId: 'exact-predecessor', status: 'failed',
        workflowStepKey: 'review:review-exact:git-commit',
      })
      insertJob(db, {
        id: 'generation-exact-1', taskId: 'exact-predecessor', status: 'failed',
        workflowStepKey: 'resume:anchor-exact:1',
      })
      insertJob(db, {
        id: 'generation-exact-2', taskId: 'exact-predecessor', status: 'blocked',
        workflowStepKey: 'resume:anchor-exact:2',
      })
      insertJob(db, {
        id: 'generation-exact-3', taskId: 'exact-predecessor', status: 'queued',
        workflowStepKey: 'resume:anchor-exact:3',
      })

      insertTask(db, 'gap-predecessor')
      insertJob(db, {
        id: 'anchor-gap', taskId: 'gap-predecessor', status: 'failed',
        workflowStepKey: 'review:review-gap:git-commit',
      })
      insertJob(db, {
        id: 'generation-gap-1', taskId: 'gap-predecessor', status: 'blocked',
        workflowStepKey: 'resume:anchor-gap:1',
      })
      insertJob(db, {
        id: 'generation-gap-3', taskId: 'gap-predecessor', status: 'queued',
        workflowStepKey: 'resume:anchor-gap:3',
      })
    })

    const storage = createSQLiteStorage(dbPath)

    expect(storage.jobs.findById('generation-exact-2')?.status).toBe('failed')
    expect(storage.jobs.findById('generation-gap-1')?.status).toBe('blocked')
    expect(storage.jobs.findById('anchor-exact')?.workflowStepKey).toBe('review:review-exact:git-commit')
    expect(storage.jobs.findById('generation-exact-1')?.workflowStepKey).toBe('resume:anchor-exact:1')
    expect(storage.jobs.findById('generation-exact-2')?.workflowStepKey).toBe('resume:anchor-exact:2')
    expect(storage.jobs.findById('generation-exact-3')?.workflowStepKey).toBe('resume:anchor-exact:3')
  })

  it('legacy nested git_commit successors still terminalize and supersede their exact source', () => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => {
      insertTask(db, 'legacy-terminalize')
      insertJob(db, { id: 'legacy-origin-a', taskId: 'legacy-terminalize', status: 'failed' })
      insertJob(db, {
        id: 'legacy-source-a', taskId: 'legacy-terminalize', status: 'blocked',
        workflowStepKey: 'resume:legacy-origin-a:1',
      })
      insertJob(db, {
        id: 'legacy-successor-a', taskId: 'legacy-terminalize', status: 'queued',
        workflowStepKey: 'resume:legacy-source-a:1',
      })

      insertTask(db, 'legacy-supersede')
      insertApproval(db, 'legacy-approval-b', 'legacy-supersede', 'WAITING_FOR_USER')
      insertJob(db, { id: 'legacy-origin-b', taskId: 'legacy-supersede', status: 'failed' })
      insertJob(db, {
        id: 'legacy-source-b', taskId: 'legacy-supersede', status: 'failed',
        approvalId: 'legacy-approval-b', workflowStepKey: 'resume:legacy-origin-b:1',
      })
      insertJob(db, {
        id: 'legacy-successor-b', taskId: 'legacy-supersede', status: 'queued',
        workflowStepKey: 'resume:legacy-source-b:1',
      })
    })

    const storage = createSQLiteStorage(dbPath)

    expect(storage.jobs.findById('legacy-source-a')?.status).toBe('failed')
    expect(storage.auditLog.findByEntity('job', 'legacy-source-a')).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining('successor_job_id=legacy-successor-a'),
      }),
    ])
    expect(approvalStatusOf(storage, 'legacy-approval-b')).toBe('SUPERSEDED')
    expect(storage.auditLog.findByEntity('approval_request', 'legacy-approval-b')).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining(
          'source_job_id=legacy-source-b successor_job_id=legacy-successor-b',
        ),
      }),
    ])
  })

  it('generation 3 supersedes only generation 2 approval after exact predecessor reconciliation', () => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => {
      insertTask(db, 'approval-generation-3')
      insertApproval(db, 'approval-generation-2', 'approval-generation-3', 'WAITING_FOR_USER')
      insertJob(db, {
        id: 'anchor-approval', taskId: 'approval-generation-3', status: 'failed',
        workflowStepKey: 'review:review-approval:git-commit',
      })
      insertJob(db, {
        id: 'approval-generation-1', taskId: 'approval-generation-3', status: 'failed',
        workflowStepKey: 'resume:anchor-approval:1',
      })
      insertJob(db, {
        id: 'approval-generation-2-job', taskId: 'approval-generation-3', status: 'failed',
        approvalId: 'approval-generation-2', workflowStepKey: 'resume:anchor-approval:2',
      })
      insertJob(db, {
        id: 'approval-generation-3-job', taskId: 'approval-generation-3', status: 'queued',
        workflowStepKey: 'resume:anchor-approval:3',
      })
    })

    const storage = createSQLiteStorage(dbPath)

    expect(approvalStatusOf(storage, 'approval-generation-2')).toBe('SUPERSEDED')
    expect(storage.auditLog.findByEntity('approval_request', 'approval-generation-2')).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining(
          'source_job_id=approval-generation-2-job successor_job_id=approval-generation-3-job',
        ),
      }),
    ])
  })

  it.each<ApprovalGateStatus>(['REJECTED', 'CONSUMED', 'STALE', 'EXPIRED'])('%s は変えない', (status) => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => seedTerminalSource(db, 'kept', status))

    const storage = createSQLiteStorage(dbPath)

    expect(approvalStatusOf(storage, 'approval-kept')).toBe(status)
    expect(storage.auditLog.findByEntity('approval_request', 'approval-kept')).toHaveLength(0)
  })

  it('lineage を exact に証明できない行は触らない（後継なし / 別 Task / 別 Project / 別 kind / generation gap）', () => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => {
      seedTerminalSource(db, 'no-successor', 'WAITING_FOR_USER', 'none')
      seedTerminalSource(db, 'other-task', 'WAITING_FOR_USER', { taskId: 'foreign-task' })
      seedTerminalSource(db, 'other-project', 'WAITING_FOR_USER', { projectId: 'project-2' })
      seedTerminalSource(db, 'other-kind', 'WAITING_FOR_USER', { kind: 'test' })
      seedTerminalSource(db, 'gap', 'WAITING_FOR_USER', { startGeneration: 2 })
    })

    const storage = createSQLiteStorage(dbPath)

    for (const name of ['no-successor', 'other-task', 'other-project', 'other-kind', 'gap']) {
      expect(approvalStatusOf(storage, `approval-${name}`), name).toBe('WAITING_FOR_USER')
      expect(storage.auditLog.findByEntity('approval_request', `approval-${name}`), name).toHaveLength(0)
    }
  })

  it('terminal でない source（blocked）に紐づく request は、この補正では触らない', () => {
    const dbPath = tempDbPath()
    seedRaw(dbPath, (db) => {
      insertTask(db, 'live')
      insertApproval(db, 'approval-live', 'live', 'WAITING_FOR_USER')
      insertJob(db, { id: 'source-live', taskId: 'live', status: 'blocked', approvalId: 'approval-live' })
      insertJob(db, { id: 'successor-live', taskId: 'live', status: 'queued', workflowStepKey: 'resume:source-live:1' })
    })

    const storage = createSQLiteStorage(dbPath)

    // 既存の第1段は WAITING に紐づく blocked source を終端化しない（変わらない挙動）
    expect(storage.jobs.findById('source-live')?.status).toBe('blocked')
    expect(approvalStatusOf(storage, 'approval-live')).toBe('WAITING_FOR_USER')
  })
})
