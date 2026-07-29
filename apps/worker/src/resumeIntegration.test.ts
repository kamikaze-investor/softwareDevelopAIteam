import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { AiCliProvider, AiCliResult, Job, Project, Task } from '@ai-team/shared'
import { describe, expect, it, vi } from 'vitest'
import type { IAiCliAdapter } from './aiCli/adapter.js'
import { createAiCliAdapter } from './aiCli/factory.js'
import { resolveCommand } from './commandResolver.js'
import { appendObservationLog } from './approvalLevel/observationLog.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { callGateCheck, callConsume } from './guards/gateClient.js'
import { resolvePolicy } from './guards/gatePolicy.js'
import { permissionGuardWithGrants } from './guards/permissionGuard.js'
import { runJob } from './jobRunner.js'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('./aiCli/factory.js', () => ({
  createAiCliAdapter: vi.fn(),
}))

vi.mock('./commandResolver.js', () => ({
  resolveCommand: vi.fn(),
}))

vi.mock('./guards/permissionGuard.js', () => ({
  permissionGuard: vi.fn(),
  permissionGuardWithGrants: vi.fn(),
}))

vi.mock('./guards/fileChangeGuard.js', () => ({
  fileChangeGuard: vi.fn(),
}))

vi.mock('./jobLogger.js', () => ({
  saveJobLogs: vi.fn((jobId: string, stdout: string, stderr: string) => ({
    stdoutPath: `/logs/${jobId}/stdout.txt`,
    stderrPath: `/logs/${jobId}/stderr.txt`,
    stdoutPreview: stdout.slice(0, 1000),
    stderrPreview: stderr.slice(0, 1000),
  })),
}))

vi.mock('./guards/gateClient.js', () => ({
  callGateCheck: vi.fn(),
  callConsume: vi.fn(),
  GateClientError: class GateClientError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'GateClientError'
    }
  },
}))

vi.mock('./guards/gatePolicy.js', () => ({
  resolvePolicy: vi.fn(),
  SAFE_WORK_ALLOWED_COMMAND_KINDS: ['git_status', 'git_diff', 'git_log', 'typecheck', 'test', 'lint'],
}))

vi.mock('./notifier/notifier.js', () => ({
  sendAlert: vi.fn().mockResolvedValue([]),
}))

vi.mock('./approvalLevel/stepReview.js', () => ({
  runStepReview: vi.fn().mockResolvedValue({
    status: 'failed',
    summary: '(test default: runStepReview not mocked for this case)',
    concerns: [],
    requiredFixes: [],
    escalationReason: null,
    confidence: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
    rawResponse: '',
  }),
  createNotRunStepReviewResult: vi.fn((reason: string) => ({
    status: 'not_run',
    summary: reason,
    concerns: [],
    requiredFixes: [],
    escalationReason: null,
    confidence: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
    rawResponse: '',
  })),
}))

vi.mock('./approvalLevel/postReviewer.js', () => ({
  runPostReview: vi.fn().mockResolvedValue({
    jobId: 'job-1',
    taskId: 'task-1',
    reviewerResult: {
      provider: 'gemini',
      phase: 'post',
      verdict: 'approved',
      summary: '(test default)',
      issues: [],
      confidence: 0.9,
      generatedAt: '2026-01-01T00:00:00.000Z',
      rawResponse: '',
    },
    alignmentVerdict: 'aligned',
    blocked: false,
    decidedAt: '2026-01-01T00:00:00.000Z',
  }),
}))

vi.mock('./approvalLevel/observationLog.js', () => ({
  appendObservationLog: vi.fn(),
}))

const execFileSyncMock = vi.mocked(execFileSync)
const createAiCliAdapterMock = vi.mocked(createAiCliAdapter)
const resolveCommandMock = vi.mocked(resolveCommand)
const fileChangeGuardMock = vi.mocked(fileChangeGuard)
const callGateCheckMock = vi.mocked(callGateCheck)
const callConsumeMock = vi.mocked(callConsume)
const resolvePolicyMock = vi.mocked(resolvePolicy)
const permissionGuardWithGrantsMock = vi.mocked(permissionGuardWithGrants)
const appendObservationLogMock = vi.mocked(appendObservationLog)

const ALLOW_PROCEED_RESPONSE = {
  outcome: { decision: 'ALLOW' as const, riskLevel: 'LOW' },
  riskReview: { riskLevel: 'LOW' as const, triggeredRules: [], requiresIndependentReview: false },
  sideEffects: [] as Array<{ type: string; requestId: string }>,
  continuationPolicy: 'continue' as const,
  nextAction: { action: 'proceed' as const, message: 'proceed' },
}

const REJECTED_OPERATION_WARNING =
  '\u5374\u4e0b\u3055\u308c\u305f\u64cd\u4f5c\u3092\u5909\u66f4\u305b\u305a\u7e70\u308a\u8fd4\u3055\u306a\u3044\u3053\u3068'

interface InjectOptions {
  method: string
  url: string
  payload?: unknown
}

interface InjectResponse {
  statusCode: number
  body: string
}

interface TestHttpApp {
  register(plugin: unknown, options?: unknown): unknown
  ready(): Promise<void>
  inject(options: InjectOptions): Promise<InjectResponse>
  close(): Promise<void>
}

