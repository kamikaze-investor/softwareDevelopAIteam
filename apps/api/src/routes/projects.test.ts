import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approval, ApprovalType, Project } from '@ai-team/shared'

async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { approvalRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./approvals.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(approvalRoutes, { prefix: '/api' })
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
      name: 'Project',
      goal: 'Goal',
      designPhilosophy: [],
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Project>(res.body)
}

async function createApproval(
  app: FastifyInstance,
  projectId: string,
  body: { title?: string; reason?: string; type?: ApprovalType } = {},
): Promise<Approval> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/approvals`,
    payload: {
      title: 'Approval',
      reason: 'Need approval',
      type: 'external_service',
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Approval>(res.body)
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
})

describe('Project API', () => {
  it('GET /api/projects returns an empty list', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project[]>(res.body)).toEqual([])
    })
  })

  it('POST /api/projects creates a project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Test', goal: 'Test goal', designPhilosophy: [] },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Project>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.name).toBe('Test')
      expect(body.status).toBe('draft')
    })
  })

  it('GET /api/projects/:id returns a project', async () => {
    await withApp(async (app) => {
      const created = await createProject(app, { name: 'P', goal: 'g' })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project>(res.body).name).toBe('P')
    })
  })

  it('GET /api/projects/:id returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project not found')
    })
  })

  it('PATCH /api/projects/:id updates a project', async () => {
    await withApp(async (app) => {
      const created = await createProject(app, { name: 'Old' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${created.id}`,
        payload: { name: 'New' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project>(res.body).name).toBe('New')
    })
  })

  it('POST /api/projects returns 409 when another project is already running', async () => {
    await withApp(async (app) => {
      await createProject(app, { name: 'Running', status: 'running' })

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Second running',
          goal: 'Goal',
          designPhilosophy: [],
          status: 'running',
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Another project is already running')
    })
  })

  it('PATCH /api/projects/:id returns 409 when another project is already running', async () => {
    await withApp(async (app) => {
      await createProject(app, { name: 'Running', status: 'running' })
      const other = await createProject(app, { name: 'Other', status: 'draft' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${other.id}`,
        payload: { status: 'running' },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Another project is already running')
    })
  })

  it('PATCH /api/projects/:id allows a running project to remain running', async () => {
    await withApp(async (app) => {
      const running = await createProject(app, { name: 'Running', status: 'running' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${running.id}`,
        payload: { name: 'Still running', status: 'running' },
      })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Project>(res.body)
      expect(body.id).toBe(running.id)
      expect(body.name).toBe('Still running')
      expect(body.status).toBe('running')
    })
  })

  it('POST /api/projects allows multiple non-running projects for each status', async () => {
    await withApp(async (app) => {
      const statuses = ['draft', 'paused', 'archived'] as const

      for (const status of statuses) {
        await createProject(app, { name: `${status}-1`, status })
        await createProject(app, { name: `${status}-2`, status })
      }

      const res = await app.inject({ method: 'GET', url: '/api/projects' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project[]>(res.body)).toHaveLength(statuses.length * 2)
    })
  })

  it('POST /api/projects returns 400 for invalid input', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { goal: 'g' },
      })

      expect(res.statusCode).toBe(400)
    })
  })
})

describe('Approval API', () => {
  it('GET /api/projects/:projectId/approvals returns pending approvals', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      await createApproval(app, project.id, { title: 'A' })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Approval[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].title).toBe('A')
      expect(body[0].status).toBe('pending')
    })
  })

  it('GET /api/projects/:projectId/approvals returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/not-exist/approvals' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project not found')
    })
  })

  it('POST /api/projects/:projectId/approvals creates a pending approval', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/approvals`,
        payload: {
          title: 'Deploy',
          reason: 'Need deployment approval',
          type: 'deployment',
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Approval>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.title).toBe('Deploy')
      expect(body.status).toBe('pending')
    })
  })

  it('POST /api/projects/:projectId/approvals returns 400 for invalid input', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/approvals`,
        payload: { title: 'Missing reason', type: 'security' },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it('PATCH /api/approvals/:id updates approval status and review metadata', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const approval = await createApproval(app, project.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/approvals/${approval.id}`,
        payload: { status: 'approved', reviewNote: 'ok' },
      })

      expect(res.statusCode).toBe(200)
      const updated = parseBody<Approval>(res.body)
      expect(updated.status).toBe('approved')
      expect(updated.reviewNote).toBe('ok')
      expect(updated.reviewedAt).toBeTruthy()

      const pending = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals` })
      expect(parseBody<Approval[]>(pending.body)).toEqual([])
    })
  })

  it('PATCH /api/approvals/:id returns 404 for a missing approval', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/approvals/not-exist',
        payload: { status: 'rejected' },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Approval not found')
    })
  })
})
