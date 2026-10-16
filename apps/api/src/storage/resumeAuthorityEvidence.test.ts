import { describe, expect, it, vi } from 'vitest'
import type { IStorage } from './interface'
import { createSQLiteStorage } from './sqlite'
import { abortTask } from '../pl/abortTask'
import { recordApprovalActor, resumeActorClassFromAudit, RESUME_ACTOR_OPERATION } from '../designReview/resumeActor'

/**
 * G-01: authority を変える遷移と、その authority evidence は一緒に commit する。
 * C-03: 新しい人の判断（Human Resume / Human Recovery）は、その Task の古い Task 単位の判断を置き換える。
 * 人でない resume は、生きた Task 単位の人の判断がある間は再開しない（HUMAN_DECISION_PENDING）。
 */

const HOUR = 60 * 60 * 1000
const HUMAN = { actorClass: 'human', evidence: 'admin_credential' } as const
const PL = { actorClass: 'pl', evidence: 'in_process_pl' } as const

function seedBlockedTask(storage: IStorage): { taskId: string; projectId: string; jobId: string } {
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'blocked',
    assignee: 'developer_ai', dependencies: [],
  } as Parameters<IStorage['tasks']['create']>[0])
  const job = storage.jobs.create({
    taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
    safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' }, dryRun: false,
    workflowStepKey: 'review:some-review-job:git-commit',
  } as Parameters<IStorage['jobs']['create']>[0])
  return { taskId: task.id, projectId: project.id, jobId: job.id }
}

function taskApproval(
  storage: IStorage,
  taskId: string,
  requestedAction: string,
  status: 'APPROVED' | 'WAITING_FOR_USER' = 'APPROVED',
  /** APPROVED を人（ADMIN）の決定として記録するか。記録の無い APPROVED は authority ではない（C3）。 */
  decidedBy: 'admin' | 'none' = 'admin',
): string {
  const id = storage.approvalRequests.create({
    taskId, requestedAction, riskLevel: 'HIGH', targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
    changedFiles: [], triggeredRules: [], invalidIf: [], status,
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
  } as Parameters<IStorage['approvalRequests']['create']>[0]).id
  if (status === 'APPROVED' && decidedBy === 'admin') recordApprovalActor(storage, id, 'admin')
  return id
}

function resumeActorRows(storage: IStorage, jobId: string) {
  return storage.auditLog.findByEntity('job', jobId).filter((entry) => entry.operation === RESUME_ACTOR_OPERATION)
}

describe('resumeBlockedTask — resume_actor は resume と同じ transaction で書く（G-01）', () => {
  it('通常の resume では resume Job と resume_actor 行が両方残る', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)

    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })

    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumeActorClassFromAudit(resumeActorRows(storage, resumed.job.id))).toBe('human')
  })

  it('resume_actor の書き込みが失敗すると resume ごと rollback し、再試行可能な RESUME_COMMIT_FAILED を返す', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const jobsBefore = storage.jobs.findByTaskId(seeded.taskId).map((job) => job.id)

    const original = storage.auditLog.record.bind(storage.auditLog)
    const spy = vi.spyOn(storage.auditLog, 'record').mockImplementation((entry) => {
      if (entry.operation === RESUME_ACTOR_OPERATION) throw new Error('disk is full')
      return original(entry)
    })
    const failed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })
    spy.mockRestore()

    expect(failed).toMatchObject({ ok: false, code: 'RESUME_COMMIT_FAILED' })
    // resume Job は作られておらず、source も blocked のまま（終端化も rollback）。
    expect(storage.jobs.findByTaskId(seeded.taskId).map((job) => job.id)).toEqual(jobsBefore)
    expect(storage.jobs.findById(seeded.jobId)?.status).toBe('blocked')
    expect(storage.auditLog.findAll().filter((entry) => entry.operation === RESUME_ACTOR_OPERATION)).toEqual([])

    // 同じ resume を再試行すれば通る。
    const retried = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(resumeActorClassFromAudit(resumeActorRows(storage, retried.job.id))).toBe('human')
  })
})

