/**
 * Lifecycle E2E — Repair paths（R1 / R2 / R3）。
 *
 * review の changes_requested から Stage 2（repair Design Review → repair Job → 再 review）を
 * 本物の route / storage / repair flow で通し、Design Review runner の不調（requeue / failed）と
 * Human Resume（ADMIN）からの復帰までを確かめる。
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

import {
  APPROVED_REVIEW,
  buildLedger,
  changesRequested,
  createRunningProject,
  git,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
  type ReviewOutcome,
} from './harness'
import { designReviewCalls, resetDesignReviewStub, scriptDesignReview } from './runnerStub'
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

/** review の結果を順番に返す（尽きたら approved）。 */
function reviewSequence(...outcomes: ReviewOutcome[]): () => ReviewOutcome {
  return () => outcomes.shift() ?? APPROVED_REVIEW
}

const REKICK = async () => JSON.stringify({ actionKind: 'rekick_design_review', rationale: 'queued repair review is idle', riskLevel: 'LOW' })

async function adoptedTask(id: string, allowedPath: string) {
  env = await startLifecycle({ ledger: buildLedger([{ id, title: `Repair scenario ${id}` }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [allowedPath]
  const task = await env.adoptNext(project.id, id)
  return { project, task }
}

function stepKeysOf(taskId: string): string[] {
  return env.jobsOf(taskId).slice().reverse().map((job) => (job.workflowStepKey ?? '-').replace(/[0-9a-f-]{36}/g, '<id>'))
}

describe('R1: review changes_requested → repair Design Review ALIGNED → repair → re-review approved → commit', () => {
  it.each([
    { label: 'one finding, one file', id: 'r1-a', path: 'docs/r1a', finding: 'wording is unclear', repairFile: 'docs/r1a/fix.md' },
    { label: 'second finding, extra file', id: 'r1-b', path: 'docs/r1b', finding: 'missing example', repairFile: 'docs/r1b/example.md' },
  ])('$label', async ({ id, path, finding, repairFile }) => {
    const repairFiles: Record<string, string> = { [repairFile]: 'repaired\n' }
    // Start: adopted Task with a queued initial-implement Job.
    const { task } = await adoptedTask(id, path)
    let implementCalls = 0
    env.worker.behaviors.implement = () => {
      implementCalls += 1
      return implementCalls === 1
        ? { kind: 'change', files: { [`${path}/first.md`]: 'first\n' } }
        : { kind: 'change', files: repairFiles }
    }
    env.worker.behaviors.review = reviewSequence(changesRequested(finding))

    // Operation: Worker drains everything (repair DR is kicked by the review PATCH).
    const steps = await env.worker.runUntilIdle()

    // Expected transition: implement → review(changes_requested → failed) → [repair DR ALIGNED] →
    // repair implement → review(approved) → git_commit → done.
    expect(steps.map((step) => [step.kind, step.reported])).toEqual([
      ['implement', 'success'],
      ['review', 'failed'],
      ['implement', 'success'],
      ['review', 'success'],
      ['git_commit', 'success'],
    ])
    expect(stepKeysOf(task.id)).toEqual([
      'task:<id>:initial-implement',
      'implement:<id>:review',
      'repair:<id>:1',
      'implement:<id>:review',
      'review:<id>:git-commit',
    ])
    expect(env.task(task.id).status).toBe('done')
    // The repair prompt carried the review finding through the Design Review that admitted it.
    const repairJob = env.jobsOf(task.id).find((job) => job.workflowStepKey?.startsWith('repair:'))!
    expect(repairJob.aiCliPrompt).toContain(finding)
    const repairRuns = env.storage.designReviewRuns.findByTaskId(task.id).filter((run) => run.repairSourceJobId !== undefined)
    expect(repairRuns.map((run) => run.status)).toEqual(['succeeded'])
    expect(designReviewCalls().map((call) => call.verdict)).toEqual(['ALIGNED', 'ALIGNED'])
    // Commit passed Safety Evidence through the repair lineage (no human approval needed for LOW).
    const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
    expect(env.storage.auditLog.findByEntity('job', commitJob.id)
      .find((entry) => entry.operation === 'git_commit_safety_evidence')?.result).toBe('verified')
    expect(git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').sort())
      .toEqual([`${path}/first.md`, ...Object.keys(repairFiles)].sort())
    expect(env.storage.approvalRequests.findByTaskId(task.id)).toEqual([])
    expect((await env.systemState()).attention).toEqual([])
    expect(env.escalations).toEqual([])
  })
})

describe('R2: repair Design Review runner unavailable → requeued (not escalated) → PL rekick → ALIGNED', () => {
  it.each([
    { label: 'runner process failure', verdict: 'RUNNER_UNAVAILABLE' as const, id: 'r2-a' },
    { label: 'runner reports REVIEW_UNAVAILABLE', verdict: 'REVIEW_UNAVAILABLE' as const, id: 'r2-b' },
  ])('$label', async ({ verdict, id }) => {
    // Start: adopted Task (initial Design Review already ALIGNED by the stub).
    const { task } = await adoptedTask(id, `docs/${id}`)
    env.worker.behaviors.review = reviewSequence(changesRequested('please restructure'))
    // The next Design Review (the repair one) is unavailable once.
    scriptDesignReview(verdict)

    // Operation 1: Worker runs implement + review(changes_requested).
    const first = await env.worker.runUntilIdle()
    expect(first.map((step) => [step.kind, step.reported])).toEqual([['implement', 'success'], ['review', 'failed']])

    // Expected: repair run requeued (attempt 1), no repair Job yet, Task NOT blocked, no escalation.
    const [repairRun] = env.storage.designReviewRuns.findByTaskId(task.id).filter((run) => run.repairSourceJobId !== undefined)
    expect(repairRun).toMatchObject({ status: 'queued', attemptCount: 1 })
    expect(env.jobsOf(task.id).some((job) => job.workflowStepKey?.startsWith('repair:'))).toBe(false)
    expect(env.task(task.id).status).not.toBe('blocked')
    expect(env.storage.auditLog.findAll().filter((entry) => entry.operation === 'task_escalated_to_human')).toEqual([])
    // While the retry cooldown (retryCooldown.ts) runs, the run is not idle (no rekick target) and the
    // project summary says when it may retry.
    const cooling = await env.systemState()
    expect(cooling.attention.map((item) => item.kind)).not.toContain('design_review_idle')
    expect(cooling.projects.find((p) => p.designReview !== undefined)?.designReview)
      .toMatchObject({ status: 'queued', attemptCount: 1, idle: false, retryNotBefore: expect.any(String) })
    // PL ticks during the cooldown spend no provider diagnosis on this Task (its job_failed waits too).
    let coolingDiagnoses = 0
    for (let i = 0; i < 3; i += 1) {
      const tick = await env.plTick({ diagnose: async () => { coolingDiagnoses += 1; return REKICK() } })
      expect(tick.status).toBe('idle')
    }
    expect(coolingDiagnoses).toBe(0)
    expect(env.storage.designReviewRuns.findById(repairRun!.id)).toMatchObject({ status: 'queued', attemptCount: 1 })
    // Advance the clock past the cooldown: the run is idle again and PL rekicks it.
    passDesignReviewRetryCooldown()
    const attention = (await env.systemState()).attention
    // The repair run is idle, and the review Job (failed by changes_requested) is reported as job_failed.
    // PL handles design_review_idle first (ATTENTION_PRIORITY), so the rekick below is what runs.
    expect(attention.map((item) => item.kind).sort()).toEqual(['design_review_idle', 'job_failed'])
    const reviewJob = env.jobsOf(task.id).find((job) => job.aiCliMode === 'review')!
    expect(attention.find((item) => item.kind === 'job_failed')?.jobId).toBe(reviewJob.id)

    // Operation 2: PL tick with a rekick diagnosis.
    // Expected: the repair run is executed by the repair executor → ALIGNED → repair Job queued.
    const tick = await env.plTick({ diagnose: REKICK })
    expect(tick).toMatchObject({ status: 'acted', proposedKind: 'rekick_design_review' })
    expect(env.storage.designReviewRuns.findById(repairRun!.id)).toMatchObject({ status: 'succeeded', attemptCount: 2 })
    const repairJob = env.jobsOf(task.id).find((job) => job.workflowStepKey?.startsWith('repair:'))
    expect(repairJob?.status).toBe('queued')

    // Operation 3: Worker continues. Expected: repair → review approved → commit → done.
    const rest = await env.worker.runUntilIdle()
    expect(rest.map((step) => [step.kind, step.reported])).toEqual([
      ['implement', 'success'], ['review', 'success'], ['git_commit', 'success'],
    ])
    expect(env.task(task.id).status).toBe('done')
    expect(designReviewCalls().map((call) => call.verdict)).toEqual(['ALIGNED', verdict, 'ALIGNED'])
    expect(env.escalations).toEqual([])
  })
})

describe('R3: repair Design Review unavailable 3 times → failed → escalation → Human Resume (ADMIN) → continues', () => {
  it.each([
    { label: 'runner process failures', verdict: 'RUNNER_UNAVAILABLE' as const, id: 'r3-a' },
    { label: 'REVIEW_UNAVAILABLE results', verdict: 'REVIEW_UNAVAILABLE' as const, id: 'r3-b' },
  ])('$label', async ({ verdict, id }) => {
    // Start: adopted Task.
    const { task } = await adoptedTask(id, `docs/${id}`)
    env.worker.behaviors.review = reviewSequence(changesRequested('needs a different approach'))
    scriptDesignReview(verdict, verdict, verdict)

    // Operation 1: Worker runs implement + review(changes_requested) → repair DR attempt 1 (requeued).
    await env.worker.runUntilIdle()
    const [repairRun] = env.storage.designReviewRuns.findByTaskId(task.id).filter((run) => run.repairSourceJobId !== undefined)
    expect(repairRun).toMatchObject({ status: 'queued', attemptCount: 1 })

    // Operation 2: two PL rekicks (attempt 2 requeued, attempt 3 → failed → escalation to human).
    // Each rekick happens after the retry cooldown (retryCooldown.ts); advance the clock past it.
    passDesignReviewRetryCooldown()
    await env.plTick({ diagnose: REKICK })
    expect(env.storage.designReviewRuns.findById(repairRun!.id)).toMatchObject({ status: 'queued', attemptCount: 2 })
    passDesignReviewRetryCooldown()
    await env.plTick({ diagnose: REKICK })

    // Expected: run failed, Task blocked, escalation audited, the stop is visible as attention.
    expect(env.storage.designReviewRuns.findById(repairRun!.id)).toMatchObject({ status: 'failed', attemptCount: 3 })
    expect(env.task(task.id).status).toBe('blocked')
    expect(env.storage.auditLog.findByEntity('task', task.id)
      .filter((entry) => entry.operation === 'task_escalated_to_human').map((entry) => entry.result)).toContain('blocked')
    const attentionKinds = (await env.systemState()).attention.map((item) => item.kind)
    expect(attentionKinds.length).toBeGreaterThan(0)
    expect(env.jobsOf(task.id).some((job) => job.workflowStepKey?.startsWith('repair:'))).toBe(false)
    // Mobile shows Resume for exactly this shape.
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })

    // Operation 3: CEO (ADMIN) Human Resume.
    // Expected: 201, a resume Job is created and the actor is recorded as human.
    const resume = await env.ceo.resume(task.id, 'Use a simpler structure.')
    expect(resume.statusCode, JSON.stringify(resume.body)).toBe(201)
    const resumeJob = resume.body
    expect(resumeJob.workflowStepKey).toMatch(/^resume:/)
    expect(env.storage.auditLog.findByEntity('job', resumeJob.id)
      .filter((entry) => entry.operation === 'resume_actor').map((entry) => entry.result)).toEqual(['human'])

    // Operation 4: Worker continues. Expected: the resumed review (resume:<review>:1) re-runs and approves;
    // git_commit Safety Evidence refuses a resumed review (review_resumed) → Job-linked human approval.
    const rest = await env.worker.runUntilIdle()
    expect(rest.map((step) => [step.kind, step.reported])).toEqual([['review', 'success'], ['git_commit', 'blocked']])
    const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
    expect(env.storage.auditLog.findByEntity('job', commitJob.id)
      .find((entry) => entry.operation === 'git_commit_safety_evidence')?.detail).toContain('review_resumed')
    const [approval] = env.storage.approvalRequests.findByTaskId(task.id)
    expect(approval).toMatchObject({ requestedAction: 'git_commit', status: 'WAITING_FOR_USER' })

    // Operation 5: ADMIN approves; Worker re-runs git_commit. Expected: consume → commit → done.
    expect((await env.ceo.approve(approval!.id)).statusCode).toBe(200)
    const final = await env.worker.runUntilIdle()
    expect(final.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expect(env.task(task.id).status).toBe('done')
    expect(env.jobsOf(task.id).some((job) => job.status === 'queued' || job.status === 'running')).toBe(false)
  })
})
