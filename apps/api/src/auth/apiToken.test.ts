import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './apiToken'

async function buildApp(token?: string): Promise<FastifyInstance> {
  if (token === undefined) {
    delete process.env.API_TOKEN
  } else {
    process.env.API_TOKEN = token
  }

  const app = Fastify()
  app.register(cors, { origin: true })
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    if (req.url === '/health') return
    await apiTokenAuth(req, reply)
  })
  app.get('/health', async (): Promise<{ status: string }> => ({ status: 'ok' }))
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

function parseBody<T>(body: string): T {
  return JSON.parse(body) as T
}

afterEach(() => {
  delete process.env.API_TOKEN
})

describe('API Token Auth', () => {
  it('/health is accessible without authentication', async () => {
    await withApp('secret-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/health' })

      expect(res.statusCode).toBe(200)
    })
  })

  it('allows protected endpoints when API_TOKEN is not configured', async () => {
    await withApp(undefined, async (app) => {
      const res = await app.inject({ method: 'GET', url: '/protected' })

      expect(res.statusCode).toBe(200)
    })
  })

  it('allows requests with the correct token', async () => {
    await withApp('my-token', async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer my-token' },
      })

      expect(res.statusCode).toBe(200)
    })
  })

  it('returns 401 without an Authorization header', async () => {
    await withApp('my-token', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/protected' })

      expect(res.statusCode).toBe(401)
      expect(parseBody<{ error: string }>(res.body)).toEqual({
        error: 'Authorization header required',
      })
    })
  })

  it('returns 401 for an invalid token', async () => {
    await withApp('my-token', async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer wrong-token' },
      })

      expect(res.statusCode).toBe(401)
      expect(parseBody<{ error: string }>(res.body)).toEqual({ error: 'Invalid token' })
    })
  })
})
