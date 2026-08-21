import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeJobUpdate } from '@ai-team/shared'

const ensureTaskContinuationMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../ctoAi/taskContinuation.js', () => ({ ensureTaskContinuation: ensureTaskContinuationMock }))

function outboxPayload(payload: Record<string, unknown>) {
  return { ...payload, eventId: 'continuation-outbox-event', payloadHash: createHash('sha256').update(canonicalizeJobUpdate(payload)).digest('hex') }
}

describe('git_commit durable continuation route', () => {
  beforeEach(() => {
    ensureTaskContinuationMock.mockClear()
    process.env.DB_PATH = ':memory:'
  })

  it('re-kicks a pending continuation on the same Outbox event and ACKs after completion', async () => {
    const [{ jobRoutes }, { getStorage, resetStorage }] = await Promise.all([import('./jobs.js'), import('../storage/index.js')])
    resetStorage()
    const storage = getStorage()
    const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
    const source = storage.tasks.create({ projectId: project.id, title: 'Source', description: '', status: 'pending', assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1 })
    storage.tasks.create({ projectId: project.id, title: 'Next', description: 'Implement next.', status: 'pending', assignee: 'developer_ai', dependencies: [source.id], roadmapActive: true, phase: 2 })
    const commit = storage.jobs.create({ taskId: source.id, projectId: project.id, agentRole: 'developer_ai', status: 'running', safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' } })
    const app = Fastify()
    app.register(jobRoutes, { prefix: '/api/jobs' })
    await app.ready()
    try {
      const payload = outboxPayload({ status: 'success', exitCode: 0 })
      const first = await app.inject({ method: 'PATCH', url: `/api/jobs/${commit.id}`, payload })
      const continuation = storage.taskContinuations.findBySourceJobId(commit.id)!
      const resent = await app.inject({ method: 'PATCH', url: `/api/jobs/${commit.id}`, payload })
      storage.taskContinuations.update(continuation.id, { status: 'completed', completedAt: new Date().toISOString() })
      const acknowledged = await app.inject({ method: 'PATCH', url: `/api/jobs/${commit.id}`, payload })
      expect(first.statusCode).toBe(503)
      expect(resent.statusCode).toBe(503)
      expect(ensureTaskContinuationMock).toHaveBeenCalledTimes(2)
      expect(storage.jobs.findById(commit.id)?.status).toBe('success')
      expect(acknowledged.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
