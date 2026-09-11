/**
 * POST /api/task-continuations/reconcile — backend専用のcontinuation liveness driver。
 *
 * 目的は「Mobileの`GET /api/projects`系が持つretry副作用に依存せず、Workerのpoll cycleだけで
 * pending continuationを回収できる」ことの確認である。したがってここでは**GETを一切呼ばない**。
 *
 * gateの正しさ（paused/dependency/design review evidence）は
 * `createInitialImplementWorkflow()`側の責務だが、sweepという新しい呼び出し口が
 * それらを迂回していないことを、この経路からも確認する。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ai-team/shared'

const roadmapMocks = vi.hoisted(() => ({ generateRoadmap: vi.fn() }))
vi.mock('../ctoAi/roadmapGenerator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ctoAi/roadmapGenerator.js')>()),
  generateRoadmap: roadmapMocks.generateRoadmap,
}))

const TASK_ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
  integrationReviewResult: { decision: 'ALIGNED' },
})
/**
 * 有効なStrategicDecisionは 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN' のみ
 * （packages/shared/src/types/meta_review.ts）。ここで CONFLICT を明示するのは、
 * 「design reviewが通らない」ケースをその意味どおり表現するためである。
 *
 * 履歴: 本コメントは元々「未知の文字列はresolveFinalDecision()がALIGNEDへ
 * fall throughするので実在する値を使うこと」という注意書きだった。その fall-through は
 * fail-open欠陥として修正済み（未知値はUNCERTAINへ倒れ、recomputeDecision()が
 * 理由付きでrejectする）。回帰テストは packages/shared/src/strategicDecision.test.ts と
 * designReviewCoordinator.test.ts にある。
 */
const TASK_CONFLICT_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }],
  integrationReviewResult: { decision: 'CONFLICT' },
})
const ROADMAP_ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [
    { focus: 'strategic_alignment', decision: 'ALIGNED' },
    { focus: 'scope_simplicity', decision: 'ALIGNED' },
    { focus: 'architecture_responsibility', decision: 'ALIGNED' },
  ],
  integrationReviewResult: { decision: 'ALIGNED' },
  independentReviewResult: { verdict: 'approved' },
})

/** roadmap reviewは常にALIGNED、task design reviewだけテストごとに切り替える。 */
let taskReviewStdout = TASK_ALIGNED_STDOUT
function stdoutForReviewInput(input: string): string {
  const parsed = JSON.parse(input) as { reviewKind?: string }
  return parsed.reviewKind === 'roadmap' ? ROADMAP_ALIGNED_STDOUT : taskReviewStdout
}

const designReviewMocks = vi.hoisted(() => ({
  execute: vi.fn(async (_input: string) => ({ ok: true, timedOut: false, stdout: '' })),
}))
vi.mock('../designReview/designReviewCoordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../designReview/designReviewCoordinator')>()),
  buildDefaultCoordinatorDeps: () => ({
    runnerCommand: 'node', runnerArgs: [], homeDirectory: '/tmp', workingDir: '/tmp',
    execute: designReviewMocks.execute,
  }),
}))
vi.mock('../ctoAi/projectMemoryWriter.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeProjectMemory: () => ({
    writtenFiles: [], targetDir: process.env.TARGET_ROOT ?? '/tmp',
    readinessScore: 100, readinessReason: 'test',
    mustResolveGaps: 0, definitionHash: 'test-definition-hash', constraintsHash: 'test-constraints-hash',
  }),
}))
vi.mock('../ctoAi/roadmapWriter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ctoAi/roadmapWriter.js')>()),
  writeRoadmap: () => ({ writtenFiles: [], targetDir: process.env.TARGET_ROOT ?? '/tmp' }),
}))
const specAnalyzerMocks = vi.hoisted(() => ({ analyzeSpec: vi.fn() }))
vi.mock('../ctoAi/specAnalyzer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ctoAi/specAnalyzer.js')>()),
  analyzeSpec: specAnalyzerMocks.analyzeSpec,
}))

