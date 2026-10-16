import { describe, expect, it, vi } from 'vitest'
import type { ApprovalGateStatus, ApprovalRequest } from '@ai-team/shared'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

/**
 * 新しい ApprovalRequest を作るときの invariant（2026-10-16 PL 判断）:
 * Task あたり WAITING_FOR_USER は高々1件（action・期限を問わず畳む）。APPROVED は人の判断なので
 * 別 action の要求では SUPERSEDED にしない。同 action の APPROVED は
 * `replaceActiveAndCreate()` では置き換え、Job 束縛の `createForJob()`（git_commit）では残す。
 */

const LIVE = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const EXPIRED = (): string => new Date(Date.now() - 60 * 1000).toISOString()

function seedTask(storage: IStorage): { projectId: string; taskId: string } {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'draft' })
  const taskId = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'blocked',
    assignee: 'developer_ai', dependencies: [],
  }).id
  return { projectId: project.id, taskId }
}

function input(
  taskId: string,
  requestedAction: string,
  status: ApprovalGateStatus = 'WAITING_FOR_USER',
  expiresAt: string = LIVE(),
): Omit<ApprovalRequest, 'id' | 'createdAt'> {
  return {
    taskId, requestedAction, riskLevel: 'HIGH',
    targetBranch: 'ai/x', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: [],
    status, expiresAt,
  } as Omit<ApprovalRequest, 'id' | 'createdAt'>
}

function statusOf(storage: IStorage, id: string): ApprovalGateStatus | undefined {
  return storage.approvalRequests.findById(id)?.status
}

function waitingIds(storage: IStorage, taskId: string): string[] {
  return storage.approvalRequests.findByTaskId(taskId)
    .filter((request) => request.status === 'WAITING_FOR_USER')
    .map((request) => request.id)
}

describe('approvalRequests.replaceActiveAndCreate', () => {
  it('WAITING は action・期限を問わず、APPROVED は同 action だけ SUPERSEDED にする', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage)
    const otherWaiting = storage.approvalRequests.create(input(taskId, 'abort_task')).id
    const otherExpiredWaiting = storage.approvalRequests.create(
      input(taskId, 'git_commit', 'WAITING_FOR_USER', EXPIRED()),
    ).id
    const otherApproved = storage.approvalRequests.create(input(taskId, 'abort_task', 'APPROVED')).id
    const sameExpiredWaiting = storage.approvalRequests.create(
      input(taskId, 'repair_from_stored_review:x', 'WAITING_FOR_USER', EXPIRED()),
    ).id
    const sameApproved = storage.approvalRequests.create(
      input(taskId, 'repair_from_stored_review:x', 'APPROVED', EXPIRED()),
    ).id
    const rejected = storage.approvalRequests.create(input(taskId, 'git_commit', 'REJECTED')).id
    const consumed = storage.approvalRequests.create(input(taskId, 'abort_task', 'CONSUMED')).id
    const expired = storage.approvalRequests.create(input(taskId, 'abort_task', 'EXPIRED')).id

    const result = storage.approvalRequests.replaceActiveAndCreate(input(taskId, 'repair_from_stored_review:x'))

    const superseded = [otherWaiting, otherExpiredWaiting, sameExpiredWaiting, sameApproved]
    expect([...result.supersededIds].sort()).toEqual([...superseded].sort())
    for (const id of superseded) {
      expect(statusOf(storage, id)).toBe('SUPERSEDED')
      // 人の判断を偽らない: reason / reviewedAt は書かない。
      expect(storage.approvalRequests.findById(id)?.reviewedAt).toBeUndefined()
      expect(storage.auditLog.findByEntity('approval_request', id)).toEqual([
        expect.objectContaining({
          operation: 'supersede',
          result: 'success',
          detail: expect.stringContaining(`new_approval_id=${result.approvalRequest.id}`),
        }),
      ])
    }
    // 別 action の APPROVED は人の判断なので残る（進行中の abort_task 承認を消さない）。
    expect(statusOf(storage, otherApproved)).toBe('APPROVED')
    expect(statusOf(storage, rejected)).toBe('REJECTED')
    expect(statusOf(storage, consumed)).toBe('CONSUMED')
    expect(statusOf(storage, expired)).toBe('EXPIRED')
    expect(waitingIds(storage, taskId)).toEqual([result.approvalRequest.id])
  })

  it.each([
    ['git_commit', 'repair_from_stored_review:x'],
    ['repair_from_stored_review:x', 'git_commit'],
    ['abort_task', 'recover_blocked_task'],
    ['recover_blocked_task', 'abort_task'],
  ])('作成順 %s → %s のどちらでも WAITING は新しい1件だけ', (first, second) => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage)
    const a = storage.approvalRequests.replaceActiveAndCreate(input(taskId, first))
    const b = storage.approvalRequests.replaceActiveAndCreate(input(taskId, second))

    expect(a.supersededIds).toEqual([])
    expect(b.supersededIds).toEqual([a.approvalRequest.id])
    expect(statusOf(storage, a.approvalRequest.id)).toBe('SUPERSEDED')
    expect(waitingIds(storage, taskId)).toEqual([b.approvalRequest.id])
  })

  it.each([
    ['git_commit', 'repair_from_stored_review:x'],
    ['repair_from_stored_review:x', 'git_commit'],
  ])('作成順 %s(APPROVED) → %s でも別 action の APPROVED は残る', (first, second) => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage)
    const a = storage.approvalRequests.replaceActiveAndCreate(input(taskId, first))
    storage.approvalRequests.updateStatus(a.approvalRequest.id, 'APPROVED')
    const b = storage.approvalRequests.replaceActiveAndCreate(input(taskId, second))

    expect(b.supersededIds).toEqual([])
    expect(statusOf(storage, a.approvalRequest.id)).toBe('APPROVED')
    expect(waitingIds(storage, taskId)).toEqual([b.approvalRequest.id])
  })

  it('別 Task の行には触れない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage)
    const { taskId: otherTaskId } = seedTask(storage)
    const foreign = storage.approvalRequests.create(input(otherTaskId, 'abort_task')).id

    expect(storage.approvalRequests.replaceActiveAndCreate(input(taskId, 'abort_task')).supersededIds).toEqual([])
    expect(statusOf(storage, foreign)).toBe('WAITING_FOR_USER')
  })

  it('insert が失敗したら supersede も audit も残さない（単一 transaction）', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage)
    const existing = storage.approvalRequests.create(input(taskId, 'abort_task')).id
    const spy = vi.spyOn(storage.approvalRequests, 'create').mockImplementation(() => {
      throw new Error('insert failed')
    })

    expect(() => storage.approvalRequests.replaceActiveAndCreate(input(taskId, 'git_commit')))
      .toThrow('insert failed')
    spy.mockRestore()

    expect(statusOf(storage, existing)).toBe('WAITING_FOR_USER')
    expect(storage.auditLog.findByEntity('approval_request', existing)).toEqual([])
    expect(waitingIds(storage, taskId)).toEqual([existing])
  })
})

