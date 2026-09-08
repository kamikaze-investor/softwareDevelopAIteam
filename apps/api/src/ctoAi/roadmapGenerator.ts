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

import path from 'node:path'
import { buildRunnerEnv, executeRunner, type CoordinatorDeps } from '../designReview/designReviewCoordinator.js'
import { buildConstitutionPrinciplesPrompt, formatConstitutionPrinciplesWarning, loadConstitutionPrinciples } from '@ai-team/shared/src/constitutionPrinciples.js'
import {
  assertRoadmapTopologySeparated,
  ROADMAP_GENERATOR_PROVIDER,
  ROADMAP_TASK_CATEGORIES,
  type RoadmapTaskCategory,
} from '@ai-team/shared'
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
  /**
   * このタスクが解決すべきAI調査対象の不確実性への参照（`U1`, `U2`...）。
   * プロンプトへ提示した Open Technical Uncertainties のIDをそのまま返す。
   *
   * 「descriptionへ書き写してください」という指示だけでは、モデルが従ったかどうかを
   * 機械的に検証できない。構造化参照にすることで、deterministic validationで
   * 「全不確実性が最低1つのタスクから参照されているか」「未知のrefが無いか」を検査でき、
   * 参照された本文は`buildRoadmapTasks()`が決定論的にdescriptionへ展開できる。
   */
  technicalUncertaintyRefs: z.array(z.string()).default([]),
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
- Open Technical Uncertainties が渡された場合の扱い（一般ルール）:
  - 無視しない。CEOへ質問されていないので、AIが解決しなければ誰も解決しない
  - それを解決する必要がある**関連タスクの technicalUncertaintyRefs へIDを列挙する**。
    本文はそのタスクのdescriptionへ自動展開されるため、あなたが書き写す必要はない
  - **提示されたIDはすべて、最低1つのタスクから参照されていなければならない。**
    参照漏れ・未知のIDがあるRoadmapは却下され再生成になる
  - 独立した成果物にならない調査だけを別タスクへ切り出さない。調査は、それを必要とする
    実装タスクの一部として扱う
  - 実装詳細を推測で決め打ちしない。既存のコード・仕様・テストを確認してから実装する
  - どの不確実性がどのタスクに関係するかはあなたが判断する。関係しないタスクへ機械的に
    全件コピーしない
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
      "estimatedComplexity": "small",
      "technicalUncertaintyRefs": []
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

  /** 対象リポジトリのルート。Codexがここを読みながらRoadmapを立てる。 */
  targetProjectRoot?: string

  /** テストから差し替えるためのrunner起動設定。未指定なら既定。 */
  runnerDeps?: CoordinatorDeps
}

/**
 * `decisionOwner: 'ai'`のGap（CEOへ質問されない、AIが既存repo/spec/testを調査して解決すべき
 * 技術的不確実性）をRoadmap生成プロンプトへ渡す。
 *
 * これが無いと、CEO質問から除外したGapがどの後続AIにも届かない
 * （`gap_analysis.md`は書き出されるだけで読み手が存在しない）。**除外は「解決済み」ではない**:
 * specAnalyzerはrepo/spec/testを読んでいないため、不確実性の種類を判定できても答えは知らない。
 * Roadmapを立てるAIが、調査そのものを計画へ織り込めるようにする。
 */
export interface TechnicalUncertainty {
  /** この生成ラウンド内で安定した参照ID（`U1`, `U2`...）。 */
  ref: string
  description: string
  category: string
  severity: string
  suggestion: string
}

/**
 * `decisionOwner: 'ai'`のGapへ、この生成ラウンド内で安定した参照IDを振る。
 * `analysis.gaps`の順序から決定論的に導出するため、生成・検証・展開の三者が
 * 同じIDを再計算できる（IDを別に永続化する必要がない）。
 */
export function collectTechnicalUncertainties(analysis: SpecAnalysis): TechnicalUncertainty[] {
  return analysis.gaps
    .filter((gap) => gap.decisionOwner === 'ai')
    .map((gap, index) => ({
      ref: `U${index + 1}`,
      description: gap.description,
      category: gap.category,
      severity: gap.severity,
      suggestion: gap.suggestion,
    }))
}

function buildOpenTechnicalUncertaintiesSection(analysis: SpecAnalysis): string {
  const uncertainties = collectTechnicalUncertainties(analysis)
  if (uncertainties.length === 0) return ''

  return `
## Open Technical Uncertainties (resolve by investigating the existing repo/spec/tests)

これらはCEOへ質問されない。既存の実装・仕様・テストを調査すれば答えが決まる種類の不確実性であり、
Roadmapを立てる時点で「調査して確定させる」対象として扱うこと。推測で決め打ちしない。

**それぞれを解決する必要があるタスクの \`technicalUncertaintyRefs\` へ、下記のIDを列挙すること。**
参照された本文は自動でそのタスクのdescriptionへ展開される（あなたが書き写す必要はない）。
**すべてのIDが最低1つのタスクから参照されていなければRoadmapは却下され、再生成になる。**
関係しないタスクへ機械的に全件コピーしないこと。調査だけの独立タスクは作らないこと。

${uncertainties.map((u) => `- ${u.ref}: ${u.description}（${u.category} / ${u.severity}）\n  調査の手がかり: ${u.suggestion}`).join('\n')}
`
}