interface ReconcileSummary {
  scanned: number
  recovered: number
  failed: number
  stillPending: number
}

let sandbox: string

/**
 * fileベースのDBを使う（`:memory:`ではない）。restart後も回収できることを、
 * storage handleとFastify instanceを作り直して確認する必要があるため。
 */
async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { taskContinuationRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./taskContinuations.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskContinuationRoutes, { prefix: '/api' })
  await app.ready()
  return app
}

async function getStorageForTest() {
  const { getStorage } = await import('../storage/index.js')
  return getStorage()
}

async function createRunningProjectWithTask(app: FastifyInstance) {
  const createRes = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'Project', goal: 'Goal', designPhilosophy: [], status: 'draft' },
  })
  expect(createRes.statusCode).toBe(201)
  const project = JSON.parse(createRes.body) as Project

  const startRes = await app.inject({
    method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' },
  })
  expect(startRes.statusCode).toBe(200)

  const storage = await getStorageForTest()
  // kickProjectStart()はfire-and-forgetなのでTask生成を待つ。
  for (let i = 0; i < 200 && storage.tasks.findByProjectId(project.id).length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const sourceTask = storage.tasks.findByProjectId(project.id)[0]
  expect(sourceTask).toBeDefined()
  return { project, sourceTask, storage }
}

/** 「Task 1のcommitは済んだが、次Taskの初回Jobがまだ作られていない」状態を直接作る。 */
async function seedPendingContinuation(
  storage: Awaited<ReturnType<typeof getStorageForTest>>,
  projectId: string,
  sourceTaskId: string,
  options: { dependencies?: string[] } = {},
) {
  const nextTask = storage.tasks.create({
    projectId, title: 'Next', description: 'Implement next.', status: 'pending',
    assignee: 'developer_ai', dependencies: options.dependencies ?? [], roadmapActive: true, phase: 2,
  })
  const sourceJob = storage.jobs.create({
    taskId: sourceTaskId, projectId, agentRole: 'developer_ai', status: 'success',
    safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
  })
  const continuation = storage.taskContinuations.create({
    sourceJobId: sourceJob.id, projectId, completedTaskId: sourceTaskId,
    nextTaskId: nextTask.id, status: 'pending',
  })
  return { nextTask, continuation }
}

/**
 * sweep本体を直接呼ぶ。routeは202を即返すfire-and-forgetになったため（Workerのpoll cycleを
 * design reviewの完了まで止めないため）、HTTP経由では戻り値のsummaryを観測できない。
 * route自体の契約は下の専用テストで確認する。
 */
async function reconcile(_app: FastifyInstance): Promise<ReconcileSummary> {
  const { reconcileTaskContinuations } = await import('../ctoAi/taskContinuation.js')
  const storage = await getStorageForTest()
  return reconcileTaskContinuations(storage)
}

