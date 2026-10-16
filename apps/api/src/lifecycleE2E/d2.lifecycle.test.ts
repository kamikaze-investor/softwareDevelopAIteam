/**
 * Lifecycle E2E — D2: 承認済みの HIGH / CRITICAL git_commit は commit され、承認の無い・使えない承認では commit されない。
 *
 * 本物の route + SQLite + git worktree の上で、Worker simulation（`harness.ts`。Gate policy は本物の
 * `resolvePolicy()`）と PL tick を回す。番号は CEO の D2 完了条件（1〜15）。
 *
 * 2 / 4 / 15 は承認済みの commit が成立すること、1 / 3 / 5 / 6 / 10 / 11 は成立しないこと、
 * 7 / 8 / 9 / 12 は consume の拒否と冪等性、13 / 14 は consume 前後の障害と Worker 再起動。
 * consume の Task / Job / action / 状態ごとの拒否は route レベル（`routes/approvalGate.test.ts`
 * 「consume — D2 hardening」）でも網羅している。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

import type { ApprovalRequest, Job, Task } from '@ai-team/shared'
import type { JobUpdate } from '@ai-team/worker/src/index.js'
import { patchJobWithRetry } from '@ai-team/worker/src/index.js'
import { recoverStaleJobs } from '@ai-team/worker/src/jobStateManager.js'
import * as outboxStore from '@ai-team/worker/src/outbox/outboxStore.js'
import {
  buildLedger,
  createRunningProject,
  dirtyPaths,
  git,
  headCommit,
  installFetchBridge,
  removeTargetRepo,
  startLifecycle,
  type FetchBridge,
  type LifecycleEnv,
} from './harness'
import { LIFECYCLE_TARGET_DIR, resetDesignReviewStub } from './runnerStub'

vi.setConfig({ testTimeout: 300_000 })

let env: LifecycleEnv
let bridge: FetchBridge | undefined
let cwdSpy: { mockRestore: () => void } | undefined

beforeAll(() => {
  // 本物の outboxStore は `process.cwd()/data/outbox.db` を使う。worktree を汚さないよう一時ディレクトリへ向ける。
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(path.join(os.tmpdir(), 'lifecycle-d2-outbox-')))
})
beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  vi.useRealTimers()
  bridge?.restore()
  bridge = undefined
  await env?.close()
})
afterAll(() => {
  cwdSpy?.mockRestore()
  removeTargetRepo()
})

const API = 'http://lifecycle.invalid'
const noSleep = async (): Promise<void> => {}
const HIGH_FILE = 'docs/project_memory/goal.md'
const CRITICAL_FILE = 'docs/AGENTS.md'
const REKICK = async () => JSON.stringify({ actionKind: 'rekick_design_review', rationale: 'queued repair review is idle', riskLevel: 'LOW' })
const RESUME = async () => JSON.stringify({ actionKind: 'resume_task', rationale: 'resume the stopped git_commit', riskLevel: 'LOW' })

function commitCount(): number {
  return Number(git(['rev-list', '--count', 'HEAD']).trim())
}

function approvalsOf(taskId: string): ApprovalRequest[] {
  return env.storage.approvalRequests.findByTaskId(taskId)
}

function waitingGitCommit(taskId: string): ApprovalRequest | undefined {
  return approvalsOf(taskId).find((a) => a.requestedAction === 'git_commit' && a.status === 'WAITING_FOR_USER')
}

/** HIGH diff の Task を採用し、git_commit が Job-linked の人間承認待ち（WAITING）で止まるまで進める。 */
async function highCommitWaiting(id: string, items = [{ id, title: `HIGH ${id}` }]): Promise<{ task: Task; commitJob: Job; approval: ApprovalRequest; head: string }> {
  env = await startLifecycle({ ledger: buildLedger(items) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [HIGH_FILE]
  env.worker.behaviors.implement = () => ({ kind: 'change', files: { [HIGH_FILE]: `# Goal\n\n${id}: run the AI team from a phone.\n` } })
  const task = await env.adoptNext(project.id, id)
  const steps = await env.worker.runUntilIdle()
  expect(steps.map((step) => [step.kind, step.reported])).toEqual([
    ['implement', 'success'], ['review', 'success'], ['git_commit', 'blocked'],
  ])
  // API の continuationPolicy（policy 起因の人間承認 → block_until_approved）をそのまま写す。
  expect(steps[2]!.gate).toMatchObject({ decision: 'BLOCKED', policy: 'block_until_approved', nextAction: 'wait_for_approval' })
  const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
  const approval = waitingGitCommit(task.id)!
  expect(approval).toMatchObject({ riskLevel: 'HIGH' })
  expect(commitJob).toMatchObject({ status: 'blocked', approvalId: approval.id })
  return { task, commitJob, approval, head: headCommit() }
}

/** 承認済みの commit が成立したことの共通確認。 */
function expectCommitted(task: Task, commitJobId: string, file: string, headBefore: string): void {
  const job = env.storage.jobs.findById(commitJobId)!
  expect(job.status).toBe('success')
  expect(headCommit()).not.toBe(headBefore)
  expect(job.commitHash).toBe(headCommit())
  expect(git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim()).toBe(file)
  expect(env.task(task.id).status).toBe('done')
  expect(dirtyPaths()).toEqual([])
}

/** 承認の無い・使えない状態では commit されていないことの共通確認。 */
function expectNotCommitted(headBefore: string, file: string): void {
  expect(headCommit()).toBe(headBefore)
  expect(dirtyPaths()).toContain(file)
}

describe('D2 criterion 1: HIGH unapproved → never commits', () => {
  it('the git_commit stays blocked on the WAITING approval through PL ticks and Worker polls', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c1')
    await env.plTick()
    await env.plTick()
    const again = await env.worker.runUntilIdle()
    expect(again).toEqual([])
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('WAITING_FOR_USER')
    expect((await env.systemState()).attention.map((item) => item.kind)).toContain('approval_waiting')
    expect(env.task(task.id).status).not.toBe('done')
    expectNotCommitted(head, HIGH_FILE)
    expect(commitCount()).toBe(1)
  })
})

/** CRITICAL diff: review の safe-work も止まる（block_until_approved）→ 承認 + resume → git_commit が承認待ち。 */
async function criticalCommitWaiting(id: string): Promise<{ task: Task; commitJob: Job; approval: ApprovalRequest; head: string }> {
  env = await startLifecycle({ ledger: buildLedger([{ id, title: `CRITICAL ${id}` }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [CRITICAL_FILE]
  env.worker.behaviors.implement = () => ({ kind: 'change', files: { [CRITICAL_FILE]: `# Agents\n\n${id}\n` } })
  const task = await env.adoptNext(project.id, id)
  const head = headCommit()

  // CRITICAL: review（git_status）も承認まで止まる。git_commit Job はまだ作られていない。
  const first = await env.worker.runUntilIdle()
  expect(first.map((step) => [step.kind, step.reported])).toEqual([['implement', 'success'], ['review', 'blocked']])
  expect(first[1]!.gate).toMatchObject({ decision: 'BLOCKED', policy: 'block_until_approved' })
  expect(env.jobsOf(task.id).some((job) => job.safeCommand.kind === 'git_commit')).toBe(false)
  const reviewApproval = approvalsOf(task.id).find((a) => a.requestedAction === 'git_status')!
  expect(reviewApproval).toMatchObject({ status: 'WAITING_FOR_USER', riskLevel: 'CRITICAL' })
  expect(await env.worker.runUntilIdle()).toEqual([])
  expectNotCommitted(head, CRITICAL_FILE)

  // ADMIN が review を承認し、Human Resume で review を再実行 → 承認を consume して review が通る。
  expect((await env.ceo.approve(reviewApproval.id)).statusCode).toBe(200)
  expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })
  expect((await env.ceo.resume(task.id)).statusCode).toBe(201)
  const second = await env.worker.runUntilIdle()
  expect(second.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([
    ['review', 'success', 200], ['git_commit', 'blocked', undefined],
  ])
  expect(second[1]!.gate).toMatchObject({ decision: 'BLOCKED', policy: 'block_until_approved' })
  const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
  const approval = waitingGitCommit(task.id)!
  expect(approval).toMatchObject({ riskLevel: 'CRITICAL' })
  expect(commitJob.approvalId).toBe(approval.id)
  return { task, commitJob, approval, head }
}

describe('D2 criterion 3: CRITICAL unapproved → never commits', () => {
  it('neither the review nor the git_commit runs without approval, and nothing is committed', async () => {
    const { task, commitJob, approval, head } = await criticalCommitWaiting('c3')
    await env.plTick()
    expect(await env.worker.runUntilIdle()).toEqual([])
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('WAITING_FOR_USER')
    expect(env.task(task.id).status).not.toBe('done')
    expectNotCommitted(head, CRITICAL_FILE)
  })
})

describe('D2 criterion 4: CRITICAL approved → consume → commit → done', () => {
  it('the approved CRITICAL git_commit consumes its approval and commits (same treatment as HIGH after approval)', async () => {
    const { task, commitJob, approval, head } = await criticalCommitWaiting('c4')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    const done = await env.worker.runUntilIdle()
    expect(done.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expect(done[0]!.gate).toMatchObject({ decision: 'ALLOW', policy: 'continue', nextAction: 'call_consume' })
    expectCommitted(task, commitJob.id, CRITICAL_FILE, head)
    expect(approvalsOf(task.id).map((a) => [a.requestedAction, a.status]).sort()).toEqual([
      ['git_commit', 'CONSUMED'], ['git_status', 'CONSUMED'],
    ])
    expect((await env.systemState()).attention).toEqual([])
  })
})

describe('D2 criterion 5: expired approval → no commit → blocked → resume path', () => {
  it('an approval that expires between gate/check and consume is refused at consume (EXPIRED); the Job is blocked and resumable', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c5')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    env.worker.beforeNextConsume = () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000))
    }
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'blocked', 409]])
    expect(steps[0]!.gate).toMatchObject({ decision: 'ALLOW', nextAction: 'call_consume' })
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('EXPIRED')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expectNotCommitted(head, HIGH_FILE)
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })

    // Exit: resume → a new git_commit Job with a fresh approval → approve → commit.
    expect((await env.plTick({ diagnose: RESUME })).proposedKind).toBe('resume_task')
    const blocked = await env.worker.runUntilIdle()
    expect(blocked.map((step) => [step.kind, step.reported])).toEqual([['git_commit', 'blocked']])
    const fresh = waitingGitCommit(task.id)!
    expect(fresh.id).not.toBe(approval.id)
    expect((await env.ceo.approve(fresh.id)).statusCode).toBe(200)
    const done = await env.worker.runUntilIdle()
    expect(done.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expect(env.task(task.id).status).toBe('done')
    expect(headCommit()).not.toBe(head)
  })
})

