import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WatchdogEvent } from '@ai-team/shared'

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ watchdogEventRoutes }, { resetStorage }] = await Promise.all([
    import('./watchdogEvents.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(watchdogEventRoutes, { prefix: '/api' })
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

const samplePayload = {
  jobId: 'job-1',
  taskId: 'task-1',
  commandKind: 'typecheck',
  workingDir: '/workspace/target',
  startedAt: '2026-06-18T10:00:00.000Z',
  detectedAt: '2026-06-18T10:05:30.000Z',
  stallDurationMs: 330_000,
}

describe('POST /api/watchdog-events', () => {
  it('creates event and returns 201', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/watchdog-events',
        payload: samplePayload,
      })
      expect(res.statusCode).toBe(201)
      const event = parseBody<WatchdogEvent>(res.body)
      expect(event.jobId).toBe('job-1')
      expect(event.commandKind).toBe('typecheck')
      expect(event.status).toBe('detected')
      expect(event.id).toBeTruthy()
    })
  })

  it('バリデーションエラーで 400', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/watchdog-events',
        payload: { jobId: 'job-1' }, // taskId など必須フィールド欠損
      })
      expect(res.statusCode).toBe(400)
    })
  })
})

describe('GET /api/watchdog-events', () => {
  it('空リストを返す', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/watchdog-events' })
      expect(res.statusCode).toBe(200)
      expect(parseBody<WatchdogEvent[]>(res.body)).toEqual([])
    })
  })

  it('作成したイベントが含まれる', async () => {
    await withApp(async (app) => {
      await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })
      const res = await app.inject({ method: 'GET', url: '/api/watchdog-events' })
      const events = parseBody<WatchdogEvent[]>(res.body)
      expect(events).toHaveLength(1)
      expect(events[0].jobId).toBe('job-1')
    })
  })
})

describe('GET /api/watchdog-events/:id', () => {
  it('存在するイベントを返す', async () => {
    await withApp(async (app) => {
      const created = parseBody<WatchdogEvent>(
        (await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })).body,
      )
      const res = await app.inject({ method: 'GET', url: `/api/watchdog-events/${created.id}` })
      expect(res.statusCode).toBe(200)
      expect(parseBody<WatchdogEvent>(res.body).id).toBe(created.id)
    })
  })

  it('存在しない ID で 404', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/watchdog-events/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('PATCH /api/watchdog-events/:id', () => {
  it('status と AI分析を更新できる', async () => {
    await withApp(async (app) => {
      const created = parseBody<WatchdogEvent>(
        (await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })).body,
      )
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watchdog-events/${created.id}`,
        payload: { status: 'confirmed', aiAnalysis: 'デッドロックの可能性', isStuck: true },
      })
      expect(res.statusCode).toBe(200)
      const updated = parseBody<WatchdogEvent>(res.body)
      expect(updated.status).toBe('confirmed')
      expect(updated.aiAnalysis).toBe('デッドロックの可能性')
      expect(updated.isStuck).toBe(true)
    })
  })

  it('false_alarm に更新できる', async () => {
    await withApp(async (app) => {
      const created = parseBody<WatchdogEvent>(
        (await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })).body,
      )
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/watchdog-events/${created.id}`,
        payload: { status: 'false_alarm', aiAnalysis: '大規模プロジェクトのため低速', isStuck: false },
      })
      expect(res.statusCode).toBe(200)
      const updated = parseBody<WatchdogEvent>(res.body)
      expect(updated.status).toBe('false_alarm')
      expect(updated.isStuck).toBe(false)
    })
  })
})
