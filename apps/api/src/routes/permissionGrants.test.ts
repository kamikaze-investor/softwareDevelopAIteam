import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PermissionGrant } from '@ai-team/shared'

async function buildApp(): Promise<FastifyInstance> {
  // テストごとにインメモリDBを使用（ファイルDBだとテスト間でデータが残る）
  process.env.DB_PATH = ':memory:'

  const [{ permissionGrantRoutes }, { resetStorage }] = await Promise.all([
    import('./permissionGrants.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(permissionGrantRoutes, { prefix: '/api' })
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

describe('POST /api/permission-grants', () => {
  it('creates a grant and returns 201', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        payload: {
          taskId: 'task-1',
          agentRole: 'developer_ai',
          scope: 'task',
          reason: 'Test grant',
        },
      })

      expect(res.statusCode).toBe(201)
      const grant = parseBody<PermissionGrant>(res.body)
      expect(grant.id).toBeTruthy()
      expect(grant.taskId).toBe('task-1')
      expect(grant.agentRole).toBe('developer_ai')
      expect(grant.scope).toBe('task')
      expect(grant.used).toBe(false)
    })
  })

  it('returns 400 for invalid body', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        payload: { agentRole: 'invalid_role', scope: 'task' },
      })

      expect(res.statusCode).toBe(400)
    })
  })
})

describe('GET /api/permission-grants', () => {
  it('returns active grants for a taskId', async () => {
    await withApp(async (app) => {
      // Create a grant
      await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        payload: {
          taskId: 'task-2',
          agentRole: 'developer_ai',
          scope: 'task',
        },
      })

      const res = await app.inject({
        method: 'GET',
        url: '/api/permission-grants?taskId=task-2',
      })

      expect(res.statusCode).toBe(200)
      const grants = parseBody<PermissionGrant[]>(res.body)
      expect(grants.length).toBe(1)
      expect(grants[0].taskId).toBe('task-2')
    })
  })

  it('does not return expired grants', async () => {
    await withApp(async (app) => {
      // Create an expired grant
      await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        payload: {
          taskId: 'task-3',
          agentRole: 'developer_ai',
          scope: 'task',
          expiresAt: '2000-01-01T00:00:00.000Z',
        },
      })

      const res = await app.inject({
        method: 'GET',
        url: '/api/permission-grants?taskId=task-3',
      })

      expect(res.statusCode).toBe(200)
      const grants = parseBody<PermissionGrant[]>(res.body)
      expect(grants.length).toBe(0)
    })
  })

  it('returns 400 when taskId is missing', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/permission-grants',
      })

      expect(res.statusCode).toBe(400)
    })
  })
})

describe('DELETE /api/permission-grants/:id', () => {
  it('deletes a grant and returns 204', async () => {
    await withApp(async (app) => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        payload: {
          taskId: 'task-4',
          agentRole: 'developer_ai',
          scope: 'task',
        },
      })
      const grant = parseBody<PermissionGrant>(createRes.body)

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/permission-grants/${grant.id}`,
      })

      expect(deleteRes.statusCode).toBe(204)

      // Verify it's gone
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/permission-grants?taskId=task-4',
      })
      const grants = parseBody<PermissionGrant[]>(getRes.body)
      expect(grants.length).toBe(0)
    })
  })

  it('returns 404 for non-existent grant', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/permission-grants/non-existent-id',
      })

      expect(res.statusCode).toBe(404)
    })
  })
})

describe('PATCH /api/permission-grants/:id/use', () => {
  it('marks a grant as used', async () => {
    await withApp(async (app) => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        payload: {
          taskId: 'task-5',
          agentRole: 'developer_ai',
          scope: 'once',
        },
      })
      const grant = parseBody<PermissionGrant>(createRes.body)

      const useRes = await app.inject({
        method: 'PATCH',
        url: `/api/permission-grants/${grant.id}/use`,
      })

      expect(useRes.statusCode).toBe(200)
      const updated = parseBody<PermissionGrant>(useRes.body)
      expect(updated.used).toBe(true)
    })
  })
})
