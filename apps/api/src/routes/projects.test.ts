import { mkdirSync } from 'node:fs'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approval, ApprovalType, JobStatus, Project, ProjectRoadmapCompletion } from '@ai-team/shared'

const roadmapMocks = vi.hoisted(() => ({ generateRoadmap: vi.fn() }))
vi.mock('../ctoAi/roadmapGenerator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ctoAi/roadmapGenerator.js')>()),
  generateRoadmap: roadmapMocks.generateRoadmap,
}))
const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
  integrationReviewResult: { decision: 'ALIGNED' },
})
const designReviewMocks = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ ok: true, timedOut: false, stdout: '' })),
}))
vi.mock('../designReview/designReviewCoordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../designReview/designReviewCoordinator')>()),
  buildDefaultCoordinatorDeps: () => ({
    runnerCommand: 'node', runnerArgs: [], homeDirectory: '/tmp', workingDir: '/tmp',
    execute: designReviewMocks.execute,
  }),
}))
vi.mock('../ctoAi/projectMemoryWriter.js', async (importOriginal) => ({ ...(await importOriginal()), writeProjectMemory: () => ({ writtenFiles: [], targetDir: process.env.TARGET_ROOT ?? '/tmp' }) }))
vi.mock('../ctoAi/roadmapWriter.js', () => ({ writeRoadmap: () => ({ writtenFiles: [], targetDir: process.env.TARGET_ROOT ?? '/tmp' }) }))

function noGapsAnalysis(goal: string, designPhilosophy: string[]) {
  return {
    goal, designPhilosophy,
    mvpScope: { description: goal, includedFeatures: [], excludedFeatures: [] },
    targetUsers: [], techStack: [], gaps: [], structuredConstraints: [], requiredExternalServices: [],
    readinessScore: 100, readinessReason: 'no gaps (test default)',
  }
}
const specAnalyzerMocks = vi.hoisted(() => ({ analyzeSpec: vi.fn() }))
vi.mock('../ctoAi/specAnalyzer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ctoAi/specAnalyzer.js')>()),
  analyzeSpec: specAnalyzerMocks.analyzeSpec,
}))

