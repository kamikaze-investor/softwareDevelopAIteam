import { describe, expect, it } from 'vitest'
import type { Job } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { completeRepairHandoff, prepareRepairFlow } from './repairFlow'
import { repairFromStoredReview } from './repairFromStoredReview'
import { humanRecoveryAuthorityByImplementation, repairRecoveryActionFor } from './repairRecoveryEpoch'
import { recordApprovalActor, recordResumeActor } from './resumeActor'
import { designReviewRunAnsweredByHumanResume } from './repairFlow'

/**
 * **最新の初回 implement を、stepKey の形ではなく human authority の意味で認める**（b8d0fc5d）。
 *
 * production の形: initial-implement `4ce3f35d` 成功 → review `6652e0e2`（`implement:4ce3f35d:review`）が
 * `changes_requested` を保存 → repair Design Review run `c11357e8`（repairSourceJobId=4ce3f35d）が
 * 終端 → Task blocked。Stored Review Recovery も Human Resume も admission step 4 で黙って止まっていた。
 */

const DOC = 'docs/project_memory/decisions/vps-operations.md'
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

type RunKind = 'REVIEW_UNAVAILABLE' | 'NO_RESULT' | 'CONFLICT' | 'ALIGNED'

interface Shape {
  storage: IStorage
  taskId: string
  projectId: string
  impl: Job
  r0: Job
}

function job(s: IStorage, ids: { taskId: string; projectId: string }, fields: Record<string, unknown>, terminal: Record<string, unknown>): Job {
  const created = s.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'prompt',
    ...fields,
  } as never)
  return s.jobs.update(created.id, terminal as never)!
}

function verdict(s: IStorage, taskId: string, jobId: string): void {
  s.reviewResults.create({
    taskId,
    jobId,
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: `verdict of ${jobId}`,
    findings: [{ severity: 'medium', file: DOC, message: `finding from ${jobId}` }],
  } as never)
}

