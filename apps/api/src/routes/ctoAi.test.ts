import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import type { Project } from '@ai-team/shared'

vi.mock('../ctoAi/initialImplementWorkflow.js', () => ({ createInitialImplementWorkflow: async (_storage: unknown, taskId: string) => ({ taskId, status: 'skipped', reason: 'test' }) }))


process.env.DB_PATH = ':memory:'

/** target-project は実運用では常にgit repoであるため、テストでも同じ前提を再現する */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
}

const VALID_SPEC_TEXT = 'This test specification is intentionally longer than fifty characters so validation can pass.'

const MOCK_ANALYSIS = JSON.stringify({
  goal: 'テスト用プロジェクトの目的',
  designPhilosophy: ['シンプルに作る', 'テストを書く'],
  mvpScope: {
    description: 'MVP説明',
    includedFeatures: ['機能A'],
    excludedFeatures: ['機能B'],
  },
  targetUsers: ['開発者'],
  techStack: ['Node.js', 'TypeScript'],
  gaps: [],
  requiredExternalServices: [],
  readinessScore: 85,
  readinessReason: 'テスト用スコア',
})

async function buildApp(): Promise<FastifyInstance> {
  const [{ ctoAiRoutes }, { taskRoutes }, { resetStorage }] = await Promise.all([
    import('./ctoAi.js'),
    import('./tasks.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(ctoAiRoutes, { prefix: '/api/cto' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  await app.ready()
  return app
}

async function createProject(status: Project['status'] = 'running'): Promise<Project> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage().projects.create({
    name: `${status} project`,
    goal: 'Goal',
    designPhilosophy: [],
    status,
  })
}

describe('CTO AI API', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    process.env.DB_PATH = ':memory:'
    tmpDir = path.join(os.tmpdir(), `cto-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    initGitRepo(tmpDir)
    process.env.TARGET_ROOT = tmpDir
  })

  it('POST /api/cto/analyze — mockResponse で Project Memory を生成できる', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: 'テスト仕様書です。これは50文字以上のテキストが必要なのでここに追加テキストを入れます。十分な長さにするために更に文字を追加します。',
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ready')
    expect(body.readinessScore).toBe(85)
    expect(body.writtenFiles).toHaveLength(6)
    // ファイルが実際に作成されているか
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'goal.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'gap_analysis.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'project_definition.json'))).toBe(true)
  })

  it('POST /api/cto/analyze — specText が短すぎると 400', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: '短い',
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/cto/analyze — readinessScore < 70 は gaps_found を返す', async () => {
    const lowScoreMock = JSON.stringify({
      ...JSON.parse(MOCK_ANALYSIS),
      readinessScore: 50,
      gaps: [{
        category: 'technical',
        description: '重要な未決定事項',
        severity: 'must_resolve',
        suggestion: '決定が必要',
      }],
    })
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: 'テスト仕様書です。これは50文字以上のテキストが必要なのでここに追加テキストを入れます。十分な長さにするために更に文字を追加します。',
        targetProjectRoot: tmpDir,
        mockResponse: lowScoreMock,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('gaps_found')
    expect(body.mustResolveGaps).toHaveLength(1)
  })

  it('POST /api/cto/analyze — readinessScore < 70 はmust_resolveなしでも gaps_found を返す', async () => {
    const lowScoreMock = JSON.stringify({
      ...JSON.parse(MOCK_ANALYSIS),
      readinessScore: 50,
      readinessReason: 'Scope is too vague.',
      gaps: [],
    })
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: VALID_SPEC_TEXT,
        targetProjectRoot: tmpDir,
        mockResponse: lowScoreMock,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('gaps_found')
    // A synthetic must_resolve Gap is returned so a downstream consumer relying on a concrete
    // Gap list to prompt for clarification (e.g. the Mobile gaps screen) always has one, even
    // when the model didn't flag a specific gap itself (independent-review fix, 2026-09-01).
    expect(body.mustResolveGaps).toHaveLength(1)
    expect(body.mustResolveGaps[0].severity).toBe('must_resolve')
    expect(body.readinessReason).toBe('Scope is too vague.')
    expect(body.message).toContain('Scope is too vague.')
  })

  it('POST /api/cto/analyze — targetProjectRoot がない場合 400', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: 'テスト仕様書です。これは50文字以上のテキストが必要なのでここに追加テキストを入れます。十分な長さにするために更に文字を追加します。',
        mockResponse: MOCK_ANALYSIS,
        // targetProjectRoot なし
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/cto/analyze returns 400 when projectId is missing', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        specText: VALID_SPEC_TEXT,
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST /api/cto/analyze returns 404 when projectId does not exist', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: 'missing-project',
        specText: VALID_SPEC_TEXT,
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('Project not found')
  })

  it('POST /api/cto/analyze returns 409 when project is not running', async () => {
    const app = await buildApp()
    const project = await createProject('draft')
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: VALID_SPEC_TEXT,
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Project is not running',
      detail: 'status=draft',
    })
  })

  it('POST /api/cto/analyze returns 400 when targetProjectRoot differs from configured TARGET_ROOT', async () => {
    const app = await buildApp()
    const project = await createProject()
    const otherRoot = path.join(os.tmpdir(), `cto-other-${Date.now()}`)
    mkdirSync(otherRoot, { recursive: true })

    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      payload: {
        projectId: project.id,
        specText: VALID_SPEC_TEXT,
        targetProjectRoot: otherRoot,
        mockResponse: MOCK_ANALYSIS,
      },
    })

    expect(res.statusCode).toBe(400)
  })
})

// ────────────────────────────────────────────────────────────
// task-102: generate-roadmap エンドポイント
// ────────────────────────────────────────────────────────────

const MOCK_ROADMAP = JSON.stringify({
  phases: [
    {
      number: 1,
      name: '基盤構築',
      goal: '型定義とDB',
      tasks: ['task-001'],
    },
  ],
  tasks: [
    {
      id: 'task-001',
      title: '共有型定義',
      description: 'shared パッケージに型を追加',
      phase: 1,
      assignee: 'developer_ai',
      category: 'implementation',
      dependencies: [],
      acceptanceCriteria: ['型エラーがない'],
      allowedPaths: ['packages/shared/src/'],
      estimatedComplexity: 'small',
    },
  ],
  totalTasks: 1,
  estimatedWeeks: 1,
})

type MockRoadmapTask = {
  id: string
  title?: string
  description?: string
  phase?: number
  assignee?: 'developer_ai'
  category?: 'implementation' | 'verification' | 'control_plane_operation' | 'other'
  dependencies?: string[]
  acceptanceCriteria?: string[]
  allowedPaths?: string[]
  estimatedComplexity?: 'small' | 'medium' | 'large'
}

function mockRoadmapResponse(tasks: MockRoadmapTask[]): string {
  return JSON.stringify({
    phases: [
      {
        number: 1,
        name: 'Phase 1',
        goal: 'Goal',
        tasks: tasks.map((task) => task.id),
      },
    ],
    tasks: tasks.map((task) => ({
      title: `Title ${task.id}`,
      description: `Description ${task.id}`,
      phase: 1,
      assignee: 'developer_ai',
      category: 'implementation',
      dependencies: [],
      acceptanceCriteria: [],
      allowedPaths: [],
      estimatedComplexity: 'small',
      ...task,
    })),
    totalTasks: tasks.length,
    estimatedWeeks: 1,
  })
}

const MOCK_ANALYSIS_OBJ = JSON.parse(MOCK_ANALYSIS)

describe('CTO AI — generate-roadmap API', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    process.env.DB_PATH = ':memory:'
    tmpDir = path.join(os.tmpdir(), `roadmap-api-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    initGitRepo(tmpDir)
    process.env.TARGET_ROOT = tmpDir
  })

  it('POST /api/cto/generate-roadmap — mockResponse でロードマップを生成できる', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('roadmap_generated')
    expect(body.totalTasks).toBe(1)
    expect(body.syncSummary).toMatchObject({
      created: 1,
      updated: 0,
      reactivated: 0,
      deactivated: 0,
    })
    expect(body.writtenFiles).toHaveLength(2)
    const tasksRes = await app.inject({
      method: 'GET',
      url: `/api/tasks?projectId=${project.id}`,
    })
    expect(tasksRes.statusCode).toBe(200)
    const tasks = JSON.parse(tasksRes.body)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      projectId: project.id,
      roadmapTaskKey: 'task-001',
      roadmapActive: true,
      phase: 1,
    })
    // ファイルが実際に生成されているか
    const { existsSync } = await import('node:fs')
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(true)
  })

  it('POST /api/cto/generate-roadmap — analysis がない場合 400', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ROADMAP,
        // analysis なし
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/cto/generate-roadmap — targetProjectRoot がない場合 400', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/cto/generate-roadmap returns 409 and does not write Markdown when DB sync fails', async () => {
    const app = await buildApp()
    const project = await createProject()
    const { getStorage } = await import('../storage/index.js')
    const storage = getStorage()
    const removedTask = storage.tasks.create({
      projectId: project.id,
      title: 'Existing task',
      description: '',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
      roadmapTaskKey: 'task-001',
      phase: 1,
      roadmapActive: true,
    })
    storage.jobs.create({
      taskId: removedTask.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: mockRoadmapResponse([{ id: 'task-002' }]),
      },
    })

    expect(res.statusCode).toBe(409)
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(false)
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
    expect(storage.tasks.findById(removedTask.id)?.roadmapActive).toBe(true)
  })

  it('does not start an initial workflow when Markdown saving fails after DB Task sync', async () => {
    vi.doMock('../ctoAi/roadmapWriter.js', () => ({
      writeRoadmap: () => { throw new Error('simulated Markdown write failure') },
    }))
    try {
      const app = await buildApp()
      const project = await createProject()
      const res = await app.inject({
        method: 'POST',
        url: '/api/cto/generate-roadmap',
        payload: {
          projectId: project.id,
          targetProjectRoot: tmpDir,
          analysis: MOCK_ANALYSIS_OBJ,
          mockResponse: MOCK_ROADMAP,
        },
      })

      expect(res.statusCode).toBe(500)
      const { getStorage } = await import('../storage/index.js')
      const tasks = getStorage().tasks.findByProjectId(project.id)
      expect(tasks).toHaveLength(1)
      expect(getStorage().jobs.findByTaskId(tasks[0].id)).toHaveLength(0)
    } finally {
      vi.doUnmock('../ctoAi/roadmapWriter.js')
    }
  })

  it('POST /api/cto/generate-roadmap returns 409 with conflicts for started task spec changes', async () => {
    const app = await buildApp()
    const project = await createProject()
    const { getStorage } = await import('../storage/index.js')
    const storage = getStorage()
    const existingTask = storage.tasks.create({
      projectId: project.id,
      title: 'Title task-001',
      description: 'Description task-001',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
      acceptanceCriteria: [],
      allowedPaths: [],
      roadmapTaskKey: 'task-001',
      phase: 1,
      roadmapActive: true,
    })
    storage.jobs.create({
      taskId: existingTask.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'success',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: mockRoadmapResponse([{ id: 'task-001', title: 'Changed title' }]),
      },
    })

    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(409)
    expect(body.conflicts).toContainEqual({
      roadmapTaskKey: 'task-001',
      field: 'title',
    })
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(false)
    expect(storage.tasks.findById(existingTask.id)?.title).toBe('Title task-001')
  })

  it('POST /api/cto/generate-roadmap — Phase metadataもDBへ同期される', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.syncSummary).toMatchObject({
      phasesCreated: 1,
      phasesUpdated: 0,
      phasesReactivated: 0,
      phasesDeactivated: 0,
    })

    const { getStorage } = await import('../storage/index.js')
    const phases = getStorage().projectRoadmapPhases.findByProjectId(project.id)
    expect(phases).toEqual([
      expect.objectContaining({
        projectId: project.id,
        phaseNumber: 1,
        name: '基盤構築',
        goal: '型定義とDB',
        roadmapActive: true,
      }),
    ])
  })

  it('POST /api/cto/generate-roadmap — 未着手Taskのみのphaseはname/goal変更が反映される', async () => {
    const app = await buildApp()
    const project = await createProject()
    await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: mockRoadmapResponse([{ id: 'task-001' }]).replace('Phase 1', 'Renamed Phase'),
      },
    })
    expect(res.statusCode).toBe(201)

    const { getStorage } = await import('../storage/index.js')
    const phases = getStorage().projectRoadmapPhases.findByProjectId(project.id)
    expect(phases).toHaveLength(1)
    expect(phases[0].name).toBe('Renamed Phase')
  })

  it('POST /api/cto/generate-roadmap returns 409 with phaseConflicts when a phase with a started task is repurposed', async () => {
    const app = await buildApp()
    const project = await createProject()
    const { getStorage } = await import('../storage/index.js')
    const storage = getStorage()

    // 1回目: task-001 が phase 1 に紐づき、Jobが完了して「着手済み」になる
    await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })
    const startedTask = storage.tasks.findByProjectId(project.id)[0]
    storage.jobs.create({
      taskId: startedTask.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'success',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    })

    // 2回目: 同じ phase 1 だが task-001 は変更なし・phase 1 の name/goal だけ別の意味へ変更しようとする
    const repurposedRoadmap = JSON.stringify({
      ...JSON.parse(MOCK_ROADMAP),
      phases: [{ number: 1, name: '全く別のPhase', goal: '別の目的', tasks: ['task-001'] }],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: repurposedRoadmap,
      },
    })

    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(409)
    expect(body.phaseConflicts).toContainEqual({ phaseNumber: 1, field: 'name' })
    expect(body.phaseConflicts).toContainEqual({ phaseNumber: 1, field: 'goal' })
    const phases = storage.projectRoadmapPhases.findByProjectId(project.id)
    expect(phases[0].name).toBe('基盤構築') // ロールバックされ元のままであること
  })

  it('POST /api/cto/generate-roadmap — 再生成でPhaseが消えるとroadmapActive=falseになる', async () => {
    const app = await buildApp()
    const project = await createProject()
    await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })

    const secondRoadmap = JSON.stringify({
      phases: [{ number: 2, name: '別フェーズ', goal: '別の目的', tasks: ['task-002'] }],
      tasks: [{
        id: 'task-002', title: 'T2', description: 'D2', phase: 2, assignee: 'developer_ai', category: 'implementation',
        dependencies: [], acceptanceCriteria: [], allowedPaths: [], estimatedComplexity: 'small',
      }],
      totalTasks: 1,
      estimatedWeeks: 1,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: secondRoadmap,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.syncSummary.phasesDeactivated).toBe(1)

    const { getStorage } = await import('../storage/index.js')
    const phases = getStorage().projectRoadmapPhases.findByProjectId(project.id)
    const phase1 = phases.find((p: { phaseNumber: number }) => p.phaseNumber === 1)
    expect(phase1?.roadmapActive).toBe(false)
  })

  it('POST /api/cto/generate-roadmap returns 422 and creates no tasks for invalid generated roadmap', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: mockRoadmapResponse([
          { id: 'task-001', title: 'First duplicate' },
          { id: 'task-001', title: 'Second duplicate' },
        ]),
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_roadmap_task_key',
    }))
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap returns 422 and creates no tasks for an empty generated roadmap', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: mockRoadmapResponse([]),
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).issues).toContainEqual(expect.objectContaining({
      code: 'empty_roadmap',
    }))
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap returns 422 and creates no tasks when a structured constraint is violated', async () => {
    const app = await buildApp()
    const project = await createProject()
    const constrainedAnalysis = {
      ...MOCK_ANALYSIS_OBJ,
      structuredConstraints: [{
        kind: 'max_task_count',
        value: 1,
        description: 'Only one task may be generated.',
        sourceText: 'only 1 task',
      }],
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: constrainedAnalysis,
        // 2 tasks violates the max_task_count=1 constraint.
        mockResponse: mockRoadmapResponse([
          { id: 'task-001' },
          { id: 'task-002' },
        ]),
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).issues).toContainEqual(expect.objectContaining({
      code: 'task_count_exceeded',
    }))
    // No Task / Job may exist in storage before DB sync (fail-closed).
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(getStorage().jobs.findByTaskId('task-001')).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap returns 422 and creates no tasks when a structured constraint is violated', async () => {
    const constrainedAnalysis = JSON.stringify({
      ...JSON.parse(MOCK_ANALYSIS),
      structuredConstraints: [
        {
          kind: 'max_task_count',
          value: 1,
          description: 'Only one task may be generated.',
          sourceText: 'only 1 task',
        },
      ],
    })
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: JSON.parse(constrainedAnalysis),
        mockResponse: mockRoadmapResponse([
          { id: 'task-001' },
          { id: 'task-002' },
        ]),
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).issues).toContainEqual(expect.objectContaining({
      code: 'task_count_exceeded',
    }))
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(getStorage().jobs.findByTaskId('task-001')).toEqual([])
    expect(getStorage().jobs.findByTaskId('task-002')).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap returns 422 when a control_plane_operation task is generated (unconditional)', async () => {
    const app = await buildApp()
    const project = await createProject()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: mockRoadmapResponse([
          { id: 'task-001', category: 'control_plane_operation' },
        ]),
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).issues).toContainEqual(expect.objectContaining({
      code: 'control_plane_operation_task',
      roadmapTaskKey: 'task-001',
    }))
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap returns 422 and creates no tasks when a structured constraint is violated', async () => {
    const app = await buildApp()
    const project = await createProject()
    const constrainedAnalysis = {
      ...MOCK_ANALYSIS_OBJ,
      structuredConstraints: [{
        kind: 'max_task_count',
        value: 1,
        description: 'Only one task may be generated.',
        sourceText: 'only 1 task',
      }],
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: constrainedAnalysis,
        // 2 tasks violates max_task_count=1
        mockResponse: mockRoadmapResponse([
          { id: 'task-001' },
          { id: 'task-002' },
        ]),
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).issues).toContainEqual(expect.objectContaining({
      code: 'task_count_exceeded',
    }))
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(getStorage().jobs.findByTaskId('nonexistent')).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap keeps the existing 409 for non-running projects', async () => {
    const app = await buildApp()
    const project = await createProject('draft')
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: tmpDir,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(409)
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
  })

  it('POST /api/cto/generate-roadmap keeps the existing 400 for an unconfigured target root', async () => {
    const app = await buildApp()
    const project = await createProject()
    const otherRoot = path.join(os.tmpdir(), `roadmap-api-other-${Date.now()}`)
    mkdirSync(otherRoot, { recursive: true })

    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: project.id,
        targetProjectRoot: otherRoot,
        analysis: MOCK_ANALYSIS_OBJ,
        mockResponse: MOCK_ROADMAP,
      },
    })

    const { getStorage } = await import('../storage/index.js')
    expect(res.statusCode).toBe(400)
    expect(getStorage().tasks.findByProjectId(project.id)).toEqual([])
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(false)
  })
})
