import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, Job, Project, Task } from '@ai-team/shared'

/**
 * 期限切れの `WAITING_FOR_USER` Approval が blocked git_commit Job の resume を
 * 永久に塞ぐ問題（2026-09-12 Production 実測）に対する回帰テスト。
 *
 * 背景: `expiresAt` は参照時の遅延判定で、期限切れ行を掃除する actor は存在しない。
 * そのため期限切れ `WAITING_FOR_USER` では次の3つが同時に成立し、Task がどこからも
 * 復旧できなくなっていた。
 *   1. `GET /api/approval-requests/waiting` は期限切れを除外する（Mobile に出ない）
 *   2. `approveAndResumeJob()` は期限切れを `EXPIRED` として拒否する（正しい fail-closed）
 *   3. `resumeBlockedTask()` は status だけを見て「承認待ち」として resume を拒否する
 *
 * 修正は 3 のみ: 「有効な承認待ち」を**未期限の `WAITING_FOR_USER`** に限定する。
 * expired approval を自動承認せず、Approval Gate も迂回せず、古い行も削除しない。
 */

/** `taskRoutes` の options（Design Review deps の差し替えに使う）。 */
type TaskRouteOptions = Parameters<typeof import('./tasks.js').taskRoutes>[1]

async function buildApp(taskRouteOptions?: TaskRouteOptions): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ approvalGateRoutes }, { taskRoutes }, { jobRoutes }, { resetStorage }] = await Promise.all([
    import('./approvalGate.js'),
    import('./tasks.js'),
    import('./jobs.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(approvalGateRoutes, { prefix: '/api' })
  app.register(taskRoutes, { ...(taskRouteOptions ?? {}), prefix: '/api/tasks' })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return app
}

async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  taskRouteOptions?: TaskRouteOptions,
): Promise<void> {
  const app = await buildApp(taskRouteOptions)
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

function parseBody<T>(body: string): T {
  return JSON.parse(body) as T
}

async function createProject(): Promise<Project> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().projects.create({
    name: 'Expired approval resume test',
    goal: 'Verify resume is not blocked by an expired approval',
    designPhilosophy: [],
    status: 'running',
  })
}

async function createTask(projectId: string): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().tasks.create({
    projectId,
    title: 'Expired approval target task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
}

const HOUR = 60 * 60 * 1000

/**
 * blocked な git_commit Job と、それに紐づく `WAITING_FOR_USER` Approval を用意する。
 * `expiresInMs` が負なら「24h 放置されて期限切れになった」行（Production 実測の状態）になる。
 *
 * route (`POST /api/gate/check`) は `computeExpiresAt()` でサーバー計算するため過去日時を
 * 作れない。ここは storage の `createForJob` を直接呼び、`expiresAt` を与えて再現する。
 */
async function createBlockedGitCommitJobWithWaitingApproval(
  task: Task,
  expiresInMs: number,
): Promise<{ job: Job; approval: ApprovalRequest }> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()

  const job = storage.jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status: 'blocked',
    safeCommand: {
      kind: 'git_commit',
      workingDir: '/workspace/target',
      params: { commitMessage: 'Expired approval target task' },
    },
  })

  const created = storage.approvalRequests.createForJob(
    {
      taskId: task.id,
      targetBranch: 'master',
      targetCommit: 'commit-at-request-time',
      targetDiffHash: 'diff-at-request-time',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      invalidIf: [],
    },
    job.id,
  )
  if (!created.ok) {
    throw new Error(`failed to seed approval: ${created.reason}`)
  }

  const approval = storage.approvalRequests.findById(created.approvalRequest.id)
  if (!approval || approval.status !== 'WAITING_FOR_USER') {
    throw new Error(`test setup did not produce a WAITING_FOR_USER approval, got: ${approval?.status}`)
  }

  return { job, approval }
}

/**
 * 非 git_commit（AI CLI）の blocked Job と、それに紐づく `WAITING_FOR_USER` Approval を用意する。
 *
 * 非 git_commit の Approval Request は `POST /api/approval-requests` から作られる
 * （`requestedAction: 'git_commit'` はそこでは拒否され、`/gate/check` 専用）。
 * こちらも `expiresAt` はサーバー計算なので、期限切れ行は storage を直接使って再現する。
 */
