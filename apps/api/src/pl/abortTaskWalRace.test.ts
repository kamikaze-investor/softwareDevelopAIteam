import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JobWorkspaceBaseline } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import { recordApprovalActor } from '../designReview/resumeActor'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import { completeAbortCleanup, requestTechnicalAbort } from './abortTask'

/**
 * Technical Abort の最終 transaction と、別 connection の人の操作が同じ WAL file DB で競合するとき
 * （Codex review 527668d）。pending Task + blocked carrier（`releaseBlockedJobAndParkTask()`）の経路。
 *
 * - 人の write が先に lock を持っていれば、最終 transaction は BEGIN IMMEDIATE で待ち、取れなければ
 *   STORAGE_BUSY（再試行可能）で何も変えずに戻る。carrier を quarantine せず、generation も残す。
 *   人の write が commit された後の再試行は HUMAN_DECISION_CONFLICT で generation を取り消す。
 * - Technical Abort が先に commit すれば、後から来る人の write は park 後の状態の上に一貫して載る。
 */

const BASELINE: JobWorkspaceBaseline = { mode: 'clean', startCommitHash: '0805249b' }
const FUTURE = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const TECHNICAL_LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=technical-item state=planned -->',
  '1. [ ] **Technical item**',
  '   Protected runtime work.',
  '',
].join('\n')
const KNOWN_GOOD = {
  gitOperationMarkers: [] as string[],
  worktreeClean: true,
  indexClean: true,
  headValid: true,
  blindSpotsAbsent: true,
}

function tempDbPath(): string {
  return path.join(os.tmpdir(), `abort-wal-race-${randomUUID()}.db`)
}

const DIRTY: JobWorkspaceBaseline = {
  mode: 'dirty',
  startCommitHash: BASELINE.startCommitHash,
  entries: [{ path: 'apps/worker/src/index.ts', kind: 'modified', xyStatus: '.M', worktreeHash: 'sha256:task-owned' }],
}

function seedPendingTechnicalAbort(
  storage: IStorage,
  options: { dirty?: boolean } = {},
): { taskId: string; carrierId: string } {
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'technical item',
    description: 'protected runtime work',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    roadmapTaskKey: 'technical-item',
    allowedPaths: ['apps/worker/src/index.ts'],
    acceptanceCriteria: ['done'],
  } as Parameters<IStorage['tasks']['create']>[0])
  const end = options.dirty === true ? DIRTY : BASELINE
  storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    workspaceBaseline: BASELINE,
    failureMetadata: { workspaceEndFingerprint: end },
  } as Parameters<IStorage['jobs']['create']>[0])
  const carrier = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    workspaceBaseline: end,
    ...(options.dirty === true ? { changedFiles: ['apps/worker/src/index.ts'] } : {}),
    failureMetadata: { workspaceEndFingerprint: end },
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.jobs.update(carrier.id, {
    guardResult: {
      permissionAllowed: true,
      fileChangeAllowed: false,
      fileViolations: ['apps/worker/src/index.ts'],
    },
  } as Parameters<IStorage['jobs']['update']>[1])

  const attention = buildSystemState(storage).attention.find((item) => item.taskId === task.id)
  if (attention === undefined) throw new Error('technical attention missing')
  const requested = requestTechnicalAbort(storage, {
    taskId: task.id,
    attention,
    readLedger: () => TECHNICAL_LEDGER,
  })
  if (!requested.ok || requested.status !== 'cleanup_requested') {
    throw new Error(`technical cleanup not requested: ${JSON.stringify(requested)}`)
  }
  return { taskId: task.id, carrierId: carrier.id }
}

/** Worker と同じく、報告する時点の carrier の marker から cleanup generation を名指す。 */
function generationOf(storage: IStorage, carrierId: string) {
  const metadata = storage.jobs.findById(carrierId)?.failureMetadata
  return {
    abortCleanupRequestedAt: metadata?.abortCleanupRequestedAt ?? '',
    abortTechnicalEvidenceId: metadata?.abortTechnicalEvidenceId ?? '',
    abortTechnicalStateFingerprint: metadata?.abortTechnicalStateFingerprint ?? '',
  }
}

