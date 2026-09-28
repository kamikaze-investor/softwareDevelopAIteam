import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalizeJobUpdate, type Job, type Task } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildResumeAiCliPrompt } from './tasks'

/**
 * **D4: approved になった Human Resume review を、通常の review と同じ git_commit successor へ繋ぐ。**
 *
 * 2026-09-28 監査: `routes/jobs.ts` の `isAutomaticReviewJob` は `implement:<id>:review` の形しか見ず、
 * Human Resume で再実行された review（`resume:<review>:1`）が approved でも git_commit を作らなかった。
 * Task は blocked のまま latest Job = success になり、resume も recover もできない行き止まりになる。
 *
 * 1 責務として同時に固定するもの:
 *   - approved な resumed review は `review:<今回の review>:git-commit` を作る（lineage で実装へ辿れるときだけ）
 *   - その git_commit が CEO に REJECT されたら、`resumeBlockedTask()` の provenance が
 *     git_commit → 今回の review → review lineage → 元の implement を**同じ walker** で復元する
 *   - git_commit 側の resume 正規化は従来どおり 1 ホップだけ
 */

const DOC = 'docs/project_memory/decisions/vps-operations.md'
const INSTRUCTION = '却下理由に沿って直す'
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
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
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

async function storage() {
  return (await import('../storage/index.js')).getStorage()
}

interface Chain {
  task: Task
  implementJob: Job
  firstReview: Job
  base: Record<string, unknown>
}

/** I（implement・success）→ R0 implement:I:review。`firstReviewDone` なら R0 は changes_requested で failed。 */
async function chain(firstReviewDone = true, existingProjectId?: string): Promise<Chain> {
  const s = await storage()
  const projectId = existingProjectId
    ?? s.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' }).id
  const project = { id: projectId }
  const task = s.tasks.create({
    projectId: project.id, title: 'VPS docs', description: 'd', status: 'blocked',
    assignee: 'developer_ai', dependencies: [], allowedPaths: [DOC], roadmapActive: true,
  } as never)
  const base = { taskId: task.id, projectId: project.id, agentRole: 'developer_ai' }
  const implementJob = s.jobs.create({
    ...base, status: 'success',
    safeCommand: { kind: 'test', workingDir: '/workspace/target', params: {} },
    aiCliProvider: 'claude_code', aiCliMode: 'implement', aiCliPrompt: 'original implementation prompt',
    workflowStepKey: `task:${task.id}:initial-implement`,
  } as never)
  await tick()
  const firstReview = s.jobs.create({
    ...base, agentRole: 'qa_ai', status: firstReviewDone ? 'failed' : 'running',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code', aiCliMode: 'review', aiCliPrompt: 'p',
    workflowStepKey: `implement:${implementJob.id}:review`,
  } as never)
  if (firstReviewDone) {
    s.reviewResults.create({
      taskId: task.id, jobId: firstReview.id, reviewer: 'qa_ai', status: 'changes_requested',
      summary: 'first review', findings: [{ severity: 'medium', file: DOC, message: 'first finding' }],
    } as never)
  }
  await tick()
  return { task, implementJob, firstReview, base }
}

/** `resume:<source>:1` の review Job（Human Resume が作る形）を running で作る。 */
async function resumedReview(c: Chain, source: Job, overrides: Record<string, unknown> = {}): Promise<Job> {
  const s = await storage()
  const job = s.jobs.create({
    ...c.base, agentRole: 'qa_ai', status: 'running',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code', aiCliMode: 'review', aiCliPrompt: 'p',
    workflowStepKey: `resume:${source.id}:1`,
    ...overrides,
  } as never)
  await tick()
  return job
}

const approved = {
  status: 'success',
  exitCode: 0,
  changedFiles: [DOC],
  guardResult: { permissionAllowed: true, fileChangeAllowed: true },
  reviewResult: { status: 'approved', summary: 'looks right', findings: [] },
}

function withOutbox<T extends Record<string, unknown>>(payload: T, eventId: string): T & { eventId: string; payloadHash: string } {
  return { ...payload, eventId, payloadHash: createHash('sha256').update(canonicalizeJobUpdate(payload)).digest('hex') }
}

async function gitCommitsOf(taskId: string): Promise<Job[]> {
  return (await storage()).jobs.findByTaskId(taskId).filter((job) => job.safeCommand.kind === 'git_commit')
}

