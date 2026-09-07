import { describe, it, expect, vi } from 'vitest'

const anthropicMocks = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: anthropicMocks.create }
  },
}))
import { parseRoadmapJson, generateRoadmap, buildRoadmapProjectSummary } from './roadmapGenerator.js'
import type { SpecAnalysis } from './specAnalyzer.js'
import { buildInitialImplementAiCliPrompt } from './initialImplementWorkflow.js'

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
      category: 'implementation',
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
      category: 'implementation',
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
      category: 'implementation',
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

  it('system prompt does not contain the old unconditional 10-20 default when structuredConstraints is empty', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: MOCK_ROADMAP_JSON }],
    })

    const emptyConstraintsAnalysis: SpecAnalysis = {
      ...MOCK_ANALYSIS,
      structuredConstraints: [],
    }

    await generateRoadmap(emptyConstraintsAnalysis, { apiKey: 'test-api-key' })

    const request = anthropicMocks.create.mock.calls.at(-1)?.[0]
    expect(request?.system).not.toContain('10〜20件')
    expect(request?.system).not.toContain('10-20')
  })

  it('system prompt contains proportional sizing guidance when structuredConstraints is empty', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: MOCK_ROADMAP_JSON }],
    })

    const emptyConstraintsAnalysis: SpecAnalysis = {
      ...MOCK_ANALYSIS,
      structuredConstraints: [],
    }

    await generateRoadmap(emptyConstraintsAnalysis, { apiKey: 'test-api-key' })

    const request = anthropicMocks.create.mock.calls.at(-1)?.[0]
    expect(request?.system).toContain('タスク数はプロジェクトの実際の範囲に比例させてください')
    expect(request?.system).toContain('単一ファイル・単一関数の変更であれば1〜2タスクで十分')
  })

  it('explicit max_task_count in structuredConstraints is still instructed as the governing limit', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: MOCK_ROADMAP_JSON }],
    })

    const maxCountAnalysis: SpecAnalysis = {
      ...MOCK_ANALYSIS,
      structuredConstraints: [
        {
          kind: 'max_task_count',
          value: 5,
          description: 'At most 5 tasks.',
          sourceText: 'at most 5 tasks',
        },
      ],
    }

    await generateRoadmap(maxCountAnalysis, { apiKey: 'test-api-key' })

    const request = anthropicMocks.create.mock.calls.at(-1)?.[0]
    expect(request?.system).toContain('max_task_count がある場合はその値を厳守')
    expect(request?.messages[0]?.content).toContain('"kind": "max_task_count"')
  })

  it('surfaces scope signals in the project summary for sizing', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: MOCK_ROADMAP_JSON }],
    })

    await generateRoadmap(MOCK_ANALYSIS, { apiKey: 'test-api-key' })

    const request = anthropicMocks.create.mock.calls.at(-1)?.[0]
    expect(request?.messages[0]?.content).toContain('## Scope Signals')
    expect(request?.messages[0]?.content).toContain('MVP included features: 2')
    expect(request?.messages[0]?.content).toContain('Tech stack size: 3')
  })

  it('adds priorAttemptFeedback to the real API prompt when provided', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: MOCK_ROADMAP_JSON }],
    })

    await generateRoadmap(MOCK_ANALYSIS, {
      apiKey: 'test-api-key',
      priorAttemptFeedback: 'scope_simplicity rejected the previous roadmap as over-split.',
    })

    const request = anthropicMocks.create.mock.calls.at(-1)?.[0]
    expect(request?.messages[0]?.content).toContain('Previous Attempt Was Rejected -- Fix This')
    expect(request?.messages[0]?.content).toContain('scope_simplicity rejected the previous roadmap as over-split.')
    expect(request?.messages[0]?.content).toContain('Generate a NEW roadmap')
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

// CEO質問から除外したGapが、実際にRoadmapを立てるAIへ届くことを固定する。
// これが無いと `gap_analysis.md` へ書くだけの行き止まりになり（読み手が存在しない）、
// 「CEOにも聞かれず、AIにも渡らない」情報になる。
describe('buildRoadmapProjectSummary — AI-owned Gapの伝播', () => {
  function analysisWith(gaps: SpecAnalysis['gaps']): SpecAnalysis {
    return {
      goal: 'G',
      designPhilosophy: [],
      mvpScope: { description: 'G', includedFeatures: [], excludedFeatures: [] },
      targetUsers: [],
      techStack: [],
      gaps,
      structuredConstraints: [],
      requiredExternalServices: [],
      readinessScore: 95,
      readinessReason: 'r',
    }
  }

  it('decisionOwner: ai のGapをプロンプト本文へ載せる', () => {
    const summary = buildRoadmapProjectSummary(analysisWith([
      { category: 'technical', description: '依存関係の表現方法', severity: 'must_resolve', suggestion: '既存の型を調べる', decisionOwner: 'ai' },
    ]))

    expect(summary).toContain('Open Technical Uncertainties')
    expect(summary).toContain('依存関係の表現方法')
    expect(summary).toContain('既存の型を調べる')
  })

  it('AI-owned Gapが無ければ余計なセクションを足さない', () => {
    const summary = buildRoadmapProjectSummary(analysisWith([
      { category: 'business', description: 'CEOが決める話', severity: 'must_resolve', suggestion: 's', decisionOwner: 'ceo' },
    ]))

    expect(summary).not.toContain('Open Technical Uncertainties')
    expect(summary).not.toContain('CEOが決める話')
  })
})

