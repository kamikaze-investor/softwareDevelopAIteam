import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './auth/apiToken.js'
import { healthRoutes } from './routes/health.js'

/**
 * apps/api/src/index.ts の認証除外ロジック（isHealthCheckUrl）とルート登録構成を
 * 模した最小Fastifyインスタンスを組み立てて検証する。
 * index.ts自体は app.listen を含み直接importしてテストするには不向きなため、
 * apiToken.test.ts と同様のパターン（テスト内で構成を再現する）を踏襲する。
 */

function isHealthCheckUrl(url: string): boolean {
  const pathname = url.split('?')[0]
  return pathname === '/health' || pathname === '/api/health'
}

async function buildApp(token?: string): Promise<FastifyInstance> {
  if (token === undefined) {
    delete process.env.API_TOKEN
  } else {
    process.env.API_TOKEN = token
  }

  const app = Fastify()
  app.register(cors, { origin: true })
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    if (isHealthCheckUrl(req.url)) return
    await apiTokenAuth(req, reply)
  })
  app.get('/health', async (): Promise<{ status: string; version: string }> => ({
    status: 'ok',
    version: '0.1.0',
  }))
  app.register(healthRoutes, { prefix: '/api' })
  app.get('/protected', async (): Promise<{ data: string }> => ({ data: 'secret' }))
  await app.ready()
  return app
}

async function withApp(
  token: string | undefined,
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = await buildApp(token)
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

afterEach(() => {
  delete process.env.API_TOKEN
})

describe('index.ts — health endpoint 認証除外', () => {
  it('API_TOKEN設定時でも GET /health が認証なしで200を返す', async () => {
    await withApp('secret-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
    })
  })

  it('API_TOKEN設定時でも GET /health?x=1 が認証なしで200を返す', async () => {
    await withApp('secret-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/health?x=1' })
      expect(res.statusCode).toBe(200)
    })
  })

  it('API_TOKEN設定時でも GET /api/health が認証なしで200を返す', async () => {
    await withApp('secret-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      expect(res.statusCode).toBe(200)
    })
  })

  it('API_TOKEN設定時でも GET /api/health?x=1 が認証なしで200を返す', async () => {
    await withApp('secret-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health?x=1' })
      expect(res.statusCode).toBe(200)
    })
  })

  it('通常の /protected ルートは API_TOKEN設定時、認証なしでは401になる', async () => {
    await withApp('secret-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/protected' })
      expect(res.statusCode).toBe(401)
    })
  })
})
