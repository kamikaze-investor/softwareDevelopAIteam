import Fastify from 'fastify'
import { setCredentialClass } from '../auth/credentialClass'
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
    // C-1: the Worker's result delivery is authenticated as the Worker (apiTokenAuth sets the class in
    // production). These route tests have no auth plugin, so stand in for it on the Worker's PATCH /api/jobs/:id.
    app.addHook('onRequest', async (req) => {
      if (req.method === 'PATCH' && /^\/api\/jobs\/[^/?]+(\?|$)/.test(req.url)) setCredentialClass(req, 'worker')
    })
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

  it('ACKs immediately without invoking ensureTaskContinuation when the next Project is paused', async () => {
    const [{ jobRoutes }, { getStorage, resetStorage }] = await Promise.all([import('./jobs.js'), import('../storage/index.js')])
    resetStorage()
    const storage = getStorage()
    const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
    const source = storage.tasks.create({ projectId: project.id, title: 'Source', description: '', status: 'pending', assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1 })
    storage.tasks.create({ projectId: project.id, title: 'Next', description: 'Implement next.', status: 'pending', assignee: 'developer_ai', dependencies: [source.id], roadmapActive: true, phase: 2 })
    const commit = storage.jobs.create({ taskId: source.id, projectId: project.id, agentRole: 'developer_ai', status: 'running', safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' } })
    // Pausing between commit-start and the Worker's success PATCH is the scenario this
    // guards: the continuation must not hold the Worker's Outbox event pending while the
    // Project can stay paused indefinitely.
    storage.projects.update(project.id, { status: 'paused' })
    const app = Fastify()
    // C-1: the Worker's result delivery is authenticated as the Worker (apiTokenAuth sets the class in
    // production). These route tests have no auth plugin, so stand in for it on the Worker's PATCH /api/jobs/:id.
    app.addHook('onRequest', async (req) => {
      if (req.method === 'PATCH' && /^\/api\/jobs\/[^/?]+(\?|$)/.test(req.url)) setCredentialClass(req, 'worker')
    })
    app.register(jobRoutes, { prefix: '/api/jobs' })
    await app.ready()
    try {
      const payload = outboxPayload({ status: 'success', exitCode: 0 })
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${commit.id}`, payload })
      const continuation = storage.taskContinuations.findBySourceJobId(commit.id)!
      expect(res.statusCode).toBe(200)
      expect(ensureTaskContinuationMock).not.toHaveBeenCalled()
      expect(continuation.status).toBe('pending')
    } finally {
      await app.close()
    }
  })
})
