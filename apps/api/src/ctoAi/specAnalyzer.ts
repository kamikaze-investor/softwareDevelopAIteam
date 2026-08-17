/**
 * CTO AI — 仕様書解析エンジン（task-101）
 *
 * 役割:
 *   仕様書テキスト（Markdown）を受け取り、Claude APIで構造化する。
 *   出力はProject Memoryの素材として使われる。
 *
 * 呼び出し方:
 *   CLI経由ではなくAnthropicSDKで直接呼ぶ（構造化JSON出力が必要なため）。
 */

import Anthropic from '@anthropic-ai/sdk'
import { buildConstitutionPrinciplesPrompt, formatConstitutionPrinciplesWarning, loadConstitutionPrinciples } from '@ai-team/shared/src/constitutionPrinciples.js'
import { z } from 'zod'

// ────────────────────────────────────────────────────────────
// 出力型定義
// ────────────────────────────────────────────────────────────

export const GapSchema = z.object({
  category: z.enum(['business', 'technical', 'data', 'cost', 'legal', 'other']),
  description: z.string(),
  severity: z.enum(['must_resolve', 'should_resolve', 'optional']),
  suggestion: z.string(),
})

export const SpecAnalysisSchema = z.object({
  /** プロジェクトの最終目的（1〜3文） */
  goal: z.string(),
  /** 設計思想（箇条書き、3〜7項目） */
  designPhilosophy: z.array(z.string()),
  /** MVP スコープ（何を最初に作るか） */
  mvpScope: z.object({
    description: z.string(),
    includedFeatures: z.array(z.string()),
    excludedFeatures: z.array(z.string()),
  }),
  /** 主要ユーザー */
  targetUsers: z.array(z.string()),
  /** 技術スタック候補 */
  techStack: z.array(z.string()),
  /** 不足情報（Gap Analysis） */
  gaps: z.array(GapSchema),
  /** 外部サービス（APIキーや課金が必要なもの） */
  requiredExternalServices: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    hasCost: z.boolean(),
  })),
  /** 開発開始の準備状況（0〜100） */
  readinessScore: z.number().int().min(0).max(100),
  /** readinessScore の根拠 */
  readinessReason: z.string(),
})

export type SpecAnalysis = z.infer<typeof SpecAnalysisSchema>
export type Gap = z.infer<typeof GapSchema>

// ────────────────────────────────────────────────────────────
// プロンプト
// ────────────────────────────────────────────────────────────

const constitutionPrinciples = loadConstitutionPrinciples()
const constitutionPrinciplesWarning = formatConstitutionPrinciplesWarning(constitutionPrinciples)
if (constitutionPrinciplesWarning) console.warn(constitutionPrinciplesWarning)
const constitutionPrinciplesPrompt = `${buildConstitutionPrinciplesPrompt(constitutionPrinciples)}\n`

const SYSTEM_PROMPT = `あなたはAI開発チームのCTO AIです。
ユーザーから仕様書（Markdown）を受け取り、開発チームが開発を開始できる形に構造化します。
AI Team OS共通行動原則は specs/00_constitution.md 3.14〜3.15（最小検証・必要最小反証／CEO確認最小化・自律判断）を正本として適用し、明示的なSafety Ruleを常に優先します。
${constitutionPrinciplesPrompt}
以下のJSON形式のみで回答してください。説明文・マークダウンコードブロック・前置き・後書きは一切不要です。

{
  "goal": "プロジェクトの最終目的（1〜3文で明確に）",
  "designPhilosophy": ["思想1", "思想2", ...],
  "mvpScope": {
    "description": "MVPの一言説明",
    "includedFeatures": ["機能1", "機能2", ...],
    "excludedFeatures": ["除外機能1", ...]
  },
  "targetUsers": ["ユーザータイプ1", ...],
  "techStack": ["技術1", "技術2", ...],
  "gaps": [
    {
      "category": "technical|business|data|cost|legal|other",
      "description": "不足している情報",
      "severity": "must_resolve|should_resolve|optional",
      "suggestion": "解決案または仮決定案"
    }
  ],
  "requiredExternalServices": [
    {
      "name": "サービス名",
      "purpose": "用途",
      "hasCost": true
    }
  ],
  "readinessScore": 75,
  "readinessReason": "スコアの根拠（1〜2文）"
}

注意事項:
- gaps は本当に重要な不足情報だけを列挙する（5件以内）
- readinessScore は 70以上なら開発開始可能とみなす
- techStack は仕様書に明記されているものだけを含める（推測しない）`

// ────────────────────────────────────────────────────────────
// メイン関数
// ────────────────────────────────────────────────────────────

export interface SpecAnalyzerOptions {
  /** Anthropic APIキー（省略時は環境変数 ANTHROPIC_API_KEY を使用） */
  apiKey?: string
  /** 使用モデル（省略時は claude-3-5-haiku-latest） */
  model?: string
  /** テスト用モック（指定するとAPIを呼ばない） */
  mockResponse?: string
}

export async function analyzeSpec(
  specText: string,
  options: SpecAnalyzerOptions = {},
): Promise<SpecAnalysis> {
  const { mockResponse, model = 'claude-3-5-haiku-latest' } = options

  // ── モック（テスト用） ─────────────────────────────────
  if (mockResponse !== undefined) {
    return parseAnalysisJson(mockResponse)
  }

  // ── 実際のAPI呼び出し ──────────────────────────────────
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      '[CTO AI] ANTHROPIC_API_KEY が設定されていません。\n' +
      '.env に ANTHROPIC_API_KEY=sk-ant-... を設定してください。'
    )
  }

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `以下の仕様書を解析してください:\n\n${specText}`,
      },
    ],
  })

  const rawText = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('')

  return parseAnalysisJson(rawText)
}

// ────────────────────────────────────────────────────────────
// JSONパース + バリデーション
// ────────────────────────────────────────────────────────────

export function parseAnalysisJson(raw: string): SpecAnalysis {
  // JSONブロック抽出（```json ... ``` があれば取り出す）
  const jsonMatch = raw.match(/```json\n?([\s\S]+?)\n?```/) ??
                    raw.match(/(\{[\s\S]+\})/)

  if (!jsonMatch) {
    throw new Error(`[CTO AI] JSONが見つかりません。応答:\n${raw.slice(0, 300)}`)
  }

  const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
  const result = SpecAnalysisSchema.safeParse(parsed)

  if (!result.success) {
    throw new Error(
      `[CTO AI] JSON構造が不正です:\n${JSON.stringify(result.error.format(), null, 2)}`
    )
  }

  return result.data
}