/** initial-implement（success）→ review（changes_requested）。 */
async function b8d0fc5dShape(): Promise<Shape> {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'VPS docs',
    description: 'd',
    status: 'blocked',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: [DOC],
    roadmapActive: true,
  } as never)
  const ids = { taskId: task.id, projectId: project.id }
  const impl = job(storage, ids, { aiCliMode: 'implement', workflowStepKey: `task:${task.id}:initial-implement` }, { status: 'success', exitCode: 0, changedFiles: [DOC] })
  await tick()
  const r0 = job(storage, ids, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${impl.id}:review` }, { status: 'failed', exitCode: 0 })
  verdict(storage, task.id, r0.id)
  await tick()
  return { storage, ...ids, impl, r0 }
}

/** 終端した repair Design Review run（`c11357e8` の位置）。 */
async function terminalRun(shape: Shape, kind: RunKind, repairSourceJobId: string = shape.impl.id): Promise<string> {
  const designText = `design ${Math.random()}`
  const created = shape.storage.designReviewRuns.create({
    taskId: shape.taskId,
    taskTitle: 'VPS docs',
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [DOC],
    repairSourceJobId,
  })
  const claimed = shape.storage.designReviewRuns.claim(created.id, 3)
  if (kind === 'NO_RESULT') {
    shape.storage.designReviewRuns.complete(created.id, claimed.claimToken!, 'failed', undefined, 'runner crashed')
  } else {
    const raw = kind === 'REVIEW_UNAVAILABLE'
      ? { reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [], finalDecision: 'REVIEW_UNAVAILABLE', unavailableReason: 'ENOENT' }
      : {
          reviewLoad: 'low',
          selectedFocuses: [],
          focusedReviewResults: [],
          integrationReviewResult: { decision: kind, summary: kind, findings: [] },
          finalDecision: kind,
        }
    shape.storage.designReviewRuns.complete(created.id, claimed.claimToken!, 'succeeded', JSON.stringify(raw))
  }
  await tick()
  return created.id
}

/** review の resume（`resume:<source>:1`）。actor を記録してから verdict を保存する。 */
async function resumedReview(shape: Shape, actor: 'human' | 'pl', source: Job = shape.r0): Promise<Job> {
  const r1 = job(shape.storage, shape, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `resume:${source.id}:1` }, { status: 'failed', exitCode: 0 })
  if (actor === 'human') {
    // R-4: Human Resume は作成時点で Task を止めていた run を記録する（route と同じ関数）。
    const answeredRunId = designReviewRunAnsweredByHumanResume(shape.storage, shape.taskId)
    recordResumeActor(shape.storage, {
      jobId: r1.id, taskId: shape.taskId, actorClass: 'human', evidence: 'admin_credential',
      ...(answeredRunId !== undefined ? { answeredRunId } : {}),
    })
  } else {
    recordResumeActor(shape.storage, { jobId: r1.id, taskId: shape.taskId, actorClass: 'pl', evidence: 'in_process_pl', technicalResume: true })
  }
  verdict(shape.storage, shape.taskId, r1.id)
  await tick()
  return r1
}

const recover = (shape: Shape) =>
  repairFromStoredReview(shape.storage, { taskId: shape.taskId, reviewJobId: shape.r0.id }, { kick: () => {} })

describe('Stored Review Recovery: 最新の初回 implement は consume 済み承認で認める', () => {
  it.each(['REVIEW_UNAVAILABLE', 'NO_RESULT'] as const)(
    'repair run が %s なら承認待ちになり、承認 → consume で新しい repair run を queue する',
    async (kind) => {
      const shape = await b8d0fc5dShape()
      await terminalRun(shape, kind)

      const first = recover(shape)
      expect(first).toMatchObject({ status: 'awaiting_approval', requestedAction: repairRecoveryActionFor(shape.r0.id) })
      if (first.status !== 'awaiting_approval') return
      // 承認が無い間は何も queue しない。
      expect(shape.storage.designReviewRuns.findQueued()).toHaveLength(0)

      recordApprovalActor(shape.storage, first.approvalRequestId, 'admin')
      shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')
      const second = recover(shape)

      expect(second).toMatchObject({ status: 'queued', stepKey: `repair:${shape.impl.id}:1` })
      const approval = shape.storage.approvalRequests.findById(first.approvalRequestId)
      expect(approval?.status).toBe('CONSUMED')
      const queued = shape.storage.designReviewRuns.findQueued()
      expect(queued).toHaveLength(1)
      expect(queued[0]!.repairSourceJobId).toBe(shape.impl.id)
    },
  )

  it('consume 済み承認の generation は human_recovery の参照を持ち、予算を reset する', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    recordApprovalActor(shape.storage, first.approvalRequestId, 'admin')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')
    expect(shape.storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: shape.taskId,
      approvalRequestId: first.approvalRequestId,
      expectedAction: repairRecoveryActionFor(shape.r0.id),
    }).ok).toBe(true)

    const preparation = prepareRepairFlow(shape.storage, { failedJob: shape.impl })

    expect(preparation).toMatchObject({
      action: 'queue',
      generation: {
        rootJobId: shape.impl.id,
        rootKind: 'human_recovery',
        budgetReset: true,
        authority: { kind: 'human_recovery', approvalRequestId: first.approvalRequestId, reviewJobId: shape.r0.id },
      },
    })
  })

  it('handoff を断られた consume 済み承認は使い切られ、次の Stored Review Recovery は新しい承認を求める（R-3）', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    recordApprovalActor(shape.storage, first.approvalRequestId, 'admin')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')
    const queued = recover(shape)
    if (queued.status !== 'queued') throw new Error('fixture expected queued')
    expect(shape.storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('CONSUMED')

    // Design Review は ALIGNED で終わったが、その間に Project が止まった → handoff は断られる。
    const run = shape.storage.designReviewRuns.findById(queued.runId)!
    const claimed = shape.storage.designReviewRuns.claim(run.id, 3)
    shape.storage.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED', summary: 'ALIGNED', findings: [] },
      finalDecision: 'ALIGNED',
    }))
    await tick()
    shape.storage.projects.update(shape.projectId, { status: 'paused' })
    const handoff = completeRepairHandoff(shape.storage, shape.storage.designReviewRuns.findById(run.id)!, queued.stepKey, shape.taskId, shape.impl)
    expect(handoff.status).toBe('skipped')

    const spent = shape.storage.auditLog.findByEntity('approval_request', first.approvalRequestId)
      .filter((entry) => entry.operation === 'stored_review_recovery_spent')
    expect(spent).toHaveLength(1)
    expect(humanRecoveryAuthorityByImplementation(shape.storage, shape.taskId).has(shape.impl.id)).toBe(false)

    // Project が再開しても、使い切られた承認は authority にならない。
    shape.storage.projects.update(shape.projectId, { status: 'running' })
    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl })).toMatchObject({
      action: 'skip',
      code: 'recovery_authority_required',
    })
    const again = recover(shape)
    expect(again).toMatchObject({ status: 'awaiting_approval', reused: false })
    if (again.status !== 'awaiting_approval') return
    expect(again.approvalRequestId).not.toBe(first.approvalRequestId)
  })

  it('使い切り marker が書けなければ refusal は確定せず、再試行で marker と一緒に断られる（R-3: 同じ transaction）', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    recordApprovalActor(shape.storage, first.approvalRequestId, 'admin')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')
    const queued = recover(shape)
    if (queued.status !== 'queued') throw new Error('fixture expected queued')
    const run = shape.storage.designReviewRuns.findById(queued.runId)!
    const claimed = shape.storage.designReviewRuns.claim(run.id, 3)
    shape.storage.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED', summary: 'ALIGNED', findings: [] },
      finalDecision: 'ALIGNED',
    }))
    await tick()
    shape.storage.projects.update(shape.projectId, { status: 'paused' })
    const auditBefore = shape.storage.auditLog.findByEntity('approval_request', first.approvalRequestId).length
    const jobsBefore = shape.storage.jobs.findByTaskId(shape.taskId).length

    // audit の書き込みだけを壊す。
    const originalRecord = shape.storage.auditLog.record.bind(shape.storage.auditLog)
    shape.storage.auditLog.record = (() => { throw new Error('audit disk full') }) as typeof shape.storage.auditLog.record
    try {
      expect(() => completeRepairHandoff(
        shape.storage, shape.storage.designReviewRuns.findById(run.id)!, queued.stepKey, shape.taskId, shape.impl,
      )).toThrow(/spent marker/)
    } finally {
      shape.storage.auditLog.record = originalRecord
    }
    // 何も確定していない: marker も repair Job も無く、Task も escalation されていない。
    expect(shape.storage.auditLog.findByEntity('approval_request', first.approvalRequestId)).toHaveLength(auditBefore)
    expect(shape.storage.jobs.findByTaskId(shape.taskId)).toHaveLength(jobsBefore)

    // 再試行: refusal と marker が一緒に確定し、承認は authority から外れる。
    const retried = completeRepairHandoff(
      shape.storage, shape.storage.designReviewRuns.findById(run.id)!, queued.stepKey, shape.taskId, shape.impl,
    )
    expect(retried.status).toBe('skipped')
    expect(shape.storage.auditLog.findByEntity('approval_request', first.approvalRequestId)
      .filter((entry) => entry.operation === 'stored_review_recovery_spent')).toHaveLength(1)
    expect(humanRecoveryAuthorityByImplementation(shape.storage, shape.taskId).has(shape.impl.id)).toBe(false)
  })

  it('park で断られた handoff も同じ transaction で承認を使い切る（R-3）', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    recordApprovalActor(shape.storage, first.approvalRequestId, 'admin')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')
    const queued = recover(shape)
    if (queued.status !== 'queued') throw new Error('fixture expected queued')
    const run = shape.storage.designReviewRuns.findById(queued.runId)!
    const claimed = shape.storage.designReviewRuns.claim(run.id, 3)
    shape.storage.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED', summary: 'ALIGNED', findings: [] },
      finalDecision: 'ALIGNED',
    }))
    await tick()
    shape.storage.auditLog.record({ actor: 'api', operation: 'task_aborted', entityType: 'task', entityId: shape.taskId, result: 'success' })
    expect(shape.storage.tasks.isParked(shape.taskId)).toBe(true)

    const handoff = completeRepairHandoff(shape.storage, shape.storage.designReviewRuns.findById(run.id)!, queued.stepKey, shape.taskId, shape.impl)
    expect(handoff.status).toBe('skipped')
    expect(humanRecoveryAuthorityByImplementation(shape.storage, shape.taskId).has(shape.impl.id)).toBe(false)
  })

  it('repair run が CONFLICT なら承認を作らずに skipped を返す', async () => {
    const shape = await b8d0fc5dShape()
    const runId = await terminalRun(shape, 'CONFLICT')

    const outcome = recover(shape)

    expect(outcome).toEqual({ status: 'skipped', reason: 'task is blocked (latest design review is CONFLICT)' })
    expect(shape.storage.approvalRequests.findByTaskId(shape.taskId)).toHaveLength(0)
    expect(shape.storage.designReviewRuns.findQueued()).toHaveLength(0)
    expect(runId).toBeDefined()
  })

  it('下見の skip は欠けているのが authority だけのときに限り recovery_authority_required を付ける', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl })).toMatchObject({
      action: 'skip',
      code: 'recovery_authority_required',
    })

    // live Job がある（step 8）なら code は付かない。
    job(shape.storage, shape, { aiCliMode: 'implement', workflowStepKey: 'manual' }, { status: 'running' })
    const blocked = prepareRepairFlow(shape.storage, { failedJob: shape.impl })
    expect(blocked).toMatchObject({ action: 'skip' })
    expect(blocked).not.toHaveProperty('code')
  })
})

describe('Human Resume: 引き金の review lineage 上の Human Resume を authority (b) にする', () => {
  it('CONFLICT run の後の Human Resume review が修正を要求したら admit し、generation は human_resume 参照を持つ', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'CONFLICT')
    const r1 = await resumedReview(shape, 'human')

    const preparation = prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })

    expect(preparation).toMatchObject({
      action: 'queue',
      stepKey: `repair:${shape.impl.id}:1`,
      generation: {
        rootJobId: shape.impl.id,
        rootKind: 'human_resume',
        depth: 0,
        budgetReset: true,
        resetReason: 'human_resume_started_new_generation',
        authority: { kind: 'human_resume', resumeJobId: r1.id, resumedReviewJobId: shape.r0.id },
      },
    })
  })

  it('作られた repair の generation audit が authority を載せ、その successor の修正要求も human generation として admit される', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'CONFLICT')
    const r1 = await resumedReview(shape, 'human')
    const preparation = prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })
    if (preparation.action !== 'queue') throw new Error('fixture expected a queue preparation')

    // Design Review が ALIGNED で終わった前提で handoff する（executeQueuedRepair の後半）。
    const run = shape.storage.designReviewRuns.create(preparation.run)
    const claimed = shape.storage.designReviewRuns.claim(run.id, 3)
    shape.storage.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED', summary: 'ALIGNED', findings: [] },
      finalDecision: 'ALIGNED',
    }))
    await tick()
    const handoff = completeRepairHandoff(shape.storage, shape.storage.designReviewRuns.findById(run.id)!, preparation.stepKey, shape.taskId, shape.impl)
    expect(handoff.status).toBe('repair_job_created')
    if (handoff.status !== 'repair_job_created') return

    const audit = shape.storage.auditLog.findByEntity('job', handoff.jobId)
      .filter((entry) => entry.operation === 'repair_generation')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.detail).toContain(`generation_root=${shape.impl.id}`)
    expect(audit[0]!.detail).toContain('budget_reset=yes')
    expect(audit[0]!.detail).toContain('authority_kind=human_resume')
    expect(audit[0]!.detail).toContain(`authority_resume_job_id=${r1.id}`)
    expect(audit[0]!.detail).toContain(`authority_resumed_review_job_id=${shape.r0.id}`)

    // successor（repair:<impl>:1）が成功し、その review が修正を要求する。
    const repair = shape.storage.jobs.update(handoff.jobId, { status: 'success', exitCode: 0, changedFiles: [DOC] } as never)!
    await tick()
    const rr = job(shape.storage, shape, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${repair.id}:review` }, { status: 'failed', exitCode: 0 })
    verdict(shape.storage, shape.taskId, rr.id)

    const next = prepareRepairFlow(shape.storage, { failedJob: repair, reviewJobId: rr.id })

    expect(next).toMatchObject({
      action: 'queue',
      stepKey: `repair:${repair.id}:1`,
      generation: { rootJobId: shape.impl.id, rootKind: 'human_resume', depth: 1 },
    })
  })

  it('Human Resume の review の verdict が changes_requested でなければ authority にならない（admit しない）', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const r1 = job(shape.storage, shape, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `resume:${shape.r0.id}:1` }, { status: 'success', exitCode: 0 })
    recordResumeActor(shape.storage, { jobId: r1.id, taskId: shape.taskId, actorClass: 'human', evidence: 'admin_credential' })
    shape.storage.reviewResults.create({
      taskId: shape.taskId, jobId: r1.id, reviewer: 'qa_ai', status: 'approved', summary: 'approved', findings: [],
    } as never)
    await tick()

    const result = prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })

    expect(result).toMatchObject({ action: 'skip' })
    expect(result).not.toMatchObject({ action: 'queue' })
  })

  it('PL Technical Resume の review は authority にならない（admit しない）', async () => {
    const shape = await b8d0fc5dShape()
    // 判定の無い run は根拠にならないので、step 4 の authority だけが効く形にする。
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const r1 = await resumedReview(shape, 'pl')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toMatchObject({
      action: 'skip',
      code: 'recovery_authority_required',
    })
  })

  it('PL Technical Resume は CONFLICT run にも答えない', async () => {
    const shape = await b8d0fc5dShape()
    const runId = await terminalRun(shape, 'CONFLICT')
    const r1 = await resumedReview(shape, 'pl')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toEqual({
      action: 'skip',
      reason: 'task is blocked (latest design review is CONFLICT)',
      runId,
    })
  })

  it('最新でない初回 implement は Human Resume があっても認めない', async () => {
    const shape = await b8d0fc5dShape()
    const r1 = await resumedReview(shape, 'human')
    // 初回 implement の後に別の implement Job がある（最新ではなくなる）。
    job(shape.storage, shape, { aiCliMode: 'implement', workflowStepKey: `resume:${shape.impl.id}:1` }, { status: 'failed', exitCode: 1 })

    const result = prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })

    expect(result).toMatchObject({ action: 'skip' })
    expect(result).not.toHaveProperty('code')
    if (result.action !== 'skip') return
    expect(result.reason).toContain('not a canonical resume or repair successor')
  })

  it('Human Resume の後に完了した CONFLICT run は根拠のまま残る', async () => {
    const shape = await b8d0fc5dShape()
    const r1 = await resumedReview(shape, 'human')
    const runId = await terminalRun(shape, 'CONFLICT')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toEqual({
      action: 'skip',
      reason: 'task is blocked (latest design review is CONFLICT)',
      runId,
    })
  })
})

