import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import type { Project } from '@ai-team/shared'

process.env.DB_PATH = ':memory:'

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
  const [{ ctoAiRoutes }, { resetStorage }] = await Promise.all([
    import('./ctoAi.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(ctoAiRoutes, { prefix: '/api/cto' })
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
    expect(body.writtenFiles).toHaveLength(5)
    // ファイルが実際に作成されているか
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'goal.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'gap_analysis.md'))).toBe(true)
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
      dependencies: [],
      acceptanceCriteria: ['型エラーがない'],
      allowedPaths: ['packages/shared/src/'],
      estimatedComplexity: 'small',
    },
  ],
  totalTasks: 1,
  estimatedWeeks: 1,
})

const MOCK_ANALYSIS_OBJ = JSON.parse(MOCK_ANALYSIS)

describe('CTO AI — generate-roadmap API', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    process.env.DB_PATH = ':memory:'
    tmpDir = path.join(os.tmpdir(), `roadmap-api-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
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
    expect(body.writtenFiles).toHaveLength(2)
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
})
