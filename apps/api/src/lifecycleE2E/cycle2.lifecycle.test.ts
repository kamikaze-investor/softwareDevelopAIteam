/**
 * Lifecycle E2E — Cycle 2 の挙動（Worker 再起動時の Outbox replay、blocked Task の外部完了取り込み拒否 →
 * abort/park → 取り込み、done Task に残った legacy blocked 行が claim を止めないこと）。
 *
 * ここでは Worker 側を**本物の関数**で動かす部分がある: `outboxStore`（一時ディレクトリの SQLite）、
 * `patchJobWithRetry()`、`recoverStaleJobs()`、`reportAbortCleanupObservations()`。これらは global `fetch`
 * を使うので、`installFetchBridge()` で Fastify app へ in-process につなぐ。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

import type { JobUpdate } from '@ai-team/worker/src/index.js'
import { patchJobWithRetry, reportAbortCleanupObservations } from '@ai-team/worker/src/index.js'
import { recoverStaleJobs } from '@ai-team/worker/src/jobStateManager.js'
import * as outboxStore from '@ai-team/worker/src/outbox/outboxStore.js'
import {
  buildLedger,
  createRunningProject,
  git,
  installFetchBridge,
  removeTargetRepo,
  startLifecycle,
  type FetchBridge,
  type LifecycleEnv,
  type ReviewOutcome,
} from './harness'
import { LIFECYCLE_TARGET_DIR, resetDesignReviewStub } from './runnerStub'

vi.setConfig({ testTimeout: 240_000 })

let env: LifecycleEnv
let bridge: FetchBridge | undefined
let cwdSpy: { mockRestore: () => void } | undefined
const previousRepoRoot = process.env.DESIGN_REVIEW_REPO_ROOT

beforeAll(() => {
  // 本物の outboxStore は `process.cwd()/data/outbox.db` を使う。worktree を汚さないよう一時ディレクトリへ向ける。
  const outboxRoot = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-outbox-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(outboxRoot)
})
beforeEach(() => {
  resetDesignReviewStub()
})
afterEach(async () => {
  bridge?.restore()
  bridge = undefined
  if (previousRepoRoot === undefined) delete process.env.DESIGN_REVIEW_REPO_ROOT
  else process.env.DESIGN_REVIEW_REPO_ROOT = previousRepoRoot
  await env?.close()
})
afterAll(() => {
  cwdSpy?.mockRestore()
  removeTargetRepo()
})

const API = 'http://lifecycle.invalid'
const noSleep = async (): Promise<void> => {}
const HIGH_FINDING: ReviewOutcome = {
  kind: 'verdict',
  result: { status: 'approved', summary: 'caveat', findings: [{ severity: 'high', message: 'check the claim' }] },
}

/** `start()` の再起動手順と同じ順序: (1) Outbox を 1 回再送 (2) pending を持つ Job を避けて recovery。 */
async function workerRestart(): Promise<number> {
  // `replayOutboxAtStartup()` は非公開なので、その本体（既存 resendPending + patchJobWithRetry）を同じ順で呼ぶ。
  if (outboxStore.hasPending()) {
    await outboxStore.resendPending(async (jobId, payload) => (
      await patchJobWithRetry(jobId, payload, { apiBaseUrl: API, headers: {}, sleepImpl: noSleep })
    ).ok)
  }
  return recoverStaleJobs(API, {}, { hasPendingTerminalEvent: (jobId) => outboxStore.hasPendingFor(jobId) })
}