async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { approvalRoutes }, { resetStorage }] = await Promise.all([
    import('./projects.js'),
    import('./approvals.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(approvalRoutes, { prefix: '/api' })
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

async function createProject(app: FastifyInstance, body: Partial<Project> = {}): Promise<Project> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Project',
      goal: 'Goal',
      designPhilosophy: [],
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Project>(res.body)
}

async function createProjectJob(projectId: string, status: JobStatus): Promise<void> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()
  const task = storage.tasks.create({
    projectId,
    title: 'Task',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
  storage.jobs.create({
    taskId: task.id,
    projectId,
    agentRole: 'developer_ai',
    status,
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
  })
}

async function createApproval(
  app: FastifyInstance,
  projectId: string,
  body: { title?: string; reason?: string; type?: ApprovalType } = {},
): Promise<Approval> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/approvals`,
    payload: {
      title: 'Approval',
      reason: 'Need approval',
      type: 'external_service',
      ...body,
    },
  })

  expect(res.statusCode).toBe(201)
  return parseBody<Approval>(res.body)
}

beforeEach(() => {
  vi.resetModules()
  process.env.DB_PATH = ':memory:'
  process.env.TARGET_ROOT = '/tmp/project-route-test'
  mkdirSync(process.env.TARGET_ROOT, { recursive: true })
  roadmapMocks.generateRoadmap.mockReset()
  roadmapMocks.generateRoadmap.mockResolvedValue({ phases: [{ number: 1, name: 'Foundation', goal: 'Start', tasks: ['task-001'] }], tasks: [{ id: 'task-001', title: 'Implement', description: 'Implement.', phase: 1, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [], estimatedComplexity: 'small' }], totalTasks: 1, estimatedWeeks: 1 })
  designReviewMocks.execute.mockReset()
  designReviewMocks.execute.mockResolvedValue({ ok: true, timedOut: false, stdout: ALIGNED_STDOUT })
  specAnalyzerMocks.analyzeSpec.mockReset()
  specAnalyzerMocks.analyzeSpec.mockImplementation(async (specText: string) => noGapsAnalysis(specText, []))
})

describe('Project API', () => {
  it('GET /api/projects returns an empty list', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project[]>(res.body)).toEqual([])
    })
  })

  it('POST /api/projects creates a project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Test', goal: 'Test goal', designPhilosophy: [] },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Project>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.name).toBe('Test')
      expect(body.status).toBe('draft')
    })
  })

  it('GET /api/projects/:id returns a project', async () => {
    await withApp(async (app) => {
      const created = await createProject(app, { name: 'P', goal: 'g' })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project>(res.body).name).toBe('P')
    })
  })

  it('GET /api/projects/:id returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/not-exist' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project not found')
    })
  })

  it('GET /api/projects/:id/roadmap returns synced phases ordered by phaseNumber', async () => {
    await withApp(async (app) => {
      const created = await createProject(app, { name: 'P', goal: 'g' })

      const { getStorage } = await import('../storage/index.js')
      getStorage().tasks.syncRoadmapTasks({
        projectId: created.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 1, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 1, name: 'First', goal: 'G1' }],
      })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/roadmap` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<{ completion: ProjectRoadmapCompletion; phases: Array<{ phaseNumber: number; name: string }> }>(res.body)
      expect(body.phases).toEqual([
        expect.objectContaining({ phaseNumber: 1, name: 'First', roadmapActive: true }),
      ])
      expect(body.completion).toEqual({ completedTaskCount: 0, isComplete: false, totalTaskCount: 1 })
    })
  })

  it('GET /api/projects/:id/roadmap derives completion from active roadmap tasks only', async () => {
    await withApp(async (app) => {
      const completed = await createProject(app, { name: 'Completed', goal: 'g' })
      const incomplete = await createProject(app, { name: 'Incomplete', goal: 'g' })
      const noRoadmap = await createProject(app, { name: 'No roadmap', goal: 'g' })
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()

      storage.tasks.syncRoadmapTasks({
        projectId: completed.id,
        tasks: [{ roadmapTaskKey: 'task-001', title: 'Done', description: '', phase: 1, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [] }],
        phases: [{ phaseNumber: 1, name: 'Complete', goal: 'g' }],
      })
      const completedTask = storage.tasks.findByProjectId(completed.id)[0]
      storage.tasks.update(completedTask.id, { status: 'done' })
      storage.tasks.create({
        projectId: completed.id,
        title: 'Manual pending task',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })

      storage.tasks.syncRoadmapTasks({
        projectId: incomplete.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'Done', description: '', phase: 1, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
          { roadmapTaskKey: 'task-002', title: 'Pending', description: '', phase: 1, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 1, name: 'Incomplete', goal: 'g' }],
      })
      const incompleteTasks = storage.tasks.findByProjectId(incomplete.id)
      storage.tasks.update(incompleteTasks[0].id, { status: 'done' })

      const [completedRes, incompleteRes, noRoadmapRes] = await Promise.all([
        app.inject({ method: 'GET', url: `/api/projects/${completed.id}/roadmap` }),
        app.inject({ method: 'GET', url: `/api/projects/${incomplete.id}/roadmap` }),
        app.inject({ method: 'GET', url: `/api/projects/${noRoadmap.id}/roadmap` }),
      ])

      expect(parseBody<{ completion: ProjectRoadmapCompletion }>(completedRes.body).completion)
        .toEqual({ completedTaskCount: 1, isComplete: true, totalTaskCount: 1 })
      expect(parseBody<{ completion: ProjectRoadmapCompletion }>(incompleteRes.body).completion)
        .toEqual({ completedTaskCount: 1, isComplete: false, totalTaskCount: 2 })
      expect(parseBody<{ completion: ProjectRoadmapCompletion }>(noRoadmapRes.body).completion)
        .toEqual({ completedTaskCount: 0, isComplete: false, totalTaskCount: 0 })
    })
  })

  it('GET /api/projects/:id/roadmap excludes deactivated phases while DB history is preserved', async () => {
    await withApp(async (app) => {
      const created = await createProject(app, { name: 'P', goal: 'g' })
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()

      storage.tasks.syncRoadmapTasks({
        projectId: created.id,
        tasks: [
          { roadmapTaskKey: 'task-001', title: 'T1', description: '', phase: 1, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 1, name: 'Old phase', goal: 'Old goal' }],
      })
      // 再生成でphase 1が消え、phase 2だけが現行Roadmapになる
      storage.tasks.syncRoadmapTasks({
        projectId: created.id,
        tasks: [
          { roadmapTaskKey: 'task-002', title: 'T2', description: '', phase: 2, assignee: 'developer_ai', category: 'implementation', dependencies: [], acceptanceCriteria: [], allowedPaths: [] },
        ],
        phases: [{ phaseNumber: 2, name: 'New phase', goal: 'New goal' }],
      })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${created.id}/roadmap` })
      const body = parseBody<{ phases: Array<{ phaseNumber: number; roadmapActive: boolean }> }>(res.body)

      // APIは現行Roadmap（active）のみ返す
      expect(body.phases).toHaveLength(1)
      expect(body.phases[0]).toMatchObject({ phaseNumber: 2, roadmapActive: true })

      // DBには履歴としてinactiveなphase 1が残っている（削除されていない）
      const allPhases = storage.projectRoadmapPhases.findByProjectId(created.id)
      expect(allPhases).toHaveLength(2)
      expect(allPhases.find((p) => p.phaseNumber === 1)?.roadmapActive).toBe(false)
    })
  })

  it('GET /api/projects/:id/roadmap returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/not-exist/roadmap' })

      expect(res.statusCode).toBe(404)
    })
  })

  it('PATCH /api/projects/:id updates a project', async () => {
    await withApp(async (app) => {
      const created = await createProject(app, { name: 'Old' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${created.id}`,
        payload: { name: 'New' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project>(res.body).name).toBe('New')
    })
  })

  it('PATCH /api/projects/:id rejects archived to running', async () => {
    await withApp(async (app) => {
      const archived = await createProject(app, { status: 'archived' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${archived.id}`,
        payload: { status: 'running' },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe(
        'Cannot resume an archived project directly to running',
      )
    })
  })

  it('PATCH /api/projects/:id allows archived to paused', async () => {
    await withApp(async (app) => {
      const archived = await createProject(app, { status: 'archived' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${archived.id}`,
        payload: { status: 'paused' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project>(res.body).status).toBe('paused')
    })
  })

  it('PATCH /api/projects/:id retries a pending Task continuation left over from a pause', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const project = await createProject(app, { status: 'draft' })

      const startRes = await app.inject({
        method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' },
      })
      expect(startRes.statusCode).toBe(200)
      const sourceTask = storage.tasks.findByProjectId(project.id)[0]
      expect(sourceTask).toBeDefined()

      const nextTask = storage.tasks.create({
        projectId: project.id, title: 'Next', description: 'Implement next.', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 2,
      })
      const sourceJob = storage.jobs.create({
        taskId: sourceTask.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      })
      const continuation = storage.taskContinuations.create({
        sourceJobId: sourceJob.id, projectId: project.id, completedTaskId: sourceTask.id,
        nextTaskId: nextTask.id, status: 'pending',
      })

      const pauseRes = await app.inject({
        method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'paused' },
      })
      expect(pauseRes.statusCode).toBe(200)

      const resumeRes = await app.inject({
        method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' },
      })
      expect(resumeRes.statusCode).toBe(200)

      // ensureTaskContinuation() runs fire-and-forget (not awaited by the route) so the
      // next Task's Job creation happens asynchronously after the PATCH response.
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(1)
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('completed')
    })
  })

  it('a resume attempt that cannot complete yet is retried by the next poll, not stranded forever', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const project = await createProject(app, { status: 'draft' })

      const startRes = await app.inject({
        method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' },
      })
      expect(startRes.statusCode).toBe(200)
      const sourceTask = storage.tasks.findByProjectId(project.id)[0]

      // nextTask depends on a still-pending blocker, so the FIRST retry attempt (fired by
      // the resume PATCH itself) cannot create its Job yet -- createInitialImplementWorkflow()
      // returns a `retryable: true` skip for "task dependencies are not yet done", which
      // ensureTaskContinuation() leaves 'pending' rather than failing.
      const blockerTask = storage.tasks.create({
        projectId: project.id, title: 'Blocker', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 2,
      })
      const nextTask = storage.tasks.create({
        projectId: project.id, title: 'Next', description: 'Implement next.', status: 'pending',
        assignee: 'developer_ai', dependencies: [blockerTask.id], roadmapActive: true, phase: 3,
      })
      const sourceJob = storage.jobs.create({
        taskId: sourceTask.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      })
      const continuation = storage.taskContinuations.create({
        sourceJobId: sourceJob.id, projectId: project.id, completedTaskId: sourceTask.id,
        nextTaskId: nextTask.id, status: 'pending',
      })

      await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'paused' } })
      const resumeRes = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
      expect(resumeRes.statusCode).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The resume-time attempt alone could not complete: it is not "try once and give up".
      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(0)
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('pending')

      // The blocker resolves later, independent of any further PATCH from the CEO.
      storage.tasks.update(blockerTask.id, { status: 'done' })

      // Mobile's existing poll of GET /api/projects/:id (usePolling) is what recovers it --
      // not a second manual resume action.
      const pollRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })
      expect(pollRes.statusCode).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(1)
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('completed')
    })
  })

  it('concurrent continuation retries never create more than one Job for the same continuation', async () => {
    await withApp(async (app) => {
      const { getStorage } = await import('../storage/index.js')
      const { retryPendingContinuationsForProject } = await import('../ctoAi/taskContinuation.js')
      const storage = getStorage()
      const project = await createProject(app, { status: 'draft' })

      await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
      const sourceTask = storage.tasks.findByProjectId(project.id)[0]

      const nextTask = storage.tasks.create({
        projectId: project.id, title: 'Next', description: 'Implement next.', status: 'pending',
        assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 2,
      })
      const sourceJob = storage.jobs.create({
        taskId: sourceTask.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
        safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
      })
      const continuation = storage.taskContinuations.create({
        sourceJobId: sourceJob.id, projectId: project.id, completedTaskId: sourceTask.id,
        nextTaskId: nextTask.id, status: 'pending',
      })

      // Simulates the resume-time sweep and a poll-triggered sweep (GET /:id or GET /)
      // landing at nearly the same moment -- the exact race the Outbox 503 path already had
      // to be safe against via the workflow_step_key unique index.
      await Promise.all([
        retryPendingContinuationsForProject(storage, project.id),
        retryPendingContinuationsForProject(storage, project.id),
      ])

      expect(storage.jobs.findByTaskId(nextTask.id)).toHaveLength(1)
      expect(storage.taskContinuations.findById(continuation.id)?.status).toBe('completed')
    })
  })

  it('PATCH /api/projects/:id archives a draft project with no Jobs', async () => {
    await withApp(async (app) => {
      const draft = await createProject(app, { status: 'draft' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${draft.id}`,
        payload: { status: 'archived' },
      })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project>(res.body).status).toBe('archived')
    })
  })

  it.each(['queued', 'blocked'] as const)(
    'PATCH /api/projects/:id archives a project with only a %s Job',
    async (jobStatus) => {
      await withApp(async (app) => {
        const project = await createProject(app, { status: 'paused' })
        await createProjectJob(project.id, jobStatus)

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/projects/${project.id}`,
          payload: { status: 'archived' },
        })

        expect(res.statusCode).toBe(200)
        expect(parseBody<Project>(res.body).status).toBe('archived')
      })
    },
  )

  it('PATCH /api/projects/:id rejects archive while a Job is running', async () => {
    await withApp(async (app) => {
      const project = await createProject(app, { status: 'running' })
      await createProjectJob(project.id, 'running')

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}`,
        payload: { status: 'archived' },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe(
        'Cannot archive project while a Job is running',
      )
    })
  })

  it('POST /api/projects returns 409 when another project is already running', async () => {
    await withApp(async (app) => {
      await createProject(app, { name: 'Running', status: 'running' })

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Second running',
          goal: 'Goal',
          designPhilosophy: [],
          status: 'running',
        },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Another project is already running')
    })
  })

  it('PATCH /api/projects/:id returns 409 when another project is already running', async () => {
    await withApp(async (app) => {
      await createProject(app, { name: 'Running', status: 'running' })
      const other = await createProject(app, { name: 'Other', status: 'draft' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${other.id}`,
        payload: { status: 'running' },
      })

      expect(res.statusCode).toBe(409)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Another project is already running')
    })
  })

  it('PATCH /api/projects/:id allows a running project to remain running', async () => {
    await withApp(async (app) => {
      const running = await createProject(app, { name: 'Running', status: 'running' })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${running.id}`,
        payload: { name: 'Still running', status: 'running' },
      })

      expect(res.statusCode, res.body).toBe(200)
      const body = parseBody<Project>(res.body)
      expect(body.id).toBe(running.id)
      expect(body.name).toBe('Still running')
      expect(body.status).toBe('running')
    })
  })

  it('POST /api/projects allows multiple non-running projects for each status', async () => {
    await withApp(async (app) => {
      const statuses = ['draft', 'paused', 'archived'] as const

      for (const status of statuses) {
        await createProject(app, { name: `${status}-1`, status })
        await createProject(app, { name: `${status}-2`, status })
      }

      const res = await app.inject({ method: 'GET', url: '/api/projects' })

      expect(res.statusCode).toBe(200)
      expect(parseBody<Project[]>(res.body)).toHaveLength(statuses.length * 2)
    })
  })

  it('starts draft through roadmap task and initial job once', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const first = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
      expect(first.statusCode).toBe(200)
      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage(); const tasks = storage.tasks.findByProjectId(project.id)
      expect(tasks).toHaveLength(1); expect(storage.jobs.findByTaskId(tasks[0].id)).toHaveLength(1)
      const second = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
      expect(second.statusCode).toBe(200); expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1); expect(storage.jobs.findByTaskId(tasks[0].id)).toHaveLength(1)
    })
  })

  it('POST /api/projects returns 400 for invalid input', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { goal: 'g' },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  describe('Interactive Project Definition / Readiness (Gap Analysis gating)', () => {
    it('an important (must_resolve) Gap blocks the running transition and is returned to the caller', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { goal: 'Vague goal' })
        specAnalyzerMocks.analyzeSpec.mockResolvedValueOnce({
          ...noGapsAnalysis('Vague goal', []),
          gaps: [{ category: 'business', description: '対象ユーザーが不明', severity: 'must_resolve', suggestion: '対象ユーザーを教えてください' }],
        })

        const res = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })

        expect(res.statusCode).toBe(409)
        const body = parseBody<{ error: string; gaps: Array<{ description: string }> }>(res.body)
        expect(body.error).toBe('Project Definition has unresolved gaps')
        expect(body.gaps).toHaveLength(1)
        expect(body.gaps[0].description).toBe('対象ユーザーが不明')

        const { getStorage } = await import('../storage/index.js')
        const storage = getStorage()
        expect(storage.projects.findById(project.id)?.status).toBe('draft')
        expect(storage.tasks.findByProjectId(project.id)).toHaveLength(0)
      })
    })

    it('a should_resolve/optional Gap does not block -- the normal fast path is unaffected', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { goal: 'Mostly clear goal' })
        specAnalyzerMocks.analyzeSpec.mockResolvedValueOnce({
          ...noGapsAnalysis('Mostly clear goal', []),
          gaps: [{ category: 'technical', description: 'minor detail', severity: 'should_resolve', suggestion: 's' }],
        })

        const res = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })

        expect(res.statusCode).toBe(200)
        const { getStorage } = await import('../storage/index.js')
        expect(getStorage().tasks.findByProjectId(project.id)).toHaveLength(1)
      })
    })

    it('low readiness blocks the running transition and synthesizes an answerable Gap when the model returned none (independent-review fix: the Mobile gaps screen has no input when gaps=[])', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { goal: 'Vague but gapless goal' })
        specAnalyzerMocks.analyzeSpec.mockResolvedValueOnce({
          ...noGapsAnalysis('Vague but gapless goal', []),
          readinessScore: 55,
          readinessReason: 'Scope is too vague to plan safely.',
        })

        const res = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })

        expect(res.statusCode).toBe(409)
        const body = parseBody<{
          gaps: Array<{ severity: string; description: string; suggestion: string }>
          readinessReason: string; readinessScore: number; reason: string
        }>(res.body)
        // A concrete, answerable Gap is synthesized so the existing gaps screen (which only
        // renders question cards with an input, not a bare message) always has something the
        // CEO can respond to -- not an empty, non-actionable dead end.
        expect(body.gaps).toHaveLength(1)
        expect(body.gaps[0].severity).toBe('must_resolve')
        expect(body.gaps[0].suggestion).toBe('Scope is too vague to plan safely.')
        expect(body.readinessScore).toBe(55)
        expect(body.readinessReason).toBe('Scope is too vague to plan safely.')
        expect(body.reason).toContain('readiness score is below 70')

        const { getStorage } = await import('../storage/index.js')
        const storage = getStorage()
        expect(storage.projects.findById(project.id)?.status).toBe('draft')
        expect(storage.tasks.findByProjectId(project.id)).toHaveLength(0)
      })
    })

    it('answering the Gap and resubmitting proceeds without a second manual Start', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { goal: 'Vague goal' })
        specAnalyzerMocks.analyzeSpec.mockResolvedValueOnce({
          ...noGapsAnalysis('Vague goal', []),
          gaps: [{ category: 'business', description: '対象ユーザーが不明', severity: 'must_resolve', suggestion: 's' }],
        })
        const blocked = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
        expect(blocked.statusCode).toBe(409)

        // Second analyzeSpec call (after the CEO answers) reports no more important gaps --
        // the mock default (noGapsAnalysis) covers this without a second mockResolvedValueOnce.
        const resolved = await app.inject({
          method: 'PATCH',
          url: `/api/projects/${project.id}`,
          payload: { status: 'running', gapAnswers: { '対象ユーザーが不明': '中小企業の経理担当者' } },
        })

        expect(resolved.statusCode).toBe(200)
        expect(specAnalyzerMocks.analyzeSpec.mock.calls[1][0]).toContain('中小企業の経理担当者')
        const { getStorage } = await import('../storage/index.js')
        expect(getStorage().tasks.findByProjectId(project.id)).toHaveLength(1)
      })
    })

    it('threads canonical Project Definition metadata into Roadmap generation on first Start', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, {
          goal: 'Plan from this goal',
          designPhilosophy: ['Keep the first version small'],
        })

        const res = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })

        expect(res.statusCode).toBe(200)
        const lastCall = roadmapMocks.generateRoadmap.mock.calls.at(-1)
        expect(lastCall?.[1]).toEqual(expect.objectContaining({
          canonicalDefinitionText: expect.stringContaining('Plan from this goal'),
          definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }))
        expect(lastCall?.[1]?.canonicalDefinitionText).toContain('Keep the first version small')
      })
    })

    it('field edits submitted alongside a blocked Start are still saved (normal creation experience preserved)', async () => {
      await withApp(async (app) => {
        const project = await createProject(app, { goal: 'Vague goal' })
        specAnalyzerMocks.analyzeSpec.mockResolvedValueOnce({
          ...noGapsAnalysis('Vague goal', []),
          gaps: [{ category: 'business', description: 'gap', severity: 'must_resolve', suggestion: 's' }],
        })

        const res = await app.inject({
          method: 'PATCH', url: `/api/projects/${project.id}`,
          payload: { status: 'running', goal: 'Refined goal' },
        })

        expect(res.statusCode).toBe(409)
        const { getStorage } = await import('../storage/index.js')
        const stored = getStorage().projects.findById(project.id)
        expect(stored?.goal).toBe('Refined goal')
        expect(stored?.status).toBe('draft')
      })
    })

    it('resuming an already-initialized Project (hasActiveRoadmap) does not re-run Gap Analysis', async () => {
      await withApp(async (app) => {
        const project = await createProject(app)
        await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
        specAnalyzerMocks.analyzeSpec.mockClear()

        await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'paused' } })
        const resumeRes = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })

        expect(resumeRes.statusCode).toBe(200)
        expect(specAnalyzerMocks.analyzeSpec).not.toHaveBeenCalled()
      })
    })

    it.each([
      ['goal', { goal: 'Changed goal' }],
      ['designPhilosophy', { designPhilosophy: ['Changed philosophy'] }],
    ] as const)(
      'rejects %s edits once an active Roadmap exists',
      async (_field, payload) => {
        await withApp(async (app) => {
          const project = await createProject(app, {
            goal: 'Original goal',
            designPhilosophy: ['Original philosophy'],
          })
          const startRes = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload: { status: 'running' } })
          expect(startRes.statusCode).toBe(200)
          specAnalyzerMocks.analyzeSpec.mockClear()

          const res = await app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload })

          expect(res.statusCode).toBe(409)
          expect(parseBody<{ error: string }>(res.body).error).toBe('Project Definition cannot be edited after Roadmap generation')
          const { getStorage } = await import('../storage/index.js')
          const stored = getStorage().projects.findById(project.id)
          expect(stored?.goal).toBe('Original goal')
          expect(stored?.designPhilosophy).toEqual(['Original philosophy'])
          expect(specAnalyzerMocks.analyzeSpec).not.toHaveBeenCalled()
        })
      },
    )
  })
})

describe('Approval API', () => {
  it('GET /api/projects/:projectId/approvals returns pending approvals', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      await createApproval(app, project.id, { title: 'A' })

      const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals` })

      expect(res.statusCode).toBe(200)
      const body = parseBody<Approval[]>(res.body)
      expect(body).toHaveLength(1)
      expect(body[0].title).toBe('A')
      expect(body[0].status).toBe('pending')
    })
  })

  it('GET /api/projects/:projectId/approvals returns 404 for a missing project', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/projects/not-exist/approvals' })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Project not found')
    })
  })

  it('POST /api/projects/:projectId/approvals creates a pending approval', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/approvals`,
        payload: {
          title: 'Deploy',
          reason: 'Need deployment approval',
          type: 'deployment',
        },
      })

      expect(res.statusCode).toBe(201)
      const body = parseBody<Approval>(res.body)
      expect(body.id).toBeTruthy()
      expect(body.title).toBe('Deploy')
      expect(body.status).toBe('pending')
    })
  })

  it('POST /api/projects/:projectId/approvals returns 400 for invalid input', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/approvals`,
        payload: { title: 'Missing reason', type: 'security' },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  it('PATCH /api/approvals/:id updates approval status and review metadata', async () => {
    await withApp(async (app) => {
      const project = await createProject(app)
      const approval = await createApproval(app, project.id)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/approvals/${approval.id}`,
        payload: { status: 'approved', reviewNote: 'ok' },
      })

      expect(res.statusCode).toBe(200)
      const updated = parseBody<Approval>(res.body)
      expect(updated.status).toBe('approved')
      expect(updated.reviewNote).toBe('ok')
      expect(updated.reviewedAt).toBeTruthy()

      const pending = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals` })
      expect(parseBody<Approval[]>(pending.body)).toEqual([])
    })
  })

  it('PATCH /api/approvals/:id returns 404 for a missing approval', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/approvals/not-exist',
        payload: { status: 'rejected' },
      })

      expect(res.statusCode).toBe(404)
      expect(parseBody<{ error: string }>(res.body).error).toBe('Approval not found')
    })
  })
})
