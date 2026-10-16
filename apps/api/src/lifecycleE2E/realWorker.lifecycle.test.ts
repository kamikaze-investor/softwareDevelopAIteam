/**
 * Lifecycle E2E with the **real Worker** (`start()` / `pollJobs()` / `runJob()`), over real HTTP against the
 * real API on an ephemeral localhost port. See `realWorkerHarness.ts` for exactly what is real and what is
 * simulated (containment bridge, AI CLI process output, target `pnpm test`, TARGET_ROOT, observation-only LLM
 * reviewers, notifier/watchdog, Design Review runner output, PL LLM calls).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Runs before every import: the Worker modules read API_BASE_URL / poll interval at module load.
const setup = vi.hoisted(() => {
  const getBuiltin = (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule
  const cp = getBuiltin('node:child_process') as typeof import('node:child_process')
  const fs = getBuiltin('node:fs') as typeof import('node:fs')
  const os = getBuiltin('node:os') as typeof import('node:os')
  const nodePath = getBuiltin('node:path') as typeof import('node:path')
  const gitAvailable = cp.spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0
  // An ephemeral port, chosen by the OS in a throwaway process (the Worker needs it before import).
  const port = cp.execFileSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
  ], { encoding: 'utf-8' }).trim()
  const scratch = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'real-worker-e2e-'))
  process.env.API_BASE_URL = `http://127.0.0.1:${port}`
  process.env.WORKER_POLL_INTERVAL_MS = '50'
  process.env.JOB_LOG_DIR = nodePath.join(scratch, 'logs')
  return { apiBase: `http://127.0.0.1:${port}`, scratch, gitAvailable }
})

const alerts = vi.hoisted(() => [] as Array<{ title: string; body: string; severity?: string }>)

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
// Worker: cgroup containment does not exist on Windows → the existing test bridge (forwards to execFileSync,
// with a per-test override for the AI CLI / target pnpm stubs).
vi.mock('@ai-team/worker/src/execution/runContainedCommand.js', async () => {
  const { createContainedCommandMock } = await import('@ai-team/worker/src/execution/containedCommandTestBridge.js')
  return createContainedCommandMock()
})
// Worker: TARGET_ROOT is hard-coded to /workspace/target. Point it (and the realpath check) at the temp repo.
// (The factory must not import runnerStub: runnerStub imports Worker modules, and resolving them inside this
// factory deadlocks the mock graph. The temp root is filled in right after the imports below.)
const targetRoot = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-team/worker/src/utils/pathUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-team/worker/src/utils/pathUtils.js')>()
  const fs = await import('node:fs')
  const nodePath = await import('node:path')
  // Same algorithm as the real isInsideTargetRoot(), with the temp repo as the root.
  const isInsideTargetRoot = (workingDir: string): boolean => {
    try {
      if (targetRoot.dir === '') return false
      const realTarget = fs.existsSync(targetRoot.dir) ? fs.realpathSync(targetRoot.dir) : nodePath.resolve(targetRoot.dir)
      const realWorkingDir = fs.existsSync(workingDir) ? fs.realpathSync(workingDir) : nodePath.resolve(workingDir)
      return realWorkingDir === realTarget || realWorkingDir.startsWith(realTarget + nodePath.sep)
    } catch {
      return false
    }
  }
  return {
    ...actual,
    get TARGET_ROOT(): string { return targetRoot.dir },
    isInsideTargetRoot,
  }
})
// Worker: observation-only LLM reviewers never run (no LLM calls); both are non-blocking in runJob().
vi.mock('@ai-team/worker/src/approvalLevel/stepReview.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-team/worker/src/approvalLevel/stepReview.js')>()
  return { ...actual, runStepReview: async () => actual.createNotRunStepReviewResult('stubbed in real-worker e2e') }
})
vi.mock('@ai-team/worker/src/approvalLevel/postReviewer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-team/worker/src/approvalLevel/postReviewer.js')>()),
  runPostReview: async () => { throw new Error('postReviewer is stubbed in real-worker e2e') },
}))
vi.mock('@ai-team/worker/src/notifier/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-team/worker/src/notifier/notifier.js')>()),
  sendAlert: async (payload: { title: string; body: string; severity?: string }) => {
    alerts.push(payload)
    return { success: true, results: [] }
  },
}))
vi.mock('@ai-team/worker/src/watchdog/watchdog.js', () => ({ startWatchdog: async () => undefined }))

import Database from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Job, Task } from '@ai-team/shared'
import * as outboxStore from '@ai-team/worker/src/outbox/outboxStore.js'
import { buildLedger, createRunningProject, removeTargetRepo } from './harness'
import { designReviewCalls, LIFECYCLE_TARGET_DIR, resetDesignReviewStub } from './runnerStub'
import {
  APPROVED,
  bootWorker,
  git,
  installCommandStubs,
  installNetworkGuard,
  jobTrail,
  startRealWorkerApi,
  waitFor,
  type AiBehaviors,
  type CommandLog,
  type ImplementScript,
  type NetworkGuard,
  type RealWorkerEnv,
  type ReviewVerdict,
  type WorkerProcess,
} from './realWorkerHarness'

vi.setConfig({ testTimeout: 240_000, hookTimeout: 30_000 })
targetRoot.dir = LIFECYCLE_TARGET_DIR

let api: RealWorkerEnv | undefined
let worker: WorkerProcess | undefined
let network: NetworkGuard
let commands: { log: CommandLog[]; restore(): void } | undefined
let behaviors: AiBehaviors
let cwdSpy: { mockRestore: () => void } | undefined
const outboxRoot = path.join(setup.scratch, 'worker-cwd')

beforeAll(() => {
  // The real Outbox lives at `process.cwd()/data/outbox.db`; keep it out of the repository.
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(outboxRoot)
  network = installNetworkGuard(setup.apiBase)
})
beforeEach(() => {
  network.failWith = undefined
  if (api !== undefined) return // continuing the previous test's environment
  resetDesignReviewStub()
  alerts.length = 0
  network.calls.length = 0
  behaviors = { implement: defaultImplement, review: () => APPROVED }
})
/** Set by a test whose environment the next test continues (RW4a → RW4b). */
let keepForNextTest = false
afterEach(async () => {
  if (keepForNextTest) {
    keepForNextTest = false
    return
  }
  await worker?.kill()
  worker = undefined
  commands?.restore()
  commands = undefined
  await api?.close()
  api = undefined
})
afterAll(() => {
  network.restore()
  cwdSpy?.mockRestore()
  removeTargetRepo()
  try {
    rmSync(setup.scratch, { recursive: true, force: true })
  } catch {
    // The Worker's Outbox SQLite handle stays open for the module lifetime (Windows refuses the unlink).
  }
})