function finish(storage: IStorage, carrierId: string): ReturnType<typeof completeAbortCleanup> {
  return completeAbortCleanup(storage, {
    jobId: carrierId,
    cleanupGeneration: generationOf(storage, carrierId),
    preCleanupObservation: BASELINE,
    observation: BASELINE,
    knownGood: KNOWN_GOOD,
    cleanupSummary: { changedPathCount: 0, restoredPathCount: 0, removedPathCount: 0 },
  })
}

/**
 * dirty cleanup の Worker 報告。Worker は revert 済みなので post は clean。STORAGE_BUSY の後は
 * **同じ値**（pre = 永続化済みの dirty fingerprint、post = clean、summary）をそのまま再送する。
 */
const DIRTY_REPORT = {
  preCleanupObservation: DIRTY,
  observation: BASELINE,
  knownGood: KNOWN_GOOD,
  cleanupSummary: { changedPathCount: 1, restoredPathCount: 1, removedPathCount: 0 },
}

function finishDirty(
  storage: IStorage,
  carrierId: string,
  generation: ReturnType<typeof generationOf>,
): ReturnType<typeof completeAbortCleanup> {
  return completeAbortCleanup(storage, { jobId: carrierId, ...DIRTY_REPORT, cleanupGeneration: generation })
}

function holdWriteLock(dbPath: string, write: (db: Database.Database) => void): Database.Database {
  const other = new Database(dbPath)
  other.exec('BEGIN IMMEDIATE')
  write(other)
  return other
}

describe('Technical Abort finalization vs. a concurrent human write on another connection (WAL)', () => {
  it('human write holds the lock: STORAGE_BUSY without quarantine, then the retry cancels the generation', () => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const { taskId, carrierId } = seedPendingTechnicalAbort(storage)
    const metadataBefore = storage.jobs.findById(carrierId)?.failureMetadata

    // 別 connection（人の承認を書く API の別 process 相当）が write lock を取って承認を作っている途中。
    const other = new Database(dbPath)
    other.exec('BEGIN IMMEDIATE')
    const approvalId = `approval-${randomUUID()}`
    other.prepare(`
      INSERT INTO approval_requests
        (id, task_id, target_branch, target_commit, target_diff_hash, risk_level, requested_action,
         status, expires_at, invalid_if, changed_files, triggered_rules, created_at)
      VALUES (?, ?, 'b', 'c', 'd', 'HIGH', 'repair_from_stored_review:r', 'WAITING_FOR_USER', ?, '[]', '[]', '[]', ?)
    `).run(approvalId, taskId, FUTURE(), new Date().toISOString())

    // BEGIN IMMEDIATE は busy timeout の間待ってから SQLITE_BUSY で諦める。何も変えていない。
    expect(finish(storage, carrierId)).toMatchObject({ ok: false, code: 'STORAGE_BUSY' })
    const carrierWhileBusy = storage.jobs.findById(carrierId)
    expect(carrierWhileBusy?.status).toBe('blocked')
    expect(carrierWhileBusy?.failureMetadata).toEqual(metadataBefore)
    expect(carrierWhileBusy?.failureMetadata?.quarantined).toBeUndefined()

    other.exec('COMMIT')
    other.close()

    // 人の判断が commit された後の再試行は、その判断を上書きしない。
    expect(finish(storage, carrierId)).toMatchObject({ ok: false, code: 'HUMAN_DECISION_CONFLICT' })
    const carrierAfter = storage.jobs.findById(carrierId)
    expect(carrierAfter?.status).toBe('blocked')
    expect(carrierAfter?.failureMetadata?.quarantined).toBeUndefined()
    expect(carrierAfter?.failureMetadata?.abortCleanupRequestedAt).toBeUndefined()
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
    expect(storage.approvalRequests.findById(approvalId)?.status).toBe('WAITING_FOR_USER')
    expect(finish(storage, carrierId)).toMatchObject({ ok: false, code: 'NOT_REQUESTED' })
  }, 30_000)

  it('Technical Abort commits first: the later human write on another connection lands consistently', () => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const { taskId, carrierId } = seedPendingTechnicalAbort(storage)

    expect(finish(storage, carrierId)).toMatchObject({ ok: true })

    const second = createSQLiteStorage(dbPath)
    expect(second.tasks.findById(taskId)?.roadmapActive).toBe(false)
    expect(second.jobs.findById(carrierId)?.status).toBe('failed')
    const created = second.approvalRequests.replaceActiveAndCreate({
      taskId, targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd', riskLevel: 'HIGH',
      requestedAction: 'repair_from_stored_review:r', status: 'WAITING_FOR_USER', expiresAt: FUTURE(),
      invalidIf: [], changedFiles: [], triggeredRules: [],
    } as Parameters<IStorage['approvalRequests']['replaceActiveAndCreate']>[0])

    // 先の park は人の request を STALE にしておらず（まだ無かった）、後の request は park 後に1件だけ載る。
    expect(created.supersededIds).toEqual([])
    expect(storage.approvalRequests.findById(created.approvalRequest.id)?.status).toBe('WAITING_FOR_USER')
    expect(storage.jobs.findById(carrierId)?.failureMetadata?.quarantined).toBeUndefined()
    expect(storage.auditLog.findByEntity('task', taskId).filter(
      (entry) => entry.operation === 'task_aborted' && entry.result === 'success',
    )).toHaveLength(1)
  })
})