/** 条件が満たされるまで短く待つ（fire-and-forgetの効果は非同期に現れる）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

beforeEach(() => {
  vi.resetModules()
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'continuation-sweep-'))
  process.env.DB_PATH = path.join(sandbox, 'db.sqlite')
  process.env.TARGET_ROOT = path.join(sandbox, 'target')
  mkdirSync(process.env.TARGET_ROOT, { recursive: true })

  taskReviewStdout = TASK_ALIGNED_STDOUT
  roadmapMocks.generateRoadmap.mockReset()
  roadmapMocks.generateRoadmap.mockResolvedValue({
    phases: [{ number: 1, name: 'Foundation', goal: 'Start', tasks: ['task-001'] }],
    tasks: [{
      id: 'task-001', title: 'Implement', description: 'Implement.', phase: 1,
      assignee: 'developer_ai', category: 'implementation', dependencies: [],
      acceptanceCriteria: [], allowedPaths: [], estimatedComplexity: 'small',
    }],
    totalTasks: 1, estimatedWeeks: 1,
  })
  designReviewMocks.execute.mockReset()
  designReviewMocks.execute.mockImplementation(async (input: string) => ({
    ok: true, timedOut: false, stdout: stdoutForReviewInput(input),
  }))
  specAnalyzerMocks.analyzeSpec.mockReset()
  specAnalyzerMocks.analyzeSpec.mockImplementation(async (specText: string) => ({
    goal: specText, designPhilosophy: [],
    mvpScope: { description: specText, includedFeatures: [], excludedFeatures: [] },
    targetUsers: [], techStack: [], gaps: [], structuredConstraints: [], requiredExternalServices: [],
    readinessScore: 100, readinessReason: 'no gaps (test default)',
  }))
})

afterEach(() => {
  // Windowsでは開いたままのSQLite handleがファイルをロックするため、後始末は best-effort。
  // 一時ディレクトリの残骸はテスト結果に影響しない。
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('POST /api/task-continuations/reconcile', () => {
  it('running Projectのpending continuationから次Taskの初回Jobを作る（GETを一切呼ばない）', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask, continuation } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(0)

      const summary = await reconcile(app)

      expect(summary).toMatchObject({ scanned: 1, recovered: 1, failed: 0, stillPending: 0 })
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(1)
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('completed')
    } finally {
      await app.close()
    }
  })

  it('paused Projectは自動突破しない（continuationはpendingのまま保持される）', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask, continuation } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      const pauseRes = await app.inject({
        method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'paused' },
      })
      expect(pauseRes.statusCode).toBe(200)

      const summary = await reconcile(app)

      // 走査対象にすらしない。CEOがrunningへ戻すまで前へ進めてはならない。
      expect(summary).toMatchObject({ scanned: 0, recovered: 0, failed: 0, stillPending: 0 })
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(0)
      // failedにもしない。pausedは一時状態であり、continuationは失われない。
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('pending')
    } finally {
      await app.close()
    }
  })

  it('dependency未達のTaskは進めず、pendingのまま次cycleへ残す', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const blocker = storage.tasks.create({
        projectId: project.id, title: 'Blocker', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 2,
      })
      const { nextTask, continuation } = await seedPendingContinuation(
        storage, project.id, sourceTask.id, { dependencies: [blocker.id] },
      )

      const summary = await reconcile(app)

      expect(summary).toMatchObject({ scanned: 1, recovered: 0, failed: 0, stillPending: 1 })
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(0)
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('pending')
    } finally {
      await app.close()
    }
  })

  it('design review evidenceが成立しない場合はJobを作らない（gateを迂回しない）', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask, continuation } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      // roadmap reviewは通すが、task design reviewだけCONFLICTにする。
      taskReviewStdout = TASK_CONFLICT_STDOUT

      const summary = await reconcile(app)

      expect(summary.scanned).toBe(1)
      expect(summary.recovered).toBe(0)
      // ALIGNED evidenceが無いので初回Jobは作られない。
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(0)
      // 非retryableなskipはcontinuationをfailedにし、Taskをblockedにする（CEOへ可視化する）。
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('failed')
      expect(storage.tasks.findById(nextTask.id)?.status).toBe('blocked')
    } finally {
      await app.close()
    }
  })

  it('sweepを繰り返してもduplicate Jobを作らない', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      const first = await reconcile(app)
      const second = await reconcile(app)
      const third = await reconcile(app)

      expect(first.recovered).toBe(1)
      // 2回目以降はpendingが残っていないので走査対象が無い。
      expect(second).toMatchObject({ scanned: 0, recovered: 0 })
      expect(third).toMatchObject({ scanned: 0, recovered: 0 })
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('sweepが同時に走ってもduplicate Jobを作らない', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      await Promise.all([reconcile(app), reconcile(app), reconcile(app)])

      // ux_jobs_workflow_step_key（UNIQUE）とstepKey既存チェックで重複生成は封じられている。
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('API restart後も、同じdurable stateからcontinuationを回収できる', async () => {
    const first = await buildApp()
    let projectId: string
    let nextTaskId: string
    let continuationId: string
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(first)
      const seeded = await seedPendingContinuation(storage, project.id, sourceTask.id)
      projectId = project.id
      nextTaskId = seeded.nextTask.id
      continuationId = seeded.continuation.id
      expect(storage.jobs.findByTaskId(nextTaskId)).toHaveLength(0)
    } finally {
      // restart相当: Fastify instanceもstorage handleも破棄する。DBファイルだけが残る。
      await first.close()
    }

    vi.resetModules()
    const restarted = await buildApp()
    try {
      const storage = await getStorageForTest()
      expect(storage.projects.findById(projectId)?.status).toBe('running')

      const summary = await reconcile(restarted)

      expect(summary).toMatchObject({ scanned: 1, recovered: 1 })
      expect(storage.jobs.findByTaskId(nextTaskId)).toHaveLength(1)
      expect(storage.taskContinuations.findById(continuationId)?.status).toBe('completed')
    } finally {
      await restarted.close()
    }
  })

  it('routeは202を即返し、Workerのpoll cycleをsweep完了まで待たせない', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      // design review をテスト側で握り、sweep を完了させないまま POST する。
      // これで「sweep が終わっていないのに 202 が返る」ことを決定的に確認できる。
      let releaseReview: (() => void) | undefined
      const reviewStarted = new Promise<void>((resolveStarted) => {
        designReviewMocks.execute.mockImplementation(async (input: string) => {
          resolveStarted()
          await new Promise<void>((resolveHeld) => { releaseReview = resolveHeld })
          return { ok: true, timedOut: false, stdout: stdoutForReviewInput(input) }
        })
      })

      const res = await app.inject({
        method: 'POST', url: '/api/task-continuations/reconcile',
      })

      // sweepはawaitされない。design reviewは最大120sかかりうるため、ここを待つと
      // Worker側がOutbox再送にもqueued Job取得にも到達できなくなる。
      expect(res.statusCode).toBe(202)
      expect(JSON.parse(res.body)).toMatchObject({ accepted: true })

      // 応答時点で design review はまだ解放していない = sweep は未完了。
      await reviewStarted
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(0)

      // 解放すれば回収自体は非同期に完走する。
      releaseReview?.()
      await waitFor(() => storage.jobs.findByTaskId(nextTask.id).length === 1)
    } finally {
      await app.close()
    }
  })

  it('sweep実行中に再度呼ばれてもin-flight guardで重複起動しない', async () => {
    const app = await buildApp()
    try {
      const { project, sourceTask, storage } = await createRunningProjectWithTask(app)
      const { nextTask } = await seedPendingContinuation(storage, project.id, sourceTask.id)

      let releaseReview: (() => void) | undefined
      const reviewStarted = new Promise<void>((resolveStarted) => {
        designReviewMocks.execute.mockImplementation(async (input: string) => {
          resolveStarted()
          await new Promise<void>((resolveHeld) => { releaseReview = resolveHeld })
          return { ok: true, timedOut: false, stdout: stdoutForReviewInput(input) }
        })
      })

      const callsBefore = designReviewMocks.execute.mock.calls.length

      const first = await app.inject({ method: 'POST', url: '/api/task-continuations/reconcile' })
      expect(first.statusCode).toBe(202)
      expect(JSON.parse(first.body)).toMatchObject({ accepted: true })
      await reviewStarted

      // Worker は POLL_INTERVAL_MS(5s) ごとに呼ぶが、design review は最大120sかかる。
      // guard が無いと同一 continuation に対する sweep が積み上がる。
      const second = await app.inject({ method: 'POST', url: '/api/task-continuations/reconcile' })
      expect(second.statusCode).toBe(202)
      expect(JSON.parse(second.body)).toMatchObject({ accepted: false })

      releaseReview?.()
      await waitFor(() => storage.jobs.findByTaskId(nextTask.id).length === 1)

      // 2回POSTしてもdesign reviewの起動は1回だけ。
      expect(designReviewMocks.execute.mock.calls.length - callsBefore).toBe(1)
    } finally {
      await app.close()
    }
  })
})
