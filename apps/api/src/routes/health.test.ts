import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { healthRoutes } from './health.js'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  app.register(healthRoutes, { prefix: '/api' })
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

async function withEnvAsync(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key]
  }

  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await run()
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('GET /api/health', () => {
  it('200を返す', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      expect(res.statusCode).toBe(200)
    })
  })

  it('ok:true を返す', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
    })
  })

  it('status:running を返す', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.status).toBe('running')
    })
  })

  it('message:running を返す', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.message).toBe('running')
    })
  })

  it('必須フィールドがすべて存在する', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)

      expect(body).toHaveProperty('ok')
      expect(body).toHaveProperty('appName')
      expect(body).toHaveProperty('appType')
      expect(body).toHaveProperty('version')
      expect(body).toHaveProperty('environment')
      expect(body).toHaveProperty('startedAt')
      expect(body).toHaveProperty('lastHeartbeatAt')
      expect(body).toHaveProperty('lastSuccessAt')
      expect(body).toHaveProperty('lastErrorAt')
      expect(body).toHaveProperty('status')
      expect(body).toHaveProperty('message')
    })
  })

  it('appName が ai-team-os', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.appName).toBe('ai-team-os')
    })
  })

  it('appType が api', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.appType).toBe('api')
    })
  })

  it('lastSuccessAt が null', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.lastSuccessAt).toBeNull()
    })
  })

  it('lastErrorAt が null', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)
      expect(body.lastErrorAt).toBeNull()
    })
  })

  it('startedAt と lastHeartbeatAt が ISO8601としてparse可能', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      const body = JSON.parse(res.body)

      expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false)
      expect(Number.isNaN(Date.parse(body.lastHeartbeatAt))).toBe(false)
    })
  })

  it('API_TOKENをセットしても、レスポンス本文に含まれない', async () => {
    await withEnvAsync({ API_TOKEN: 'secret-xyz' }, async () => {
      await withApp(async (app) => {
        const res = await app.inject({ method: 'GET', url: '/api/health' })
        expect(res.body).not.toContain('secret-xyz')
      })
    })
  })

  it('NODE_ENVをproductionにすると environment:production を返す', async () => {
    await withEnvAsync({ NODE_ENV: 'production' }, async () => {
      await withApp(async (app) => {
        const res = await app.inject({ method: 'GET', url: '/api/health' })
        const body = JSON.parse(res.body)
        expect(body.environment).toBe('production')
      })
    })
  })
})
