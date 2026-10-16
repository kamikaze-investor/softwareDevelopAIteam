import { describe, expect, it, vi } from 'vitest'
import type { ApprovalGateStatus, ApprovalRequest } from '@ai-team/shared'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

/**
 * `approvalRequests.replaceActiveAndCreate()` —— Task あたり active request
 * （WAITING_FOR_USER / APPROVED）は action・期限を問わず高々1件、という invariant。
 */

const LIVE = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const EXPIRED = (): string => new Date(Date.now() - 60 * 1000).toISOString()

function seedTask(storage: IStorage): string {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'draft' })
  return storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'blocked',
    assignee: 'developer_ai', dependencies: [],
  }).id
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

function activeRows(storage: IStorage, taskId: string): ApprovalRequest[] {
  return storage.approvalRequests.findByTaskId(taskId)
    .filter((request) => request.status === 'WAITING_FOR_USER' || request.status === 'APPROVED')
}

describe('approvalRequests.replaceActiveAndCreate', () => {
  it('別 action の active 行・期限切れの同 action 行を SUPERSEDED にし、終わった行は変えない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const otherWaiting = storage.approvalRequests.create(input(taskId, 'abort_task')).id
    const otherApproved = storage.approvalRequests.create(input(taskId, 'git_commit', 'APPROVED')).id
    const expiredSame = storage.approvalRequests.create(
      input(taskId, 'repair_from_stored_review:x', 'WAITING_FOR_USER', EXPIRED()),
    ).id
    const rejected = storage.approvalRequests.create(input(taskId, 'git_commit', 'REJECTED')).id
    const consumed = storage.approvalRequests.create(input(taskId, 'abort_task', 'CONSUMED')).id
    const expired = storage.approvalRequests.create(input(taskId, 'abort_task', 'EXPIRED')).id

    const result = storage.approvalRequests.replaceActiveAndCreate(input(taskId, 'repair_from_stored_review:x'))

    expect([...result.supersededIds].sort()).toEqual([otherWaiting, otherApproved, expiredSame].sort())
    for (const id of [otherWaiting, otherApproved, expiredSame]) {
      expect(storage.approvalRequests.findById(id)?.status).toBe('SUPERSEDED')
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
    expect(storage.approvalRequests.findById(rejected)?.status).toBe('REJECTED')
    expect(storage.approvalRequests.findById(consumed)?.status).toBe('CONSUMED')
    expect(storage.approvalRequests.findById(expired)?.status).toBe('EXPIRED')
    expect(activeRows(storage, taskId).map((request) => request.id)).toEqual([result.approvalRequest.id])
    expect(storage.approvalRequests.findActiveByTaskId(taskId)?.id).toBe(result.approvalRequest.id)
  })

  it.each([
    ['git_commit', 'repair_from_stored_review:x'],
    ['repair_from_stored_review:x', 'git_commit'],
    ['abort_task', 'recover_blocked_task'],
    ['recover_blocked_task', 'abort_task'],
  ])('作成順 %s → %s のどちらでも active は新しい1件だけ', (first, second) => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const a = storage.approvalRequests.replaceActiveAndCreate(input(taskId, first))
    const b = storage.approvalRequests.replaceActiveAndCreate(input(taskId, second))

    expect(a.supersededIds).toEqual([])
    expect(b.supersededIds).toEqual([a.approvalRequest.id])
    expect(storage.approvalRequests.findById(a.approvalRequest.id)?.status).toBe('SUPERSEDED')
    expect(activeRows(storage, taskId).map((request) => request.id)).toEqual([b.approvalRequest.id])
  })

  it('別 Task の active 行には触れない', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const otherTaskId = seedTask(storage)
    const foreign = storage.approvalRequests.create(input(otherTaskId, 'abort_task')).id

    expect(storage.approvalRequests.replaceActiveAndCreate(input(taskId, 'abort_task')).supersededIds).toEqual([])
    expect(storage.approvalRequests.findById(foreign)?.status).toBe('WAITING_FOR_USER')
  })

  it('insert が失敗したら supersede も audit も残さない（単一 transaction）', () => {
    const storage = createSQLiteStorage(':memory:')
    const taskId = seedTask(storage)
    const existing = storage.approvalRequests.create(input(taskId, 'abort_task')).id
    const spy = vi.spyOn(storage.approvalRequests, 'create').mockImplementation(() => {
      throw new Error('insert failed')
    })

    expect(() => storage.approvalRequests.replaceActiveAndCreate(input(taskId, 'git_commit')))
      .toThrow('insert failed')
    spy.mockRestore()

    expect(storage.approvalRequests.findById(existing)?.status).toBe('WAITING_FOR_USER')
    expect(storage.auditLog.findByEntity('approval_request', existing)).toEqual([])
    expect(activeRows(storage, taskId).map((request) => request.id)).toEqual([existing])
  })
})
