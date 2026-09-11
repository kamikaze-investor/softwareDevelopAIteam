import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, Job, Project, Task } from '@ai-team/shared'

/**
 * M2（`approval-resume-liveness-dependency`）の検証。
 *
 * 問い: CEO が blocked な git_commit Job を承認したあと、**client が
 * `POST /api/tasks/:id/resume` を叩かなくても**後続が進むか。
 *
 * これは Exit Criterion 5「Goal変更以外で開発が止まらない」に直結する。
 * さらに Worker の `findWorkspaceOwningTaskId()`（`apps/worker/src/index.ts`）は
 * `blocked` Job を workspace の所有者として扱い、`fetchQueuedJob()` は所有者がいる間
 * **ほかの全 Task の queued Job を skip する**。したがって blocked のまま残ると
 * 当該 Task だけでなく Worker 全体が止まる。
 *
 * 本ファイルは「承認だけで queued へ戻り、blocked Job が残らない」ことを
 * 実route経由で固定する回帰テストである。
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

/**
 * production と同じ形の「承認待ちで blocked になった git_commit Job」を用意する。
 * Gate が `block_until_approved` を返し、Worker が `status:'blocked'` を返した直後の状態。
 */
async function seedBlockedGitCommitJob(): Promise<{
  task: Task
  job: Job
  approval: ApprovalRequest
}> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()

  const project: Project = storage.projects.create({
    name: 'M2 liveness project',
    goal: 'Verify approval alone resumes the blocked git_commit Job',
    designPhilosophy: [],
    status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'M2 target task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })

  const job = storage.jobs.create({
    taskId: task.id,
    projectId: project.id,
    agentRole: 'developer_ai',
    status: 'running',
    safeCommand: {
      kind: 'git_commit',
      workingDir: '/workspace/target',
      params: { commitMessage: 'M2 target task' },
    },
  })

  const created = storage.approvalRequests.createForJob(
    {
      taskId: task.id,
      targetBranch: 'master',
      targetCommit: 'commit-sha',
      targetDiffHash: 'diff-hash',
      riskLevel: 'LOW',
      requestedAction: 'git_commit',
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      invalidIf: [],
    },
    job.id,
  )
  if (!created.ok) throw new Error(`failed to seed approval: ${created.reason}`)

  // Worker が Gate の block_until_approved を受けて blocked を書き戻した状態。
  storage.jobs.update(job.id, { status: 'blocked', completedAt: new Date().toISOString() })

  const blocked = storage.jobs.findById(job.id)
  if (!blocked || blocked.status !== 'blocked') {
    throw new Error(`test setup did not produce a blocked Job, got: ${blocked?.status}`)
  }
  if (blocked.approvalId !== created.approvalRequest.id) {
    throw new Error('test setup did not link the Job to the approval request')
  }

  return { task, job: blocked, approval: created.approvalRequest }
}

async function approve(
  app: FastifyInstance,
  approvalId: string,
): Promise<{ statusCode: number; body: ApprovalRequest }> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/approval-requests/${approvalId}/status`,
    payload: { status: 'APPROVED' },
  })
  return { statusCode: res.statusCode, body: parseBody<ApprovalRequest>(res.body) }
}

describe('M2: 承認だけで blocked git_commit Job が再開する（client resume 不要）', () => {
  it('APPROVED にしただけで Job が queued へ戻る', async () => {
    await withApp(async (app) => {
      const { job, approval } = await seedBlockedGitCommitJob()

      const approved = await approve(app, approval.id)
      expect(approved.statusCode).toBe(200)
      expect(approved.body.status).toBe('APPROVED')

      const { getStorage } = await import('../storage/index.js')
      const resumed = getStorage().jobs.findById(job.id)

      // client は /api/tasks/:id/resume を一度も呼んでいない。
      expect(resumed?.status).toBe('queued')
    })
  })

  it('再開は同一 Job 行で行われ、approvalId の紐づきを保つ（consume が成立する前提）', async () => {
    await withApp(async (app) => {
      const { task, job, approval } = await seedBlockedGitCommitJob()

      await approve(app, approval.id)

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const jobs = storage.jobs.findByTaskId(task.id)

      // 新しい Job 行を作らない（= duplicate Job にならない）。
      expect(jobs).toHaveLength(1)
      expect(jobs[0].id).toBe(job.id)
      expect(jobs[0].approvalId).toBe(approval.id)
    })
  })

  it('前回実行の結果は再開時にクリアされ、古い結果が残らない', async () => {
    await withApp(async (app) => {
      const { job, approval } = await seedBlockedGitCommitJob()

      const { getStorage } = await import('../storage/index.js')
      getStorage().jobs.update(job.id, {
        stderr: 'block_until_approved: CEO承認が必要です',
        exitCode: 1,
      })

      await approve(app, approval.id)

      const resumed = getStorage().jobs.findById(job.id)
      expect(resumed?.status).toBe('queued')
      expect(resumed?.stderr ?? null).toBeNull()
      expect(resumed?.exitCode ?? null).toBeNull()
      expect(resumed?.completedAt ?? null).toBeNull()
    })
  })

  // Worker の workspace 所有権は `blocked` Job の存在で決まる。承認後に blocked が
  // 残っていると、その Task が workspace を握り続け Worker 全体が止まる。
  it('承認後に blocked Job が残らない（workspace ownership が解放される）', async () => {
    await withApp(async (app) => {
      const { task, approval } = await seedBlockedGitCommitJob()

      await approve(app, approval.id)

      const { getStorage } = await import('../storage/index.js')
      const blockedJobs = getStorage().jobs.findByTaskId(task.id).filter((j) => j.status === 'blocked')
      expect(blockedJobs).toHaveLength(0)
    })
  })

  it('Worker が claim に使う GET /api/jobs?taskId= から queued として見える', async () => {
    await withApp(async (app) => {
      const { task, job, approval } = await seedBlockedGitCommitJob()

      await approve(app, approval.id)

      const res = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })
      expect(res.statusCode).toBe(200)
      const visible = parseBody<Job[]>(res.body)
      expect(visible.find((j) => j.id === job.id)?.status).toBe('queued')
    })
  })

  it('二重承認は 409 で拒否され、Job を二重に再開しない', async () => {
    await withApp(async (app) => {
      const { task, approval } = await seedBlockedGitCommitJob()

      const first = await approve(app, approval.id)
      expect(first.statusCode).toBe(200)

      const second = await approve(app, approval.id)
      expect(second.statusCode).toBe(409)

      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
    })
  })

  // Approval Gate 自体は緩めない。承認していないものが進んではならない。
  it('REJECTED では Job は queued へ戻らない', async () => {
    await withApp(async (app) => {
      const { job, approval } = await seedBlockedGitCommitJob()

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/approval-requests/${approval.id}/status`,
        payload: { status: 'REJECTED' },
      })
      expect(res.statusCode).toBe(200)

      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findById(job.id)?.status).toBe('blocked')
    })
  })

  it('承認しないまま放置しても Job は blocked のまま（自動では進まない）', async () => {
    await withApp(async () => {
      const { job } = await seedBlockedGitCommitJob()

      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findById(job.id)?.status).toBe('blocked')
    })
  })
})
