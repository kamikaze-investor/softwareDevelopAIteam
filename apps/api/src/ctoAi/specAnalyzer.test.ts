import { describe, it, expect, vi } from 'vitest'

const anthropicMocks = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: anthropicMocks.create }
  },
}))
import { parseAnalysisJson, analyzeSpec } from './specAnalyzer.js'

const VALID_ANALYSIS_JSON = JSON.stringify({
  goal: '個人の思考・経験をAIで複数媒体へ自動配信するシステムを作る。',
  designPhilosophy: [
    '1 Thought = N Assets: 1つの入力から複数の出力を生成する',
    '投稿は必ず人間確認あり（自動投稿禁止）',
    'Raw体験を中心にする（AI感を出さない）',
  ],
  mvpScope: {
    description: 'Markdown入力 → AI記事化 → ローカル保存 → 手動投稿',
    includedFeatures: ['Markdown入力', 'Claude APIでコンテンツ化', 'ローカルSQLite保存', '手動投稿'],
    excludedFeatures: ['自動投稿', 'Analytics Engine', 'Podcast/動画生成'],
  },
  targetUsers: ['個人開発者', '起業家', 'Build in Public実践者'],
  techStack: ['Node.js', 'TypeScript', 'Astro', 'SQLite', 'Claude API'],
  gaps: [
    {
      category: 'technical',
      description: '最初に対応する媒体が未決定',
      severity: 'must_resolve',
      suggestion: 'まずAstro + GitHub Pages のみから始める',
    },
  ],
  requiredExternalServices: [
    { name: 'Claude API', purpose: 'コンテンツ生成', hasCost: true },
    { name: 'GitHub Pages', purpose: 'ブログホスティング', hasCost: false },
  ],
  readinessScore: 75,
  readinessReason: '主要機能が明確でMVP範囲が絞られている。対応媒体を決定すれば開発開始可能。',
})

describe('parseAnalysisJson', () => {
  it('正常なJSONを解析できる', () => {
    const result = parseAnalysisJson(VALID_ANALYSIS_JSON)
    expect(result.goal).toContain('個人の思考')
    expect(result.designPhilosophy).toHaveLength(3)
    expect(result.gaps).toHaveLength(1)
    expect(result.readinessScore).toBe(75)
  })

  it('```json ブロックに包まれたJSONを解析できる', () => {
    const wrapped = '```json\n' + VALID_ANALYSIS_JSON + '\n```'
    const result = parseAnalysisJson(wrapped)
    expect(result.goal).toBeTruthy()
  })

  it('JSONが含まれない場合はエラーをthrowする', () => {
    expect(() => parseAnalysisJson('JSONではないテキスト')).toThrow('[CTO AI]')
  })

  it('スキーマ不正なJSONはエラーをthrowする', () => {
    const invalid = JSON.stringify({ goal: 'OK' })  // 必須フィールド欠落
    expect(() => parseAnalysisJson(invalid)).toThrow('[CTO AI]')
  })

  it('readinessScore が 0〜100 の範囲外はエラー', () => {
    const badScore = JSON.parse(VALID_ANALYSIS_JSON)
    badScore.readinessScore = 150
    expect(() => parseAnalysisJson(JSON.stringify(badScore))).toThrow()
  })
})

describe('analyzeSpec (default model)', () => {
  it('uses the current Anthropic Haiku model by default', async () => {
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: VALID_ANALYSIS_JSON }],
    })

    await analyzeSpec('テスト仕様書のテキスト（50文字以上にするためにここに追加テキストを入れます）', { apiKey: 'test-api-key' })

    expect(anthropicMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
    }))
  })
})

describe('analyzeSpec (mockResponse)', () => {
  it('mockResponse を使うとAPIを呼ばずに解析できる', async () => {
    const result = await analyzeSpec('テスト仕様書のテキスト（50文字以上にするためにここに追加テキストを入れます）', {
      mockResponse: VALID_ANALYSIS_JSON,
    })
    expect(result.goal).toContain('個人の思考')
    expect(result.readinessScore).toBe(75)
  })

  it('ANTHROPIC_API_KEY がない状態で mockResponse なしはエラー', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    await expect(
      analyzeSpec('テスト仕様書（50文字以上にするためにここに追加テキストを入れます）', {})
    ).rejects.toThrow('ANTHROPIC_API_KEY')

    process.env.ANTHROPIC_API_KEY = originalKey
  })
})
