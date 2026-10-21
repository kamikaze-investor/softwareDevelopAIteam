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

/** 517d0af7-like shape: Human-resumed refusal started repair:root:1, whose review now requests changes. */
async function blockedAfterEligibleRefusalRepair() {
  const s = await storage()
  const project = s.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
  const task = s.tasks.create({
    projectId: project.id, title: 'Refusal recovery', description: 'd', status: 'blocked',
    assignee: 'developer_ai', dependencies: [], allowedPaths: [DOC], roadmapActive: true,
  } as never)
  const base = {
    taskId: task.id, projectId: project.id, status: 'queued',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' }, aiCliProvider: 'claude_code', aiCliPrompt: 'p',
  }
  const root = s.jobs.create({
    ...base,
    agentRole: 'developer_ai',
    aiCliMode: 'implement',
    workflowStepKey: `task:${task.id}:initial-implement`,
  } as never)
  s.jobs.update(root.id, { status: 'success', exitCode: 0, changedFiles: [DOC] } as never)

  const originalReview = s.jobs.create({
    ...base,
    agentRole: 'qa_ai',
    aiCliMode: 'review',
    workflowStepKey: `implement:${root.id}:review`,
  } as never)
  s.jobs.update(originalReview.id, { status: 'failed', exitCode: 1 } as never)
  const resumedReview = s.jobs.create({
    ...base,
    agentRole: 'qa_ai',
    aiCliMode: 'review',
    workflowStepKey: `resume:${originalReview.id}:1`,
  } as never)
  recordResumeActor(s, {
    jobId: resumedReview.id,
    taskId: task.id,
    actorClass: 'human',
    evidence: 'admin_credential',
  })
  s.jobs.update(resumedReview.id, {
    status: 'failed',
    exitCode: 1,
    failureMetadata: {
      workspaceState: 'unchanged',
      refusal: {
        kind: 'secret_scan',
        patternKinds: ['secret assignment'],
        repairEligible: true,
        repairEligibilityReason: 'implementation_report_generic_assignment',
      },
    },
  } as never)

  await tick()
  const designText = 'refusal repair admission'
  const admissionRun = s.designReviewRuns.create({
    taskId: task.id,
    taskTitle: task.title,
    designText,
    designTextHash: createHash('sha256').update(designText).digest('hex'),
    changedFiles: [DOC],
    repairSourceJobId: root.id,
  })
  const claimed = s.designReviewRuns.claim(admissionRun.id, 3)
  expect(claimed.claimToken).toBeDefined()
  await tick()
  expect(s.designReviewRuns.complete(admissionRun.id, claimed.claimToken!, 'succeeded', JSON.stringify({
    focusedReviewResults: [],
    integrationReviewResult: { decision: 'ALIGNED' },
    finalDecision: 'ALIGNED',
  }))).toBe(true)
  await tick()

  const repair = s.jobs.create({
    ...base,
    agentRole: 'developer_ai',
    aiCliMode: 'implement',
    workflowStepKey: `repair:${root.id}:1`,
  } as never)
  s.jobs.update(repair.id, { status: 'success', exitCode: 0, changedFiles: [DOC] } as never)
  await tick()
  const repairReview = s.jobs.create({
    ...base,
    agentRole: 'qa_ai',
    aiCliMode: 'review',
    workflowStepKey: `implement:${repair.id}:review`,
  } as never)
  return { taskId: task.id, repair, repairReview }
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

  it('a resumed review secret-scan refusal enters the same repair admission', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterFailedReview({ firstReviewTerminal: false })
      const s = await storage()
      s.jobs.update(shape.r0.id, { status: 'failed', exitCode: 1 } as never)
      const resumed = await resume(app, shape.taskId)
      expect(resumed.workflowStepKey).toBe(`resume:${shape.r0.id}:1`)

      const res = await app.inject({
        method: 'PATCH', url: `/api/jobs/${resumed.id}`,
        payload: {
          status: 'failed',
          exitCode: 1,
          stderr: 'Prompt refused by the pre-send secret scan',
          failureMetadata: {
            workspaceState: 'unchanged',
            refusal: {
              kind: 'secret_scan',
              patternKinds: ['password assignment', 'secret assignment'],
              repairEligible: true,
              repairEligibilityReason: 'implementation_report_generic_assignment',
            },
          },
        },
      })

      expect(res.statusCode).toBe(200)
      const runs = await repairRuns(shape.taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.repairSourceJobId).toBe(shape.i1.id)
      expect(runs[0]!.designText).toContain('kind: secret_scan')
      expect(runs[0]!.designText).toContain('password assignment')
      expect(runs[0]!.designText).toContain('implementation_report_generic_assignment')
      expect(kick).toHaveBeenCalledTimes(1)
      expect(kick.mock.calls[0]![2]).toBe(`repair:${shape.i1.id}:1`)
    })
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

  it('eligible refusal 由来の origin-root repair review PATCH が stage 2 を queue する', async () => {
    await withApp(async (app) => {
      const shape = await blockedAfterEligibleRefusalRepair()

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${shape.repairReview.id}`,
        payload: reviewPatch('changes_requested', '517d0af7-like review'),
      })

      expect(res.statusCode).toBe(200)
      const runs = await repairRuns(shape.taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('queued')
      expect(runs[0]!.repairSourceJobId).toBe(shape.repair.id)
      expect(runs[0]!.designText).toContain('517d0af7-like review')
      expect(kick).toHaveBeenCalledTimes(1)
      expect(kick.mock.calls[0]![2]).toBe(`repair:${shape.repair.id}:1`)
      expect((await storage()).tasks.findById(shape.taskId)?.status).toBe('blocked')
    })
  })
})

/**
 * **review 結果の永続化後・Stage 2 前に落ちても、再送で Stage 2 が1回だけ起きる**（lifecycle repair C2 / H-02）。
 *
 * persistReviewWorkflowResult（Outbox 記録を含む）と Stage 2 は別 transaction。以前は再送が
 * deduplicated になると Stage 2 を飛ばし、Task は pending・最新 review failed・live Job / run 無しで止まった。
 */
describe('PATCH の review 分岐: 永続化後に落ちた changes_requested の再送', () => {
  beforeEach(() => {
    kick.mockClear()
  })

  async function pendingReviewedImplementation() {
    const s = await storage()
    const project = s.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' })
    const task = s.tasks.create({
      projectId: project.id, title: 'VPS docs', description: 'd', status: 'pending',
      assignee: 'developer_ai', dependencies: [], allowedPaths: [DOC], roadmapActive: true,
    } as never)
    const base = {
      taskId: task.id, projectId: project.id, status: 'queued',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' }, aiCliProvider: 'claude_code', aiCliPrompt: 'p',
    }
    const impl = s.jobs.create({ ...base, agentRole: 'developer_ai', aiCliMode: 'implement', workflowStepKey: `task:${task.id}:initial-implement` } as never)
    s.jobs.update(impl.id, { status: 'success', exitCode: 0, changedFiles: [DOC] } as never)
    await tick()
    const review = s.jobs.create({ ...base, agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `implement:${impl.id}:review` } as never)
    s.jobs.update(review.id, { status: 'running' } as never)
    await tick()
    return { taskId: task.id, impl, review }
  }

  it('永続化だけ済んだ event の再送で Stage 2 が起き、さらに再送しても run は1件のまま', async () => {
    await withApp(async (app) => {
      const shape = await pendingReviewedImplementation()
      const payload = withOutbox(reviewPatch('changes_requested', 'lost before stage 2'), 'evt-review-crash')
      const { eventId, payloadHash, reviewResult, ...update } = payload

      // crash の再現: route と同じ永続化（status は failed へ正規化）だけを行い、Stage 2 は走らせない。
      const persisted = (await storage()).jobs.persistReviewWorkflowResult({
        jobId: shape.review.id,
        update: { ...update, status: 'failed' } as never,
        reviewResult: reviewResult as never,
        outboxEvent: { eventId, payloadHash },
      })
      expect(persisted.ok).toBe(true)
      expect(await repairRuns(shape.taskId)).toHaveLength(0)

      const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${shape.review.id}`, payload })

      expect(replay.statusCode).toBe(200)
      expect(JSON.parse(replay.body).outbox).toEqual({ eventId, deduplicated: true })
      const runs = await repairRuns(shape.taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.repairSourceJobId).toBe(shape.impl.id)
      expect(runs[0]!.designText).toContain('lost before stage 2')
      expect(kick).toHaveBeenCalledTimes(1)

      // もう一度再送しても、Stage 2 は二重に起きない（active run / identity 照合）。
      const again = await app.inject({ method: 'PATCH', url: `/api/jobs/${shape.review.id}`, payload })
      expect(again.statusCode).toBe(200)
      expect(await repairRuns(shape.taskId)).toHaveLength(1)
      expect(kick).toHaveBeenCalledTimes(1)
    })
  })

  it('Stage 2 の run が終端した後の再送でも、同じ repair 計画の run を作り直さない', async () => {
    await withApp(async (app) => {
      const shape = await pendingReviewedImplementation()
      const payload = withOutbox(reviewPatch('changes_requested', 'terminal before replay'), 'evt-review-terminal')

      expect((await app.inject({ method: 'PATCH', url: `/api/jobs/${shape.review.id}`, payload })).statusCode).toBe(200)
      const s = await storage()
      const [run] = s.designReviewRuns.findByTaskId(shape.taskId)
      expect(run).toBeDefined()
      const claimed = s.designReviewRuns.claim(run!.id, 3)
      s.designReviewRuns.complete(run!.id, claimed.claimToken!, 'succeeded', JSON.stringify({
        focusedReviewResults: [], integrationReviewResult: { decision: 'CONFLICT' }, finalDecision: 'CONFLICT',
      }))

      expect((await app.inject({ method: 'PATCH', url: `/api/jobs/${shape.review.id}`, payload })).statusCode).toBe(200)
      expect(s.designReviewRuns.findByTaskId(shape.taskId)).toHaveLength(1)
    })
  })
})
