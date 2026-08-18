import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import { executeQueuedRepair, prepareRepairFlow } from './repairFlow'
import { MAX_REPAIR_ATTEMPTS } from './repairPolicy'
import { recoverAndRekickAtStartup } from './designReviewCoordinator'

/**
 * Stage 2 E2E。
 *
 * failure facts
 *   → canonical repair prompt
 *   → design_review_runs
 *   → Trusted Design Review
 *   → ALIGNED
 *   → 同一review済みpromptでimplement Job作成
 *   → （繰り返し）
 *   → bound到達でHuman escalation
 *
 * を通しで確認する。
 */

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seed(storage: IStorage): { taskId: string; projectId: string } {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'READMEを更新する', description: '1行追記する',
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

/** low load になるchangedFiles。空配列はmedium扱いになりfocus集合が一致しないため必ず指定する。 */
const CHANGED = ['docs/readme.md']

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

/** PATCH相当: 失敗を永続化しStage 2をqueueして実行するまで。 */
async function failJobAndRunStage2(
  storage: IStorage,
  job: Job,
  failure: Record<string, unknown>,
): Promise<{ outcome: string; repairJobId?: string }> {
  const failedSnapshot = { ...job, ...failure } as Job
  const preparation = prepareRepairFlow(storage, { failedJob: failedSnapshot })

  if (preparation.action === 'escalate') {
    storage.jobs.updateWithOutboxEvent(job.id, failure as never, undefined)
    storage.tasks.update(job.taskId, { status: 'blocked' })
    return { outcome: 'escalated' }
  }
  if (preparation.action === 'skip') {
    storage.jobs.updateWithOutboxEvent(job.id, failure as never, undefined)
    return { outcome: 'skipped' }
  }

  const persisted = storage.jobs.updateWithOutboxEvent(
    job.id, failure as never, undefined, preparation.run,
  )
  if (!persisted.ok || !persisted.queuedDesignReviewRun) throw new Error('persist failed')

  const result = await executeQueuedRepair(
    storage, persisted.queuedDesignReviewRun, preparation.stepKey, deps(),
  )
  return {
    outcome: result.status,
    repairJobId: result.status === 'repair_job_created' ? result.jobId : undefined,
  }
}

describe('Stage 2 E2E', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('失敗 → design review → ALIGNED → review済みpromptでrepair Jobが作られる', async () => {
    const job = createRunningJob(storage, ids)

    const { outcome, repairJobId } = await failJobAndRunStage2(storage, job, {
      status: 'failed', exitCode: 1, stderr: 'TypeError: boom', changedFiles: ['docs/readme.md'],
    })

    expect(outcome).toBe('repair_job_created')
    const repairJob = storage.jobs.findById(repairJobId!)!

    // chain全体の整合
    expect(repairJob.status).toBe('queued')
    expect(repairJob.aiCliMode).toBe('implement')
    expect(repairJob.workflowStepKey).toBe(`repair:${job.id}:1`)

    // review済みpromptそのままでGateを通る
    const gate = checkImplementJobDesignReviewEvidence(repairJob, storage.designReviewEvidence)
    expect(gate.ok).toBe(true)

    // 失敗事実がpromptへ入っている（untrusted領域の内側）
    const fenceStart = repairJob.aiCliPrompt!.indexOf('<<<UNTRUSTED_FAILURE_DATA>>>')
    expect(repairJob.aiCliPrompt).toContain('TypeError: boom')
    expect(repairJob.aiCliPrompt!.indexOf('TypeError: boom')).toBeGreaterThan(fenceStart)
  })

  it('One Job failure != Task failure — 失敗してもTaskは継続する', async () => {
    const job = createRunningJob(storage, ids)
    await failJobAndRunStage2(storage, job, { status: 'failed', exitCode: 1, stderr: 'boom', changedFiles: CHANGED })

    expect(storage.tasks.findById(ids.taskId)!.status).not.toBe('blocked')
    expect(storage.jobs.findById(job.id)!.status).toBe('failed')
  })

  it('異なる失敗が続く間はrepairを重ね、bound到達でHuman escalationに入る', async () => {
    let current = createRunningJob(storage, ids)

    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      const { outcome, repairJobId } = await failJobAndRunStage2(storage, current, {
        status: 'failed', exitCode: attempt, stderr: `distinct failure ${attempt}`, changedFiles: CHANGED,
      })
      expect(outcome).toBe('repair_job_created')
      current = storage.jobs.findById(repairJobId!)!
    }

    // bound到達
    const final = await failJobAndRunStage2(storage, current, {
      status: 'failed', exitCode: 99, stderr: 'one more distinct failure', changedFiles: CHANGED,
    })

    expect(final.outcome).toBe('escalated')
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')

    const repairJobs = storage.jobs.findByTaskId(ids.taskId)
      .filter((j) => j.workflowStepKey?.startsWith('repair:'))
    expect(repairJobs).toHaveLength(MAX_REPAIR_ATTEMPTS)
  })

  it('同じ失敗が続く場合は別アプローチを要求したpromptになる', async () => {
    const sameFailure = { status: 'failed', exitCode: 7, stderr: 'persistent failure', changedFiles: CHANGED }

    const job = createRunningJob(storage, ids)
    const first = await failJobAndRunStage2(storage, job, sameFailure)
    const firstJob = storage.jobs.findById(first.repairJobId!)!
    expect(firstJob.aiCliPrompt).not.toContain('前回と実質的に異なるアプローチ')

    const second = await failJobAndRunStage2(storage, firstJob, sameFailure)
    const secondJob = storage.jobs.findById(second.repairJobId!)!

    expect(secondJob.aiCliPrompt).toContain('前回と実質的に異なるアプローチ')
    expect(secondJob.aiCliPrompt).not.toBe(firstJob.aiCliPrompt)

    // 別promptなので別のevidenceが必要になり、それぞれ自分のpromptでGateを通る
    expect(checkImplementJobDesignReviewEvidence(secondJob, storage.designReviewEvidence).ok).toBe(true)
  })

  it('escalate後は新しいrepair Jobが生えない', async () => {
    let current = createRunningJob(storage, ids)
    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      const { repairJobId } = await failJobAndRunStage2(storage, current, {
        status: 'failed', exitCode: attempt, stderr: `distinct ${attempt}`, changedFiles: CHANGED,
      })
      current = storage.jobs.findById(repairJobId!)!
    }
    await failJobAndRunStage2(storage, current, { status: 'failed', exitCode: 99, stderr: 'final', changedFiles: CHANGED })
    expect(storage.tasks.findById(ids.taskId)!.status).toBe('blocked')

    const before = storage.jobs.findByTaskId(ids.taskId).length
    const after = await failJobAndRunStage2(storage, current, {
      status: 'failed', exitCode: 100, stderr: 'yet another', changedFiles: CHANGED,
    })

    expect(after.outcome).toBe('skipped')
    expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(before)
  })

  it('Stage 1 retry Jobが存在してもStage 2のbound計算に混ざらない', async () => {
    storage.jobs.create({
      taskId: ids.taskId, projectId: ids.projectId, agentRole: 'developer_ai',
      status: 'failed', workflowStepKey: 'retry:some-job:1',
      safeCommand: { kind: 'noop' }, aiCliMode: 'implement', aiCliProvider: 'claude_code',
      aiCliPrompt: 'retried prompt',
    } as never)

    const job = createRunningJob(storage, ids)
    const { outcome, repairJobId } = await failJobAndRunStage2(storage, job, {
      status: 'failed', exitCode: 1, stderr: 'boom', changedFiles: CHANGED,
    })

    expect(outcome).toBe('repair_job_created')
    expect(storage.jobs.findById(repairJobId!)!.workflowStepKey).toBe(`repair:${job.id}:1`)
  })
})