describe('D2 criterion 6 / 11: STALE (diff changed) and REJECTED → no commit', () => {
  it('diff changed after approval → gate STALE → blocked, no commit; a new approval is required for the new diff', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c6-stale')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    writeFileSync(path.join(LIFECYCLE_TARGET_DIR, HIGH_FILE), '# Goal\n\nchanged after the approval\n')
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'blocked', undefined]])
    expect(steps[0]!.gate).toMatchObject({ decision: 'STALE', policy: 're_check', nextAction: 're_check' })
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('STALE')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expectNotCommitted(head, HIGH_FILE)

    expect((await env.plTick({ diagnose: RESUME })).proposedKind).toBe('resume_task')
    expect((await env.worker.runUntilIdle()).map((step) => [step.kind, step.reported])).toEqual([['git_commit', 'blocked']])
    const fresh = waitingGitCommit(task.id)!
    expect(fresh.id).not.toBe(approval.id)
    expect(fresh.targetDiffHash).not.toBe(approval.targetDiffHash)
    expectNotCommitted(head, HIGH_FILE)
    expect((await env.ceo.approve(fresh.id)).statusCode).toBe(200)
    expect((await env.worker.runUntilIdle()).map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expect(git(['show', 'HEAD:' + HIGH_FILE])).toContain('changed after the approval')
    expect(env.task(task.id).status).toBe('done')
  })

  it('consume with a commit/diff that no longer matches the approval → 409 STALE, the approval is invalidated, no commit', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c6-consume-stale')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    // The Worker claims the requeued Job, then presents a different diff at consume time.
    const claimed = await env.api('PATCH', `/api/jobs/${commitJob.id}`, { status: 'running', startedAt: new Date().toISOString() }, 'worker')
    expect(claimed.statusCode).toBe(200)
    const consume = await env.api<{ consumed?: boolean }>('POST', `/api/approval-requests/${approval.id}/consume`, {
      jobId: commitJob.id, currentCommit: approval.targetCommit, currentDiffHash: 'a-different-diff',
    }, 'worker')
    expect(consume.statusCode).toBe(409)
    expect(consume.body.consumed).toBe(false)
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('STALE')
    expectNotCommitted(head, HIGH_FILE)
    expect(env.task(task.id).status).not.toBe('done')
  })

  it('REJECTED → the Job is not requeued and nothing is committed', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c6-rejected')
    expect((await env.ceo.reject(approval.id)).statusCode).toBe(200)
    expect(await env.worker.runUntilIdle()).toEqual([])
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('REJECTED')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expect(env.task(task.id).status).not.toBe('done')
    expectNotCommitted(head, HIGH_FILE)
  })
})

