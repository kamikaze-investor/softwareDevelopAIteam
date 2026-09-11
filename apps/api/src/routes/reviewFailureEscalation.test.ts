/**
 * review-failure-escalation gap（MVP-BLOCKING）の回帰テスト。
 *
 * review が structured result を返せずに終了すると `reviewResult` が無いため Stage 2
 * （prepareRepairFlow / escalateTaskToHuman）へ入れず、Task が `pending` のまま残っていた。
 * その結果:
 *   1. implement の正当な成果が未コミットで worktree に残る
 *   2. 次の通常 Job が clean worktree 要件を満たせず quarantine される
 *   3. `resumeBlockedTask` は quarantine を fail-closed で拒否し、解除機構も無い
 * となり、CEO がスマホから復旧できなくなる（Production E2E test 8 で実際に発生）。
 *
 * 修正は既存 `escalateTaskToHuman()` の再利用のみ。Task を `blocked` にして
 * 既存 resume 経路（`resume:` = intentionally-dirty）へ合流させ、quarantine を
 * **そもそも発生させない**。quarantine 判定も clear-quarantine の条件も変更しない。
 */

import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeJobUpdate, type Job, type Project, type Task } from '@ai-team/shared'

async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { jobRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./jobs.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
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

function calculatePayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalizeJobUpdate(payload)).digest('hex')
}

function withOutbox<T extends Record<string, unknown>>(payload: T, eventId: string): T & { eventId: string; payloadHash: string } {
  return { ...payload, eventId, payloadHash: calculatePayloadHash(payload) }
}

async function getStorage() {
  const { getStorage } = await import('../storage/index.js')
  return getStorage()
}

async function createProject(app: FastifyInstance): Promise<Project> {
  const res = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'Test', goal: 'Test goal', designPhilosophy: [] },
  })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body) as Project
}

async function createTask(projectId: string): Promise<Task> {
  const storage = await getStorage()
  return storage.tasks.create({
    projectId, title: 'T', description: '', status: 'pending',
    assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
  })
}

/** implement Job -> その review Job という、production と同じ workflow 連結を作る。 */
async function createImplementAndReview(task: Task): Promise<{ implement: Job; review: Job }> {
  const storage = await getStorage()
  const implement = storage.jobs.create({
    taskId: task.id, projectId: task.projectId, agentRole: 'developer_ai', status: 'success',
    workflowStepKey: `task:${task.id}:initial-implement`,
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliMode: 'implement',
  })
  // resumeBlockedTask は latestJob を `ORDER BY created_at DESC` で選ぶ（tie-break 無し）。
  // 同一ミリ秒だと順序が不定になるため、production と同じく review を後発にする。
  await new Promise((resolve) => setTimeout(resolve, 5))
  const review = storage.jobs.create({
    taskId: task.id, projectId: task.projectId, agentRole: 'qa_ai', status: 'running',
    workflowStepKey: `implement:${implement.id}:review`,
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliMode: 'review',
  })
  return { implement, review }
}

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
})

