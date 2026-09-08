import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from '@ai-team/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage, RoadmapSyncResult } from '../storage/interface'
import { buildInitialImplementAiCliPrompt } from './initialImplementWorkflow.js'
import {
  awaitProjectStartForTest,
  kickProjectStart,
  recoverInterruptedProjectStarts,
  resetInFlightProjectStartsForTest,
} from './projectStartWorkflow'
import {
  initializeApprovedProject,
  ProjectInitializationError,
} from './projectInitialization'
import type { Roadmap, RoadmapGeneratorOptions } from './roadmapGenerator'
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

const roadmapGeneratorMocks = vi.hoisted(() => ({
  generateRoadmap: vi.fn(),
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

// createInitialImplementWorkflow だけを差し替え、buildInitialImplementAiCliPrompt は実物を使う
// （Implementer promptまでの経路を実コードで検証するため）。
vi.mock('./initialImplementWorkflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./initialImplementWorkflow.js')>()),
  createInitialImplementWorkflow: workflowMocks.createInitialImplementWorkflow,
}))

vi.mock('./roadmapGenerator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./roadmapGenerator.js')>()),
  generateRoadmap: roadmapGeneratorMocks.generateRoadmap,
}))

const ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS = 3
const SCOPE_SIMPLICITY_CONFLICT_REASON =
  '5 Tasks / 2 Phases for what should be a single small test-coverage change violates scope_simplicity.'
const ROADMAP_FOCUSES = ['strategic_alignment', 'scope_simplicity', 'architecture_responsibility'] as const

const TASK_ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
  integrationReviewResult: { decision: 'ALIGNED' },
})

function roadmapStdout(
  decision: 'ALIGNED' | 'CONFLICT' | 'UNCERTAIN' | 'REVIEW_UNAVAILABLE' = 'ALIGNED',
  reason = SCOPE_SIMPLICITY_CONFLICT_REASON,
): string {
  const scopeDecision = decision === 'CONFLICT' || decision === 'UNCERTAIN' ? decision : 'ALIGNED'
  return JSON.stringify({
    reviewKind: 'roadmap',
    subjectId: 'project-roadmap',
    reviewLoad: 'critical',
    reviewLoadReasons: ["reviewKind='roadmap': whole-roadmap review is always critical load by design"],
    selectedFocuses: ROADMAP_FOCUSES,
    focusedReviewResults: ROADMAP_FOCUSES.map((focus) => ({
      focus,
      decision: focus === 'scope_simplicity' ? scopeDecision : 'ALIGNED',
      summary: focus === 'scope_simplicity' ? reason : `${focus} aligned`,
      findings: focus === 'scope_simplicity' && scopeDecision === 'CONFLICT'
        ? [{
            severity: 'medium',
            category: 'scope_creep',
            message: reason,
          }]
        : [],
    })),
    ...(decision === 'REVIEW_UNAVAILABLE'
      ? {}
      : { integrationReviewResult: { decision: 'ALIGNED', summary: 'Integrated review aligned.' } }),
    // PR C: roadmap kind に independent review は無い。第二意見は Claude の integration review。
    // 取得できなかった場合は integration 側が欠落する（=fail-closed）ことで表現する。
    finalDecision: decision,
    independentReviewRequired: false,
    requiresCeoApproval: decision !== 'ALIGNED',
    createdAt: '2026-09-02T00:00:00.000Z',
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

const MAX_ONE_TASK_ANALYSIS: SpecAnalysis = {
  ...ANALYSIS,
  goal: 'Improve computeTaskDisplayStatus test coverage, small and low-risk.',
  mvpScope: {
    ...ANALYSIS.mvpScope,
    description: 'Improve computeTaskDisplayStatus test coverage, small and low-risk.',
  },
  structuredConstraints: [{
    kind: 'max_task_count',
    value: 1,
    description: 'Only one roadmap task is allowed for this small test coverage change.',
    sourceText: 'small and low-risk',
  }],
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
technicalUncertaintyRefs: [],
    },
  ],
  totalTasks: 1,
  estimatedWeeks: 1,
}

function makeRoadmap(taskCount: number, phaseCount: number, titlePrefix: string): Roadmap {
  const phases = Array.from({ length: phaseCount }, (_, index) => ({
    number: index + 1,
    name: `Phase ${index + 1}`,
    goal: `${titlePrefix} phase ${index + 1}`,
    tasks: [] as string[],
  }))
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const id = `task-${String(index + 1).padStart(3, '0')}`
    const phase = Math.min(Math.floor(index / Math.ceil(taskCount / phaseCount)) + 1, phaseCount)
    const phaseEntry = phases[phase - 1]
    if (!phaseEntry) {
      throw new Error(`invalid phase ${phase}`)
    }
    phaseEntry.tasks.push(id)
    return {
      id,
      title: `${titlePrefix} ${index + 1}`,
      description: `${titlePrefix} ${index + 1}.`,
      phase,
      assignee: 'developer_ai' as const,
      category: 'implementation' as const,
      dependencies: [],
      acceptanceCriteria: [`${titlePrefix} ${index + 1} is complete.`],
      allowedPaths: ['apps/api/src/'],
      estimatedComplexity: 'small' as const,
      technicalUncertaintyRefs: [],
    }
  })

  return {
    phases,
    tasks,
    totalTasks: taskCount,
    estimatedWeeks: phaseCount,
  }
}