describe('dirty Technical Abort cleanup: STORAGE_BUSY, then the identical report is resubmitted (WAL)', () => {
  it('an unrelated write held the lock: the identical dirty report succeeds on resubmission', () => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const { taskId, carrierId } = seedPendingTechnicalAbort(storage, { dirty: true })
    // Worker は最初の報告の generation を証拠と一緒に保持し、再送でもそのまま名指す。
    const generation = generationOf(storage, carrierId)
    const metadataBefore = storage.jobs.findById(carrierId)?.failureMetadata

    const other = holdWriteLock(dbPath, (db) => {
      db.prepare(
        "INSERT INTO audit_log (id, actor, operation, entity_type, entity_id, result, detail, created_at) "
        + "VALUES (?, 'api', 'unrelated', 'project', 'p', 'success', '', ?)",
      ).run(randomUUID(), new Date().toISOString())
    })
    expect(finishDirty(storage, carrierId, generation)).toMatchObject({ ok: false, code: 'STORAGE_BUSY' })
    // 何も変えていない: 永続化済みの dirty fingerprint と cleanup generation はそのまま。
    expect(storage.jobs.findById(carrierId)?.failureMetadata).toEqual(metadataBefore)
    other.exec('COMMIT')
    other.close()

    // Worker は観測し直さず、同じ証拠を再送する。
    expect(finishDirty(storage, carrierId, generation)).toMatchObject({ ok: true })
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(false)
    expect(storage.jobs.findById(carrierId)?.failureMetadata?.quarantined).toBeUndefined()
  }, 30_000)

  it('a human approval held the lock: the identical resubmission yields to it without quarantine', () => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const { taskId, carrierId } = seedPendingTechnicalAbort(storage, { dirty: true })
    // Worker は最初の報告の generation を証拠と一緒に保持し、再送でもそのまま名指す。
    const generation = generationOf(storage, carrierId)

    const approvalId = `approval-${randomUUID()}`
    const other = holdWriteLock(dbPath, (db) => {
      db.prepare(`
        INSERT INTO approval_requests
          (id, task_id, target_branch, target_commit, target_diff_hash, risk_level, requested_action,
           status, expires_at, invalid_if, changed_files, triggered_rules, created_at)
        VALUES (?, ?, 'b', 'c', 'd', 'HIGH', 'repair_from_stored_review:r', 'WAITING_FOR_USER', ?, '[]', '[]', '[]', ?)
      `).run(approvalId, taskId, FUTURE(), new Date().toISOString())
    })
    expect(finishDirty(storage, carrierId, generation)).toMatchObject({ ok: false, code: 'STORAGE_BUSY' })
    other.exec('COMMIT')
    other.close()

    expect(finishDirty(storage, carrierId, generation)).toMatchObject({ ok: false, code: 'HUMAN_DECISION_CONFLICT' })
    const carrier = storage.jobs.findById(carrierId)
    expect(carrier?.failureMetadata?.quarantined).toBeUndefined()
    expect(carrier?.failureMetadata?.abortCleanupRequestedAt).toBeUndefined()
    expect(carrier?.failureMetadata?.workspaceEndFingerprint).toEqual(DIRTY)
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
    expect(storage.approvalRequests.findById(approvalId)?.status).toBe('WAITING_FOR_USER')
  }, 30_000)
})