describe('review-failure-escalation gap', () => {
  it('structured result の無い review failure で Task が pending に残らず blocked へ escalate する', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      expect(storage.tasks.findById(task.id)?.status).toBe('pending')

      // Worker は structured result を解析できないとき inspectAfterAiFailure() 経由で
      // **failed** を報告する。success だけを見ていると production の経路を取りこぼす。
      const res = await app.inject({
        method: 'PATCH', url: `/api/jobs/${review.id}`,
        payload: {
          status: 'failed',
          exitCode: 1,
          stderr: 'Structured review output failed strict schema validation (fail-closed)',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(storage.jobs.findById(review.id)?.status).toBe('failed')
      expect(storage.tasks.findById(task.id)?.status).toBe('blocked')
    })
  })

  it('review が success を報告しても structured result が無ければ failed 化し blocked へ escalate する', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      const res = await app.inject({
        method: 'PATCH', url: `/api/jobs/${review.id}`,
        payload: { status: 'success', exitCode: 0 },
      })

      expect(res.statusCode).toBe(200)
      // fail-open しない: reviewResult が無い success は失敗として扱う。
      expect(storage.jobs.findById(review.id)?.status).toBe('failed')
      expect(storage.tasks.findById(task.id)?.status).toBe('blocked')
    })
  })

  it('原因が provider 障害・auth 失敗でも fail-open せず blocked へ到達する', async () => {
    // 修正は「reviewResult が無い」という一点で判定するので、原因文言に依存しない。
    for (const stderr of [
      'provider request failed: 401 Unauthorized',
      'provider timed out after 120s',
      'Structured review output failed strict schema validation (fail-closed)',
    ]) {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(project.id)
        const { review } = await createImplementAndReview(task)
        const storage = await getStorage()

        const res = await app.inject({
          method: 'PATCH', url: `/api/jobs/${review.id}`,
          payload: { status: 'failed', exitCode: 1, stderr },
        })

        expect(res.statusCode).toBe(200)
        expect(storage.tasks.findById(task.id)?.status).toBe('blocked')
      })
    }
  })

  it('同じ failure が再送されても duplicate escalation を起こさない（復旧済み Task を再び止めない）', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      const payload = {
        status: 'failed' as const,
        exitCode: 1,
        stderr: 'Structured review output failed strict schema validation (fail-closed)',
      }
      const body = withOutbox(payload, 'event-review-fail-1')

      const first = await app.inject({ method: 'PATCH', url: `/api/jobs/${review.id}`, payload: body })
      expect(first.statusCode).toBe(200)
      expect(storage.tasks.findById(task.id)?.status).toBe('blocked')

      // Task が進行して commit 済みになった状況を模す。
      // （`resumeBlockedTask` は Task の status を変えないため、実際に pending から動くのは
      //   `blocked` と `done` だけ。ここでは復旧しきった `done` を使う。）
      storage.tasks.update(task.id, { status: 'done' })

      // 同じ Outbox event が再送される。deduplicated なので escalate してはならない。
      const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${review.id}`, payload: body })
      expect(replay.statusCode).toBe(200)
      expect(JSON.parse(replay.body).outbox?.deduplicated).toBe(true)

      // 復旧済みの Task を blocked へ戻していない。
      expect(storage.tasks.findById(task.id)?.status).toBe('done')
      // Job も増えていない。
      expect(storage.jobs.findByTaskId(task.id)).toHaveLength(2)
    })
  })

  it('approved review の既存経路は変わらない（git_commit Job が作られ Task は blocked にならない）', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      const res = await app.inject({
        method: 'PATCH', url: `/api/jobs/${review.id}`,
        payload: {
          status: 'success',
          exitCode: 0,
          reviewResult: { status: 'approved', summary: 'ok', findings: [] },
        },
      })

      expect(res.statusCode).toBe(200)
      expect(storage.jobs.findById(review.id)?.status).toBe('success')
      expect(storage.tasks.findById(task.id)?.status).not.toBe('blocked')

      const commitJobs = storage.jobs.findByTaskId(task.id)
        .filter((j) => j.safeCommand.kind === 'git_commit')
      expect(commitJobs).toHaveLength(1)
      expect(commitJobs[0].workflowStepKey).toBe(`review:${review.id}:git-commit`)
    })
  })

  it('changes_requested の既存 Stage 2 経路は変わらない（escalate ではなく repair 側で処理される）', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      const res = await app.inject({
        method: 'PATCH', url: `/api/jobs/${review.id}`,
        payload: {
          status: 'success',
          exitCode: 0,
          reviewResult: {
            status: 'changes_requested', summary: 'fix the format',
            findings: [{ severity: 'high', file: 'test.js', line: 1, message: 'wrong format', rule: 'acceptanceCriteria[0]' }],
          },
        },
      })

      expect(res.statusCode).toBe(200)
      // review 結果は永続化され、git_commit は作られない。
      const persisted = storage.reviewResults.findByTaskId(task.id).find((r) => r.jobId === review.id)
      expect(persisted?.status).toBe('changes_requested')
      expect(storage.jobs.findByTaskId(task.id).filter((j) => j.safeCommand.kind === 'git_commit')).toHaveLength(0)
    })
  })

  it('escalate 後は resume できる: dirty worktree を保持したまま `resume:` Job が作られる', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      // 修正前はここが pending のままで、resumeBlockedTask の入口条件
      // （latestJob=blocked もしくは task=blocked かつ latestJob=failed）を満たせず
      // `Latest job status is failed, not blocked` で弾かれていた。
      await app.inject({
        method: 'PATCH', url: `/api/jobs/${review.id}`,
        payload: { status: 'failed', exitCode: 1, stderr: 'Structured review output failed strict schema validation (fail-closed)' },
      })
      expect(storage.tasks.findById(task.id)?.status).toBe('blocked')

      // worktree は dirty のまま（implement の正当な成果を捨てない）。
      const resumed = storage.jobs.resumeBlockedTask({
        taskId: task.id,
        instructionPrompt: 'レビューが失敗したので再実行する',
      })

      expect(resumed.ok).toBe(true)
      if (resumed.ok) {
        // `resume:` は intentionally-dirty 経路なので clean-worktree quarantine に入らない
        // （worker 側 computeWorkspaceBaseline の免除条件。jobRunner.test.ts で固定済み）。
        expect(resumed.job.workflowStepKey?.startsWith('resume:')).toBe(true)
        expect(resumed.job.status).toBe('queued')
      }

      // quarantine 済みの Job は一つも作られていない（そもそも発生させない）。
      expect(storage.jobs.findByTaskId(task.id).some((j) => j.failureMetadata?.quarantined === true)).toBe(false)
    })
  })

  it('永続化後 escalate 前に落ちても、再送（deduplicated）で escalate される', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(project.id)
      const { review } = await createImplementAndReview(task)
      const storage = await getStorage()

      // 独立レビュー指摘（CLAIM 1）の再現:
      // `updateWithOutboxEvent` は Job 更新と Outbox event 記録を同一 transaction で確定する。
      // その直後・escalate 前に API が落ちた状態を、storage を直接叩いて作る。
      const payload = {
        status: 'failed' as const,
        exitCode: 1,
        stderr: 'Structured review output failed strict schema validation (fail-closed)',
      }
      const body = withOutbox(payload, 'event-crash-window-1')
      const persisted = storage.jobs.updateWithOutboxEvent(
        review.id,
        { ...payload, status: 'failed' },
        { eventId: 'event-crash-window-1', payloadHash: calculatePayloadHash(payload) },
      )
      expect(persisted.ok).toBe(true)
      // escalate は実行されていない = crash した状態
      expect(storage.tasks.findById(task.id)?.status).toBe('pending')

      // Worker が同じ Outbox event を再送する。storage は deduplicated を返し状態を再適用しない。
      const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${review.id}`, payload: body })
      expect(replay.statusCode).toBe(200)
      expect(JSON.parse(replay.body).outbox?.deduplicated).toBe(true)

      // それでも Task は escalate され、pending に取り残されない。
      expect(storage.tasks.findById(task.id)?.status).toBe('blocked')
    })
  })
})
