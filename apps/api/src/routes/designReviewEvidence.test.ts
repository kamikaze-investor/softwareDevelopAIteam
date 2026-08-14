import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignReviewEvidence, Task } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

async function buildApp(): Promise<FastifyInstance> {
  const [{ designReviewEvidenceRoutes }, { resetStorage }] = await Promise.all([
    import('./designReviewEvidence.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(designReviewEvidenceRoutes, { prefix: '/api' })
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

async function createTask(): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()
  const project = storage.projects.create({
    name: 'Evidence route project',
    goal: 'g',
    designPhilosophy: [],
    status: 'draft',
  })

  return storage.tasks.create({
    projectId: project.id,
    title: 'Evidence route task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
})

describe('Design Review evidence API', () => {
  it('POST /api/design-review-evidence stores server-computed design text hash', async () => {
    await withApp(async (app) => {
      const task = await createTask()
      const designText = 'Design: persist trusted evidence for exact prompt matching.'

      const res = await app.inject({
        method: 'POST',
        url: '/api/design-review-evidence',
        payload: {
          taskId: task.id,
          designText,
          reviewLoad: 'critical',
          decision: 'ALIGNED',
          independentReviewRequired: true,
          independentReviewVerdict: 'approved',
          designTextHash: 'client-supplied-hash-must-not-be-accepted',
        },
      })

      expect(res.statusCode).toBe(400)

      const accepted = await app.inject({
        method: 'POST',
        url: '/api/design-review-evidence',
        payload: {
          taskId: task.id,
          designText,
          reviewLoad: 'critical',
          decision: 'ALIGNED',
          independentReviewRequired: true,
          independentReviewVerdict: 'approved',
        },
      })

      expect(accepted.statusCode).toBe(201)
      const evidence = parseBody<DesignReviewEvidence>(accepted.body)
      expect(evidence.designTextHash).toBe(computeDesignTextHash(designText))
      expect(JSON.stringify(evidence)).not.toContain(designText)
    })
  })

  it('POST /api/design-review-evidence rejects evidence for a missing Task', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/design-review-evidence',
        payload: {
          taskId: 'missing-task',
          designText: 'Design text',
          reviewLoad: 'medium',
          decision: 'ALIGNED',
          independentReviewRequired: false,
        },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Task not found')
    })
  })
})
