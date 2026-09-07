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

/**
 * DB-007: stall event の重複防止を DB/API 側で保証する。
 * Worker の in-memory Set は速度のための最適化であって、正しさの根拠ではない。
 */
describe('POST /api/watchdog-events — episode 単位の冪等性（DB-007）', () => {
  it('同じ (jobId, startedAt) の再POSTは行を増やさず既存eventを返す', async () => {
    await withApp(async (app) => {
      const first = await app.inject({
        method: 'POST', url: '/api/watchdog-events', payload: samplePayload,
      })
      expect(first.statusCode).toBe(201)
      const created = parseBody<WatchdogEvent>(first.body)

      // Worker restart 後の再検出に相当。detectedAt / stallDurationMs は変わり得る。
      const second = await app.inject({
        method: 'POST',
        url: '/api/watchdog-events',
        payload: { ...samplePayload, detectedAt: '2026-06-18T10:11:00.000Z', stallDurationMs: 660000 },
      })
      // 作成していないので 201 ではなく 200
      expect(second.statusCode).toBe(200)
      expect(parseBody<WatchdogEvent>(second.body).id).toBe(created.id)

      const all = await app.inject({ method: 'GET', url: '/api/watchdog-events' })
      expect(parseBody<WatchdogEvent[]>(all.body)).toHaveLength(1)
    })
  })

  it('復旧後に再び stall した同じ Job は、別 episode として記録される', async () => {
    await withApp(async (app) => {
      // Job は failed/blocked -> queued -> running と復帰でき、そのとき startedAt が付け直される。
      // job_id だけを dedup key にすると、この**正当な再発**を握り潰してしまう。
      await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })

      const secondEpisode = await app.inject({
        method: 'POST',
        url: '/api/watchdog-events',
        payload: {
          ...samplePayload,
          startedAt: '2026-06-18T12:00:00.000Z',
          detectedAt: '2026-06-18T12:05:30.000Z',
        },
      })

      expect(secondEpisode.statusCode).toBe(201)
      const all = parseBody<WatchdogEvent[]>(
        (await app.inject({ method: 'GET', url: '/api/watchdog-events' })).body,
      )
      expect(all).toHaveLength(2)
      expect(new Set(all.map((e) => e.startedAt)).size).toBe(2)
    })
  })

  it('別 Job の stall は互いに独立して記録される', async () => {
    await withApp(async (app) => {
      await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })
      const other = await app.inject({
        method: 'POST',
        url: '/api/watchdog-events',
        payload: { ...samplePayload, jobId: 'job-2' },
      })
      expect(other.statusCode).toBe(201)
      const all = parseBody<WatchdogEvent[]>(
        (await app.inject({ method: 'GET', url: '/api/watchdog-events' })).body,
      )
      expect(all).toHaveLength(2)
    })
  })

  it('冪等な再POSTでも、後続のPATCH対象は同じeventのまま', async () => {
    await withApp(async (app) => {
      const first = parseBody<WatchdogEvent>(
        (await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })).body,
      )
      const second = parseBody<WatchdogEvent>(
        (await app.inject({ method: 'POST', url: '/api/watchdog-events', payload: samplePayload })).body,
      )
      expect(second.id).toBe(first.id)

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/watchdog-events/${second.id}`,
        payload: { status: 'confirmed', isStuck: true },
      })
      expect(patched.statusCode).toBe(200)
      expect(parseBody<WatchdogEvent>(patched.body).status).toBe('confirmed')
    })
  })
})
