/**
 * Lifecycle E2E — R4: Task `b8d0fc5d` の形。
 *
 * initial-implement（goal.md = critical load）→ review changes_requested → repair Design Review が
 * 本物の CONFLICT（critical で必須の independent も欠落）→ Task blocked。
 * そこから Stored Review Recovery（承認前に拒否されること）、Human Resume（ADMIN）、
 * resumed review の changes_requested による Stage 2（authority = human_resume）までを
 * 本物の route / storage で通す。
 *
 * もう一つの形（保存済み repair run が REVIEW_UNAVAILABLE だけで終わった）では、
 * Stored Review Recovery → 承認待ち → ADMIN 承認（approval_actor human）→ consume → repair queued を通す。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/targetWorkingDir', async () => {
  const { LIFECYCLE_TARGET_DIR } = await import('./runnerStub.js')
  return { TARGET_WORKING_DIR: LIFECYCLE_TARGET_DIR }
})
vi.mock('../designReview/designReviewCoordinator', async (importOriginal) => {
  const { stubCoordinatorDeps } = await import('./runnerStub.js')
  return {
    ...(await importOriginal<typeof import('../designReview/designReviewCoordinator')>()),
    buildDefaultCoordinatorDeps: stubCoordinatorDeps,
  }
})

import type { Job } from '@ai-team/shared'
import {
  APPROVED_REVIEW,
  buildLedger,
  changesRequested,
  createRunningProject,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
  type ReviewOutcome,
} from './harness'
import { designReviewCalls, resetDesignReviewStub, scriptDesignReview, type StubVerdict } from './runnerStub'
import { passDesignReviewRetryCooldown } from '../designReview/retryCooldownTestClock'

vi.setConfig({ testTimeout: 240_000 })

let env: LifecycleEnv

beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  // retry cooldown を明けさせるために進めた壁時計を戻す（retryCooldownTestClock.ts）。
  vi.useRealTimers()
  await env?.close()
})
afterAll(() => {
  removeTargetRepo()
})

const GOAL = 'docs/project_memory/goal.md'
const REKICK = async () => JSON.stringify({ actionKind: 'rekick_design_review', rationale: 'queued repair review is idle', riskLevel: 'LOW' })

function reviewSequence(...outcomes: ReviewOutcome[]): () => ReviewOutcome {
  return () => outcomes.shift() ?? APPROVED_REVIEW
}

/**
 * initial-implement（goal.md）→ review changes_requested → repair Design Review を `repairVerdicts` で回し、
 * repair run が終端して Task が blocked になるところまで進める。
 */
