import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from '@ai-team/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage, RoadmapSyncResult } from '../storage/interface'
import {
  initializeApprovedProject,
  ProjectInitializationError,
} from './projectInitialization'
import type { Roadmap } from './roadmapGenerator'
import type { SpecAnalysis } from './specAnalyzer'

const reviewMocks = vi.hoisted(() => ({
  execute: vi.fn(),
}))

const workflowMocks = vi.hoisted(() => ({
  createInitialImplementWorkflow: vi.fn(async (_storage: IStorage, taskId: string) => ({
    taskId,
    status: 'skipped' as const,
    reason: 'test',
  })),
}))

vi.mock('../designReview/designReviewCoordinator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../designReview/designReviewCoordinator.js')>()),
  buildDefaultCoordinatorDeps: () => ({
    runnerCommand: 'node',
    runnerArgs: [],
    homeDirectory: '/tmp',
    workingDir: '/tmp',
    execute: reviewMocks.execute,
  }),
}))

vi.mock('./initialImplementWorkflow.js', () => ({
  createInitialImplementWorkflow: workflowMocks.createInitialImplementWorkflow,
}))

const TASK_ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
  integrationReviewResult: { decision: 'ALIGNED' },
})

function roadmapStdout(focusDecision: 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN' = 'ALIGNED'): string {
  return JSON.stringify({
    focusedReviewResults: [
      { focus: 'strategic_alignment', decision: focusDecision },
      { focus: 'scope_simplicity', decision: 'ALIGNED' },
      { focus: 'architecture_responsibility', decision: 'ALIGNED' },
    ],
    integrationReviewResult: { decision: 'ALIGNED' },
    independentReviewResult: { verdict: 'approved' },
  })
}

function stdoutForReviewInput(input: string): string {
  const parsed = JSON.parse(input) as { reviewKind?: string }
  return parsed.reviewKind === 'roadmap' ? roadmapStdout() : TASK_ALIGNED_STDOUT
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
}

const ANALYSIS: SpecAnalysis = {
  goal: 'Build a reliable project initialization flow.',
  designPhilosophy: ['Keep gates fail-closed before persistence.'],
  mvpScope: {
    description: 'Initialize an approved project safely.',
    includedFeatures: [],
    excludedFeatures: [],
  },
  targetUsers: [],
  techStack: [],
  gaps: [],
  structuredConstraints: [],
  requiredExternalServices: [],
  readinessScore: 100,
  readinessReason: 'Ready for initialization.',
}

const ROADMAP: Roadmap = {
  phases: [
    {
      number: 1,
      name: 'Foundation',
      goal: 'Create the first implementation task.',
      tasks: ['task-001'],
    },
  ],
  tasks: [
    {
      id: 'task-001',
      title: 'Implement foundation',
      description: 'Implement the first foundation task.',
      phase: 1,
      assignee: 'developer_ai',
      category: 'implementation',
      dependencies: [],
      acceptanceCriteria: ['The foundation task is implemented.'],
      allowedPaths: ['apps/api/src/'],
      estimatedComplexity: 'small',
    },
  ],
  totalTasks: 1,
  estimatedWeeks: 1,
}

function createProject(storage: IStorage): Project {
  return storage.projects.create({
    name: 'Project',
    goal: ANALYSIS.goal,
    designPhilosophy: ANALYSIS.designPhilosophy,
    status: 'running',
  })
}

async function expectInitialization422(
  action: () => Promise<unknown>,
): Promise<ProjectInitializationError> {
  try {
    await action()
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(ProjectInitializationError)
    const error = err as ProjectInitializationError
    expect(error.statusCode).toBe(422)
    return error
  }
  throw new Error('Expected ProjectInitializationError with statusCode=422')
}

