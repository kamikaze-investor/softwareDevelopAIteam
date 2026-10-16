/**
 * Lifecycle E2E — Normal paths（N1 / N2）。
 *
 * 本物の route + SQLite + git worktree の上で、Worker simulation（`harness.ts`）と PL tick だけを
 * 外から回し、Roadmap 採用 → Design Review → implement → review → git_commit → done →
 * continuation → 次の採用、までを通しで確かめる。
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
  buildLedger,
  createRunningProject,
  git,
  removeTargetRepo,
  startLifecycle,
  type LifecycleEnv,
} from './harness'
import { designReviewCalls, resetDesignReviewStub } from './runnerStub'

// 本物の git を何度も呼ぶ（Windows では 1 回数十〜百 ms）ので、scenario 単位で長めに取る。
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

function auditOps(operation: string) {
  return env.storage.auditLog.findAll().filter((entry) => entry.operation === operation)
}

describe('N1: two roadmap Tasks in sequence on the LOW-risk Safety Evidence path', () => {
  it.each([
    {
      label: 'single docs file',
      allowedPaths: ['docs/lifecycle'],
      items: [{ id: 'docs-intro', title: 'Write the docs intro' }, { id: 'docs-usage', title: 'Write the usage page' }],
      files: (n: number) => ({ [`docs/lifecycle/page-${n}.md`]: `page ${n}\n` }),
    },
    {
      label: 'two docs files per Task',
      allowedPaths: ['docs/notes'],
      items: [{ id: 'notes-alpha', title: 'Alpha notes' }, { id: 'notes-beta', title: 'Beta notes' }],
      files: (n: number) => ({ [`docs/notes/${n}-a.md`]: 'a\n', [`docs/notes/${n}-b.md`]: 'b\n' }),
    },
  ])('$label', async ({ items, files, allowedPaths }) => {
    // Start: running Project, ledger with two planned items, no Tasks, clean worktree.
    env = await startLifecycle({ ledger: buildLedger(items) })
    const project = createRunningProject(env)
    env.adoptionAllowedPaths = allowedPaths
    let implementCount = 0
    env.worker.behaviors.implement = () => ({ kind: 'change', files: files(++implementCount) })

    for (const item of items) {
      // Operation 1: PL tick while the Project is idle → adoption of the next planned item.
      // Expected: Task created, Design Review ALIGNED, initial-implement Job queued.
      const task = await env.adoptNext(project.id, item.id)
      expect(env.jobsOf(task.id).map((job) => [job.workflowStepKey, job.status]))
        .toEqual([[`task:${task.id}:initial-implement`, 'queued']])

      // Operation 2: the Worker drains the queue.
      // Expected: implement → review(approved) → git_commit(ALLOW via Safety Evidence) → Task done.
      const steps = await env.worker.runUntilIdle()
      expect(steps.map((step) => [step.kind, step.reported])).toEqual([
        ['implement', 'success'],
        ['review', 'success'],
        ['git_commit', 'success'],
      ])
      expect(steps[2]!.gate).toMatchObject({ decision: 'ALLOW', policy: 'continue', nextAction: 'proceed' })

      expect(env.task(task.id).status).toBe('done')
      const jobs = env.jobsOf(task.id)
      expect(jobs.every((job) => job.status === 'success')).toBe(true)
      const commitJob = jobs.find((job) => job.safeCommand.kind === 'git_commit')!
      expect(commitJob.workflowStepKey).toMatch(/^review:.+:git-commit$/)
      expect(commitJob.commitHash).toBe(git(['rev-parse', 'HEAD']).trim())
      expect(commitJob.approvalId).toBeUndefined()
      expect(env.storage.approvalRequests.findByTaskId(task.id)).toHaveLength(0)
      // Safety Evidence verdict is audited, and the resulting commit is bound to the Gate ALLOW.
      expect(env.storage.auditLog.findByEntity('job', commitJob.id)
        .filter((entry) => entry.operation === 'git_commit_safety_evidence')
        .map((entry) => entry.result)).toEqual(['verified'])
      const [evaluation] = env.storage.gateEvaluations.findByJobId(commitJob.id)
      expect(evaluation).toMatchObject({ decision: 'ALLOW', bindingVerification: 'authoritative' })
      expect(evaluation?.resultingCommit).toBe(commitJob.commitHash)
      // Worker drained its Outbox (the continuation 503 was resent and deduplicated).
      expect(env.worker.hasPendingOutbox()).toBe(false)
      // Continuation recorded for the completed Task and not left pending.
      expect(env.storage.taskContinuations.findBySourceJobId(commitJob.id)?.status).toBe('completed')
      expect(git(['status', '--porcelain']).trim()).toBe('')

      // The Project is unoccupied again: no current Task and no attention.
      const state = await env.systemState()
      expect(state.attention, `attention after ${item.id}`).toEqual([])
      expect(state.projects.find((p) => p.id === project.id)?.currentTask).toBeUndefined()
    }

    // Final: both Tasks done, one commit per Task on top of the initial commit.
    const tasks = env.storage.tasks.findByProjectId(project.id)
    expect(tasks.map((task) => [task.roadmapTaskKey, task.status])).toEqual(
      expect.arrayContaining(items.map((item) => [item.id, 'done'])),
    )
    expect(tasks).toHaveLength(items.length)
    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe(String(items.length + 1))
    expect(auditOps('git_commit_safety_evidence').map((entry) => entry.result)).toEqual(['verified', 'verified'])
    // Every Design Review the stub answered was a task review that ALIGNED.
    expect(designReviewCalls().map((call) => [call.reviewKind, call.verdict])).toEqual(
      items.map(() => ['task', 'ALIGNED']),
    )
    expect(env.escalations).toEqual([])
  })
})

const HIGH_CASES = [
  { label: 'goal.md', file: 'docs/project_memory/goal.md' },
  { label: 'design_philosophy.md', file: 'docs/project_memory/design_philosophy.md' },
]

/**
 * N2 の前半: HIGH diff の Task を採用し、git_commit が人間承認で止まるところまで進めて ADMIN が承認する。
 * 途中の各状態はここで assert する（N2 の両テストで共有）。
 */
