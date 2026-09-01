import { describe, it, expect, vi } from 'vitest'

const anthropicMocks = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: anthropicMocks.create }
  },
}))
import { parseRoadmapJson, generateRoadmap } from './roadmapGenerator.js'
import type { SpecAnalysis } from './specAnalyzer.js'

const MOCK_ANALYSIS: SpecAnalysis = {
  goal: 'コンテンツ配信を自動化するシステム',
  designPhilosophy: ['シンプルに作る', '人間が最終確認する'],
  mvpScope: {
    description: 'MVP: ブログ記事を複数プラットフォームに配信',
    includedFeatures: ['記事生成', 'DEV.to配信'],
    excludedFeatures: ['分析機能'],
  },
  targetUsers: ['開発者ブロガー'],
  techStack: ['Node.js', 'TypeScript', 'SQLite'],
  gaps: [],
  structuredConstraints: [
    {
      kind: 'allowed_path_prefixes',
      value: ['apps/api/src/'],
      description: 'Only API source files may be changed.',
      sourceText: 'only touch apps/api/src/',
    },
  ],
  requiredExternalServices: [{ name: 'DEV.to API', purpose: '記事投稿', hasCost: false }],
  readinessScore: 80,
  readinessReason: 'スコープが明確',
}

const MOCK_ROADMAP_JSON = JSON.stringify({
  phases: [
    {
      number: 1,
      name: '基盤構築',
      goal: '型定義・DB・API骨格を作る',
      tasks: ['task-001', 'task-002'],
    },
    {
      number: 2,
      name: 'MVP機能',
      goal: '記事生成と配信を動かす',
      tasks: ['task-003'],
    },
  ],
  tasks: [
    {
      id: 'task-001',
      title: '共有型定義',
      description: 'packages/shared に型を追加',
      phase: 1,
      assignee: 'developer_ai',
      dependencies: [],
      acceptanceCriteria: ['型エラーがない'],
      allowedPaths: ['packages/shared/src/'],
      estimatedComplexity: 'small',
    },
    {
      id: 'task-002',
      title: 'DB スキーマ定義',
      description: 'SQLite スキーマを作成する',
      phase: 1,
      assignee: 'developer_ai',
      dependencies: ['task-001'],
      acceptanceCriteria: ['マイグレーションが通る'],
      allowedPaths: ['src/db/'],
      estimatedComplexity: 'small',
    },
    {
      id: 'task-003',
      title: '記事生成エンジン',
      description: 'Claude API を呼び出して記事を生成する',
      phase: 2,
      assignee: 'developer_ai',
      dependencies: ['task-001', 'task-002'],
      acceptanceCriteria: ['mock でテストが通る'],
      allowedPaths: ['src/engine/'],
      estimatedComplexity: 'medium',
    },
  ],
  totalTasks: 3,
  estimatedWeeks: 2,
})

describe('parseRoadmapJson', () => {
  it('正常なJSONをパースできる', () => {
    const roadmap = parseRoadmapJson(MOCK_ROADMAP_JSON)
    expect(roadmap.totalTasks).toBe(3)
    expect(roadmap.phases).toHaveLength(2)
    expect(roadmap.tasks).toHaveLength(3)
    expect(roadmap.estimatedWeeks).toBe(2)
  })

  it('```json ブロックで囲まれていてもパースできる', () => {
    const wrapped = '```json\n' + MOCK_ROADMAP_JSON + '\n```'
    const roadmap = parseRoadmapJson(wrapped)
    expect(roadmap.totalTasks).toBe(3)
  })

  it('不正なJSONはエラーをスローする', () => {
    expect(() => parseRoadmapJson('not json')).toThrow('[CTO AI] Roadmap JSON')
  })

  it('スキーマ違反（assigneeが不正）はエラーをスローする', () => {
    const invalid = JSON.stringify({
      ...JSON.parse(MOCK_ROADMAP_JSON),
      tasks: [{ ...JSON.parse(MOCK_ROADMAP_JSON).tasks[0], assignee: 'UNKNOWN_ROLE' }],
    })
    expect(() => parseRoadmapJson(invalid)).toThrow()
  })

  it('task id が task-xxx 形式でないとエラー', () => {
    const invalidId = JSON.stringify({
      ...JSON.parse(MOCK_ROADMAP_JSON),
      tasks: [{ ...JSON.parse(MOCK_ROADMAP_JSON).tasks[0], id: 'TASK001' }],
    })
    expect(() => parseRoadmapJson(invalidId)).toThrow()
  })
})

describe('generateRoadmap (default model)', () => {
  it('uses the current Anthropic Haiku model by default', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: MOCK_ROADMAP_JSON }],
    })

    await generateRoadmap(MOCK_ANALYSIS, {
      apiKey: 'test-api-key',
      canonicalDefinitionText: '# Goal\n\nCanonical goal',
      definitionHash: 'abc123',
    })

    expect(anthropicMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
    }))
    const request = anthropicMocks.create.mock.calls.at(-1)?.[0]
    expect(request?.messages[0]?.content).toContain('Project Definition Hash')
    expect(request?.messages[0]?.content).toContain('abc123')
    expect(request?.messages[0]?.content).toContain('Canonical goal')
    expect(request?.messages[0]?.content).toContain('allowed_path_prefixes')
  })
})

describe('generateRoadmap (mockResponse)', () => {
  it('mockResponse を渡すと API を呼ばずにロードマップを返す', async () => {
    const roadmap = await generateRoadmap(MOCK_ANALYSIS, { mockResponse: MOCK_ROADMAP_JSON })
    expect(roadmap.totalTasks).toBe(3)
    expect(roadmap.phases[0].name).toBe('基盤構築')
  })

  it('mockResponse なし & APIキーなしはエラー', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    await expect(generateRoadmap(MOCK_ANALYSIS)).rejects.toThrow('ANTHROPIC_API_KEY')
    process.env.ANTHROPIC_API_KEY = origKey
  })
})
