import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Task } from '@ai-team/shared'

vi.mock('../designReview/repairFlow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../designReview/repairFlow')>()
  return {
    ...actual,
    executeQueuedRepair: vi.fn(async () => ({ status: 'already_started', stepKey: 'mocked' })),
  }
})

import { executeQueuedRepair } from '../designReview/repairFlow'
import { buildSystemState } from '../state/systemState'
import { triageBlocked } from '../pl/blockedTriage'

const repairKick = vi.mocked(executeQueuedRepair)
const alignedResumeReview = vi.fn(async () => ({
  ok: true,
  timedOut: false,
  stdout: JSON.stringify({
    focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
    integrationReviewResult: { decision: 'ALIGNED' },
  }),
}))

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'
  const [{ jobRoutes }, { taskRoutes }, { resetStorage }] = await Promise.all([
    import('./jobs.js'),
    import('./tasks.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.register(jobRoutes, { prefix: '/api/jobs' })
  app.register(taskRoutes, {
    prefix: '/api/tasks',
    resumeDesignReviewDeps: {
      runnerCommand: 'mock',
      runnerArgs: [],
      homeDirectory: '/tmp',
      workingDir: '/tmp',
      execute: alignedResumeReview,
    },
  })
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

async function seedTask(): Promise<Task> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()
  const project = storage.projects.create({
    name: 'Baseline refusal',
    goal: 'Do not adopt a foreign dirty workspace',
    designPhilosophy: [],
    status: 'running',
  })
  return storage.tasks.create({
    projectId: project.id,
    title: 'Initial implementation',
    description: 'Implement safely.',
    status: 'in_progress',
    assignee: 'developer_ai',
    dependencies: [],
  })
}

async function createImplementJob(
  task: Task,
  workflowStepKey: string,
  status: Job['status'],
): Promise<Job> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status,
    workflowStepKey,
    safeCommand: { kind: 'test', workingDir: '/workspace/target', params: {} },
    aiCliProvider: 'codex',
    aiCliPrompt: 'Implement safely.',
    aiCliMode: 'implement',
  })
}

async function reportFailure(app: FastifyInstance, job: Job): Promise<Job> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${job.id}`,
    payload: {
      status: 'failed',
      exitCode: 1,
      stderr: 'workspace baseline failure: foreign dirty worktree',
      completedAt: '2026-09-30T01:02:03.000Z',
    },
  })
  expect(response.statusCode).toBe(200)
  return parseBody<Job>(response.body)
}

beforeEach(() => {
  repairKick.mockClear()
  alignedResumeReview.mockClear()
})

describe('initial implement pre-start workspace refusal', () => {
  it('quarantines without repair, budget consumption, or a Design Review repair run', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const task = await seedTask()
      const job = await createImplementJob(task, `task:${task.id}:initial-implement`, 'queued')

      const persisted = await reportFailure(app, job)

      expect(persisted).toMatchObject({
        status: 'blocked',
        failureMetadata: {
          kind: 'workspace_baseline_failure',
          workspaceState: 'unknown',
          quarantined: true,
          quarantineReason: 'workspace baseline failure: foreign dirty worktree',
        },
      })
      const taskJobs = storage.jobs.findByTaskId(task.id)
      expect(taskJobs).toHaveLength(1)
      expect(taskJobs.filter((candidate) => (
        candidate.workflowStepKey?.startsWith('repair:')
      ))).toHaveLength(0)
      expect(taskJobs.some((candidate) => (
        candidate.workflowStepKey?.includes(':review') || candidate.workflowStepKey?.includes(':git-commit')
      ))).toBe(false)
      expect(storage.designReviewRuns.findByTaskId(task.id)).toHaveLength(0)
      expect(repairKick).not.toHaveBeenCalled()

      const attention = buildSystemState(storage).attention.find((item) => (
        item.kind === 'workspace_quarantined' && item.jobId === job.id
      ))
      expect(attention).toBeDefined()
      expect(triageBlocked(storage, attention!)).toMatchObject({
        rootCauseClass: 'workspace_quarantined',
        recommendedLane: 'ceo_escalation',
      })
    })
  })

  it('refuses resume while dirty, then resumes through the existing path after verified clean clearance', async () => {
    await withApp(async (app) => {
      const task = await seedTask()
      const job = await createImplementJob(task, `task:${task.id}:initial-implement`, 'queued')
      await reportFailure(app, job)

      const refused = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/resume`,
        payload: { instruction: 'Retry only after workspace ownership is verified.' },
      })
      expect(refused.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(refused.body).error).toContain('Cannot resume')
      expect(alignedResumeReview).not.toHaveBeenCalled()

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}/clear-quarantine`,
        payload: {
          observation: { mode: 'clean', startCommitHash: 'verified-clean-head' },
          knownGood: {
            gitOperationMarkers: [],
            worktreeClean: true,
            indexClean: true,
            headValid: true,
            blindSpotsAbsent: true,
          },
          quarantineClearedReason: 'operator cleaned and Worker verified the workspace',
        },
      })
      expect(cleared.statusCode).toBe(200)

      const resumed = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/resume`,
        payload: { instruction: 'Retry only after workspace ownership is verified.' },
      })
      expect(resumed.statusCode).toBe(201)
      expect(parseBody<Job>(resumed.body)).toMatchObject({
        status: 'queued',
        workflowStepKey: `resume:${job.id}:1`,
      })
      expect(alignedResumeReview).toHaveBeenCalledTimes(1)
      expect(repairKick).not.toHaveBeenCalled()
    })
  })

  it('keeps ordinary running implementation failures repairable', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const task = await seedTask()
      const job = await createImplementJob(task, `task:${task.id}:initial-implement`, 'running')

      const persisted = await reportFailure(app, job)

      expect(persisted.status).toBe('failed')
      expect(storage.designReviewRuns.findByTaskId(task.id)).toHaveLength(1)
      expect(repairKick).toHaveBeenCalledTimes(1)
    })
  })

  it('leaves the existing non-initial blocked quarantine behavior unchanged', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const task = await seedTask()
      const job = await createImplementJob(task, 'repair:source-job:1', 'queued')

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        payload: {
          status: 'blocked',
          stderr: 'workspace baseline failure: fingerprint failed',
          completedAt: '2026-09-30T01:02:03.000Z',
          failureMetadata: {
            kind: 'workspace_baseline_failure',
            workspaceState: 'unknown',
            quarantined: true,
            quarantineReason: 'workspace baseline failure: fingerprint failed',
          },
        },
      })

      expect(response.statusCode).toBe(200)
      expect(parseBody<Job>(response.body)).toMatchObject({
        status: 'blocked',
        failureMetadata: { kind: 'workspace_baseline_failure', quarantined: true },
      })
      expect(storage.designReviewRuns.findByTaskId(task.id)).toHaveLength(0)
      expect(repairKick).not.toHaveBeenCalled()
    })
  })
})
