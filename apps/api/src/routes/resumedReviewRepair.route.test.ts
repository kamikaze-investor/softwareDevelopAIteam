import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeJobUpdate, type Job } from '@ai-team/shared'

// **kick だけを止める。** 判定（prepareRepairFlow / resolveReviewedImplementation）は本物を使う。
// executeQueuedRepair は既定で runner subprocess を起動するため、route テストでは差し替える。
vi.mock('../designReview/repairFlow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../designReview/repairFlow')>()
  return { ...actual, executeQueuedRepair: vi.fn(async () => ({ status: 'already_started', stepKey: 'mocked' })) }
})
import { executeQueuedRepair } from '../designReview/repairFlow'
import { recordResumeActor } from '../designReview/resumeActor'

const kick = vi.mocked(executeQueuedRepair)

/**
 * **D1 の production caller（`PATCH /api/jobs/:id` の review 分岐）を実 route で確かめる。**
 *
 * 2026-09-28 production と同じ順序で組む: 失敗した review が最新 Job の blocked Task を
 * `POST /api/tasks/:id/resume` で再開し（`resumeBlockedTask()` が `resume:<review>:1` の review を作る）、
 * その review の structured result を PATCH する。
 */

const DOC = 'docs/project_memory/decisions/vps-operations.md'

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'
  const [{ taskRoutes }, { jobRoutes }, { resetStorage }] = await Promise.all([
    import('./tasks.js'),
    import('./jobs.js'),
    import('../storage/index.js'),
  ])
  resetStorage()
  const app = Fastify()
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

/** 「最新 Job」は createdAt で決まる。production では分単位で離れているので、同一ミリ秒を避ける。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function storage() {
  return (await import('../storage/index.js')).getStorage()
}

/** production の形: B0 blocked → I1 resume:B0:1 成功（human）→ R0 implement:I1:review 失敗（changes_requested）。 */
async function blockedAfterFailedReview(opts: { firstReviewTerminal?: boolean } = {}) {
  const s = await storage()
  const project = s.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = s.tasks.create({
    projectId: project.id, title: 'VPS docs', description: 'd', status: 'blocked',
    assignee: 'developer_ai', dependencies: [], allowedPaths: [DOC], roadmapActive: true,
  } as never)
  const base = {
    taskId: task.id, projectId: project.id, status: 'queued',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' }, aiCliProvider: 'claude_code', aiCliPrompt: 'p',
  }
  const b0 = s.jobs.create({ ...base, agentRole: 'developer_ai', aiCliMode: 'implement', workflowStepKey: `task:${task.id}:initial-implement` } as never)
  s.jobs.update(b0.id, { status: 'blocked' } as never)
  await tick()
  const i1 = s.jobs.create({ ...base, agentRole: 'developer_ai', aiCliMode: 'implement', workflowStepKey: `resume:${b0.id}:1` } as never)
  s.jobs.update(i1.id, { status: 'success', exitCode: 0, changedFiles: [DOC] } as never)
  recordResumeActor(s, { jobId: i1.id, taskId: task.id, actorClass: 'human', evidence: 'admin_credential' })
  await tick()
  const r0 = s.jobs.create({ ...base, agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${i1.id}:review` } as never)
  if (opts.firstReviewTerminal !== false) {
    s.jobs.update(r0.id, { status: 'failed', exitCode: 0 } as never)
    s.reviewResults.create({
      taskId: task.id, jobId: r0.id, reviewer: 'qa_ai', status: 'changes_requested',
      summary: 'first review', findings: [{ severity: 'medium', file: DOC, message: 'first finding' }],
    } as never)
  }
  await tick()
  return { taskId: task.id, projectId: project.id, b0, i1, r0 }
}

async function resume(app: FastifyInstance, taskId: string): Promise<Job> {
  const res = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/resume`, payload: { instruction: 'Address the review.' } })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body) as Job
}

function reviewPatch(status: 'approved' | 'changes_requested', summary = 'second review'): Record<string, unknown> {
  return {
    status: 'success',
    exitCode: 0,
    changedFiles: [DOC],
    guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    reviewResult: {
      status,
      summary,
      findings: status === 'approved' ? [] : [{ severity: 'medium', file: DOC, message: 'secret boundary claim is wrong' }],
    },
  }
}