describe('step 7: 判定を出さずに終わった run は根拠にしない（RC3）', () => {
  it('判定の無い run を外した後、その下の CONFLICT run に従う', async () => {
    const shape = await b8d0fc5dShape()
    const r1 = await resumedReview(shape, 'human')
    const conflict = await terminalRun(shape, 'CONFLICT')
    await terminalRun(shape, 'NO_RESULT')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toMatchObject({
      action: 'skip',
      runId: conflict,
    })
  })

  it('queued の run は従来どおり止める', async () => {
    const shape = await b8d0fc5dShape()
    const r1 = await resumedReview(shape, 'human')
    const designText = 'still queued'
    const active = shape.storage.designReviewRuns.create({
      taskId: shape.taskId,
      taskTitle: 'VPS docs',
      designText,
      designTextHash: computeDesignTextHash(designText),
      changedFiles: [DOC],
      repairSourceJobId: shape.impl.id,
    })

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toMatchObject({
      action: 'skip',
      runId: active.id,
    })
  })
})

/** recovery 承認を作り、決定と consume まで進める。actor は記録しないこともできる。 */
function consumedRecoveryApproval(shape: Shape, actor: 'admin' | 'worker' | 'legacy' | 'none'): string {
  const approval = shape.storage.approvalRequests.create({
    taskId: shape.taskId,
    targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
    riskLevel: 'HIGH',
    requestedAction: repairRecoveryActionFor(shape.r0.id),
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    invalidIf: [],
  } as never)
  if (actor !== 'none') recordApprovalActor(shape.storage, approval.id, actor)
  shape.storage.approvalRequests.recordDecision(approval.id, 'APPROVED')
  expect(shape.storage.approvalRequests.verifyAndConsumeForTaskAction({
    taskId: shape.taskId,
    approvalRequestId: approval.id,
    expectedAction: repairRecoveryActionFor(shape.r0.id),
  }).ok).toBe(true)
  return approval.id
}

