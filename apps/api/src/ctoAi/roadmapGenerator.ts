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
import { buildConstitutionPrinciplesPrompt, formatConstitutionPrinciplesWarning, loadConstitutionPrinciples } from '@ai-team/shared/src/constitutionPrinciples.js'
import { ROADMAP_TASK_CATEGORIES, type RoadmapTaskCategory } from '@ai-team/shared'
import { z } from 'zod'
import type { SpecAnalysis } from './specAnalyzer.js'

// ────────────────────────────────────────────────────────────
// 出力型定義
//
// category の型そのものは packages/shared/src/types/project_roadmap.ts が正本
// （roadmapTaskValidation.ts の検証と共有するため。Meta Reviewer指摘、2026-09-01）。
// ここではLLM出力の実行時検証に使うZod schemaだけを持ち、`z.ZodType<RoadmapTaskCategory>`で
// 共有型との一致をコンパイル時に強制する。
// ────────────────────────────────────────────────────────────

export const GeneratedTaskCategorySchema: z.ZodType<RoadmapTaskCategory> = z.enum(ROADMAP_TASK_CATEGORIES)

export const GeneratedTaskSchema = z.object({
  id: z.string().regex(/^task-\d+$/, 'task-001 形式で指定'),
  title: z.string().min(1).max(100),
  description: z.string(),
  phase: z.number().int().min(1),
  assignee: z.enum(['cto_ai', 'context_manager', 'developer_ai', 'reviewer_ai', 'qa_ai']),
  category: GeneratedTaskCategorySchema,
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

const constitutionPrinciples = loadConstitutionPrinciples()
const constitutionPrinciplesWarning = formatConstitutionPrinciplesWarning(constitutionPrinciples)
if (constitutionPrinciplesWarning) console.warn(constitutionPrinciplesWarning)
const constitutionPrinciplesPrompt = `${buildConstitutionPrinciplesPrompt(constitutionPrinciples)}\n`

const SYSTEM_PROMPT = `あなたはAI開発チームのCTO AIです。
Project Memoryを受け取り、具体的な開発ロードマップとタスク一覧をJSON形式で出力します。
AI Team OS共通行動原則は specs/00_constitution.md 3.14〜3.15（最小検証・必要最小反証／CEO確認最小化・自律判断）を正本として適用し、明示的なSafety Ruleを常に優先します。
${constitutionPrinciplesPrompt}
以下のルールを守ってください:
- タスクは小さく分割する（1タスク = 最大2日の作業量）
- 依存関係を正確に設定する（並列実行できるものは依存しない）
- タスク数はプロジェクトの実際の範囲に比例させてください。単一ファイル・単一関数の変更であれば1〜2タスクで十分であり、複数ファイル・複数モジュール・新しいサブシステムを含む場合のみ分割を広げてください。デフォルトのタスク数_rangeは存在しません。要件に応じて比例的に Size してください。
- Structured Constraints に max_task_count がある場合はその値を厳守してください
- Phase はプロジェクトの範囲に応じて適切に設定してください。小規模変更では1フェーズで十分であり、基盤構築→MVP機能→品質改善の3フェーズ構造は、複数フェーズにまたがる複数の異なる成果物がある場合のみ使ってください
- allowedPaths は実際に変更するディレクトリのみ（例: "apps/engine/src/"）
- 各タスクには category を必ず設定する:
  - "implementation": 実際にコード/ドキュメント/設定の変更を行いプロジェクトの成果物を生み出すタスク
  - "verification": 既に実装された変更のテスト・QA・検証を行うタスク。**注意**: 小規模変更では implementation タスクにテスト検証を組み込み、別途 verification タスクを生成しないこと。verification は変更が広範囲で検証が別途必要とされる場合のみ生成する
  - "control_plane_operation": AIteamOSの自動操作を複製するタスク（Design Review提出・Approval取得・ブランチ作成・コミット・PR作成・CI確認・Commit Gate実行など）— **このカテゴリのタスクは絶対に生成しないでください**。これらはTaskシステムの外で自動的に実行されるため、Taskとして生成しない
  - "other": 上記以外（ sparingly 使用し、可能な限り他の3つを優先する）

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
      "category": "implementation",
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
  canonicalDefinitionText?: string
  definitionHash?: string
  /**
   * Feedback from a previous rejected attempt (deterministic validation issues or a
   * Whole-Roadmap Design Review CONFLICT reason). When present, tells the model what was wrong
   * last time so it can avoid repeating it. Never used to inject new constraints or guess at
   * Goal/Design Philosophy content -- purely "here's what failed, fix this."
   */
  priorAttemptFeedback?: string
}

export async function generateRoadmap(
  analysis: SpecAnalysis,
  options: RoadmapGeneratorOptions = {},
): Promise<Roadmap> {
  const { mockResponse, model = 'claude-haiku-4-5-20251001' } = options

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

${options.definitionHash ? `## Project Definition Hash\n${options.definitionHash}\n` : ''}
${options.canonicalDefinitionText ? `## Canonical Project Definition\n${options.canonicalDefinitionText}\n` : ''}
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

## Scope Signals
- MVP included features: ${analysis.mvpScope.includedFeatures.length}
- MVP excluded features: ${analysis.mvpScope.excludedFeatures.length}
- Tech stack size: ${analysis.techStack.length}
- Structured constraints count: ${analysis.structuredConstraints.length}

## Structured Constraints
${JSON.stringify(analysis.structuredConstraints, null, 2)}
${options.priorAttemptFeedback ? `
## Previous Attempt Was Rejected -- Fix This

${options.priorAttemptFeedback}

Generate a NEW roadmap that addresses this specific problem. Do not repeat the same structural mistake.
` : ''}
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