describe('approvalRequests.createForJob — 同じ規則で WAITING だけを畳む', () => {
  function gitCommitJob(storage: IStorage, projectId: string, taskId: string): string {
    return storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' }, dryRun: false,
    }).id
  }

  it('他の WAITING（別 action・別 Job の git_commit・期限切れ）を SUPERSEDED にし、APPROVED は action を問わず残す', () => {
    const storage = createSQLiteStorage(':memory:')
    const { projectId, taskId } = seedTask(storage)
    const otherActionWaiting = storage.approvalRequests.create(input(taskId, 'abort_task')).id
    const olderJob = gitCommitJob(storage, projectId, taskId)
    const olderLinked = storage.approvalRequests.createForJob(input(taskId, 'git_commit'), olderJob)
    if (!olderLinked.ok) throw new Error('older linked approval not created')
    const expiredWaiting = storage.approvalRequests.create(
      input(taskId, 'repair_from_stored_review:x', 'WAITING_FOR_USER', EXPIRED()),
    ).id
    const otherActionApproved = storage.approvalRequests.create(input(taskId, 'abort_task', 'APPROVED')).id
    const sameActionApproved = storage.approvalRequests.create(input(taskId, 'git_commit', 'APPROVED')).id

    const job = gitCommitJob(storage, projectId, taskId)
    const created = storage.approvalRequests.createForJob(input(taskId, 'git_commit'), job)
    if (!created.ok) throw new Error('linked approval not created')

    expect(statusOf(storage, otherActionWaiting)).toBe('SUPERSEDED')
    expect(statusOf(storage, olderLinked.approvalRequest.id)).toBe('SUPERSEDED')
    expect(statusOf(storage, expiredWaiting)).toBe('SUPERSEDED')
    expect(statusOf(storage, otherActionApproved)).toBe('APPROVED')
    expect(statusOf(storage, sameActionApproved)).toBe('APPROVED')
    expect(waitingIds(storage, taskId)).toEqual([created.approvalRequest.id])
    expect(storage.jobs.findById(job)?.approvalId).toBe(created.approvalRequest.id)
    expect(storage.auditLog.findByEntity('approval_request', otherActionWaiting)).toEqual([
      expect.objectContaining({ operation: 'supersede', detail: expect.stringContaining('new_requested_action=git_commit') }),
    ])
  })

  it('Job 検証で拒否したときは何も SUPERSEDED にしない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { projectId, taskId } = seedTask(storage)
    const waiting = storage.approvalRequests.create(input(taskId, 'abort_task')).id
    const job = gitCommitJob(storage, projectId, taskId)

    expect(storage.approvalRequests.createForJob(input(taskId, 'test'), job)).toMatchObject({
      ok: false, code: 'JOB_MISMATCH',
    })
    expect(statusOf(storage, waiting)).toBe('WAITING_FOR_USER')
  })
})