const OVERSPLIT_ROADMAP = makeRoadmap(5, 2, 'Over-split coverage task')
const TWO_TASK_ROADMAP = makeRoadmap(2, 1, 'Too many validation tasks')

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

function mockGenerateRoadmaps(...roadmaps: Roadmap[]): void {
  roadmapGeneratorMocks.generateRoadmap.mockImplementation(async () => {
    const next = roadmaps.shift()
    if (!next) {
      throw new Error('Unexpected generateRoadmap call')
    }
    return next
  })
}

function roadmapReviewCalls(): string[] {
  return reviewMocks.execute.mock.calls.flatMap(([input]) => {
    const text = input as string
    const parsed = JSON.parse(text) as { reviewKind?: string }
    return parsed.reviewKind === 'roadmap' ? [text] : []
  })
}

function recordTaskSyncs(storage: IStorage): Array<Parameters<IStorage['tasks']['syncRoadmapTasks']>[0]> {
  const syncInputs: Array<Parameters<IStorage['tasks']['syncRoadmapTasks']>[0]> = []
  const originalSyncRoadmapTasks = storage.tasks.syncRoadmapTasks.bind(storage.tasks)
  storage.tasks.syncRoadmapTasks = (input): RoadmapSyncResult => {
    syncInputs.push(input)
    return originalSyncRoadmapTasks(input)
  }
  return syncInputs
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
    roadmapGeneratorMocks.generateRoadmap.mockReset()
    roadmapGeneratorMocks.generateRoadmap.mockResolvedValue(ROADMAP)
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
      // roadmap kind は independent review を要求しない（PR C）。
      independentReviewRequired: false,
    })
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
  })

  it('recovers from one Whole-Roadmap Review CONFLICT using scope_simplicity feedback', async () => {
    const project = createProject(storage)
    const syncInputs = recordTaskSyncs(storage)
    mockGenerateRoadmaps(OVERSPLIT_ROADMAP, ROADMAP)
    reviewMocks.execute
      .mockResolvedValueOnce({
        ok: true,
        timedOut: false,
        stdout: roadmapStdout('CONFLICT', SCOPE_SIMPLICITY_CONFLICT_REASON),
      })
      .mockResolvedValueOnce({
        ok: true,
        timedOut: false,
        stdout: roadmapStdout('ALIGNED'),
      })

    const result = await initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      writeProjectMemory: true,
    })

    expect(result.roadmap.tasks).toHaveLength(1)
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(2)
    expect(roadmapReviewCalls()).toHaveLength(2)
    expect(syncInputs).toHaveLength(1)
    expect(syncInputs[0]?.tasks.map((task) => task.roadmapTaskKey)).toEqual(['task-001'])
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)

    const secondOptions = roadmapGeneratorMocks.generateRoadmap.mock.calls[1]?.[1] as
      | RoadmapGeneratorOptions
      | undefined
    expect(secondOptions?.priorAttemptFeedback).toContain(SCOPE_SIMPLICITY_CONFLICT_REASON)
  })

  it('recovers from a deterministic validation failure before any rejected Tasks are synced', async () => {
    const project = createProject(storage)
    const syncInputs = recordTaskSyncs(storage)
    mockGenerateRoadmaps(TWO_TASK_ROADMAP, ROADMAP)

    const result = await initializeApprovedProject(storage, project, tmpDir, {
      analysis: MAX_ONE_TASK_ANALYSIS,
      writeProjectMemory: true,
    })

    expect(result.roadmap.tasks).toHaveLength(1)
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(2)
    expect(roadmapReviewCalls()).toHaveLength(1)
    expect(syncInputs).toHaveLength(1)
    expect(syncInputs[0]?.tasks.map((task) => task.roadmapTaskKey)).toEqual(['task-001'])
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)

    const secondOptions = roadmapGeneratorMocks.generateRoadmap.mock.calls[1]?.[1] as
      | RoadmapGeneratorOptions
      | undefined
    expect(secondOptions?.priorAttemptFeedback).toContain('Deterministic validation failed')
    expect(secondOptions?.priorAttemptFeedback).toContain('task_count_exceeded')
  })

  it('is bounded when every Whole-Roadmap Review attempt remains CONFLICT', async () => {
    const project = createProject(storage)
    mockGenerateRoadmaps(ROADMAP, ROADMAP, ROADMAP)
    reviewMocks.execute.mockImplementation(async () => ({
      ok: true,
      timedOut: false,
      stdout: roadmapStdout('CONFLICT', SCOPE_SIMPLICITY_CONFLICT_REASON),
    }))

    const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      writeProjectMemory: true,
    }))

    expect(error.message).toBe('Whole-Roadmap Design Review remained CONFLICT after bounded retry')
    expect(error.details).toMatchObject({ decision: 'CONFLICT', attempts: ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS })
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS)
    expect(storage.tasks.findByProjectId(project.id)).toEqual([])
    expect(workflowMocks.createInitialImplementWorkflow).not.toHaveBeenCalled()
  })

  it('fails closed immediately and creates no Tasks when the roadmap review returns UNCERTAIN', async () => {
    const project = createProject(storage)
    reviewMocks.execute.mockImplementation(async () => ({
      ok: true,
      timedOut: false,
      stdout: roadmapStdout('UNCERTAIN', 'scope_simplicity could not reach a clear verdict'),
    }))

    const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
    }))

    expect(error.message).toBe('Whole-Roadmap Design Review did not align or could not complete')
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(1)
    expect(storage.tasks.findByProjectId(project.id)).toEqual([])
    expect(workflowMocks.createInitialImplementWorkflow).not.toHaveBeenCalled()
  })

  it('fails closed immediately and creates no Tasks when required roadmap review is unavailable', async () => {
    const project = createProject(storage)
    reviewMocks.execute.mockImplementation(async () => ({
      ok: true,
      timedOut: false,
      stdout: roadmapStdout('REVIEW_UNAVAILABLE', 'independent reviewer output could not be parsed'),
    }))

    const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
    }))

    expect(error.message).toBe('Whole-Roadmap Design Review did not align or could not complete')
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(1)
    expect(storage.tasks.findByProjectId(project.id)).toEqual([])
    expect(workflowMocks.createInitialImplementWorkflow).not.toHaveBeenCalled()
  })

  it('drains transient non-decisive review execution results without regenerating the roadmap', async () => {
    const project = createProject(storage)
    reviewMocks.execute
      .mockResolvedValueOnce({
        ok: false,
        timedOut: false,
        stdout: '',
        error: 'temporary runner failure',
      })
      .mockResolvedValueOnce({
        ok: true,
        timedOut: false,
        stdout: roadmapStdout('ALIGNED'),
      })

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      mockResponse: JSON.stringify(ROADMAP),
      writeProjectMemory: true,
    })

    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(1)
    expect(roadmapReviewCalls()).toHaveLength(2)
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
  })

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
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(1)
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

    expect(roadmapReviewCalls()).toHaveLength(1)
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
  })
})