function defaultImplement(job: Job): { files: Record<string, string> } {
  return { files: { [`docs/lifecycle/${job.id.slice(0, 8)}.md`]: `change by ${job.id}\n` } }
}

/** API + real Worker for one scenario. */
async function boot(items: Array<{ id: string; title: string }>, allowedPaths: string[] = ['docs/lifecycle']) {
  expect(outboxStore.hasPending()).toBe(false)
  api = await startRealWorkerApi(setup.apiBase, { ledger: buildLedger(items) })
  const env = api.env
  env.adoptionAllowedPaths = allowedPaths
  const project = createRunningProject(env)
  commands = installCommandStubs((jobId) => env.storage.jobs.findById(jobId), () => behaviors)
  worker = await bootWorker()
  return { env, project }
}

function trailOf(taskId: string): string[][] {
  return jobTrail(api!.env, taskId)
}

async function waitTaskStatus(taskId: string, status: Task['status'], timeoutMs = 90_000): Promise<void> {
  await waitFor(
    () => api!.env.storage.tasks.findById(taskId)?.status === status,
    () => `task ${taskId} → ${status}; now ${api!.env.storage.tasks.findById(taskId)?.status}; jobs ${JSON.stringify(trailOf(taskId))}; alerts ${JSON.stringify(alerts.map((a) => a.title))}`,
    timeoutMs,
  )
}

function commitJobOf(taskId: string): Job | undefined {
  return api!.env.storage.jobs.findByTaskId(taskId).find((job) => job.safeCommand.kind === 'git_commit')
}

function headFiles(): string[] {
  return git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').filter(Boolean).sort()
}

function expectNoUnexpectedCommands(): void {
  expect(commands!.log.filter((entry) => entry.kind === 'unexpected')).toEqual([])
}

