/**
 * CTO AI — Roadmap + Task一覧ジェネレーター（task-102）
 *
 * 役割:
 *   Project Memory（goal / mvpScope / designPhilosophy）を受け取り、
 *   Claude APIで開発ロードマップとタスク一覧を生成する。
 *
 * 出力:
 *   - Roadmap（フェーズ別計画）
 *   - タスク一覧（依存関係付き、実装順に並んでいる）
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { SpecAnalysis } from './specAnalyzer.js'

// ────────────────────────────────────────────────────────────
// 出力型定義
// ────────────────────────────────────────────────────────────

export const GeneratedTaskSchema = z.object({
  id: z.string().regex(/^task-\d+$/, 'task-001 形式で指定'),
  title: z.string().min(1).max(100),
  description: z.string(),
  phase: z.number().int().min(1),
  assignee: z.enum(['cto_ai', 'context_manager', 'developer_ai', 'reviewer_ai', 'qa_ai']),
  dependencies: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(['small', 'medium', 'large']),
})

export const RoadmapSchema = z.object({
  phases: z.array(z.object({
    number: z.number().int().min(1),
    name: z.string(),
    goal: z.string(),
    tasks: z.array(z.string()),  // task-id のリスト
  })),
  tasks: z.array(GeneratedTaskSchema),
  totalTasks: z.number().int(),
  estimatedWeeks: z.number().int(),
})

export type GeneratedTask = z.infer<typeof GeneratedTaskSchema>
export type Roadmap = z.infer<typeof RoadmapSchema>

// ────────────────────────────────────────────────────────────
// プロンプト
// ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `あなたはAI開発チームのCTO AIです。
Project Memoryを受け取り、具体的な開発ロードマップとタスク一覧をJSON形式で出力します。
AI Team OS共通行動原則は specs/00_constitution.md 3.14〜3.15（最小検証・必要最小反証／CEO確認最小化・自律判断）を正本として適用し、明示的なSafety Ruleを常に優先します。

以下のルールを守ってください:
- タスクは小さく分割する（1タスク = 最大2日の作業量）
- 依存関係を正確に設定する（並列実行できるものは依存しない）
- Phase 1 は基盤構築（型定義・DB・API骨格）
- Phase 2 はMVP機能（最小限の動くもの）
- Phase 3 は品質・改善
- タスク数は合計10〜20件程度（MVPスコープに絞る）
- allowedPaths は実際に変更するディレクトリのみ（例: "apps/engine/src/"）

以下のJSON形式のみで回答してください。コードブロック・前置き・後書きは不要です:

{
  "phases": [
    {
      "number": 1,
      "name": "フェーズ名",
      "goal": "このフェーズで達成すること",
      "tasks": ["task-001", "task-002"]
    }
  ],
  "tasks": [
    {
      "id": "task-001",
      "title": "タスクのタイトル（50文字以内）",
      "description": "何をするか（100文字以内）",
      "phase": 1,
      "assignee": "developer_ai",
      "dependencies": [],
      "acceptanceCriteria": ["テストが通る", "型エラーがない"],
      "allowedPaths": ["apps/engine/src/"],
      "estimatedComplexity": "small"
    }
  ],
  "totalTasks": 12,
  "estimatedWeeks": 4
}`

// ────────────────────────────────────────────────────────────
// メイン関数
// ────────────────────────────────────────────────────────────

export interface RoadmapGeneratorOptions {
  apiKey?: string
  model?: string
  mockResponse?: string
}

export async function generateRoadmap(
  analysis: SpecAnalysis,
  options: RoadmapGeneratorOptions = {},
): Promise<Roadmap> {
  const { mockResponse, model = 'claude-3-5-haiku-latest' } = options

  if (mockResponse !== undefined) {
    return parseRoadmapJson(mockResponse)
  }

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('[CTO AI] ANTHROPIC_API_KEY が設定されていません。')
  }

  const client = new Anthropic({ apiKey })

  const projectSummary = `
# Project Summary

## Goal
${analysis.goal}

## Design Philosophy
${analysis.designPhilosophy.map((p, i) => `${i + 1}. ${p}`).join('\n')}

## MVP Scope
${analysis.mvpScope.description}

### 含む機能
${analysis.mvpScope.includedFeatures.map(f => `- ${f}`).join('\n')}

### 含まない機能
${analysis.mvpScope.excludedFeatures.map(f => `- ${f}`).join('\n')}

## Tech Stack
${analysis.techStack.map(t => `- ${t}`).join('\n')}
`.trim()

  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `以下のProject Memoryからロードマップを生成してください:\n\n${projectSummary}`,
      },
    ],
  })

  const rawText = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('')

  return parseRoadmapJson(rawText)
}

// ────────────────────────────────────────────────────────────
// JSONパース + バリデーション
// ────────────────────────────────────────────────────────────

export function parseRoadmapJson(raw: string): Roadmap {
  const jsonMatch = raw.match(/```json\n?([\s\S]+?)\n?```/) ??
                    raw.match(/(\{[\s\S]+\})/)

  if (!jsonMatch) {
    throw new Error(`[CTO AI] Roadmap JSONが見つかりません。応答:\n${raw.slice(0, 300)}`)
  }

  const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
  const result = RoadmapSchema.safeParse(parsed)

  if (!result.success) {
    throw new Error(
      `[CTO AI] Roadmap JSONの構造が不正です:\n${JSON.stringify(result.error.format(), null, 2)}`
    )
  }

  return result.data
}
