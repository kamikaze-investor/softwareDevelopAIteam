import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, Job, Project, SafeCommand, Task, TaskSummary } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildResumeAiCliPrompt } from './tasks'

/**
 * POST /api/jobs のリクエストボディ用の型。
 * `workingDir` はクライアントから送らない（サーバー側で正規workingDirを設定するため）。
 */
type CreateJobRequestBody = Partial<Omit<Job, 'safeCommand'>> & {
  safeCommand?: { kind: SafeCommand['kind']; params?: SafeCommand['params'] }
}

async function buildApp(): Promise<FastifyInstance> {
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
  app.register(taskRoutes, { prefix: '/api/tasks' })
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

async function createProject(app: FastifyInstance, body: Partial<Project> = {}): Promise<Project> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Test',
      goal: 'Test goal',
      designPhilosophy: [],
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Project>(res.body)
}

async function createTask(
  _app: FastifyInstance,
  projectId: string,
  body: Partial<Task> = {},
): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().tasks.create({
    projectId,
    title: 'Task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    ...body,
  })
}

async function createJob(
  app: FastifyInstance,
  task: Task,
  body: CreateJobRequestBody = {},
): Promise<Job> {
  if (body.aiCliMode === 'implement' && typeof body.aiCliPrompt === 'string') {
    await createAlignedDesignReviewEvidence(task.id, body.aiCliPrompt)
  }

  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: {
      taskId: task.id,
      projectId: task.projectId,
      agentRole: 'developer_ai',
      safeCommand: { kind: 'git_status' },
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Job>(res.body)
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

async function updateJob(
  app: FastifyInstance,
  jobId: string,
  body: Partial<Job>,
): Promise<Job> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${jobId}`,
    payload: body,
  })

  expect(res.statusCode).toBe(200)
  return parseBody<Job>(res.body)
}

async function createBlockedAiCliJob(
  app: FastifyInstance,
  task: Task,
  body: CreateJobRequestBody = {},
): Promise<Job> {
  const job = await createJob(app, task, {
    aiCliProvider: 'codex',
    aiCliPrompt: 'Initial implementation prompt',
    aiCliMode: 'implement',
    ...body,
  })

  return updateJob(app, job.id, { status: 'blocked' })
}

async function createApprovalRequest(
  taskId: string,
  body: Partial<Omit<ApprovalRequest, 'id' | 'createdAt' | 'taskId'>> = {},
  linkedJobId?: string,
): Promise<ApprovalRequest> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()

  const approvalRequest = storage.approvalRequests.create({
    taskId,
    targetBranch: 'ai/task-test',
    targetCommit: 'abc123',
    targetDiffHash: 'deadbeef',
    riskLevel: 'HIGH',
    requestedAction: 'Review changes',
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    invalidIf: [],
    ...body,
  })

  if (linkedJobId) {
    storage.jobs.update(linkedJobId, { approvalId: approvalRequest.id })
  }

  return approvalRequest
}

/** createdAt比較テスト用に、ミリ秒レベルで確実に順序を分けるための待機 */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
})

describe('Task API', () => {
  it('GET /api/tasks returns 400 without projectId', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks' })

      expect(res.statusCode).toBe(400)
      expect(parseBody<{ error: string }>(res.body).error).toBe('projectId is required')
    })
  })

  it('GET /api/tasks returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks?projectId=not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project not found')
    })
  })

  it('POST /api/tasks creates only a Task and leaves its Job list empty', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Task 1',
          assignee: 'developer_ai',
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Task>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.title).toBe('Task 1')
      expect(body.description).toBe('')
      expect(body.status).toBe('pending')
      expect(body.dependencies).toEqual([])
      expect(body).not.toHaveProperty('job')

      const jobsRes = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${body.id}`,
      })
      expect(jobsRes.statusCode).toBe(200)
      expect(parseBody<Job[]>(jobsRes.body)).toEqual([])
    })
  })

  it('POST /api/jobs rejects the new Task implement Job without Design Review evidence', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const prompt = 'Implement the reviewed Task design.'
      const taskRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Evidence-gated Task',
          description: prompt,
          assignee: 'developer_ai',
        },
      })
      expect(taskRes.statusCode).toBe(201)
      const task = parseBody<Task>(taskRes.body)

      const jobRes = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: task.projectId,
          agentRole: 'developer_ai',
          aiCliProvider: 'codex',
          aiCliPrompt: prompt,
          aiCliMode: 'implement',
          safeCommand: { kind: 'test' },
        },
      })

      expect(jobRes.statusCode).toBe(409)
      expect(parseBody<{ code: string }>(jobRes.body).code).toBe(
        'MISSING_DESIGN_REVIEW_EVIDENCE',
      )
    })
  })

  it('POST /api/jobs creates the new Task implement Job with matching ALIGNED evidence', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const prompt = 'Implement the reviewed Task design.'
      const taskRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Aligned Task',
          description: prompt,
          assignee: 'developer_ai',
        },
      })
      expect(taskRes.statusCode).toBe(201)
      const task = parseBody<Task>(taskRes.body)
      await createAlignedDesignReviewEvidence(task.id, prompt)

      const jobRes = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: task.projectId,
          agentRole: 'developer_ai',
          aiCliProvider: 'codex',
          aiCliPrompt: prompt,
          aiCliMode: 'implement',
          safeCommand: { kind: 'test' },
        },
      })

      expect(jobRes.statusCode).toBe(201)
      expect(parseBody<Job>(jobRes.body)).toMatchObject({
        taskId: task.id,
        aiCliMode: 'implement',
        aiCliPrompt: prompt,
        status: 'queued',
      })
    })
  })

  it('POST /api/tasks accepts a 50,000-character description', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const description = 'a'.repeat(50_000)

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Long description task',
          description,
          assignee: 'developer_ai',
        },
      })

      expect(res.statusCode).toBe(201)
      expect(parseBody<Task>(res.body).description).toHaveLength(50_000)
    })
  })

  it('POST /api/tasks rejects a 50,001-character description', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const description = 'a'.repeat(50_001)

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Too long description task',
          description,
          assignee: 'developer_ai',
        },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it.each(['draft', 'paused', 'running'] as const)(
    'POST /api/tasks creates a task for a %s project',
    async (projectStatus) => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: projectStatus })

        const res = await app.inject({
          method: 'POST',
          url: '/api/tasks',
          payload: {
            projectId: project.id,
            title: `${projectStatus} task`,
            assignee: 'developer_ai',
          },
        })

        expect(res.statusCode).toBe(201)
        expect(parseBody<Task>(res.body).projectId).toBe(project.id)
      })
    },
  )

  it('POST /api/tasks returns 409 for an archived project', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'archived' })

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Archived task',
          assignee: 'developer_ai',
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project is archived')
    })
  })

  it('POST /api/tasks ignores roadmap fields from the public body', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Public task',
          assignee: 'developer_ai',
          roadmapTaskKey: 'task-001',
          phase: 1,
          roadmapActive: true,
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Task>(res.body)
      expect(body.roadmapTaskKey).toBeUndefined()
      expect(body.phase).toBeUndefined()
      expect(body.roadmapActive).toBe(false)
    })
  })

  it('GET /api/tasks lists project tasks', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      await createTask(app, project.id, { title: 'T1' })
      await createTask(app, project.id, { title: 'T2', assignee: 'cto_ai' })

      const res = await app.inject({ method: 'GET', url: `/api/tasks?projectId=${project.id}` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Task[]>(res.body)
      expect(body).toHaveLength(2)
      expect(body.map((task) => task.title)).toEqual(['T1', 'T2'])
    })
  })

  it('GET /api/tasks/summary returns task summaries across projects', async () => {
    await withApp(async (app) => {
      const alpha = await createProject(app, { name: 'Alpha' })
      const beta = await createProject(app, { name: 'Beta' })
      const alphaTask = await createTask(app, alpha.id, { title: 'Alpha task' })
      const betaTask = await createTask(app, beta.id, { title: 'Beta task' })
      const alphaJob = await createJob(app, alphaTask)
      await updateJob(app, alphaJob.id, {
        status: 'running',
        startedAt: '2026-07-22T10:00:00.000Z',
      })
      await createJob(app, betaTask)
      await createApprovalRequest(alphaTask.id, { status: 'WAITING_FOR_USER' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body).toHaveLength(2)
      const summaryByTaskId = new Map(body.map((summary) => [summary.taskId, summary]))
      const alphaSummary = summaryByTaskId.get(alphaTask.id)
      const betaSummary = summaryByTaskId.get(betaTask.id)

      expect(alphaSummary?.projectName).toBe('Alpha')
      expect(betaSummary?.projectName).toBe('Beta')
      expect(alphaSummary?.latestJob?.status).toBe('running')
      expect(alphaSummary?.approvalSummary.hasWaitingApproval).toBe(true)
      expect(alphaSummary?.displayStatus).toBe('running')
    })
  })

  it('GET /api/tasks/summary maps rejected approvals to rejected_waiting_instruction', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Rejected task' })
      const blockedJob = await createJob(app, task)
      await updateJob(app, blockedJob.id, { status: 'blocked' })
      await createApprovalRequest(
        task.id,
        { status: 'REJECTED', riskLevel: 'CRITICAL' },
        blockedJob.id,
      )

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body[0].approvalSummary.hasRejectedApproval).toBe(true)
      expect(body[0].approvalSummary.latestApprovalStatus).toBe('REJECTED')
      expect(body[0].approvalSummary.latestApprovalRiskLevel).toBe('CRITICAL')
      expect(body[0].displayStatus).toBe('rejected_waiting_instruction')
    })
  })

  it('GET /api/tasks/summary shows waiting_approval only for the Approval linked to the latest blocked Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Waiting task' })
      const blockedJob = await createJob(app, task)
      await updateJob(app, blockedJob.id, { status: 'blocked' })
      const approval = await createApprovalRequest(
        task.id,
        { status: 'WAITING_FOR_USER' },
        blockedJob.id,
      )

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const [summary] = parseBody<TaskSummary[]>(res.body)
      expect(summary.latestJob?.approvalId).toBe(approval.id)
      expect(summary.displayStatus).toBe('waiting_approval')
    })
  })

  it('GET /api/tasks/summary keeps a technical Job failure visible despite its linked waiting Approval', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Technical failure task' })
      const failedJob = await createJob(app, task)
      await updateJob(app, failedJob.id, {
        status: 'failed',
        stderr: 'Worker API connection failed',
      })
      const approval = await createApprovalRequest(
        task.id,
        { status: 'WAITING_FOR_USER' },
        failedJob.id,
      )

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const [summary] = parseBody<TaskSummary[]>(res.body)
      expect(summary.approvalSummary.hasWaitingApproval).toBe(true)
      expect(summary.latestJob?.approvalId).toBe(approval.id)
      expect(summary.displayStatus).toBe('failed')
    })
  })

  it('GET /api/tasks/summary treats REJECTED as stale once a newer Job succeeds', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Retried task' })

      const blockedJob = await createJob(app, task)
      await updateJob(app, blockedJob.id, { status: 'blocked' })
      await createApprovalRequest(
        task.id,
        { status: 'REJECTED', riskLevel: 'HIGH' },
        blockedJob.id,
      )
      await wait(5)
      const newerJob = await createJob(app, task)
      await updateJob(app, newerJob.id, { status: 'success' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body[0].latestJob?.status).toBe('success')
      expect(body[0].displayStatus).toBe('completed')
    })
  })

  it('GET /api/tasks/summary treats REJECTED as stale once a newer Job is running', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Retrying task' })

      const blockedJob = await createJob(app, task)
      await updateJob(app, blockedJob.id, { status: 'blocked' })
      await createApprovalRequest(
        task.id,
        { status: 'REJECTED', riskLevel: 'HIGH' },
        blockedJob.id,
      )
      await wait(5)
      const newerJob = await createJob(app, task)
      await updateJob(app, newerJob.id, { status: 'running' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body[0].displayStatus).toBe('running')
    })
  })

  it('GET /api/tasks/summary keeps rejected_waiting_instruction when the blocked Job predates the rejection and nothing newer exists', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Still rejected task' })

      const blockedJob = await createJob(app, task)
      await updateJob(app, blockedJob.id, { status: 'blocked' })
      await wait(5)
      await createApprovalRequest(
        task.id,
        { status: 'REJECTED', riskLevel: 'CRITICAL' },
        blockedJob.id,
      )

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body[0].displayStatus).toBe('rejected_waiting_instruction')
    })
  })

  it('GET /api/tasks/summary does not show waiting_approval once a newer Job has succeeded', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { title: 'Approved and moved on task' })

      const blockedJob = await createJob(app, task)
      await updateJob(app, blockedJob.id, { status: 'blocked' })
      await createApprovalRequest(
        task.id,
        { status: 'WAITING_FOR_USER' },
        blockedJob.id,
      )
      await wait(5)
      const newerJob = await createJob(app, task)
      await updateJob(app, newerJob.id, { status: 'success' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body[0].displayStatus).not.toBe('waiting_approval')
      expect(body[0].displayStatus).toBe('completed')
    })
  })

  it('GET /api/tasks/summary applies limit', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      await createTask(app, project.id, { title: 'T1' })
      await createTask(app, project.id, { title: 'T2' })
      await createTask(app, project.id, { title: 'T3' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary?limit=2' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<TaskSummary[]>(res.body)).toHaveLength(2)
    })
  })

  it('GET /api/tasks/summary clamps limit to 100 even when a larger value is requested', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      for (let i = 0; i < 105; i++) {
        await createTask(app, project.id, { title: `T${i}` })
      }

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary?limit=200' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<TaskSummary[]>(res.body)).toHaveLength(100)
    })
  })

  it('GET /api/tasks/summary falls back to the default limit for invalid limit values', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      await createTask(app, project.id, { title: 'Only task' })

      const zero = await app.inject({ method: 'GET', url: '/api/tasks/summary?limit=0' })
      const negative = await app.inject({ method: 'GET', url: '/api/tasks/summary?limit=-5' })
      const notANumber = await app.inject({ method: 'GET', url: '/api/tasks/summary?limit=abc' })

      expect(zero.statusCode).toBe(200)
      expect(negative.statusCode).toBe(200)
      expect(notANumber.statusCode).toBe(200)
      expect(parseBody<TaskSummary[]>(zero.body)).toHaveLength(1)
      expect(parseBody<TaskSummary[]>(negative.body)).toHaveLength(1)
      expect(parseBody<TaskSummary[]>(notANumber.body)).toHaveLength(1)
    })
  })

  it('GET /api/tasks/summary orders by recent activity, not creation time', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      // A is created first (older) but gets a Job much later (recent activity)
      const taskA = await createTask(app, project.id, { title: 'Old task with recent activity' })
      await wait(5)
      // B is created after A but never gets any Job/ApprovalRequest
      const taskB = await createTask(app, project.id, { title: 'New task with no activity' })
      await wait(5)
      const jobForA = await createJob(app, taskA)
      await updateJob(app, jobForA.id, { status: 'success' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body.map((summary) => summary.taskId)).toEqual([taskA.id, taskB.id])
    })
  })

  it('GET /api/tasks/summary with limit=1 still returns the most recently active task', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const taskA = await createTask(app, project.id, { title: 'Old task with recent activity' })
      await wait(5)
      await createTask(app, project.id, { title: 'New task with no activity' })
      await wait(5)
      const jobForA = await createJob(app, taskA)
      await updateJob(app, jobForA.id, { status: 'success' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary?limit=1' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].taskId).toBe(taskA.id)
    })
  })

  it('GET /api/tasks/summary returns a stable order when activity timestamps tie', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      await createTask(app, project.id, { title: 'T1' })
      await createTask(app, project.id, { title: 'T2' })

      const first = await app.inject({ method: 'GET', url: '/api/tasks/summary' })
      const second = await app.inject({ method: 'GET', url: '/api/tasks/summary' })

      const firstIds = parseBody<TaskSummary[]>(first.body).map((summary) => summary.taskId)
      const secondIds = parseBody<TaskSummary[]>(second.body).map((summary) => summary.taskId)
      expect(firstIds).toEqual(secondIds)
    })
  })

  it('GET /api/tasks/summary status filters by the Task\'s own status, not displayStatus', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const pendingTask = await createTask(app, project.id, { title: 'Pending', status: 'pending' })
      await createTask(app, project.id, { title: 'Done', status: 'done' })

      const res = await app.inject({ method: 'GET', url: '/api/tasks/summary?status=pending' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<TaskSummary[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].taskId).toBe(pendingTask.id)
      expect(body[0].taskStatus).toBe('pending')
    })
  })

  it('GET /api/tasks/summary returns an empty array when no tasks match', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'GET',
        url: `/api/tasks/summary?projectId=${project.id}`,
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<TaskSummary[]>(res.body)).toEqual([])
    })
  })

  it('GET /api/tasks/:id returns a task', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const created = await createTask(app, project.id, { title: 'T' })

      const res = await app.inject({ method: 'GET', url: `/api/tasks/${created.id}` })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Task>(res.body).title).toBe('T')
    })
  })

  it('GET /api/tasks/:id returns 404 for a missing task', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks/not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Task not found')
    })
  })

  describe('POST /api/tasks/:id/resume', () => {
    it('creates a queued job from the latest blocked job and keeps the blocked job unchanged', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id, {
          title: 'Fix blocked deployment',
          description: 'Update only the allowed API files.',
        })
        const blockedJob = await createBlockedAiCliJob(app, task, {
          agentRole: 'developer_ai',
          safeCommand: {
            kind: 'typecheck',
            params: { testPattern: 'apps/api' },
          },
          aiCliProvider: 'codex',
          aiCliPrompt: 'Original rejected prompt',
          aiCliMode: 'implement',
        })
        const instruction = 'Use the existing storage interface and add tests.'
        await createAlignedDesignReviewEvidence(task.id, buildResumeAiCliPrompt(task, instruction))

        const res = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction },
        })

        expect(res.statusCode).toBe(201)
        const resumedJob = parseBody<Job>(res.body)
        expect(resumedJob.id).not.toBe(blockedJob.id)
        expect(resumedJob.status).toBe('queued')
        expect(resumedJob.taskId).toBe(task.id)
        expect(resumedJob.projectId).toBe(project.id)
        expect(resumedJob.agentRole).toBe(blockedJob.agentRole)
        expect(resumedJob.safeCommand).toEqual(blockedJob.safeCommand)
        expect(resumedJob.aiCliProvider).toBe('codex')
        expect(resumedJob.aiCliMode).toBe('implement')
        expect(resumedJob.aiCliPrompt).toContain('[Task] Fix blocked deployment')
        expect(resumedJob.aiCliPrompt).toContain('Update only the allowed API files.')
        expect(resumedJob.aiCliPrompt).toContain('Use the existing storage interface and add tests.')
        expect(resumedJob.aiCliPrompt).toContain('却下された操作を変更せず繰り返さないこと')

        const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
        expect(jobsRes.statusCode).toBe(200)
        const jobs = parseBody<Job[]>(jobsRes.body)
        expect(jobs).toHaveLength(2)
        const original = jobs.find((job) => job.id === blockedJob.id)
        const created = jobs.find((job) => job.id === resumedJob.id)
        expect(original?.status).toBe('blocked')
        expect(original?.aiCliPrompt).toBe('Original rejected prompt')
        expect(created?.status).toBe('queued')
      })
    })

    it('normalizes workingDir to the canonical TARGET_WORKING_DIR even if the blocked job stored a different value', async () => {
      await withApp(async (app) => {
        const { getStorage } = await import('../storage/index.js')
        const storage = getStorage()

        const project = await createProject(app)
        const task = await createTask(app, project.id)

        // POST /api/jobs は常に正規workingDirを強制するため、異なるworkingDirを持つ
        // Jobを作るにはルートを経由せずstorage層へ直接書き込む（過去データ・移行データを模倣）。
        const legacyJob = storage.jobs.create({
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          status: 'blocked',
          safeCommand: { kind: 'typecheck', workingDir: '/some/legacy/path' },
          aiCliProvider: 'codex',
          aiCliPrompt: 'legacy prompt',
          aiCliMode: 'implement',
        })
        expect(legacyJob.safeCommand.workingDir).toBe('/some/legacy/path')
        const instruction = 'Continue with the correct workingDir.'
        await createAlignedDesignReviewEvidence(task.id, buildResumeAiCliPrompt(task, instruction))

        const res = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction },
        })

        expect(res.statusCode).toBe(201)
        const resumedJob = parseBody<Job>(res.body)
        expect(resumedJob.safeCommand.workingDir).toBe('/workspace/target')
        // kind等workingDir以外のフィールドは元Jobから引き継がれる
        expect(resumedJob.safeCommand.kind).toBe('typecheck')
      })
    })

    it('rejects resume while the latest approval request is waiting for the user', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        await createBlockedAiCliJob(app, task)
        await createApprovalRequest(task.id, { status: 'WAITING_FOR_USER' })

        const res = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction: 'Try a smaller change.' },
        })

        expect(res.statusCode).toBe(400)
        expect(parseBody<{ error: string }>(res.body).error).toContain('waiting for user')

        const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
        expect(parseBody<Job[]>(jobsRes.body)).toHaveLength(1)
      })
    })

    it.each(['queued', 'running'] satisfies Job['status'][])(
      'rejects resume when a %s job already exists',
      async (activeStatus) => {
        await withApp(async (app) => {
          const project = await createProject(app)
          const task = await createTask(app, project.id)
          await createBlockedAiCliJob(app, task)
          await wait(5)
          const activeJob = await createJob(app, task, {
            aiCliProvider: 'codex',
            aiCliPrompt: 'Already retrying',
            aiCliMode: 'implement',
          })
          if (activeStatus === 'running') {
            await updateJob(app, activeJob.id, { status: 'running' })
          }

          const res = await app.inject({
            method: 'POST',
            url: `/api/tasks/${task.id}/resume`,
            payload: { instruction: 'Retry with constraints.' },
          })

          expect(res.statusCode).toBe(400)

          const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
          expect(parseBody<Job[]>(jobsRes.body)).toHaveLength(2)
        })
      },
    )

    it.each(['queued', 'running', 'success', 'failed'] satisfies Job['status'][])(
      'rejects resume when the latest job is %s',
      async (status) => {
        await withApp(async (app) => {
          const project = await createProject(app)
          const task = await createTask(app, project.id)
          const job = await createJob(app, task, {
            aiCliProvider: 'codex',
            aiCliPrompt: 'Latest job prompt',
            aiCliMode: 'implement',
          })
          if (status !== 'queued') {
            await updateJob(app, job.id, { status })
          }

          const res = await app.inject({
            method: 'POST',
            url: `/api/tasks/${task.id}/resume`,
            payload: { instruction: 'Resume with updated direction.' },
          })

          expect(res.statusCode).toBe(400)
        })
      },
    )

    it('returns 404 for a missing task', async () => {
      await withApp(async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/tasks/not-exist/resume',
          payload: { instruction: 'Retry with a narrower change.' },
        })

        expect(res.statusCode).toBe(404)
        expect(parseBody<{ error: string }>(res.body).error).toBe('Task not found')
      })
    })

    it.each(['', '   '])('rejects blank instruction input', async (instruction) => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)

        const res = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction },
        })

        expect(res.statusCode).toBe(400)
      })
    })

    it('rejects instruction input longer than 2000 characters', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)

        const res = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction: 'a'.repeat(2001) },
        })

        expect(res.statusCode).toBe(400)
      })
    })

    it('creates only one job when resume is submitted twice', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        await createBlockedAiCliJob(app, task)
        const instruction = 'Retry with the approved file list.'
        await createAlignedDesignReviewEvidence(task.id, buildResumeAiCliPrompt(task, instruction))

        const first = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction },
        })
        const second = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction },
        })

        expect(first.statusCode).toBe(201)
        expect(second.statusCode).toBe(400)

        const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
        const jobs = parseBody<Job[]>(jobsRes.body)
        expect(jobs).toHaveLength(2)
        expect(jobs.filter((job) => job.status === 'queued')).toHaveLength(1)
        expect(jobs.filter((job) => job.status === 'blocked')).toHaveLength(1)
      })
    })
  })

  it('PATCH /api/tasks/:id updates status', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const created = await createTask(app, project.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${created.id}`,
        payload: { status: 'in_progress' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Task>(res.body).status).toBe('in_progress')
    })
  })

  it('PATCH /api/tasks/:id updates provider and allowed paths', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const created = await createTask(app, project.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${created.id}`,
        payload: { provider: 'codex', allowedPaths: ['apps/api/src/'] },
      })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Task>(res.body)
      expect(body.provider).toBe('codex')
      expect(body.allowedPaths).toEqual(['apps/api/src/'])
    })
  })

  it('PATCH /api/tasks/:id does not accept roadmap fields from the public body', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const created = await createTask(app, project.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${created.id}`,
        payload: {
          title: 'Should not update',
          roadmapTaskKey: 'task-001',
          phase: 1,
          roadmapActive: true,
        },
      })

      expect(res.statusCode).toBe(400)

      const found = await app.inject({ method: 'GET', url: `/api/tasks/${created.id}` })
      expect(found.statusCode).toBe(200)
      const body = parseBody<Task>(found.body)
      expect(body.title).toBe(created.title)
      expect(body.roadmapTaskKey).toBeUndefined()
      expect(body.phase).toBeUndefined()
      expect(body.roadmapActive).toBe(false)
    })
  })

  it('POST /api/tasks returns 400 for missing assignee', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { projectId: project.id, title: 'T' },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it('POST /api/tasks returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { projectId: 'not-exist', title: 'T', assignee: 'developer_ai' },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project not found')
    })
  })

  it('GET /api/jobs?taskId continues to list task jobs', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const job = await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Job[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].id).toBe(job.id)
    })
  })
})