// T-1: 最終 transaction は CONSUMED 行の作成時刻を cleanup 要求時刻と Date.parse した値で比べる。
// 行の時刻は別 connection で書き換える（storage は常に Z 形式で書くので、ここでしか作れない形）。
describe('Technical Abort final transaction: human CONSUMED times are compared numerically and fail closed', () => {
  function consumedHumanRow(storage: IStorage, taskId: string): string {
    const id = storage.approvalRequests.create({
      taskId, requestedAction: 'repair_from_stored_review:r', riskLevel: 'HIGH',
      targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
      changedFiles: [], triggeredRules: [], invalidIf: [],
      status: 'APPROVED', expiresAt: FUTURE(),
    } as Parameters<IStorage['approvalRequests']['create']>[0]).id
    recordApprovalActor(storage, id, 'admin')
    storage.approvalRequests.updateStatus(id, 'CONSUMED', undefined, true)
    return id
  }

  function setCreatedAt(dbPath: string, id: string, createdAt: string): void {
    const other = new Database(dbPath)
    other.prepare('UPDATE approval_requests SET created_at = ? WHERE id = ?').run(createdAt, id)
    other.close()
  }

  it.each([
    ['a later instant written with a -05:00 offset (sorts before the Z cleanup time as text)', (requestedAt: string) =>
      new Date(Date.parse(requestedAt) + 60_000 - 5 * 60 * 60 * 1000).toISOString().replace('Z', '-05:00')],
    ['an empty created_at', () => ''],
    ['an unreadable created_at', () => 'not-a-time'],
  ])('%s → HUMAN_DECISION_CONFLICT, nothing parked', (_label, createdAtFor) => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const { taskId, carrierId } = seedPendingTechnicalAbort(storage)
    const requestedAt = storage.jobs.findById(carrierId)!.failureMetadata!.abortCleanupRequestedAt!
    const id = consumedHumanRow(storage, taskId)
    setCreatedAt(dbPath, id, createdAtFor(requestedAt))

    expect(finish(storage, carrierId)).toMatchObject({ ok: false, code: 'HUMAN_DECISION_CONFLICT' })
    expect(storage.tasks.findById(taskId)?.roadmapActive).toBe(true)
    expect(storage.jobs.findById(carrierId)?.failureMetadata?.quarantined).toBeUndefined()
  }, 30_000)

  it('an earlier instant written with a +09:00 offset (sorts after as text) does not block', () => {
    const dbPath = tempDbPath()
    const storage = createSQLiteStorage(dbPath)
    const { taskId, carrierId } = seedPendingTechnicalAbort(storage)
    const requestedAt = storage.jobs.findById(carrierId)!.failureMetadata!.abortCleanupRequestedAt!
    const id = consumedHumanRow(storage, taskId)
    setCreatedAt(dbPath, id, new Date(Date.parse(requestedAt) - 60_000 + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00'))

    expect(finish(storage, carrierId)).toMatchObject({ ok: true })
  }, 30_000)
})