describe.skipIf(!setup.gitAvailable)('real Worker E2E', () => {
  it('RW1: two roadmap Tasks complete consecutively (adoption → DR → implement → review → git_commit → done → continuation → next adoption)', async () => {
    const items = [{ id: 'rw-first', title: 'Write the first page' }, { id: 'rw-second', title: 'Write the second page' }]
    const { env, project } = await boot(items)
    const initialHead = git(['rev-parse', 'HEAD']).trim()

    for (const [index, item] of items.entries()) {
      // PL tick (real runPlTick, stubbed proposer) adopts the next item; Design Review (stub runner) ALIGNS.
      const task = await env.adoptNext(project.id, item.id)
      // The real Worker drains the chain on its own.
      await waitTaskStatus(task.id, 'done')
      expect(trailOf(task.id)).toEqual([
        ['task:<id>:initial-implement', 'success'],
        ['implement:<id>:review', 'success'],
        ['review:<id>:git-commit', 'success'],
      ])
      const commitJob = commitJobOf(task.id)!
      // The real `git commit` SafeCommand created HEAD and the API bound it to the Gate ALLOW.
      expect(commitJob.commitHash).toBe(git(['rev-parse', 'HEAD']).trim())
      expect(git(['log', '-1', '--pretty=%s']).trim().length).toBeGreaterThan(0)
      expect(git(['status', '--porcelain']).trim()).toBe('')
      const implementJob = env.storage.jobs.findByTaskId(task.id).find((job) => job.aiCliMode === 'implement')!
      expect(headFiles()).toEqual([`docs/lifecycle/${implementJob.id.slice(0, 8)}.md`])
      expect(env.storage.auditLog.findByEntity('job', commitJob.id)
        .filter((entry) => entry.operation === 'git_commit_safety_evidence').map((entry) => entry.result)).toEqual(['verified'])
      const [evaluation] = env.storage.gateEvaluations.findByJobId(commitJob.id)
      expect(evaluation).toMatchObject({ decision: 'ALLOW', bindingVerification: 'authoritative', resultingCommit: commitJob.commitHash })
      expect(env.storage.approvalRequests.findByTaskId(task.id)).toEqual([])
      // Continuation for the completed Task is recorded and settled by the Worker's poll-cycle reconcile.
      await waitFor(
        () => env.storage.taskContinuations.findBySourceJobId(commitJob.id)?.status === 'completed',
        () => `continuation ${JSON.stringify(env.storage.taskContinuations.findBySourceJobId(commitJob.id))}`,
      )
      expect(git(['rev-list', '--count', `${initialHead}..HEAD`]).trim()).toBe(String(index + 1))
    }

    // Real HTTP traffic: the Worker claimed, gated and reported through the API with the WORKER credential.
    const paths = network.calls.map((call) => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/g, '<id>')}`)
    expect(paths).toContain('POST /api/gate/check')
    expect(paths).toContain('PATCH /api/jobs/<id>')
    expect(network.calls.filter((call) => call.status === 401 || call.status === 403)).toEqual([])
    expect(designReviewCalls().map((call) => [call.reviewKind, call.verdict])).toEqual([['task', 'ALIGNED'], ['task', 'ALIGNED']])
    expect(commands!.log.filter((entry) => entry.kind === 'ai-cli').map((entry) => entry.mode))
      .toEqual(['implement', 'review', 'implement', 'review'])
    expectNoUnexpectedCommands()
    // The last terminal PATCH can still be between its 2xx and `deletePending()` when the API state settles.
    await waitFor(() => !outboxStore.hasPending(), () => 'Outbox drained')
    expect(env.escalations).toEqual([])
  })
})

function changesRequested(message: string): ReviewVerdict {
  return { status: 'changes_requested', summary: 'needs changes', findings: [{ severity: 'medium', message }] }
}

/** The on-disk Outbox, read through a separate connection (what a restarted process would open). */
function outboxRowsOnDisk(): Array<{ job_id: string; payload_json: string }> {
  const file = path.join(outboxRoot, 'data', 'outbox.db')
  if (!existsSync(file)) return []
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT job_id, payload_json FROM pending_outbox_events').all() as Array<{ job_id: string; payload_json: string }>
  } finally {
    db.close()
  }
}

describe.skipIf(!setup.gitAvailable)('real Worker E2E — repair', () => {
  it('RW2: review changes_requested → repair Design Review → repair implement → re-review approved → commit', async () => {
    const { env, project } = await boot([{ id: 'rw-repair', title: 'Write the repaired page' }])
    let implementCalls = 0
    behaviors.implement = (): ImplementScript => {
      implementCalls += 1
      return implementCalls === 1
        ? { files: { 'docs/lifecycle/first.md': 'first draft\n' } }
        : { files: { 'docs/lifecycle/fix.md': 'the fix\n' } }
    }
    let reviewCalls = 0
    behaviors.review = () => (++reviewCalls === 1 ? changesRequested('wording is unclear') : APPROVED)

    const task = await env.adoptNext(project.id, 'rw-repair')
    await waitTaskStatus(task.id, 'done')

    expect(trailOf(task.id)).toEqual([
      ['task:<id>:initial-implement', 'success'],
      ['implement:<id>:review', 'failed'],
      ['repair:<id>:1', 'success'],
      ['implement:<id>:review', 'success'],
      ['review:<id>:git-commit', 'success'],
    ])
    const repairJob = env.storage.jobs.findByTaskId(task.id).find((job) => job.workflowStepKey?.startsWith('repair:'))!
    expect(repairJob.aiCliPrompt).toContain('wording is unclear')
    // The repair inherited the dirty worktree (INTENTIONALLY-DIRTY): both files land in one commit.
    expect(headFiles()).toEqual(['docs/lifecycle/first.md', 'docs/lifecycle/fix.md'])
    const commitJob = commitJobOf(task.id)!
    expect(commitJob.commitHash).toBe(git(['rev-parse', 'HEAD']).trim())
    expect(env.storage.auditLog.findByEntity('job', commitJob.id)
      .find((entry) => entry.operation === 'git_commit_safety_evidence')?.result).toBe('verified')
    expect(designReviewCalls().map((call) => call.verdict)).toEqual(['ALIGNED', 'ALIGNED'])
    // The changes_requested verdict went through the real structured-review path and the Worker's alert.
    expect(env.storage.reviewResults.findByTaskId(task.id).map((review) => review.status).sort()).toEqual(['approved', 'changes_requested'])
    expect(alerts.map((alert) => alert.title)).toContain('Structured review: changes_requested')
    expect(git(['status', '--porcelain']).trim()).toBe('')
    expectNoUnexpectedCommands()
    await waitFor(() => !outboxStore.hasPending(), () => 'Outbox drained')
  })
})

describe.skipIf(!setup.gitAvailable)('real Worker E2E — restart with a pending Outbox event', () => {
  it('RW3: the implement result is stuck in the durable Outbox, the Worker dies, the restarted Worker replays before recovery and the chain completes', async () => {
    const { env, project } = await boot([{ id: 'rw-restart', title: 'Restart scenario' }])
    // API outage for exactly the implement Job's terminal PATCH (claim and other traffic pass).
    const isImplementJob = (p: string): boolean => {
      const id = /^\/api\/jobs\/([^/]+)$/.exec(p)?.[1]
      return id !== undefined && env.storage.jobs.findById(id)?.aiCliMode === 'implement'
    }
    network.failWith = (method, p, body) => (
      method === 'PATCH' && isImplementJob(p) && body !== undefined && body.includes('"eventId"') ? 503 : undefined
    )

    const task = await env.adoptNext(project.id, 'rw-restart')
    const implementId = env.storage.jobs.findByTaskId(task.id).find((job) => job.aiCliMode === 'implement')!.id
    // Wait until the real Worker recorded the result durably and its PATCH (with retries) failed.
    await waitFor(
      () => outboxRowsOnDisk().some((row) => row.job_id === implementId)
        && network.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith(implementId) && call.status === 503).length >= 3,
      () => `pending outbox row for ${implementId}; rows=${outboxRowsOnDisk().length}`,
    )
    expect(env.storage.jobs.findById(implementId)?.status).toBe('running')
    const [row] = outboxRowsOnDisk()
    expect(JSON.parse(row!.payload_json)).toMatchObject({ status: 'success' })

    // The Worker process dies while the event is still pending; the API recovers.
    const firstGeneration = worker!.generation
    await worker!.kill()
    network.failWith = undefined

    // Restart: real start() → startup replay (from disk) → startup recovery → pollJobs().
    worker = await bootWorker()
    await waitTaskStatus(task.id, 'done')
    expect(trailOf(task.id)).toEqual([
      ['task:<id>:initial-implement', 'success'],
      ['implement:<id>:review', 'success'],
      ['review:<id>:git-commit', 'success'],
    ])
    // Ordering: the restarted Worker's first API call was the replay of the pending event (before recovery /
    // claims), and recovery never forced the running Job to a terminal state.
    const restartCalls = network.calls.filter((call) => call.generation === worker!.generation)
    expect(restartCalls[0]).toMatchObject({ method: 'PATCH', path: `/api/jobs/${implementId}`, status: 200 })
    expect(JSON.parse(restartCalls[0]!.body!)).toMatchObject({ status: 'success', eventId: expect.any(String) })
    expect(network.calls.some((call) => call.path.endsWith('/fail-if-running'))).toBe(false)
    expect(network.calls.filter((call) => call.generation === firstGeneration && call.path === '/api/gate/check')).toHaveLength(1)
    expect(headFiles()).toEqual([`docs/lifecycle/${implementId.slice(0, 8)}.md`])
    expectNoUnexpectedCommands()
    await waitFor(() => !outboxStore.hasPending() && outboxRowsOnDisk().length === 0, () => 'Outbox drained')
  })
})

const HIGH_FILE = 'docs/project_memory/goal.md'
let rw4: { taskId: string; commitJobId: string; approvalId: string; completedAt: string | undefined } | undefined

describe.skipIf(!setup.gitAvailable)('real Worker E2E — HIGH approval', () => {
  it('RW4a: HIGH diff → the real Worker blocks git_commit → Job-linked approval WAITING → ADMIN approves over HTTP → requeued', async () => {
    const { env, project } = await boot([{ id: 'rw-goal', title: 'Update the project goal wording' }], [HIGH_FILE])
    behaviors.implement = () => ({ files: { [HIGH_FILE]: '# Goal\n\nRun the AI team from a phone.\n' } })
    const task = await env.adoptNext(project.id, 'rw-goal')
    await waitFor(
      () => commitJobOf(task.id)?.status === 'blocked',
      () => `git_commit blocked; jobs ${JSON.stringify(trailOf(task.id))}`,
    )
    const commitJob = commitJobOf(task.id)!
    const approvals = env.storage.approvalRequests.findByTaskId(task.id)
    expect(approvals.map((a) => [a.requestedAction, a.status, a.riskLevel])).toEqual([['git_commit', 'WAITING_FOR_USER', 'HIGH']])
    expect(commitJob.approvalId).toBe(approvals[0]!.id)
    expect(env.task(task.id).status).not.toBe('done')
    // Nothing was committed; the HIGH change is still in the worktree.
    expect(git(['status', '--porcelain']).trim()).toContain('goal.md')
    // The Worker's local resolvePolicy() maps HIGH BLOCKED to continue_safe_work_only, so it reports `blocked`
    // without its own "approval waiting" alert; the CEO learns of it through the API attention instead.
    expect(alerts.filter((alert) => alert.title.includes('承認待ち'))).toEqual([])
    expect((await env.systemState()).attention.map((item) => item.kind)).toEqual(['approval_waiting'])

    const approve = await api!.admin('PATCH', `/api/approval-requests/${approvals[0]!.id}/status`, { status: 'APPROVED' })
    expect(approve.status, JSON.stringify(approve.body)).toBe(200)
    expect(env.storage.approvalRequests.findById(approvals[0]!.id)?.status).toBe('APPROVED')
    rw4 = { taskId: task.id, commitJobId: commitJob.id, approvalId: approvals[0]!.id, completedAt: commitJob.completedAt }
    keepForNextTest = true
  })

  /**
   * (was DEFECT D2, fixed by D2 v4) after approval the Gate says ALLOW + call_consume; the Worker's resolvePolicy()
   * used to downgrade a local-HIGH `continue` to `continue_safe_work_only`, so runJob() returned `blocked` before
   * consuming. resolvePolicy() no longer downgrades ALLOW by local risk.
   */
  it('RW4b (was DEFECT D2): the real Worker re-runs the approved git_commit, consumes the approval, commits and the Task is done', async () => {
    if (!rw4 || !api) throw new Error('RW4a did not leave an approved git_commit')
    const env = api.env
    const { taskId, commitJobId, approvalId, completedAt } = rw4
    rw4 = undefined
    await waitFor(
      () => {
        const job = env.storage.jobs.findById(commitJobId)
        return job !== undefined && job.status !== 'queued' && job.status !== 'running' && job.completedAt !== completedAt
      },
      () => `approved git_commit re-run; now ${env.storage.jobs.findById(commitJobId)?.status}`,
    )
    const rerun = env.storage.jobs.findById(commitJobId)!
    console.log(`[RW4b] approved git_commit re-run: status=${rerun.status} approval=${env.storage.approvalRequests.findById(approvalId)?.status}`)
    expect(rerun.status).toBe('success')
    await waitTaskStatus(taskId, 'done', 30_000)
    expect(env.storage.approvalRequests.findById(approvalId)?.status).toBe('CONSUMED')
    expect(headFiles()).toEqual([HIGH_FILE])
  })
})

describe.skipIf(!setup.gitAvailable)('real Worker E2E — escalation cleanup and Human Resume', () => {
  it('RW5: repeated implement failures → repair budget exhausted → escalate → workspaceCleanupRequired → real cleanup → Human Resume completes', async () => {
    const { env, project } = await boot([{ id: 'rw-escalate', title: 'Escalation scenario' }])
    let attempt = 0
    let failing = true
    behaviors.implement = () => {
      attempt += 1
      return failing
        ? { files: { [`docs/lifecycle/attempt-${attempt}.md`]: `attempt ${attempt}\n` }, exitCode: 1 }
        : { files: { 'docs/lifecycle/resumed.md': 'resumed work\n' } }
    }
    const task = await env.adoptNext(project.id, 'rw-escalate')
    await waitTaskStatus(task.id, 'blocked', 150_000)
    // Let the Worker finish handling the escalating PATCH response (cleanup runs after the 2xx).
    await waitFor(() => !outboxStore.hasPending(), () => 'Outbox drained')
    await waitFor(
      () => alerts.some((a) => a.title.includes('Workspace cleanup')) || !existsSync(path.join(LIFECYCLE_TARGET_DIR, `docs/lifecycle/attempt-${attempt}.md`)),
      () => 'escalation cleanup observed',
      15_000,
    )
    const trail = trailOf(task.id)
    const implementTrail = trail.filter(([key]) => key!.startsWith('task:') || key!.startsWith('repair:'))
    expect(implementTrail.every(([, status]) => status === 'failed')).toBe(true)
    expect(implementTrail[0]).toEqual(['task:<id>:initial-implement', 'failed'])
    const lastAttempt = attempt
    // initial-implement + MAX_REPAIR_ATTEMPTS (3) repairs, then the 4th failure escalates.
    expect(lastAttempt).toBe(4)
    expect(env.storage.jobs.findByTaskId(task.id).filter((job) => job.aiCliMode === 'implement')).toHaveLength(4)
    // The escalating Job's own file was reverted by the real cleanupEscalatedWorkspace() → revertBlockedJobChanges().
    expect(existsSync(path.join(LIFECYCLE_TARGET_DIR, `docs/lifecycle/attempt-${lastAttempt}.md`))).toBe(false)
    expect(alerts.filter((a) => a.title === 'Workspace cleanup incomplete after escalation')).toEqual([])
    const dirtyAfterEscalation = git(['status', '--porcelain', '--untracked-files=all']).trim().split('\n').filter(Boolean)
    // Observed contract: cleanup reverts only the escalating Job's own manifest. Files written by earlier attempts
    // of the same repair chain were "pre-changed" for that Job, so they stay; the blocked Task remains the
    // workspace owner (fallback attribution) and Human Resume inherits them.
    expect(dirtyAfterEscalation).toEqual([1, 2, 3].map((n) => `?? docs/lifecycle/attempt-${n}.md`))

    // Human Resume (ADMIN over HTTP), then the real Worker continues.
    failing = false
    const resume = await api!.admin<Job & { code?: string; error?: string }>('POST', `/api/tasks/${task.id}/resume`, { instruction: 'Write the page without failing.' })
    expect(resume.status, JSON.stringify(resume.body)).toBe(201)
    expect(resume.body.workflowStepKey).toMatch(/^resume:/)
    await waitTaskStatus(task.id, 'done', 90_000)
    const committed = headFiles()
    // The resumed run's review saw (and the commit contains) the inherited files of the failed attempts.
    expect(committed).toEqual(['docs/lifecycle/attempt-1.md', 'docs/lifecycle/attempt-2.md', 'docs/lifecycle/attempt-3.md', 'docs/lifecycle/resumed.md'])
    expect(trailOf(task.id).slice(-3)).toEqual([
      ['resume:<id>:1', 'success'],
      ['implement:<id>:review', 'success'],
      ['review:<id>:git-commit', 'success'],
    ])
    expect(git(['status', '--porcelain', '--untracked-files=all']).trim()).toBe('')
    expectNoUnexpectedCommands()
  })
})