async function createBlockedAiCliJobWithWaitingApproval(
  task: Task,
  expiresInMs: number,
  aiCliMode: 'implement' | 'review' = 'review',
): Promise<{ job: Job; approval: ApprovalRequest }> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()

  const job = storage.jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status: 'blocked',
    safeCommand: { kind: 'test', workingDir: '/workspace/target', params: {} },
    aiCliProvider: 'claude_code',
    aiCliMode,
    aiCliPrompt: 'original prompt',
  })

  const approval = storage.approvalRequests.create({
    taskId: task.id,
    targetBranch: 'master',
    targetCommit: 'commit-at-request-time',
    targetDiffHash: 'diff-at-request-time',
    riskLevel: 'HIGH',
    requestedAction: 'test',
    status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    invalidIf: [],
  })

  return { job, approval }
}

async function resumeTask(app: FastifyInstance, taskId: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/resume`,
    payload: { instruction: '期限切れ承認により blocked のままの git_commit Job を復旧する' },
  })
  return { statusCode: res.statusCode, body: parseBody(res.body) }
}

/** 実Workerと同じ順序（queued を claim して running にしてから gate/check）を再現する。 */
async function claimAndGateCheck(
  app: FastifyInstance,
  jobId: string,
  taskId: string,
): Promise<{
  outcome: { decision: string }
  sideEffects: Array<{ type: string; requestId: string }>
  approvalRequest?: ApprovalRequest
}> {
  await app.inject({ method: 'PATCH', url: `/api/jobs/${jobId}`, payload: { status: 'running' } })

  const res = await app.inject({
    method: 'POST',
    url: '/api/gate/check',
    payload: {
      jobId,
      taskId,
      requestedAction: 'git_commit',
      targetBranch: 'master',
      targetCommit: 'current-commit-sha',
      targetDiffHash: 'current-diff-hash',
      changedFiles: ['test.js'],
    },
  })
  expect(res.statusCode).toBe(200)
  return parseBody(res.body)
}

describe('POST /api/tasks/:id/resume — expired WAITING_FOR_USER approval', () => {
  it('1. still refuses to resume while a NON-expired approval is waiting', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      await createBlockedGitCommitJobWithWaitingApproval(task, 30 * 60 * 1000)

      const { statusCode, body } = await resumeTask(app, task.id)

      expect(statusCode).toBe(400)
      expect((body as { error?: string }).error).toContain('waiting for user review')

      // Job は blocked のまま。新しい Job は作られない。
      const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
      const jobs = parseBody<Job[]>(jobsRes.body)
      expect(jobs).toHaveLength(1)
      expect(jobs[0].status).toBe('blocked')
    })
  })

  it('2. resumes when the waiting approval has expired', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { job: blockedJob } = await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      const { statusCode, body } = await resumeTask(app, task.id)

      expect(statusCode).toBe(201)
      const resumedJob = body as Job
      expect(resumedJob.id).not.toBe(blockedJob.id)
      expect(resumedJob.status).toBe('queued')
      expect(resumedJob.safeCommand.kind).toBe('git_commit')
      // 古い approval を引き継がない（再利用・再承認しない）。
      expect(resumedJob.approvalId).toBeUndefined()
    })
  })

  it('3. the resumed Job reaches the Gate again and a NEW approval request is created', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: expired } = await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      const { body } = await resumeTask(app, task.id)
      const resumedJob = body as Job

      const gate = await claimAndGateCheck(app, resumedJob.id, task.id)

      expect(gate.outcome.decision).toBe('BLOCKED')
      expect(gate.sideEffects).toHaveLength(1)
      expect(gate.sideEffects[0].type).toBe('CREATED_APPROVAL_REQUEST')
      expect(gate.approvalRequest?.id).not.toBe(expired.id)
      expect(gate.approvalRequest?.status).toBe('WAITING_FOR_USER')
      expect(gate.approvalRequest?.targetCommit).toBe('current-commit-sha')

      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findById(resumedJob.id)?.approvalId).toBe(gate.approvalRequest?.id)
    })
  })

  it('4. does not commit until the CEO approves the new request', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      const { body } = await resumeTask(app, task.id)
      const resumedJob = body as Job
      const gate = await claimAndGateCheck(app, resumedJob.id, task.id)
      const newApprovalId = gate.approvalRequest!.id

      // 承認前の consume は拒否される（= commit へ進めない）。
      const beforeApproval = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${newApprovalId}/consume`,
        payload: {
          jobId: resumedJob.id,
          currentCommit: 'current-commit-sha',
          currentDiffHash: 'current-diff-hash',
        },
      })
      expect(beforeApproval.statusCode).toBe(409)

      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().approvalRequests.findById(newApprovalId)?.status).toBe('WAITING_FOR_USER')

      // CEO が承認して初めて consume できる。
      const approveRes = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${newApprovalId}/status`,
        payload: { status: 'APPROVED' },
      })
      expect(approveRes.statusCode).toBe(200)

      const afterApproval = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${newApprovalId}/consume`,
        payload: {
          jobId: resumedJob.id,
          currentCommit: 'current-commit-sha',
          currentDiffHash: 'current-diff-hash',
        },
      })
      expect(afterApproval.statusCode).toBe(200)
      expect(parseBody<ApprovalRequest>(afterApproval.body).status).toBe('CONSUMED')
    })
  })

  it('5. the old expired approval is left untouched and does not interfere with the new one', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: expired } = await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      const { body } = await resumeTask(app, task.id)
      const resumedJob = body as Job
      const gate = await claimAndGateCheck(app, resumedJob.id, task.id)
      const newApprovalId = gate.approvalRequest!.id

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()

      // 古い行は自動承認も force delete もされない。
      const still = storage.approvalRequests.findById(expired.id)
      expect(still).toBeDefined()
      expect(still?.status).toBe('WAITING_FOR_USER')
      expect(still?.id).not.toBe(newApprovalId)

      // 新しい承認は古い行に妨げられず APPROVED まで進む。
      const approveRes = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${newApprovalId}/status`,
        payload: { status: 'APPROVED' },
      })
      expect(approveRes.statusCode).toBe(200)
      expect(storage.approvalRequests.findById(newApprovalId)?.status).toBe('APPROVED')

      // 期限切れの古い行は承認できない（EXPIRED として fail-closed）。自動承認されていない証拠。
      const approveOld = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${expired.id}/status`,
        payload: { status: 'APPROVED' },
      })
      expect(approveOld.statusCode).toBe(409)
      expect(storage.approvalRequests.findById(expired.id)?.status).toBe('EXPIRED')
    })
  })

  it('6. a duplicate resume creates no duplicate Job and no duplicate approval', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      const first = await resumeTask(app, task.id)
      const second = await resumeTask(app, task.id)

      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(400)

      const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
      const jobs = parseBody<Job[]>(jobsRes.body)
      expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1)
      expect(jobs.filter((j) => j.status === 'blocked')).toHaveLength(1)

      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().approvalRequests.findByTaskId(task.id)).toHaveLength(1)
    })
  })

  it('7a. an APPROVED (non-expired) approval still allows resume exactly as before', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval } = await createBlockedGitCommitJobWithWaitingApproval(task, 30 * 60 * 1000)

      const { getStorage } = await import('../storage/index.js')
      getStorage().approvalRequests.updateStatus(approval.id, 'APPROVED', undefined, true)

      const { statusCode } = await resumeTask(app, task.id)
      expect(statusCode).toBe(201)
    })
  })

  it('7b. a REJECTED approval still allows resume exactly as before', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval } = await createBlockedGitCommitJobWithWaitingApproval(task, 30 * 60 * 1000)

      const { getStorage } = await import('../storage/index.js')
      getStorage().approvalRequests.updateStatus(approval.id, 'REJECTED', undefined, true)

      const { statusCode } = await resumeTask(app, task.id)
      expect(statusCode).toBe(201)
    })
  })

  it('7c. an expired APPROVED approval is unaffected by this change (resume already allowed)', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval } = await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      const { getStorage } = await import('../storage/index.js')
      getStorage().approvalRequests.updateStatus(approval.id, 'APPROVED', undefined, true)

      const { statusCode } = await resumeTask(app, task.id)
      expect(statusCode).toBe(201)
    })
  })

  it('8. Mobile path: the expired approval is invisible, and after resume a new one becomes visible', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: expired } = await createBlockedGitCommitJobWithWaitingApproval(task, -1 * HOUR)

      // Mobile の承認画面 (`apps/mobile/lib/approvalsCache.ts`) が叩くのがこのルート。
      const waitingBefore = await app.inject({ method: 'GET', url: '/api/approval-requests/waiting' })
      expect(waitingBefore.statusCode).toBe(200)
      expect(parseBody<ApprovalRequest[]>(waitingBefore.body)).toHaveLength(0)

      // Mobile Task 詳細の「追加指示して再開」。
      const { statusCode, body } = await resumeTask(app, task.id)
      expect(statusCode).toBe(201)
      const resumedJob = body as Job

      const gate = await claimAndGateCheck(app, resumedJob.id, task.id)

      const waitingAfter = await app.inject({ method: 'GET', url: '/api/approval-requests/waiting' })
      const waiting = parseBody<ApprovalRequest[]>(waitingAfter.body)
      expect(waiting).toHaveLength(1)
      expect(waiting[0].id).toBe(gate.approvalRequest?.id)
      expect(waiting[0].id).not.toBe(expired.id)
      expect(waiting[0].status).toBe('WAITING_FOR_USER')
    })
  })
  /**
   * 独立レビュー指摘（CLAIM 5）: この条件は git_commit 分岐より**手前**にあるため、
   * 非 git_commit（AI CLI）の resume にも効く。これは意図した挙動である —— 罠は
   * `requestedAction` ではなく「期限切れ行を EXPIRED へ進める actor が居ない」ことに
   * 由来しており、非 git_commit でも同じく復旧不能になるため。
   * 迂回が起きていないこと（Gate・Design Review evidence が依然として効くこと）を固定する。
   */
  it('9. non-git_commit path: an expired waiting approval likewise stops blocking resume', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: expired } = await createBlockedAiCliJobWithWaitingApproval(task, -1 * HOUR)

      const { statusCode, body } = await resumeTask(app, task.id)

      expect(statusCode).toBe(201)
      const resumedJob = body as Job
      expect(resumedJob.status).toBe('queued')
      expect(resumedJob.aiCliMode).toBe('review')
      expect(resumedJob.approvalId).toBeUndefined()

      // 古い行は自動承認も削除もされない。
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().approvalRequests.findById(expired.id)?.status).toBe('WAITING_FOR_USER')
    })
  })

  it('10. non-git_commit path: a NON-expired waiting approval still blocks resume', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      await createBlockedAiCliJobWithWaitingApproval(task, 30 * 60 * 1000)

      const { statusCode, body } = await resumeTask(app, task.id)

      expect(statusCode).toBe(400)
      expect((body as { error?: string }).error).toContain('waiting for user review')
    })
  })

  it('11. non-git_commit path: an expired approval does NOT bypass the Design Review gate', async () => {
    // Design Review runner は外部プロセスなので必ず差し替える（テストを環境依存にしない）。
    // CONFLICT を返させ、evidence が登録されない = 門が閉じたままであることを決定的に再現する。
    const execute = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }],
        integrationReviewResult: { decision: 'CONFLICT' },
      }),
      timedOut: false,
    }))

    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      // implement モードは Design Review evidence を要求する。evidence は用意しない。
      await createBlockedAiCliJobWithWaitingApproval(task, -1 * HOUR, 'implement')

      const { statusCode, body } = await resumeTask(app, task.id)

      // 承認待ちの門は通っても、Design Review の門で fail-closed のまま止まる。
      // route は resume 指示文を再レビューし、evidence が登録できなければ 409 を返す。
      expect(statusCode).toBe(409)
      expect((body as { error?: string }).error).toContain('Design Review')
      expect(execute).toHaveBeenCalledTimes(1)

      const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
      expect(parseBody<Job[]>(jobsRes.body).filter((j) => j.status === 'queued')).toHaveLength(0)
    }, {
      resumeDesignReviewDeps: {
        runnerCommand: 'mock',
        runnerArgs: [],
        homeDirectory: '/tmp',
        workingDir: '/tmp',
        execute,
      },
    })
  })
})
