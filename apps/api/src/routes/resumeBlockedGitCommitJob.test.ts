import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest, Job, Project, Task } from '@ai-team/shared'

/**
 * blocked な git_commit SafeCommand Job（STALE化した Approval に紐づくもの）を
 * `POST /api/tasks/:id/resume` から復旧できることを検証する。
 *
 * 対象: resumeBlockedTask() の git_commit 分岐（apps/api/src/storage/sqlite.ts）。
 * - 古い STALE Approval を APPROVED へ戻さない（再利用・再承認しない）
 * - 新しい Job は古い approvalId を引き継がない
 * - 新しい Job の /gate/check は現在の diff に対して新しい Approval を発行する
 * - 二重 resume で active な git_commit Job が重複しない（既存の dedup をそのまま利用）
 * - 新しい Approval が承認されれば、既存の consume → commit 経路にそのまま進める
 */

async function buildApp(): Promise<FastifyInstance> {
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
  app.register(taskRoutes, { prefix: '/api/tasks' })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return app
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp()
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
    name: 'Resume test project',
    goal: 'Verify blocked git_commit Job resume',
    designPhilosophy: [],
    status: 'running',
  })
}

async function createTask(projectId: string): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().tasks.create({
    projectId,
    title: 'Resume target task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
}

/**
 * blocked な git_commit Job と、それに紐づく STALE な Approval を用意する。
 * 本番で観測された状態（WAITING_FOR_USER → 別actorのworktree変更でdiffがズレる →
 * consume時にAPPROVED+diff不一致でSTALE化）を、consumeを経由せず直接再現する。
 */
async function createBlockedGitCommitJobWithStaleApproval(
  task: Task,
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
      workingDir: '/some/legacy/path',
      params: { commitMessage: 'Resume target task' },
    },
  })

  const created = storage.approvalRequests.createForJob(
    {
      taskId: task.id,
      targetBranch: 'master',
      targetCommit: 'old-commit-sha',
      targetDiffHash: 'old-diff-hash',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      invalidIf: [],
    },
    job.id,
  )
  if (!created.ok) {
    throw new Error(`failed to seed approval: ${created.reason}`)
  }

  // APPROVED + commit/diff不一致 → STALE への遷移は既存の consumeForJob 経路そのもの。
  // ここではPATCH /statusを経由せず、その最終状態だけを直接再現する。
  storage.approvalRequests.updateStatus(created.approvalRequest.id, 'APPROVED', undefined, true)
  const consumeAttempt = storage.approvalRequests.consumeForJob({
    id: created.approvalRequest.id,
    jobId: job.id,
    currentCommit: 'new-commit-sha-from-other-actor',
    currentDiffHash: 'new-diff-hash-from-other-actor',
  })
  if (consumeAttempt.ok) {
    throw new Error('test setup expected consume to fail with STALE')
  }

  const staleApproval = storage.approvalRequests.findById(created.approvalRequest.id)
  if (!staleApproval || staleApproval.status !== 'STALE') {
    throw new Error(`test setup did not produce a STALE approval, got: ${staleApproval?.status}`)
  }

  return { job, approval: staleApproval }
}

