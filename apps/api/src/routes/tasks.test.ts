import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Task } from '@ai-team/shared'

async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { taskRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./tasks.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
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

  it('POST /api/tasks creates a task', async () => {
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
})