describe('D2 criterion 10: commit mismatch → no commit of the approved diff', () => {
  it('HEAD moved after approval → gate STALE → blocked; the approved diff is not committed', async () => {
    const { commitJob, approval } = await highCommitWaiting('c10')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs', 'README.md'), '# docs (moved HEAD)\n')
    git(['add', '--', 'docs/README.md'])
    git(['commit', '-q', '-m', 'unrelated commit after the approval'])
    const moved = headCommit()
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported])).toEqual([['git_commit', 'blocked']])
    expect(steps[0]!.gate).toMatchObject({ decision: 'STALE', policy: 're_check' })
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('STALE')
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expectNotCommitted(moved, HIGH_FILE)
  })
})

describe('D2 criteria 7 / 8 / 9: Task / Job / action mismatch at consume → refused, no commit by the wrong Job', () => {
  it('consume by a foreign-Task Job, another git_commit Job, or a different-action Job is refused; the bound Job then commits', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c789')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    const project = env.storage.projects.findAll().find((p) => p.status === 'running')!
    const otherTask = env.storage.tasks.create({
      projectId: project.id, title: 'foreign', description: 'foreign task', status: 'pending',
      assignee: 'developer_ai', dependencies: [],
    } as Parameters<typeof env.storage.tasks.create>[0])
    const mk = (taskId: string, kind: string) => env.storage.jobs.create({
      taskId, projectId: project.id, agentRole: 'developer_ai', status: 'running',
      safeCommand: { kind, workingDir: LIFECYCLE_TARGET_DIR, ...(kind === 'git_commit' ? { params: { commitMessage: 'x' } } : {}) },
    } as never)
    const foreignTaskJob = mk(otherTask.id, 'git_commit')
    const otherCommitJob = mk(task.id, 'git_commit')
    const otherActionJob = mk(task.id, 'test')
    const binding = { currentCommit: approval.targetCommit, currentDiffHash: approval.targetDiffHash }
    for (const wrong of [foreignTaskJob, otherCommitJob, otherActionJob]) {
      const res = await env.api<{ consumed?: boolean }>('POST', `/api/approval-requests/${approval.id}/consume`, { jobId: wrong.id, ...binding }, 'worker')
      expect(res.statusCode, wrong.safeCommand.kind).toBe(409)
      expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('APPROVED')
    }
    expectNotCommitted(head, HIGH_FILE)
    // The probe Jobs are not part of the lifecycle; end them so they do not hold the workspace.
    for (const wrong of [foreignTaskJob, otherCommitJob, otherActionJob]) env.storage.jobs.update(wrong.id, { status: 'failed' })

    const done = await env.worker.runUntilIdle()
    expect(done.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expectCommitted(task, commitJob.id, HIGH_FILE, head)
  })
})

