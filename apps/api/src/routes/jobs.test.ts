import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { setCredentialClass } from '../auth/credentialClass'
import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeJobUpdate, type DesignReviewEvidence, type Job, type Project, type Task } from '@ai-team/shared'
import { appendImplementContracts } from '../implementPrompt'

async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { taskRoutes }, { jobRoutes }, { designReviewEvidenceRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./tasks.js'),
    import('./jobs.js'),
    import('./designReviewEvidence.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  // C-1: the Worker's result delivery is authenticated as the Worker (apiTokenAuth sets the class in
  // production). These route tests have no auth plugin, so stand in for it on the Worker's PATCH /api/jobs/:id.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'PATCH' && /^\/api\/jobs\/[^/?]+(\?|$)/.test(req.url)) setCredentialClass(req, 'worker')
  })
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  // Design Review runner を**必ず注入する**。既定の `buildDefaultCoordinatorDeps()` は
  // 実 subprocess を spawn し、実 LLM provider を呼ぶ。そのため resume 経路のテストが
  // 「LLM がその時どう判定したか」に依存し、環境によって結果が変わっていた
  // （2026-09-14 に production VPS で実測: restricted env では review が ALIGNED を返して
  // resume が成立し 201、full env では UNCERTAIN で 409。どちらも route としては正しい挙動で、
  // 非決定なのはテスト側だった）。
  //
  // ここでは「review を完了できなかった」を決定論的に再現する。これにより
  // **review が成立しない限り resume させない**という fail-closed 契約そのものを固定できる。
  // 既に `tasks.test.ts` / `resumeExpiredApproval.test.ts` が使っている注入口を再利用しており、
  // 新しい仕組みは追加していない。
  app.register(taskRoutes, {
    prefix: '/api/tasks',
    resumeDesignReviewDeps: {
      runnerCommand: 'mock',
      runnerArgs: [],
      homeDirectory: '/tmp',
      workingDir: '/tmp',
      execute: async () => ({
        ok: false,
        stdout: '',
        error: 'design review runner is not available in tests',
        timedOut: false,
      }),
    },
  })
  app.register(jobRoutes, { prefix: '/api/jobs' })
  app.register(designReviewEvidenceRoutes, { prefix: '/api' })
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

type OutboxJobResponse = Job & { outbox?: { eventId: string; deduplicated: boolean } }

type DesignReviewEvidenceOverrides = Partial<Pick<
  DesignReviewEvidence,
  'reviewLoad' | 'decision' | 'independentReviewRequired' | 'independentReviewVerdict'
>>

function calculatePayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalizeJobUpdate(payload))
    .digest('hex')
}

function withOutbox<T extends Record<string, unknown>>(payload: T, eventId: string): T & { eventId: string; payloadHash: string } {
  return {
    ...payload,
    eventId,
    payloadHash: calculatePayloadHash(payload),
  }
}

async function createProject(app: FastifyInstance, body: Partial<Project> = {}): Promise<Project> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Test',
      goal: 'Test goal',
      designPhilosophy: [],
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Project>(res.body)
}

async function createTask(
  _app: FastifyInstance,
  projectId: string,
  body: Partial<Task> = {},
): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().tasks.create({
    projectId,
    title: 'Task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    ...body,
  })
}

async function createDesignReviewEvidence(
  app: FastifyInstance,
  task: Task,
  designText: string,
  overrides: DesignReviewEvidenceOverrides = {},
): Promise<DesignReviewEvidence> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/design-review-evidence',
    payload: {
      taskId: task.id,
      designText,
      reviewLoad: 'medium',
      decision: 'ALIGNED',
      independentReviewRequired: false,
      ...overrides,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<DesignReviewEvidence>(res.body)
}

async function createJob(
  app: FastifyInstance,
  task: Task,
  body: Partial<Job> = {},
): Promise<Job> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    payload: {
      taskId: task.id,
      projectId: task.projectId,
      agentRole: 'developer_ai',
      safeCommand: { kind: 'git_status' },
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Job>(res.body)
}

async function createTestWorkflowImplementJob(
  app: FastifyInstance,
  task: Task,
  prompt = 'Implement the approved requirement.',
): Promise<Job> {
  await createDesignReviewEvidence(app, task, prompt)
  const { getStorage } = await import('../storage/index.js')
  return getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    workflowStepKey: `task:${task.id}:initial-implement`,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliPrompt: prompt,
    aiCliMode: 'implement',
  })
}

async function createStoredImplementJob(
  task: Task,
  prompt: string,
  status: Job['status'] = 'failed',
): Promise<Job> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status,
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'codex',
    aiCliPrompt: prompt,
    aiCliMode: 'implement',
  })
}

function providerTimeoutFailure(
  workspaceState: 'unchanged' | 'changed' | 'unknown' = 'unchanged',
): Record<string, unknown> {
  return {
    status: 'failed',
    exitCode: 1,
    stderr: 'provider command timed out',
    changedFiles: [],
    guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    failureMetadata: {
      kind: 'provider_timeout',
      workspaceState,
    },
  }
}

async function createProducedTimeoutRetry(
  app: FastifyInstance,
  task: Task,
  prompt: string,
  workflowStepKey?: string,
): Promise<{ source: Job; retry: Job }> {
  await createDesignReviewEvidence(app, task, prompt)
  const { getStorage } = await import('../storage/index.js')
  const source = getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    ...(workflowStepKey === undefined ? {} : { workflowStepKey }),
    agentRole: 'developer_ai',
    status: 'running',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'codex',
    aiCliPrompt: prompt,
    aiCliMode: 'implement',
  })

  const timeout = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${source.id}`,
    payload: providerTimeoutFailure(),
  })
  expect(timeout.statusCode).toBe(200)

  const retry = getStorage().jobs.findByTaskId(task.id).find((job) => job.id !== source.id)
  if (!retry) throw new Error('Provider timeout retry Job was not created')
  return { source, retry }
}

const successfulChangedImplementResult = {
  status: 'success' as const,
  exitCode: 0,
  changedFiles: ['src/retry-result.ts'],
  guardResult: { permissionAllowed: true, fileChangeAllowed: true },
}

async function createApprovalRequestWithStatus(
  task: Task,
  status: 'WAITING_FOR_USER' | 'REJECTED',
): Promise<void> {
  const { getStorage } = await import('../storage/index.js')
  getStorage().approvalRequests.create({
    taskId: task.id,
    targetBranch: 'main',
    targetCommit: 'commit-hash',
    targetDiffHash: 'diff-hash',
    riskLevel: 'HIGH',
    requestedAction: 'test',
    status,
    expiresAt: '2099-01-01T00:00:00.000Z',
    invalidIf: [],
  })
}

async function createAutomaticReviewJob(
  app: FastifyInstance,
): Promise<{ implement: Job; project: Project; review: Job; task: Task }> {
  const project = await createProject(app)
  const taskResponse = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: {
      projectId: project.id,
      title: 'Structured review task',
      description: 'Implement the approved requirement.',
      assignee: 'developer_ai',
    },
  })
  expect(taskResponse.statusCode).toBe(201)
  const task = parseBody<Task>(taskResponse.body)
  const implement = await createTestWorkflowImplementJob(app, task)
  const implementResult = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${implement.id}`,
    payload: withOutbox({
      status: 'success',
      exitCode: 0,
      changedFiles: ['src/feature.ts'],
      guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    }, randomUUID()),
  })
  expect(implementResult.statusCode).toBe(200)
  const jobs = parseBody<Job[]>((await app.inject({
    method: 'GET',
    url: `/api/jobs?taskId=${task.id}`,
  })).body)
  const review = jobs.find((job) => job.aiCliMode === 'review')
  if (!review) throw new Error('Automatic review Job was not created')
  return { implement, project, review, task }
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
})

