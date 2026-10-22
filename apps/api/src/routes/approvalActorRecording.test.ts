import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import { apiTokenAuth } from '../auth/apiToken'
import { repairFromStoredReview } from '../designReview/repairFromStoredReview'
import { readApprovalActorClass } from '../designReview/resumeActor'

/**
 * PATCH /api/approval-requests/:id/status が「誰が決めたか」（`approval_actor`）を残すことの end-to-end。
 *
 * stored-review recovery の承認は consume されると repair budget を作り直す authority になる
 * （b8d0fc5d）。`repairFromStoredReview()` は `approval_actor = human`（ADMIN credential）の記録がある
 * 承認しか使わない。route がその記録を書かなければ、人が Mobile で承認しても recovery は永久に
 * `APPROVAL_ACTOR_NOT_HUMAN` になり、逆に legacy 単一 token の承認が human 扱いになってはならない。
 */

const ADMIN_TOKEN = 'admin-token-for-test'
const WORKER_TOKEN = 'worker-token-for-test'
const LEGACY_TOKEN = 'legacy-token-for-test'
const IN_SCOPE = 'apps/api/src/pl/executionLoop.ts'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

async function buildApp(): Promise<{ app: FastifyInstance; storage: IStorage }> {
  process.env.DB_PATH = ':memory:'
  const [{ approvalGateRoutes }, { resetStorage, getStorage }] = await Promise.all([
    import('./approvalGate.js'),
    import('../storage/index.js'),
  ])
  resetStorage()
  const app = Fastify()
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.register(approvalGateRoutes, { prefix: '/api' })
  await app.ready()
  return { app, storage: getStorage() }
}

function useSplitCredentials(): void {
  process.env.ADMIN_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)
  process.env.WORKER_TOKEN_SHA256 = sha256Hex(WORKER_TOKEN)
}

function useLegacyCredential(): void {
  process.env.API_TOKEN = LEGACY_TOKEN
}

afterEach(() => {
  delete process.env.API_TOKEN
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
})

function makeImplementJob(
  storage: IStorage,
  ids: { taskId: string; projectId: string },
  workflowStepKey: string,
  finalStatus: 'failed' | 'success',
): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId, projectId: ids.projectId, agentRole: 'developer_ai', status: 'queued',
    safeCommand: { kind: 'noop' }, aiCliMode: 'implement', aiCliProvider: 'claude_code', workflowStepKey,
  } as never)
  return storage.jobs.update(job.id, {
    status: finalStatus, exitCode: finalStatus === 'success' ? 0 : 1, changedFiles: [IN_SCOPE],
  } as never)!
}

/** production `c3849205` の形: repair を使い切った後、resume で成功した実装に changes_requested が保存されている。 */
function storedReviewShape(storage: IStorage): { taskId: string; implementJob: Job; reviewJob: Job } {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: 'd', status: 'blocked',
    assignee: 'developer_ai', dependencies: [], allowedPaths: ['apps/api/src/pl'],
  } as never)
  const ids = { taskId: task.id, projectId: project.id }
  let parent = makeImplementJob(storage, ids, `task:${task.id}:initial-implement`, 'failed')
  for (let i = 0; i < 3; i += 1) parent = makeImplementJob(storage, ids, `repair:${parent.id}:1`, 'failed')
  const resumed = makeImplementJob(storage, ids, `resume:${parent.id}:1`, 'failed')
  const implementJob = makeImplementJob(storage, ids, `resume:${resumed.id}:1`, 'success')
  const created = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'reviewer_ai', status: 'queued',
    safeCommand: { kind: 'noop' }, aiCliMode: 'review', aiCliProvider: 'claude_code',
    workflowStepKey: `implement:${implementJob.id}:review`,
  } as never)
  const reviewJob = storage.jobs.update(created.id, { status: 'failed', exitCode: 0 } as never)!
  storage.reviewResults.create({
    taskId: task.id, jobId: reviewJob.id, reviewer: 'qa_ai', status: 'changes_requested',
    summary: 'fix two things', findings: [{ severity: 'medium', file: IN_SCOPE, message: 'state transition widened' }],
  } as never)
  return { taskId: task.id, implementJob, reviewJob }
}