describe('D2 criterion 12: double consume → no second commit; the same Job is idempotent', () => {
  it('after the commit, the same Job re-consuming is an idempotent success, another Job is refused, HEAD does not move', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c12')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    await env.worker.runUntilIdle()
    expectCommitted(task, commitJob.id, HIGH_FILE, head)
    const committed = headCommit()
    const count = commitCount()
    const binding = { currentCommit: approval.targetCommit, currentDiffHash: approval.targetDiffHash }

    // Same Job (now success, no longer running): idempotent success (Outbox-style replay).
    const replay = await env.api<{ alreadyConsumed?: boolean; consumed?: boolean }>('POST', `/api/approval-requests/${approval.id}/consume`, { jobId: commitJob.id, ...binding }, 'worker')
    expect(replay.statusCode).toBe(200)
    expect(replay.body).toMatchObject({ consumed: true, alreadyConsumed: true })

    // Another Job: refused, reported as already consumed by the bound Job.
    const project = env.storage.projects.findAll().find((p) => p.status === 'running')!
    const other = env.storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'running',
      safeCommand: { kind: 'git_commit', workingDir: LIFECYCLE_TARGET_DIR, params: { commitMessage: 'x' } },
    } as never)
    const second = await env.api<{ consumed?: boolean; jobId?: string }>('POST', `/api/approval-requests/${approval.id}/consume`, { jobId: other.id, ...binding }, 'worker')
    expect(second.statusCode).toBe(409)
    expect(second.body).toMatchObject({ consumed: true, jobId: commitJob.id })
    env.storage.jobs.update(other.id, { status: 'failed' })

    expect(await env.worker.runUntilIdle()).toEqual([])
    expect(headCommit()).toBe(committed)
    expect(commitCount()).toBe(count)
  })
})

