import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeJobUpdate, type Job, type Project, type Task } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildResumeAiCliPrompt, type TaskRouteOptions } from './tasks'
import { ensureTaskContinuation } from '../ctoAi/taskContinuation'
import { createInitialImplementWorkflow } from '../ctoAi/initialImplementWorkflow'

// 次Task自動開始（ensureTaskContinuation → createInitialImplementWorkflow）の確認は、
// 既存のtaskContinuation.test.tsと同じ確立済みパターン（module-levelでcreateInitialImplementWorkflow
// をmockする）を使う。ensureTaskContinuation自身はDesign Review deps注入点を公開していないため
// （常にbuildDefaultCoordinatorDeps=実subprocessを使う設計）、これが唯一の既存の確認方法。
vi.mock('../ctoAi/initialImplementWorkflow', () => ({
  createInitialImplementWorkflow: vi.fn(),
}))
const createInitialImplementWorkflowMock = vi.mocked(createInitialImplementWorkflow)

/**
 * resumeBlockedTask() 経由のJob成功後にreview Jobが生成されず、通常の
 * review→git_commit→Task done→continuationへ自動的に戻れなかった問題の修正検証。
 *
 * 対象: apps/api/src/routes/jobs.ts の shouldCreateReview 拡張（isResumeImplementJob）
 *   と apps/api/src/storage/sqlite.ts の resumeBlockedTask()（AI-CLI分岐に
 *   workflowStepKey: `resume:<元Job>:1` を付与）。
 *
 * 既存のreview→git_commit→continuation機構（jobs.ts / sqlite.ts の
 * persistCommitSuccessWithContinuation / taskContinuation.ts）は変更していないため、
 * repairReviewReconnect.test.ts と同じ形で、実際のroute経由で確認する
 * （継続先Task選定のensureTaskContinuationだけは既存の慣例どおりunit経由で確認する）。
 */

async function buildApp(taskRouteOptions: TaskRouteOptions = {}): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ projectRoutes }, { taskRoutes }, { jobRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./tasks.js'),
    import('./jobs.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks', ...taskRouteOptions })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return app
}

async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  taskRouteOptions: TaskRouteOptions = {},
): Promise<void> {
  const app = await buildApp(taskRouteOptions)
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

/**
 * storage経由で直接 status: 'running' のProjectを作る。POST /api/projects → PATCH .../running
 * を経由すると、hasActiveRoadmap=false（Taskがまだ無い）の間はPATCH自身がinitializeApprovedProject
 * （実CTO AI roadmap生成、ANTHROPIC_API_KEY必須）を起動してしまう
 * （apps/api/src/routes/projects.ts）。既存のtaskContinuation.test.ts / .storage.test.ts と
 * 同じ「storageへ直接running状態で作る」fixtureパターンを使い、この既存の別経路（本修正の対象外）
 * を経由しない。
 */
async function createProject(_app: FastifyInstance): Promise<Project> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().projects.create({
    name: 'resume-review reconnect test project',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  })
}

async function createTask(app: FastifyInstance, projectId: string, body: Partial<Task> = {}): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().tasks.create({
    projectId,
    title: 'resume-review reconnect target task',
    description: 'Implement the reviewed requirement.',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    ...body,
  })
}

async function createAlignedDesignReviewEvidence(taskId: string, designText: string): Promise<void> {
  const { getStorage } = await import('../storage/index.js')
  getStorage().designReviewEvidence.create({
    taskId,
    designTextHash: computeDesignTextHash(designText),
    reviewLoad: 'medium',
    decision: 'ALIGNED',
    independentReviewRequired: false,
  })
}

/** 既存のresumeBlockedTask()経路で、AI-CLI implement Jobをblocked状態から用意する。 */
async function createBlockedImplementJob(app: FastifyInstance, task: Task): Promise<Job> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()
  await createAlignedDesignReviewEvidence(task.id, 'Original blocked prompt')
  const job = storage.jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'Original blocked prompt',
    aiCliMode: 'implement',
  })
  storage.jobs.update(job.id, { status: 'blocked' })
  return { ...job, status: 'blocked' }
}