describe('Worker restart with a terminal result still in the durable Outbox', () => {
  it.each([
    { label: 'API reachable at restart → replay applies, recovery has nothing to do', outage: false },
    { label: 'API down during replay → recovery skips the Job, a later poll delivers it', outage: true },
  ])('$label', async ({ outage }) => {
    // Start: adopted Task; the Worker ran the implement Job, recorded the result in its Outbox, and crashed
    // before the PATCH reached the API (Job is still `running` in the API).
    env = await startLifecycle({ ledger: buildLedger([{ id: 'restart', title: 'Restart scenario' }]) })
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = ['docs/restart']
    const task = await env.adoptNext(project.id, 'restart')
    env.worker.crashBeforeNextReport = (jobId, payload) => {
      outboxStore.recordPending(jobId, payload as JobUpdate)
    }
    const step = await env.worker.pollOnce()
    expect(step).toMatchObject({ kind: 'implement', reported: 'success' })
    const implementId = step!.jobId
    expect(env.storage.jobs.findById(implementId)?.status).toBe('running')
    expect(outboxStore.hasPendingFor(implementId)).toBe(true)

    bridge = installFetchBridge(env)
    if (outage) bridge.failWith = (method, p) => (method === 'PATCH' && p.startsWith('/api/jobs/') ? 503 : undefined)

    // Operation: Worker restart (replay first, then startup recovery).
    const recovered = await workerRestart()
    await env.quiesce()

    if (!outage) {
      // Expected: the replay applied the real result (success → review queued); recovery touched nothing.
      expect(env.storage.jobs.findById(implementId)?.status).toBe('success')
      expect(outboxStore.hasPendingFor(implementId)).toBe(false)
    } else {
      // Expected: the result stays pending; recovery did NOT terminalize the running Job (no fail-if-running).
      expect(env.storage.jobs.findById(implementId)?.status).toBe('running')
      expect(outboxStore.hasPendingFor(implementId)).toBe(true)
      expect(bridge.calls.some((call) => call.path.endsWith('/fail-if-running'))).toBe(false)
      // A later poll cycle re-sends once the API is reachable again.
      bridge.failWith = undefined
      await outboxStore.resendPending(async (jobId, payload) => (
        await patchJobWithRetry(jobId, payload, { apiBaseUrl: API, headers: {}, sleepImpl: noSleep })
      ).ok)
      await env.quiesce()
      expect(env.storage.jobs.findById(implementId)?.status).toBe('success')
      expect(outboxStore.hasPending()).toBe(false)
    }
    expect(recovered).toBe(0)
    expect(env.jobsOf(task.id).some((job) => job.aiCliMode === 'review' && job.status === 'queued')).toBe(true)

    // The lifecycle then completes normally.
    bridge.restore()
    const rest = await env.worker.runUntilIdle()
    expect(rest.map((s) => [s.kind, s.reported])).toEqual([['review', 'success'], ['git_commit', 'success']])
    expect(env.task(task.id).status).toBe('done')
  })
})

/** canonical master 相当の別 repository（external completion の根拠を照合する先）に 1 commit 作る。 */
function canonicalRepoWithCommit(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-canonical-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
  run(['init', '-q', '-b', 'master'])
  run(['config', 'user.email', 'canonical@example.invalid'])
  run(['config', 'user.name', 'canonical'])
  run(['config', 'core.autocrlf', 'false'])
  writeFileSync(path.join(dir, 'README.md'), '# canonical\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'base'])
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
    writeFileSync(path.join(dir, relative), content)
  }
  run(['add', '.'])
  run(['commit', '-q', '-m', 'external completion'])
  return dir
}

/** ADMIN が承認した Task 単位の ApprovalRequest（abort_task / reconcile_external_completion 用）。 */
async function approvedRequest(
  taskId: string,
  requestedAction: string,
  /** reconcile 承認は commit と根拠の digest に束縛する（preview が返す値をそのまま載せる）。 */
  binding: { targetCommit: string; targetDiffHash: string } = { targetCommit: 'n/a', targetDiffHash: 'n/a' },
): Promise<string> {
  const created = await env.api<{ id: string }>('POST', '/api/approval-requests', {
    taskId, targetBranch: 'master', ...binding, riskLevel: 'HIGH', requestedAction,
  })
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201)
  expect((await env.ceo.approve(created.body.id)).statusCode).toBe(200)
  return created.body.id
}