describe('D2 criterion 13: failure during consume → safe stop', () => {
  it('a technical 5xx from consume → the Job fails technically, the approval stays APPROVED, nothing is committed', async () => {
    const { commitJob, approval, head } = await highCommitWaiting('c13-5xx')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    env.worker.beforeNextConsume = () => 503
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'failed', 503]])
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('failed')
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('APPROVED')
    expectNotCommitted(head, HIGH_FILE)
    expect((await env.systemState()).attention.map((item) => item.kind)).toContain('job_failed')
  })

  it('a 409 from consume (not consumed by this Job) → blocked, nothing is committed, resume is admitted', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c13-409')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    env.worker.beforeNextConsume = () => 409
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'blocked', 409]])
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expectNotCommitted(head, HIGH_FILE)
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })
  })

  it('crash between consume and git commit → real startup recovery (recoverStaleJobs) → failed → repair → new approval → commit', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c13-crash')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    env.worker.crashAfterNextConsume = true
    const crashed = await env.worker.pollOnce()
    expect(crashed).toMatchObject({ kind: 'git_commit', consumeStatus: 200 })
    expect(crashed!.reported).toBeUndefined()
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('running')
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('CONSUMED')
    expectNotCommitted(head, HIGH_FILE)

    // Worker restart: the real recoverStaleJobs sees the workspace equal to the Job's baseline → failed.
    bridge = installFetchBridge(env)
    const recovered = await recoverStaleJobs(API, {}, { hasPendingTerminalEvent: (jobId) => outboxStore.hasPendingFor(jobId) })
    bridge.restore()
    bridge = undefined
    await env.quiesce()
    expect(recovered).toBe(1)
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('failed')
    expectNotCommitted(head, HIGH_FILE)
    // The failure prepared a repair (failAndPrepareRepair): a repair Design Review run is queued.
    expect(env.storage.designReviewRuns.findLatestByTaskId(task.id)).toMatchObject({ status: 'queued', repairSourceJobId: commitJob.id })

    // Exit: the PL rekicks the idle repair review → repair Job → fresh Job-linked approval → approve → commit.
    expect((await env.plTick({ diagnose: REKICK })).proposedKind).toBe('rekick_design_review')
    const repair = await env.worker.runUntilIdle()
    expect(repair.map((step) => [step.kind, step.reported])).toEqual([['implement', 'blocked']])
    const fresh = waitingGitCommit(task.id)!
    expect(fresh.id).not.toBe(approval.id)
    expect((await env.ceo.approve(fresh.id)).statusCode).toBe(200)
    const done = await env.worker.runUntilIdle()
    expect(done.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['implement', 'success', 200]])
    expect(env.task(task.id).status).toBe('done')
    expect(headCommit()).not.toBe(head)
    expect(git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim()).toBe(HIGH_FILE)
    expect(approvalsOf(task.id).map((a) => a.status)).toEqual(['CONSUMED', 'CONSUMED'])
  })
})