interface TestStorage {
  projects: {
    create(project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Project
  }
  tasks: {
    create(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task
  }
  jobs: {
    create(job: Omit<Job, 'id' | 'createdAt'>): Job
    findById(id: string): Job | undefined
  }
}

interface StorageModule {
  getStorage(): TestStorage
  resetStorage(): void
}

interface TaskRoutesModule {
  taskRoutes: unknown
}

function parseBody<T>(body: string): T {
  return JSON.parse(body) as T
}

async function buildResumeRouteApp(): Promise<{ app: TestHttpApp; storage: TestStorage; resetStorage: () => void }> {
  process.env.DB_PATH = ':memory:'

  const requireFromApi = createRequire(path.resolve(__dirname, '../../api/package.json'))
  const Fastify = requireFromApi('fastify') as () => TestHttpApp

  const storageModulePath = '../../api/src/storage/index.ts'
  const taskRoutesModulePath = '../../api/src/routes/tasks.ts'
  const storageModule = await import(storageModulePath) as unknown as StorageModule
  const taskRoutesModule = await import(taskRoutesModulePath) as unknown as TaskRoutesModule

  storageModule.resetStorage()
  const storage = storageModule.getStorage()
  const app = Fastify()
  app.register(taskRoutesModule.taskRoutes, { prefix: '/api/tasks' })
  await app.ready()

  return { app, storage, resetStorage: storageModule.resetStorage }
}

function makeCliResult(taskId: string, provider: AiCliProvider): AiCliResult {
  return {
    taskId,
    provider,
    exitCode: 0,
    stdout: 'ai cli completed',
    stderr: '',
    changedFiles: [],
    durationMs: 1,
    blocked: false,
  }
}

function resetWorkerMocks(): void {
  vi.clearAllMocks()

  callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
  callConsumeMock.mockResolvedValue({ ok: true })
  resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
  permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
  resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
  fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
  execFileSyncMock.mockReturnValue('')
}

describe('resume API to worker integration', () => {
  it('persists resumed AI CLI fields and Worker runJob reads them after Approval Gate', async () => {
    resetWorkerMocks()

    const previousDbPath = process.env.DB_PATH
    let app: TestHttpApp | undefined
    let resetStorage: (() => void) | undefined

    try {
      const built = await buildResumeRouteApp()
      app = built.app
      resetStorage = built.resetStorage
      const { storage } = built

      const project = storage.projects.create({
        name: 'Resume integration',
        goal: 'Verify resume handoff to Worker',
        designPhilosophy: [],
        status: 'draft',
      })
      const task = storage.tasks.create({
        projectId: project.id,
        title: 'Fix blocked deployment',
        description: 'Update only the allowed API files.',
        status: 'blocked',
        assignee: 'developer_ai',
        dependencies: [],
        roadmapActive: false,
      })
      const blockedJob = storage.jobs.create({
        taskId: task.id,
        projectId: project.id,
        agentRole: 'developer_ai',
        status: 'blocked',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
        aiCliProvider: 'codex',
        aiCliPrompt: 'Original blocked prompt',
        aiCliMode: 'implement',
      })

      const instruction = 'Use the existing storage interface and add tests.'
      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/resume`,
        payload: { instruction },
      })

      expect(response.statusCode).toBe(201)
      const responseJob = parseBody<Job>(response.body)
      expect(responseJob.id).not.toBe(blockedJob.id)

      const resumedJob = storage.jobs.findById(responseJob.id)
      expect(resumedJob).toBeDefined()
      if (!resumedJob) throw new Error('resumed job was not persisted')

      expect(resumedJob.status).toBe('queued')
      expect(resumedJob.safeCommand).toEqual(blockedJob.safeCommand)
      expect(resumedJob.aiCliProvider).toBe(blockedJob.aiCliProvider)
      expect(resumedJob.aiCliMode).toBe(blockedJob.aiCliMode)
      expect(resumedJob.aiCliPrompt).toContain('[Task] Fix blocked deployment')
      expect(resumedJob.aiCliPrompt).toContain('Update only the allowed API files.')
      expect(resumedJob.aiCliPrompt).toContain(instruction)
      expect(resumedJob.aiCliPrompt).toContain(REJECTED_OPERATION_WARNING)

      const adapterRunMock = vi.fn(async () => makeCliResult(task.id, 'codex'))
      const mockAdapter: IAiCliAdapter = { run: adapterRunMock }
      createAiCliAdapterMock.mockReturnValue(mockAdapter)

      const runResult = await runJob(resumedJob)

      expect(runResult.status).toBe('success')
      expect(callGateCheckMock).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id,
        requestedAction: 'git_status',
      }))
      expect(createAiCliAdapterMock).toHaveBeenCalledWith({ provider: 'codex' })
      expect(adapterRunMock).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id,
        provider: 'codex',
        workingDir: '/workspace/target',
        prompt: resumedJob.aiCliPrompt,
        contextFiles: [],
        mode: 'implement',
      }))
      expect(callGateCheckMock.mock.invocationCallOrder[0]).toBeLessThan(
        adapterRunMock.mock.invocationCallOrder[0],
      )
      expect(callConsumeMock).not.toHaveBeenCalled()
      expect(appendObservationLogMock).toHaveBeenCalled()

      const unchangedBlockedJob = storage.jobs.findById(blockedJob.id)
      expect(unchangedBlockedJob).toMatchObject({
        id: blockedJob.id,
        status: 'blocked',
        safeCommand: blockedJob.safeCommand,
        aiCliProvider: 'codex',
        aiCliPrompt: 'Original blocked prompt',
        aiCliMode: 'implement',
      })
    } finally {
      await app?.close()
      resetStorage?.()
      if (previousDbPath === undefined) {
        delete process.env.DB_PATH
      } else {
        process.env.DB_PATH = previousDbPath
      }
    }
  })
})
