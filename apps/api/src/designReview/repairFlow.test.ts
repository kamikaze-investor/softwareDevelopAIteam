import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { MAX_REPAIR_ATTEMPTS } from './repairPolicy'
import { executeQueuedRepair, isWorkflowStepKeyConflict, prepareRepairFlow, runRepairFlow } from './repairFlow'
import { abortTask } from '../pl/abortTask'

/**
 * Stage 2 Task Flow統合の検証。
 *
 * load-bearing invariant:
 *   1. Human escalationの実在性 — 継続できない場合、Taskが既存blockedへ入り、
 *      既存 POST /api/tasks/:id/resume（resumeBlockedTask）へ到達できる
 *   2. Stage 2起動のidempotency — 同一failure eventからchainは1本だけ
 */

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seed(storage: IStorage): { taskId: string; projectId: string } {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: 'd',
    status: 'in_progress', assignee: 'developer_ai', dependencies: [],
  })
  return { taskId: task.id, projectId: project.id }
}

function createFailedJob(
  storage: IStorage,
  ids: { taskId: string; projectId: string },
  overrides: Record<string, unknown> = {},
): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'implement',
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'original prompt',
    ...overrides,
  } as never)
  return storage.jobs.update(job.id, {
    status: 'failed',
    exitCode: 1,
    stderr: 'TypeError: boom',
    changedFiles: ['docs/readme.md'],
    ...overrides,
  } as never)!
}

const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

function deps(stdout: string = ALIGNED_STDOUT) {
  return {
    runnerCommand: 'node',
    runnerArgs: [],
    homeDirectory: '/tmp/home',
    workingDir: '/tmp/work',
    execute: async () => ({ ok: true, stdout, timedOut: false }),
  }
}

/**
 * 予算を使い切った repair chain を 1 本作り、**その先端の failed Job** を返す。
 *
 * 予算は chain（generation）単位で数えるので、無関係な repair を Task へ並べても
 * 尽きない。使い切った状態を作るには `repair:<直前のJob>:1` で実際に繋ぐ必要がある。
 */
function exhaustAttempts(storage: IStorage, ids: { taskId: string; projectId: string }): Job {
  let tip = createFailedJob(storage, ids, {
    workflowStepKey: 'task:' + ids.taskId + ':initial-implement',
    exitCode: 42,
  })
  for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i += 1) {
    tip = createFailedJob(storage, ids, { workflowStepKey: 'repair:' + tip.id + ':1', exitCode: i })
  }
  return tip
}

describe('park された Task は repair chain へ入らない', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  /** abort_task と同じ経路で park する（DB を直接書き換えない）。 */
  function park(taskId: string): void {
    storage.tasks.update(taskId, { status: 'pending', roadmapActive: true })
    const request = storage.approvalRequests.create({
      taskId, requestedAction: 'abort_task', riskLevel: 'HIGH',
      targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
      changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
      status: 'WAITING_FOR_USER', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    } as never)
    storage.approvalRequests.updateStatus(request.id, 'APPROVED')
    const parked = abortTask(storage, { taskId, approvalRequestId: request.id, reason: 'parked' })
    if (!parked.ok || parked.status !== 'parked') throw new Error('fixture failed to park')
  }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('park された Task の失敗では repair Job を作らない', async () => {
    const failed = createFailedJob(storage, ids)
    park(ids.taskId)

    const outcome = await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(outcome.status).toBe('skipped')
    expect(storage.jobs.findByTaskId(ids.taskId).filter((job) => job.status === 'queued')).toHaveLength(0)
    expect(storage.tasks.findById(ids.taskId)!.roadmapActive).toBe(false)
  })

  it('park された Task を blocked へ escalate しない（park の取り消しになるため）', async () => {
    exhaustAttempts(storage, ids)
    const failed = createFailedJob(storage, ids, { exitCode: 99 })
    park(ids.taskId)

    await runRepairFlow(storage, { failedJob: failed }, deps())

    // blocked は roadmapActive に関係なく project を占有し、resume は park を理由に拒否する。
    // 上げてしまうと誰も解消できない状態になる。
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('pending')
  })

  it('Design Review 中に park されたら、通過していても repair Job を作らない', async () => {
    const failed = createFailedJob(storage, ids)
    const parkingDeps = {
      ...deps(),
      execute: async () => {
        park(ids.taskId)
        return { ok: true as const, stdout: ALIGNED_STDOUT, timedOut: false }
      },
    }

    const outcome = await runRepairFlow(storage, { failedJob: failed }, parkingDeps)

    expect(outcome.status).toBe('skipped')
    expect(storage.jobs.findByTaskId(ids.taskId).filter((job) => job.status === 'queued')).toHaveLength(0)
  })
})