async function b8d0fc5dShape(repairVerdicts: StubVerdict[], reviews: ReviewOutcome[]) {
  env = await startLifecycle({ ledger: buildLedger([{ id: 'goal-wording', title: 'Clarify the goal wording' }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [GOAL]
  let implementCalls = 0
  env.worker.behaviors.implement = () => ({ kind: 'change', files: { [GOAL]: `# Goal\n\nrevision ${++implementCalls}\n` } })
  env.worker.behaviors.review = reviewSequence(...reviews)
  const task = await env.adoptNext(project.id, 'goal-wording')
  scriptDesignReview(...repairVerdicts)

  // Worker: implement → review(changes_requested). The review PATCH kicks the repair Design Review.
  const steps = await env.worker.runUntilIdle()
  expect(steps.map((step) => [step.kind, step.reported])).toEqual([['implement', 'success'], ['review', 'failed']])
  // Remaining attempts of an unavailable repair review are driven by PL rekicks.
  // Each rekick happens after the retry cooldown (retryCooldown.ts); advance the clock past it.
  for (let i = 1; i < repairVerdicts.length; i += 1) {
    passDesignReviewRetryCooldown()
    await env.plTick({ diagnose: REKICK })
  }

  const implementJob = env.jobsOf(task.id).find((job) => job.workflowStepKey === `task:${task.id}:initial-implement`)!
  const reviewJob = env.jobsOf(task.id).find((job) => job.aiCliMode === 'review')!
  const repairRuns = env.storage.designReviewRuns.findByTaskId(task.id).filter((run) => run.repairSourceJobId !== undefined)
  return { project, task, implementJob, reviewJob, repairRuns }
}

function liveWaiting(taskId: string) {
  return env.storage.approvalRequests.findByTaskId(taskId).filter((a) => a.status === 'WAITING_FOR_USER')
}

describe('R4: b8d0fc5d — CONFLICT repair review, Stored Review Recovery refused, Human Resume, Stage 2 by human_resume', () => {
  it.each([
    { label: 'legacy WAITING row expires before the resume', legacyRow: true },
    { label: 'no legacy row', legacyRow: false },
  ])('$label', async ({ legacyRow }) => {
    // Start: b8d0fc5d shape — repair Design Review returned CONFLICT with the critical independent missing.
    const { task, implementJob, reviewJob, repairRuns } = await b8d0fc5dShape(
      ['CONFLICT_MISSING_INDEPENDENT'],
      [changesRequested('goal wording conflicts with the philosophy'), changesRequested('still unclear'), APPROVED_REVIEW],
    )
    expect(designReviewCalls().map((call) => call.verdict)).toEqual(['ALIGNED', 'CONFLICT_MISSING_INDEPENDENT'])
    expect(repairRuns.map((run) => run.status)).toEqual(['succeeded'])
    expect(env.task(task.id).status).toBe('blocked')
    expect(env.jobsOf(task.id).some((job) => job.workflowStepKey?.startsWith('repair:'))).toBe(false)

    // Operation 1: Stored Review Recovery on the stored review.
    // Expected: refused before any approval request exists (a real CONFLICT is not a recovery-authority problem).
    const stored = await env.ceo.repairFromStoredReview(task.id, reviewJob.id)
    expect(stored.statusCode, JSON.stringify(stored.body)).toBe(200)
    expect(stored.body).toMatchObject({ status: 'skipped', reason: expect.stringContaining('CONFLICT') })
    expect(stored.body.status).not.toBe('awaiting_approval')
    expect(stored.body.status).not.toBe('queued')
    expect(env.storage.approvalRequests.findByTaskId(task.id)).toEqual([])

    if (legacyRow) {
      // A legacy (pre-W3) same-action HIGH safe-work WAITING row: resume must refuse while it is live,
      // and Mobile must agree.
      const legacy = env.storage.approvalRequests.create({
        taskId: task.id, targetBranch: 'candidate/self-dev', targetCommit: 'legacy', targetDiffHash: 'legacy',
        riskLevel: 'HIGH', requestedAction: 'git_status', status: 'WAITING_FOR_USER',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), invalidIf: [],
      } as never)
      expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: false, code: 'APPROVAL_WAITING' })
      const refused = await env.ceo.resume(task.id, 'Rewrite the goal in one sentence.')
      expect(refused.statusCode).toBe(400)
      expect(refused.body.code).toBe('APPROVAL_WAITING')
      // The legacy row is no longer live (its expiry is applied).
      env.storage.approvalRequests.updateStatus(legacy.id, 'EXPIRED', undefined, true)
    }
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })

    // Operation 2: Human Resume (ADMIN). Expected: 201, resume:<review>:1 review Job, actor human.
    const resume = await env.ceo.resume(task.id, 'Rewrite the goal in one sentence.')
    expect(resume.statusCode, JSON.stringify(resume.body)).toBe(201)
    const resumedReview = resume.body as Job
    expect(resumedReview.workflowStepKey).toBe(`resume:${reviewJob.id}:1`)
    expect(resumedReview.aiCliMode).toBe('review')

    // Operation 3: Worker runs the resumed review → changes_requested.
    // Expected: Stage 2 admitted with authority = human_resume → fresh repair Design Review (ALIGNED)
    // → repair Job → review approved → git_commit (HIGH: goal.md) → Job-linked approval WAITING.
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported])).toEqual([
      ['review', 'failed'],
      ['implement', 'success'],
      ['review', 'success'],
      ['git_commit', 'blocked'],
    ])
    const generation = env.storage.auditLog.findAll().filter((entry) => entry.operation === 'repair_generation')
    expect(generation.some((entry) => (entry.detail ?? '').includes('authority_kind=human_resume')
      && (entry.detail ?? '').includes(`authority_resume_job_id=${resumedReview.id}`)
      && (entry.detail ?? '').includes(`authority_resumed_review_job_id=${reviewJob.id}`)
      && (entry.detail ?? '').includes('budget_reset=yes'))).toBe(true)
    const repairJob = env.jobsOf(task.id).find((job) => job.workflowStepKey?.startsWith('repair:'))!
    expect(repairJob.workflowStepKey).toMatch(new RegExp(`^repair:${implementJob.id}:\\d+$`))
    expect(designReviewCalls().map((call) => call.verdict)).toEqual(['ALIGNED', 'CONFLICT_MISSING_INDEPENDENT', 'ALIGNED'])
    const waiting = liveWaiting(task.id)
    expect(waiting.map((a) => [a.requestedAction, a.riskLevel])).toEqual([['git_commit', 'HIGH']])

    // Operation 4: ADMIN approves. Expected: approval_actor human, git_commit Job requeued.
    // (The commit itself then hits DEFECT D2 — see normal.lifecycle.test.ts.)
    expect((await env.ceo.approve(waiting[0]!.id)).statusCode).toBe(200)
    const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
    expect(commitJob.status).toBe('queued')
    expect(env.storage.auditLog.findByEntity('approval_request', waiting[0]!.id)
      .filter((entry) => entry.operation === 'approval_actor').map((entry) => entry.result)).toEqual(['human'])
  })
})