describe('Job API', () => {
  it('rejects value-bearing Technical Abort refusal text at the HTTP boundary', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/jobs/missing/abort-cleanup-result',
        payload: { refusalCode: 'provider returned secret=value' },
      })
      expect(response.statusCode).toBe(400)
    })
  })

  it('retires and quarantines a refused Technical Abort cleanup marker exactly once', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { status: 'blocked', roadmapActive: true })
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const job = storage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        workspaceBaseline: { mode: 'clean', startCommitHash: '0805249b' },
        failureMetadata: {
          abortCleanupRequestedAt: '2026-10-08T00:00:00.000Z',
          abortTechnicalEvidenceId: 'evidence-1',
          abortTechnicalStateFingerprint: 'fingerprint-1',
          abortTechnicalRootCauseClass: 'protected_path',
          abortTechnicalAttentionKind: 'job_failed',
        },
      } as Parameters<typeof storage.jobs.create>[0])

      // Worker は拒否でも carrier の現在の cleanup generation を名指す。
      const cleanupGeneration = {
          abortCleanupRequestedAt: '2026-10-08T00:00:00.000Z',
          abortTechnicalEvidenceId: 'evidence-1',
          abortTechnicalStateFingerprint: 'fingerprint-1',
        }
      const first = await app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/abort-cleanup-result`,
        payload: { refusalCode: 'CLEANUP_EXECUTION_FAILED', cleanupGeneration },
      })
      expect(first.statusCode).toBe(409)
      expect(storage.jobs.findById(job.id)?.failureMetadata).toMatchObject({
        quarantined: true,
        quarantineReason: 'technical abort cleanup refused (CLEANUP_EXECUTION_FAILED)',
      })
      expect(storage.jobs.findById(job.id)?.failureMetadata?.abortCleanupRequestedAt).toBeUndefined()
      expect(storage.jobs.findById(job.id)?.failureMetadata?.abortTechnicalEvidenceId).toBeUndefined()

      const second = await app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/abort-cleanup-result`,
        payload: { refusalCode: 'CLEANUP_EXECUTION_FAILED', cleanupGeneration },
      })
      expect(second.statusCode).toBe(409)
      expect(storage.auditLog.findByEntity('task', task.id).filter(
        (entry) => entry.operation === 'technical_abort_refused',
      )).toHaveLength(1)
    })
  })

  // Codex review 57f2cf6: 遅れて届いた generation 1 の拒否が generation 2 を退役・quarantine させない。
  it('a delayed refusal of an older generation is GENERATION_MISMATCH and leaves the current generation intact', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { status: 'blocked', roadmapActive: true })
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const generation2 = {
        abortCleanupRequestedAt: '2026-10-09T00:00:00.000Z',
        abortTechnicalEvidenceId: 'evidence-2',
        abortTechnicalStateFingerprint: 'fingerprint-2',
        abortTechnicalRootCauseClass: 'protected_path',
        abortTechnicalAttentionKind: 'job_failed',
      }
      const job = storage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        workspaceBaseline: { mode: 'clean', startCommitHash: '0805249b' },
        failureMetadata: generation2,
      } as Parameters<typeof storage.jobs.create>[0])

      for (const payload of [
        { refusalCode: 'CLEANUP_EXECUTION_FAILED', cleanupGeneration: {
          abortCleanupRequestedAt: '2026-10-08T00:00:00.000Z',
          abortTechnicalEvidenceId: 'evidence-1',
          abortTechnicalStateFingerprint: 'fingerprint-1',
        } },
        { refusalCode: 'CLEANUP_EXECUTION_FAILED' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/jobs/${job.id}/abort-cleanup-result`,
          payload,
        })
        expect(response.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(response.body).code).toBe('GENERATION_MISMATCH')
      }
      expect(storage.jobs.findById(job.id)?.failureMetadata).toEqual(generation2)
      expect(storage.auditLog.findByEntity('task', task.id).filter(
        (entry) => entry.operation === 'technical_abort_refused',
      )).toHaveLength(0)
    })
  })

  it('a Technical Abort cleanup result naming another generation is refused as GENERATION_MISMATCH without quarantine', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id, { status: 'blocked', roadmapActive: true })
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const metadata = {
        abortCleanupRequestedAt: '2026-10-08T00:00:00.000Z',
        abortTechnicalEvidenceId: 'evidence-2',
        abortTechnicalStateFingerprint: 'fingerprint-2',
        abortTechnicalRootCauseClass: 'protected_path',
        abortTechnicalAttentionKind: 'job_failed',
      }
      const job = storage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'failed',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        workspaceBaseline: { mode: 'clean', startCommitHash: '0805249b' },
        failureMetadata: metadata,
      } as Parameters<typeof storage.jobs.create>[0])
      const observation = { mode: 'clean', startCommitHash: '0805249b' }
      const knownGood = {
        gitOperationMarkers: [], worktreeClean: true, indexClean: true, headValid: true, blindSpotsAbsent: true,
      }

      for (const cleanupGeneration of [
        { abortCleanupRequestedAt: '2026-10-07T00:00:00.000Z', abortTechnicalEvidenceId: 'evidence-1', abortTechnicalStateFingerprint: 'fingerprint-1' },
        undefined,
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/jobs/${job.id}/abort-cleanup-result`,
          payload: {
            observation,
            knownGood,
            preCleanupObservation: observation,
            cleanupSummary: { changedPathCount: 0, restoredPathCount: 0, removedPathCount: 0 },
            ...(cleanupGeneration !== undefined ? { cleanupGeneration } : {}),
          },
        })
        expect(response.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(response.body).code).toBe('GENERATION_MISMATCH')
      }
      // 何も変えていない: 現在の generation も残り、quarantine もしない。
      expect(storage.jobs.findById(job.id)?.failureMetadata).toEqual(metadata)
      expect(storage.auditLog.findByEntity('task', task.id).filter(
        (entry) => entry.operation === 'technical_abort_refused',
      )).toHaveLength(0)
    })
  })

  it('GET /api/jobs returns 400 without taskId', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs' })

      expect(res.statusCode).toBe(400)
      expect(parseBody<{ error: string }>(res.body).error).toBe('taskId is required')
    })
  })

  it('GET /api/jobs returns 404 for a missing task', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs?taskId=not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Task not found')
    })
  })

  it('POST /api/jobs creates a queued job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          safeCommand: { kind: 'git_status' },
          dryRun: true,
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Job>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.taskId).toBe(task.id)
      expect(body.status).toBe('queued')
      expect(body.safeCommand.kind).toBe('git_status')
      // workingDir はクライアントから受け取らず、サーバー側の正規workingDirが設定される
      expect(body.safeCommand.workingDir).toBe('/workspace/target')
      expect(body.dryRun).toBe(true)
    })
  })

  it('POST /api/jobs returns 404 for a missing task', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: 'not-exist',
          projectId: project.id,
          agentRole: 'developer_ai',
          safeCommand: { kind: 'git_status' },
        },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Task not found')
    })
  })

  it('POST /api/jobs returns 409 for a task in an archived project', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'archived' })
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          safeCommand: { kind: 'git_status' },
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project is archived')
    })
  })

  it('POST /api/jobs creates a queued job for a task in a paused project', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'paused' })
      const task = await createTask(app, project.id)

      const job = await createJob(app, task)

      expect(job.projectId).toBe(project.id)
      expect(job.status).toBe('queued')
    })
  })

  it('POST /api/jobs refuses a projectId that differs from the Task Project (W5)', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const other = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { taskId: task.id, projectId: other.id, agentRole: 'developer_ai', safeCommand: { kind: 'git_status' } },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_PROJECT_MISMATCH')
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id)).toEqual([])
    })
  })

  // running -> draft は queued Job がある間は lifecycle guard が拒否するので、到達できる停止は paused だけ。
  it.each(['paused'] as const)(
    'PATCH queued -> running is refused with 409 while the Task Project is %s; the Job stays queued (W5)',
    async (status) => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const job = await createJob(app, task)
        // Worker の poll の後・claim の前に CEO が止めた。
        const { getStorage } = await import('../storage/index.js')
        getStorage().projects.update(project.id, { status })

        const res = await app.inject({
          method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'running' },
        })

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_CLAIM_REFUSED')
        expect(getStorage().jobs.findById(job.id)?.status).toBe('queued')
      })
    },
  )

  // lifecycle repair C2: 適用しない遷移を 200 で「成功したように」見せない。200 + no-op は
  // Outbox 配送（eventId 付き。at-least-once の遅延・重複 result）にだけ使う。
  describe('PATCH with a non-applicable transition', () => {
    async function storedJob(status: 'blocked' | 'failed' | 'success') {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
      const task = storage.tasks.create({
        projectId: project.id, title: 'T', description: '', status: 'blocked', assignee: 'developer_ai', dependencies: [],
      })
      const job = storage.jobs.create({
        taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status,
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      } as Parameters<typeof storage.jobs.create>[0])
      return { storage, job }
    }

    it('a direct blocked -> failed is refused with 409 JOB_TRANSITION_NOT_APPLICABLE and nothing changes', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('blocked')

        const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'failed', stderr: 'x' } })

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string; error: string }>(res.body)).toMatchObject({ code: 'JOB_TRANSITION_NOT_APPLICABLE' })
        expect(storage.jobs.findById(job.id)).toMatchObject({ status: 'blocked' })
        expect(storage.jobs.findById(job.id)?.stderr).toBeUndefined()
      })
    })

    it('a direct claim of an already-terminal Job is refused with the definitive JOB_CLAIM_REFUSED (the Worker must not run it)', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('failed')

        const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'running' } })

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_CLAIM_REFUSED')
        expect(storage.jobs.findById(job.id)?.status).toBe('failed')
      })
    })

    it('an Outbox delivery (eventId) of a stale terminal result keeps the at-least-once contract: 200, status not applied', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('success')

        const res = await app.inject({
          method: 'PATCH', url: `/api/jobs/${job.id}`,
          payload: withOutbox({ status: 'failed', stderr: 'late' }, 'stale-terminal-result'),
        })

        expect(res.statusCode).toBe(200)
        expect(storage.jobs.findById(job.id)?.status).toBe('success')
      })
    })
  })

  // lifecycle repair C3: 適用できない Outbox 配送は「適用済み・何も適用しない」で受ける（H-02 の一般化）。
  describe('a non-applicable Outbox delivery is acknowledged and applies nothing (lifecycle repair C3)', () => {
    async function storedJob(status: 'running' | 'success') {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
      const task = storage.tasks.create({
        projectId: project.id, title: 'T', description: '', status: 'in_progress', assignee: 'developer_ai', dependencies: [],
      })
      const job = storage.jobs.create({
        taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status,
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      } as Parameters<typeof storage.jobs.create>[0])
      return { storage, job }
    }

    it('operator ends a running Job, then the Worker resends its terminal event with a fingerprint: 200, nothing applied, event recorded', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('running')
        const operator = await app.inject({
          method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'failed', stderr: 'operator stopped it' },
        })
        expect(operator.statusCode).toBe(200)
        const before = storage.jobs.findById(job.id)

        const workerEvent = withOutbox({
          status: 'success', exitCode: 0, stderr: 'worker result', commitHash: 'abc1234',
          failureMetadata: { workspaceEndFingerprint: { mode: 'clean' as const, startCommitHash: '0805249b' } },
        }, 'evt-after-operator')
        const first = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: workerEvent })

        // 以前は fingerprint の running-only 検査が先に 409 を返し、再送が永久に 409 だった。
        expect(first.statusCode).toBe(200)
        expect(parseBody<OutboxJobResponse>(first.body)).toMatchObject({
          status: 'failed', outbox: { eventId: 'evt-after-operator', deduplicated: false },
        })
        expect(storage.jobs.findById(job.id)).toEqual(before)

        // event は適用済みとして記録されたので、再送は deduplicated（Worker は event を捨てられる）。
        const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: workerEvent })
        expect(replay.statusCode).toBe(200)
        expect(parseBody<OutboxJobResponse>(replay.body).outbox).toEqual({ eventId: 'evt-after-operator', deduplicated: true })
        expect(storage.jobs.findById(job.id)).toEqual(before)
      })
    })

    // lifecycle repair final: 同じ status への配送も適用できない配送として受ける。以前は same-status を
    // 除外していたため running-only の fingerprint 検査で 409 になり、再送が永久に 409 → Worker の intake 停止。
    it.each(['failed'] as const)(
      'operator ends a running Job as %s, then the Worker delivers the same status with a fingerprint: 200, nothing applied, event recorded',
      async (status) => {
        await withApp(async (app) => {
          const { storage, job } = await storedJob('running')
          const operator = await app.inject({
            method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status, stderr: 'operator ended it' },
          })
          expect(operator.statusCode).toBe(200)
          const before = storage.jobs.findById(job.id)
          expect(before?.status).toBe(status)

          const workerEvent = withOutbox({
            status, exitCode: 1, stderr: 'worker result',
            failureMetadata: { workspaceEndFingerprint: { mode: 'clean' as const, startCommitHash: '0805249b' } },
          }, `evt-same-${status}`)
          const first = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: workerEvent })

          expect(first.statusCode).toBe(200)
          expect(parseBody<OutboxJobResponse>(first.body)).toMatchObject({
            status, outbox: { eventId: `evt-same-${status}`, deduplicated: false },
          })
          expect(storage.jobs.findById(job.id)).toEqual(before)
          expect(storage.jobs.findById(job.id)?.failureMetadata?.workspaceEndFingerprint).toBeUndefined()

          // 完全な再送は deduplicated（acknowledge と同じ記録を見る）。
          const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: workerEvent })
          expect(replay.statusCode).toBe(200)
          expect(parseBody<OutboxJobResponse>(replay.body).outbox).toEqual({ eventId: `evt-same-${status}`, deduplicated: true })
          expect(storage.jobs.findById(job.id)).toEqual(before)
        })
      },
    )

    // R-FINAL-OPPATCH: success は Worker の結果配送（Outbox event）だけが書ける。operator の直接 success は
    // 409 で断られ、何も変えない。その後に届く Worker の本物の success は通常どおり適用される
    // （以前は operator の success が先に立ち、Worker の結果は ack されるだけで捨てられていた）。
    it.each(['queued', 'running'] as const)(
      'a direct success on a %s Job is refused with 409 JOB_SUCCESS_REQUIRES_WORKER_RESULT; the Worker delivery then applies',
      async (from) => {
        await withApp(async (app) => {
          const { storage, job } = await storedJob('running')
          if (from === 'queued') storage.jobs.update(job.id, { status: 'queued' })
          const before = storage.jobs.findById(job.id)

          const operator = await app.inject({
            method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'success', stderr: 'operator ended it' },
          })
          expect(operator.statusCode).toBe(409)
          expect(parseBody<{ code: string }>(operator.body).code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
          expect(storage.jobs.findById(job.id)).toEqual(before)

          const fingerprint = { mode: 'clean' as const, startCommitHash: '0805249b' }
          // end fingerprint は running → terminal にしか載らない（queued からの直行報告は fingerprint を持たない）。
          const workerEvent = withOutbox({
            status: 'success', exitCode: 0, stdout: 'worker result',
            ...(from === 'running' ? { failureMetadata: { workspaceEndFingerprint: fingerprint } } : {}),
          }, `evt-after-refused-${from}`)
          const delivered = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: workerEvent })
          expect(delivered.statusCode).toBe(200)
          const after = storage.jobs.findById(job.id)
          expect(after?.status).toBe('success')
          expect(after?.stdout).toBe('worker result')
          if (from === 'running') expect(after?.failureMetadata?.workspaceEndFingerprint).toEqual(fingerprint)
        })
      },
    )

    // C-1 (Codex review): every success needs the Worker's Outbox delivery, even when the Job is already success.
    it('a direct success write to an already-successful Job is refused and changes nothing', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('success')
        const before = storage.jobs.findById(job.id)
        const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'success' } })
        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
        expect(storage.jobs.findById(job.id)).toEqual(before)
      })
    })

    it('a legitimate running -> terminal Outbox delivery with a fingerprint still applies', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('running')
        const fingerprint = { mode: 'clean' as const, startCommitHash: '0805249b' }

        const res = await app.inject({
          method: 'PATCH', url: `/api/jobs/${job.id}`,
          payload: withOutbox({ status: 'failed', exitCode: 1, stderr: 'worker result', failureMetadata: { workspaceEndFingerprint: fingerprint } }, 'evt-legit-terminal'),
        })

        expect(res.statusCode).toBe(200)
        const after = storage.jobs.findById(job.id)
        expect(after?.status).toBe('failed')
        expect(after?.stderr).toBe('worker result')
        expect(after?.failureMetadata?.workspaceEndFingerprint).toEqual(fingerprint)
      })
    })

    it('a stale failed + quarantined result on a success row does not make the row "success but quarantined"', async () => {
      await withApp(async (app) => {
        const { storage, job } = await storedJob('success')
        const before = storage.jobs.findById(job.id)

        const res = await app.inject({
          method: 'PATCH', url: `/api/jobs/${job.id}`,
          payload: withOutbox({
            status: 'failed', stderr: 'late', guardResult: { permissionAllowed: true, fileChangeAllowed: false },
            failureMetadata: { kind: 'workspace_baseline_failure', quarantined: true, quarantineReason: 'late dirt' },
          }, 'evt-stale-quarantine'),
        })

        expect(res.statusCode).toBe(200)
        const after = storage.jobs.findById(job.id)
        expect(after).toEqual(before)
        expect(after?.failureMetadata?.quarantined).not.toBe(true)
        expect(after?.stderr).toBeUndefined()
      })
    })
  })

  describe('claim guard: another Task that is a live workspace owner (W5)', () => {
    async function setup(app: FastifyInstance) {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const project = await createProject(app, { status: 'running' })
      const paused = await createProject(app, { status: 'paused' })
      const task = await createTask(app, project.id)
      const job = await createJob(app, task)
      const otherTask = await createTask(app, paused.id)
      return { storage, task, job, otherTask, pausedId: paused.id }
    }

    async function claim(app: FastifyInstance, jobId: string) {
      return app.inject({ method: 'PATCH', url: `/api/jobs/${jobId}`, payload: { status: 'running' } })
    }

    it.each([
      ['a concurrent non-initial queued Job', 'queued', true],
      ['a running Job', 'running', false],
    ] as const)('refuses the claim while another Task (paused Project) has %s', async (_label, status, resumeKey) => {
      await withApp(async (app) => {
        const { storage, job, otherTask, pausedId } = await setup(app)
        const key = resumeKey ? `resume:src-${otherTask.id}:1` : undefined
        storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
          ...(key !== undefined ? { workflowStepKey: key } : {}),
        } as Parameters<typeof storage.jobs.create>[0])

        const res = await claim(app, job.id)

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_CLAIM_REFUSED')
        expect(storage.jobs.findById(job.id)?.status).toBe('queued')
      })
    })

    it("refuses the claim when another Task's queued Job became blocked (pre-start refusal) after the snapshot", async () => {
      // queued -> blocked は running を経ずに起こる（開始前の拒否は blocked + quarantine になる）。
      await withApp(async (app) => {
        const { storage, job, otherTask, pausedId } = await setup(app)
        const other = storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'queued',
          workflowStepKey: `task:${otherTask.id}:initial-implement`,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        const blocked = await app.inject({
          method: 'PATCH', url: `/api/jobs/${other.id}`, payload: { status: 'blocked', stderr: 'refused before start' },
        })
        expect(blocked.statusCode).toBe(200)
        expect(storage.jobs.findById(other.id)?.status).toBe('blocked')

        const res = await claim(app, job.id)

        expect(res.statusCode).toBe(409)
        expect(storage.jobs.findById(job.id)?.status).toBe('queued')
      })
    })

    // lifecycle repair C2: done な Task の非 quarantine blocked 行は shared `holdsWorkspaceWhenBlocked` では
    // 所有者ではない（stale 候補）。解放は Worker の worktree 観測、dirty の保護は baseline admission。
    // 以前はここで 409 を返し、Worker が解放した後も claim が永久に止まった（出口なし）。
    it('a legacy blocked row on a done Task elsewhere does not refuse the claim, and systemState reports no stalled owner for it', async () => {
      await withApp(async (app) => {
        const { buildSystemState } = await import('../state/systemState.js')
        const { storage, job, pausedId } = await setup(app)
        const doneTask = storage.tasks.create({
          projectId: pausedId, title: 'Done', description: '', status: 'done',
          assignee: 'developer_ai', dependencies: [],
        })
        storage.jobs.create({
          taskId: doneTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'blocked',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])

        // claim の前の観測: claim を止める所有者が居ないので attention は出ない（guard と同じ意味）。
        expect(buildSystemState(storage).attention
          .some((item) => item.kind === 'workspace_held_by_stalled_owner')).toBe(false)
        expect((await claim(app, job.id)).statusCode).toBe(200)
        expect(storage.jobs.findById(job.id)?.status).toBe('running')
      })
    })

    // Codex review (C2): park は全 Job の終端化と観測済みの clean 解放を要求するので、park された
    // Task に残る非 quarantine の blocked 行は done Task の行と同じ legacy 行。以前は resume / abort /
    // PATCH / reconcile のどれも通らず、claim が永久に止まった。
    it('a legacy blocked row on a parked Task elsewhere does not refuse the claim; no stalled-owner attention; GET /api/tasks reports parked', async () => {
      await withApp(async (app) => {
        const { buildSystemState } = await import('../state/systemState.js')
        const { storage, job, pausedId } = await setup(app)
        const parkedTask = storage.tasks.create({
          projectId: pausedId, title: 'Parked', description: '', status: 'pending',
          assignee: 'developer_ai', dependencies: [], roadmapActive: false,
        } as Parameters<typeof storage.tasks.create>[0])
        storage.auditLog.record({
          actor: 'api', operation: 'task_aborted', entityType: 'task', entityId: parkedTask.id, result: 'success',
        })
        storage.jobs.create({
          taskId: parkedTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'blocked',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])

        const listed = parseBody<Array<{ id: string; parked?: boolean }>>(
          (await app.inject({ method: 'GET', url: `/api/tasks?projectId=${pausedId}` })).body)
        expect(listed.find((task) => task.id === parkedTask.id)?.parked).toBe(true)
        expect(buildSystemState(storage).attention
          .some((item) => item.kind === 'workspace_held_by_stalled_owner')).toBe(false)
        expect((await claim(app, job.id)).statusCode).toBe(200)
      })
    })

    // Codex review (C2): quarantine が優先する。startup reconciliation は quarantine された source を
    // 意図的に blocked のまま残し、Worker はすべての quarantine 行を所有者とするので、API も同じにする。
    it('a quarantined blocked source superseded by a human resume is still an owner: claim refused, workspace_quarantined raised', async () => {
      await withApp(async (app) => {
        const { recordResumeActor } = await import('../designReview/resumeActor.js')
        const { buildSystemState } = await import('../state/systemState.js')
        const { storage, job, otherTask, pausedId } = await setup(app)
        const source = storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'blocked',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        storage.jobs.update(source.id, { failureMetadata: { quarantined: true, quarantineReason: 'unverified' } })
        const successor = storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'success',
          workflowStepKey: `resume:${source.id}:1`,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        recordResumeActor(storage, { jobId: successor.id, taskId: otherTask.id, actorClass: 'human', evidence: 'admin_credential' })

        expect(buildSystemState(storage).attention
          .some((item) => item.kind === 'workspace_quarantined' && item.jobId === source.id)).toBe(true)
        expect((await claim(app, job.id)).statusCode).toBe(409)
        expect(storage.jobs.findById(job.id)?.status).toBe('queued')
      })
    })

    it('a quarantined blocked row on a done Task elsewhere is still an owner', async () => {
      await withApp(async (app) => {
        const { storage, job, pausedId } = await setup(app)
        const doneTask = storage.tasks.create({
          projectId: pausedId, title: 'Done', description: '', status: 'done',
          assignee: 'developer_ai', dependencies: [],
        })
        const row = storage.jobs.create({
          taskId: doneTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'blocked',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        storage.jobs.update(row.id, { failureMetadata: { quarantined: true, quarantineReason: 'unverified' } })

        expect((await claim(app, job.id)).statusCode).toBe(409)
        expect(storage.jobs.findById(job.id)?.status).toBe('queued')
      })
    })

    it('a blocked source superseded by a human resume (successor finished) is not an owner', async () => {
      await withApp(async (app) => {
        const { recordResumeActor } = await import('../designReview/resumeActor.js')
        const { storage, job, otherTask, pausedId } = await setup(app)
        const source = storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'blocked',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        const successor = storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'success',
          workflowStepKey: `resume:${source.id}:1`,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        recordResumeActor(storage, { jobId: successor.id, taskId: otherTask.id, actorClass: 'human', evidence: 'admin_credential' })

        expect((await claim(app, job.id)).statusCode).toBe(200)
      })
    })

    it('a fresh initial-implement queued elsewhere is not an owner', async () => {
      await withApp(async (app) => {
        const { storage, job, otherTask, pausedId } = await setup(app)
        storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'queued',
          workflowStepKey: `task:${otherTask.id}:initial-implement`,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])

        expect((await claim(app, job.id)).statusCode).toBe(200)
        expect(storage.jobs.findById(job.id)?.status).toBe('running')
      })
    })

    it("the claiming Task's own queued Jobs are not a blocker", async () => {
      await withApp(async (app) => {
        const { storage, task, job } = await setup(app)
        storage.jobs.create({
          taskId: task.id, projectId: task.projectId, agentRole: 'developer_ai', status: 'queued',
          workflowStepKey: `resume:${job.id}:1`,
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])

        expect((await claim(app, job.id)).statusCode).toBe(200)
      })
    })

    it('Jobs in an archived Project are not owners', async () => {
      await withApp(async (app) => {
        const { storage, job } = await setup(app)
        const archived = await createProject(app, { status: 'archived' })
        const archivedTask = await createTask(app, archived.id)
        storage.jobs.create({
          taskId: archivedTask.id, projectId: archived.id, agentRole: 'developer_ai', status: 'running',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])

        expect((await claim(app, job.id)).statusCode).toBe(200)
      })
    })

    it('a refused Outbox-tagged claim is not recorded as applied: the replay is refused again (409)', async () => {
      await withApp(async (app) => {
        const { storage, job, otherTask, pausedId } = await setup(app)
        storage.jobs.create({
          taskId: otherTask.id, projectId: pausedId, agentRole: 'developer_ai', status: 'running',
          safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        } as Parameters<typeof storage.jobs.create>[0])
        const payload = withOutbox({ status: 'running' as const, startedAt: '2026-08-08T01:02:03.000Z' }, 'event-refused-claim')

        for (let i = 0; i < 2; i += 1) {
          const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload })
          expect(res.statusCode).toBe(409)
          expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_CLAIM_REFUSED')
          expect(storage.jobs.findById(job.id)?.status).toBe('queued')
        }
      })
    })
  })

  it('PATCH queued -> running still succeeds for a running Project', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const job = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'running' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).status).toBe('running')
    })
  })

  it('POST /api/jobs rejects a client-supplied workingDir with 400', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          safeCommand: { kind: 'git_status', workingDir: '/some/other/path' },
        },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it('GET /api/jobs lists task jobs', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Job[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].taskId).toBe(task.id)
    })
  })

  it('GET /api/jobs excludes queued Jobs while the workspace is quarantined', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const { getStorage } = await import('../storage/index.js')
      // 未検証 workspace: crash復旧時に quarantine された Job（所有権保持・blocked）
      getStorage().jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'blocked',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        failureMetadata: {
          quarantined: true,
          quarantineReason: 'workspace not verified safe after crash',
        },
      })
      await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${task.id}` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Job[]>(res.body)
      // Worker（fetchQueuedJob）は status==='queued' を選ぶため、quarantine中は新規作業を渡さない
      expect(body.some((job) => job.status === 'queued')).toBe(false)
      expect(body).toHaveLength(1)
      expect(body[0].failureMetadata?.quarantined).toBe(true)
    })
  })

  it('GET /api/jobs/:id returns a job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).id).toBe(created.id)
    })
  })

  it('persists aiCliProvider/aiCliPrompt/aiCliMode with Task and Design Contracts across a DB round-trip', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const prompt = 'Implement the requested change carefully.'
      await createDesignReviewEvidence(app, task, appendImplementContracts(prompt, task))
      const created = await createJob(app, task, {
        aiCliProvider: 'codex',
        aiCliPrompt: prompt,
        aiCliMode: 'implement',
      })

      // POSTのレスポンスは作成直後のin-memoryオブジェクトを返すだけの可能性があるため、
      // 別リクエストでDBから再取得し、永続化が実際に効いていることを確認する
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

      expect(res.statusCode).toBe(200)
      const fetched = parseBody<Job>(res.body)
      expect(fetched.aiCliProvider).toBe('codex')
      expect(fetched.aiCliPrompt).toContain('Implement the requested change carefully.')
      expect(fetched.aiCliPrompt).toContain('[Task Contract]')
      expect(fetched.aiCliPrompt).toContain('"acceptanceCriteria": []')
      expect(fetched.aiCliPrompt).toContain('"allowedPaths": []')
      expect(fetched.aiCliPrompt).toContain('## Design Contract')
      expect(fetched.aiCliPrompt).toContain('current implementation is evidence, not specification')
      expect(fetched.aiCliMode).toBe('implement')
    })
  })

  it('leaves aiCliProvider/aiCliPrompt/aiCliMode undefined when omitted (backward compatibility)', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

      expect(res.statusCode).toBe(200)
      const fetched = parseBody<Job>(res.body)
      expect(fetched.aiCliProvider).toBeUndefined()
      expect(fetched.aiCliPrompt).toBeUndefined()
      expect(fetched.aiCliMode).toBeUndefined()
    })
  })

  it('POST /api/jobs accepts a manual review Job without a client prompt', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const created = await createJob(app, task, {
        agentRole: 'qa_ai',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
      })

      expect(created.aiCliProvider).toBe('claude_code')
      expect(created.aiCliMode).toBe('review')
      expect(created.aiCliPrompt).toBeUndefined()
    })
  })

  it('POST /api/jobs rejects a client prompt for a review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'qa_ai',
          aiCliProvider: 'claude_code',
          aiCliMode: 'review',
          aiCliPrompt: 'Client-controlled review instructions',
          safeCommand: { kind: 'git_status' },
        },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  describe('POST /api/jobs Design Review evidence gate', () => {
    async function postImplementJob(
      app: FastifyInstance,
      task: Task,
      prompt: string,
    ) {
      return await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: task.projectId,
          agentRole: 'developer_ai',
          aiCliProvider: 'codex',
          aiCliPrompt: prompt,
          aiCliMode: 'implement',
          safeCommand: { kind: 'test' },
        },
      })
    }

    it('allows implement Job creation with matching ALIGNED evidence', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const prompt = 'Design: implement the approved storage interface change.'
        const finalPrompt = appendImplementContracts(prompt, task)
        await createDesignReviewEvidence(app, task, finalPrompt)

        const res = await postImplementJob(app, task, prompt)

        expect(res.statusCode).toBe(201)
        expect(parseBody<Job>(res.body)).toMatchObject({
          taskId: task.id,
          aiCliMode: 'implement',
          aiCliPrompt: finalPrompt,
        })
      })
    })

    it('rejects implement Job creation when no evidence exists', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const otherTask = await createTask(app, project.id)
        const prompt = 'Design: no review was persisted for this task.'
        await createDesignReviewEvidence(app, otherTask, prompt)

        const res = await postImplementJob(app, task, prompt)

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('MISSING_DESIGN_REVIEW_EVIDENCE')
      })
    })

    it.each(['CONFLICT', 'UNCERTAIN'] as const)(
      'rejects implement Job creation when latest evidence decision is %s',
      async (decision) => {
        await withApp(async (app) => {
          const project = await createProject(app)
          const task = await createTask(app, project.id)
          const prompt = `Design: ${decision.toLowerCase()} result must fail closed.`
          await createDesignReviewEvidence(app, task, appendImplementContracts(prompt, task), { decision })

          const res = await postImplementJob(app, task, prompt)

          expect(res.statusCode).toBe(409)
          expect(parseBody<{ code: string }>(res.body).code).toBe('DESIGN_REVIEW_NOT_ALIGNED')
        })
      },
    )

    it('rejects implement Job creation when latest evidence is REVIEW_UNAVAILABLE', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const prompt = 'Design: reviewer unavailable must not pass.'
        await createDesignReviewEvidence(app, task, appendImplementContracts(prompt, task), { decision: 'REVIEW_UNAVAILABLE' })

        const res = await postImplementJob(app, task, prompt)

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('DESIGN_REVIEW_NOT_ALIGNED')
      })
    })

    it('rejects stale ALIGNED evidence created for different design text', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        await createDesignReviewEvidence(app, task, 'Design: original reviewed plan.')

        const res = await postImplementJob(app, task, 'Design: changed plan after review.')

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('DESIGN_REVIEW_HASH_MISMATCH')
      })
    })

    it('allows critical implement Job creation only when the independent verdict approved', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const prompt = 'Design: critical meta-review change approved independently.'
        await createDesignReviewEvidence(app, task, appendImplementContracts(prompt, task), {
          reviewLoad: 'critical',
          decision: 'ALIGNED',
          independentReviewRequired: true,
          independentReviewVerdict: 'approved',
        })

        const res = await postImplementJob(app, task, prompt)

        expect(res.statusCode).toBe(201)
      })
    })

    it('rejects critical ALIGNED evidence when the independent verdict did not approve', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const prompt = 'Design: critical change without independent approval.'
        await createDesignReviewEvidence(app, task, appendImplementContracts(prompt, task), {
          reviewLoad: 'critical',
          decision: 'ALIGNED',
          independentReviewRequired: true,
          independentReviewVerdict: 'changes_requested',
        })

        const res = await postImplementJob(app, task, prompt)

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('CRITICAL_INDEPENDENT_REVIEW_NOT_APPROVED')
      })
    })

    it('allows non-implement Job creation without evidence', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)

        const reviewJob = await createJob(app, task, {
          agentRole: 'qa_ai',
          aiCliProvider: 'claude_code',
          aiCliMode: 'review',
        })
        const commandJob = await createJob(app, task)

        expect(reviewJob.aiCliMode).toBe('review')
        expect(commandJob.aiCliMode).toBeUndefined()
      })
    })

    it('rejects the resume path when no matching Design Review evidence exists', async () => {
      await withApp(async (app) => {
        // resume は running Project でしか受け付けない（PROJECT_NOT_RUNNING が先に効かないように）。
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const { getStorage } = await import('../storage/index.js')
        const storage = getStorage()
        storage.jobs.create({
          taskId: task.id,
          projectId: task.projectId,
          agentRole: 'developer_ai',
          status: 'blocked',
          safeCommand: { kind: 'test', workingDir: '/workspace/target' },
          aiCliProvider: 'codex',
          aiCliPrompt: 'Original blocked prompt',
          aiCliMode: 'implement',
        })

        const res = await app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/resume`,
          payload: { instruction: 'Resume with a new plan.' },
        })

        // test 環境の runner は判定を返さない（requeued）。否定的な判定ではないので 409 ではなく
        // 503 + retryable で「同じ instruction の再送で同じ run が再開される」ことを返す。
        // evidence が無い resume を通さない（Job を作らない）ことは従来どおり。
        expect(res.statusCode).toBe(503)
        const body = parseBody<{ error: string; code: string; retryable: boolean }>(res.body)
        expect(body.error).toContain('Design Review')
        expect(body).toMatchObject({ code: 'RESUME_DESIGN_REVIEW_PENDING', retryable: true })
        expect(storage.jobs.findByTaskId(task.id).filter((job) => job.status === 'queued')).toEqual([])
      })
    })
  })

  it('persists a manual structured review without auto-creating a commit Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const review = await createJob(app, task, {
        agentRole: 'qa_ai',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: withOutbox({
          status: 'success',
          exitCode: 0,
          reviewResult: {
            status: 'approved',
            summary: 'Manual recovery review passed.',
            findings: [],
          },
        }, randomUUID()),
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).status).toBe('success')
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      expect(storage.reviewResults.findByTaskId(task.id)).toEqual([
        expect.objectContaining({ jobId: review.id, status: 'approved' }),
      ])
      expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
      expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
    })
  })

  it('GET /api/jobs/:id returns 404 for a missing job', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs/not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Job not found')
    })
  })

  it('PATCH /api/jobs/:id updates status', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { status: 'running' },
      })

      expect(res.statusCode).toBe(200)
      const body = parseBody<OutboxJobResponse>(res.body)
      expect(body.status).toBe('running')
      expect(body.outbox).toBeUndefined()
    })
  })

  it('PATCH /api/jobs/:id accepts and persists a value-free workspace END fingerprint', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      const workspaceEndFingerprint = {
        mode: 'dirty' as const,
        startCommitHash: '0805249b',
        entries: [{
          path: 'src/feature.ts', kind: 'modified' as const, worktreeHash: 'sha256:value-free',
        }],
      }

      const running = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { status: 'running' },
      })
      expect(running.statusCode).toBe(200)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: withOutbox({ status: 'success', failureMetadata: { workspaceEndFingerprint } }, randomUUID()),
      })

      expect(res.statusCode).toBe(200)
      const body = parseBody<OutboxJobResponse>(res.body)
      expect(body.failureMetadata?.workspaceEndFingerprint).toEqual(workspaceEndFingerprint)
    })
  })

  it('PATCH /api/jobs/:id rejects a workspace END fingerprint without a running-to-terminal transition', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          status: 'running',
          failureMetadata: {
            workspaceEndFingerprint: { mode: 'clean', startCommitHash: '0805249b' },
          },
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toContain('running-to-terminal')
    })
  })

  it('PATCH /api/jobs/:id rejects a workspace END fingerprint after the Job is terminal', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      await app.inject({
        method: 'PATCH', url: `/api/jobs/${created.id}`, payload: { status: 'running' },
      })
      await app.inject({
        method: 'PATCH', url: `/api/jobs/${created.id}`, payload: withOutbox({ status: 'success' }, randomUUID()),
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          failureMetadata: {
            workspaceEndFingerprint: { mode: 'clean', startCommitHash: '0805249b' },
          },
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toContain('running-to-terminal')
    })
  })

  it('PATCH /api/jobs/:id rejects rewriting an existing workspace END fingerprint', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      storage.jobs.update(created.id, {
        status: 'running',
        failureMetadata: {
          workspaceEndFingerprint: { mode: 'clean', startCommitHash: 'original' },
        },
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          status: 'failed',
          failureMetadata: {
            workspaceEndFingerprint: { mode: 'clean', startCommitHash: 'replacement' },
          },
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toContain('write-once')
      expect(storage.jobs.findById(created.id)?.failureMetadata?.workspaceEndFingerprint)
        .toEqual({ mode: 'clean', startCommitHash: 'original' })
    })
  })

  // **応答が失われた fingerprint 付き端末 PATCH の再送は deduplicated 200**（lifecycle repair C2）。
  // write-once / running-only の検査が Outbox dedup より先に走っていたため、完全な再送が 409 になり、
  // Worker の Outbox event は pending のまま残って intake が止まっていた。
  it('PATCH /api/jobs/:id: fingerprint 付き端末 PATCH の完全な再送は 200 deduplicated で、状態を変えない', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      await app.inject({ method: 'PATCH', url: `/api/jobs/${created.id}`, payload: { status: 'running' } })
      const terminal = withOutbox({
        status: 'failed',
        exitCode: 1,
        failureMetadata: { workspaceEndFingerprint: { mode: 'clean' as const, startCommitHash: '0805249b' } },
      }, 'evt-fingerprint-terminal')

      const first = await app.inject({ method: 'PATCH', url: `/api/jobs/${created.id}`, payload: terminal })
      expect(first.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(first.body).outbox).toEqual({ eventId: 'evt-fingerprint-terminal', deduplicated: false })
      const { getStorage } = await import('../storage/index.js')
      const before = getStorage().jobs.findById(created.id)

      const replay = await app.inject({ method: 'PATCH', url: `/api/jobs/${created.id}`, payload: terminal })

      expect(replay.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(replay.body).outbox).toEqual({ eventId: 'evt-fingerprint-terminal', deduplicated: true })
      expect(getStorage().jobs.findById(created.id)).toEqual(before)

      // 同じ eventId で payload が違う再送は従来どおり拒否する。
      const tampered = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          ...withOutbox({
            status: 'failed',
            exitCode: 2,
            failureMetadata: { workspaceEndFingerprint: { mode: 'clean' as const, startCommitHash: 'other' } },
          }, 'evt-fingerprint-terminal'),
        },
      })
      expect(tampered.statusCode).toBe(409)
      expect(getStorage().jobs.findById(created.id)).toEqual(before)
    })
  })

  describe('PATCH /api/jobs/:id implement requeue Design Review evidence gate', () => {
    it('rejects requeue when no evidence exists', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const job = await createStoredImplementJob(task, 'Design: evidence is missing.')

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: { status: 'queued' },
        })

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('MISSING_DESIGN_REVIEW_EVIDENCE')
        const { getStorage } = await import('../storage/index.js')
        expect(getStorage().jobs.findById(job.id)?.status).toBe('failed')
      })
    })

    it.each(['CONFLICT', 'UNCERTAIN', 'REVIEW_UNAVAILABLE'] as const)(
      'rejects requeue when latest evidence decision is %s',
      async (decision) => {
        await withApp(async (app) => {
          const project = await createProject(app)
          const task = await createTask(app, project.id)
          const prompt = `Design: ${decision.toLowerCase()} requeue must fail closed.`
          await createDesignReviewEvidence(app, task, prompt, { decision })
          const job = await createStoredImplementJob(task, prompt)

          const res = await app.inject({
            method: 'PATCH',
            url: `/api/jobs/${job.id}`,
            payload: { status: 'queued' },
          })

          expect(res.statusCode).toBe(409)
          expect(parseBody<{ code: string }>(res.body).code).toBe('DESIGN_REVIEW_NOT_ALIGNED')
        })
      },
    )

    it('rejects requeue when the latest ALIGNED evidence is stale', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        await createDesignReviewEvidence(app, task, 'Design: original reviewed implementation.')
        const job = await createStoredImplementJob(task, 'Design: changed implementation after review.')

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: { status: 'queued' },
        })

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('DESIGN_REVIEW_HASH_MISMATCH')
      })
    })

    it('rejects requeue when critical ALIGNED evidence lacks independent approval', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const prompt = 'Design: critical requeue needs independent approval.'
        await createDesignReviewEvidence(app, task, prompt, {
          reviewLoad: 'critical',
          decision: 'ALIGNED',
          independentReviewRequired: true,
        })
        const job = await createStoredImplementJob(task, prompt)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: { status: 'queued' },
        })

        expect(res.statusCode).toBe(409)
        expect(parseBody<{ code: string }>(res.body).code).toBe('CRITICAL_INDEPENDENT_REVIEW_NOT_APPROVED')
      })
    })

    it.each([
      ['blocked', false],
      ['failed', true],
    ] as const)('allows an ALIGNED implement Job to requeue from %s', async (status, useOutbox) => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const prompt = `Design: approved ${status} Job requeue.`
        await createDesignReviewEvidence(app, task, prompt)
        const job = await createStoredImplementJob(task, prompt, status)
        const payload = { status: 'queued' as const }

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: useOutbox ? withOutbox(payload, `requeue-${status}`) : payload,
        })

        expect(res.statusCode).toBe(200)
        expect(parseBody<OutboxJobResponse>(res.body)).toMatchObject({
          id: job.id,
          status: 'queued',
          ...(useOutbox ? { outbox: { eventId: `requeue-${status}`, deduplicated: false } } : {}),
        })
      })
    })

    it('does not apply the Gate when an implement Job is already queued', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const job = await createStoredImplementJob(task, 'Design: no transition occurs.', 'queued')

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: { status: 'queued', startedAt: '2026-08-16T00:00:00.000Z' },
        })

        expect(res.statusCode).toBe(200)
        expect(parseBody<Job>(res.body)).toMatchObject({
          status: 'queued',
          startedAt: '2026-08-16T00:00:00.000Z',
        })
      })
    })

    it('allows a non-implement Job to requeue without evidence', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const job = await createJob(app, task)
        await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: { status: 'failed' },
        })

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${job.id}`,
          payload: { status: 'queued' },
        })

        expect(res.statusCode).toBe(200)
        expect(parseBody<Job>(res.body).status).toBe('queued')
      })
    })
  })

  it('PATCH /api/jobs/:id accepts an Outbox event and returns Outbox metadata', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      const payload = { status: 'running' as const, startedAt: '2026-08-08T01:02:03.000Z' }

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: withOutbox(payload, 'event-simple-update'),
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(res.body)).toMatchObject({
        id: created.id,
        status: 'running',
        startedAt: '2026-08-08T01:02:03.000Z',
        outbox: { eventId: 'event-simple-update', deduplicated: false },
      })
    })
  })

  it.each([
    ['eventId only', { eventId: 'event-missing-hash', status: 'running' }],
    ['payloadHash only', { payloadHash: 'abc123', status: 'running' }],
  ])('PATCH /api/jobs/:id rejects Outbox metadata with %s', async (_label, payload) => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload,
      })

      expect(res.statusCode).toBe(400)
      expect(parseBody<{ error: string }>(res.body).error).toContain('eventId and payloadHash')
    })
  })

  it('PATCH /api/jobs/:id rejects a request payload hash mismatch', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          status: 'running',
          eventId: 'event-bad-request-hash',
          payloadHash: 'not-the-api-computed-hash',
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toContain('hash mismatch')
    })
  })

  it('PATCH /api/jobs/:id rejects the same eventId with a different valid payload', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const firstPayload = { status: 'running' as const }
      const secondPayload = { status: 'failed' as const, stderr: 'different result' }
      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: withOutbox(firstPayload, 'event-conflict'),
      })
      const second = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: withOutbox(secondPayload, 'event-conflict'),
      })

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(409)
      const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
      expect(parseBody<Job>(fetched.body)).toMatchObject({ status: 'running' })
    })
  })

  it('PATCH /api/jobs/:id/fail-if-running changes running to blocked when a repair is queued', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { status: 'running' },
      })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}/fail-if-running`,
        payload: {
          workspaceVerified: true,
          stderr: 'technical failure',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })

      // F8: verified でも queue intent が作られた場合、所有権は解放せず blocked に保つ。
      expect(res.statusCode).toBe(200)
      expect(parseBody<{
        updated: boolean
        currentStatus: Job['status']
        job: Job
      }>(res.body)).toMatchObject({
        updated: true,
        currentStatus: 'blocked',
        job: {
          id: created.id,
          status: 'blocked',
          stderr: 'technical failure',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })
    })
  })

  it.each(['success', 'failed', 'blocked', 'queued'] as const)(
    'PATCH /api/jobs/:id/fail-if-running leaves %s unchanged',
    async (status) => {
      await withApp(async (app) => {
        const project = await createProject(app)
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        if (status !== 'queued') {
          await app.inject({
            method: 'PATCH',
            url: `/api/jobs/${created.id}`,
            payload: status === 'success' ? withOutbox({ status }, randomUUID()) : { status },
          })
        }

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/fail-if-running`,
          payload: {
            workspaceVerified: true,
            stderr: 'must not be saved',
            completedAt: '2026-08-08T01:02:03.000Z',
          },
        })

        expect(res.statusCode).toBe(200)
        expect(parseBody<{ updated: boolean; currentStatus: Job['status']; job: Job }>(res.body))
          .toMatchObject({ updated: false, currentStatus: status, job: { status } })
      })
    },
  )

  it('PATCH /api/jobs/:id/fail-if-running returns 404 for a missing Job', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/jobs/missing-job/fail-if-running',
        payload: {
          workspaceVerified: true,
          stderr: 'technical failure',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Job not found')
    })
  })

  it('PATCH /api/jobs/:id/fail-if-running returns 409 while the Task workspace is quarantined', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const first = await createJob(app, task)
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${first.id}`,
        payload: { status: 'running' },
      })

      const quarantine = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${first.id}/fail-if-running`,
        payload: {
          workspaceVerified: false,
          stderr: 'crash without verification',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })
      expect(quarantine.statusCode).toBe(200)
      expect(parseBody<{ currentStatus: Job['status'] }>(quarantine.body).currentStatus).toBe('blocked')

      const second = await createJob(app, task)
      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${second.id}`,
        payload: { status: 'running' },
      })

      // claim itself is refused while quarantined: listing フィルタだけでなく、
      // 実際の queued -> running 書き込みが成立しないことを pin する（TOCTOU 対策）。
      const afterClaim = await app.inject({ method: 'GET', url: `/api/jobs/${second.id}` })
      expect(parseBody<Job>(afterClaim.body)).toMatchObject({ status: 'queued' })

      // running になっていないので fail-if-running は CAS に負け、副作用を起こさない。
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${second.id}/fail-if-running`,
        payload: {
          workspaceVerified: true,
          stderr: 'should be refused',
          completedAt: '2026-08-08T01:02:03.000Z',
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toContain('quarantined')
      const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${second.id}` })
      expect(parseBody<Job>(fetched.body)).toMatchObject({ status: 'queued' })
    })
  })

  describe('PATCH /api/jobs/:id/clear-quarantine', () => {
    const CLEAN_OBSERVATION = { mode: 'clean', startCommitHash: 'abc123' }
    const KNOWN_GOOD = {
      gitOperationMarkers: [],
      worktreeClean: true,
      indexClean: true,
      headValid: true,
      blindSpotsAbsent: true,
    }
    const CLEAR_PAYLOAD = {
      observation: CLEAN_OBSERVATION,
      knownGood: KNOWN_GOOD,
    }

    async function quarantineJob(app: FastifyInstance, jobId: string, baseline?: unknown): Promise<void> {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${jobId}`,
        payload: { status: 'running' },
      })
      expect(res.statusCode).toBe(200)
      const quarantine = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${jobId}/fail-if-running`,
        payload: {
          workspaceVerified: false,
          stderr: 'crash without verification',
          completedAt: '2026-08-08T01:02:03.000Z',
          quarantineReason: 'workspace dirty after crash',
        },
      })
      expect(quarantine.statusCode).toBe(200)
      expect(parseBody<{ currentStatus: Job['status'] }>(quarantine.body).currentStatus).toBe('blocked')
      if (baseline !== undefined) {
        const setBaseline = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${jobId}`,
          payload: { workspaceBaseline: baseline },
        })
        expect(setBaseline.statusCode).toBe(200)
      }
    }

    it('clears quarantine when the observation matches the persisted baseline, and records it', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id, CLEAN_OBSERVATION)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: {
            ...CLEAR_PAYLOAD,
            quarantineClearedReason: 'startup recovery: workspace reconciled to a safe reference point',
          },
        })

        expect(res.statusCode).toBe(200)
        const body = parseBody<{
          cleared: boolean
          clearedJobCount: number
          alreadyCleared: boolean
          job: Job
        }>(res.body)
        expect(body).toMatchObject({ cleared: true, clearedJobCount: 1, alreadyCleared: false })
        expect(body.job.failureMetadata).toMatchObject({
          quarantined: false,
          quarantineClearedAt: expect.any(String),
          quarantineClearedReason: 'startup recovery: workspace reconciled to a safe reference point',
        })
      })
    })

    it('rejects a request carrying only a boolean (no observation) — no bypass remains', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: { workspaceVerified: true },
        })

        expect(res.statusCode).toBe(400)
        const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
        expect(parseBody<Job>(fetched.body).failureMetadata?.quarantined).toBe(true)
      })
    })

    it('rejects clearance when the observation is missing', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: { knownGood: KNOWN_GOOD },
        })

        expect(res.statusCode).toBe(400)
      })
    })

    it('rejects clearance when the observation does NOT match the persisted baseline (quarantine remains)', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id, CLEAN_OBSERVATION)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: {
            observation: { mode: 'clean', startCommitHash: 'different-head' },
            knownGood: KNOWN_GOOD,
          },
        })

        expect(res.statusCode).toBe(409)
        const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
        expect(parseBody<Job>(fetched.body).failureMetadata?.quarantined).toBe(true)
      })
    })

    it('clears WITHOUT a persisted baseline when a full known-good state is presented (baseline-computation failure case)', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: CLEAR_PAYLOAD,
        })

        expect(res.statusCode).toBe(200)
        // observation は新しい durable baseline として永続化される
        const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
        expect(parseBody<Job>(fetched.body).workspaceBaseline).toEqual(CLEAN_OBSERVATION)
        expect(parseBody<Job>(fetched.body).failureMetadata?.quarantined).toBe(false)
      })
    })

    it('refuses WITHOUT a persisted baseline when a known-good condition is false (quarantine remains)', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: {
            observation: CLEAN_OBSERVATION,
            knownGood: { ...KNOWN_GOOD, worktreeClean: false },
          },
        })

        expect(res.statusCode).toBe(409)
        const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
        expect(parseBody<Job>(fetched.body).failureMetadata?.quarantined).toBe(true)
        expect(parseBody<Job>(fetched.body).workspaceBaseline).toBeUndefined()
      })
    })

    it('is idempotent: a second clearance reports alreadyCleared and preserves the recorded state', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id, CLEAN_OBSERVATION)

        const first = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: CLEAR_PAYLOAD,
        })
        expect(first.statusCode).toBe(200)
        expect(parseBody<{ clearedJobCount: number }>(first.body).clearedJobCount).toBe(1)

        const afterFirst = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })

        const second = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: CLEAR_PAYLOAD,
        })
        expect(second.statusCode).toBe(200)
        const secondBody = parseBody<{ clearedJobCount: number; alreadyCleared: boolean }>(second.body)
        expect(secondBody).toMatchObject({ clearedJobCount: 0, alreadyCleared: true })

        const afterSecond = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
        expect(parseBody<Job>(afterFirst.body).failureMetadata)
          .toEqual(parseBody<Job>(afterSecond.body).failureMetadata)
      })
    })

    it('does NOT clear a quarantined Job for a DIFFERENT workingDir', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const created = await createJob(app, task)
        await quarantineJob(app, created.id, CLEAN_OBSERVATION)

        // 別 workingDir の quarantine 兄弟
        const { getStorage } = await import('../storage/index.js')
        const otherDir = getStorage().jobs.create({
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          status: 'blocked',
          safeCommand: { kind: 'test', workingDir: '/workspace/other' },
          failureMetadata: { quarantined: true, quarantineReason: 'other workspace' },
        })

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${created.id}/clear-quarantine`,
          payload: CLEAR_PAYLOAD,
        })
        expect(res.statusCode).toBe(200)
        expect(parseBody<{ clearedJobCount: number }>(res.body).clearedJobCount).toBe(1)

        const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${otherDir.id}` })
        expect(parseBody<Job>(fetched.body).failureMetadata?.quarantined).toBe(true)
      })
    })

    it('returns 404 for a missing Job', async () => {
      await withApp(async (app) => {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/jobs/missing-job/clear-quarantine',
          payload: CLEAR_PAYLOAD,
        })

        expect(res.statusCode).toBe(404)
        expect(parseBody<{ error: string }>(res.body).error).toBe('Job not found')
      })
    })
  })

  it('PATCH /api/jobs/:id updates exitCode', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { exitCode: 0 },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Job>(res.body).exitCode).toBe(0)
    })
  })

  it('PATCH /api/jobs/:id rejects client-supplied approvalId', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: { approvalId: 'client-controlled-approval' },
      })

      expect(res.statusCode).toBe(400)
      const fetched = await app.inject({ method: 'GET', url: `/api/jobs/${created.id}` })
      expect(parseBody<Job>(fetched.body).approvalId).toBeUndefined()
    })
  })

  it('PATCH /api/jobs/:id updates log previews and paths', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const created = await createJob(app, task)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        payload: {
          stdout: 'preview stdout',
          stderr: 'preview stderr',
          stdoutPath: '/workspace/target/data/logs/job-1/stdout.txt',
          stderrPath: '/workspace/target/data/logs/job-1/stderr.txt',
        },
      })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Job>(res.body)
      expect(body.stdout).toBe('preview stdout')
      expect(body.stderr).toBe('preview stderr')
      expect(body.stdoutPath).toBe('/workspace/target/data/logs/job-1/stdout.txt')
      expect(body.stderrPath).toBe('/workspace/target/data/logs/job-1/stderr.txt')
    })
  })

  it('PATCH /api/jobs/:id creates one review Job after a successful changed implementation', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Automatic implementation',
          assignee: 'developer_ai',
        },
      })
      const task = parseBody<Task>(taskResponse.body)
      const implement = await createTestWorkflowImplementJob(app, task)
      const successfulResult = {
        status: 'success' as const,
        exitCode: 0,
        changedFiles: ['src/feature.ts'],
        guardResult: {
          permissionAllowed: true,
          fileChangeAllowed: true,
        },
      }

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: withOutbox(successfulResult, randomUUID()),
      })
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: successfulResult,
      })

      expect(first.statusCode).toBe(200)
      // C-1: a resend without the Worker's Outbox event cannot write success (even to a success Job).
      expect(resend.statusCode).toBe(409)
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      const jobs = parseBody<Job[]>(jobsResponse.body)
      expect(jobs).toHaveLength(2)
      const reviewJob = jobs.find((job) => job.aiCliMode === 'review')
      expect(reviewJob).toMatchObject({
        workflowStepKey: `implement:${implement.id}:review`,
        agentRole: 'qa_ai',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
        status: 'queued',
      })
      expect(reviewJob?.aiCliPrompt).toBeUndefined()
    })
  })

  it('deduplicates an Outbox resend that creates the automatic review Job', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Outbox implementation',
          assignee: 'developer_ai',
        },
      })
      const task = parseBody<Task>(taskResponse.body)
      const implement = await createTestWorkflowImplementJob(app, task)
      const successfulResult = {
        status: 'success' as const,
        exitCode: 0,
        changedFiles: ['src/feature.ts'],
        guardResult: {
          permissionAllowed: true,
          fileChangeAllowed: true,
        },
      }

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: withOutbox(successfulResult, 'event-review-once'),
      })
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: withOutbox(successfulResult, 'event-review-once'),
      })

      expect(first.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(first.body).outbox).toEqual({
        eventId: 'event-review-once',
        deduplicated: false,
      })
      expect(resend.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(resend.body).outbox).toEqual({
        eventId: 'event-review-once',
        deduplicated: true,
      })
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      const jobs = parseBody<Job[]>(jobsResponse.body)
      expect(jobs.filter((job) => job.aiCliMode === 'review')).toHaveLength(1)
    })
  })

  it.each([
    ['implement failed', { status: 'failed', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: true, fileChangeAllowed: true } }],
    ['changedFiles is empty', { status: 'success', exitCode: 0, changedFiles: [], guardResult: { permissionAllowed: true, fileChangeAllowed: true } }],
    ['SafeCommand failed', { status: 'failed', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: true, fileChangeAllowed: true } }],
    ['permission guard failed', { status: 'blocked', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: false, fileChangeAllowed: true } }],
    ['file guard failed', { status: 'blocked', exitCode: 1, changedFiles: ['src/a.ts'], guardResult: { permissionAllowed: true, fileChangeAllowed: false } }],
  ])('does not create a review Job when %s', async (_label, resultPayload) => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId: project.id,
          title: 'Stopped implementation',
          assignee: 'developer_ai',
        },
      })
      const task = parseBody<Task>(taskResponse.body)
      const implement = await createTestWorkflowImplementJob(app, task)

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${implement.id}`,
        payload: resultPayload.status === 'success' ? withOutbox(resultPayload, randomUUID()) : resultPayload,
      })

      expect(updateResponse.statusCode).toBe(200)
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      expect(parseBody<Job[]>(jobsResponse.body)).toHaveLength(1)
    })
  })

  it('creates one new retry Job, preserves the failed source Job, and deduplicates the same result PATCH', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Implement the reviewed timeout retry case.'
      await createDesignReviewEvidence(app, task, prompt)
      const { getStorage } = await import('../storage/index.js')
      const source = getStorage().jobs.create({
        taskId: task.id,
        projectId: task.projectId,
        workflowStepKey: `task:${task.id}:initial-implement`,
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        dryRun: true,
        aiCliProvider: 'codex',
        aiCliPrompt: prompt,
        aiCliMode: 'implement',
      })
      const payload = providerTimeoutFailure()
      const outboxPayload = withOutbox(payload, 'provider-timeout-event')

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: outboxPayload,
      })
      const second = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: outboxPayload,
      })

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(second.body).outbox?.deduplicated).toBe(true)

      const jobs = getStorage().jobs.findByTaskId(task.id)
      expect(jobs).toHaveLength(2)
      expect(jobs.find((job) => job.id === source.id)).toMatchObject({
        status: 'failed',
        failureMetadata: {
          kind: 'provider_timeout',
          workspaceState: 'unchanged',
        },
      })
      expect(jobs.find((job) => job.id !== source.id)).toMatchObject({
        taskId: source.taskId,
        projectId: source.projectId,
        workflowStepKey: `retry:${source.id}:1`,
        agentRole: source.agentRole,
        status: 'queued',
        safeCommand: source.safeCommand,
        dryRun: true,
        aiCliProvider: source.aiCliProvider,
        aiCliPrompt: source.aiCliPrompt,
        aiCliMode: source.aiCliMode,
      })
    })
  })

  it('creates a review after a produced retry of initial implement succeeds with changes', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { status: 'in_progress' })
      const { retry } = await createProducedTimeoutRetry(
        app,
        task,
        'Retry the initial implementation.',
        `task:${task.id}:initial-implement`,
      )

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${retry.id}`,
        payload: withOutbox(successfulChangedImplementResult, randomUUID()),
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      const jobs = getStorage().jobs.findByTaskId(task.id)
      expect(getStorage().jobs.findById(retry.id)?.status).toBe('success')
      expect(jobs.find((job) => job.workflowStepKey === `implement:${retry.id}:review`)).toMatchObject({
        aiCliMode: 'review',
        status: 'queued',
      })
      expect(jobs.some((job) => job.status === 'queued')).toBe(true)
    })
  })

  it.each([
    ['repair', 'repair:review-source:1'],
    ['resume', 'resume:review-source:1'],
  ])('creates a review after a produced retry of %s implement succeeds with changes', async (_kind, stepKey) => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { status: 'in_progress' })
      const { retry } = await createProducedTimeoutRetry(
        app,
        task,
        `Retry the ${_kind} implementation.`,
        stepKey,
      )

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${retry.id}`,
        payload: withOutbox(successfulChangedImplementResult, randomUUID()),
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      const jobs = getStorage().jobs.findByTaskId(task.id)
      expect(getStorage().jobs.findById(retry.id)?.status).toBe('success')
      expect(jobs.find((job) => job.workflowStepKey === `implement:${retry.id}:review`)).toMatchObject({
        aiCliMode: 'review',
        status: 'queued',
      })
    })
  })

  it('does not create a review when a produced workflow retry succeeds without changed files', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { status: 'in_progress' })
      const { retry } = await createProducedTimeoutRetry(
        app,
        task,
        'Retry without changes.',
        `task:${task.id}:initial-implement`,
      )

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${retry.id}`,
        payload: withOutbox({ ...successfulChangedImplementResult, changedFiles: [] }, randomUUID()),
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id).filter((job) => job.aiCliMode === 'review')).toHaveLength(0)
    })
  })

  it('does not create a review when a produced retry of a manual implement succeeds with changes', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { status: 'in_progress' })
      const { retry } = await createProducedTimeoutRetry(app, task, 'Retry a manual implementation.')

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${retry.id}`,
        payload: withOutbox(successfulChangedImplementResult, randomUUID()),
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id).filter((job) => job.aiCliMode === 'review')).toHaveLength(0)
    })
  })

  it('fails closed without throwing when a retry source does not exist', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { status: 'in_progress' })
      const { getStorage } = await import('../storage/index.js')
      const retry = getStorage().jobs.create({
        taskId: task.id,
        projectId: task.projectId,
        workflowStepKey: 'retry:nonexistent:1',
        agentRole: 'developer_ai',
        status: 'running',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
        aiCliProvider: 'codex',
        aiCliPrompt: 'Do not resolve this retry source.',
        aiCliMode: 'implement',
      })

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${retry.id}`,
        payload: withOutbox(successfulChangedImplementResult, randomUUID()),
      })

      expect(response.statusCode).toBe(200)
      expect(getStorage().jobs.findById(retry.id)?.status).toBe('success')
      expect(getStorage().jobs.findByTaskId(task.id).filter((job) => job.aiCliMode === 'review')).toHaveLength(0)
    })
  })

  it.each(['blocked', 'queued', 'success'] as const)(
    'applies an Outbox provider_timeout result to a %s source Job without retrying and deduplicates its resend',
    async (status) => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const prompt = `Apply the timeout result to the ${status} source Job.`
        await createDesignReviewEvidence(app, task, prompt)
        const source = await createStoredImplementJob(task, prompt, status)
        const { getStorage } = await import('../storage/index.js')
        const payload = withOutbox(providerTimeoutFailure(), `provider-timeout-${status}`)

        const first = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${source.id}`,
          payload,
        })
        const resend = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${source.id}`,
          payload,
        })

        expect(first.statusCode).toBe(200)
        expect(resend.statusCode).toBe(200)
        expect(parseBody<OutboxJobResponse>(first.body).outbox).toEqual({
          eventId: `provider-timeout-${status}`,
          deduplicated: false,
        })
        expect(parseBody<OutboxJobResponse>(resend.body).outbox).toEqual({
          eventId: `provider-timeout-${status}`,
          deduplicated: true,
        })
        const jobs = getStorage().jobs.findByTaskId(task.id)
        expect(jobs).toHaveLength(1)
        // 遅延resultは受理されるが、確定済みterminal stateは上書きしない。
        // queuedのsourceはまだ確定していないため適用される。
        if (status === 'queued') {
          expect(jobs[0]).toMatchObject({
            id: source.id,
            status: 'failed',
            exitCode: 1,
            stderr: 'provider command timed out',
            failureMetadata: {
              kind: 'provider_timeout',
              workspaceState: 'unchanged',
            },
          })
        } else {
          // 適用できない配送は status 以外の payload も重ねない（lifecycle repair C3。以前は exitCode / stderr /
          // failureMetadata を確定済みの行へ重ね、確定 state と矛盾する行を作っていた）。
          expect(jobs[0]).toMatchObject({ id: source.id, status })
          expect(jobs[0].exitCode).toBeUndefined()
          expect(jobs[0].stderr).toBeUndefined()
          expect(jobs[0].failureMetadata).toBeUndefined()
        }
        expect(jobs.some((job) => job.workflowStepKey?.startsWith('retry:') === true)).toBe(false)
      })
    },
  )

  it.each([
    ['changes_requested without Outbox', 'changes_requested' as const, false],
    ['rejected without Outbox', 'rejected' as const, false],
    ['changes_requested with Outbox', 'changes_requested' as const, true],
    ['rejected with Outbox', 'rejected' as const, true],
  ])('rejects %s on an eligible implement timeout without applying the update', async (_label, status, useOutbox) => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Reject structured review data on an implement timeout.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const sourceBefore = storage.jobs.findById(source.id)
      const reviewPayload = {
        ...providerTimeoutFailure(),
        reviewResult: {
          status,
          summary: 'blocking',
          findings: [],
        },
      }
      const eventId = `implement-timeout-review-${status}`

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: useOutbox ? withOutbox(reviewPayload, eventId) : reviewPayload,
      })

      expect(response.statusCode).toBe(400)
      expect(parseBody<{ error: string }>(response.body)).toEqual({
        error: 'Structured review results are only accepted for review Jobs',
      })
      expect(storage.jobs.findById(source.id)).toEqual(sourceBefore)
      expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
      expect(storage.reviewResults.findByTaskId(task.id)).toEqual([])

      if (useOutbox) {
        const probePayload = { status: 'running' as const }
        const probe = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${source.id}`,
          payload: withOutbox(probePayload, eventId),
        })
        expect(probe.statusCode).toBe(200)
        expect(parseBody<OutboxJobResponse>(probe.body).outbox).toEqual({
          eventId,
          deduplicated: false,
        })
        expect(storage.jobs.findByTaskId(task.id)).toHaveLength(1)
        expect(storage.jobs.findById(source.id)?.status).toBe('running')
      }
    })
  })

  it('does not create a third Job when the retry Job also fails with provider_timeout', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Implement the reviewed bounded retry case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')

      await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: providerTimeoutFailure(),
      })
      const { getStorage } = await import('../storage/index.js')
      const retry = getStorage().jobs.findByTaskId(task.id).find(
        (job) => job.workflowStepKey === `retry:${source.id}:1`,
      )
      expect(retry).toBeDefined()

      const retryFailure = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${retry?.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(retryFailure.statusCode).toBe(200)
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(2)
      expect(getStorage().jobs.findById(retry?.id ?? '')?.status).toBe('failed')
    })
  })

  it.each(['changed', 'unknown'] as const)(
    'does not retry when workspaceState is %s',
    async (workspaceState) => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const prompt = `Implement workspace ${workspaceState}.`
        await createDesignReviewEvidence(app, task, prompt)
        const source = await createStoredImplementJob(task, prompt, 'running')

        const response = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${source.id}`,
          payload: providerTimeoutFailure(workspaceState),
        })

        expect(response.statusCode).toBe(200)
        const { getStorage } = await import('../storage/index.js')
        expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
      })
    },
  )

  it('does not retry when stderr only contains ETIMEDOUT without failureMetadata.kind', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Implement stderr-only classification case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: {
          status: 'failed',
          stderr: 'ETIMEDOUT from nested command output',
          failureMetadata: { workspaceState: 'unchanged' },
        },
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
    })
  })

  it('does not retry a review-mode Job even with provider_timeout metadata', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const { getStorage } = await import('../storage/index.js')
      const review = getStorage().jobs.create({
        taskId: task.id,
        projectId: task.projectId,
        workflowStepKey: 'implement:source:review',
        agentRole: 'qa_ai',
        status: 'running',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
      })

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(response.statusCode).toBe(200)
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
      expect(getStorage().jobs.findById(review.id)?.status).toBe('failed')
    })
  })

  it.each([
    ['hash mismatch', 'different reviewed text', 'ALIGNED' as const],
    ['non-ALIGNED evidence', 'Implement the reviewed evidence case.', 'CONFLICT' as const],
  ])('does not retry when Design Review evidence has %s', async (_label, reviewedText, decision) => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Implement the reviewed evidence case.'
      await createDesignReviewEvidence(app, task, reviewedText, { decision })
      const source = await createStoredImplementJob(task, prompt, 'running')

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
      expect(getStorage().jobs.findById(source.id)?.status).toBe('failed')
    })
  })

  it.each(['WAITING_FOR_USER', 'REJECTED'] as const)(
    'does not retry while the latest Approval is %s',
    async (approvalStatus) => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'running' })
        const task = await createTask(app, project.id)
        const prompt = `Implement approval state ${approvalStatus}.`
        await createDesignReviewEvidence(app, task, prompt)
        await createApprovalRequestWithStatus(task, approvalStatus)
        const source = await createStoredImplementJob(task, prompt, 'running')

        const response = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${source.id}`,
          payload: providerTimeoutFailure(),
        })

        expect(response.statusCode).toBe(200)
        const { getStorage } = await import('../storage/index.js')
        expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
      })
    },
  )

  // 遅れて届いた report（Outbox resend）が park の後に着く順序は実際に起こりうる。
  // retry は queued Job を作る経路であり、Worker は Task の状態を見ずにそれを拾うため、
  // ここで作ると park が黙って取り消される。
  it('does not retry a Task that abort_task has parked', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { roadmapActive: true } as Partial<Task>)
      const prompt = 'Implement parked case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()

      // abort_task と同じ経路で park する（DB を直接書き換えない）。
      const request = storage.approvalRequests.create({
        taskId: task.id, requestedAction: 'abort_task', riskLevel: 'HIGH',
        targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
        changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
        status: 'WAITING_FOR_USER', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never)
      storage.approvalRequests.recordDecision(request.id, 'APPROVED', undefined, { credentialClass: 'admin' })
      storage.jobs.update(source.id, { status: 'failed' } as never)
      const { abortTask } = await import('../pl/abortTask.js')
      expect(abortTask(storage, {
        taskId: task.id, approvalRequestId: request.id, reason: 'parked',
      })).toMatchObject({ ok: true, status: 'parked' })

      // park の後に、running だった頃の provider timeout 報告が遅れて届く。
      storage.jobs.update(source.id, { status: 'running' } as never)
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(response.statusCode).toBe(200)
      expect(storage.jobs.findByTaskId(task.id).some(
        (job) => job.workflowStepKey?.startsWith('retry:') === true,
      )).toBe(false)
      expect(storage.jobs.findByTaskId(task.id).filter((job) => job.status === 'queued')).toHaveLength(0)
      expect(storage.tasks.findById(task.id)?.roadmapActive).toBe(false)
    })
  })

  // park は Job を failed へ解放する。canApplyJobResultStatus は terminal からの requeue を
  // 許すため、この汎用経路を塞がないと park した Task の Job をそのまま動かし直せる。
  it('refuses to make a parked Task\'s job live again', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id, { roadmapActive: true } as Partial<Task>)
      // 実際の implement Job は Design Review evidence を持つ。持たない Job で試すと、
      // requeue は evidence 不足で別の 409 になり、park の guard を通らないまま通過する。
      const prompt = 'Implement parked requeue case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'failed')
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()

      const request = storage.approvalRequests.create({
        taskId: task.id, requestedAction: 'abort_task', riskLevel: 'HIGH',
        targetBranch: 'ai/park', targetCommit: 'c', targetDiffHash: 'd',
        changedFiles: [], triggeredRules: [], invalidIf: ['commit changes'],
        status: 'WAITING_FOR_USER', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never)
      storage.approvalRequests.recordDecision(request.id, 'APPROVED', undefined, { credentialClass: 'admin' })
      const { abortTask } = await import('../pl/abortTask.js')
      expect(abortTask(storage, {
        taskId: task.id, approvalRequestId: request.id, reason: 'parked',
      })).toMatchObject({ ok: true, status: 'parked' })

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: { status: 'queued' },
      })

      expect(response.statusCode).toBe(409)
      expect(storage.jobs.findById(source.id)?.status).toBe('failed')
    })
  })

  it('does not retry while a newer blocked Job represents a Permission or Safety wait', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Implement blocked state case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')
      const { getStorage } = await import('../storage/index.js')
      getStorage().jobs.create({
        taskId: task.id,
        projectId: task.projectId,
        agentRole: 'developer_ai',
        status: 'blocked',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(response.statusCode).toBe(200)
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(2)
      expect(getStorage().jobs.findByTaskId(task.id).some(
        (job) => job.workflowStepKey?.startsWith('retry:') === true,
      )).toBe(false)
    })
  })

  it('does not retry when another queued or running Job already exists for the Task', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      const task = await createTask(app, project.id)
      const prompt = 'Implement active Job conflict case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')
      const { getStorage } = await import('../storage/index.js')
      getStorage().jobs.create({
        taskId: task.id,
        projectId: task.projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(response.statusCode).toBe(200)
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(2)
      expect(getStorage().jobs.findById(source.id)?.status).toBe('failed')
    })
  })

  it.each([
    ['paused Project', { projectStatus: 'paused' as const, taskStatus: 'pending' as const }],
    ['blocked Task', { projectStatus: 'running' as const, taskStatus: 'blocked' as const }],
  ])('does not retry for a %s', async (_label, state) => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: state.projectStatus })
      const task = await createTask(app, project.id, { status: state.taskStatus })
      const prompt = 'Implement stopped project or task case.'
      await createDesignReviewEvidence(app, task, prompt)
      const source = await createStoredImplementJob(task, prompt, 'running')

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${source.id}`,
        payload: providerTimeoutFailure(),
      })

      expect(response.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().jobs.findByTaskId(task.id)).toHaveLength(1)
    })
  })

  it('does not advance a manual implement Job and rejects client workflowStepKey input', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const task = await createTask(app, project.id)
      const rejectedCreate = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          workflowStepKey: 'client-controlled-key',
          agentRole: 'developer_ai',
          safeCommand: { kind: 'test' },
        },
      })
      expect(rejectedCreate.statusCode).toBe(400)

      await createDesignReviewEvidence(app, task, appendImplementContracts('Manual recovery', task))
      const manualResponse = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: {
          taskId: task.id,
          projectId: project.id,
          agentRole: 'developer_ai',
          aiCliProvider: 'claude_code',
          aiCliPrompt: 'Manual recovery',
          aiCliMode: 'implement',
          safeCommand: { kind: 'test' },
        },
      })
      expect(manualResponse.statusCode).toBe(201)
      const manual = parseBody<Job>(manualResponse.body)
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${manual.id}`,
        payload: withOutbox({
          status: 'success',
          exitCode: 0,
          changedFiles: ['src/manual.ts'],
          guardResult: { permissionAllowed: true, fileChangeAllowed: true },
        }, randomUUID()),
      })

      expect(updateResponse.statusCode).toBe(200)
      const jobsResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs?taskId=${task.id}`,
      })
      expect(parseBody<Job[]>(jobsResponse.body)).toHaveLength(1)
    })
  })

  it('persists an approved structured review and creates one git_commit Job idempotently', async () => {
    await withApp(async (app) => {
      const { review, task } = await createAutomaticReviewJob(app)
      const verdict = {
        status: 'approved' as const,
        summary: 'All requirements are satisfied.',
        findings: [],
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${review.id}`,
          payload: withOutbox({
            status: 'success',
            exitCode: 0,
            changedFiles: ['src/feature.ts'],
            guardResult: { permissionAllowed: true, fileChangeAllowed: true },
            reviewResult: verdict,
          }, randomUUID()),
        })
        expect(response.statusCode).toBe(200)
        expect(parseBody<Job>(response.body).status).toBe('success')
      }

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const reviewResults = storage.reviewResults.findByTaskId(task.id)
      expect(reviewResults).toHaveLength(1)
      expect(reviewResults[0]).toMatchObject({
        taskId: task.id,
        jobId: review.id,
        reviewer: 'qa_ai',
        ...verdict,
      })
      const jobs = storage.jobs.findByTaskId(task.id)
      const commitJobs = jobs.filter((job) => job.safeCommand.kind === 'git_commit')
      expect(commitJobs).toHaveLength(1)
      expect(commitJobs[0]).toMatchObject({
        workflowStepKey: `review:${review.id}:git-commit`,
        status: 'queued',
      })
      expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
    })
  })

  it('deduplicates an Outbox resend that creates the git_commit Job after review approval', async () => {
    await withApp(async (app) => {
      const { review, task } = await createAutomaticReviewJob(app)
      const verdict = {
        status: 'approved' as const,
        summary: 'All requirements are satisfied.',
        findings: [],
      }
      const payload = {
        status: 'success' as const,
        exitCode: 0,
        changedFiles: ['src/feature.ts'],
        guardResult: { permissionAllowed: true, fileChangeAllowed: true },
        reviewResult: verdict,
      }

      const first = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: withOutbox(payload, 'event-commit-once'),
      })
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: withOutbox(payload, 'event-commit-once'),
      })

      expect(first.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(first.body).outbox).toEqual({
        eventId: 'event-commit-once',
        deduplicated: false,
      })
      expect(resend.statusCode).toBe(200)
      expect(parseBody<OutboxJobResponse>(resend.body).outbox).toEqual({
        eventId: 'event-commit-once',
        deduplicated: true,
      })

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      expect(storage.reviewResults.findByTaskId(task.id)).toHaveLength(1)
      expect(storage.jobs.findByTaskId(task.id).filter(
        (job) => job.safeCommand.kind === 'git_commit',
      )).toHaveLength(1)
    })
  })

  it.each(['changes_requested', 'rejected'] as const)(
    'persists %s as a failed review Job without creating commit or Approval',
    async (status) => {
      await withApp(async (app) => {
        const { review, task } = await createAutomaticReviewJob(app)
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${review.id}`,
          payload: withOutbox({
            status: 'success',
            exitCode: 0,
            changedFiles: ['src/feature.ts'],
            guardResult: { permissionAllowed: true, fileChangeAllowed: true },
            reviewResult: {
              status,
              summary: 'CEO action is required.',
              findings: [{ severity: 'high', message: 'Blocking issue' }],
            },
          }, randomUUID()),
        })

        expect(response.statusCode).toBe(200)
        expect(parseBody<Job>(response.body).status).toBe('failed')
        const { getStorage } = await import('../storage/index.js')
        const storage = getStorage()
        expect(storage.reviewResults.findByTaskId(task.id)).toHaveLength(1)
        expect(storage.jobs.findByTaskId(task.id).filter(
          (job) => job.safeCommand.kind === 'git_commit',
        )).toEqual([])
        expect(storage.approvalRequests.findByTaskId(task.id)).toEqual([])
      })
    },
  )

  it.each([
    ['unknown status', { status: 'approve', summary: 'bad', findings: [] }],
    ['unknown severity', { status: 'approved', summary: 'bad', findings: [{ severity: 'major', message: 'bad' }] }],
    ['missing required field', { status: 'approved', findings: [] }],
    ['extra field', { status: 'approved', summary: 'bad', findings: [], verdict: 'approved' }],
  ])('rejects structured review with %s and saves no ReviewResult', async (_label, reviewResult) => {
    await withApp(async (app) => {
      const { review, task } = await createAutomaticReviewJob(app)
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${review.id}`,
        payload: withOutbox({ status: 'success', reviewResult }, randomUUID()),
      })

      expect(response.statusCode).toBe(400)
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().reviewResults.findByTaskId(task.id)).toEqual([])
    })
  })
})