async function resumeTask(app: FastifyInstance, taskId: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/resume`,
    payload: { instruction: 'STALE approvalによりblockedとなったgit_commit Jobの復旧' },
  })
  return { statusCode: res.statusCode, body: parseBody(res.body) }
}

describe('POST /api/tasks/:id/resume — blocked git_commit Job (STALE approval)', () => {
  it('resumes a blocked git_commit Job without requiring AI CLI provider/mode', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { job: blockedJob } = await createBlockedGitCommitJobWithStaleApproval(task)

      const { statusCode, body } = await resumeTask(app, task.id)

      expect(statusCode).toBe(201)
      const resumedJob = body as Job
      expect(resumedJob.id).not.toBe(blockedJob.id)
      expect(resumedJob.status).toBe('queued')
      expect(resumedJob.safeCommand.kind).toBe('git_commit')
      // workingDirは既存のAI-CLI resume分岐と同じく正規TARGET_WORKING_DIRへ正規化される
      expect(resumedJob.safeCommand.workingDir).toBe('/workspace/target')
      expect(resumedJob.safeCommand.params).toEqual(blockedJob.safeCommand.params)
    })
  })

  it('does not carry the old (STALE) approvalId onto the new Job', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: staleApproval } = await createBlockedGitCommitJobWithStaleApproval(task)

      const { body } = await resumeTask(app, task.id)
      const resumedJob = body as Job

      expect(resumedJob.approvalId).toBeUndefined()
      expect(resumedJob.approvalId).not.toBe(staleApproval.id)
    })
  })

  it('leaves the old STALE approval untouched (not reused, not re-approved)', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: staleApproval } = await createBlockedGitCommitJobWithStaleApproval(task)

      await resumeTask(app, task.id)

      const { getStorage } = await import('../storage/index.js')
      const stillStale = getStorage().approvalRequests.findById(staleApproval.id)
      expect(stillStale?.status).toBe('STALE')
    })
  })

  it('the new Job obtains a fresh approval for the current diff via /gate/check (fail-closed BLOCKED, not reused)', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      const { approval: staleApproval } = await createBlockedGitCommitJobWithStaleApproval(task)

      const { body: resumeBody } = await resumeTask(app, task.id)
      const resumedJob = resumeBody as Job

      const gateRes = await app.inject({
        method: 'POST',
        url: '/api/gate/check',
        payload: {
          jobId: resumedJob.id,
          taskId: task.id,
          requestedAction: 'git_commit',
          targetBranch: 'master',
          targetCommit: 'current-commit-sha',
          targetDiffHash: 'current-diff-hash',
          changedFiles: ['test.js'],
        },
      })

      expect(gateRes.statusCode).toBe(200)
      const gateBody = parseBody<{
        outcome: { decision: string }
        sideEffects: Array<{ type: string; requestId: string }>
        approvalRequest?: ApprovalRequest
      }>(gateRes.body)

      expect(gateBody.outcome.decision).toBe('BLOCKED')
      expect(gateBody.sideEffects).toHaveLength(1)
      expect(gateBody.sideEffects[0].type).toBe('CREATED_APPROVAL_REQUEST')
      expect(gateBody.approvalRequest?.id).not.toBe(staleApproval.id)
      expect(gateBody.approvalRequest?.targetCommit).toBe('current-commit-sha')
      expect(gateBody.approvalRequest?.targetDiffHash).toBe('current-diff-hash')
      expect(gateBody.approvalRequest?.status).toBe('WAITING_FOR_USER')

      const { getStorage } = await import('../storage/index.js')
      const linkedJob = getStorage().jobs.findById(resumedJob.id)
      expect(linkedJob?.approvalId).toBe(gateBody.approvalRequest?.id)
    })
  })

  it('rejects a second resume while the resumed Job is still active (no duplicate git_commit Job)', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      await createBlockedGitCommitJobWithStaleApproval(task)

      const first = await resumeTask(app, task.id)
      const second = await resumeTask(app, task.id)

      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(400)

      const jobsRes = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
      const jobs = parseBody<Job[]>(jobsRes.body)
      expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1)
      expect(jobs.filter((j) => j.status === 'blocked')).toHaveLength(1)
    })
  })

  it('after the new approval is APPROVED, the normal consume → commit path still works', async () => {
    await withApp(async (app) => {
      const project = await createProject()
      const task = await createTask(project.id)
      await createBlockedGitCommitJobWithStaleApproval(task)

      const { body: resumeBody } = await resumeTask(app, task.id)
      const resumedJob = resumeBody as Job

      // 実際のWorkerはqueued Jobをdequeueした時点でrunningへ遷移させてから
      // git_commitのgate/checkを呼ぶ。ここでも同じ前提を再現する。
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${resumedJob.id}`,
        payload: { status: 'running' },
      })

      const gateRes = await app.inject({
        method: 'POST',
        url: '/api/gate/check',
        payload: {
          jobId: resumedJob.id,
          taskId: task.id,
          requestedAction: 'git_commit',
          targetBranch: 'master',
          targetCommit: 'current-commit-sha',
          targetDiffHash: 'current-diff-hash',
          changedFiles: ['test.js'],
        },
      })
      const newApprovalId = parseBody<{ approvalRequest: ApprovalRequest }>(gateRes.body).approvalRequest.id

      const approveRes = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${newApprovalId}/status`,
        payload: { status: 'APPROVED' },
      })
      expect(approveRes.statusCode).toBe(200)

      const consumeRes = await app.inject({
        method: 'POST',
        url: `/api/approval-requests/${newApprovalId}/consume`,
        payload: {
          jobId: resumedJob.id,
          currentCommit: 'current-commit-sha',
          currentDiffHash: 'current-diff-hash',
        },
      })

      expect(consumeRes.statusCode).toBe(200)
      const consumed = parseBody<ApprovalRequest & { consumed: boolean }>(consumeRes.body)
      expect(consumed.status).toBe('CONSUMED')
      expect(consumed.consumed).toBe(true)
    })
  })
})
