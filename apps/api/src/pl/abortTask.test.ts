import { describe, expect, it, vi } from 'vitest'
import { occupiesProject, type JobWorkspaceBaseline } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import { recoverBlockedTask } from '../humanRecovery/recoverBlockedTask'
import { abortTask, completeAbortCleanup, requestTechnicalAbort } from './abortTask'
import { classifyAdoptionCandidates, readAdoptionCandidates } from './adoptionStep'
import {
  isEligibleTechnicalAbortDiagnosis,
  recordTechnicalAbortRefusal,
  technicalAbortStateFingerprint,
} from './technicalAbortEvidence'
import type { BlockedDiagnosis, BlockedRootCauseClass } from './blockedTriage'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const BASELINE: JobWorkspaceBaseline = { mode: 'clean', startCommitHash: '0805249b' }
const TECHNICAL_LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=technical-item state=planned -->',
  '1. [ ] **Technical item**',
  '   Protected runtime work.',
  '',
].join('\n')

/** 進行中の git 操作も観測できない変更も無い、という Worker からの報告。 */
const KNOWN_GOOD = {
  gitOperationMarkers: [] as string[],
  worktreeClean: true,
  indexClean: true,
  headValid: true,
  blindSpotsAbsent: true,
}

interface Fixture {
  storage: IStorage
  projectId: string
  taskId: string
  jobId: string
}

/** production の `6f8b41ef` と同じ形: roadmapActive な pending Task + blocked Job 1本。 */
function seed(
  safeCommand: Parameters<IStorage['jobs']['create']>[0]['safeCommand'] = {
    kind: 'test', workingDir: '/workspace/target',
  },
): Fixture {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'stuck one', description: 'd', status: 'pending',
    assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    roadmapTaskKey: 'some-item', allowedPaths: ['apps/api/src/pl'], acceptanceCriteria: ['x'],
  } as Parameters<IStorage['tasks']['create']>[0])
  const job = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand, dryRun: false,
    workspaceBaseline: BASELINE,
  } as Parameters<IStorage['jobs']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id, jobId: job.id }
}

function seedTechnicalAbort(options: { dependency?: boolean } = {}): Fixture & { latestJobId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const dependency = options.dependency === true
    ? storage.tasks.create({
        projectId: project.id, title: 'dependency', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: false,
      } as Parameters<IStorage['tasks']['create']>[0])
    : undefined
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'technical item',
    description: 'protected runtime work',
    status: 'blocked',
    assignee: 'developer_ai',
    dependencies: dependency === undefined ? [] : [dependency.id],
    roadmapActive: true,
    roadmapTaskKey: 'technical-item',
    allowedPaths: ['apps/worker/src/index.ts'],
    acceptanceCriteria: ['done'],
  } as Parameters<IStorage['tasks']['create']>[0])
  storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    workspaceBaseline: BASELINE,
    failureMetadata: { workspaceEndFingerprint: BASELINE },
  } as Parameters<IStorage['jobs']['create']>[0])
  const latest = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'failed',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    workspaceBaseline: BASELINE,
    failureMetadata: { workspaceEndFingerprint: BASELINE },
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.jobs.update(latest.id, {
    guardResult: {
      permissionAllowed: true,
      fileChangeAllowed: false,
      fileViolations: ['apps/worker/src/index.ts'],
    },
  } as Parameters<IStorage['jobs']['update']>[1])
  return { storage, projectId: project.id, taskId: task.id, jobId: latest.id, latestJobId: latest.id }
}

function requestTechnical(fx: ReturnType<typeof seedTechnicalAbort>): void {
  const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
  if (attention === undefined) throw new Error('technical attention missing')
  const requested = requestTechnicalAbort(fx.storage, {
    taskId: fx.taskId,
    attention,
    readLedger: () => TECHNICAL_LEDGER,
  })
  if (!requested.ok || requested.status !== 'cleanup_requested') {
    throw new Error(`technical cleanup not requested: ${JSON.stringify(requested)}`)
  }
}

function finishTechnical(
  fx: ReturnType<typeof seedTechnicalAbort>,
  input: Partial<Parameters<typeof completeAbortCleanup>[1]> = {},
): ReturnType<typeof completeAbortCleanup> {
  return completeAbortCleanup(fx.storage, {
    jobId: fx.latestJobId,
    preCleanupObservation: BASELINE,
    observation: BASELINE,
    knownGood: KNOWN_GOOD,
    cleanupSummary: { changedPathCount: 0, restoredPathCount: 0, removedPathCount: 0 },
    ...input,
  })
}

interface TerminalBlockedFixture extends Fixture {
  latestJobId: string
}

/** blocked Task + terminal Jobs only。findByTaskId()[0] は後から作った success Job。 */
function seedTerminalBlocked(): TerminalBlockedFixture {
  const fx = seed()
  fx.storage.tasks.update(fx.taskId, { status: 'blocked' })
  fx.storage.jobs.update(fx.jobId, { status: 'failed' })
  const latest = fx.storage.jobs.create({
    taskId: fx.taskId,
    projectId: fx.projectId,
    agentRole: 'developer_ai',
    status: 'success',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    dryRun: false,
    workspaceBaseline: BASELINE,
  } as Parameters<IStorage['jobs']['create']>[0])
  return { ...fx, latestJobId: latest.id }
}

/** resumeBlockedTask() がそのまま後継 Job を作れる terminal-blocked 形。 */
function seedResumableTerminalBlocked(): Fixture {
  const fx = seed({ kind: 'git_commit', workingDir: '/workspace/target' })
  fx.storage.tasks.update(fx.taskId, { status: 'blocked' })
  fx.storage.jobs.update(fx.jobId, { status: 'failed' })
  return fx
}

function approve(storage: IStorage, taskId: string, action = 'abort_task'): string {
  const request = storage.approvalRequests.create({
    taskId, requestedAction: action, riskLevel: 'HIGH',
    targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
    status: 'WAITING_FOR_USER', expiresAt: FUTURE,
  } as Parameters<IStorage['approvalRequests']['create']>[0])
  storage.approvalRequests.updateStatus(request.id, 'APPROVED')
  return request.id
}

function approvedRequest(
  storage: IStorage,
  taskId: string,
  options: { action?: string; expiresAt?: string } = {},
): string {
  const request = storage.approvalRequests.create({
    taskId,
    requestedAction: options.action ?? 'abort_task',
    riskLevel: 'HIGH',
    targetBranch: 'ai/park',
    targetCommit: 'c',
    targetDiffHash: 'd',
    changedFiles: [],
    triggeredRules: [],
    invalidIf: ['commit changes'],
    status: 'APPROVED',
    expiresAt: options.expiresAt ?? FUTURE,
  } as Parameters<IStorage['approvalRequests']['create']>[0])
  return request.id
}

function requestTerminalBlocked(fx: TerminalBlockedFixture): string {
  const approvalRequestId = approve(fx.storage, fx.taskId)
  const requested = abortTask(fx.storage, {
    taskId: fx.taskId,
    approvalRequestId,
    reason: 'terminal blocked task is obsolete',
  })
  if (!requested.ok || requested.status !== 'cleanup_requested') {
    throw new Error(`expected cleanup_requested, got ${JSON.stringify(requested)}`)
  }
  return approvalRequestId
}

function markTerminalCleanup(
  fx: TerminalBlockedFixture,
  approvalRequestId: string,
): void {
  const job = fx.storage.jobs.findById(fx.latestJobId)
  if (!job) throw new Error('latest job missing')
  fx.storage.jobs.update(job.id, {
    failureMetadata: {
      ...(job.failureMetadata ?? {}),
      abortCleanupRequestedAt: new Date().toISOString(),
      abortApprovalRequestId: approvalRequestId,
      abortReason: 'terminal blocked task is obsolete',
    },
  })
}

/** 段階操作をまとめて通す（正常系のヘルパー）。 */
function parkFully(fx: Fixture): void {
  const requested = abortTask(fx.storage, {
    taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: '別の項目を先に進める',
  })
  if (!requested.ok || requested.status !== 'cleanup_requested') throw new Error('expected cleanup_requested')
  const done = completeAbortCleanup(fx.storage, {
    jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
  })
  if (!done.ok) throw new Error(`cleanup failed: ${done.reason}`)
}

