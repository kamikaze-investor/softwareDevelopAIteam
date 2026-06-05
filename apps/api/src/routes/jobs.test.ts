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
  app: FastifyInstance,
  projectId: string,
  body: Partial<Task> = {},
): Promise<Task> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: {
      projectId,
      title: 'Task',
      assignee: 'developer_ai',
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Task>(res.body)
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
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Job>(res.body)
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
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
          dryRun: true,
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Job>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.taskId).toBe(task.id)
      expect(body.status).toBe('queued')
      expect(body.safeCommand.kind).toBe('git_status')
      expect(body.dryRun).toBe(true)
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
})
