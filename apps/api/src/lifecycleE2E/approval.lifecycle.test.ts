/**
 * Lifecycle E2E — Approval paths（A1 REJECT / A2 expiry / A3 HIGH safe-work）。
 *
 * git_commit を人間承認へ送るために、LOW の docs 変更でも review に high finding を付ける
 * （Safety Evidence の `review_has_high_or_critical_finding`）。HIGH diff を使わないのは、
 * 承認後の commit が DEFECT D2 で止まるためで、ここでは承認の意味論そのものを見る。
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
  createRunningProject,
  git,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
  type ReviewOutcome,
} from './harness'
import { resetDesignReviewStub } from './runnerStub'

vi.setConfig({ testTimeout: 240_000 })

let env: LifecycleEnv

beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  vi.useRealTimers()
  await env?.close()
})
afterAll(() => {
  removeTargetRepo()
})

const HIGH_FINDING: ReviewOutcome = {
  kind: 'verdict',
  result: { status: 'approved', summary: 'approved with a caveat', findings: [{ severity: 'high', message: 'double-check the claim' }] },
}

function reviewSequence(...outcomes: ReviewOutcome[]): () => ReviewOutcome {
  return () => outcomes.shift() ?? APPROVED_REVIEW
}

/** LOW docs Task を採用し、git_commit が Job-linked 承認待ちで blocked になるところまで進める。 */
async function blockedOnHumanGate(id: string, path: string, reviews: ReviewOutcome[]) {
  env = await startLifecycle({ ledger: buildLedger([{ id, title: `Approval scenario ${id}` }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [path]
  env.worker.behaviors.review = reviewSequence(...reviews)
  const task = await env.adoptNext(project.id, id)
  const steps = await env.worker.runUntilIdle()
  expect(steps.map((step) => [step.kind, step.reported])).toEqual([
    ['implement', 'success'], ['review', 'success'], ['git_commit', 'blocked'],
  ])
  const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
  const [approval] = env.storage.approvalRequests.findByTaskId(task.id)
  expect(approval).toMatchObject({ requestedAction: 'git_commit', status: 'WAITING_FOR_USER', riskLevel: 'LOW' })
  expect(commitJob.approvalId).toBe(approval!.id)
  return { project, task, commitJob, approval: approval! }
}

function waitingRows(taskId: string) {
  return env.storage.approvalRequests.findByTaskId(taskId).filter((a) => a.status === 'WAITING_FOR_USER')
}

describe('A1: CEO REJECTs the git_commit → Human Resume returns to the source implement with the fix instruction', () => {
  it.each([
    { id: 'a1-a', path: 'docs/a1a', instruction: 'Remove the unverified claim.' },
    { id: 'a1-b', path: 'docs/a1b', instruction: 'Cite the source for the number.' },
  ])('$id', async ({ id, path, instruction }) => {
    // Start: git_commit blocked on a WAITING Job-linked approval.
    const { task, commitJob, approval } = await blockedOnHumanGate(id, path, [HIGH_FINDING])
    const sourceImplement = env.jobsOf(task.id).find((job) => job.aiCliMode === 'implement')!

    // Operation 1: CEO rejects. Expected: REJECTED, the Job stays blocked (not requeued), and PL does not
    // auto-resume a CEO rejection (it escalates instead).
    expect((await env.ceo.reject(approval.id, 'the claim is unverified')).statusCode).toBe(200)
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('REJECTED')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    const tick = await env.plTick({
      diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: 'resume it', riskLevel: 'LOW' }),
    })
    expect(tick.status).not.toBe('acted')
    expect(env.jobsOf(task.id).filter((job) => job.workflowStepKey?.startsWith('resume:'))).toEqual([])
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })

    // Operation 2: Human Resume with a fix instruction (ADMIN).
    // Expected (#346): a new implement Job keyed resume:<git_commit>:1, same provider / command kind as the
    // source implement, carrying the instruction.
    const resume = await env.ceo.resume(task.id, instruction)
    expect(resume.statusCode, JSON.stringify(resume.body)).toBe(201)
    const resumed = resume.body as Job
    expect(resumed.workflowStepKey).toBe(`resume:${commitJob.id}:1`)
    expect(resumed.aiCliMode).toBe('implement')
    expect(resumed.aiCliProvider).toBe(sourceImplement.aiCliProvider)
    expect(resumed.safeCommand.kind).toBe(sourceImplement.safeCommand.kind)
    expect(resumed.aiCliPrompt).toContain(instruction)

    // Operation 3: Worker continues. Expected: resumed implement → review (approved, clean) → git_commit
    // passes Safety Evidence → done. The REJECTED row stays REJECTED; nothing is WAITING.
    env.worker.behaviors.implement = () => ({ kind: 'change', files: { [`${path}/fixed.md`]: `${instruction}\n` } })
    const rest = await env.worker.runUntilIdle()
    expect(rest.map((step) => [step.kind, step.reported])).toEqual([
      ['implement', 'success'], ['review', 'success'], ['git_commit', 'success'],
    ])
    expect(env.task(task.id).status).toBe('done')
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('REJECTED')
    expect(waitingRows(task.id)).toEqual([])
    expect(git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n')).toContain(`${path}/fixed.md`)
  })
})

describe('A2: approval expiry → PL auto resume → new approval → approve → completes', () => {
  it.each([
    { id: 'a2-a', path: 'docs/a2a', expiredBy: 24 * 60 + 1 },
    { id: 'a2-b', path: 'docs/a2b', expiredBy: 3 * 24 * 60 },
  ])('$id (expired by $expiredBy min)', async ({ id, path, expiredBy }) => {
    // Start: git_commit blocked on a WAITING approval; the second review of the resumed run will also carry
    // the high finding, so the new cycle again needs a human.
    const { task, commitJob, approval } = await blockedOnHumanGate(id, path, [HIGH_FINDING])

    // Operation 1: time passes beyond the approval TTL (APPROVAL_REQUEST_TTL_MINUTES = 24h; only Date is faked).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + expiredBy * 60 * 1000))
    let state = await env.systemState()
    expect(state.attention.map((item) => item.kind)).toEqual(['job_blocked'])
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })

    // Operation 2: PL tick with a resume diagnosis.
    // Expected: auto_recovery lane runs the existing resume → a NEW git_commit Job in the canonical
    // resume lineage; the expired request is not reused.
    const tick = await env.plTick({
      diagnose: async () => JSON.stringify({ actionKind: 'resume_task', rationale: 'approval expired', riskLevel: 'LOW' }),
    })
    expect(tick, JSON.stringify(tick)).toMatchObject({ status: 'acted', proposedKind: 'resume_task' })
    const resumed = env.jobsOf(task.id).find((job) => job.workflowStepKey?.startsWith(`resume:${commitJob.id}:`))!
    expect(resumed.safeCommand.kind).toBe('git_commit')
    expect(resumed.status).toBe('queued')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('failed')

    // Operation 3: Worker runs the resumed git_commit. Expected: Evidence still refuses (same review) →
    // a new Job-linked approval; the old expired request is no longer WAITING (no orphan WAITING rows).
    const blocked = await env.worker.runUntilIdle()
    expect(blocked.map((step) => [step.kind, step.reported])).toEqual([['git_commit', 'blocked']])
    const waiting = waitingRows(task.id)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.id).not.toBe(approval.id)
    expect(env.storage.jobs.findById(resumed.id)?.approvalId).toBe(waiting[0]!.id)

    // Operation 4: ADMIN approves; Worker commits. Expected: done; lineage depth 1; one CONSUMED approval.
    expect((await env.ceo.approve(waiting[0]!.id)).statusCode).toBe(200)
    const done = await env.worker.runUntilIdle()
    expect(done.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expect(env.task(task.id).status).toBe('done')
    const commitJobs = env.jobsOf(task.id).filter((job) => job.safeCommand.kind === 'git_commit')
    expect(commitJobs).toHaveLength(2)
    expect(env.storage.approvalRequests.findByTaskId(task.id).map((a) => a.status).sort())
      .toEqual(['CONSUMED', expect.not.stringMatching(/^WAITING_FOR_USER$/)].sort())
    expect(waitingRows(task.id)).toEqual([])
    state = await env.systemState()
    expect(state.attention).toEqual([])
  })
})

