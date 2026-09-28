import Fastify, { type FastifyInstance } from 'fastify'
import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@ai-team/shared'

// **kick だけを止める。** 判定（prepareRepairFlow / admission）は本物を使う。
vi.mock('../designReview/repairFlow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../designReview/repairFlow')>()
  return { ...actual, executeQueuedRepair: vi.fn(async () => ({ status: 'already_started', stepKey: 'mocked' })) }
})
import { executeQueuedRepair } from '../designReview/repairFlow'
import { recordResumeActor } from '../designReview/resumeActor'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

const kick = vi.mocked(executeQueuedRepair)

/**
 * **D3 を production caller（`PATCH /api/jobs/:id` の review 分岐）で確かめる。**
 *
 * production `9fdee5a3` の形: repair run（REVIEW_UNAVAILABLE）が終わった**後で** CEO が Human Resume した
 * review が修正を要求したら、その run に止められずに repair run を queue する。
 * admission が skip したときは、理由と対象を warn log に残す（黙って止まらない）。
 */

const DOC = 'docs/project_memory/decisions/vps-operations.md'
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

interface LogLine { level: number; msg: string; [key: string]: unknown }

async function buildApp(lines: LogLine[]): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'
  const [{ jobRoutes }, { resetStorage }] = await Promise.all([
    import('./jobs.js'),
    import('../storage/index.js'),
  ])
  resetStorage()
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line) as LogLine)
      done()
    },
  })
  const app = Fastify({ logger: { level: 'warn', stream } })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return app
}

async function storage() {
  return (await import('../storage/index.js')).getStorage()
}

/** B0 blocked → I1 resume:B0:1（human・success）→ R0 implement:I1:review（changes_requested）。 */
async function shape() {
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
  s.jobs.update(r0.id, { status: 'failed', exitCode: 0 } as never)
  s.reviewResults.create({
    taskId: task.id, jobId: r0.id, reviewer: 'qa_ai', status: 'changes_requested',
    summary: 'first review', findings: [{ severity: 'medium', file: DOC, message: 'first finding' }],
  } as never)
  await tick()

  const unavailableRun = async (): Promise<string> => {
    const designText = `repair plan ${Math.random()}`
    const run = s.designReviewRuns.create({
      taskId: task.id, taskTitle: 'VPS docs', designText, designTextHash: computeDesignTextHash(designText),
      changedFiles: [DOC], repairSourceJobId: i1.id,
    })
    const claimed = s.designReviewRuns.claim(run.id, 3)
    s.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      finalDecision: 'REVIEW_UNAVAILABLE', unavailableReason: 'ENOENT',
    }))
    await tick()
    return run.id
  }

  /** CEO の Human Resume（R1 = resume:R0:1、human）。route を通さず、保存される事実だけを作る。 */
  const humanResumedReview = async (): Promise<Job> => {
    const r1 = s.jobs.create({ ...base, agentRole: 'qa_ai', aiCliMode: 'review', workflowStepKey: `resume:${r0.id}:1` } as never)
    recordResumeActor(s, { jobId: r1.id, taskId: task.id, actorClass: 'human', evidence: 'admin_credential' })
    s.jobs.update(r1.id, { status: 'running' } as never)
    await tick()
    return r1
  }

  return { s, taskId: task.id, i1, unavailableRun, humanResumedReview }
}

const changesRequested = {
  status: 'success',
  exitCode: 0,
  changedFiles: [DOC],
  guardResult: { permissionAllowed: true, fileChangeAllowed: true },
  reviewResult: {
    status: 'changes_requested',
    summary: 'second review',
    findings: [{ severity: 'medium', file: DOC, message: 'secret boundary claim is wrong' }],
  },
}

describe('D3: PATCH の review 分岐と Human Resume で回答済みの Design Review run', () => {
  beforeEach(() => {
    kick.mockClear()
  })

  it('production 9fdee5a3: run が終わった後の Human Resume review の修正要求は repair run を queue する', async () => {
    const lines: LogLine[] = []
    const app = await buildApp(lines)
    try {
      const { s, taskId, i1, unavailableRun, humanResumedReview } = await shape()
      const oldRun = await unavailableRun()
      const r1 = await humanResumedReview()

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${r1.id}`, payload: changesRequested })

      expect(res.statusCode).toBe(200)
      const queued = s.designReviewRuns.findQueued().filter((run) => run.taskId === taskId)
      expect(queued).toHaveLength(1)
      expect(queued[0]!.id).not.toBe(oldRun)
      expect(queued[0]!.repairSourceJobId).toBe(i1.id)
      expect(kick).toHaveBeenCalledTimes(1)
      expect(kick.mock.calls[0]![2]).toBe(`repair:${i1.id}:1`)
      expect(lines.some((line) => line.msg.includes('stage 2 skipped'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('run の完了前に作られた resume なら skip し、reason / sourceJobId / reviewJobId / runId を warn に残す', async () => {
    const lines: LogLine[] = []
    const app = await buildApp(lines)
    try {
      const { s, taskId, i1, unavailableRun, humanResumedReview } = await shape()
      const r1 = await humanResumedReview()
      const runId = await unavailableRun()

      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${r1.id}`, payload: changesRequested })

      expect(res.statusCode).toBe(200)
      expect(s.designReviewRuns.findQueued().filter((run) => run.taskId === taskId)).toHaveLength(0)
      expect(kick).not.toHaveBeenCalled()
      const warn = lines.find((line) => line.msg.includes('stage 2 skipped'))
      expect(warn).toMatchObject({
        level: 40,
        reason: 'task is blocked (latest design review is REVIEW_UNAVAILABLE)',
        sourceJobId: i1.id,
        reviewJobId: r1.id,
        runId,
      })
    } finally {
      await app.close()
    }
  })
})
