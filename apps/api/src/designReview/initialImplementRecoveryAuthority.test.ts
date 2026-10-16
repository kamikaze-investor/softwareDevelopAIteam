import { describe, expect, it } from 'vitest'
import type { Job } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { completeRepairHandoff, prepareRepairFlow } from './repairFlow'
import { repairFromStoredReview } from './repairFromStoredReview'
import { repairRecoveryActionFor } from './repairRecoveryEpoch'
import { recordResumeActor } from './resumeActor'

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
    recordResumeActor(shape.storage, { jobId: r1.id, taskId: shape.taskId, actorClass: 'human', evidence: 'admin_credential' })
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