// analysis.gaps -> roadmap generation -> structured refs -> deterministic validation
// -> Task.description -> Implementer prompt を実際の不変条件として固定する。
// プロンプト上の指示だけを hard invariant として扱わない。
describe('AI-owned uncertainty: 構造化参照から Implementer prompt までの不変条件', () => {
  let storage: IStorage
  let tmpDir: string

  const UNCERTAINTY_ANALYSIS: SpecAnalysis = {
    ...ANALYSIS,
    gaps: [
      { category: 'technical', description: '依存関係の表現方法', severity: 'must_resolve', suggestion: '既存の型定義を調べる', decisionOwner: 'ai' },
      { category: 'technical', description: '既存の動きを変えてよいか', severity: 'must_resolve', suggestion: '変えない', decisionOwner: 'ceo' },
    ],
  }

  function roadmapWithRefs(refs: string[]): Roadmap {
    const base = makeRoadmap(1, 1, 'Order check')
    return { ...base, tasks: [{ ...base.tasks[0], technicalUncertaintyRefs: refs }] }
  }

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'project-initialization-uncertainty-'))
    initGitRepo(tmpDir)
    reviewMocks.execute.mockReset()
    reviewMocks.execute.mockImplementation(async (input: string) => ({
      ok: true,
      timedOut: false,
      stdout: stdoutForReviewInput(input),
    }))
    roadmapGeneratorMocks.generateRoadmap.mockReset()
    workflowMocks.createInitialImplementWorkflow.mockClear()
  })

  it('参照されたGap本文がTask.descriptionへ機械的に展開され、Implementer promptまで到達する', async () => {
    const project = createProject(storage)
    const syncs = recordTaskSyncs(storage)
    mockGenerateRoadmaps(roadmapWithRefs(['U1']))

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: UNCERTAINTY_ANALYSIS,
      writeProjectMemory: true,
    })

    const syncedTask = syncs[0].tasks[0]
    expect(syncedTask.description).toContain('依存関係の表現方法')
    expect(syncedTask.description).toContain('既存の型定義を調べる')
    // CEO判断のGapは実装AIの調査事項として混入しない
    expect(syncedTask.description).not.toContain('既存の動きを変えてよいか')

    // 既存の実装prompt経路をそのまま使い、Implementerまで到達することを固定する
    const implementPrompt = buildInitialImplementAiCliPrompt({
      description: syncedTask.description,
      allowedPaths: syncedTask.allowedPaths,
    })
    expect(implementPrompt).toContain('依存関係の表現方法')
    expect(implementPrompt).not.toContain('既存の動きを変えてよいか')
  })

  it('AI-owned Gapのrefが欠落したRoadmapはdeterministic validationで拒否される', async () => {
    const project = createProject(storage)
    const syncs = recordTaskSyncs(storage)
    mockGenerateRoadmaps(roadmapWithRefs([]), roadmapWithRefs([]), roadmapWithRefs([]))

    const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
      analysis: UNCERTAINTY_ANALYSIS,
      writeProjectMemory: true,
    }))

    const issues = error.details.issues as Array<{ code: string }>
    expect(issues.some((i) => i.code === 'unreferenced_technical_uncertainty')).toBe(true)
    // Task行は1件も作られない
    expect(syncs).toHaveLength(0)
    // 既存のbounded retryで再生成が試みられている（新しいGate/Queueは足していない）
    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(3)
  })

  it('未知のrefを含むRoadmapも拒否される', async () => {
    const project = createProject(storage)
    mockGenerateRoadmaps(roadmapWithRefs(['U9']), roadmapWithRefs(['U9']), roadmapWithRefs(['U9']))

    const error = await expectInitialization422(() => initializeApprovedProject(storage, project, tmpDir, {
      analysis: UNCERTAINTY_ANALYSIS,
      writeProjectMemory: true,
    }))

    const issues = error.details.issues as Array<{ code: string }>
    expect(issues.some((i) => i.code === 'unknown_technical_uncertainty_ref')).toBe(true)
  })

  it('参照漏れは再生成feedbackとして次の試行へ渡り、修正されれば成功する', async () => {
    const project = createProject(storage)
    const syncs = recordTaskSyncs(storage)
    mockGenerateRoadmaps(roadmapWithRefs([]), roadmapWithRefs(['U1']))

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: UNCERTAINTY_ANALYSIS,
      writeProjectMemory: true,
    })

    expect(roadmapGeneratorMocks.generateRoadmap).toHaveBeenCalledTimes(2)
    const secondCallOptions = roadmapGeneratorMocks.generateRoadmap.mock.calls[1][1] as { priorAttemptFeedback?: string }
    expect(secondCallOptions.priorAttemptFeedback).toContain('unreferenced_technical_uncertainty')
    expect(syncs[0].tasks[0].description).toContain('依存関係の表現方法')
  })

  it('AI-owned Gapごとの独立Taskは要求しない（1タスクが複数refを持てる）', async () => {
    const project = createProject(storage)
    const syncs = recordTaskSyncs(storage)
    const twoAiGaps: SpecAnalysis = {
      ...ANALYSIS,
      gaps: [
        { category: 'technical', description: '不確実性A', severity: 'must_resolve', suggestion: 'a', decisionOwner: 'ai' },
        { category: 'other', description: '不確実性B', severity: 'should_resolve', suggestion: 'b', decisionOwner: 'ai' },
      ],
    }
    mockGenerateRoadmaps(roadmapWithRefs(['U1', 'U2']))

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: twoAiGaps,
      writeProjectMemory: true,
    })

    expect(syncs[0].tasks).toHaveLength(1)
    expect(syncs[0].tasks[0].description).toContain('不確実性A')
    expect(syncs[0].tasks[0].description).toContain('不確実性B')
  })

  it('AI-owned Gapが無い場合は既存の生成結果を一切変えない', async () => {
    const project = createProject(storage)
    const syncs = recordTaskSyncs(storage)
    const base = makeRoadmap(1, 1, 'Plain task')
    mockGenerateRoadmaps(base)

    await initializeApprovedProject(storage, project, tmpDir, {
      analysis: ANALYSIS,
      writeProjectMemory: true,
    })

    expect(syncs[0].tasks[0].description).toBe(base.tasks[0].description)
  })
})

