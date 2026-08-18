import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { prepareRepairFlow, executeQueuedRepair } from './repairFlow'
import { recoverAndRekickAtStartup } from './designReviewCoordinator'

/**
 * Durable Stage 2 Initiation。
 *
 * 検証したいfailure window:
 *   1. source Job terminal update成功
 *   2. design_review_run作成前
 *   3. API process crash
 *   4. API再起動
 *
 * このとき「Jobはfailed / runは存在しない / duplicate PATCHは既にfailedなので再起動しない」
 * という状態が成立してはならない（＝Stage 2 chainが永久に失われてはならない）。
 *
 * 対策は、terminal Job update と queued design_review_run を同一transactionで確定させること。
 * 永続化さえ済めば、executor kickが落ちてもstartup recoveryが再kickできる。
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

function createRunningJob(storage: IStorage, ids: { taskId: string; projectId: string }): Job {
  return storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'running',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'implement',
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'original prompt',
  } as never)
}

const FAILURE_UPDATE = {
  status: 'failed' as const,
  exitCode: 1,
  stderr: 'TypeError: boom',
  changedFiles: ['docs/readme.md'],
}

const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

function deps() {
  return {
    runnerCommand: 'node',
    runnerArgs: [],
    homeDirectory: '/tmp/home',
    workingDir: '/tmp/work',
    execute: async () => ({ ok: true, stdout: ALIGNED_STDOUT, timedOut: false }),
  }
}

describe('Durable Stage 2 Initiation', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('terminal Job updateと同一transactionでqueued runが永続化される', () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    expect(preparation.action).toBe('queue')
    if (preparation.action !== 'queue') return

    const result = storage.jobs.updateWithOutboxEvent(
      job.id,
      FAILURE_UPDATE,
      { eventId: 'evt-1', payloadHash: 'hash-1' },
      preparation.run,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.job.status).toBe('failed')
    // Jobがfailedになった時点で、runは既に存在する
    expect(result.queuedDesignReviewRun).toBeDefined()
    expect(storage.designReviewRuns.findActiveByTaskId(ids.taskId)).toBeDefined()
  })

  it('kick前にcrashしても、queued runがstartup recoveryで再kickされる', async () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    // terminal update + queued run を永続化した直後にcrashしたとみなし、kickは行わない
    const persisted = storage.jobs.updateWithOutboxEvent(
      job.id,
      FAILURE_UPDATE,
      { eventId: 'evt-1', payloadHash: 'hash-1' },
      preparation.run,
    )
    expect(persisted.ok).toBe(true)

    // 「Jobはfailed / runは無い」という失われた状態になっていないこと
    expect(storage.jobs.findById(job.id)!.status).toBe('failed')
    const queued = storage.designReviewRuns.findQueued()
    expect(queued).toHaveLength(1)
    expect(queued[0].taskId).toBe(ids.taskId)

    // API再起動: startup recoveryがqueued runを拾って実行できる
    const results = await recoverAndRekickAtStartup(storage, deps())
    expect(results.length).toBeGreaterThan(0)
    expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(1)
  })

  it('crash後の再起動でrunがrunningのままにならない', async () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    storage.jobs.updateWithOutboxEvent(
      job.id, FAILURE_UPDATE, { eventId: 'evt-1', payloadHash: 'h' }, preparation.run,
    )
    const run = storage.designReviewRuns.findActiveByTaskId(ids.taskId)!
    // 実行中にcrashした状態を再現
    storage.designReviewRuns.claim(run.id, 3)
    expect(storage.designReviewRuns.findById(run.id)!.status).toBe('running')

    await recoverAndRekickAtStartup(storage, deps(), '9999-12-31T00:00:00.000Z')

    expect(storage.designReviewRuns.findById(run.id)!.status).not.toBe('running')
  })

  it('永続化されたrunからrepair Jobまで到達でき、chainが失われない', async () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    const persisted = storage.jobs.updateWithOutboxEvent(
      job.id, FAILURE_UPDATE, { eventId: 'evt-1', payloadHash: 'h' }, preparation.run,
    )
    if (!persisted.ok || !persisted.queuedDesignReviewRun) throw new Error('expected queued run')

    const outcome = await executeQueuedRepair(
      storage, persisted.queuedDesignReviewRun, preparation.stepKey, deps(),
    )

    expect(outcome.status).toBe('repair_job_created')
    const repairJobs = storage.jobs
      .findByTaskId(ids.taskId)
      .filter((j) => j.workflowStepKey?.startsWith('repair:'))
    expect(repairJobs).toHaveLength(1)
    expect(repairJobs[0].aiCliPrompt).toBe(preparation.run.designText)
  })

  it('Outbox再送では二重にqueued runを作らない', () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    const event = { eventId: 'evt-1', payloadHash: 'h' }
    storage.jobs.updateWithOutboxEvent(job.id, FAILURE_UPDATE, event, preparation.run)
    const resent = storage.jobs.updateWithOutboxEvent(job.id, FAILURE_UPDATE, event, preparation.run)

    expect(resent.ok).toBe(true)
    if (resent.ok) expect(resent.deduplicated).toBe(true)

    const all = storage.designReviewRuns.findQueued()
      .concat(storage.designReviewRuns.findActiveByTaskId(ids.taskId) ? [] : [])
    expect(all).toHaveLength(1)
  })

  it('既にrepair chainがある場合は新しいrunをqueueしない', () => {
    const job = createRunningJob(storage, ids)
    const first = prepareRepairFlow(storage, { failedJob: { ...job, ...FAILURE_UPDATE } as Job })
    if (first.action !== 'queue') throw new Error('expected queue')

    storage.jobs.updateWithOutboxEvent(
      job.id, FAILURE_UPDATE, { eventId: 'e1', payloadHash: 'h1' }, first.run,
    )

    const second = prepareRepairFlow(storage, { failedJob: { ...job, ...FAILURE_UPDATE } as Job })
    expect(second.action).toBe('skip')
  })
})

describe('非outbox経路もdurableである', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('outboxEventが無くてもJob failedとqueued runが同時に成立する', () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    // outboxEvent を渡さない経路
    const result = storage.jobs.updateWithOutboxEvent(
      job.id, FAILURE_UPDATE, undefined, preparation.run,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.job.status).toBe('failed')
    expect(result.queuedDesignReviewRun).toBeDefined()
    expect(storage.designReviewRuns.findQueued()).toHaveLength(1)
  })

  it('source Jobが見つからない場合はJobを作らずescalateする', async () => {
    const job = createRunningJob(storage, ids)
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...job, ...FAILURE_UPDATE } as Job,
    })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    const persisted = storage.jobs.updateWithOutboxEvent(
      job.id, FAILURE_UPDATE, undefined, preparation.run,
    )
    if (!persisted.ok || !persisted.queuedDesignReviewRun) throw new Error('expected run')

    // 存在しないsource Jobを指すstepKeyで実行する
    const outcome = await executeQueuedRepair(
      storage, persisted.queuedDesignReviewRun, 'repair:missing-job-id:1', deps(),
    )

    expect(outcome.status).toBe('escalated')
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')
    const created = storage.jobs.findByTaskId(ids.taskId)
      .filter((j) => j.workflowStepKey?.startsWith('repair:'))
    expect(created).toHaveLength(0)
  })
})