describe('invariant 1: Human escalationの実在性', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('MAX_REPAIR_ATTEMPTS到達でTaskが既存blockedへ入る', async () => {
    const failed = exhaustAttempts(storage, ids)

    const outcome = await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(outcome.status).toBe('escalated')
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')
  })

  it('同じTaskでも別chainの失敗には予算が残っている', async () => {
    exhaustAttempts(storage, ids)
    // 使い切った chain とは繋がっていない、別の失敗。
    const unrelated = createFailedJob(storage, ids, { exitCode: 99 })

    const outcome = await runRepairFlow(storage, { failedJob: unrelated }, deps())

    expect(outcome.status).toBe('repair_job_created')
    expect(storage.tasks.findById(ids.taskId)!.status).not.toBe('blocked')
  })

  it('blocked後はrepair Jobを作らず自律repairが止まる', async () => {
    const failed = exhaustAttempts(storage, ids)
    await runRepairFlow(storage, { failedJob: failed }, deps())

    const before = storage.jobs.findByTaskId(ids.taskId).length
    const again = await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(again.status).toBe('skipped')
    expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(before)
  })

  it('blocked TaskはCEO側のAction Required集計（既存dashboard条件）に載る', async () => {
    await runRepairFlow(storage, { failedJob: exhaustAttempts(storage, ids) }, deps())

    const blocked = storage.tasks.findByProjectId(ids.projectId).filter((t) => t.status === 'blocked')
    expect(blocked.map((t) => t.id)).toContain(ids.taskId)
  })

  it('blocked Taskは既存 resumeBlockedTask 経路へ到達できる', async () => {
    await runRepairFlow(storage, { failedJob: exhaustAttempts(storage, ids) }, deps())
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')

    const resumed = storage.jobs.resumeBlockedTask({
      taskId: ids.taskId,
      instructionPrompt: 'human instruction',
    })

    // Design Review Gateは維持されるため、未reviewのpromptなら理由付きで拒否される。
    // どちらであれ resume 経路へ到達できていることが確認できる。
    // Gateは維持されるため拒否されうる。ここで示したいのは resume 経路へ到達できることなので、
    // 「呼び出しが成立し、結果が返る」ことを確認する（沈黙や例外で消えない）。
    expect(resumed).toBeDefined()
    if (resumed.ok) {
      expect(resumed.job.taskId).toBe(ids.taskId)
    } else {
      expect(typeof resumed.reason).toBe('string')
    }
  })

  it('Design Reviewが通らない修正案でもescalateしてblockedになる', async () => {
    const failed = createFailedJob(storage, ids)
    const conflicting = deps(JSON.stringify({
      focusedReviewResults: [],
      integrationReviewResult: { decision: 'CONFLICT' },
      finalDecision: 'ALIGNED',
    }))

    const outcome = await runRepairFlow(storage, { failedJob: failed }, conflicting)

    expect(outcome.status).toBe('escalated')
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')
  })
})