// kick / recovery層をstubで検証するだけでは、実際のinitializeApprovedProject()を通る
// crash/replay契約を証明できない（独立レビュー指摘、2026-09-07）。ここではproviderだけを
// mockし、**実装本体を通して**stage永続化とresume境界を固定する。
describe('Project開始workflow: 実initialize経路のdurability', () => {
  let storage: IStorage
  let tmpDir: string

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'project-start-integration-'))
    initGitRepo(tmpDir)
    reviewMocks.execute.mockReset()
    reviewMocks.execute.mockImplementation(async (input: string) => ({
      ok: true,
      timedOut: false,
      stdout: stdoutForReviewInput(input),
    }))
    roadmapGeneratorMocks.generateRoadmap.mockReset()
    workflowMocks.createInitialImplementWorkflow.mockClear()
    resetInFlightProjectStartsForTest()
    process.env.TARGET_ROOT = tmpDir
  })

  afterEach(() => {
    delete process.env.TARGET_ROOT
  })

  it('実initialize経路を通してstageが永続化され、completedに到達する', async () => {
    const project = createProject(storage)
    mockGenerateRoadmaps(ROADMAP)
    const stages: string[] = []
    const originalUpdate = storage.projects.updateStartStage.bind(storage.projects)
    storage.projects.updateStartStage = (id, stage, reason) => {
      stages.push(stage)
      return originalUpdate(id, stage, reason)
    }

    kickProjectStart(storage, project, { analysis: ANALYSIS, writeProjectMemory: true })
    await awaitProjectStartForTest(project.id)

    expect(stages).toContain('roadmap_generation')
    expect(stages).toContain('deterministic_validation')
    expect(stages).toContain('task_sync')
    expect(stages.at(-1)).toBe('completed')
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
    expect(workflowMocks.createInitialImplementWorkflow).toHaveBeenCalledTimes(1)
  })

  it('Task sync後・Job作成前のcrashをresumeしても、Roadmapを作り直さず1件だけJobを作る', async () => {
    const project = createProject(storage)
    mockGenerateRoadmaps(ROADMAP)

    // 1回目: 正常にsyncまで到達させる
    kickProjectStart(storage, project, { analysis: ANALYSIS, writeProjectMemory: true })
    await awaitProjectStartForTest(project.id)
    const tasksAfterFirstRun = storage.tasks.findByProjectId(project.id)
    expect(tasksAfterFirstRun).toHaveLength(1)

    // Job作成前にcrashした状態を再現する（stageをtask_syncへ巻き戻す）
    storage.projects.updateStartStage(project.id, 'task_sync')
    workflowMocks.createInitialImplementWorkflow.mockClear()
    resetInFlightProjectStartsForTest()

    // restart後のRoadmap生成が**別内容**になるよう仕込む。resumeがこれを使ってしまうと、
    // 旧Roadmap由来のTaskが非活性化され別Taskが作られる＝実質的な作り直しになる。
    const divergentRoadmap = makeRoadmap(3, 2, 'Completely different plan')
    mockGenerateRoadmaps(divergentRoadmap)
    // 1回目の呼び出し履歴を消し、resumeで新たに呼ばれないことを検証できるようにする
    roadmapGeneratorMocks.generateRoadmap.mockClear()

    const { rekicked, resumed } = await recoverInterruptedProjectStarts(storage)

    expect(rekicked).toEqual([])
    expect(resumed).toEqual([project.id])
    // Roadmap Generatorは呼ばれない（別内容のRoadmapは使われない）
    expect(roadmapGeneratorMocks.generateRoadmap).not.toHaveBeenCalled()
    // 旧Roadmap由来のTaskがそのまま残り、新旧が混在しない
    const tasksAfterResume = storage.tasks.findByProjectId(project.id)
    expect(tasksAfterResume.map((t) => t.roadmapTaskKey)).toEqual(
      tasksAfterFirstRun.map((t) => t.roadmapTaskKey),
    )
    expect(tasksAfterResume.filter((t) => t.roadmapActive)).toHaveLength(1)
    // 正しいTaskに初回Jobが1件だけ
    expect(workflowMocks.createInitialImplementWorkflow).toHaveBeenCalledTimes(1)
    expect(workflowMocks.createInitialImplementWorkflow).toHaveBeenCalledWith(storage, tasksAfterFirstRun[0].id)
    expect(storage.projects.findById(project.id)?.startStage).toBe('completed')
  })
})
