import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeJobUpdate, type Job, type Project, type Task } from '@ai-team/shared'
import { REPAIR_STEP_PREFIX, decideRepairAction } from '../designReview/repairPolicy'
import { prepareRepairFlow } from '../designReview/repairFlow'

/**
 * repair Job success後にreview Jobが生成されず停止していた問題の修正検証。
 *
 * 対象: apps/api/src/routes/jobs.ts の shouldCreateReview 拡張
 *   （REPAIR_STEP_PREFIX を再利用し、repair Jobもinitial-implement Jobと同じ
 *   「成功したらreviewが必要」という既存責務に統合する）。
 *
 * 既存のreview→repair遷移・attempt上限・dedup機構（repairPolicy.ts / repairFlow.ts）は
 * 変更していないため、それらはユニットレベル（prepareRepairFlow / decideRepairAction）で
 * 直接検証し、LLMを呼ぶ非同期実行（executeQueuedRepair）は経由しない。
 */

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ jobRoutes }, { resetStorage }] = await Promise.all([
    import('./jobs.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return app
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp()
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

function parseBody<T>(body: string): T {
  return JSON.parse(body) as T
}

function withOutbox<T extends Record<string, unknown>>(
  payload: T,
  eventId: string,
): T & { eventId: string; payloadHash: string } {
  return {
    ...payload,
    eventId,
    payloadHash: createHash('sha256').update(canonicalizeJobUpdate(payload)).digest('hex'),
  }
}

async function createProject(): Promise<Project> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().projects.create({
    name: 'repair-review reconnect test project',
    goal: 'Verify repair success reconnects to review',
    designPhilosophy: [],
    status: 'running',
  })
}

async function createTask(projectId: string): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().tasks.create({
    projectId,
    title: 'repair-review reconnect target task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
}

async function createInitialImplementJob(task: Task): Promise<Job> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    workflowStepKey: `task:${task.id}:initial-implement`,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'Implement the reviewed requirement.',
    aiCliMode: 'implement',
  })
}

/** 既存のrepair生成経路（repairPolicy.decideRepairAction）が払い出すkeyでrepair Jobを直接用意する。 */
async function createRepairJob(sourceJob: Job, task: Task): Promise<Job> {
  const { getStorage } = await import('../storage/index.js')
  const decision = decideRepairAction(sourceJob.id, [], {
    exitCode: 1,
    stderr: 'review requested changes',
  })
  if (decision.action !== 'repair') {
    throw new Error('test setup expected a repair decision')
  }
  return getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    workflowStepKey: decision.stepKey,
    agentRole: sourceJob.agentRole,
    status: 'queued',
    safeCommand: sourceJob.safeCommand,
    aiCliProvider: sourceJob.aiCliProvider,
    aiCliPrompt: 'Repair prompt (already design-reviewed).',
    aiCliMode: 'implement',
  })
}

function successPatchPayload(overrides: Partial<Job> = {}): Record<string, unknown> {
  return {
    status: 'success',
    exitCode: 0,
    changedFiles: ['test.js'],
    guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    ...overrides,
  }
}

async function reviewJobsOf(taskId: string): Promise<Job[]> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().jobs.findByTaskId(taskId).filter((job) => job.aiCliMode === 'review')
}