describe('A3: HIGH safe-work checks create no request and retire a legacy same-action HIGH WAITING row', () => {
  it.each([
    { label: 'goal.md', file: 'docs/project_memory/goal.md' },
    { label: 'design_philosophy.md', file: 'docs/project_memory/design_philosophy.md' },
  ])('$label', async ({ file }) => {
    // Start: Task adopted with a HIGH scope; implement has run and the review is queued.
    env = await startLifecycle({ ledger: buildLedger([{ id: 'a3', title: 'HIGH safe-work scenario' }]) })
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = [file]
    env.worker.behaviors.implement = () => ({ kind: 'change', files: { [file]: '# HIGH doc\n\nchanged\n' } })
    const task = await env.adoptNext(project.id, 'a3')
    const implement = await env.worker.pollOnce()
    expect(implement).toMatchObject({ kind: 'implement', reported: 'success' })
    // A legacy (pre-W3) WAITING row for the same safe-work action the review will check.
    const legacy = env.storage.approvalRequests.create({
      taskId: task.id, targetBranch: 'candidate/self-dev', targetCommit: 'legacy', targetDiffHash: 'legacy',
      riskLevel: 'HIGH', requestedAction: 'git_status', status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), invalidIf: [],
    } as never)

    // Operation: the Worker runs the review (HIGH safe-work gate check).
    const review = await env.worker.pollOnce()

    // Expected: safe-work continues, no new request is created, and the legacy row is retired.
    expect(review).toMatchObject({ kind: 'review', reported: 'success' })
    expect(review!.gate).toMatchObject({ policy: 'continue_safe_work_only' })
    expect(review!.gate?.requestId).toBeUndefined()
    const rows = env.storage.approvalRequests.findByTaskId(task.id)
    expect(rows.map((row) => row.id)).toEqual([legacy.id])
    expect(env.storage.approvalRequests.findById(legacy.id)?.status).not.toBe('WAITING_FOR_USER')
  })
})
