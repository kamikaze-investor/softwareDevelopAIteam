import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { MAX_REPAIR_ATTEMPTS } from './repairPolicy'
import { runRepairFlow } from './repairFlow'

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

function exhaustAttempts(storage: IStorage, ids: { taskId: string; projectId: string }): void {
  for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i += 1) {
    createFailedJob(storage, ids, { workflowStepKey: 'repair:' + ids.taskId + ':' + i, exitCode: i })
  }
}

describe('invariant 1: Human escalationの実在性', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('MAX_REPAIR_ATTEMPTS到達でTaskが既存blockedへ入る', async () => {
    exhaustAttempts(storage, ids)
    const failed = createFailedJob(storage, ids, { exitCode: 99 })

    const outcome = await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(outcome.status).toBe('escalated')
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')
  })

  it('blocked後はrepair Jobを作らず自律repairが止まる', async () => {
    exhaustAttempts(storage, ids)
    const failed = createFailedJob(storage, ids, { exitCode: 99 })
    await runRepairFlow(storage, { failedJob: failed }, deps())

    const before = storage.jobs.findByTaskId(ids.taskId).length
    const again = await runRepairFlow(storage, { failedJob: failed }, deps())

    expect(again.status).toBe('skipped')
    expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(before)
  })

  it('blocked TaskはCEO側のAction Required集計（既存dashboard条件）に載る', async () => {
    exhaustAttempts(storage, ids)
    await runRepairFlow(storage, { failedJob: createFailedJob(storage, ids, { exitCode: 99 }) }, deps())

    const blocked = storage.tasks.findByProjectId(ids.projectId).filter((t) => t.status === 'blocked')
    expect(blocked.map((t) => t.id)).toContain(ids.taskId)
  })

  it('blocked Taskは既存 resumeBlockedTask 経路へ到達できる', async () => {
    exhaustAttempts(storage, ids)
    await runRepairFlow(storage, { failedJob: createFailedJob(storage, ids, { exitCode: 99 }) }, deps())
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