async function approve(app: FastifyInstance, review: Job, payload: Record<string, unknown> = approved) {
  const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${review.id}`, payload })
  expect(res.statusCode).toBe(200)
}

/** CEO がその git_commit を REJECT した状態を作る（Gate が作る linked Approval を REJECTED にする）。 */
async function rejectCommit(task: Task, commit: Job): Promise<void> {
  const s = await storage()
  s.jobs.update(commit.id, { status: 'blocked' } as never)
  const created = s.approvalRequests.createForJob({
    taskId: task.id, targetBranch: 'master', targetCommit: 'c', targetDiffHash: 'd', riskLevel: 'LOW',
    requestedAction: 'git_commit', status: 'WAITING_FOR_USER',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), invalidIf: [],
  }, commit.id)
  if (!created.ok) throw new Error(created.reason)
  s.approvalRequests.updateStatus(created.approvalRequest.id, 'REJECTED', undefined, true)
  // 修正指示の pre-implementation Design Review は成立済みとする（gate 自体は迂回しない）。
  s.designReviewEvidence.create({
    taskId: task.id,
    designTextHash: computeDesignTextHash(buildResumeAiCliPrompt(task, INSTRUCTION)),
    reviewLoad: 'medium', decision: 'ALIGNED', independentReviewRequired: false,
  })
  await tick()
}

async function resume(app: FastifyInstance, taskId: string) {
  const res = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume`, payload: { instruction: INSTRUCTION } })
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Job & { code?: string } }
}

describe('D4: approved な review の git_commit successor', () => {
  it('通常の implement:<id>:review が approved なら従来どおり git_commit を作る（regression）', async () => {
    await withApp(async (app) => {
      const c = await chain(false)

      await approve(app, c.firstReview)

      const commits = await gitCommitsOf(c.task.id)
      expect(commits.map((job) => job.workflowStepKey)).toEqual([`review:${c.firstReview.id}:git-commit`])
    })
  })

  it('1 段の resumed review が approved なら、今回の review の id で git_commit を作る', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const r1 = await resumedReview(c, c.firstReview)

      await approve(app, r1)

      const commits = await gitCommitsOf(c.task.id)
      expect(commits).toHaveLength(1)
      expect(commits[0]!.workflowStepKey).toBe(`review:${r1.id}:git-commit`)
      expect(commits[0]!.status).toBe('queued')
      expect((await storage()).jobs.findById(r1.id)?.status).toBe('success')
    })
  })

  it('多段（resume:R1:1 → resume:R0:1 → implement:I:review）でも git_commit を作る', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const s = await storage()
      const r1 = await resumedReview(c, c.firstReview)
      s.jobs.update(r1.id, { status: 'failed' } as never)
      const r2 = await resumedReview(c, r1)

      await approve(app, r2)

      expect((await gitCommitsOf(c.task.id)).map((job) => job.workflowStepKey)).toEqual([`review:${r2.id}:git-commit`])
    })
  })

  describe('lineage で実装へ辿れない resumed review は git_commit を作らない（fail-closed）', () => {
    it('resume の元 Job が存在しない', async () => {
      await withApp(async (app) => {
        const c = await chain()
        const orphan = await resumedReview(c, c.firstReview, { workflowStepKey: 'resume:missing-job:1' })

        await approve(app, orphan)

        expect(await gitCommitsOf(c.task.id)).toHaveLength(0)
      })
    })

    it('resume の元が別 Task の review', async () => {
      await withApp(async (app) => {
        const c = await chain()
        const other = await chain(true, c.task.projectId)
        const crossTask = await resumedReview(c, other.firstReview)

        await approve(app, crossTask)

        expect(await gitCommitsOf(c.task.id)).toHaveLength(0)
      })
    })

    it('resume の元が同じ Task だが別 Project の行', async () => {
      await withApp(async (app) => {
        const c = await chain()
        const s = await storage()
        const otherProject = s.projects.create({ name: 'other', goal: 'g', designPhilosophy: [], status: 'paused' })
        const foreign = s.jobs.create({
          ...c.base, projectId: otherProject.id, agentRole: 'qa_ai', status: 'failed',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
          aiCliProvider: 'claude_code', aiCliMode: 'review', aiCliPrompt: 'p',
          // Project 以外は正しい段（R0 を名指す review）。Project の一致検査だけがこれを落とす。
          workflowStepKey: `resume:${c.firstReview.id}:1`,
        } as never)
        await tick()
        const crossProject = await resumedReview(c, foreign)

        await approve(app, crossProject)

        expect(await gitCommitsOf(c.task.id)).toHaveLength(0)
      })
    })

    it('resume の段が review ではない（implement を再実行した形の review）', async () => {
      await withApp(async (app) => {
        const c = await chain()
        const s = await storage()
        // 段の key は正しく R0 を名指すが、実体は implement Job。review 以外の段を跨がないことだけがこれを落とす。
        const implementHop = s.jobs.create({
          ...c.base, status: 'failed',
          safeCommand: { kind: 'test', workingDir: '/workspace/target', params: {} },
          aiCliProvider: 'claude_code', aiCliMode: 'implement', aiCliPrompt: 'p',
          workflowStepKey: `resume:${c.firstReview.id}:1`,
        } as never)
        await tick()
        const nonReviewHop = await resumedReview(c, implementHop)

        await approve(app, nonReviewHop)

        expect(await gitCommitsOf(c.task.id)).toHaveLength(0)
      })
    })

    it('resume key が malformed', async () => {
      await withApp(async (app) => {
        const c = await chain()
        const malformed = await resumedReview(c, c.firstReview, { workflowStepKey: `resume:${c.firstReview.id}:x` })

        await approve(app, malformed)

        expect(await gitCommitsOf(c.task.id)).toHaveLength(0)
      })
    })
  })

  it('同じ結果の再適用（Outbox replay・同一 body の再送）で git_commit を 2 本作らない', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const r1 = await resumedReview(c, c.firstReview)
      const payload = withOutbox(approved, 'resumed-review-approved-once')

      await approve(app, r1, payload)
      await approve(app, r1, payload)
      await approve(app, r1)

      expect(await gitCommitsOf(c.task.id)).toHaveLength(1)
    })
  })
})