describe('consume 済み承認は、人が決めた記録があるときだけ authority になる（Codex review）', () => {
  // stack 暫定: actor 要求は書き手（承認 PATCH の recordApprovalActor）と同じ stack-06 で戻す
  // （APPROVAL_ACTOR_REQUIRED）。拒否側の 2 件は re-enabled with the writer in stack-06。
  it.skip.each([
    ['記録なし', 'none'],
    ['WORKER credential（ai）', 'worker'],
    ['legacy 単一 token（unknown）', 'legacy'],
  ] as const)('%s の承認は authority にならない（recovery_authority_required、budget reset なし）', async (_label, actor) => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    consumedRecoveryApproval(shape, actor)

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl })).toMatchObject({
      action: 'skip',
      code: 'recovery_authority_required',
    })
  })

  it('ADMIN credential で決めた承認は authority になる', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const approvalId = consumedRecoveryApproval(shape, 'admin')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl })).toMatchObject({
      action: 'queue',
      generation: { rootKind: 'human_recovery', budgetReset: true, authority: { approvalRequestId: approvalId } },
    })
  })

  // stack 暫定の liveness 確認（stack-06 で actor 要求と一緒に外す）: 書き手の無い層では、
  // 承認 PATCH が approval_actor を書かなくても正当な承認は master と同じく通る。
  it('stack 暫定: approval_actor の記録が無い承認でも承認 → consume で repair run を queue する', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')

    expect(recover(shape)).toMatchObject({ status: 'queued', stepKey: `repair:${shape.impl.id}:1` })
    expect(shape.storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('CONSUMED')
    expect(shape.storage.designReviewRuns.findQueued()).toHaveLength(1)
  })

  // re-enabled with the writer in stack-06（APPROVAL_ACTOR_REQUIRED）。
  it.skip('人が決めた記録の無い APPROVED は consume せずに rejected を返す（承認を焼かない）', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    recordApprovalActor(shape.storage, first.approvalRequestId, 'legacy')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')

    expect(recover(shape)).toMatchObject({ status: 'rejected', code: 'APPROVAL_ACTOR_NOT_HUMAN' })
    expect(shape.storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('APPROVED')
    expect(shape.storage.designReviewRuns.findQueued()).toHaveLength(0)
  })
})

