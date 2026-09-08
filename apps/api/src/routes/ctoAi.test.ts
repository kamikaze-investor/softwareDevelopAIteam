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

/**
 * PR C: `/api/cto/generate-roadmap` は削除した。
 *
 * このrouteは `initializeApprovedProject()` を `writeProjectMemory` 無しで呼んでいたため、
 * Gemini focused review も Claude integration review も evidence 登録も通らずに Task sync まで
 * 到達できた。API tokenさえあれば production で到達可能な、review gate を完全に迂回する
 * 第二のRoadmap workflowだった。
 *
 * ここで固定するのは「そのrouteが無いこと」そのものである。単に review を通すよう直すと
 * 同じworkflowへの入口が2つ残り、将来どちらかだけが変更されて保証が崩れる。
 */
describe('CTO AI — generate-roadmap route removal (PR C)', () => {
  it('review gateを迂回できたRoadmap生成routeは存在しない', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/generate-roadmap',
      payload: {
        projectId: 'any-project',
        analysis: {},
        targetProjectRoot: '/workspace/target',
      },
    })

    // 404 = routeが登録されていない。400/500 なら route はまだ生きている。
    expect(res.statusCode).toBe(404)
  })
})