describe('D4: resumed review 由来の git_commit を CEO が REJECT した後の provenance', () => {
  it('git_commit → 今回の review → review lineage → 元の implement を復元して修正 Job を作る', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const r1 = await resumedReview(c, c.firstReview)
      await approve(app, r1)
      const [commit] = await gitCommitsOf(c.task.id)
      await rejectCommit(c.task, commit!)

      const { statusCode, body } = await resume(app, c.task.id)

      expect(statusCode).toBe(201)
      expect(body.aiCliMode).toBe('implement')
      expect(body.aiCliProvider).toBe(c.implementJob.aiCliProvider)
      expect(body.safeCommand.kind).toBe(c.implementJob.safeCommand.kind)
      expect(body.workflowStepKey).toBe(`resume:${commit!.id}:1`)
    })
  })

  it('多段の resumed review 由来でも同じく復元する', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const s = await storage()
      const r1 = await resumedReview(c, c.firstReview)
      s.jobs.update(r1.id, { status: 'failed' } as never)
      const r2 = await resumedReview(c, r1)
      await approve(app, r2)
      const [commit] = await gitCommitsOf(c.task.id)
      await rejectCommit(c.task, commit!)

      const { statusCode, body } = await resume(app, c.task.id)

      expect(statusCode).toBe(201)
      expect(body.aiCliMode).toBe('implement')
      expect(body.aiCliProvider).toBe(c.implementJob.aiCliProvider)
    })
  })

  it('git_commit 自体の resume は従来どおり 1 ホップだけ正規化する（1 段は通る）', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const s = await storage()
      const r1 = await resumedReview(c, c.firstReview)
      await approve(app, r1)
      const [commit] = await gitCommitsOf(c.task.id)
      s.jobs.update(commit!.id, { status: 'blocked' } as never)
      await tick()
      const commitResume = s.jobs.create({
        ...c.base, status: 'queued',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
        workflowStepKey: `resume:${commit!.id}:1`,
      } as never)
      await rejectCommit(c.task, commitResume)

      const { statusCode, body } = await resume(app, c.task.id)

      expect(statusCode).toBe(201)
      expect(body.aiCliMode).toBe('implement')
    })
  })

  it('git_commit 側の 2 段 resume は従来どおり fail-closed（review lineage の walk と混ぜない）', async () => {
    await withApp(async (app) => {
      const c = await chain()
      const s = await storage()
      const r1 = await resumedReview(c, c.firstReview)
      await approve(app, r1)
      const [commit] = await gitCommitsOf(c.task.id)
      s.jobs.update(commit!.id, { status: 'blocked' } as never)
      await tick()
      const hop1 = s.jobs.create({
        ...c.base, status: 'blocked',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
        workflowStepKey: `resume:${commit!.id}:1`,
      } as never)
      await tick()
      const hop2 = s.jobs.create({
        ...c.base, status: 'queued',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
        workflowStepKey: `resume:${hop1.id}:1`,
      } as never)
      await rejectCommit(c.task, hop2)
      const before = s.jobs.findByTaskId(c.task.id).length

      const { statusCode, body } = await resume(app, c.task.id)

      expect(statusCode).toBe(409)
      expect(body.code).toBe('REJECTED_COMMIT_SOURCE_UNRESOLVED')
      expect(s.jobs.findByTaskId(c.task.id)).toHaveLength(before)
    })
  })

  it('通常 review 由来の git_commit の REJECT provenance は従来どおり（regression）', async () => {
    await withApp(async (app) => {
      const c = await chain(false)
      await approve(app, c.firstReview)
      const [commit] = await gitCommitsOf(c.task.id)
      await rejectCommit(c.task, commit!)

      const { statusCode, body } = await resume(app, c.task.id)

      expect(statusCode).toBe(201)
      expect(body.aiCliMode).toBe('implement')
      expect(body.aiCliProvider).toBe(c.implementJob.aiCliProvider)
    })
  })
})
