import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'

/**
 * Resume の前提条件（共有 `evaluateResumeAdmission()`）を storage と route で確かめる（b8d0fc5d 監査）。
 * done の Task・running でない Project は 409 + stable code、live な承認待ちは拒否、
 * 期限切れの承認待ちは resume を妨げない。
 */

async function buildApp(): Promise<{ app: FastifyInstance; storage: IStorage }> {
  process.env.DB_PATH = ':memory:'
  const [{ taskRoutes }, { resetStorage, getStorage }] = await Promise.all([
    import('./tasks.js'),
    import('../storage/index.js'),
  ])
  resetStorage()
  const app = Fastify()
  app.register(taskRoutes, { prefix: '/api/tasks' })
  await app.ready()
  return { app, storage: getStorage() }
}

function seed(storage: IStorage, options: { taskStatus?: string; projectStatus?: string } = {}) {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: (options.projectStatus ?? 'running') as never,
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: 'd',
    status: options.taskStatus ?? 'blocked',
    assignee: 'developer_ai',
    dependencies: [],
  } as never)
  const job = storage.jobs.create({
    taskId: task.id,
    projectId: project.id,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliMode: 'implement',
    aiCliPrompt: 'p',
  } as never)
  storage.jobs.update(job.id, { status: 'blocked' } as never)
  return { taskId: task.id, projectId: project.id, jobId: job.id }
}

function waitingApproval(storage: IStorage, taskId: string, expiresInMs: number): void {
  storage.approvalRequests.create({
    taskId,
    targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
    riskLevel: 'HIGH',
    requestedAction: 'git_commit',
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    invalidIf: [],
  } as never)
}

const resume = (app: FastifyInstance, taskId: string) =>
  app.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume`, payload: { instruction: 'continue' } })

describe('resume admission', () => {
  it('done の Task は 409 TASK_DONE で断り、Job を作らない', async () => {
    const { app, storage } = await buildApp()
    try {
      const { taskId } = seed(storage, { taskStatus: 'done' })

      const res = await resume(app, taskId)

      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'TASK_DONE' })
      expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it.each(['paused', 'draft'])('Project が %s なら 409 PROJECT_NOT_RUNNING', async (projectStatus) => {
    const { app, storage } = await buildApp()
    try {
      const { taskId } = seed(storage, { projectStatus })

      const res = await resume(app, taskId)

      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'PROJECT_NOT_RUNNING' })
      expect(storage.jobs.findByTaskId(taskId)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('live な承認待ちがあれば APPROVAL_WAITING で断る', async () => {
    const { app, storage } = await buildApp()
    try {
      const { taskId } = seed(storage)
      waitingApproval(storage, taskId, 60_000)

      const res = await resume(app, taskId)

      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'APPROVAL_WAITING' })
    } finally {
      await app.close()
    }
  })

  it('期限切れの承認待ちは resume の前提条件を塞がない（次の門 = Design Review evidence まで進む）', async () => {
    const { app, storage } = await buildApp()
    try {
      const { taskId } = seed(storage)
      waitingApproval(storage, taskId, -60_000)

      const result = storage.jobs.resumeBlockedTask({ taskId, instructionPrompt: 'continue' })

      expect(result).toMatchObject({ ok: false, code: 'DESIGN_REVIEW_PRECONDITION_FAILED' })
    } finally {
      await app.close()
    }
  })
})