describe('step 7: 適用される run をすべて見る（新しい ALIGNED が古い CONFLICT を隠さない）', () => {
  async function taskDesignRun(shape: Shape, kind: 'ALIGNED' | 'CONFLICT'): Promise<string> {
    const designText = `task design ${Math.random()}`
    const created = shape.storage.designReviewRuns.create({
      taskId: shape.taskId, taskTitle: 'VPS docs', designText,
      designTextHash: computeDesignTextHash(designText), changedFiles: [DOC],
    })
    const claimed = shape.storage.designReviewRuns.claim(created.id, 3)
    shape.storage.designReviewRuns.complete(created.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      integrationReviewResult: { decision: kind, summary: kind, findings: [] },
      finalDecision: kind,
    }))
    await tick()
    return created.id
  }

  it('この実装の未回答の repair CONFLICT は、より新しい無関係な ALIGNED があっても止める', async () => {
    const shape = await b8d0fc5dShape()
    const conflict = await terminalRun(shape, 'CONFLICT')
    await taskDesignRun(shape, 'ALIGNED')
    const r1 = await resumedReview(shape, 'pl')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toEqual({
      action: 'skip',
      reason: 'task is blocked (latest design review is CONFLICT)',
      runId: conflict,
    })
  })

  it('同じ対象（repairSourceJobId）のより新しい ALIGNED があれば、古い CONFLICT は解消済み', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'CONFLICT')
    await terminalRun(shape, 'ALIGNED')
    const r1 = await resumedReview(shape, 'human')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id }).action).toBe('queue')
  })

  it('Task 設計の CONFLICT は、より新しい Task 設計の ALIGNED（別の design text）で解消済み', async () => {
    const shape = await b8d0fc5dShape()
    await taskDesignRun(shape, 'CONFLICT')
    await taskDesignRun(shape, 'ALIGNED')
    const r1 = await resumedReview(shape, 'human')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id }).action).toBe('queue')
  })

  it('Task 設計の CONFLICT は、より新しい repair の ALIGNED では解消されない', async () => {
    const shape = await b8d0fc5dShape()
    const conflict = await taskDesignRun(shape, 'CONFLICT')
    await terminalRun(shape, 'ALIGNED')
    const r1 = await resumedReview(shape, 'human')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id })).toMatchObject({
      action: 'skip',
      runId: conflict,
    })
  })

  it('この実装の lineage に無い repair 対象の CONFLICT は適用しない', async () => {
    const shape = await b8d0fc5dShape()
    const unrelated = job(shape.storage, shape, { aiCliMode: 'review', workflowStepKey: 'manual-review' }, { status: 'failed' })
    await terminalRun(shape, 'CONFLICT', unrelated.id)
    const r1 = await resumedReview(shape, 'human')

    expect(prepareRepairFlow(shape.storage, { failedJob: shape.impl, reviewJobId: r1.id }).action).toBe('queue')
  })
})