describe('resume admission refuses while a repair Design Review run is in flight (lifecycle repair C3 / D3-1)', () => {
  it('human resume of a blocked task with a queued repair run is REPAIR_REVIEW_IN_FLIGHT and creates nothing', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const run = storage.designReviewRuns.create({
      taskId: seeded.taskId, taskTitle: 'T', designText: 'repair', designTextHash: 'h', changedFiles: [],
      repairSourceJobId: seeded.jobId,
    })
    const jobsBefore = storage.jobs.findByTaskId(seeded.taskId).map((job) => job.id)
    expect(storage.tasks.hasRepairDesignReviewInFlight(seeded.taskId)).toBe(true)

    const refused = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })

    expect(refused).toMatchObject({ ok: false, code: 'REPAIR_REVIEW_IN_FLIGHT' })
    expect(storage.jobs.findByTaskId(seeded.taskId).map((job) => job.id)).toEqual(jobsBefore)

    // run が終端すれば（running も同じ扱い）resume は通る。
    const claim = storage.designReviewRuns.claim(run.id, 3)
    expect(storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN }))
      .toMatchObject({ ok: false, code: 'REPAIR_REVIEW_IN_FLIGHT' })
    storage.designReviewRuns.complete(run.id, claim.claimToken!, 'failed', undefined, 'boom')
    expect(storage.tasks.hasRepairDesignReviewInFlight(seeded.taskId)).toBe(false)
    expect(storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN }).ok).toBe(true)
  })
})