async function highRiskTaskApproved(file: string) {
  // Start: running Project, one planned item whose scope is a Decision Authority document (HIGH).
  env = await startLifecycle({ ledger: buildLedger([{ id: 'goal-update', title: 'Update the project goal wording' }]) })
  const project = createRunningProject(env)
  env.adoptionAllowedPaths = [file]
  env.worker.behaviors.implement = () => ({ kind: 'change', files: { [file]: '# Goal\n\nRun the AI team from a phone.\n' } })
  const task = await env.adoptNext(project.id, 'goal-update')

  // Operation 1: Worker drains. Expected: implement + review succeed (review's HIGH gate is safe-work),
  // git_commit gate fails Safety Evidence (HIGH) → BLOCKED, Job-linked approval WAITING, Job blocked.
  const steps = await env.worker.runUntilIdle()
  expect(steps.map((step) => [step.kind, step.reported])).toEqual([
    ['implement', 'success'],
    ['review', 'success'],
    ['git_commit', 'blocked'],
  ])
  expect(steps[1]!.gate).toMatchObject({ policy: 'continue_safe_work_only' })
  // API says block_until_approved (policy); the Worker's `resolvePolicy()` maps HIGH BLOCKED to safe-work-only,
  // and git_commit is not a safe-work command, so the Job is reported blocked either way.
  expect(steps[2]!.gate).toMatchObject({ decision: 'BLOCKED', policy: 'continue_safe_work_only' })
  const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
  expect(commitJob.status).toBe('blocked')
  // W3: the review's HIGH safe-work check created no request — only the Job-linked git_commit approval exists.
  const approvals = env.storage.approvalRequests.findByTaskId(task.id)
  expect(approvals.map((a) => [a.requestedAction, a.status, a.riskLevel])).toEqual([['git_commit', 'WAITING_FOR_USER', 'HIGH']])
  const approval = approvals[0]!
  expect(commitJob.approvalId).toBe(approval.id)
  expect(env.storage.auditLog.findByEntity('job', commitJob.id)
    .find((entry) => entry.operation === 'git_commit_safety_evidence')?.result).toBe('insufficient_safety_evidence')
  expect(env.task(task.id).status).not.toBe('done')
  const state = await env.systemState()
  expect(state.attention.map((item) => item.kind)).toEqual(['approval_waiting'])

  // Operation 2: PL ticks. Expected: approval_waiting is notify-only → exactly one CEO escalation.
  await env.plTick()
  await env.plTick()
  expect(env.escalations).toHaveLength(1)

  // Operation 3: CEO (ADMIN) approves. Expected: APPROVED, approval_actor=human recorded (W3),
  // the same Job requeued.
  const approve = await env.ceo.approve(approval.id)
  expect(approve.statusCode).toBe(200)
  expect(env.storage.approvalRequests.findById(approval.id)?.status).toBe('APPROVED')
  expect(env.storage.auditLog.findByEntity('approval_request', approval.id)
    .filter((entry) => entry.operation === 'approval_actor').map((entry) => entry.result)).toEqual(['human'])
  expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('queued')
  return { task, commitJob, approval }
}