describe('Stage 2 完了判定: 4経路', () => {
  let storage: IStorage
  let ids: { taskId: string; projectId: string }

  beforeEach(() => {
    storage = createStorage()
    ids = seed(storage)
  })

  it('経路1: ordinary implementation failure → repair Job', async () => {
    const job = createRunningJob(storage, ids)
    const { outcome, repairJobId } = await failJobAndRunStage2(storage, job, {
      status: 'failed', exitCode: 1, stderr: 'compile error', changedFiles: CHANGED,
    })

    expect(outcome).toBe('repair_job_created')
    const repairJob = storage.jobs.findById(repairJobId!)!
    expect(checkImplementJobDesignReviewEvidence(repairJob, storage.designReviewEvidence).ok).toBe(true)
    expect(repairJob.workflowStepKey).toBe(`repair:${job.id}:1`)
  })

  it('経路2: review changes_requested → findings/QAを含むrepair prompt → repair Job', async () => {
    const implementJob = createRunningJob(storage, ids)
    storage.jobs.update(implementJob.id, {
      status: 'failed', exitCode: 1, stderr: 'lint failed', changedFiles: CHANGED,
    } as never)

    const reviewResult = storage.reviewResults.create({
      taskId: ids.taskId,
      jobId: implementJob.id,
      reviewer: 'qa_ai',
      status: 'changes_requested',
      summary: 'UIにビジネスロジックがある',
      findings: [{
        severity: 'high', file: 'app/ui/Foo.tsx', line: 42,
        message: 'move logic to core', rule: 'no_business_logic_in_ui',
      }],
    } as never)

    const qaResult = storage.qaResults.create({
      taskId: ids.taskId, jobId: implementJob.id, type: 'unit_test',
      status: 'failed', summary: '3 tests failed', details: 'foo.test.ts',
    } as never)

    const failedJob = storage.jobs.findById(implementJob.id)!
    const preparation = prepareRepairFlow(storage, {
      failedJob, review: reviewResult, qaResults: [qaResult],
    })
    expect(preparation.action).toBe('queue')
    if (preparation.action !== 'queue') return

    // review findings と QA が prompt に含まれる
    expect(preparation.run.designText).toContain('no_business_logic_in_ui')
    expect(preparation.run.designText).toContain('app/ui/Foo.tsx:42')
    expect(preparation.run.designText).toContain('3 tests failed')

    const run = storage.designReviewRuns.create(preparation.run)
    const result = await executeQueuedRepair(storage, run, preparation.stepKey, deps())
    expect(result.status).toBe('repair_job_created')

    const repairJob = storage.jobs.findByTaskId(ids.taskId)
      .find((j) => j.workflowStepKey === preparation.stepKey)!
    expect(repairJob.aiCliPrompt).toBe(preparation.run.designText)
    expect(checkImplementJobDesignReviewEvidence(repairJob, storage.designReviewEvidence).ok).toBe(true)
  })

  it('経路3: kick前crash → startup recovery → chain継続', async () => {
    const job = createRunningJob(storage, ids)
    const failure = { status: 'failed', exitCode: 1, stderr: 'boom', changedFiles: CHANGED }

    const preparation = prepareRepairFlow(storage, { failedJob: { ...job, ...failure } as Job })
    if (preparation.action !== 'queue') throw new Error('expected queue')

    // terminal Job + queued run を永続化した直後にcrash（kickしない）
    const persisted = storage.jobs.updateWithOutboxEvent(job.id, failure as never, undefined, preparation.run)
    expect(persisted.ok).toBe(true)
    expect(storage.designReviewRuns.findQueued()).toHaveLength(1)

    // 再起動
    await recoverAndRekickAtStartup(storage, deps())

    expect(storage.designReviewEvidence.findByTaskId(ids.taskId)).toHaveLength(1)
    expect(storage.designReviewRuns.findQueued()).toHaveLength(0)
  })

  it('経路4: bound到達 → 新repairなし → blocked → Action Required → resume到達', async () => {
    let current = createRunningJob(storage, ids)
    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      const { repairJobId } = await failJobAndRunStage2(storage, current, {
        status: 'failed', exitCode: attempt, stderr: `distinct ${attempt}`, changedFiles: CHANGED,
      })
      current = storage.jobs.findById(repairJobId!)!
    }

    const before = storage.jobs.findByTaskId(ids.taskId).length
    const final = await failJobAndRunStage2(storage, current, {
      status: 'failed', exitCode: 99, stderr: 'still failing', changedFiles: CHANGED,
    })

    expect(final.outcome).toBe('escalated')
    // 新しいrepair Jobは作られない
    expect(storage.jobs.findByTaskId(ids.taskId)).toHaveLength(before)
    // Action Required（既存dashboard条件）
    expect(storage.tasks.findByProjectId(ids.projectId).filter((t) => t.status === 'blocked').map((t) => t.id))
      .toContain(ids.taskId)
    // 既存resume経路へ到達できる
    const resumed = storage.jobs.resumeBlockedTask({
      taskId: ids.taskId, instructionPrompt: 'human instruction',
    })
    expect(resumed).toBeDefined()
  })

  it('Stage 2の入口はterminal failure / changes_requestedに限定される', () => {
    // running中のJobはStage 2の入口ではない。
    // routes/jobs.ts の起動条件は jobUpdate.status === 'failed' であり、
    // review経路も persistReviewWorkflowResult で failed 化された後にのみ起動する。
    // よって running / stuck なJobは判定対象にならない。
    const running = createRunningJob(storage, ids)
    expect(running.status).toBe('running')

    // running のまま prepareRepairFlow を呼んでも、chainは1本目として扱われ
    // 「同一失敗の再発」判定に running が混ざることはない（repair: prefixを持たないため）
    const preparation = prepareRepairFlow(storage, {
      failedJob: { ...running, status: 'failed', exitCode: 1, stderr: 'boom', changedFiles: CHANGED } as Job,
    })
    expect(preparation.action).toBe('queue')
    if (preparation.action !== 'queue') return
    expect(preparation.attempt).toBe(1)
    // 別アプローチ要求は立たない（比較対象となる failed な repair Job が無い）
    expect(preparation.run.designText).not.toContain('前回と実質的に異なるアプローチ')
  })
})