describe('repair success reconnects to the existing review-creation flow', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
  })

  it('1. initial implement success still creates exactly one review Job (regression, unchanged)', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const implement = await createInitialImplementJob(task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: successPatchPayload(),
      })

      expect(res.statusCode).toBe(200)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].workflowStepKey).toBe(`implement:${implement.id}:review`)
    })
  })

  it('2. a review requesting changes prepares a repair Job with the existing repairPolicy stepKey (unchanged transition)', async () => {
    const { getStorage, resetStorage } = await import('../storage/index.js')
    resetStorage()
    const storage = getStorage()
    const project = storage.projects.create({
      name: 'unit-level repair transition', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 't', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [],
    })
    const implement = storage.jobs.create({
      taskId: task.id, projectId: project.id, workflowStepKey: `task:${task.id}:initial-implement`,
      agentRole: 'developer_ai', status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      aiCliProvider: 'claude_code', aiCliPrompt: 'p', aiCliMode: 'implement',
      changedFiles: ['test.js'],
    })

    const preparation = prepareRepairFlow(storage, {
      failedJob: implement,
      review: { id: 'rr-1', jobId: 'review-1', taskId: task.id, status: 'changes_requested', summary: 's', findings: [], reviewer: 'qa_ai', createdAt: new Date().toISOString() },
    })

    expect(preparation.action).toBe('queue')
    if (preparation.action === 'queue') {
      expect(preparation.stepKey).toBe(`${REPAIR_STEP_PREFIX}${implement.id}:1`)
    }
  })

  it('3. repair Job success creates exactly one NEW review Job (the fix under test)', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const initial = await createInitialImplementJob(task)
      const repair = await createRepairJob(initial, task)
      expect(repair.workflowStepKey).toBe(`${REPAIR_STEP_PREFIX}${initial.id}:1`)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${repair.id}`,
        payload: successPatchPayload(),
      })

      expect(res.statusCode).toBe(200)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].workflowStepKey).toBe(`implement:${repair.id}:review`)
    })
  })

  it('4. re-processing the same repair success (Outbox resend) does not duplicate the review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const initial = await createInitialImplementJob(task)
      const repair = await createRepairJob(initial, task)
      const payload = successPatchPayload()
      const eventId = 'repair-success-once'

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${repair.id}`,
        payload: withOutbox(payload, eventId),
      })
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${repair.id}`,
        payload: withOutbox(payload, eventId),
      })

      expect(first.statusCode).toBe(200)
      expect(resend.statusCode).toBe(200)
      expect(parseBody<{ outbox?: { deduplicated: boolean } }>(resend.body).outbox?.deduplicated).toBe(true)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
    })
  })

  it('5. repair Job failure does not create a review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const initial = await createInitialImplementJob(task)
      const repair = await createRepairJob(initial, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${repair.id}`,
        payload: {
          status: 'failed',
          exitCode: 1,
          stderr: 'repair attempt failed again',
          changedFiles: ['test.js'],
          guardResult: { permissionAllowed: true, fileChangeAllowed: true },
        },
      })

      expect(res.statusCode).toBe(200)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(0)
    })
  })

  it('6. a second repair chained off a failed repair gets a distinct, non-colliding stepKey', async () => {
    const { getStorage, resetStorage } = await import('../storage/index.js')
    resetStorage()
    const storage = getStorage()
    const project = storage.projects.create({
      name: 'chained repair keys', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 't', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [],
    })
    const initial = storage.jobs.create({
      taskId: task.id, projectId: project.id, workflowStepKey: `task:${task.id}:initial-implement`,
      agentRole: 'developer_ai', status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      aiCliProvider: 'claude_code', aiCliPrompt: 'p', aiCliMode: 'implement',
    })
    const firstRepair = storage.jobs.create({
      taskId: task.id, projectId: project.id, workflowStepKey: `${REPAIR_STEP_PREFIX}${initial.id}:1`,
      agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      aiCliProvider: 'claude_code', aiCliPrompt: 'repair 1', aiCliMode: 'implement',
      exitCode: 1, stderr: 'still failing, different reason this time',
    })

    // repairPolicy自身のattempt上限（MAX_REPAIR_ATTEMPTS）とdedupの範囲内で、
    // 失敗したrepair Job自身をsourceJobIdとした次のrepairが既存キー規約どおりに払い出されることを確認する。
    const nextDecision = decideRepairAction(firstRepair.id, [
      { workflowStepKey: initial.workflowStepKey, status: initial.status, facts: {} },
      { workflowStepKey: firstRepair.workflowStepKey, status: firstRepair.status, facts: { exitCode: 1, stderr: 'still failing, different reason this time' } },
    ], { exitCode: 1, stderr: 'a genuinely different failure reason' })

    expect(nextDecision.action).toBe('repair')
    if (nextDecision.action === 'repair') {
      expect(nextDecision.stepKey).toBe(`${REPAIR_STEP_PREFIX}${firstRepair.id}:1`)
      expect(nextDecision.stepKey).not.toBe(firstRepair.workflowStepKey)
    }
  })

  it('7. after repair success creates a review Job, an approved review still proceeds to the normal git_commit path', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const initial = await createInitialImplementJob(task)
      const repair = await createRepairJob(initial, task)

      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${repair.id}`,
        payload: successPatchPayload(),
      })
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
      const review = reviews[0]

      const reviewRes = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: {
          status: 'success',
          exitCode: 0,
          changedFiles: ['test.js'],
          guardResult: { permissionAllowed: true, fileChangeAllowed: true },
          reviewResult: { status: 'approved', summary: 'looks good', findings: [] },
        },
      })

      expect(reviewRes.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      const commitJobs = getStorage().jobs.findByTaskId(task.id).filter((j) => j.safeCommand.kind === 'git_commit')
      expect(commitJobs).toHaveLength(1)
      expect(commitJobs[0].workflowStepKey).toBe(`review:${review.id}:git-commit`)
    })
  })
})
