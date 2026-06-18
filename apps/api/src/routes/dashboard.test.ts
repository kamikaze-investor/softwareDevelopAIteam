import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ dashboardRoutes }, { resetStorage }] = await Promise.all([
    import('./dashboard.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(dashboardRoutes, { prefix: '/api' })
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

describe('GET /api/dashboard', () => {
  it('空DBでもサマリーを返す', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/dashboard' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('generatedAt')
      expect(body).toHaveProperty('projects')
      expect(body).toHaveProperty('watchdog')
      expect(body).toHaveProperty('runningJobs')
      expect(Array.isArray(body.projects)).toBe(true)
      expect(Array.isArray(body.runningJobs)).toBe(true)
    })
  })

  it('watchdog セクションに集計フィールドが含まれる', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/dashboard' })
      const body = JSON.parse(res.body)
      expect(body.watchdog).toHaveProperty('total')
      expect(body.watchdog).toHaveProperty('confirmed')
      expect(body.watchdog).toHaveProperty('false_alarm')
      expect(body.watchdog).toHaveProperty('analyzing')
      expect(body.watchdog).toHaveProperty('resolved')
      expect(Array.isArray(body.watchdog.recentConfirmed)).toBe(true)
    })
  })
})