describe('D2 criterion 14: Worker restart after the commit → the Outbox replay completes the Task', () => {
  it('the commit result recorded in the Outbox before the crash is replayed at restart; startup recovery leaves the Job alone', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('c14')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    env.worker.crashBeforeNextReport = (jobId, payload) => {
      outboxStore.recordPending(jobId, payload as JobUpdate)
    }
    const step = await env.worker.pollOnce()
    expect(step).toMatchObject({ kind: 'git_commit', consumeStatus: 200, reported: 'success' })
    expect(headCommit()).not.toBe(head)
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('running')
    expect(outboxStore.hasPendingFor(commitJob.id)).toBe(true)

    bridge = installFetchBridge(env)
    await outboxStore.resendPending(async (jobId, payload) => (
      await patchJobWithRetry(jobId, payload, { apiBaseUrl: API, headers: {}, sleepImpl: noSleep })
    ).ok)
    const recovered = await recoverStaleJobs(API, {}, { hasPendingTerminalEvent: (jobId) => outboxStore.hasPendingFor(jobId) })
    bridge.restore()
    bridge = undefined
    await env.quiesce()
    expect(recovered).toBe(0)
    expect(outboxStore.hasPendingFor(commitJob.id)).toBe(false)
    expectCommitted(task, commitJob.id, HIGH_FILE, head)
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('CONSUMED')
  })
})

describe('D2 criterion 15: approved commit → Task done → continuation → next Task adopted', () => {
  it('the approved HIGH Task completes, its continuation completes, and the PL adopts and finishes the next item', async () => {
    const items = [{ id: 'c15-a', title: 'HIGH first' }, { id: 'c15-b', title: 'LOW second' }]
    const { task, commitJob, approval, head } = await highCommitWaiting('c15-a', items)
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    const done = await env.worker.runUntilIdle()
    expect(done.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expectCommitted(task, commitJob.id, HIGH_FILE, head)
    expect(env.storage.taskContinuations.findBySourceJobId(commitJob.id)?.status).toBe('completed')
    expect(env.worker.hasPendingOutbox()).toBe(false)

    env.adoptionAllowedPaths = ['docs/lifecycle']
    env.worker.behaviors.implement = () => ({ kind: 'change', files: { 'docs/lifecycle/second.md': 'second\n' } })
    const project = env.storage.projects.findAll().find((p) => p.status === 'running')!
    const next = await env.adoptNext(project.id, 'c15-b')
    const rest = await env.worker.runUntilIdle()
    expect(rest.map((step) => [step.kind, step.reported])).toEqual([['implement', 'success'], ['review', 'success'], ['git_commit', 'success']])
    expect(env.task(next.id).status).toBe('done')
    expect(commitCount()).toBe(3)
  })
})

describe('D2: local risk > API risk (worker/api rule skew) → blocked and visible, never executed', () => {
  it('the approved commit is not consumed; the Job is blocked with the risk-inconsistency reason, visible in attention, and resumable', async () => {
    const { task, commitJob, approval, head } = await highCommitWaiting('skew')
    expect((await env.ceo.approve(approval.id)).statusCode).toBe(200)
    env.worker.localRiskOverride = () => 'CRITICAL'
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'blocked', undefined]])
    expect(steps[0]!.gate).toMatchObject({
      decision: 'ALLOW', nextAction: 'call_consume', policy: 'block_until_approved',
      reason: 'risk inconsistency: local CRITICAL > API HIGH (worker/api rule skew)',
    })
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('blocked')
    expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('APPROVED')
    expectNotCommitted(head, HIGH_FILE)
    const attention = (await env.systemState()).attention
    expect(attention.find((item) => item.kind === 'job_blocked' && item.jobId === commitJob.id)?.detail).toContain('approved_but_worker_blocked')
    expect((await env.mobileAdmission(task.id)).resume).toEqual({ ok: true })

    // Once the versions agree again, the existing resume is the exit.
    env.worker.localRiskOverride = undefined
    expect((await env.ceo.resume(task.id)).statusCode).toBe(201)
    // The resumed git_commit is a new Job, so it gets its own Job-linked approval (one approval per Job).
    const resumedRun = await env.worker.runUntilIdle()
    expect(resumedRun.map((step) => [step.kind, step.reported])).toEqual([['git_commit', 'blocked']])
    const waiting = waitingGitCommit(task.id)!
    expect(waiting.id).not.toBe(approval.id)
    expect((await env.ceo.approve(waiting.id)).statusCode).toBe(200)
    const steps2 = await env.worker.runUntilIdle()
    expect(steps2.map((step) => [step.kind, step.reported, step.consumeStatus])).toEqual([['git_commit', 'success', 200]])
    expect(env.task(task.id).status).toBe('done')
    expect(headCommit()).not.toBe(head)
  })
})