describe('Stored Review Recovery の skip も repair_admission_skipped を残す', () => {
  const skips = (shape: Shape) => shape.storage.auditLog.findByEntity('task', shape.taskId)
    .filter((entry) => entry.operation === 'repair_admission_skipped')

  it('下見の skip（CONFLICT run）', async () => {
    const shape = await b8d0fc5dShape()
    const runId = await terminalRun(shape, 'CONFLICT')

    expect(recover(shape).status).toBe('skipped')

    const rows = skips(shape)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toContain(`review_job_id=${shape.r0.id}`)
    expect(rows[0]!.detail).toContain(`implementation_job_id=${shape.impl.id}`)
    expect(rows[0]!.detail).toContain(`design_review_run_id=${runId}`)
  })

  it('consume 後の評価の skip', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'REVIEW_UNAVAILABLE')
    const first = recover(shape)
    if (first.status !== 'awaiting_approval') throw new Error('fixture expected awaiting_approval')
    recordApprovalActor(shape.storage, first.approvalRequestId, 'admin')
    shape.storage.approvalRequests.recordDecision(first.approvalRequestId, 'APPROVED')
    // 承認と consume の間に live Job が現れる（step 8 で skip になる）。
    job(shape.storage, shape, { aiCliMode: 'implement', workflowStepKey: 'manual' }, { status: 'running' })

    expect(recover(shape).status).toBe('skipped')

    const rows = skips(shape)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toContain('reason_code=not_admitted')
    expect(rows[0]!.detail).toContain(`implementation_job_id=${shape.impl.id}`)
  })
})