/** POST /api/tasks/:id/resume を実際に叩き、resumeBlockedTask()が作るJobを取得する。 */
async function resumeTask(app: FastifyInstance, taskId: string, instruction: string): Promise<Job> {
  await createAlignedDesignReviewEvidence(taskId, buildResumeAiCliPrompt(
    (await (await import('../storage/index.js')).getStorage().tasks.findById(taskId))!,
    instruction,
  ))
  const res = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/resume`,
    payload: { instruction },
  })
  expect(res.statusCode).toBe(201)
  return parseBody<Job>(res.body)
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

describe('resume success reconnects to the existing review-creation flow', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
    vi.useRealTimers()
  })

  it('1. resumed implement Job success creates exactly one review Job (the fix under test)', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const blocked = await createBlockedImplementJob(app, task)
      const resumed = await resumeTask(app, task.id, 'Use the reviewer-approved narrower approach.')
      expect(resumed.id).not.toBe(blocked.id)
      expect(resumed.workflowStepKey).toBe(`resume:${blocked.id}:1`)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${resumed.id}`,
        payload: successPatchPayload(),
      })

      expect(res.statusCode).toBe(200)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].workflowStepKey).toBe(`implement:${resumed.id}:review`)
    })
  })

  it('2. re-processing the same resumed-Job success (Outbox resend) does not duplicate the review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      await createBlockedImplementJob(app, task)
      const resumed = await resumeTask(app, task.id, 'Use the reviewer-approved narrower approach.')
      const payload = successPatchPayload()
      const eventId = 'resume-success-once'

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${resumed.id}`,
        payload: withOutbox(payload, eventId),
      })
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${resumed.id}`,
        payload: withOutbox(payload, eventId),
      })

      expect(first.statusCode).toBe(200)
      expect(resend.statusCode).toBe(200)
      expect(parseBody<{ outbox?: { deduplicated: boolean } }>(resend.body).outbox?.deduplicated).toBe(true)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
    })
  })

  it('3. resumed implement Job failure does not create a review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      await createBlockedImplementJob(app, task)
      const resumed = await resumeTask(app, task.id, 'Use the reviewer-approved narrower approach.')

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${resumed.id}`,
        payload: {
          status: 'failed',
          exitCode: 1,
          stderr: 'resumed attempt failed again',
          changedFiles: ['test.js'],
          guardResult: { permissionAllowed: true, fileChangeAllowed: true },
        },
      })

      expect(res.statusCode).toBe(200)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(0)
    })
  })

  it('4. initial implement / repair Jobs are unaffected (regression, unchanged prefixes still recognized)', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const initial = getStorage().jobs.create({
        taskId: task.id,
        projectId: project.id,
        workflowStepKey: `task:${task.id}:initial-implement`,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        aiCliProvider: 'claude_code',
        aiCliPrompt: 'p',
        aiCliMode: 'implement',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${initial.id}`,
        payload: successPatchPayload(),
      })

      expect(res.statusCode).toBe(200)
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].workflowStepKey).toBe(`implement:${initial.id}:review`)
    })
  })

  it('5. after resume success creates a review Job, an approved review proceeds through the normal git_commit → Task done → continuation path', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const project = await createProject(app)
      const source = await createTask(app, project.id, { roadmapActive: true, phase: 1 })
      // 継続先(next eligible task)。dependenciesにsourceを指定し、sourceがdoneになった時だけ
      // selectNextContinuableTask()から選ばれる既存の依存判定をそのまま使う。
      const next = await createTask(app, project.id, {
        title: 'next eligible task',
        roadmapActive: true,
        phase: 2,
        dependencies: [source.id],
      })
      await createBlockedImplementJob(app, source)
      const resumed = await resumeTask(app, source.id, 'Use the reviewer-approved narrower approach.')

      // resumed implement success → review自動生成（本修正）
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${resumed.id}`,
        payload: successPatchPayload(),
      })
      const reviews = await reviewJobsOf(source.id)
      expect(reviews).toHaveLength(1)
      const review = reviews[0]

      // review approved → git_commit自動生成（既存の未変更経路）
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
      const commitJobs = storage.jobs.findByTaskId(source.id).filter((j) => j.safeCommand.kind === 'git_commit')
      expect(commitJobs).toHaveLength(1)
      const commit = commitJobs[0]
      expect(commit.workflowStepKey).toBe(`review:${review.id}:git-commit`)

      // git_commit success → Task done + continuation row（既存の未変更経路、jobs.ts経由）。
      // ensureTaskContinuationは非同期fire-and-forget（PATCH自体は継続をtriggerするだけで
      // 完了を待たない、既存の意図的挙動）なので、PATCHのレスポンスコード自体では待たない。
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${commit.id}`,
        payload: { status: 'success', exitCode: 0, changedFiles: ['test.js'] },
      })

      expect(storage.tasks.findById(source.id)?.status).toBe('done')
      const continuation = storage.taskContinuations.findBySourceJobId(commit.id)
      expect(continuation).toMatchObject({
        completedTaskId: source.id,
        nextTaskId: next.id,
        status: 'pending',
      })

      // 次Task自動開始（ensureTaskContinuation → createInitialImplementWorkflow）:
      // 既存のtaskContinuation.test.tsと同じ確立済みパターン（module-level mock）で確認する。
      const nextJob: Job = {
        id: 'next-task-initial-implement-job',
        taskId: next.id,
        projectId: next.projectId,
        workflowStepKey: `task:${next.id}:initial-implement`,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        aiCliProvider: 'claude_code',
        aiCliPrompt: next.description,
        aiCliMode: 'implement',
        createdAt: new Date().toISOString(),
      }
      createInitialImplementWorkflowMock.mockResolvedValueOnce({
        taskId: next.id,
        status: 'created',
        job: nextJob,
      })
      // mockはJobをstorageへ書き込まない（createInitialImplementWorkflow自体を丸ごと
      // 差し替えているため）。ensureTaskContinuationは戻り値のstatusだけを見てcontinuationを
      // completedにするので、実際のJob行は既存のcreateInitialImplementWorkflow自身のテスト
      // （initialImplementWorkflow.test.ts）で別途検証済みの経路として、ここではstorageへ
      // 直接作成してmockの結果と一致させる。
      storage.jobs.create({
        taskId: nextJob.taskId,
        projectId: nextJob.projectId,
        workflowStepKey: nextJob.workflowStepKey,
        agentRole: nextJob.agentRole,
        status: nextJob.status,
        safeCommand: nextJob.safeCommand,
        aiCliProvider: nextJob.aiCliProvider,
        aiCliPrompt: nextJob.aiCliPrompt,
        aiCliMode: nextJob.aiCliMode,
      })

      await ensureTaskContinuation(storage, continuation!.id)

      expect(createInitialImplementWorkflowMock).toHaveBeenCalledWith(storage, next.id)
      expect(storage.taskContinuations.findById(continuation!.id)?.status).toBe('completed')
      const nextJobs = storage.jobs.findByTaskId(next.id)
      expect(nextJobs).toHaveLength(1)
      expect(nextJobs[0].workflowStepKey).toBe(`task:${next.id}:initial-implement`)
      expect(nextJobs[0].status).toBe('queued')
    })
  })

  it('6. a second resume (task blocked again after the first resumed Job) gets its own workflowStepKey and does not duplicate the review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const blocked = await createBlockedImplementJob(app, task)
      const firstResume = await resumeTask(app, task.id, 'First attempt: narrower approach.')
      expect(firstResume.workflowStepKey).toBe(`resume:${blocked.id}:1`)

      // 最初のresumed Jobも失敗し、再びblockedへ（既存のcreateBlockedImplementJobと同じ
      // 直接blocked化パターン。resumeBlockedTask()はlatestJob.status==='blocked'を要求する）。
      const { getStorage } = await import('../storage/index.js')
      getStorage().jobs.update(firstResume.id, { status: 'blocked' })

      const secondResume = await resumeTask(app, task.id, 'Second attempt: even narrower approach.')
      expect(secondResume.id).not.toBe(firstResume.id)
      // anchorは直前のblocked Job(=firstResume)のid。retry:/repair:と同じ
      // 「anchorはsourceJobId」規約により、1回目のresumeキーと衝突しない。
      expect(secondResume.workflowStepKey).toBe(`resume:${firstResume.id}:1`)
      expect(secondResume.workflowStepKey).not.toBe(firstResume.workflowStepKey)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${secondResume.id}`,
        payload: successPatchPayload(),
      })

      expect(res.statusCode).toBe(200)
      // 1回目のresumed Jobは一度も成功していないためreviewを作らず（testケース3と同じ挙動）、
      // 2回目のresumed Jobの成功だけがreviewを作る: 合計でちょうど1件。
      const reviews = await reviewJobsOf(task.id)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].workflowStepKey).toBe(`implement:${secondResume.id}:review`)
    })
  })
})
