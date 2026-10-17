/**
 * Lifecycle E2E — accepted residuals re-evaluated with evidence (lifecycle repair residuals).
 *
 * R-FINAL-OPPATCH: an operator PATCH that moved a running implement Job to `success` without the Worker's
 * result fields used to win the race against the Worker's own Outbox delivery. The late delivery was then
 * acknowledged as non-applicable with nothing applied, so the post-implement review was never created.
 * Measured before the fix (same scenario as the first test below): the Task stayed `pending` (never
 * `in_progress`, so the stranded attention could not fire), the latest Job was `success`, the worktree was
 * dirty, `attention` was empty and every PL tick returned `idle: no attention items` — a silent stop with
 * no exit. A generic PATCH can no longer record `success`; only the Worker's Outbox delivery can.
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

import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalizeJobUpdate } from '@ai-team/shared'
import {
  buildLedger,
  createRunningProject,
  git,
  removeTargetRepo,
  startLifecycle,
  type Caller,
  type LifecycleEnv,
} from './harness'
import { LIFECYCLE_TARGET_DIR, resetDesignReviewStub } from './runnerStub'

vi.setConfig({ testTimeout: 180_000 })

let env: LifecycleEnv
beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  await env?.close()
})
afterAll(() => {
  removeTargetRepo()
})

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf-8').digest('hex')

/** `persistTerminalUpdate()` と同じ形の Outbox 配送。 */
function asOutboxDelivery(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, eventId: randomUUID(), payloadHash: sha256(canonicalizeJobUpdate(payload)) }
}

describe('R-FINAL-OPPATCH: a direct success write cannot pre-empt the Worker result', () => {
  it.each<Caller>(['admin', 'worker'])(
    'a %s PATCH running implement -> success without an Outbox event is refused; the Worker result then drives the Task to done',
    async (caller) => {
      env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
      const project = createRunningProject(env)
      const task = await env.adoptNext(project.id, 'docs-a')

      // The Worker claims and implements, but its terminal report is still in the local Outbox.
      let held: { jobId: string; payload: Record<string, unknown> } | undefined
      env.worker.crashBeforeNextReport = (jobId, payload) => {
        held = { jobId, payload }
      }
      await env.worker.pollOnce()
      expect(held?.payload.status).toBe('success')
      const implementJobId = held!.jobId
      expect(env.storage.jobs.findById(implementJobId)?.status).toBe('running')

      // Operator (or any credential) writes success directly: refused, nothing changes.
      const direct = await env.api<{ code?: string }>('PATCH', `/api/jobs/${implementJobId}`, { status: 'success' }, caller)
      expect(direct.statusCode).toBe(409)
      expect(direct.body.code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
      expect(env.storage.jobs.findById(implementJobId)?.status).toBe('running')

      // The Worker's own delivery applies normally and creates the post-implement review.
      const delivered = await env.api('PATCH', `/api/jobs/${implementJobId}`, asOutboxDelivery(held!.payload), 'worker')
      expect(delivered.statusCode).toBe(200)
      await env.quiesce()
      expect(env.storage.jobs.findById(implementJobId)?.status).toBe('success')
      expect(env.jobsOf(task.id).map((job) => [job.workflowStepKey, job.status])).toContainEqual(
        [`implement:${implementJobId}:review`, 'queued'],
      )

      // The rest of the lifecycle completes: review -> git_commit (Safety Evidence) -> done, clean worktree.
      const steps = await env.worker.runUntilIdle()
      expect(steps.map((step) => [step.kind, step.reported])).toEqual([
        ['review', 'success'],
        ['git_commit', 'success'],
      ])
      expect(env.task(task.id).status).toBe('done')
      expect(git(['status', '--porcelain']).trim()).toBe('')
      expect((await env.systemState()).attention).toEqual([])
    },
  )

  it('an ADMIN success carrying a caller-computed eventId + payloadHash is refused under split credentials', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
    const project = createRunningProject(env)
    const task = await env.adoptNext(project.id, 'docs-a')
    let held: { jobId: string; payload: Record<string, unknown> } | undefined
    env.worker.crashBeforeNextReport = (jobId, payload) => {
      held = { jobId, payload }
    }
    await env.worker.pollOnce()

    // Same body the Worker would send (valid hash), but from the ADMIN credential.
    const forged = await env.api<{ code?: string }>('PATCH', `/api/jobs/${held!.jobId}`, asOutboxDelivery(held!.payload), 'admin')
    expect(forged.statusCode).toBe(409)
    expect(forged.body.code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
    expect(env.storage.jobs.findById(held!.jobId)?.status).toBe('running')

    const delivered = await env.api('PATCH', `/api/jobs/${held!.jobId}`, asOutboxDelivery(held!.payload), 'worker')
    expect(delivered.statusCode).toBe(200)
    await env.quiesce()
    await env.worker.runUntilIdle()
    expect(env.task(task.id).status).toBe('done')
  })

  it('a direct success on a git_commit Job cannot mark the Task done without a commit', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
    const project = createRunningProject(env)
    const task = await env.adoptNext(project.id, 'docs-a')
    // implement + review run normally; stop before the git_commit is executed.
    await env.worker.pollOnce()
    await env.worker.pollOnce()
    const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')
    expect(commitJob?.status).toBe('queued')
    const headBefore = git(['rev-parse', 'HEAD']).trim()

    const direct = await env.api<{ code?: string }>('PATCH', `/api/jobs/${commitJob!.id}`, { status: 'success', exitCode: 0 }, 'admin')

    expect(direct.statusCode).toBe(409)
    expect(direct.body.code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
    expect(env.storage.jobs.findById(commitJob!.id)?.status).toBe('queued')
    expect(env.task(task.id).status).not.toBe('done')
    expect(env.storage.taskContinuations.findBySourceJobId(commitJob!.id)).toBeUndefined()
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore)

    // The real Worker run still completes it.
    await env.worker.runUntilIdle()
    expect(env.task(task.id).status).toBe('done')
  })

  it('the operator exit for a stuck running Job still works: a direct failed is applied', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
    const project = createRunningProject(env)
    const task = await env.adoptNext(project.id, 'docs-a')
    env.worker.crashBeforeNextReport = () => {}
    await env.worker.pollOnce()
    const running = env.jobsOf(task.id).find((job) => job.status === 'running')!

    const failed = await env.api('PATCH', `/api/jobs/${running.id}`, { status: 'failed', stderr: 'operator stopped it' }, 'admin')
    expect(failed.statusCode).toBe(200)
    expect(env.storage.jobs.findById(running.id)?.status).toBe('failed')
  })
})