describe('initializeApprovedProject Whole-Roadmap Design Review gate', () => {
  let storage: IStorage
  let tmpDir: string

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'project-initialization-review-'))
    initGitRepo(tmpDir)
    reviewMocks.execute.mockReset()
    reviewMocks.execute.mockImplementation(async (input: string) => ({
      ok: true,
      timedOut: false,
      stdout: stdoutForReviewInput(input),
    }))
    workflowMocks.createInitialImplementWorkflow.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores ALIGNED roadmap evidence before syncing any Task rows', async () => {
    const project = createProject(storage)
    const events: string[] = []
    const originalSyncRoadmapTasks = storage.tasks.syncRoadmapTasks.bind(storage.tasks)
    storage.tasks.syncRoadmapTasks = (input): RoadmapSyncResult => {
      const evidence = storage.designReviewEvidence.findLatestBySubjectId('roadmap', input.projectId)
      events.push(`sync-before:tasks=${storage.tasks.findByProjectId(input.projectId).length}`)
      events.push(`sync-before:evidence=${evidence?.decision ?? 'none'}`)
      const result = originalSyncRoadmapTasks(input)
      events.push(`sync-after:tasks=${storage.tasks.findByProjectId(input.projectId).length}`)
      return result
    }
    reviewMocks.execute.mockImplementation(async (input: string) => {
      const parsed = JSON.parse(input) as { reviewKind?: string }
      if (parsed.reviewKind === 'roadmap') {
        events.push(`roadmap-execute:tasks=${storage.tasks.findByProjectId(project.id).length}`)
      }
      return { ok: true, timedOut: false, stdout: stdoutForReviewInput(input) }
    })

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
      canonicalDefinitionText: '# Goal\n\nBuild a reliable project initialization flow.',
    })

    expect(events).toEqual([
      'roadmap-execute:tasks=0',
      'sync-before:tasks=0',
      'sync-before:evidence=ALIGNED',
      'sync-after:tasks=1',
    ])
    const evidence = storage.designReviewEvidence.findLatestBySubjectId('roadmap', project.id)
    expect(evidence).toMatchObject({
      reviewKind: 'roadmap',
      subjectId: project.id,
      decision: 'ALIGNED',
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
  })

  it.each(['CONFLICT', 'UNCERTAIN'] as const)(
    'fails closed and creates no Tasks when the roadmap review returns %s',
    async (focusDecision) => {
      const project = createProject(storage)
      reviewMocks.execute.mockImplementation(async (input: string) => {
        const parsed = JSON.parse(input) as { reviewKind?: string }
        return {
          ok: true,
          timedOut: false,
          stdout: parsed.reviewKind === 'roadmap' ? roadmapStdout(focusDecision) : TASK_ALIGNED_STDOUT,
        }
      })

      const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
        analysis: ANALYSIS,
        mockResponse: JSON.stringify(ROADMAP),
        writeProjectMemory: true,
      }))

      expect(error.message).toBe('Whole-Roadmap Design Review did not align or could not complete')
      expect(storage.tasks.findByProjectId(project.id)).toEqual([])
      expect(workflowMocks.createInitialImplementWorkflow).not.toHaveBeenCalled()
    },
  )

  it('fails closed and creates no Tasks when the roadmap review runner fails', async () => {
    const project = createProject(storage)
    reviewMocks.execute.mockImplementation(async () => ({
      ok: false,
      timedOut: false,
      stdout: '',
      error: 'runner failed',
    }))

    const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
    }))

    expect(error.message).toBe('Whole-Roadmap Design Review did not align or could not complete')
    expect(storage.tasks.findByProjectId(project.id)).toEqual([])
    expect(workflowMocks.createInitialImplementWorkflow).not.toHaveBeenCalled()
  })

  it('reuses fresh ALIGNED roadmap evidence on retry without executing the roadmap review again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
    const project = createProject(storage)

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
      canonicalDefinitionText: '# Goal\n\nBuild a reliable project initialization flow.',
    })
    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
      canonicalDefinitionText: '# Goal\n\nBuild a reliable project initialization flow.',
    })

    const roadmapReviewCalls = reviewMocks.execute.mock.calls.filter(([input]) => {
      const parsed = JSON.parse(input as string) as { reviewKind?: string }
      return parsed.reviewKind === 'roadmap'
    })
    expect(roadmapReviewCalls).toHaveLength(1)
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
  })
})