// analysis -> roadmap prompt -> generated Task -> buildInitialImplementAiCliPrompt -> Implementer
// までを端から端まで固定する。Context Pack は未配線（deferred item）なので、Implementerへ届く
// 決定的な経路は Task.description だけであり、そこが切れると誰も調査しないまま実装される。
describe('AI-owned uncertainty: analysisからImplementer promptまでの経路', () => {
  function analysisWith(gaps: SpecAnalysis['gaps']): SpecAnalysis {
    return {
      goal: 'G',
      designPhilosophy: [],
      mvpScope: { description: 'G', includedFeatures: [], excludedFeatures: [] },
      targetUsers: [],
      techStack: [],
      gaps,
      structuredConstraints: [],
      requiredExternalServices: [],
      readinessScore: 95,
      readinessReason: 'r',
    }
  }

  const aiGap: SpecAnalysis['gaps'][number] = {
    category: 'technical',
    description: '依存関係の表現方法',
    severity: 'must_resolve',
    suggestion: '既存の型定義を調べる',
    decisionOwner: 'ai',
  }

  const ceoGap: SpecAnalysis['gaps'][number] = {
    category: 'technical',
    description: '既存の動きを変えてよいか',
    severity: 'must_resolve',
    suggestion: '変えない',
    decisionOwner: 'ceo',
  }

  it('1. AI-owned GapがRoadmap promptへ入る', () => {
    const summary = buildRoadmapProjectSummary(analysisWith([aiGap, ceoGap]))

    expect(summary).toContain('Open Technical Uncertainties')
    expect(summary).toContain(aiGap.description)
    expect(summary).toContain(aiGap.suggestion)
  })

  it('4. CEO-owned GapはImplementer向けAI調査事項として混入しない', () => {
    const summary = buildRoadmapProjectSummary(analysisWith([aiGap, ceoGap]))

    expect(summary).not.toContain(ceoGap.description)
  })

  it('5. AI-owned Gapのためだけに独立Taskを作ることを要求していない', () => {
    const summary = buildRoadmapProjectSummary(analysisWith([aiGap]))

    expect(summary).toContain('調査だけの独立タスクは作らない')
    // 参照IDを列挙させる指示であること（本文の書き写しをモデルに依存させない）
    expect(summary).toContain('technicalUncertaintyRefs')
  })

  it('2+3. 生成Taskのdescriptionに調査責務が残り、Implementer promptまで到達する', () => {
    // Roadmap生成AIがルールに従い、関連タスクのdescriptionへ織り込んだ場合の生成結果。
    // ここから先（Task行 -> implement prompt）は決定論的な配線であり、それを固定する。
    const generated = parseRoadmapJson(JSON.stringify({
      phases: [{ number: 1, name: 'P1', goal: 'g', tasks: ['task-001'] }],
      tasks: [{
        id: 'task-001',
        title: '実行前に順序の不備を検出する',
        description: '実行を始める前に順序の不備を検出する。依存関係の表現方法は既存のコード・仕様・テストを確認してから決めること（推測で決め打ちしない）。',
        phase: 1,
        assignee: 'developer_ai',
        category: 'implementation',
        dependencies: [],
        acceptanceCriteria: ['既存の正しい順序の結果は変わらない'],
        allowedPaths: ['src/'],
        estimatedComplexity: 'small',
      }],
      totalTasks: 1,
      estimatedWeeks: 1,
    }))

    const task = generated.tasks[0]
    expect(task.description).toContain('依存関係の表現方法')

    const implementPrompt = buildInitialImplementAiCliPrompt({
      description: task.description,
      allowedPaths: task.allowedPaths,
    })

    expect(implementPrompt).toContain('依存関係の表現方法')
    expect(implementPrompt).toContain('既存のコード・仕様・テストを確認してから')
    expect(implementPrompt).not.toContain(ceoGap.description)
  })
})