describe('N2: HIGH-risk diff — git_commit needs a Job-linked human approval', () => {
  it.each(HIGH_CASES)('$label: blocked → approval WAITING → ADMIN approve (approval_actor human) → requeued', async ({ file }) => {
    await highRiskTaskApproved(file)
  })

  /**
   * DEFECT D2（HIGH git_commit は承認後も commit できない）。
   *
   * Expected: 承認後の再実行で Gate は ALLOW + call_consume を返し、Worker は consume して commit し、Task は done。
   * Actual:   Gate は ALLOW + call_consume / continuationPolicy=continue を返すが、Worker の
   *           `resolvePolicy()`（apps/worker/src/guards/gatePolicy.ts「ローカルリスクによる escalation」:
   *           `apiPolicy === 'continue'` かつ local finalRiskLevel HIGH → `continue_safe_work_only`）が
   *           それを safe-work-only へ格下げし、git_commit は SAFE_WORK_ALLOWED_COMMAND_KINDS に無いので
   *           consume 前に `blocked` を返す（jobRunner.ts の safe_work_only 判定は consume より前）。
   *           API 側は承認 APPROVED の Job への blocked を `jobs.update()`（storage/sqlite.ts
   *           「Approval承認とWorkerのblocked結果保存が競合した場合…現在値を返す」）で黙って捨てるので、
   *           Job は `running` のまま・承認は APPROVED のまま・Task は pending、attention は空、
   *           Mobile/API の resume（LATEST_JOB_NOT_BLOCKED）も recover（TASK_NOT_BLOCKED）も不可 —
   *           誰にも見えない行き止まりになる（実測: 本テストの途中状態）。
   * Worker の unit test は resolvePolicy を mock しているため、この合成は未検証だった。
   */
  for (const { label, file } of HIGH_CASES) {
    it.fails(`DEFECT D2 ${label}: after approval the Worker consumes, commits and the Task is done`, async () => {
      const { task, commitJob } = await highRiskTaskApproved(file)

      // Operation 4: Worker. Expected: gate ALLOW + call_consume → consume 200 → commit → Task done.
      const after = await env.worker.runUntilIdle()
      expect(after[0]!.gate).toMatchObject({ decision: 'ALLOW', nextAction: 'call_consume' })
      expect(after.map((step) => [step.kind, step.reported])).toEqual([['git_commit', 'success']])
      expect(after[0]!.consumeStatus).toBe(200)
      expect(env.task(task.id).status).toBe('done')
      const finalCommit = env.storage.jobs.findById(commitJob.id)!
      expect(finalCommit.status).toBe('success')
      expect(finalCommit.commitHash).toBe(git(['rev-parse', 'HEAD']).trim())
      expect(git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim()).toBe(file)
      expect(env.storage.approvalRequests.findByTaskId(task.id).map((a) => a.status)).toEqual(['CONSUMED'])
      expect((await env.systemState()).attention).toEqual([])
      expect(env.worker.hasPendingOutbox()).toBe(false)
    })
  }
})


describe('N2-low: LOW-risk diff routed to a human gate by review evidence', () => {
  it('approve → requeued git_commit run reports its result', async () => {
    // Start: running Project, LOW docs scope; the review approves but carries a high-severity finding,
    // so git_commit Safety Evidence fails (review_has_high_or_critical_finding) and a human approval is needed.
    env = await startLifecycle({ ledger: buildLedger([{ id: 'docs-low', title: 'Low risk docs' }]) })
    const project = createRunningProject(env)
    env.worker.behaviors.review = () => ({
      kind: 'verdict',
      result: { status: 'approved', summary: 'ok with a caveat', findings: [{ severity: 'high', message: 'double-check wording' }] },
    })
    const task = await env.adoptNext(project.id, 'docs-low')
    const steps = await env.worker.runUntilIdle()
    expect(steps.map((step) => [step.kind, step.reported])).toEqual([
      ['implement', 'success'], ['review', 'success'], ['git_commit', 'blocked'],
    ])
    const commitJob = env.jobsOf(task.id).find((job) => job.safeCommand.kind === 'git_commit')!
    const [approval] = env.storage.approvalRequests.findByTaskId(task.id)
    expect(approval).toMatchObject({ requestedAction: 'git_commit', status: 'WAITING_FOR_USER', riskLevel: 'LOW' })

    // Operation: ADMIN approves; Worker re-runs the same git_commit Job.
    expect((await env.ceo.approve(approval!.id)).statusCode).toBe(200)
    const after = await env.worker.runUntilIdle()

    // Expected: consume 200, commit, the success report is accepted (200/503), Task done.
    expect(after[0]).toMatchObject({ kind: 'git_commit', consumeStatus: 200, reported: 'success' })
    expect(after[0]!.reportError).toBeUndefined()
    expect([200, 503]).toContain(after[0]!.reportStatus)
    expect(env.storage.jobs.findById(commitJob.id)?.status).toBe('success')
    expect(env.task(task.id).status).toBe('done')
    expect(env.worker.hasPendingOutbox()).toBe(false)
  })
})