describe('Task 単位の承認は新しい人の判断で置き換わる（C-03）', () => {
  it('APPROVED abort_task の後に Human Resume すると abort は SUPERSEDED になり、後から park に使えない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const abortApproval = taskApproval(storage, seeded.taskId, 'abort_task')
    const reconcileWaiting = taskApproval(storage, seeded.taskId, 'reconcile_external_completion', 'APPROVED')

    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return

    expect(storage.approvalRequests.findById(abortApproval)?.status).toBe('SUPERSEDED')
    expect(storage.approvalRequests.findById(reconcileWaiting)?.status).toBe('SUPERSEDED')
    expect(storage.auditLog.findByEntity('approval_request', abortApproval)
      .filter((entry) => entry.operation === 'supersede')).toEqual([
      expect.objectContaining({
        operation: 'supersede',
        detail: `reason=superseded_by_resume resume_job_id=${resumed.job.id}`,
      }),
    ])

    // 古い承認では park できない（新しい作業を後から止めない）。
    const parked = abortTask(storage, { taskId: seeded.taskId, approvalRequestId: abortApproval, reason: 'old decision' })
    expect(parked.ok).toBe(false)
    expect(storage.tasks.isParked(seeded.taskId)).toBe(false)
    expect(storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: seeded.taskId, approvalRequestId: abortApproval, expectedAction: 'abort_task',
    }).ok).toBe(false)
  })

  it('PL の resume は生きた人の判断（APPROVED abort_task）を置き換えず、HUMAN_DECISION_PENDING で再開しない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const abortApproval = taskApproval(storage, seeded.taskId, 'abort_task')
    const jobsBefore = storage.jobs.findByTaskId(seeded.taskId).map((job) => job.id)

    const refused = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: PL })

    expect(refused).toMatchObject({ ok: false, code: 'HUMAN_DECISION_PENDING' })
    expect(storage.approvalRequests.findById(abortApproval)?.status).toBe('APPROVED')
    expect(storage.jobs.findByTaskId(seeded.taskId).map((job) => job.id)).toEqual(jobsBefore)
    expect(storage.jobs.findById(seeded.jobId)?.status).toBe('blocked')

    // 続いて人が resume すれば、abort は置き換えられて resume が進む。
    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })
    expect(resumed.ok).toBe(true)
    expect(storage.approvalRequests.findById(abortApproval)?.status).toBe('SUPERSEDED')
  })

  it('主体不明（resumedBy なし）の resume も、生きた Task 単位の APPROVED がある間は再開しない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    // live WAITING は resume admission（APPROVAL_WAITING）が先に断るので、ここでは APPROVED で確かめる。
    taskApproval(storage, seeded.taskId, 'repair_from_stored_review:review-1')

    expect(storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume' }))
      .toMatchObject({ ok: false, code: 'HUMAN_DECISION_PENDING' })
  })

  it('決定主体の記録が無い APPROVED abort_task は PL の resume を止めず、approval_actor_not_human で SUPERSEDED になる（C3）', () => {
    // 実行側（verifyAndConsumeTaskApproval）が authority として使わない行を、HUMAN_DECISION_PENDING の
    // 根拠にしない。authoritative な resume 経路で出会ったので、consume 側と同じ理由で置き換える。
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const actorless = taskApproval(storage, seeded.taskId, 'abort_task', 'APPROVED', 'none')

    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: PL })

    expect(resumed.ok).toBe(true)
    expect(storage.approvalRequests.findById(actorless)?.status).toBe('SUPERSEDED')
    expect(storage.auditLog.findByEntity('approval_request', actorless)).toEqual([
      expect.objectContaining({ operation: 'supersede', detail: 'reason=approval_actor_not_human' }),
    ])
  })

  it('期限切れの APPROVED や command kind の承認は PL の resume を止めない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const expired = storage.approvalRequests.create({
      taskId: seeded.taskId, requestedAction: 'abort_task', riskLevel: 'HIGH', targetBranch: 'b', targetCommit: 'c',
      targetDiffHash: 'd', changedFiles: [], triggeredRules: [], invalidIf: [], status: 'APPROVED',
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    } as Parameters<IStorage['approvalRequests']['create']>[0]).id
    const command = taskApproval(storage, seeded.taskId, 'git_revert')

    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: PL })

    expect(resumed.ok).toBe(true)
    expect(storage.approvalRequests.findById(expired)?.status).toBe('APPROVED')
    expect(storage.approvalRequests.findById(command)?.status).toBe('APPROVED')
  })

  it('command kind の承認（git_commit 以外も含む）には触れない', () => {
    const storage = createSQLiteStorage(':memory:')
    const seeded = seedBlockedTask(storage)
    const commandApproval = taskApproval(storage, seeded.taskId, 'git_revert', 'APPROVED', 'none')

    const resumed = storage.jobs.resumeBlockedTask({ taskId: seeded.taskId, instructionPrompt: 'resume', resumedBy: HUMAN })

    expect(resumed.ok).toBe(true)
    expect(storage.approvalRequests.findById(commandApproval)?.status).toBe('APPROVED')
    expect(storage.auditLog.findByEntity('approval_request', commandApproval)).toEqual([])
  })

  it('Human Recovery も Task 単位の APPROVED を SUPERSEDED にする（reason=superseded_by_recover）', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'blocked',
      assignee: 'developer_ai', dependencies: [],
    } as Parameters<IStorage['tasks']['create']>[0])
    const repairApproval = taskApproval(storage, task.id, 'repair_from_stored_review:review-1')

    const recovered = storage.tasks.recoverFromBlocked({ taskId: task.id, detail: 'human recovery' })

    expect(recovered.ok).toBe(true)
    expect(storage.approvalRequests.findById(repairApproval)?.status).toBe('SUPERSEDED')
    expect(storage.auditLog.findByEntity('approval_request', repairApproval)
      .filter((entry) => entry.operation === 'supersede')).toEqual([
      expect.objectContaining({
        operation: 'supersede',
        detail: `reason=superseded_by_recover recovered_task_id=${task.id}`,
      }),
    ])
  })
})