/**
 * Roadmap生成プロンプトへ渡すProject Summary本文。
 * プロンプトへ実際に何が載るかをテストから検証できるよう、組み立てだけを切り出している。
 */
export function buildRoadmapProjectSummary(
  analysis: SpecAnalysis,
  options: RoadmapGeneratorOptions = {},
): string {
  return `
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
${buildOpenTechnicalUncertaintiesSection(analysis)}
${options.priorAttemptFeedback ? `
## Previous Attempt Was Rejected -- Fix This

${options.priorAttemptFeedback}

Generate a NEW roadmap that addresses this specific problem. Do not repeat the same structural mistake.
` : ''}
`.trim()
}

/** Roadmap生成に使うCodexのモデルと推論強度。Roadmapは全体の骨格を決めるので最上位を使う。 */
export const ROADMAP_GENERATOR_MODEL = 'gpt-5.6-sol'
export const ROADMAP_GENERATOR_REASONING_EFFORT = 'xhigh'
/** vendor separationの正本は packages/shared/src/roadmapTopology.ts。ここでは再輸出だけ。 */
export { ROADMAP_GENERATOR_PROVIDER }

/** Roadmap生成runnerの既定起動設定。designReviewと同じ形（新しいQueue/Daemonは作らない）。 */
export function buildDefaultRoadmapGeneratorDeps(): CoordinatorDeps {
  const repoRoot = process.env.DESIGN_REVIEW_REPO_ROOT ?? path.resolve(process.cwd(), '../..')

  return {
    runnerCommand: process.env.DESIGN_REVIEW_RUNNER_COMMAND ?? 'npx',
    runnerArgs: [
      ...(process.env.DESIGN_REVIEW_RUNNER_COMMAND ? [] : ['tsx']),
      path.join(repoRoot, 'apps', 'worker', 'scripts', 'roadmapGeneratorRunner.ts'),
    ],
    homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? repoRoot,
    workingDir: repoRoot,
  }
}

/**
 * Roadmapを生成する。
 *
 * **生成者はCodex（gpt-5.6-sol / reasoning effort xhigh）。**
 * 以前はClaude Haikuへ Anthropic SDK で投げていたが、それでは対象リポジトリを読めない —
 * SDK経路のモデルはファイルにアクセスできないので、既存のコード・仕様・テストを見ずに
 * Roadmapを立てることになる。Codex CLIは `-C <target>` を読みながら計画できる。
 *
 * runnerは `--sandbox read-only` で動き、capture fileはOS temp配下に置かれるので、
 * 生成中に対象リポジトリを書き換えない。
 *
 * ⚠️ このVPSではbubblewrapが動かないため `use_legacy_landlock=true` をcall-localに渡す。
 * deprecatedな暫定経路（roadmap: codex-sandbox-off-deprecated-landlock）。
 */
export async function generateRoadmap(
  analysis: SpecAnalysis,
  options: RoadmapGeneratorOptions = {},
): Promise<Roadmap> {
  const { mockResponse } = options

  if (mockResponse !== undefined) {
    return parseRoadmapJson(mockResponse)
  }

  // **モデルを呼ぶ前に**分離を検証する。生成後に気付くと最上位モデルの枠を捨てることになる。
  // 同一vendor / 未知のvendorはfail-closed（reviewSeparation.ts）。
  assertRoadmapTopologySeparated()

  const projectSummary = buildRoadmapProjectSummary(analysis, options)
  const targetRepo = options.targetProjectRoot ?? process.env.TARGET_ROOT ?? '/workspace/target'
  const deps = options.runnerDeps ?? buildDefaultRoadmapGeneratorDeps()

  const runnerInput = JSON.stringify({
    subjectId: options.definitionHash ?? 'roadmap',
    prompt: [
      SYSTEM_PROMPT,
      '',
      '以下のProject Memoryからロードマップを生成してください:',
      '',
      projectSummary,
    ].join(String.fromCharCode(10)),
    workingDir: targetRepo,
    model: ROADMAP_GENERATOR_MODEL,
    reasoningEffort: ROADMAP_GENERATOR_REASONING_EFFORT,
    useLegacyLandlockSandbox: true,
  })

  // designReviewCoordinator と同じ呼び出し規約: テストは deps.execute で差し替える。
  const execution = deps.execute
    ? await deps.execute(runnerInput)
    : await executeRunner(deps, runnerInput)

  if (!execution.ok) {
    // Roadmapが得られないことを「空のRoadmap」として下流へ流さない（fail-closed）。
    throw new Error(
      '[CTO AI] Roadmap生成に失敗しました: ' + (execution.error ?? 'unknown')
      + (execution.stderr ? ' / ' + execution.stderr : ''),
    )
  }

  return parseRoadmapJson(execution.stdout)
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
