import cors from '@fastify/cors'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './apiToken.js'

/**
 * Worker↔API authority separation（2026-08-15設計）の統合テスト。
 * index.ts のroute登録構成（対象route分のみ）を再現し、実際のFastify routingを通して
 * ADMIN / WORKER credentialの挙動を検証する（`req.routeOptions.url`によるallowlist判定を
 * 実route登録経由で確認するため、apiToken.test.tsのような最小appではなく実route moduleを使う）。
 */

const ADMIN_TOKEN = 'admin-plain-token-for-tests'
const WORKER_TOKEN = 'worker-plain-token-for-tests'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

function adminAuthHeader(): { authorization: string } {
  return { authorization: `Bearer ${ADMIN_TOKEN}` }
}

function workerAuthHeader(): { authorization: string } {
  return { authorization: `Bearer ${WORKER_TOKEN}` }
}

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'
  process.env.ADMIN_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)
  process.env.WORKER_TOKEN_SHA256 = sha256Hex(WORKER_TOKEN)

  const [
    { projectRoutes },
    { taskRoutes },
    { jobRoutes },
    { permissionGrantRoutes },
    { watchdogEventRoutes },
    { approvalGateRoutes },
    { approvalRoutes },
    { knowledgeGraphRoutes },
    { resetStorage },
  ] = await Promise.all([
    import('../routes/projects.js'),
    import('../routes/tasks.js'),
    import('../routes/jobs.js'),
    import('../routes/permissionGrants.js'),
    import('../routes/watchdogEvents.js'),
    import('../routes/approvalGate.js'),
    import('../routes/approvals.js'),
    import('../routes/knowledgeGraph.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  app.register(permissionGrantRoutes, { prefix: '/api' })
  app.register(watchdogEventRoutes, { prefix: '/api' })
  app.register(approvalGateRoutes, { prefix: '/api' })
  app.register(approvalRoutes, { prefix: '/api' })
  app.register(knowledgeGraphRoutes, { prefix: '/api' })
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

afterEach(() => {
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
  delete process.env.API_TOKEN
})

describe('Worker↔API authority separation — ADMIN credential', () => {
  it('ADMINは既存APIを利用可能（GET /api/projects）', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: adminAuthHeader() })
      expect(res.statusCode).toBe(200)
    })
  })

  it('ADMINはWORKER allowlist外のroute（CEO承認決定）も利用可能', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/approval-requests/non-existent/status',
        headers: adminAuthHeader(),
        payload: { status: 'APPROVED' },
      })
      // 404（対象が存在しない）であって401/403ではないこと＝認証自体は通過している
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })
})

describe('Worker↔API authority separation — WORKER credential: allowlist 11経路', () => {
  it('GET /api/projects が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: workerAuthHeader() })
      expect(res.statusCode).toBe(200)
    })
  })

  it('GET /api/tasks が通る（route parameter無しpattern）', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: workerAuthHeader() })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('GET /api/jobs が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: workerAuthHeader() })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('PATCH /api/jobs/:id が通る（route parameter付きpattern）', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/jobs/non-existent-id',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('PATCH /api/jobs/:id/fail-if-running が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/jobs/non-existent-id/fail-if-running',
        headers: workerAuthHeader(),
        payload: { stderr: 'x', completedAt: new Date().toISOString() },
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('GET /api/permission-grants が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/permission-grants?taskId=x',
        headers: workerAuthHeader(),
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('PATCH /api/permission-grants/:id/use が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/permission-grants/non-existent-id/use',
        headers: workerAuthHeader(),
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('POST /api/gate/check が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/gate/check',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('POST /api/approval-requests/:id/consume が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/approval-requests/non-existent-id/consume',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('POST /api/watchdog-events が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/watchdog-events',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })

  it('PATCH /api/watchdog-events/:id が通る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/watchdog-events/non-existent-id',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  })
})

describe('Worker↔API authority separation — WORKER credential: Default Deny', () => {
  it('CEO approval decision（PATCH /api/approval-requests/:id/status）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/approval-requests/some-id/status',
        headers: workerAuthHeader(),
        payload: { status: 'APPROVED' },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('billing/security等のCEO decision（PATCH /api/approvals/:id）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/approvals/some-id',
        headers: workerAuthHeader(),
        payload: { status: 'approved' },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('Task作成（POST /api/tasks）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: workerAuthHeader(), payload: {} })
      expect(res.statusCode).toBe(403)
    })
  })

  it('Task変更（PATCH /api/tasks/:id）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/tasks/some-id',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('Project変更（PATCH /api/projects/:id）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/projects/some-id',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('permission grant自己発行（POST /api/permission-grants）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/permission-grants',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('permission grant削除（DELETE /api/permission-grants/:id）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/permission-grants/some-id',
        headers: workerAuthHeader(),
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('design-review-evidence登録（POST /api/design-review-evidence）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/design-review-evidence',
        headers: workerAuthHeader(),
        payload: {},
      })
      expect(res.statusCode).toBe(403)
    })
  })

  it('Job自己生成（POST /api/jobs）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'POST', url: '/api/jobs', headers: workerAuthHeader(), payload: {} })
      expect(res.statusCode).toBe(403)
    })
  })

  it('Knowledge Graph delete（DELETE /api/kg/nodes/:id）は403', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/kg/nodes/some-id',
        headers: workerAuthHeader(),
      })
      expect(res.statusCode).toBe(403)
    })
  })
})

describe('Worker↔API authority separation — credential判定', () => {
  it('未知のtokenは401', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: 'Bearer completely-unknown-token' },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  it('Authorizationヘッダ無しは401', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects' })
      expect(res.statusCode).toBe(401)
    })
  })
})