describe('abortTask — 段階1: 前提条件と承認', () => {
  it('所有権を保持する Job があるので、まず cleanup を要求する（この時点では park しない）', () => {
    const fx = seed()

    const result = abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(result).toMatchObject({ ok: true, status: 'cleanup_requested', jobIds: [fx.jobId] })
    // **まだ park していない。** 所有権が解放されるまで Task は現役のまま。
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  it('承認が無ければ何も要求しない', () => {
    const fx = seed()

    const result = abortTask(fx.storage, { taskId: fx.taskId, approvalRequestId: 'nope', reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
    expect(fx.storage.jobs.findById(fx.jobId)?.failureMetadata?.abortCleanupRequestedAt).toBeUndefined()
  })

  it('承認が WAITING のままなら何も要求しない', () => {
    const fx = seed()
    const request = fx.storage.approvalRequests.create({
      taskId: fx.taskId, requestedAction: 'abort', riskLevel: 'HIGH',
      targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
      changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
      status: 'WAITING_FOR_USER', expiresAt: FUTURE,
    } as Parameters<IStorage['approvalRequests']['create']>[0])

    expect(abortTask(fx.storage, { taskId: fx.taskId, approvalRequestId: request.id, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
  })

  it('別 action の承認は流用できない（approval は task 単位で出るため action 束縛が要る）', () => {
    const fx = seed()

    expect(abortTask(fx.storage, {
      taskId: fx.taskId,
      approvalRequestId: approve(fx.storage, fx.taskId, 'git_commit'),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
    expect(fx.storage.jobs.findById(fx.jobId)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()
  })

  it('別 Task の承認は流用できない', () => {
    const fx = seed()
    const other = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'other', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])

    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, other.id), reason: 'r',
    })).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
  })

  it('live Job があれば fail-closed で拒否する', () => {
    const fx = seed()
    fx.storage.jobs.create({
      taskId: fx.taskId, projectId: fx.projectId, agentRole: 'developer_ai', status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'LIVE_JOB_PRESENT' })
  })

  it('quarantine 中の Job があれば拒否する（既存の解除経路が先）', () => {
    const fx = seed()
    fx.storage.jobs.update(fx.jobId, { failureMetadata: { quarantined: true } })

    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'JOB_QUARANTINED' })
  })

  it('done / pending 以外 / 既に park 済みは拒否する', () => {
    const done = seed()
    done.storage.tasks.update(done.taskId, { status: 'done' })
    expect(abortTask(done.storage, {
      taskId: done.taskId, approvalRequestId: approve(done.storage, done.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_ALREADY_DONE' })

    const blocked = seed()
    blocked.storage.tasks.update(blocked.taskId, { status: 'blocked' })
    expect(abortTask(blocked.storage, {
      taskId: blocked.taskId, approvalRequestId: approve(blocked.storage, blocked.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_NOT_PARKABLE' })

    const parked = seed()
    parked.storage.tasks.update(parked.taskId, { roadmapActive: false })
    expect(abortTask(parked.storage, {
      taskId: parked.taskId, approvalRequestId: approve(parked.storage, parked.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_NOT_ACTIVE' })
  })

  it('解放すべき Job が無ければその場で park する', () => {
    const fx = seed()
    fx.storage.jobs.update(fx.jobId, { status: 'failed' })

    const result = abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(result).toMatchObject({ ok: true, status: 'parked' })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(false)
    expect(fx.storage.tasks.findById(fx.taskId)?.status).toBe('pending')
  })
})

describe('abortTask — 段階2: 観測の再検証と所有権解放', () => {
  it('観測が baseline と一致すれば解放して park する。status は変えず Job 履歴も残す', () => {
    const fx = seed()

    parkFully(fx)

    const task = fx.storage.tasks.findById(fx.taskId)
    // **done にしない。**
    expect(task?.status).toBe('pending')
    expect(task?.roadmapActive).toBe(false)
    // Job は消えず、terminal になって所有権を手放す。
    expect(fx.storage.jobs.findById(fx.jobId)?.status).toBe('failed')
    expect(fx.storage.jobs.findByTaskId(fx.taskId)).toHaveLength(1)
  })

  it('観測が baseline と食い違えば park しない（fail-closed）', () => {
    const fx = seed()
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    const result = completeAbortCleanup(fx.storage, {
      jobId: fx.jobId,
      observation: { mode: 'clean', startCommitHash: 'deadbeef' },
      knownGood: KNOWN_GOOD,
    })

    expect(result).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    // Job は blocked のまま所有権を保持し、Task も現役のまま。
    expect(fx.storage.jobs.findById(fx.jobId)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  it('要求されていない Job の所有権は解放できない', () => {
    const fx = seed()

    const result = completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })

    expect(result).toMatchObject({ ok: false, code: 'NOT_REQUESTED' })
    expect(fx.storage.jobs.findById(fx.jobId)?.status).toBe('blocked')
  })

  it('park と audit は同時に成立する', () => {
    const fx = seed()

    parkFully(fx)

    const entries = fx.storage.auditLog.findByEntity('task', fx.taskId)
      .filter((entry) => entry.operation === 'task_aborted')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.detail).toContain('別の項目を先に進める')
    expect(entries[0]?.detail).toContain('status kept as pending')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(false)
  })

  it('follow-up Task を作らない（残作業の再開は #233 の責務）', () => {
    const fx = seed()

    parkFully(fx)

    expect(fx.storage.tasks.findByProjectId(fx.projectId)).toHaveLength(1)
  })
})

describe('abortTask — 承認と対象の束縛', () => {
  it('他 Task が blocked Job で workspace を所有していれば park しない（fail-closed）', () => {
    const fx = seed()
    // 対象 Task 側には解放すべき Job が無い状態にして、他 Task の所有だけを残す。
    fx.storage.jobs.update(fx.jobId, { status: 'failed' })
    const other = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'owner', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: other.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
      workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
  })

  // 2026-09-17 の production Operational E2E で実測: AIteamOS project には done な Task に
  // 紐づく古い blocked 行が4本残っており、それらを所有者と数えたせいで abort が丸ごと通らなかった。
  // 既存 `findWorkspaceOwningTaskId()` はこれらを所有者と見なしていない。
  it('done な Task に残る古い blocked Job は所有者として数えない', () => {
    const fx = seed()
    const finished = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'finished long ago', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    const staleJob = fx.storage.jobs.create({
      taskId: finished.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
      workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])

    // 対象 Task 側は通常どおり cleanup 要求へ進める。
    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: true, status: 'cleanup_requested', jobIds: [fx.jobId] })

    // 古い blocked 行は印も付かず、状態も変わらない。
    expect(fx.storage.jobs.findById(staleJob.id)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: true })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(false)
    expect(fx.storage.jobs.findById(staleJob.id)?.status).toBe('blocked')
  })

  // 取り残された行が所有者でないと言えるのは、workspace を観測して
  // 「次の Task を始められる状態」だと確かめたときだけである（Worker と同じ判定）。
  // 対象 Task 自身に解放すべき Job が無ければ、その観測の当てが無い。
  it('観測の当てが無ければ、取り残された blocked Job を所有者として扱う', () => {
    const fx = seed()
    // 対象 Task 側の blocked Job を消す（= 段階操作へ進まない直接 park 経路）。
    fx.storage.jobs.update(fx.jobId, { status: 'failed' })
    const finished = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'finished long ago', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: finished.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
      workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  // 証明は観測した workspace にしか効かない。別の workingDir に取り残された行について、
  // こちらの workspace が clean だったことは何も言っていない。
  it('別 workspace に取り残された blocked Job は、こちらの証明では見逃さない', () => {
    const fx = seed()
    const finished = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'finished elsewhere', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    const elsewhere = fx.storage.jobs.create({
      taskId: finished.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/other' }, dryRun: false,
      workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0]).id

    // 対象 Task の cleanup は /workspace/target しか観測しない。
    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })

    expect(fx.storage.jobs.findById(elsewhere)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  // **この1件はこの修正の証拠ではない**（独立レビューの指摘どおり、旧実装でも通る）。
  // 「done なら見逃す」を将来 quarantine まで広げてしまわないための固定として残す。
  it('quarantine された blocked Job は done な Task のものでも所有者として数える', () => {
    const fx = seed()
    const finished = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'finished but unproven', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: finished.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
      failureMetadata: { quarantined: true },
    } as Parameters<IStorage['jobs']['create']>[0])

    // 未検証の workspace を持つ行は done でも手放していない（既存 quarantine の不変条件）。
    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
  })

  it('他 Task の blocked Job には cleanup を要求しない（承認の流用を作らない）', () => {
    const fx = seed()
    const other = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'other', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    const otherJob = fx.storage.jobs.create({
      taskId: other.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])

    const result = abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(result).toMatchObject({ ok: true, status: 'cleanup_requested', jobIds: [fx.jobId] })
    expect(fx.storage.jobs.findById(otherJob.id)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()
  })

  it('承認は park で使い切られ、二度目には使えない', () => {
    const fx = seed()
    const approvalRequestId = approve(fx.storage, fx.taskId)
    fx.storage.jobs.update(fx.jobId, { status: 'failed' })

    expect(abortTask(fx.storage, { taskId: fx.taskId, approvalRequestId, reason: 'r' }))
      .toMatchObject({ ok: true, status: 'parked' })
    expect(fx.storage.approvalRequests.findById(approvalRequestId)?.status).toBe('CONSUMED')

    // 同じ承認で別 Task を park できない。
    const second = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'second', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    expect(abortTask(fx.storage, { taskId: second.id, approvalRequestId, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
    expect(fx.storage.tasks.findById(second.id)?.roadmapActive).toBe(true)
  })

  it('cleanup 要求後に承認が失効していれば park しない', () => {
    const fx = seed()
    const approvalRequestId = approve(fx.storage, fx.taskId)
    abortTask(fx.storage, { taskId: fx.taskId, approvalRequestId, reason: 'r' })

    // CEO が承認を取り消した / 期限切れになった、に相当する。
    fx.storage.approvalRequests.updateStatus(approvalRequestId, 'REJECTED')

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    expect(fx.storage.jobs.findById(fx.jobId)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })
})

describe('abortTask — 観測の検証は baseline 一致だけではない', () => {
  it('進行中の git 操作が残っていれば park しない', () => {
    const fx = seed()
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    const result = completeAbortCleanup(fx.storage, {
      jobId: fx.jobId,
      observation: BASELINE,
      knownGood: { ...KNOWN_GOOD, gitOperationMarkers: ['rebase-merge'] },
    })

    expect(result).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    expect(fx.storage.jobs.findById(fx.jobId)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  it('観測に出ない変更が否定できなければ park しない', () => {
    const fx = seed()
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: { ...KNOWN_GOOD, blindSpotsAbsent: false },
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  it('段階操作の途中で Task が動き出していたら park しない', () => {
    const fx = seed()
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    // in_progress / blocked は roadmapActive に関係なく占有と数えられるため、
    // ここで park しても PL は解放されない。「park できたのに進めない」を作らない。
    fx.storage.tasks.update(fx.taskId, { status: 'in_progress' })

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })
})

describe('abortTask — blocked Job を1本残さない', () => {
  /** resume は新しい Job 行を作り、古い blocked 行を履歴として残す。2本並ぶのは異常ではない。 */
  function addSecondBlockedJob(
    fx: Fixture,
    overrides: { workingDir?: string; workspaceBaseline?: JobWorkspaceBaseline | undefined } = {},
  ): string {
    const { workingDir = '/workspace/target' } = overrides
    return fx.storage.jobs.create({
      taskId: fx.taskId, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir }, dryRun: false,
      workspaceBaseline: 'workspaceBaseline' in overrides ? overrides.workspaceBaseline : BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0]).id
  }

  it('同じ Task の blocked Job が複数あれば、park と同時に全部解放する', () => {
    const fx = seed()
    const second = addSecondBlockedJob(fx)

    const requested = abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })
    expect(requested).toMatchObject({ ok: true, status: 'cleanup_requested' })

    // Worker は1本ぶんの観測しか報告しない。
    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: true })

    // **1本も blocked を残さない。** 残すと所有者と見なされ続け、しかも Task は
    // もう roadmap-active でないので2本目の報告はもう通らない（park したのに止まる）。
    const blocked = fx.storage.jobs.findByTaskId(fx.taskId).filter((job) => job.status === 'blocked')
    expect(blocked).toHaveLength(0)
    expect(fx.storage.jobs.findById(second)?.status).toBe('failed')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(false)
  })

  it('baseline が一致しない blocked Job が残っていれば park しない', () => {
    const fx = seed()
    // 一致しないということは、その Job が記録した時点から workspace が説明できない形で
    // 変わっているということ。clean に見えることは、その説明にはならない。
    const stale = addSecondBlockedJob(fx, {
      workspaceBaseline: { mode: 'clean', startCommitHash: 'aaaaaaa1' },
    })
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })

    expect(fx.storage.jobs.findById(stale)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  // 観測は必ずどこかの workspace で採られている。対象 Job 側に workingDir が無いと、
  // その観測がこの Job の workspace の話だという対応が付かない。
  // （`jobs.update()` は `safe_command` を書かないので、この形は create 時にしか作れない。）
  it('対象 Job に workingDir が無ければ park しない（証明の結び先が無い）', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'legacy', description: 'd', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    // 古い行はこの形で読めることがある（`SafeCommand.workingDir` は型上必須だが永続化は別）。
    const legacyJob = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test' }, dryRun: false, workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(abortTask(storage, {
      taskId: task.id, approvalRequestId: approve(storage, task.id), reason: 'r',
    })).toMatchObject({ ok: true, status: 'cleanup_requested' })

    expect(completeAbortCleanup(storage, {
      jobId: legacyJob.id, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })

    expect(storage.jobs.findById(legacyJob.id)?.status).toBe('blocked')
    expect(storage.tasks.findById(task.id)?.roadmapActive).toBe(true)
  })

  it('baseline を持たない blocked Job が残っていれば park しない', () => {
    const fx = seed()
    const legacy = addSecondBlockedJob(fx, { workspaceBaseline: undefined })
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })

    expect(fx.storage.jobs.findById(legacy)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  it('別 workspace の blocked Job が残っていれば park しない（検証したのは1つだけ）', () => {
    const fx = seed()
    const elsewhere = addSecondBlockedJob(fx, { workingDir: '/workspace/other' })
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })

    expect(fx.storage.jobs.findById(fx.jobId)?.status).toBe('blocked')
    expect(fx.storage.jobs.findById(elsewhere)?.status).toBe('blocked')
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })

  it('報告までの間に他 Task が所有者になっていたら park しない', () => {
    const fx = seed()
    abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: approve(fx.storage, fx.taskId), reason: 'r',
    })

    // stage 1 を通った後に別 Task が blocked になる。park しても workspace は解放されない。
    const other = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'other', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: other.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })
})

describe('abortTask — park した Task を別経路で再武装させない', () => {
  it('resume は park された Task を進めない', () => {
    const fx = seed()
    parkFully(fx)

    const resumed = fx.storage.jobs.resumeBlockedTask({
      taskId: fx.taskId, instructionPrompt: 'continue',
    })

    expect(resumed.ok).toBe(false)
    expect(fx.storage.jobs.findByTaskId(fx.taskId)).toHaveLength(1)
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(false)
  })

  it('park 判定は audit にもとづく（roadmapActive=false だけでは park ではない）', () => {
    const fx = seed()
    expect(fx.storage.tasks.isParked(fx.taskId)).toBe(false)

    fx.storage.tasks.update(fx.taskId, { roadmapActive: false })
    expect(fx.storage.tasks.isParked(fx.taskId)).toBe(false)

    fx.storage.tasks.update(fx.taskId, { roadmapActive: true })
    parkFully(fx)
    expect(fx.storage.tasks.isParked(fx.taskId)).toBe(true)
  })
})

describe('abortTask — park 後は PL を止めない', () => {
  it('currentTask から外れ、blocked 履歴の attention も出なくなる', () => {
    const fx = seed()

    const before = buildSystemState(fx.storage)
    expect(before.projects.find((p) => p.id === fx.projectId)?.currentTask?.id).toBe(fx.taskId)
    expect(before.attention.some((i) => i.kind === 'job_blocked' && i.taskId === fx.taskId)).toBe(true)

    parkFully(fx)

    const after = buildSystemState(fx.storage)
    expect(after.projects.find((p) => p.id === fx.projectId)?.currentTask).toBeUndefined()
    expect(after.attention.some((i) => i.kind === 'job_blocked' && i.taskId === fx.taskId)).toBe(false)
    // **事実は残る。** Job 行は消えていない。
    expect(fx.storage.jobs.findByTaskId(fx.taskId)).toHaveLength(1)
  })

  it('park ではない非活性 Task の attention は消さない', () => {
    const fx = seed()
    // sync による非活性化や手動 Task はここに入る。park していないので
    // blocked Job は依然「誰かが対応できる」ものであり、attention を消してはならない。
    fx.storage.tasks.update(fx.taskId, { roadmapActive: false })

    const state = buildSystemState(fx.storage)

    expect(state.attention.some((i) => i.kind === 'job_blocked' && i.taskId === fx.taskId)).toBe(true)
  })
})

describe('abortTask — sync が park を取り消さない', () => {
  const spec = (key: string) => ({
    roadmapTaskKey: key, title: 'stuck one', description: 'd', phase: 1,
    assignee: 'developer_ai' as const, category: 'implementation' as const, dependencies: [],
    acceptanceCriteria: ['x'], allowedPaths: ['apps/api/src/pl'],
  })

  it('park した Task は後続 sync で再活性化されない', () => {
    const fx = seed()
    parkFully(fx)

    const result = fx.storage.tasks.syncRoadmapTasks({
      projectId: fx.projectId,
      tasks: [spec('some-item')],
      phases: [{ phaseNumber: 1, name: 'p', goal: 'g' }],
    })

    expect(result.ok).toBe(true)
    expect(result.reactivatedTaskIds).not.toContain(fx.taskId)
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(false)
  })

  it('Job 履歴が無いまま park された Task も再活性化されない', () => {
    // 解放すべき Job が無い経路（その場で park）。この Task は Job を1つも持たないため、
    // sync の「未着手 Task」分岐へ入る。そこが park を踏み越えると、park が黙って取り消される。
    const fx = seed()
    const bare = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'stuck one', description: 'd', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
      roadmapTaskKey: 'bare-item', allowedPaths: ['apps/api/src/pl'], acceptanceCriteria: ['x'],
    } as Parameters<IStorage['tasks']['create']>[0])
    // 対象 Task の blocked Job が project の workspace を持っていると park を拒否するので外す。
    fx.storage.jobs.update(fx.jobId, { status: 'failed' })

    expect(abortTask(fx.storage, {
      taskId: bare.id, approvalRequestId: approve(fx.storage, bare.id), reason: 'r',
    })).toMatchObject({ ok: true, status: 'parked' })
    expect(fx.storage.jobs.findByTaskId(bare.id)).toHaveLength(0)

    const result = fx.storage.tasks.syncRoadmapTasks({
      projectId: fx.projectId,
      tasks: [spec('some-item'), { ...spec('bare-item') }],
      phases: [{ phaseNumber: 1, name: 'p', goal: 'g' }],
    })

    expect(result.ok).toBe(true)
    expect(result.reactivatedTaskIds).not.toContain(bare.id)
    expect(fx.storage.tasks.findById(bare.id)?.roadmapActive).toBe(false)
  })

  it('park されていない非活性 Task の既存再活性化は変えていない', () => {
    const fx = seed()
    fx.storage.jobs.update(fx.jobId, { status: 'failed' })
    fx.storage.tasks.update(fx.taskId, { roadmapActive: false })

    const result = fx.storage.tasks.syncRoadmapTasks({
      projectId: fx.projectId,
      tasks: [spec('some-item')],
      phases: [{ phaseNumber: 1, name: 'p', goal: 'g' }],
    })

    expect(result.ok).toBe(true)
    expect(result.reactivatedTaskIds).toContain(fx.taskId)
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
  })
})

describe('abortTask — 全 Job terminal の blocked Task', () => {
  it('最新 Job にだけ cleanup を要求し、承認をまだ消費せず直接 park しない', () => {
    const fx = seedTerminalBlocked()
    const approvalRequestId = approve(fx.storage, fx.taskId)

    const result = abortTask(fx.storage, {
      taskId: fx.taskId,
      approvalRequestId,
      reason: 'obsolete after promotion',
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'cleanup_requested',
      jobIds: [fx.latestJobId],
    })
    expect(fx.storage.tasks.findById(fx.taskId)).toMatchObject({
      status: 'blocked',
      roadmapActive: true,
    })
    expect(fx.storage.approvalRequests.findById(approvalRequestId)?.status).toBe('APPROVED')
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata).toMatchObject({
      abortApprovalRequestId: approvalRequestId,
      abortReason: 'obsolete after promotion',
    })
    expect(fx.storage.jobs.findById(fx.jobId)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()
  })

  it.each(['blocked', 'queued', 'running'] as const)(
    'refuses while a %s Job remains',
    (status) => {
      const fx = seedTerminalBlocked()
      fx.storage.jobs.update(fx.jobId, { status })

      const result = abortTask(fx.storage, {
        taskId: fx.taskId,
        approvalRequestId: approve(fx.storage, fx.taskId),
        reason: 'r',
      })

      expect(result).toMatchObject({
        ok: false,
        code: status === 'blocked' ? 'TASK_NOT_PARKABLE' : 'LIVE_JOB_PRESENT',
      })
    },
  )

  it('refuses a quarantined terminal Job', () => {
    const fx = seedTerminalBlocked()
    fx.storage.jobs.update(fx.jobId, { failureMetadata: { quarantined: true } })

    expect(abortTask(fx.storage, {
      taskId: fx.taskId,
      approvalRequestId: approve(fx.storage, fx.taskId),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'JOB_QUARANTINED' })
  })

  it('refuses a zero-Job blocked Task so /recover remains the only entry', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'zero', description: '', status: 'blocked',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])

    expect(abortTask(storage, {
      taskId: task.id,
      approvalRequestId: approve(storage, task.id),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_NOT_PARKABLE' })
  })

  it('refuses mixed or empty workingDir before requesting an observation', () => {
    const mixed = seedTerminalBlocked()
    mixed.storage.jobs.create({
      taskId: mixed.taskId, projectId: mixed.projectId, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/other' }, workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(abortTask(mixed.storage, {
      taskId: mixed.taskId,
      approvalRequestId: approve(mixed.storage, mixed.taskId),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_NOT_PARKABLE' })

    const empty = seedTerminalBlocked()
    empty.storage.jobs.create({
      taskId: empty.taskId,
      projectId: empty.projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '' },
      workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(abortTask(empty.storage, {
      taskId: empty.taskId,
      approvalRequestId: approve(empty.storage, empty.taskId),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_NOT_PARKABLE' })
  })

  it('refuses roadmap-inactive and foreign-owner shapes', () => {
    const inactive = seedTerminalBlocked()
    inactive.storage.tasks.update(inactive.taskId, { roadmapActive: false })
    expect(abortTask(inactive.storage, {
      taskId: inactive.taskId,
      approvalRequestId: approve(inactive.storage, inactive.taskId),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'TASK_NOT_ACTIVE' })

    const foreign = seedTerminalBlocked()
    const other = foreign.storage.tasks.create({
      projectId: foreign.projectId, title: 'other', description: '', status: 'blocked',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    foreign.storage.jobs.create({
      taskId: other.id, projectId: foreign.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(abortTask(foreign.storage, {
      taskId: foreign.taskId,
      approvalRequestId: approve(foreign.storage, foreign.taskId),
      reason: 'r',
    })).toMatchObject({ ok: false, code: 'FOREIGN_BLOCKED_JOB' })
  })
})

describe('P2-2 Automatic Technical Abort', () => {
  it('protected_path は CEO/Approval 無しで cleanup を経て park する', () => {
    const fx = seedTechnicalAbort()

    requestTechnical(fx)
    expect(fx.storage.approvalRequests.findByTaskId(fx.taskId)).toHaveLength(0)
    expect(finishTechnical(fx)).toMatchObject({ ok: true, taskId: fx.taskId, jobId: fx.latestJobId })

    expect(fx.storage.tasks.findById(fx.taskId)).toMatchObject({ status: 'pending', roadmapActive: false })
    const aborted = fx.storage.auditLog.findByEntity('task', fx.taskId)
      .find((entry) => entry.operation === 'task_aborted')
    const detail = JSON.parse(aborted?.detail ?? '{}') as Record<string, unknown>
    expect(detail).toMatchObject({
      rootCauseClass: 'protected_path',
      parkCount: 1,
      observedHead: BASELINE.startCommitHash,
      cleanup: { changedPathCount: 0, restoredPathCount: 0, removedPathCount: 0 },
    })
    expect(detail).toHaveProperty('technicalEvidenceId')
    expect(aborted?.detail).not.toContain('apps/worker/src/index.ts')
    expect(aborted?.detail).not.toContain('protected runtime work')
  })

  it.each([
    ['count-only exhaustion', 'design_review_exhausted', 'high', {}],
    ['unknown cause', 'unknown', 'high', {}],
    ['low confidence', 'protected_path', 'low', {}],
    ['transient provider', 'provider_transient', 'high', {}],
    ['provider workspace failure', 'provider_failure_workspace_dirty', 'high', {}],
    ['review execution failure', 'review_execution_failed', 'high', {}],
    ['unresolved review conflict', 'design_review_conflict', 'high', {}],
    ['Decision Authority', 'safety_or_authority_boundary', 'high', {
      requiresSafetyBoundaryChange: true,
      requiresAuthorityChange: true,
    }],
  ] as const)('%s is never eligible for automatic park', (_label, cause, confidence, flags) => {
    const diagnosis: BlockedDiagnosis = {
      rootCauseClass: cause as BlockedRootCauseClass,
      blockingLayer: 'unknown',
      evidence: [],
      recoverable: false,
      existingRecoveryAvailable: false,
      requiresSafetyBoundaryChange: false,
      requiresAuthorityChange: false,
      irreversible: false,
      confidence,
      recommendedLane: 'ceo_escalation',
      summary: '',
      ...flags,
    }
    expect(isEligibleTechnicalAbortDiagnosis(diagnosis)).toBe(false)
  })

  it('unknown current triage does not mark, delete or park the Task', () => {
    const fx = seedTechnicalAbort()
    fx.storage.jobs.update(fx.latestJobId, {
      guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    })
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')

    expect(requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId,
      attention,
      readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: false, code: 'TECHNICAL_EVIDENCE_INELIGIBLE' })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
    expect(fx.storage.jobs.findByTaskId(fx.taskId)).toHaveLength(2)
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()
  })

  it('Task-owned dirty paths can be cleaned and parked without an active approval', () => {
    const fx = seedTechnicalAbort()
    const dirty: JobWorkspaceBaseline = {
      mode: 'dirty',
      startCommitHash: BASELINE.startCommitHash,
      entries: [{
        path: 'apps/worker/src/index.ts',
        kind: 'modified',
        xyStatus: '.M',
        worktreeHash: 'sha256:task-owned',
      }],
    }
    fx.storage.jobs.update(fx.latestJobId, {
      workspaceBaseline: dirty,
      changedFiles: ['apps/worker/src/index.ts'],
      failureMetadata: { workspaceEndFingerprint: dirty },
    })
    const older = fx.storage.jobs.findByTaskId(fx.taskId)[1]
    if (older === undefined) throw new Error('older job missing')
    fx.storage.jobs.update(older.id, {
      failureMetadata: { workspaceEndFingerprint: dirty },
    })
    requestTechnical(fx)

    expect(finishTechnical(fx, {
      preCleanupObservation: dirty,
      cleanupSummary: { changedPathCount: 1, restoredPathCount: 1, removedPathCount: 0 },
    })).toMatchObject({ ok: true })
  })

  it.each([
    ['pre-cleanup fingerprint mismatch', {
      preCleanupObservation: { mode: 'clean', startCommitHash: 'different' } as JobWorkspaceBaseline,
    }],
    ['post-cleanup HEAD mismatch', {
      observation: { mode: 'clean', startCommitHash: 'different' } as JobWorkspaceBaseline,
    }],
    ['merge/rebase marker', {
      knownGood: { ...KNOWN_GOOD, gitOperationMarkers: ['MERGE_HEAD'] },
    }],
    ['index not clean', { knownGood: { ...KNOWN_GOOD, indexClean: false } }],
    ['blind spot', { knownGood: { ...KNOWN_GOOD, blindSpotsAbsent: false } }],
    ['missing cleanup counts', { cleanupSummary: undefined }],
    ['missing final observation', { observation: undefined }],
  ])('%s refusal quarantines, retires the marker, and does not park', (_label, override) => {
    const fx = seedTechnicalAbort()
    requestTechnical(fx)

    expect(finishTechnical(fx, override)).toMatchObject({ ok: false })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
    expect(fx.storage.jobs.findByTaskId(fx.taskId)).toHaveLength(2)
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata).toMatchObject({ quarantined: true })
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()
    expect(fx.storage.auditLog.findByEntity('task', fx.taskId).some(
      (entry) => entry.operation === 'technical_abort_refused',
    )).toBe(true)
  })

  it('cross-Project workspace sharing that appears before final transaction blocks park', () => {
    const fx = seedTechnicalAbort()
    requestTechnical(fx)
    const otherProject = fx.storage.projects.create({
      name: 'other', goal: 'g', designPhilosophy: [], status: 'draft',
    })
    const otherTask = fx.storage.tasks.create({
      projectId: otherProject.id, title: 'other', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: otherTask.id, projectId: otherProject.id, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(finishTechnical(fx)).toMatchObject({ ok: false })
    expect(fx.storage.tasks.findById(fx.taskId)?.roadmapActive).toBe(true)
    expect(fx.storage.jobs.findByTaskId(fx.taskId)).toHaveLength(2)
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata).toMatchObject({ quarantined: true })
  })

  it.each(['WAITING_FOR_USER', 'APPROVED'] as const)(
    'refuses Technical Abort while an active %s approval exists',
    (status) => {
      const fx = seedTechnicalAbort()
      fx.storage.approvalRequests.create({
        taskId: fx.taskId,
        requestedAction: 'git_commit',
        riskLevel: 'HIGH',
        targetBranch: 'ai/technical',
        targetCommit: 'c2',
        targetDiffHash: 'd2',
        changedFiles: [],
        triggeredRules: [],
        invalidIf: [],
        status,
        expiresAt: FUTURE,
      } as Parameters<IStorage['approvalRequests']['create']>[0])
      const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
      if (attention === undefined) throw new Error('attention missing')

      expect(requestTechnicalAbort(fx.storage, {
        taskId: fx.taskId,
        attention,
        readLedger: () => TECHNICAL_LEDGER,
      })).toMatchObject({ ok: false, code: 'TECHNICAL_EVIDENCE_INELIGIBLE' })
      expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata?.abortCleanupRequestedAt)
        .toBeUndefined()
    },
  )

  it('refuses a subject that already has a CEO escalation', () => {
    const fx = seedTechnicalAbort()
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')
    fx.storage.auditLog.record({
      actor: 'api',
      operation: 'pl_loop',
      entityType: 'pl_loop_target',
      entityId: `${attention.kind}:${attention.referenceId ?? attention.jobId ?? attention.taskId ?? attention.projectId}`,
      result: 'escalated',
    })
    fx.storage.auditLog.findAll = () => {
      throw new Error('hasTaskEscalation must not scan the full audit log')
    }

    expect(requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId,
      attention,
      readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: false, code: 'TECHNICAL_EVIDENCE_INELIGIBLE' })
  })

  it.each([
    ['an earlier Job target', (fx: ReturnType<typeof seedTechnicalAbort>): string => {
      const earlier = fx.storage.jobs.findByTaskId(fx.taskId)[1]
      if (earlier === undefined) throw new Error('earlier job missing')
      return `job_blocked:${earlier.id}`
    }],
    ['task_blocked_without_job', (fx: ReturnType<typeof seedTechnicalAbort>): string => (
      `task_blocked_without_job:${fx.taskId}:first`
    )],
  ])('refuses after a CEO escalation for %s of the same Task', (_label, targetKey) => {
    const fx = seedTechnicalAbort()
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')
    fx.storage.auditLog.record({
      actor: 'api', operation: 'pl_loop', entityType: 'pl_loop_target',
      entityId: targetKey(fx), result: 'escalated',
    })

    expect(requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId, attention, readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: false, code: 'TECHNICAL_EVIDENCE_INELIGIBLE' })
  })

  it('requires the protected path in the Task Contract or the same violation on two Jobs', () => {
    const uncorroborated = seedTechnicalAbort()
    uncorroborated.storage.tasks.update(uncorroborated.taskId, {
      allowedPaths: ['apps/api/src/pl'],
      expectedOutputs: [],
    })
    const firstAttention = buildSystemState(uncorroborated.storage).attention
      .find((item) => item.taskId === uncorroborated.taskId)
    if (firstAttention === undefined) throw new Error('attention missing')
    expect(requestTechnicalAbort(uncorroborated.storage, {
      taskId: uncorroborated.taskId,
      attention: firstAttention,
      readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: false, code: 'TECHNICAL_EVIDENCE_INELIGIBLE' })

    const repeated = seedTechnicalAbort()
    repeated.storage.tasks.update(repeated.taskId, {
      allowedPaths: ['apps/api/src/pl'],
      expectedOutputs: [],
    })
    const older = repeated.storage.jobs.findByTaskId(repeated.taskId)[1]
    if (older === undefined) throw new Error('older job missing')
    repeated.storage.jobs.update(older.id, {
      guardResult: {
        permissionAllowed: true,
        fileChangeAllowed: false,
        fileViolations: ['apps/worker/src/index.ts'],
      },
    })
    requestTechnical(repeated)
  })

  it.each([
    ['pending', 'blocked', true],
    ['pending', 'failed', false],
    ['pending', 'success', false],
    ['blocked', 'blocked', false],
    ['blocked', 'failed', true],
    ['blocked', 'success', false],
  ] as const)('accepts only Worker-serviced carrier shape %s + %s', (taskStatus, jobStatus, accepted) => {
    const fx = seedTechnicalAbort()
    fx.storage.tasks.update(fx.taskId, { status: taskStatus })
    fx.storage.jobs.update(fx.latestJobId, { status: jobStatus })
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) {
      expect(accepted).toBe(false)
      return
    }
    const result = requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId,
      attention,
      readLedger: () => TECHNICAL_LEDGER,
    })
    expect(result.ok).toBe(accepted)
  })

  it('refuses when another Task used the workingDir between the clean baseline and carrier', () => {
    vi.useFakeTimers()
    try {
      const storage = createSQLiteStorage(':memory:')
      const project = storage.projects.create({
        name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
      })
      const task = storage.tasks.create({
        projectId: project.id, title: 'technical item', description: '', status: 'blocked',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true,
        roadmapTaskKey: 'technical-item', allowedPaths: ['apps/worker/src/index.ts'],
      } as Parameters<IStorage['tasks']['create']>[0])
      vi.setSystemTime('2026-10-08T00:00:00.000Z')
      storage.jobs.create({
        taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' }, workspaceBaseline: BASELINE,
      } as Parameters<IStorage['jobs']['create']>[0])
      const foreignTask = storage.tasks.create({
        projectId: project.id, title: 'foreign', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: false,
      } as Parameters<IStorage['tasks']['create']>[0])
      vi.setSystemTime('2026-10-08T00:00:01.000Z')
      storage.jobs.create({
        taskId: foreignTask.id, projectId: project.id, agentRole: 'developer_ai', status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' }, workspaceBaseline: BASELINE,
      } as Parameters<IStorage['jobs']['create']>[0])
      vi.setSystemTime('2026-10-08T00:00:02.000Z')
      const carrier = storage.jobs.create({
        taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        workspaceBaseline: {
          mode: 'dirty',
          startCommitHash: BASELINE.startCommitHash,
          entries: [{
            path: 'apps/foreign/uncommitted.ts',
            kind: 'modified',
            worktreeHash: 'sha256:foreign',
          }],
        },
        changedFiles: ['apps/foreign/uncommitted.ts'],
      } as Parameters<IStorage['jobs']['create']>[0])
      storage.jobs.update(carrier.id, {
        guardResult: {
          permissionAllowed: true,
          fileChangeAllowed: false,
          fileViolations: ['apps/worker/src/index.ts'],
        },
      })
      const attention = buildSystemState(storage).attention.find((item) => item.jobId === carrier.id)
      if (attention === undefined) throw new Error('attention missing')

      expect(requestTechnicalAbort(storage, {
        taskId: task.id,
        attention,
        readLedger: () => TECHNICAL_LEDGER,
      })).toMatchObject({ ok: false, code: 'OWNERSHIP_UNPROVEN' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a tracked-file content change between consecutive Task Jobs without touching the carrier', () => {
    const fx = seedTechnicalAbort()
    const carrierBefore = fx.storage.jobs.findById(fx.latestJobId)
    if (carrierBefore === undefined) throw new Error('carrier missing')
    fx.storage.jobs.update(fx.latestJobId, {
      workspaceBaseline: {
        mode: 'dirty',
        startCommitHash: BASELINE.startCommitHash,
        entries: [{
          path: 'apps/other-task/uncommitted.ts',
          kind: 'modified',
          worktreeHash: 'sha256:foreign',
        }],
      },
      changedFiles: ['apps/worker/src/index.ts'],
    })
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')

    expect(requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId,
      attention,
      readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: false, code: 'OWNERSHIP_UNPROVEN' })
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata)
      .toEqual(carrierBefore.failureMetadata)
  })

  it('excludes the carrier changedFiles from ownership and accepts pairwise start/end continuity', () => {
    const fx = seedTechnicalAbort()
    const inherited: JobWorkspaceBaseline = {
      mode: 'dirty',
      startCommitHash: BASELINE.startCommitHash,
      entries: [{
        path: 'apps/worker/src/index.ts', kind: 'modified', worktreeHash: 'sha256:owned',
      }],
    }
    const older = fx.storage.jobs.findByTaskId(fx.taskId)[1]
    if (older === undefined) throw new Error('older job missing')
    fx.storage.jobs.update(older.id, {
      failureMetadata: { workspaceEndFingerprint: inherited },
    })
    fx.storage.jobs.update(fx.latestJobId, {
      workspaceBaseline: inherited,
      changedFiles: ['apps/external/not-an-ownership-source.ts'],
      failureMetadata: { workspaceEndFingerprint: inherited },
    })

    requestTechnical(fx)
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeDefined()
  })

  it('refuses legacy Task Jobs without a persisted end fingerprint and keeps the handoff', () => {
    const fx = seedTechnicalAbort()
    fx.storage.jobs.update(fx.latestJobId, { failureMetadata: {} })
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')

    const result = requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId, attention, readLedger: () => TECHNICAL_LEDGER,
    })
    expect(result).toMatchObject({ ok: false, code: 'OWNERSHIP_UNPROVEN' })
    if (result.ok) throw new Error('expected legacy refusal')
    expect(result.reason).toContain('legacy row')
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata?.abortCleanupRequestedAt)
      .toBeUndefined()
  })

  it('does not let updatedAt alone invalidate the technical state fingerprint', () => {
    const fx = seedTechnicalAbort()
    const task = fx.storage.tasks.findById(fx.taskId)
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (task === undefined || attention === undefined) throw new Error('fixture missing')
    const jobs = fx.storage.jobs.findByTaskId(fx.taskId)
    expect(technicalAbortStateFingerprint(
      { ...task, updatedAt: '2026-10-08T01:00:00.000Z' },
      jobs,
      attention,
    )).toBe(technicalAbortStateFingerprint(
      { ...task, updatedAt: '2026-10-08T02:00:00.000Z' },
      jobs,
      attention,
    ))
  })

  it('deduplicates refusal audit rows by Task, evidence, and refusal code', () => {
    const fx = seedTechnicalAbort()
    for (let index = 0; index < 3; index += 1) {
      recordTechnicalAbortRefusal(fx.storage, {
        taskId: fx.taskId,
        evidenceId: 'evidence-1',
        code: 'PRE_CLEANUP_BASELINE_MISMATCH',
        stage: index === 0 ? 'worker_cleanup' : 'final_transaction',
      })
    }
    expect(fx.storage.auditLog.findByEntity('task', fx.taskId).filter(
      (entry) => entry.operation === 'technical_abort_refused',
    )).toHaveLength(1)
  })

  it('leaves a current Technical Abort marker for the Worker instead of retiring it', () => {
    const fx = seedTechnicalAbort()
    requestTechnical(fx)
    const marker = fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')

    expect(requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId,
      attention,
      readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: true, status: 'cleanup_requested' })
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata).toEqual(marker)
  })

  it('retires a Technical Abort marker only after its state fingerprint is provably stale', () => {
    const fx = seedTechnicalAbort()
    requestTechnical(fx)
    fx.storage.jobs.update(fx.latestJobId, { changedFiles: ['apps/worker/src/index.ts'] })
    const attention = buildSystemState(fx.storage).attention.find((item) => item.taskId === fx.taskId)
    if (attention === undefined) throw new Error('attention missing')

    expect(requestTechnicalAbort(fx.storage, {
      taskId: fx.taskId, attention, readLedger: () => TECHNICAL_LEDGER,
    })).toMatchObject({ ok: false, code: 'JOB_QUARANTINED' })
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata).toMatchObject({ quarantined: true })
    expect(fx.storage.jobs.findById(fx.latestJobId)?.failureMetadata?.abortTechnicalEvidenceId)
      .toBeUndefined()
  })

  it('manual ADMIN abort still requires APPROVED abort_task approval and consumes it', () => {
    const fx = seed()
    const waiting = fx.storage.approvalRequests.create({
      taskId: fx.taskId, requestedAction: 'abort_task', riskLevel: 'HIGH',
      targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd', changedFiles: [],
      triggeredRules: [], invalidIf: [], status: 'WAITING_FOR_USER', expiresAt: FUTURE,
    } as Parameters<IStorage['approvalRequests']['create']>[0])
    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: waiting.id, reason: 'manual',
    })).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })

    fx.storage.approvalRequests.updateStatus(waiting.id, 'APPROVED')
    expect(abortTask(fx.storage, {
      taskId: fx.taskId, approvalRequestId: waiting.id, reason: 'manual',
    })).toMatchObject({ ok: true, status: 'cleanup_requested' })
    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.jobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: true })
    expect(fx.storage.approvalRequests.findById(waiting.id)?.status).toBe('CONSUMED')
  })
})

describe('P2-2 re-adoption suppression and re-enable signals', () => {
  function parked(options: { dependency?: boolean } = {}): ReturnType<typeof seedTechnicalAbort> {
    const fx = seedTechnicalAbort(options)
    requestTechnical(fx)
    const done = finishTechnical(fx)
    if (!done.ok) throw new Error(done.reason)
    return fx
  }

  function classification(fx: ReturnType<typeof seedTechnicalAbort>, ledger = TECHNICAL_LEDGER) {
    return classifyAdoptionCandidates(
      fx.storage,
      fx.projectId,
      readAdoptionCandidates(() => ledger),
    ).find((candidate) => candidate.id === 'technical-item')
  }

  it('unchanged fingerprint stays suppressed, remains visible as parked, and count alone never escalates', () => {
    const fx = parked()
    for (let i = 0; i < 4; i += 1) {
      expect(classification(fx)).toMatchObject({
        kind: 'not_available',
        notAvailableReason: 'technical_abort_unchanged',
      })
    }
    expect(fx.storage.tasks.isParked(fx.taskId)).toBe(true)
    expect(fx.storage.tasks.findById(fx.taskId)).toMatchObject({ status: 'pending', roadmapActive: false })
    expect(fx.storage.auditLog.findAll().some(
      (entry) => entry.operation === 'pl_adoption_escalation_notified',
    )).toBe(false)
  })

  it('Roadmap body change re-enables autonomous follow-up', () => {
    const fx = parked()
    const changed = TECHNICAL_LEDGER.replace('Protected runtime work.', 'Use an unprotected adapter seam.')
    expect(classification(fx, changed)?.kind).toBe('follow_up')
  })

  it('Task Contract change re-enables autonomous follow-up', () => {
    const fx = parked()
    fx.storage.tasks.update(fx.taskId, { allowedPaths: ['apps/api/src/pl'] })
    expect(classification(fx)?.kind).toBe('follow_up')
  })

  it('dependency completion re-enables autonomous follow-up', () => {
    const fx = parked({ dependency: true })
    const dependencyId = fx.storage.tasks.findById(fx.taskId)?.dependencies[0]
    if (dependencyId === undefined) throw new Error('dependency missing')
    fx.storage.tasks.update(dependencyId, { status: 'done' })
    expect(classification(fx)?.kind).toBe('follow_up')
  })

  it('a later same-workspace Job/HEAD record re-enables autonomous follow-up', () => {
    const fx = parked()
    const laterTask = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'merged code', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapActive: false,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: laterTask.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      workspaceBaseline: { mode: 'clean', startCommitHash: 'new-head' },
      commitHash: 'new-head',
    } as Parameters<IStorage['jobs']['create']>[0])
    expect(classification(fx)?.kind).toBe('follow_up')
  })

  it('a recorded recovery/triage signal re-enables autonomous follow-up', () => {
    const fx = parked()
    fx.storage.auditLog.record({
      actor: 'api', operation: 'resume_actor', entityType: 'task', entityId: fx.taskId,
      result: 'technical_recovery', detail: 'value-free',
    })
    expect(classification(fx)?.kind).toBe('follow_up')
  })

  it('unrelated audit traffic does not re-enable adoption on time/count alone', () => {
    const fx = parked()
    fx.storage.auditLog.record({
      actor: 'api', operation: 'unrelated_observation', entityType: 'task', entityId: fx.taskId,
      result: 'seen', detail: 'count=99',
    })
    expect(classification(fx)).toMatchObject({
      kind: 'not_available',
      notAvailableReason: 'technical_abort_unchanged',
    })
  })
})

describe('abortTask — terminal blocked Task の storage release', () => {
  function expectStillBlocked(fx: TerminalBlockedFixture, approvalRequestId: string): void {
    expect(fx.storage.tasks.findById(fx.taskId)).toMatchObject({
      status: 'blocked', roadmapActive: true,
    })
    expect(fx.storage.approvalRequests.findById(approvalRequestId)?.status).toBe('APPROVED')
    expect(fx.storage.auditLog.findByEntity('task', fx.taskId)
      .filter((entry) => entry.operation === 'task_aborted')).toHaveLength(0)
  }

  it('refuses dirty observation, HEAD mismatch, and missing baseline without consuming approval', () => {
    const dirty = seedTerminalBlocked()
    const dirtyApproval = requestTerminalBlocked(dirty)
    expect(completeAbortCleanup(dirty.storage, {
      jobId: dirty.latestJobId,
      observation: { mode: 'dirty', startCommitHash: BASELINE.startCommitHash, entries: [] },
      knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    expectStillBlocked(dirty, dirtyApproval)

    const mismatch = seedTerminalBlocked()
    const mismatchApproval = requestTerminalBlocked(mismatch)
    mismatch.storage.jobs.update(mismatch.jobId, {
      workspaceBaseline: { mode: 'clean', startCommitHash: 'different-head' },
    })
    const mismatchResult = completeAbortCleanup(mismatch.storage, {
      jobId: mismatch.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })
    expect(mismatchResult).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    if (mismatchResult.ok) throw new Error('expected HEAD mismatch refusal')
    expect(mismatchResult.reason).toContain('terminal Jobs do not share one start HEAD')
    expectStillBlocked(mismatch, mismatchApproval)

    const missing = seedTerminalBlocked()
    const missingApproval = requestTerminalBlocked(missing)
    missing.storage.jobs.update(missing.jobId, { workspaceBaseline: undefined })
    expect(completeAbortCleanup(missing.storage, {
      jobId: missing.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    expectStillBlocked(missing, missingApproval)
  })

  it.each([
    ['gitOperationMarkers', { ...KNOWN_GOOD, gitOperationMarkers: ['MERGE_HEAD'] }],
    ['worktreeClean', { ...KNOWN_GOOD, worktreeClean: false }],
    ['indexClean', { ...KNOWN_GOOD, indexClean: false }],
    ['headValid', { ...KNOWN_GOOD, headValid: false }],
    ['blindSpotsAbsent', { ...KNOWN_GOOD, blindSpotsAbsent: false }],
  ])('refuses when knownGood.%s is unsafe', (_name, knownGood) => {
    const fx = seedTerminalBlocked()
    const approvalRequestId = requestTerminalBlocked(fx)

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.latestJobId,
      observation: BASELINE,
      knownGood,
    })).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED' })
    expectStillBlocked(fx, approvalRequestId)
  })

  it.each([
    ['a Job becomes blocked', (fx: TerminalBlockedFixture) => {
      fx.storage.jobs.update(fx.jobId, { status: 'blocked' })
    }],
    ['a Job becomes quarantined', (fx: TerminalBlockedFixture) => {
      fx.storage.jobs.update(fx.jobId, { failureMetadata: { quarantined: true } })
    }],
    ['a live Job appears in the project', (fx: TerminalBlockedFixture) => {
      const other = fx.storage.tasks.create({
        projectId: fx.projectId, title: 'live', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true,
      } as Parameters<IStorage['tasks']['create']>[0])
      fx.storage.jobs.create({
        taskId: other.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' }, workspaceBaseline: BASELINE,
      } as Parameters<IStorage['jobs']['create']>[0])
    }],
  ] as Array<[string, (fx: TerminalBlockedFixture) => void]>) (
    'transaction rechecks when %s after cleanup was requested',
    (_name, mutate) => {
      const fx = seedTerminalBlocked()
      const approvalRequestId = requestTerminalBlocked(fx)
      mutate(fx)

      expect(completeAbortCleanup(fx.storage, {
        jobId: fx.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
      })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
      expectStillBlocked(fx, approvalRequestId)
    },
  )

  it('transaction refuses a foreign blocked owner that appears after cleanup was requested', () => {
    const fx = seedTerminalBlocked()
    const approvalRequestId = requestTerminalBlocked(fx)
    const other = fx.storage.tasks.create({
      projectId: fx.projectId, title: 'owner', description: '', status: 'blocked',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true,
    } as Parameters<IStorage['tasks']['create']>[0])
    fx.storage.jobs.create({
      taskId: other.id, projectId: fx.projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, workspaceBaseline: BASELINE,
    } as Parameters<IStorage['jobs']['create']>[0])

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    expectStillBlocked(fx, approvalRequestId)
  })

  it.each(['failed', 'success'] as const)(
    'refuses an old marked Job after resume creates a newer %s Job without consuming approval',
    (successorStatus) => {
      const fx = seedResumableTerminalBlocked()
      const approvalRequestId = approve(fx.storage, fx.taskId)
      expect(abortTask(fx.storage, {
        taskId: fx.taskId,
        approvalRequestId,
        reason: 'obsolete before resume',
      })).toMatchObject({
        ok: true,
        status: 'cleanup_requested',
        jobIds: [fx.jobId],
      })

      const resumed = fx.storage.jobs.resumeBlockedTask({
        taskId: fx.taskId,
        instructionPrompt: 'resume after cleanup observation was refused',
      })
      if (!resumed.ok) throw new Error(resumed.reason)
      expect(resumed.ok).toBe(true)
      fx.storage.jobs.update(resumed.job.id, { status: successorStatus })

      const result = completeAbortCleanup(fx.storage, {
        jobId: fx.jobId,
        observation: BASELINE,
        knownGood: KNOWN_GOOD,
      })

      expect(result).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
      if (result.ok) throw new Error('expected stale cleanup refusal')
      expect(result.reason).toContain(`is not task ${fx.taskId}'s latest job (${resumed.job.id})`)
      expectStillBlocked({ ...fx, latestJobId: resumed.job.id }, approvalRequestId)
    },
  )

  it('refuses when the cleanup mark predates the latest Job creation time', () => {
    const fx = seedTerminalBlocked()
    const approvalRequestId = requestTerminalBlocked(fx)
    const latest = fx.storage.jobs.findById(fx.latestJobId)
    if (!latest) throw new Error('latest job missing')
    fx.storage.jobs.update(latest.id, {
      failureMetadata: {
        ...(latest.failureMetadata ?? {}),
        abortCleanupRequestedAt: new Date(Date.parse(latest.createdAt) - 1).toISOString(),
      },
    })

    const result = completeAbortCleanup(fx.storage, {
      jobId: latest.id,
      observation: BASELINE,
      knownGood: KNOWN_GOOD,
    })

    expect(result).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    if (result.ok) throw new Error('expected cleanup mark time refusal')
    expect(result.reason).toContain('predates')
    expectStillBlocked(fx, approvalRequestId)
  })

  it.each([
    ['expired', (fx: TerminalBlockedFixture) => approvedRequest(
      fx.storage,
      fx.taskId,
      { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    )],
    ['foreign', (fx: TerminalBlockedFixture) => {
      const other = fx.storage.tasks.create({
        projectId: fx.projectId, title: 'other', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true,
      } as Parameters<IStorage['tasks']['create']>[0])
      return approvedRequest(fx.storage, other.id)
    }],
    ['wrong-action', (fx: TerminalBlockedFixture) => approvedRequest(
      fx.storage,
      fx.taskId,
      { action: 'git_commit' },
    )],
  ] as const)('refuses %s approval and leaves it APPROVED', (_name, makeApproval) => {
    const fx = seedTerminalBlocked()
    const approvalRequestId = makeApproval(fx)
    markTerminalCleanup(fx, approvalRequestId)

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    expectStillBlocked(fx, approvalRequestId)
  })

  it('parks atomically, consumes once, writes one audit row, and leaves terminal Jobs unchanged', () => {
    const fx = seedTerminalBlocked()
    const beforeJobs = fx.storage.jobs.findByTaskId(fx.taskId).map((job) => ({
      id: job.id, status: job.status, completedAt: job.completedAt, stderr: job.stderr,
    }))
    const approvalRequestId = requestTerminalBlocked(fx)

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: true, taskId: fx.taskId, jobId: fx.latestJobId })

    expect(fx.storage.tasks.findById(fx.taskId)).toMatchObject({
      status: 'pending', roadmapActive: false,
    })
    expect(fx.storage.tasks.isParked(fx.taskId)).toBe(true)
    expect(fx.storage.approvalRequests.findById(approvalRequestId)?.status).toBe('CONSUMED')
    expect(fx.storage.jobs.findByTaskId(fx.taskId).map((job) => ({
      id: job.id, status: job.status, completedAt: job.completedAt, stderr: job.stderr,
    }))).toEqual(beforeJobs)
    const aborted = fx.storage.auditLog.findByEntity('task', fx.taskId)
      .filter((entry) => entry.operation === 'task_aborted')
    expect(aborted).toHaveLength(1)
    expect(aborted[0]?.detail).toContain('blocked -> pending')
    expect(aborted[0]?.detail).toContain(`observed job ${fx.latestJobId}`)
    expect(aborted[0]?.detail).toContain(`observed HEAD ${BASELINE.startCommitHash}`)

    expect(completeAbortCleanup(fx.storage, {
      jobId: fx.latestJobId, observation: BASELINE, knownGood: KNOWN_GOOD,
    })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' })
    expect(fx.storage.auditLog.findByEntity('task', fx.taskId)
      .filter((entry) => entry.operation === 'task_aborted')).toHaveLength(1)

    expect(fx.storage.jobs.resumeBlockedTask({
      taskId: fx.taskId, instructionPrompt: 'do not resume',
    }).ok).toBe(false)
    expect(recoverBlockedTask(fx.storage, {
      taskId: fx.taskId, reason: 'do not recover',
    }).ok).toBe(false)
    expect(occupiesProject(fx.storage.tasks.findById(fx.taskId)!)).toBe(false)
    expect(buildSystemState(fx.storage).projects
      .find((project) => project.id === fx.projectId)?.currentTask).toBeUndefined()
  })
})