describe('step 7: 実装 lineage 上の Human Resume も run への回答になる', () => {
  async function resumedImplementation(shape: Shape, actor: 'human' | 'ai'): Promise<{ i1: Job; review: Job }> {
    const answeredRunId = designReviewRunAnsweredByHumanResume(shape.storage, shape.taskId)
    const i1 = job(shape.storage, shape, { aiCliMode: 'implement', workflowStepKey: `resume:${shape.impl.id}:1` }, { status: 'success', exitCode: 0, changedFiles: [DOC] })
    recordResumeActor(shape.storage, {
      jobId: i1.id,
      taskId: shape.taskId,
      actorClass: actor,
      evidence: actor === 'human' ? 'admin_credential' : 'worker_credential',
      ...(actor === 'human' && answeredRunId !== undefined ? { answeredRunId } : {}),
    })
    await tick()
    const review = job(shape.storage, shape, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${i1.id}:review` }, { status: 'failed', exitCode: 0 })
    verdict(shape.storage, shape.taskId, review.id)
    await tick()
    return { i1, review }
  }

  it('repair CONFLICT の後に人がその実装を Human Resume したなら、その run は答えられている', async () => {
    const shape = await b8d0fc5dShape()
    await terminalRun(shape, 'CONFLICT')
    const { i1, review } = await resumedImplementation(shape, 'human')

    expect(prepareRepairFlow(shape.storage, { failedJob: i1, reviewJobId: review.id }).action).toBe('queue')
  })

  it('R-4: answered_run を記録していない（legacy）実装の Human Resume は答えにならない', async () => {
    const shape = await b8d0fc5dShape()
    const conflict = await terminalRun(shape, 'CONFLICT')
    const i1 = job(shape.storage, shape, { aiCliMode: 'implement', workflowStepKey: `resume:${shape.impl.id}:1` }, { status: 'success', exitCode: 0, changedFiles: [DOC] })
    recordResumeActor(shape.storage, { jobId: i1.id, taskId: shape.taskId, actorClass: 'human', evidence: 'admin_credential' })
    await tick()
    const review = job(shape.storage, shape, { agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${i1.id}:review` }, { status: 'failed', exitCode: 0 })
    verdict(shape.storage, shape.taskId, review.id)
    await tick()

    expect(prepareRepairFlow(shape.storage, { failedJob: i1, reviewJobId: review.id })).toMatchObject({
      action: 'skip',
      runId: conflict,
    })
  })

  it('AI の resume は答えにならない', async () => {
    const shape = await b8d0fc5dShape()
    const conflict = await terminalRun(shape, 'CONFLICT')
    const { i1, review } = await resumedImplementation(shape, 'ai')

    expect(prepareRepairFlow(shape.storage, { failedJob: i1, reviewJobId: review.id })).toMatchObject({
      action: 'skip',
      runId: conflict,
    })
  })
})
