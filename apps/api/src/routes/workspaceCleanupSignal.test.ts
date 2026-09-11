import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Job, Task } from '@ai-team/shared'
import { MAX_REPAIR_ATTEMPTS } from '../designReview/repairPolicy'

/**
 * M1（`workspace-dirty-leakage-cleanup`）の API 側の責務。
 *
 * 共有 `/workspace/target` は Job 間で reset されない。通常は失敗の後続
 * （`repair:` / `retry:` / `resume:`）が INTENTIONALLY-DIRTY として dirty を正統に継承するが、
 * escalate は「repair を作らずこの失敗を確定させる」判断なので**継承者が現れない**。
 *
 * API はリポジトリを触らない。掃除は Worker の `revertBlockedJobChanges()` の責務なので、
 * API が持つのは**開始条件を応答で伝えること**だけ。ここではその条件が
 * 「escalate のときだけ立ち、repair を queue したときには立たない」ことを固定する。
 */

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ jobRoutes }, { resetStorage }] = await Promise.all([
    import('./jobs.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(jobRoutes, { prefix: '/api/jobs' })
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

async function seedTask(): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()
  const project = storage.projects.create({
    name: 'M1 cleanup signal', goal: 'g', designPhilosophy: [], status: 'running',
  })
  return storage.tasks.create({
    projectId: project.id,
    title: 'M1 target task',
    description: '',
    status: 'in_progress',
    assignee: 'developer_ai',
    dependencies: [],
  })
}

async function createImplementJob(task: Task, workflowStepKey: string, status: Job['status']): Promise<Job> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status,
    workflowStepKey,
    safeCommand: { kind: 'test', workingDir: '/workspace/target', params: {} },
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'implement it',
    aiCliMode: 'implement',
  })
}

async function failJob(app: FastifyInstance, jobId: string): Promise<Job & { workspaceCleanupRequired?: boolean }> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${jobId}`,
    payload: { status: 'failed', exitCode: 1, stderr: 'implementation failed', completedAt: new Date().toISOString() },
  })
  expect(res.statusCode).toBe(200)
  return parseBody(res.body)
}

describe('M1: PATCH /api/jobs/:id が workspace cleanup の開始条件を返す', () => {
  it('repair を queue した失敗では立たない（repair が dirty を継承するため）', async () => {
    await withApp(async (app) => {
      const task = await seedTask()
      const job = await createImplementJob(task, `task:${task.id}:initial-implement`, 'running')

      const body = await failJob(app, job.id)

      expect(body.status).toBe('failed')
      expect(body.workspaceCleanupRequired).toBeUndefined()
    })
  })

  it('repair 上限に達して escalate した失敗で立つ', async () => {
    await withApp(async (app) => {
      const task = await seedTask()
      const { getStorage } = await import('../storage/index.js')

      // 既に上限ぶんの repair を使い切っている状態を作る。
      for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i += 1) {
        const prior = await createImplementJob(task, `repair:prior-${i}:1`, 'running')
        getStorage().jobs.update(prior.id, { status: 'failed', exitCode: 1, stderr: `attempt ${i}` })
      }

      const job = await createImplementJob(task, `repair:last:1`, 'running')
      const body = await failJob(app, job.id)

      expect(body.status).toBe('failed')
      expect(body.workspaceCleanupRequired).toBe(true)
      // escalate は既存の Human escalation（Task blocked）へ入れる。
      expect(getStorage().tasks.findById(task.id)?.status).toBe('blocked')
    })
  })

  it('成功した Job では立たない（review → git_commit が dirty を継承するため）', async () => {
    await withApp(async (app) => {
      const task = await seedTask()
      const job = await createImplementJob(task, `task:${task.id}:initial-implement`, 'running')

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        payload: { status: 'success', exitCode: 0, completedAt: new Date().toISOString() },
      })
      expect(res.statusCode).toBe(200)
      const body = parseBody<Job & { workspaceCleanupRequired?: boolean }>(res.body)
      expect(body.workspaceCleanupRequired).toBeUndefined()
    })
  })

  it('応答は従来の Job 本文をそのまま含む（既存クライアントを壊さない）', async () => {
    await withApp(async (app) => {
      const task = await seedTask()
      const { getStorage } = await import('../storage/index.js')
      for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i += 1) {
        const prior = await createImplementJob(task, `repair:prior-${i}:1`, 'running')
        getStorage().jobs.update(prior.id, { status: 'failed', exitCode: 1, stderr: `attempt ${i}` })
      }
      const job = await createImplementJob(task, `repair:last:1`, 'running')

      const body = await failJob(app, job.id)

      expect(body.id).toBe(job.id)
      expect(body.taskId).toBe(task.id)
      expect(body.exitCode).toBe(1)
    })
  })
})
