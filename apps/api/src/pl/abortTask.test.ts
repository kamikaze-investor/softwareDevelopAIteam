import { describe, expect, it } from 'vitest'
import type { JobWorkspaceBaseline } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import { abortTask, completeAbortCleanup } from './abortTask'

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const BASELINE: JobWorkspaceBaseline = { mode: 'clean', startCommitHash: '0805249b' }

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
function seed(): Fixture {
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
    safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    workspaceBaseline: BASELINE,
  } as Parameters<IStorage['jobs']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id, jobId: job.id }
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