function withOutbox<T extends Record<string, unknown>>(payload: T, eventId: string): T & { eventId: string; payloadHash: string } {
  return { ...payload, eventId, payloadHash: createHash('sha256').update(canonicalizeJobUpdate(payload)).digest('hex') }
}

async function repairRuns(taskId: string) {
  return (await storage()).designReviewRuns.findQueued().filter((run) => run.taskId === taskId && run.repairSourceJobId !== undefined)
}

describe('PATCH の review 分岐: Human Resume で再実行された review', () => {
  beforeEach(() => {
    kick.mockClear()
  })

  it('2. resume された review の changes_requested が repair run を queue する', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterFailedReview()
      const resumed = await resume(app, shape.taskId)
      // production と同じ形であることを先に確かめる。
      expect(resumed.workflowStepKey).toBe(`resume:${shape.r0.id}:1`)
      expect(resumed.aiCliMode).toBe('review')

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${resumed.id}`, payload: reviewPatch('changes_requested') })

      expect(res.statusCode).toBe(200)
      const runs = await repairRuns(shape.taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('queued')
      expect(runs[0]!.repairSourceJobId).toBe(shape.i1.id)
      expect(runs[0]!.designText).toContain('second review')
      expect(kick).toHaveBeenCalledTimes(1)
      expect(kick.mock.calls[0]![2]).toBe(`repair:${shape.i1.id}:1`)
    })
  })

  it('3. resume された review が approved なら repair を作らない', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterFailedReview()
      const resumed = await resume(app, shape.taskId)

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${resumed.id}`, payload: reviewPatch('approved') })

      expect(res.statusCode).toBe(200)
      expect(await repairRuns(shape.taskId)).toHaveLength(0)
      expect(kick).not.toHaveBeenCalled()
    })
  })

  it('6. 同じ結果の再送（Outbox replay）では repair を 2 本作らない', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterFailedReview()
      const resumed = await resume(app, shape.taskId)
      const payload = withOutbox(reviewPatch('changes_requested'), 'resumed-review-once')

      const first = await app.inject({ method: 'PATCH', url: `/api/jobs/${resumed.id}`, payload })
      const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${resumed.id}`, payload })

      expect(first.statusCode).toBe(200)
      expect(replay.statusCode).toBe(200)
      expect(await repairRuns(shape.taskId)).toHaveLength(1)
      expect(kick).toHaveBeenCalledTimes(1)
    })
  })

  it('4. 実装へ辿れない review（manual review の resume）は repair を作らない', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterFailedReview()
      const s = await storage()
      await tick()
      // 最新 Job を「implement:<id>:review ではない review」にしてから resume する。
      const manual = s.jobs.create({
        taskId: shape.taskId, projectId: shape.projectId, agentRole: 'qa_ai', status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' }, aiCliProvider: 'claude_code',
        aiCliPrompt: 'p', aiCliMode: 'review', workflowStepKey: 'manual-review',
      } as never)
      s.jobs.update(manual.id, { status: 'failed', exitCode: 0 } as never)
      await tick()
      const resumed = await resume(app, shape.taskId)
      expect(resumed.workflowStepKey).toBe(`resume:${manual.id}:1`)

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${resumed.id}`, payload: reviewPatch('changes_requested') })

      expect(res.statusCode).toBe(200)
      expect(await repairRuns(shape.taskId)).toHaveLength(0)
      expect(kick).not.toHaveBeenCalled()
    })
  })
})

describe('PATCH の review 分岐: 既存の implement:<id>:review（regression）', () => {
  beforeEach(() => {
    kick.mockClear()
  })

  it('1. 通常の review の changes_requested は従来どおり repair run を queue する', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterFailedReview({ firstReviewTerminal: false })

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${shape.r0.id}`, payload: reviewPatch('changes_requested', 'first review') })

      expect(res.statusCode).toBe(200)
      const runs = await repairRuns(shape.taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.repairSourceJobId).toBe(shape.i1.id)
      expect(kick).toHaveBeenCalledTimes(1)
      expect(kick.mock.calls[0]![2]).toBe(`repair:${shape.i1.id}:1`)
    })
  })
})
