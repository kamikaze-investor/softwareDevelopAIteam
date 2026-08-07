import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Project, Task } from '@ai-team/shared'

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
  body: Partial<Job> = {},
): Promise<Job> {
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

async function createAutomaticReviewJob(
  app: FastifyInstance,
): Promise<{ implement: Job; project: Project; review: Job; task: Task }> {
  const project = await createProject(app)
  const taskResponse = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: {
      projectId: project.id,
      title: 'Structured review task',
      description: 'Implement the approved requirement.',
      assignee: 'developer_ai',
    },
  })
  expect(taskResponse.statusCode).toBe(201)
  const task = parseBody<Task>(taskResponse.body)
  const initialJobs = parseBody<Job[]>((await app.inject({
    method: 'GET',
    url: `/api/jobs?taskId=${task.id}`,
  })).body)
  const implement = initialJobs[0]
  const implementResult = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${implement.id}`,
    payload: {
      status: 'success',
      exitCode: 0,
      changedFiles: ['src/feature.ts'],
      guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    },
  })
  expect(implementResult.statusCode).toBe(200)
  const jobs = parseBody<Job[]>((await app.inject({
    method: 'GET',
    url: `/api/jobs?taskId=${task.id}`,
  })).body)
  const review = jobs.find((job) => job.aiCliMode === 'review')
  if (!review) throw new Error('Automatic review Job was not created')
  return { implement, project, review, task }
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
})

describe('Job API', () => {
  it('GET /api/jobs returns 400 without taskId', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs' })

      expect(res.statusCode).toBe(400)
      expect(parseBody<{ error: string }>(res.body).error).toBe('taskId is required')
    })
  })

  it('GET /api/jobs returns 404 for a missing task', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs?taskId=not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Task not found')
    })
  })

  it('POST /api/jobs creates a queued job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          safeCommand: { kind: 'git_status' },
          dryRun: true,
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Job>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.taskId).toBe(task.id)
      expect(body.status).toBe('queued')
      expect(body.safeCommand.kind).toBe('git_status')
      // workingDir はクライアントから受け取らず、サーバー側の正規workingDirが設定される
      expect(body.safeCommand.workingDir).toBe('/workspace/target')
      expect(body.dryRun).toBe(true)
    })
  })

  it('POST /api/jobs rejects a client-supplied workingDir with 400', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          safeCommand: { kind: 'git_status', workingDir: '/some/other/path' },
        },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it('GET /api/jobs lists task jobs', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Job[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].taskId).toBe(task.id)
    })
  })

  it('GET /api/jobs/:id returns a job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).id).toBe(created.id)
    })
  })

  it('persists aiCliProvider/aiCliPrompt/aiCliMode across a DB round-trip', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task, {
        aiCliProvider: 'codex',
        aiCliPrompt: 'Implement the requested change carefully.',
        aiCliMode: 'implement',
      })

      // POSTのレスポンスは作成直後のin-memoryオブジェクトを返すだけの可能性があるため、
      // 別リクエストでDBから再取得し、永続化が実際に効いていることを確認する
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

      expect(res.statusCode).toBe(200)
      const fetched = parseBody<Job>(res.body)
      expect(fetched.aiCliProvider).toBe('codex')
      expect(fetched.aiCliPrompt).toBe('Implement the requested change carefully.')
      expect(fetched.aiCliMode).toBe('implement')
    })
  })

  it('leaves aiCliProvider/aiCliPrompt/aiCliMode undefined when omitted (backward compatibility)', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

      expect(res.statusCode).toBe(200)
      const fetched = parseBody<Job>(res.body)
      expect(fetched.aiCliProvider).toBeUndefined()
      expect(fetched.aiCliPrompt).toBeUndefined()
      expect(fetched.aiCliMode).toBeUndefined()
    })
  })

  it('POST /api/jobs accepts a manual review Job without a client prompt', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const created = await createJob(app, task, {
        agentRole: 'qa_ai',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
      })

      expect(created.aiCliProvider).toBe('claude_code')
      expect(created.aiCliMode).toBe('review')
      expect(created.aiCliPrompt).toBeUndefined()
    })
  })

  it('POST /api/jobs rejects a client prompt for a review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'qa_ai',
          aiCliProvider: 'claude_code',
          aiCliMode: 'review',
          aiCliPrompt: 'Client-controlled review instructions',
          safeCommand: { kind: 'git_status' },
        },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it('persists a manual structured review without auto-creating a commit Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const review = await createJob(app, task, {
        agentRole: 'qa_ai',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: {
          status: 'success',
          exitCode: 0,
          reviewResult: {
            status: 'approved',
            summary: 'Manual recovery review passed.',
            findings: [],
          },
        },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).status).toBe('success')
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      expect(storage.reviewResults.findByTaskId(task.id)).toEqual([
        expect.objectContaining({ jobId: review.id, status: 'approved' }),
      ])
      expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
      expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
    })
  })

  it('GET /api/jobs/:id returns 404 for a missing job', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs/not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Job not found')
    })
  })

  it('PATCH /api/jobs/:id updates status', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { status: 'running' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).status).toBe('running')
    })
  })

  it('PATCH /api/jobs/:id/fail-if-running changes running to failed', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { status: 'running' },
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}/fail-if-running`,
        payload: {
          stderr: 'technical failure',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<{
        updated: boolean
        currentStatus: Job['status']
        job: Job
      }>(res.body)).toMatchObject({
        updated: true,
        currentStatus: 'failed',
        job: {
          id: created.id,
          status: 'failed',
          stderr: 'technical failure',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })
    })
  })

  it.each(['success', 'failed', 'blocked', 'queued'] as const)(
    'PATCH /api/jobs/:id/fail-if-running leaves %s unchanged',
    async (status) => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        if (status !== 'queued') {
          await app.inject({
            method: 'PATCH',
            url: `/api/jobs/${created.id}`,
            payload: { status },
          })
        }

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/fail-if-running`,
          payload: {
            stderr: 'must not be saved',
            completedAt: '2026-08-08T01:02:03.000Z',
          },
        })

        expect(res.statusCode).toBe(200)
        expect(parseBody<{ updated: boolean; currentStatus: Job['status']; job: Job }>(res.body))
          .toMatchObject({ updated: false, currentStatus: status, job: { status } })
      })
    },
  )

  it('PATCH /api/jobs/:id/fail-if-running returns 404 for a missing Job', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/jobs/missing-job/fail-if-running',
        payload: {
          stderr: 'technical failure',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Job not found')
    })
  })

  it('PATCH /api/jobs/:id updates exitCode', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { exitCode: 0 },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).exitCode).toBe(0)
    })
  })

  it('PATCH /api/jobs/:id rejects client-supplied approvalId', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { approvalId: 'client-controlled-approval' },
      })

      expect(res.statusCode).toBe(400)
      const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
      expect(parseBody<Job>(fetched.body).approvalId).toBeUndefined()
    })
  })

  it('PATCH /api/jobs/:id updates log previews and paths', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          stdout: 'preview stdout',
          stderr: 'preview stderr',
          stdoutPath: '/workspace/target/data/logs/job-1/stdout.txt',
          stderrPath: '/workspace/target/data/logs/job-1/stderr.txt',
        },
      })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Job>(res.body)
      expect(body.stdout).toBe('preview stdout')
      expect(body.stderr).toBe('preview stderr')
      expect(body.stdoutPath).toBe('/workspace/target/data/logs/job-1/stdout.txt')
      expect(body.stderrPath).toBe('/workspace/target/data/logs/job-1/stderr.txt')
    })
  })

  it('PATCH /api/jobs/:id creates one review Job after a successful changed implementation', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Automatic implementation',
          assignee: 'developer_ai',
        },
      })
      const task = parseBody<Task>(taskResponse.body)
      const initialJobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      const implement = parseBody<Job[]>(initialJobsResponse.body)[0]
      const successfulResult = {
        status: 'success' as const,
        exitCode: 0,
        changedFiles: ['src/feature.ts'],
        guardResult: {
          permissionAllowed: true,
          fileChangeAllowed: true,
        },
      }

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: successfulResult,
      })
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: successfulResult,
      })

      expect(first.statusCode).toBe(200)
      expect(resend.statusCode).toBe(200)
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      const jobs = parseBody<Job[]>(jobsResponse.body)
      expect(jobs).toHaveLength(2)
      const reviewJob = jobs.find((job) => job.aiCliMode === 'review')
      expect(reviewJob).toMatchObject({
        workflowStepKey: `implement:${implement.id}:review`,
        agentRole: 'qa_ai',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
        status: 'queued',
      })
      expect(reviewJob?.aiCliPrompt).toBeUndefined()
    })
  })

  it.each([
    ['implement failed', { status: 'failed', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: true, fileChangeAllowed: true } }],
    ['changedFiles is empty', { status: 'success', exitCode: 0, changedFiles: [], guardResult: { permissionAllowed: true, fileChangeAllowed: true } }],
    ['SafeCommand failed', { status: 'failed', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: true, fileChangeAllowed: true } }],
    ['permission guard failed', { status: 'blocked', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: false, fileChangeAllowed: true } }],
    ['file guard failed', { status: 'blocked', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: true, fileChangeAllowed: false } }],
  ])('does not create a review Job when %s', async (_label, resultPayload) => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Stopped implementation',
          assignee: 'developer_ai',
        },
      })
      const task = parseBody<Task>(taskResponse.body)
      const initialJobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      const implement = parseBody<Job[]>(initialJobsResponse.body)[0]

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: resultPayload,
      })

      expect(updateResponse.statusCode).toBe(200)
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      expect(parseBody<Job[]>(jobsResponse.body)).toHaveLength(1)
    })
  })

  it('does not advance a manual implement Job and rejects client workflowStepKey input', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const rejectedCreate = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          workflowStepKey: 'client-controlled-key',
          agentRole: 'developer_ai',
          safeCommand: { kind: 'test' },
        },
      })
      expect(rejectedCreate.statusCode).toBe(400)

      const manualResponse = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          aiCliProvider: 'claude_code',
          aiCliPrompt: 'Manual recovery',
          aiCliMode: 'implement',
          safeCommand: { kind: 'test' },
        },
      })
      expect(manualResponse.statusCode).toBe(201)
      const manual = parseBody<Job>(manualResponse.body)
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${manual.id}`,
        payload: {
          status: 'success',
          exitCode: 0,
          changedFiles: ['src/manual.ts'],
          guardResult: { permissionAllowed: true, fileChangeAllowed: true },
        },
      })

      expect(updateResponse.statusCode).toBe(200)
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      expect(parseBody<Job[]>(jobsResponse.body)).toHaveLength(1)
    })
  })

  it('persists an approved structured review and creates one git_commit Job idempotently', async () => {
    await withApp(async (app) => {
      const { review, task } = await createAutomaticReviewJob(app)
      const verdict = {
        status: 'approved' as const,
        summary: 'All requirements are satisfied.',
        findings: [],
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${review.id}`,
          payload: {
            status: 'success',
            exitCode: 0,
            changedFiles: ['src/feature.ts'],
            guardResult: { permissionAllowed: true, fileChangeAllowed: true },
            reviewResult: verdict,
          },
        })
        expect(response.statusCode).toBe(200)
        expect(parseBody<Job>(response.body).status).toBe('success')
      }

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const reviewResults = storage.reviewResults.findByTaskId(task.id)
      expect(reviewResults).toHaveLength(1)
      expect(reviewResults[0]).toMatchObject({
        taskId: task.id,
        jobId: review.id,
        reviewer: 'qa_ai',
        ...verdict,
      })
      const jobs = storage.jobs.findByTaskId(task.id)
      const commitJobs = jobs.filter((job) => job.safeCommand.kind === 'git_commit')
      expect(commitJobs).toHaveLength(1)
      expect(commitJobs[0]).toMatchObject({
        workflowStepKey: `review:${review.id}:git-commit`,
        status: 'queued',
      })
      expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
    })
  })

  it.each(['changes_requested', 'rejected'] as const)(
    'persists %s as a failed review Job without creating commit or Approval',
    async (status) => {
      await withApp(async (app) => {
        const { review, task } = await createAutomaticReviewJob(app)
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${review.id}`,
          payload: {
            status: 'success',
            exitCode: 0,
            changedFiles: ['src/feature.ts'],
            guardResult: { permissionAllowed: true, fileChangeAllowed: true },
            reviewResult: {
              status,
              summary: 'CEO action is required.',
              findings: [{ severity: 'high', message: 'Blocking issue' }],
            },
          },
        })

        expect(response.statusCode).toBe(200)
        expect(parseBody<Job>(response.body).status).toBe('failed')
        const { getStorage } = await import('../storage/index.js')
        const storage = getStorage()
        expect(storage.reviewResults.findByTaskId(task.id)).toHaveLength(1)
        expect(storage.jobs.findByTaskId(task.id).filter(
          (job) => job.safeCommand.kind === 'git_commit',
        )).toEqual([])
        expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
      })
    },
  )

  it.each([
    ['unknown status', { status: 'approve', summary: 'bad', findings: [] }],
    ['unknown severity', { status: 'approved', summary: 'bad', findings: [{ severity: 'major', message: 'bad' }] }],
    ['missing required field', { status: 'approved', findings: [] }],
    ['extra field', { status: 'approved', summary: 'bad', findings: [], verdict: 'approved' }],
  ])('rejects structured review with %s and saves no ReviewResult', async (_label, reviewResult) => {
    await withApp(async (app) => {
      const { review, task } = await createAutomaticReviewJob(app)
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: { status: 'success', reviewResult },
      })

      expect(response.statusCode).toBe(400)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().reviewResults.findByTaskId(task.id)).toEqual([])
    })
  })
})
