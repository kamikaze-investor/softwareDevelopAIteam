/**
 * 2026-10-23 implement stall の回帰テスト（route 経由）。
 *
 * SafeCommand の実行予算切れ（failureMetadata.kind='safe_command_timeout'）が同じ repair generation で
 * 繰り返されたとき、repair を作らず既存の escalate へ渡すこと、そして**黙って止まらない**こと
 * （Task は blocked、`task_escalated_to_human` が残り、`job_failed` が attention に見える）を固定する。
 * Triage の扱いは変えていない（このテストは lane を固定しない）。
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Job, Task } from '@ai-team/shared'
import { setCredentialClass } from '../auth/credentialClass'
import { buildSystemState } from '../state/systemState'

async function buildApp(): Promise<FastifyInstance> {
  const [{ jobRoutes }, { resetStorage }] = await Promise.all([
    import('./jobs.js'),
    import('../storage/index.js'),
  ])
  resetStorage()
  const app = Fastify()
  app.addHook('onRequest', async (req) => {
    if (req.method === 'PATCH' && /^\/api\/jobs\/[^/?]+(\?|$)/.test(req.url)) setCredentialClass(req, 'worker')
  })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return app
}

async function getStorage() {
  const { getStorage } = await import('../storage/index.js')
  return getStorage()
}

const TIMEOUT_FAILURE = {
  status: 'failed',
  exitCode: 1,
  stderr: 'command timed out after 600000ms (test budget) and was terminated by containment',
  failureMetadata: { kind: 'safe_command_timeout', workspaceState: 'changed' },
} as const

async function seedOriginTimedOutAndRunningRepair(): Promise<{ task: Task; origin: Job; repair: Job }> {
  const storage = await getStorage()
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [], allowedPaths: ['docs'], forbiddenPaths: [],
  })
  const origin = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'running',
    workflowStepKey: `task:${task.id}:initial-implement`,
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code', aiCliMode: 'implement', aiCliPrompt: 'p',
  } as Parameters<typeof storage.jobs.create>[0])
  storage.jobs.update(origin.id, { ...TIMEOUT_FAILURE } as never)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const repair = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'running',
    workflowStepKey: `repair:${origin.id}:1`,
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code', aiCliMode: 'implement', aiCliPrompt: 'p',
  } as Parameters<typeof storage.jobs.create>[0])
  return { task, origin, repair }
}

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
})

describe('repeated safe_command_timeout through PATCH /api/jobs/:id', () => {
  it('creates no further repair, blocks the Task with task_escalated_to_human, and keeps job_failed visible (no silent stop)', async () => {
    const app = await buildApp()
    try {
      const { task, repair } = await seedOriginTimedOutAndRunningRepair()
      const storage = await getStorage()

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${repair.id}`, payload: { ...TIMEOUT_FAILURE } })
      expect(res.statusCode).toBe(200)

      const stored = storage.jobs.findById(repair.id)
      expect(stored?.status).toBe('failed')
      expect(stored?.failureMetadata?.kind).toBe('safe_command_timeout')

      // repair は作られない（同じ予算で同じ SafeCommand を繰り返さない）。
      const jobs = storage.jobs.findByTaskId(task.id)
      expect(jobs.some((job) => job.workflowStepKey === `repair:${repair.id}:1`)).toBe(false)
      expect(jobs.some((job) => job.status === 'queued' || job.status === 'running')).toBe(false)
      expect(storage.designReviewRuns.findLatestByTaskId(task.id)).toBeUndefined()

      // 黙って止まらない: Task は blocked、escalation の audit が残り、job_failed が attention に出る。
      expect(storage.tasks.findById(task.id)?.status).toBe('blocked')
      const escalations = storage.auditLog.findByEntity('task', task.id)
        .filter((entry) => entry.operation === 'task_escalated_to_human')
      expect(escalations).toHaveLength(1)
      expect(escalations[0]?.detail).toContain('timed out again')
      const attention = buildSystemState(storage).attention.filter((item) => item.taskId === task.id)
      expect(attention.some((item) => item.kind === 'job_failed' && item.jobId === repair.id)).toBe(true)
    } finally {
      await app.close()
    }
  })
})