/**
 * R-C3-DIRT: Human Resume adopts the current dirty worktree as an intentionally-dirty baseline, so edits made
 * on the host between a stop and the Resume are inherited. Could a LOW resumed git_commit auto-commit them
 * without anyone having seen them?
 *
 * Controlled by evidence: the git_commit Safety Evidence (`gitCommitEvidence.ts` review_gate_evidence_mismatch)
 * passes only when the commit's (HEAD, diffHash) equals the (HEAD, diffHash) the review Job's own Gate check
 * recorded at review start, and the Worker builds that hash from the same diff text it embeds in the review
 * prompt (`jobRunner.ts` preDiffText → targetDiffHash and buildStructuredReviewPrompt diffText). A resumed
 * review (review_resumed) or a resumed git_commit (no `review:<id>:git-commit` key → review_lineage_unresolved)
 * never passes. So a foreign edit is either part of the exact diff the reviewer was shown, or it fails the
 * Evidence and falls back to a human approval.
 */
describe('R-C3-DIRT: foreign worktree edits cannot ride a LOW git_commit past review', () => {
  function evidenceAudit(jobId: string) {
    return env.storage.auditLog.findByEntity('job', jobId).filter((entry) => entry.operation === 'git_commit_safety_evidence')
  }

  it('an edit made after the review started fails Safety Evidence and needs a human approval', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
    const project = createRunningProject(env)
    const task = await env.adoptNext(project.id, 'docs-a')
    expect(await env.worker.pollOnce()).toMatchObject({ kind: 'implement', reported: 'success' })
    expect(await env.worker.pollOnce()).toMatchObject({ kind: 'review', reported: 'success' })
    const headBefore = git(['rev-parse', 'HEAD']).trim()

    // A host edit inside the Task's allowedPaths (LOW risk, passes File Change Guard) after the review.
    writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs/lifecycle/host-edit.md'), 'edited on the host\n')

    const [commit] = await env.worker.runUntilIdle()
    expect(commit).toMatchObject({ kind: 'git_commit', reported: 'blocked' })
    // LOW → continue_safe_work_only, and git_commit is not safe work: the Worker stops and reports blocked.
    expect(commit!.gate).toMatchObject({ decision: 'BLOCKED', policy: 'continue_safe_work_only' })
    const audit = evidenceAudit(commit!.jobId)
    expect(audit.map((entry) => entry.result)).toEqual(['insufficient_safety_evidence'])
    expect(audit[0]!.detail).toContain('review_gate_evidence_mismatch')
    expect(env.storage.approvalRequests.findByTaskId(task.id)
      .filter((request) => request.status === 'WAITING_FOR_USER')
      .map((request) => request.requestedAction)).toEqual(['git_commit'])
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(env.task(task.id).status).not.toBe('done')
  })

  it('an edit present when the review starts is inside the exact diff the review was bound to', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
    const project = createRunningProject(env)
    const task = await env.adoptNext(project.id, 'docs-a')
    expect(await env.worker.pollOnce()).toMatchObject({ kind: 'implement', reported: 'success' })
    // A host edit between implement and review (the same position a Resume-inherited edit has).
    writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs/lifecycle/host-edit.md'), 'edited on the host\n')

    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported])).toEqual([
      ['review', 'success'],
      ['git_commit', 'success'],
    ])
    const review = env.jobsOf(task.id).find((job) => job.aiCliMode === 'review')!
    const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
    const [reviewEval] = env.storage.gateEvaluations.findByJobId(review.id)
    const [commitEval] = env.storage.gateEvaluations.findByJobId(commitJob.id)
    // The committed diff is byte-for-byte the diff the review Gate check (and the review prompt) covered.
    expect(commitEval).toMatchObject({ decision: 'ALLOW', bindingVerification: 'authoritative' })
    expect(commitEval!.targetDiffHash).toBe(reviewEval!.targetDiffHash)
    expect(commitEval!.targetCommit).toBe(reviewEval!.targetCommit)
    expect(git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n')).toContain('docs/lifecycle/host-edit.md')
  })

  it('an edit made between review start and the commit, outside allowedPaths, is refused too (File Change Guard + binding)', async () => {
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-a', title: 'Docs A' }]) })
    const project = createRunningProject(env)
    const task = await env.adoptNext(project.id, 'docs-a')
    await env.worker.pollOnce()
    await env.worker.pollOnce()
    writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs/README.md'), '# docs\n\nedited on the host\n')

    const [commit] = await env.worker.runUntilIdle()
    expect(commit).toMatchObject({ kind: 'git_commit', reported: 'blocked' })
    const detail = evidenceAudit(commit!.jobId)[0]!.detail ?? ''
    expect(detail).toContain('review_gate_evidence_mismatch')
    expect(detail).toContain('file_policy_violation')
    expect(env.task(task.id).status).not.toBe('done')
  })
})