function recover(storage: IStorage, shape: { taskId: string; reviewJob: Job }) {
  return repairFromStoredReview(storage, { taskId: shape.taskId, reviewJobId: shape.reviewJob.id }, { kick: () => {} })
}

async function decide(app: FastifyInstance, id: string, status: 'APPROVED' | 'REJECTED', token: string) {
  return app.inject({
    method: 'PATCH',
    url: `/api/approval-requests/${id}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status },
  })
}

describe('PATCH /api/approval-requests/:id/status — approval_actor を記録する', () => {
  it('ADMIN が承認した stored-review recovery は human authority として consume され、repair が queue される', async () => {
    useSplitCredentials()
    const { app, storage } = await buildApp()
    try {
      const shape = storedReviewShape(storage)
      const first = recover(storage, shape)
      expect(first.status).toBe('awaiting_approval')
      if (first.status !== 'awaiting_approval') return

      const res = await decide(app, first.approvalRequestId, 'APPROVED', ADMIN_TOKEN)
      expect(res.statusCode).toBe(200)
      expect(readApprovalActorClass(storage, first.approvalRequestId)).toBe('human')

      const second = recover(storage, shape)
      expect(second.status).toBe('queued')
      if (second.status !== 'queued') return
      expect(second.stepKey).toBe(`repair:${shape.implementJob.id}:1`)
      expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('CONSUMED')
    } finally {
      await app.close()
    }
  })

  // C-02: 承認 PATCH は HUMAN_ONLY_ROUTES。legacy 単一 token では人と Worker を区別できないので、
  // 正しい token でも 403（HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS）で、決定も actor 行も残らない。
  it('legacy 単一 token では承認 PATCH に届かず（403）、決定も actor 記録も残らない', async () => {
    useLegacyCredential()
    const { app, storage } = await buildApp()
    try {
      const shape = storedReviewShape(storage)
      const first = recover(storage, shape)
      if (first.status !== 'awaiting_approval') throw new Error(`unexpected ${first.status}`)

      const res = await decide(app, first.approvalRequestId, 'APPROVED', LEGACY_TOKEN)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS' })
      expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('WAITING_FOR_USER')
      expect(readApprovalActorClass(storage, first.approvalRequestId)).toBe('unknown')
    } finally {
      await app.close()
    }
  })

  it('認証なし（API_TOKEN 未設定）の構成でも承認 PATCH は 403', async () => {
    const { app, storage } = await buildApp()
    try {
      const shape = storedReviewShape(storage)
      const first = recover(storage, shape)
      if (first.status !== 'awaiting_approval') throw new Error(`unexpected ${first.status}`)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${first.approvalRequestId}/status`,
        payload: { status: 'APPROVED' },
      })
      expect(res.statusCode).toBe(403)
      expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('WAITING_FOR_USER')
    } finally {
      await app.close()
    }
  })

  it('WORKER credential は承認 PATCH に届かず（403）、決定も actor 記録も残らない', async () => {
    useSplitCredentials()
    const { app, storage } = await buildApp()
    try {
      const shape = storedReviewShape(storage)
      const first = recover(storage, shape)
      if (first.status !== 'awaiting_approval') throw new Error(`unexpected ${first.status}`)

      const res = await decide(app, first.approvalRequestId, 'APPROVED', WORKER_TOKEN)
      expect(res.statusCode).toBe(403)
      expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('WAITING_FOR_USER')
      expect(readApprovalActorClass(storage, first.approvalRequestId)).toBe('unknown')
    } finally {
      await app.close()
    }
  })

  // H-03: 決定と actor 記録は同じ transaction。actor 行の書き込みが落ちたら決定も（git_commit は Job の
  // 再 queue も）残らず、要求は WAITING のまま —— 同じ PATCH をもう一度送れば通る（409 で詰まない）。
  it('actor 行の書き込みが transaction 内で失敗すると、決定も actor 行も残らず、再 PATCH で通る', async () => {
    useSplitCredentials()
    const { app, storage } = await buildApp()
    try {
      const shape = storedReviewShape(storage)
      const first = recover(storage, shape)
      if (first.status !== 'awaiting_approval') throw new Error(`unexpected ${first.status}`)

      const original = storage.auditLog.record.bind(storage.auditLog)
      const spy = vi.spyOn(storage.auditLog, 'record').mockImplementation((entry) => {
        if (entry.operation === 'approval_actor') throw new Error('simulated crash inside the decision transaction')
        return original(entry)
      })
      const failed = await decide(app, first.approvalRequestId, 'APPROVED', ADMIN_TOKEN)
      spy.mockRestore()

      expect(failed.statusCode).toBe(500)
      expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('WAITING_FOR_USER')
      expect(storage.auditLog.findByEntity('approval_request', first.approvalRequestId)).toEqual([])
      expect(readApprovalActorClass(storage, first.approvalRequestId)).toBe('unknown')

      const retried = await decide(app, first.approvalRequestId, 'APPROVED', ADMIN_TOKEN)
      expect(retried.statusCode).toBe(200)
      expect(readApprovalActorClass(storage, first.approvalRequestId)).toBe('human')
      expect(recover(storage, shape).status).toBe('queued')
    } finally {
      await app.close()
    }
  })

  it('git_commit の承認も、actor 行が書けなければ承認と Job の再 queue ごと rollback される', async () => {
    useSplitCredentials()
    const { app, storage } = await buildApp()
    try {
      const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
      const task = storage.tasks.create({
        projectId: project.id, title: 'T', description: 'd', status: 'in_progress',
        assignee: 'developer_ai', dependencies: [],
      } as never)
      const created = storage.jobs.create({
        taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'queued',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', args: { message: 'm' } },
      } as never)
      const job = storage.jobs.update(created.id, { status: 'blocked' } as never)!
      const linked = storage.approvalRequests.createForJob({
        taskId: task.id, targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd', riskLevel: 'HIGH',
        requestedAction: 'git_commit', status: 'WAITING_FOR_USER',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), invalidIf: [],
      } as never, job.id)
      if (!linked.ok) throw new Error(linked.reason)
      const approvalId = linked.approvalRequest.id

      const original = storage.auditLog.record.bind(storage.auditLog)
      const spy = vi.spyOn(storage.auditLog, 'record').mockImplementation((entry) => {
        if (entry.operation === 'approval_actor') throw new Error('simulated crash inside the approve transaction')
        return original(entry)
      })
      const failed = await decide(app, approvalId, 'APPROVED', ADMIN_TOKEN)
      spy.mockRestore()

      expect(failed.statusCode).toBe(500)
      expect(storage.approvalRequests.findById(approvalId)?.status).toBe('WAITING_FOR_USER')
      expect(storage.jobs.findById(job.id)?.status).toBe('blocked')
      expect(readApprovalActorClass(storage, approvalId)).toBe('unknown')

      const retried = await decide(app, approvalId, 'APPROVED', ADMIN_TOKEN)
      expect(retried.statusCode).toBe(200)
      expect(storage.approvalRequests.findById(approvalId)?.status).toBe('APPROVED')
      expect(storage.jobs.findById(job.id)?.status).toBe('queued')
      expect(readApprovalActorClass(storage, approvalId)).toBe('human')
    } finally {
      await app.close()
    }
  })

  it('REJECTED も、git_commit 以外の任意の action も、決定者を記録する', async () => {
    useSplitCredentials()
    const { app, storage } = await buildApp()
    try {
      const shape = storedReviewShape(storage)
      const created = storage.approvalRequests.replaceActiveAndCreate({
        taskId: shape.taskId, targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd', riskLevel: 'HIGH',
        requestedAction: 'abort_task', status: 'WAITING_FOR_USER',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), invalidIf: [],
      }).approvalRequest

      const res = await decide(app, created.id, 'REJECTED', ADMIN_TOKEN)
      expect(res.statusCode).toBe(200)
      expect(storage.approvalRequests.findById(created.id)?.status).toBe('REJECTED')
      expect(readApprovalActorClass(storage, created.id)).toBe('human')
    } finally {
      await app.close()
    }
  })
})