describe('R4 variant: stored repair run ended REVIEW_UNAVAILABLE only → Stored Review Recovery with human approval', () => {
  it.each([
    { label: 'runner reported REVIEW_UNAVAILABLE x3', verdict: 'REVIEW_UNAVAILABLE' as const },
    { label: 'runner process unavailable x3', verdict: 'RUNNER_UNAVAILABLE' as const },
  ])('$label', async ({ verdict }) => {
    // Start: repair Design Review unavailable on all 3 attempts → run failed → Task blocked.
    const { task, implementJob, reviewJob, repairRuns } = await b8d0fc5dShape(
      [verdict, verdict, verdict],
      [changesRequested('goal wording is ambiguous')],
    )
    expect(repairRuns.map((run) => [run.status, run.attemptCount])).toEqual([['failed', 3]])
    expect(env.task(task.id).status).toBe('blocked')

    // Operation 1: Stored Review Recovery. Expected: 202 awaiting_approval with a new WAITING request.
    const first = await env.ceo.repairFromStoredReview(task.id, reviewJob.id)
    expect(first.statusCode, JSON.stringify(first.body)).toBe(202)
    expect(first.body.status).toBe('awaiting_approval')
    const approvalId = first.body.approvalRequestId!
    expect(env.storage.approvalRequests.findById(approvalId)?.status).toBe('WAITING_FOR_USER')
    // Asking again reuses the same request (no duplicate rows).
    const again = await env.ceo.repairFromStoredReview(task.id, reviewJob.id)
    expect(again.body).toMatchObject({ status: 'awaiting_approval', approvalRequestId: approvalId })
    expect(liveWaiting(task.id)).toHaveLength(1)

    // Operation 2: ADMIN approves. Expected: APPROVED + approval_actor human (W3 wiring).
    expect((await env.ceo.approve(approvalId)).statusCode).toBe(200)
    expect(env.storage.auditLog.findByEntity('approval_request', approvalId)
      .filter((entry) => entry.operation === 'approval_actor').map((entry) => entry.result)).toEqual(['human'])

    // Operation 3: Stored Review Recovery again. Expected: approval consumed, repair run queued and
    // executed (ALIGNED) → repair Job queued for the original implementation.
    const third = await env.ceo.repairFromStoredReview(task.id, reviewJob.id)
    expect(third.statusCode, JSON.stringify(third.body)).toBe(200)
    expect(third.body.status).toBe('queued')
    await env.quiesce()
    expect(env.storage.approvalRequests.findById(approvalId)?.status).toBe('CONSUMED')
    const repairJob = env.jobsOf(task.id).find((job) => job.workflowStepKey?.startsWith('repair:'))
    expect(repairJob?.status).toBe('queued')
    expect(repairJob?.workflowStepKey).toMatch(new RegExp(`^repair:${implementJob.id}:\\d+$`))
    expect(liveWaiting(task.id)).toEqual([])
  })
})