describe('invariant 2: Stage 2起動のidempotency', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('同一failureで複数回起動してもrepair Jobは1本だけ', async () => {
    const failed = createFailedJob(storage, ids)

    const first = await runRepairFlow(storage, { failedJob: failed }, deps())
    expect(first.status).toBe('repair_job_created')

    const second = await runRepairFlow(storage, { failedJob: failed }, deps())
    const third = await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(second.status).toBe('already_started')
    expect(third.status).toBe('already_started')

    const repairJobs = storage.jobs
      .findByTaskId(ids.taskId)
      .filter((job) => job.workflowStepKey?.startsWith('repair:'))
    expect(repairJobs).toHaveLength(1)
  })

  it('design review evidenceも重複生成されない', async () => {
    const failed = createFailedJob(storage, ids)
    await runRepairFlow(storage, { failedJob: failed }, deps())
    await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(storage.designReviewRuns.findActiveByTaskId(ids.taskId)).toBeUndefined()
    expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(1)
  })

  it('stepKeyは再利用され、attemptが勝手に進まない', async () => {
    const failed = createFailedJob(storage, ids)
    const first = await runRepairFlow(storage, { failedJob: failed }, deps())
    const second = await runRepairFlow(storage, { failedJob: failed }, deps())

    if (first.status !== 'repair_job_created' || second.status !== 'already_started') {
      throw new Error('unexpected outcomes: ' + first.status + ' / ' + second.status)
    }
    expect(second.stepKey).toBe(first.stepKey)
    // stepKeyは失敗した元Jobをanchorにする（attempt番号をanchorにすると再送で別keyになる）
    expect(first.stepKey).toBe('repair:' + failed.id + ':1')
  })

  it('workflow_step_keyはsource Job間で衝突しない', async () => {
    const otherTask = storage.tasks.create({
      projectId: ids.projectId, title: 'T2', description: 'd',
      status: 'in_progress', assignee: 'developer_ai', dependencies: [],
    })
    const other = { taskId: otherTask.id, projectId: ids.projectId }
    await runRepairFlow(storage, { failedJob: createFailedJob(storage, ids) }, deps())
    await runRepairFlow(storage, { failedJob: createFailedJob(storage, other) }, deps())

    const keys = storage.jobs.findByTaskId(ids.taskId)
      .concat(storage.jobs.findByTaskId(other.taskId))
      .map((job) => job.workflowStepKey)
      .filter((key): key is string => key?.startsWith('repair:') === true)

    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('review済みpromptがそのままrepair Jobへ渡る', () => {
  it('Job.aiCliPromptのhashがevidenceのdesignTextHashと一致する', async () => {
    const storage = createStorage()
    const ids = seed(storage)
    const failed = createFailedJob(storage, ids)

    const outcome = await runRepairFlow(storage, { failedJob: failed }, deps())
    expect(outcome.status).toBe('repair_job_created')

    if (outcome.status === 'repair_job_created') {
      const repairJob = storage.jobs.findById(outcome.jobId)!
      const evidence = storage.designReviewEvidence.findLatestByTaskId(ids.taskId)!
      expect(computeDesignTextHash(repairJob.aiCliPrompt!)).toBe(evidence.designTextHash)
    }
  })
})

describe('stepKey の一意制約 race は already_started（500 にしない）', () => {
  it('Design Review 中に同じ stepKey の Job が先に作られても already_started になる', async () => {
    const storage = createStorage()
    const ids = seed(storage)
    const failed = createFailedJob(storage, ids)

    // Design Review の実行中に「並行した別経路が先に repair Job を作った」状態を作る。
    // ここは既存 dedup の判定**より後**で Job 作成**より前**なので、本番の race window と同じ位置である。
    const racing = deps()
    const racingDeps = {
      ...racing,
      execute: async () => {
        storage.jobs.create({
          taskId: ids.taskId,
          projectId: ids.projectId,
          agentRole: 'developer_ai',
          status: 'queued',
          workflowStepKey: 'repair:' + failed.id + ':1',
          safeCommand: { kind: 'noop' },
          aiCliMode: 'implement',
          aiCliProvider: 'claude_code',
          aiCliPrompt: 'winner prompt',
        } as never)
        return { ok: true as const, stdout: ALIGNED_STDOUT, timedOut: false }
      },
    }

    const outcome = await runRepairFlow(storage, { failedJob: failed }, racingDeps)

    expect(outcome.status).toBe('already_started')
    const repairJobs = storage.jobs
      .findByTaskId(ids.taskId)
      .filter((job) => job.workflowStepKey?.startsWith('repair:'))
    expect(repairJobs).toHaveLength(1)
    expect(storage.tasks.findById(ids.taskId)!.status).not.toBe('blocked')
  })

  it('一意制約エラーの判定は実際の storage が投げるエラーで成立する', () => {
    const storage = createStorage()
    const ids = seed(storage)
    const base = {
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      workflowStepKey: 'repair:duplicate-source:1',
      safeCommand: { kind: 'noop' },
      aiCliMode: 'implement',
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'p',
    }
    storage.jobs.create(base as never)

    let caught: unknown
    try {
      storage.jobs.create(base as never)
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeDefined()
    expect(isWorkflowStepKeyConflict(caught)).toBe(true)
  })

  it('無関係なエラーは一意制約 race として扱わない', () => {
    expect(isWorkflowStepKeyConflict(new Error('disk is full'))).toBe(false)
    expect(isWorkflowStepKeyConflict(undefined)).toBe(false)
    expect(isWorkflowStepKeyConflict({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: index ux_projects_single_running' })).toBe(false)
  })
})

describe('queue 経路（executeQueuedRepair）でも race は already_started', () => {
  it('handoff が stepKey の重複で失敗したら escalate せず already_started', async () => {
    const storage = createStorage()
    const ids = seed(storage)
    const failed = createFailedJob(storage, ids)
    // source Job は所有権を保持したまま（queue intent の形）にする。
    storage.jobs.update(failed.id, { status: 'blocked' } as never)

    const preparation = prepareRepairFlow(storage, { failedJob: failed })
    if (preparation.action !== 'queue') throw new Error('fixture expected a queue preparation')
    storage.designReviewRuns.create(preparation.run)
    const run = storage.designReviewRuns.findQueued()[0]

    // Design Review の実行中に、並行経路が同じ stepKey の Job を先に作る。
    const racingDeps = {
      ...deps(),
      execute: async () => {
        storage.jobs.create({
          taskId: ids.taskId,
          projectId: ids.projectId,
          agentRole: 'developer_ai',
          status: 'queued',
          workflowStepKey: preparation.stepKey,
          safeCommand: { kind: 'noop' },
          aiCliMode: 'implement',
          aiCliProvider: 'claude_code',
          aiCliPrompt: 'winner prompt',
        } as never)
        return { ok: true as const, stdout: ALIGNED_STDOUT, timedOut: false }
      },
    }

    const outcome = await executeQueuedRepair(storage, run, preparation.stepKey, racingDeps)

    expect(outcome.status).toBe('already_started')
    expect(storage.tasks.findById(ids.taskId)!.status).not.toBe('blocked')
    const repairJobs = storage.jobs
      .findByTaskId(ids.taskId)
      .filter((job) => job.workflowStepKey?.startsWith('repair:'))
    expect(repairJobs).toHaveLength(1)
  })
})

describe('repair generation を既存 audit へ残す', () => {
  it('作られた repair Job に generation の確定事実が記録される', async () => {
    const storage = createStorage()
    const ids = seed(storage)
    const failed = createFailedJob(storage, ids, {
      workflowStepKey: 'task:' + ids.taskId + ':initial-implement',
    })

    const outcome = await runRepairFlow(storage, { failedJob: failed }, deps())
    expect(outcome.status).toBe('repair_job_created')
    if (outcome.status !== 'repair_job_created') return

    const rows = storage.auditLog
      .findByEntity('job', outcome.jobId)
      .filter((entry) => entry.operation === 'repair_generation')
    expect(rows).toHaveLength(1)
    expect(rows[0].result).toBe('continued')
    expect(rows[0].detail).toContain('generation_root=' + failed.id)
    expect(rows[0].detail).toContain('ancestry_depth=0')
    expect(rows[0].detail).toContain('budget_reset=no')
    expect(rows[0].detail).toContain('previous_generation_root=none')
    expect(rows[0].detail).toContain('reset_reason=same_generation')
  })

  it('2 本目の repair では深さが 1 として記録される', async () => {
    const storage = createStorage()
    const ids = seed(storage)
    const origin = createFailedJob(storage, ids, {
      workflowStepKey: 'task:' + ids.taskId + ':initial-implement',
    })
    const firstRepair = createFailedJob(storage, ids, {
      workflowStepKey: 'repair:' + origin.id + ':1',
      exitCode: 7,
      stderr: 'a different failure',
    })

    const outcome = await runRepairFlow(storage, { failedJob: firstRepair }, deps())
    expect(outcome.status).toBe('repair_job_created')
    if (outcome.status !== 'repair_job_created') return

    const rows = storage.auditLog
      .findByEntity('job', outcome.jobId)
      .filter((entry) => entry.operation === 'repair_generation')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toContain('generation_root=' + origin.id)
    expect(rows[0].detail).toContain('ancestry_depth=1')
  })
})
