import { describe, expect, it } from 'vitest'
import type { IStorage } from './interface'
import { createSQLiteStorage } from './sqlite'
import { authorizePlAction, PlActionBlockedError } from '../pl/actionGate'

/**
 * Codex review 361c19a:
 *  1. Task 単位の人の判断は、approval_actor = human の記録があって初めて authority になる
 *     （stored-review recovery と同じ正本の規則）。PL の approval_gate と Task 単位の consume の両方で。
 *  2. live な WAITING の Task 単位 request も resume / recover の C-03 規則に乗る
 *     （共有 admission が APPROVAL_WAITING で先に断らない）。
 */

const HOUR = 60 * 60 * 1000
const HUMAN = { actorClass: 'human', evidence: 'admin_credential' } as const
const PL = { actorClass: 'pl', evidence: 'in_process_pl' } as const

function seedTask(storage: IStorage, withBlockedJob: boolean): { taskId: string; jobId?: string } {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'blocked',
    assignee: 'developer_ai', dependencies: [],
  } as Parameters<IStorage['tasks']['create']>[0])
  if (!withBlockedJob) return { taskId: task.id }
  const job = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' }, dryRun: false,
    workflowStepKey: 'review:some-review-job:git-commit',
  } as Parameters<IStorage['jobs']['create']>[0])
  return { taskId: task.id, jobId: job.id }
}

function request(storage: IStorage, taskId: string, requestedAction: string): string {
  return storage.approvalRequests.create({
    taskId, requestedAction, riskLevel: 'HIGH', targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: [], status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
  } as Parameters<IStorage['approvalRequests']['create']>[0]).id
}

describe('Task 単位の承認は approval_actor = human でだけ authority になる', () => {
  it('actor 記録の無い（actor 記録導入前の）APPROVED abort_task は PL approval_gate を通らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = request(storage, taskId, 'reconcile_external_completion')
    storage.approvalRequests.updateStatus(id, 'APPROVED')

    expect(() => authorizePlAction(storage, {
      proposal: { kind: 'reconcile_external_completion' },
      target: { kind: 'task', taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId: id }],
    })).toThrow(PlActionBlockedError)
    expect(() => authorizePlAction(storage, {
      proposal: { kind: 'reconcile_external_completion' },
      target: { kind: 'task', taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId: id }],
    })).toThrow(/APPROVAL_ACTOR_NOT_HUMAN/)
  })

  it('ADMIN が決めた APPROVED は PL approval_gate を通る', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = request(storage, taskId, 'reconcile_external_completion')
    storage.approvalRequests.recordDecision(id, 'APPROVED', undefined, { credentialClass: 'admin' })

    expect(() => authorizePlAction(storage, {
      proposal: { kind: 'reconcile_external_completion' },
      target: { kind: 'task', taskId },
      evidence: [{ gate: 'approval_gate', approvalRequestId: id }],
    })).not.toThrow()
  })

  it.each([
    ['actor 記録なし', undefined],
    ['legacy 単一 token', 'legacy'],
  ] as const)('%s の APPROVED は consume されず、同じ transaction で SUPERSEDED になる', (_label, credentialClass) => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = request(storage, taskId, 'abort_task')
    if (credentialClass === undefined) storage.approvalRequests.updateStatus(id, 'APPROVED')
    else storage.approvalRequests.recordDecision(id, 'APPROVED', undefined, { credentialClass })

    const consumed = storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId, approvalRequestId: id, expectedAction: 'abort_task',
    })

    expect(consumed).toMatchObject({ ok: false, code: 'APPROVAL_ACTOR_NOT_HUMAN' })
    expect(storage.approvalRequests.findById(id)?.status).toBe('SUPERSEDED')
    expect(storage.auditLog.findByEntity('approval_request', id)
      .some((entry) => entry.operation === 'supersede' && entry.detail === 'reason=approval_actor_not_human')).toBe(true)
  })

  it('ADMIN が決めた APPROVED は consume できる', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = request(storage, taskId, 'abort_task')
    storage.approvalRequests.recordDecision(id, 'APPROVED', undefined, { credentialClass: 'admin' })

    expect(storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId, approvalRequestId: id, expectedAction: 'abort_task',
    })).toEqual({ ok: true })
    expect(storage.approvalRequests.findById(id)?.status).toBe('CONSUMED')
  })

  it('決定の書き手は decidedBy を必須にする（actor 証拠の無い決定を作れない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = request(storage, taskId, 'abort_task')

    expect(() => storage.approvalRequests.recordDecision(id, 'APPROVED', undefined, undefined as never)).toThrow(/decidedBy/)
    expect(storage.approvalRequests.findById(id)?.status).toBe('WAITING_FOR_USER')
  })

  // lifecycle repair final（P3）: 期限切れの WAITING を transaction の中で読み直して決定しない。
  it.each(['APPROVED', 'REJECTED'] as const)('期限切れの WAITING を %s にしない（EXPIRED へ進め、actor 証拠も書かない）', (decision) => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = storage.approvalRequests.create({
      taskId, requestedAction: 'abort_task', riskLevel: 'HIGH', targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
      changedFiles: [], triggeredRules: [], invalidIf: [], status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    } as Parameters<IStorage['approvalRequests']['create']>[0]).id

    const result = storage.approvalRequests.recordDecision(id, decision, undefined, { credentialClass: 'admin' })

    expect(result).toMatchObject({ ok: false, code: 'EXPIRED', approvalRequest: { status: 'EXPIRED' } })
    expect(storage.approvalRequests.findById(id)?.status).toBe('EXPIRED')
    expect(storage.auditLog.findByEntity('approval_request', id)
      .some((entry) => entry.operation === 'approval_actor')).toBe(false)
    expect(storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId, approvalRequestId: id, expectedAction: 'abort_task',
    })).toMatchObject({ ok: false })
  })

  it('決定済みの行は決定し直さない（STATUS_CONFLICT・行は変わらない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const id = request(storage, taskId, 'abort_task')
    expect(storage.approvalRequests.recordDecision(id, 'REJECTED', undefined, { credentialClass: 'admin' }))
      .toMatchObject({ ok: true, approvalRequest: { status: 'REJECTED' } })

    expect(storage.approvalRequests.recordDecision(id, 'APPROVED', undefined, { credentialClass: 'admin' }))
      .toMatchObject({ ok: false, code: 'STATUS_CONFLICT' })
    expect(storage.approvalRequests.findById(id)?.status).toBe('REJECTED')
  })
})

