import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approval, ApprovalStatus, ApprovalType, Project } from '@ai-team/shared'

type ApprovalWithProject = Approval & { projectId: string; projectName: string }

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
): Promise<Approval & { projectId: string }> {
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
  return parseBody<Approval & { projectId: string }>(res.body)
}

async function updateApprovalStatus(
  app: FastifyInstance,
  approvalId: string,
  status: Exclude<ApprovalStatus, 'pending'>,
): Promise<Approval> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/approvals/${approvalId}`,
    payload: { status },
  })

  expect(res.statusCode).toBe(200)
  return parseBody<Approval>(res.body)
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
})

describe('Approval API', () => {
  it('GET /api/approvals/pending returns only pending approvals with project names', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { name: 'Project A' })
      const otherProject = await createProject(app, { name: 'Project B' })

      const pending = await createApproval(app, project.id, { title: 'Pending approval' })
      const approved = await createApproval(app, project.id, { title: 'Approved approval' })
      const rejected = await createApproval(app, otherProject.id, { title: 'Rejected approval' })
      const expired = await createApproval(app, otherProject.id, { title: 'Expired approval' })

      await updateApprovalStatus(app, approved.id, 'approved')
      await updateApprovalStatus(app, rejected.id, 'rejected')
      await updateApprovalStatus(app, expired.id, 'expired')

      const res = await app.inject({ method: 'GET', url: '/api/approvals/pending' })

      expect(res.statusCode).toBe(200)
      const body = parseBody<ApprovalWithProject[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0]).toMatchObject({
        id: pending.id,
        projectId: project.id,
        projectName: 'Project A',
        title: 'Pending approval',
        status: 'pending',
      })
    })
  })

  it('GET /api/approvals/pending returns an empty list when there are no approvals', async () => {
    await withApp(async (app) => {
      await createProject(app, { name: 'Project A' })

      const res = await app.inject({ method: 'GET', url: '/api/approvals/pending' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<ApprovalWithProject[]>(res.body)).toEqual([])
    })
  })

  it('GET /api/projects/:projectId/approvals still returns pending approvals for the project', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { name: 'Project A' })
      const otherProject = await createProject(app, { name: 'Project B' })
      await createApproval(app, project.id, { title: 'Project approval' })
      await createApproval(app, otherProject.id, { title: 'Other project approval' })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Approval[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].title).toBe('Project approval')
      expect(body[0].status).toBe('pending')
    })
  })

  it('PATCH /api/approvals/:id still updates approval status and review metadata', async () => {
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

      const pending = await app.inject({ method: 'GET', url: '/api/approvals/pending' })
      expect(parseBody<ApprovalWithProject[]>(pending.body)).toEqual([])
    })
  })
})