/**
 * blocked 行を持つ Task を作り、外部完了の根拠（canonical repo の commit と承認済み request）を用意する。
 * - `guard`: initial implement が File Change Guard 違反で blocked（Worker は自分の変更を戻す → baseline も
 *   worktree も clean）
 * - `rejected_commit`: git_commit を CEO が REJECT（baseline は dirty = 未 commit の変更を抱えたまま claim された）
 */
async function blockedTaskWithExternalCompletion(id: string, shape: 'guard' | 'rejected_commit', files: string[]) {
  env = await startLifecycle({ ledger: buildLedger([{ id, title: `Reconcile ${id}` }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [`docs/${id}`]
  if (shape === 'guard') {
    env.worker.behaviors.implement = () => ({ kind: 'guard_violation', violations: ['apps/worker/src/index.ts'] })
  } else {
    env.worker.behaviors.review = () => HIGH_FINDING
  }
  const task = await env.adoptNext(project.id, id)
  await env.worker.runUntilIdle()
  if (shape === 'rejected_commit') {
    const [commitApproval] = env.storage.approvalRequests.findByTaskId(task.id)
    expect((await env.ceo.reject(commitApproval!.id)).statusCode).toBe(200)
  }
  const carrier = env.jobsOf(task.id)[0]!
  expect(carrier.status).toBe('blocked')
  expect(carrier.workspaceBaseline?.mode).toBe(shape === 'guard' ? 'clean' : 'dirty')

  process.env.DESIGN_REVIEW_REPO_ROOT = canonicalRepoWithCommit(Object.fromEntries(files.map((file) => [file, 'completed outside the loop\n'])))
  const externalSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.env.DESIGN_REVIEW_REPO_ROOT, encoding: 'utf-8' }).trim()
  const evidence = {
    roadmapItemId: id, commitSha: externalSha, pullRequestUrl: `https://example.invalid/pr/${id}`,
    independentReviewVerdict: 'approved', ciResult: 'green', acceptanceEvidence: 'verified on master',
    approvedScope: `docs/${id}`,
  }
  // 承認依頼に載せる束縛値は読み取り専用の preview から取る（Mobile と同じ手順）。
  const preview = await env.api<{ approvalTargetDiffHash: string }>(
    'POST', `/api/tasks/${task.id}/reconcile-external-completion/preview`, { sourceJobId: carrier.id, evidence },
  )
  expect(preview.statusCode, JSON.stringify(preview.body)).toBe(200)
  const binding = { targetCommit: externalSha, targetDiffHash: preview.body.approvalTargetDiffHash }
  const reconcileApproval = await approvedRequest(task.id, 'reconcile_external_completion', binding)
  const reconcileBody = { approvalRequestId: reconcileApproval, sourceJobId: carrier.id, evidence }
  return { task, carrier, reconcileApproval, reconcileBody, binding }
}

/** reconcile 拒否 → abort → 本物の Worker cleanup 報告 → park → reconcile、の一連（両 shape 共通の期待）。 */
async function refuseAbortParkReconcile(
  fx: Awaited<ReturnType<typeof blockedTaskWithExternalCompletion>>,
  /** Worker の観測の前に operator が行う操作（D4: backup 後に worktree を開始 commit へ戻す）。 */
  beforeWorkerReport?: () => Promise<void>,
): Promise<void> {
  const { task, carrier, reconcileApproval, reconcileBody, binding } = fx

  // Operation 1: reconcile. Expected: 409 TASK_HAS_BLOCKED_JOBS before the Gate (approval not consumed).
  const refused = await env.api<{ code?: string }>('POST', `/api/tasks/${task.id}/reconcile-external-completion`, reconcileBody)
  expect(refused.statusCode, JSON.stringify(refused.body)).toBe(409)
  expect(refused.body.code).toBe('TASK_HAS_BLOCKED_JOBS')
  expect(env.storage.approvalRequests.findById(reconcileApproval)?.status).toBe('APPROVED')
  expect(env.task(task.id).status).not.toBe('done')

  // Operation 2: abort_task with an ADMIN-approved request. Expected: cleanup requested on the blocked row.
  const abortApproval = await approvedRequest(task.id, 'abort_task')
  const abort = await env.api('POST', `/api/tasks/${task.id}/abort`, { approvalRequestId: abortApproval, reason: 'completed outside the loop' })
  expect(abort.statusCode, JSON.stringify(abort.body)).toBe(200)
  expect(env.storage.jobs.findById(carrier.id)?.failureMetadata?.abortCleanupRequestedAt).toBeDefined()

  // Operation 3: the real Worker abort-cleanup step observes the worktree and reports (manual abort: no revert).
  // Expected: accepted, blocked row released (failed), Task parked.
  await beforeWorkerReport?.()
  bridge = installFetchBridge(env)
  await reportAbortCleanupObservations()
  const reports = bridge.calls.filter((call) => call.path.endsWith('/abort-cleanup-result'))
  bridge.restore()
  await env.quiesce()
  expect(reports.map((call) => [call.status, call.responseBody?.slice(0, 160)])).toEqual([[200, expect.any(String)]])
  expect(env.storage.jobs.findById(carrier.id)?.status).toBe('failed')
  expect(env.storage.tasks.isParked(task.id)).toBe(true)

  // An authorized park stales every active request of the Task (W4 "stale every active request on authorized
  // park"), including the reconcile approval issued before the abort — intended: the CEO re-approves the
  // reconcile against the parked state.
  expect(env.storage.approvalRequests.findById(reconcileApproval)?.status).toBe('STALE')
  const freshApproval = await approvedRequest(task.id, 'reconcile_external_completion', binding)

  // Operation 4: reconcile again with the fresh approval. Expected: 200, Task done, audit recorded.
  const done = await env.api('POST', `/api/tasks/${task.id}/reconcile-external-completion`, { ...reconcileBody, approvalRequestId: freshApproval })
  expect(done.statusCode, JSON.stringify(done.body)).toBe(200)
  expect(env.task(task.id).status).toBe('done')
  expect(env.storage.auditLog.findByEntity('task', task.id).some((row) => row.operation === 'reconcile_external_completion')).toBe(true)
  // 取り込みは承認を完了と同じ transaction で使い切る（done 後に生きた承認を残さない）。
  expect(env.storage.approvalRequests.findById(freshApproval)?.status).toBe('CONSUMED')
}

describe('External completion of a Task with a blocked row: refused → abort/park → reconciled', () => {
  it.each([
    { id: 'reconcile-a', files: ['docs/reconcile-a/done.md'] },
    { id: 'reconcile-b', files: ['docs/reconcile-b/one.md', 'docs/reconcile-b/two.md'] },
  ])('$id: guard-blocked implement (clean baseline)', async ({ id, files }) => {
    // Start: initial implement blocked by the File Change Guard (its own change reverted), Task pending,
    // the same work completed outside the loop and merged to canonical master.
    await refuseAbortParkReconcile(await blockedTaskWithExternalCompletion(id, 'guard', files))
  })

  /**
   * D4（dirty baseline の blocked 行を manual abort で park する）。
   *
   * Start:     git_commit を CEO が REJECT した Task（blocked 行の baseline は dirty — git_commit は
   *            未 commit の変更を抱えた worktree で claim される）。同じ作業は canonical master で完了済み。
   * Operation: reconcile 409 → abort_task → 変更が残ったままの Worker 報告 → operator が（backup の後に）
   *            worktree を carrier の開始 commit へ戻す → Worker 報告 → reconcile。
   * Expected:  変更が残ったままの報告は 409（所有権保持・park しない。Worker の manual 経路は revert しない）。
   *            clean 観測（HEAD = carrier baseline の startCommitHash、knownGood 全項目）で park し、
   *            reconcile 200 / done（approval_rules「CEO が REJECT した git_commit の解放」: operator revert →
   *            clean 観測と knownGood）。
   */
  it('D4 rejected git_commit (dirty baseline): abort parks after an operator revert to the start commit, then the external completion is reconciled', async () => {
    const fx = await blockedTaskWithExternalCompletion('reconcile-d4', 'rejected_commit', ['docs/reconcile-d4/done.md'])
    const startCommit = fx.carrier.workspaceBaseline!.startCommitHash
    await refuseAbortParkReconcile(fx, async () => {
      // With the Task's changes still present the manual report cannot release anything.
      expect(git(['status', '--porcelain']).trim()).not.toBe('')
      const dirtyBridge = installFetchBridge(env)
      await reportAbortCleanupObservations()
      const dirtyReports = dirtyBridge.calls.filter((call) => call.path.endsWith('/abort-cleanup-result'))
      dirtyBridge.restore()
      expect(dirtyReports.map((call) => call.status)).toEqual([409])
      expect(env.storage.jobs.findById(fx.carrier.id)?.status).toBe('blocked')
      expect(env.storage.tasks.isParked(fx.task.id)).toBe(false)
      // Operator (after a restore-verified backup): revert the worktree to the carrier's start commit.
      expect(git(['rev-parse', 'HEAD']).trim()).toBe(startCommit)
      git(['checkout', '--', '.'])
      git(['clean', '-fdq'])
      expect(git(['status', '--porcelain']).trim()).toBe('')
    })
  })
})

describe('A legacy blocked row on a done Task no longer freezes claims (when the worktree is clean)', () => {
  it.each([
    { label: 'clean worktree → the next Task is claimed', dirt: false },
    { label: 'unexplained dirt → no claim until it is gone (fail-closed)', dirt: true },
  ])('$label', async ({ dirt }) => {
    // Start: a done Task L with a leftover blocked git_commit row (legacy data), and a new Task B adopted.
    env = await startLifecycle({ ledger: buildLedger([{ id: 'legacy-l', title: 'Legacy' }, { id: 'next-b', title: 'Next' }]) })
    const project = createRunningProject(env)
    const legacy = env.storage.tasks.create({
      projectId: project.id, title: 'Legacy', description: 'old', status: 'done', assignee: 'developer_ai',
      dependencies: [], roadmapActive: true, roadmapTaskKey: 'legacy-l', allowedPaths: ['docs/legacy'], acceptanceCriteria: ['x'],
    } as Parameters<typeof env.storage.tasks.create>[0])
    const stale = env.storage.jobs.create({
      taskId: legacy.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'git_commit', workingDir: LIFECYCLE_TARGET_DIR },
      workspaceBaseline: { mode: 'clean', startCommitHash: git(['rev-parse', 'HEAD']).trim() },
    } as Parameters<typeof env.storage.jobs.create>[0])
    env.adoptionAllowedPaths = ['docs/next']
    const taskB = await env.adoptNext(project.id, 'next-b')
    const bJob = env.jobsOf(taskB.id)[0]!
    if (dirt) writeFileSync(path.join(LIFECYCLE_TARGET_DIR, 'docs', 'stray.md'), 'not owned by anyone\n')

    // Operation: Worker poll.
    const step = await env.worker.pollOnce()

    if (!dirt) {
      // Expected: B's initial-implement is claimed despite the done Task's blocked row.
      expect(step).toMatchObject({ jobId: bJob.id, claimStatus: 200 })
    } else {
      // Expected: nothing is claimed while unexplained dirt exists; after it is removed, B is claimed.
      expect(step).toBeNull()
      expect(env.storage.jobs.findById(bJob.id)?.status).toBe('queued')
      execFileSync('git', ['clean', '-fdq', '--', 'docs/stray.md'], { cwd: LIFECYCLE_TARGET_DIR })
      expect(await env.worker.pollOnce()).toMatchObject({ jobId: bJob.id, claimStatus: 200 })
    }
    // The legacy row is left as it is (nothing pretends to have proven its release).
    expect(env.storage.jobs.findById(stale.id)?.status).toBe('blocked')
  })
})