describe('live WAITING の Task 単位 request も resume / recover の規則に乗る', () => {
  it('Human Resume は live WAITING の abort_task を置き換えて再開する（APPROVAL_WAITING で止まらない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, true)
    const waiting = request(storage, taskId, 'abort_task')

    const resumed = storage.jobs.resumeBlockedTask({ taskId, instructionPrompt: 'resume', resumedBy: HUMAN })

    expect(resumed.ok).toBe(true)
    expect(storage.approvalRequests.findById(waiting)?.status).toBe('SUPERSEDED')
  })

  it('人でない resume は live WAITING の Task 単位 request があると HUMAN_DECISION_PENDING', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, true)
    const waiting = request(storage, taskId, 'repair_from_stored_review:review-1')

    expect(storage.jobs.resumeBlockedTask({ taskId, instructionPrompt: 'resume', resumedBy: PL }))
      .toMatchObject({ ok: false, code: 'HUMAN_DECISION_PENDING' })
    expect(storage.approvalRequests.findById(waiting)?.status).toBe('WAITING_FOR_USER')
  })

  it('live WAITING の command kind 承認は人の resume でも従来どおり APPROVAL_WAITING', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, true)
    const waiting = request(storage, taskId, 'git_revert')

    expect(storage.jobs.resumeBlockedTask({ taskId, instructionPrompt: 'resume', resumedBy: HUMAN }))
      .toMatchObject({ ok: false, code: 'APPROVAL_WAITING' })
    expect(storage.approvalRequests.findById(waiting)?.status).toBe('WAITING_FOR_USER')
  })

  it('Human Recovery は live WAITING の Task 単位 request を置き換えて復旧する', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    const waiting = request(storage, taskId, 'reconcile_external_completion')

    const recovered = storage.tasks.recoverFromBlocked({ taskId, detail: 'human recovery' })

    expect(recovered.ok).toBe(true)
    expect(storage.approvalRequests.findById(waiting)?.status).toBe('SUPERSEDED')
  })

  it('Human Recovery も live WAITING の command kind 承認では従来どおり断る', () => {
    const storage = createSQLiteStorage(':memory:')
    const { taskId } = seedTask(storage, false)
    request(storage, taskId, 'git_revert')

    expect(storage.tasks.recoverFromBlocked({ taskId, detail: 'human recovery' }))
      .toMatchObject({ ok: false, code: 'APPROVAL_WAITING' })
  })
})