// R-FINAL-OPPATCH (Codex review r5): eventId / payloadHash are caller-computable, so the Outbox event alone
// does not prove the Worker sent the result. Under split credentials only the WORKER credential's event-bearing
// success is applied. `legacy` (one shared API_TOKEN for humans and the Worker) cannot tell the sender apart and
// keeps accepting it. A request with no credential class (unauthenticated) is not Worker provenance (C-1).
describe('event-bearing success provenance by credential class', () => {
  async function withCredential(
    credential: 'admin' | 'worker' | 'legacy' | undefined,
    run: (app: FastifyInstance) => Promise<void>,
  ): Promise<void> {
    const [{ jobRoutes }, { resetStorage }, { setCredentialClass }] = await Promise.all([
      import('./jobs.js'),
      import('../storage/index.js'),
      import('../auth/credentialClass.js'),
    ])
    resetStorage()
    const app = Fastify()
    app.addHook('preHandler', async (req) => {
      if (credential !== undefined) setCredentialClass(req, credential)
    })
    app.register(jobRoutes, { prefix: '/api/jobs' })
    await app.ready()
    try {
      await run(app)
    } finally {
      await app.close()
    }
  }

  async function runningJob() {
    const { getStorage } = await import('../storage/index.js')
    const storage = getStorage()
    const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'pending', assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'running',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    } as Parameters<typeof storage.jobs.create>[0])
    return { storage, job }
  }

  const delivery = (eventId: string) => withOutbox({ status: 'success', exitCode: 0, stdout: 'result' }, eventId)

  // C-1 (Codex review): every success needs the Worker's delivery, even to a Job that is already success,
  // and the check runs before the replay / non-applicable handling.
  async function successJob(kind: 'review' | 'implement' | 'git_commit', status: 'success' | 'failed' = 'success') {
    const { getStorage } = await import('../storage/index.js')
    const storage = getStorage()
    const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
    const task = storage.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'pending', assignee: 'developer_ai', dependencies: [],
    })
    const job = storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: kind === 'review' ? 'qa_ai' : 'developer_ai', status,
      safeCommand: { kind: kind === 'git_commit' ? 'git_commit' : 'git_status', workingDir: '/workspace/target' },
      ...(kind === 'review' ? { aiCliMode: 'review', aiCliProvider: 'claude', workflowStepKey: 'implement:src-job:review' } : {}),
      ...(kind === 'implement' ? { aiCliMode: 'implement', aiCliProvider: 'claude', workflowStepKey: `task:${task.id}:initial-implement` } : {}),
    } as Parameters<typeof storage.jobs.create>[0])
    const snapshot = () => ({
      job: storage.jobs.findById(job.id),
      audit: storage.auditLog.findByEntity('job', job.id).length,
      reviews: storage.reviewResults.findByTaskId(task.id).length,
      jobs: storage.jobs.findByTaskId(task.id).length,
      task: storage.tasks.findById(task.id),
    })
    return { storage, job, snapshot }
  }

  const forgedSuccess = (kind: 'review' | 'implement' | 'git_commit', eventId: string) => withOutbox({
    status: 'success', exitCode: 0, stdout: 'forged',
    ...(kind === 'review' ? { reviewResult: { status: 'approved', summary: 'forged', findings: [] } } : {}),
    ...(kind === 'git_commit' ? { commitHash: 'deadbeef' } : {}),
  }, eventId)

  it.each([
    ['admin', 'review'], ['admin', 'implement'], ['admin', 'git_commit'],
    [undefined, 'review'], [undefined, 'implement'], [undefined, 'git_commit'],
  ] as const)('C-1: credential %s cannot send a same-state success to an already-successful %s Job (nothing changes)', async (credential, kind) => {
    await withCredential(credential, async (app) => {
      const { job, snapshot } = await successJob(kind)
      const before = snapshot()
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: forgedSuccess(kind, `evt-forged-${kind}`) })
      expect(res.statusCode).toBe(409)
      expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
      expect(snapshot()).toEqual(before)
    })
  })

  it('C-1: an ADMIN success delivery to a Job it no longer applies to is rejected, not acknowledged (nothing changes)', async () => {
    await withCredential('admin', async (app) => {
      const { job, snapshot } = await successJob('implement', 'failed')
      const before = snapshot()
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: forgedSuccess('implement', 'evt-admin-nonapplicable') })
      expect(res.statusCode).toBe(409)
      expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
      expect(snapshot()).toEqual(before)
    })
  })

  it('C-1: the Worker credential still gets its non-applicable success delivery acknowledged (unchanged)', async () => {
    await withCredential('worker', async (app) => {
      const { job, storage } = await successJob('implement', 'failed')
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: forgedSuccess('implement', 'evt-worker-nonapplicable') })
      expect(res.statusCode).toBe(200)
      expect(storage.jobs.findById(job.id)?.status).toBe('failed')
    })
  })

  it('C-1: an unauthenticated request (no credential class) with a valid eventId cannot write success', async () => {
    await withCredential(undefined, async (app) => {
      const { storage, job } = await runningJob()
      const before = storage.jobs.findById(job.id)
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: delivery('evt-none') })
      expect(res.statusCode).toBe(409)
      expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
      expect(storage.jobs.findById(job.id)).toEqual(before)
    })
  })

  it('ADMIN with a valid eventId + payloadHash cannot write success (409, nothing changes)', async () => {
    await withCredential('admin', async (app) => {
      const { storage, job } = await runningJob()
      const before = storage.jobs.findById(job.id)
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: delivery('evt-admin') })
      expect(res.statusCode).toBe(409)
      expect(parseBody<{ code: string }>(res.body).code).toBe('JOB_SUCCESS_REQUIRES_WORKER_RESULT')
      expect(storage.jobs.findById(job.id)).toEqual(before)
    })
  })

  it.each(['worker', 'legacy'] as const)(
    'credential %s with an Outbox event applies success',
    async (credential) => {
      await withCredential(credential, async (app) => {
        const { storage, job } = await runningJob()
        const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: delivery(`evt-${credential}`) })
        expect(res.statusCode).toBe(200)
        expect(storage.jobs.findById(job.id)?.status).toBe('success')
      })
    },
  )

  it.each(['admin', 'worker', 'legacy'] as const)(
    'credential %s without an Outbox event cannot write success',
    async (credential) => {
      await withCredential(credential, async (app) => {
        const { storage, job } = await runningJob()
        const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'success' } })
        expect(res.statusCode).toBe(409)
        expect(storage.jobs.findById(job.id)?.status).toBe('running')
      })
    },
  )

  it('ADMIN can still end a running Job as failed', async () => {
    await withCredential('admin', async (app) => {
      const { storage, job } = await runningJob()
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { status: 'failed', stderr: 'stopped' } })
      expect(res.statusCode).toBe(200)
      expect(storage.jobs.findById(job.id)?.status).toBe('failed')
    })
  })
})
