/**
 * Gemini Flash Stepレビュー（Step R3・最小実装）
 *
 * 役割定義（詳細は docs/multi_ai_step_review_flow.md 6章・6-1章）:
 * - Safety Gate層ではない。停止権限を持たない、Stepごとの軽量な判断レビュー・重要度判定。
 * - 既存の`preReviewer.ts`/`postReviewer.ts`（blocked:trueで実行を止める権限を持つ）とは別物。
 *   本モジュールはblocked概念を持たない。
 * - Gemini呼び出しは既存基盤 `apps/worker/src/metaReviewer/geminiRouter.ts`（AV-001対象・編集禁止）の
 *   `callGeminiWithFallback()` をそのまま呼ぶだけで、新しい外部サービス・新しいAPIキーは追加しない。
 * - jobRunner/commitGateへの接続、ChatGPT自動呼び出し、自動停止条件の追加は本モジュールの範囲外。
 */

import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'

export type StepReviewImportance = 'low' | 'medium' | 'high'

export type StepReviewRouting =
  | 'proceed_candidate'
  | 'fix_required'
  | 'escalate_to_chatgpt'
  | 'require_ceo'
  | 'stop'

/**
 * Gemini呼び出し自体の状態。既存フローを止めないため、失敗時も例外を投げず
 * この状態として表現する。
 *   done     : Gemini呼び出し・パースに成功した
 *   failed   : Gemini呼び出しまたは応答パースに失敗した（quota枯渇・ネットワークエラー等含む）
 *   not_run  : 呼び出し条件を満たさなかった（Level 1等）ため、そもそも呼んでいない
 *   pending  : 呼び出し待ち（未着手の予約状態）
 */
export type StepReviewStatus = 'done' | 'failed' | 'not_run' | 'pending'

export interface StepReviewInput {
  jobId: string
  taskId: string
  /** 今回のStepでやったことの要約（前提量最適化に従い、過去Stepの全文は含めない） */
  stepSummary: string
  /** タスク全体の目的（短く） */
  purposeSummary: string
  /** 直前のMechanical Safety Checks結果の要約 */
  mechanicalSafetyResultSummary: string
  /** 対象ファイル一覧 */
  targetFiles: string[]
}

export interface StepReviewResult {
  status: StepReviewStatus
  importance?: StepReviewImportance
  routing?: StepReviewRouting
  summary: string
  concerns: string[]
  requiredFixes: string[]
  escalationReason: string | null
  /** レビューAIの自己申告信頼度（0.0-1.0）。パース失敗・呼び出し失敗時は0 */
  confidence: number
  generatedAt: string
  /** レビュー生テキスト（監査用に保持。not_run/pendingの場合は空文字） */
  rawResponse: string
}

interface ParsedStepReviewResponse {
  importance?: unknown
  routing?: unknown
  summary?: unknown
  concerns?: unknown
  requiredFixes?: unknown
  escalationReason?: unknown
  confidence?: unknown
}

const STEP_REVIEW_IMPORTANCES: StepReviewImportance[] = ['low', 'medium', 'high']
const STEP_REVIEW_ROUTINGS: StepReviewRouting[] = [
  'proceed_candidate',
  'fix_required',
  'escalate_to_chatgpt',
  'require_ceo',
  'stop',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStepReviewImportance(value: unknown): value is StepReviewImportance {
  return typeof value === 'string' && STEP_REVIEW_IMPORTANCES.includes(value as StepReviewImportance)
}

function isStepReviewRouting(value: unknown): value is StepReviewRouting {
  return typeof value === 'string' && STEP_REVIEW_ROUTINGS.includes(value as StepReviewRouting)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Gemini Flash Stepレビュー用のプロンプトを組み立てる。
 * 前提量最適化（docs/multi_ai_step_review_flow.md 6-1章）に従い、
 * 今回のStepの要約・目的・直前の機械チェック結果の要約のみを渡す。過去Stepの全文は含めない。
 */
export function buildStepReviewPrompt(input: StepReviewInput): string {
  const targetFileList = input.targetFiles.map(file => `- ${file}`).join('\n')

  return [
    'これはAI開発チームにおけるStep単位の軽量判断レビューです。',
    'あなたは最終判断者ではありません。重要度判定と次に何をすべきかの提案のみを行ってください。',
    'AI Team OS共通行動原則は specs/00_constitution.md 3.14〜3.15（最小検証・必要最小反証／CEO確認最小化・自律判断）を正本として適用し、明示的なSafety Ruleを常に優先してください。',
    '',
    'タスクの目的:',
    input.purposeSummary,
    '',
    '今回のStepでやったこと:',
    input.stepSummary,
    '',
    '直前のMechanical Safety Checks結果の要約:',
    input.mechanicalSafetyResultSummary,
    '',
    '対象ファイル一覧:',
    targetFileList,
    '',
    '以下のJSON形式で回答してください。他のテキストを含めないでください。',
    '```json',
    '{',
    '  "importance": "low" | "medium" | "high",',
    '  "routing": "proceed_candidate" | "fix_required" | "escalate_to_chatgpt" | "require_ceo" | "stop",',
    '  "summary": "短い要約（日本語1-2文）",',
    '  "concerns": ["懸念点"],',
    '  "requiredFixes": ["必要修正"],',
    '  "escalationReason": "ChatGPT/CEOへ上げる理由。不要ならnull",',
    '  "confidence": 0.0から1.0の数値',
    '}',
    '```',
  ].join('\n')
}

/** Gemini応答をパースする。パースに失敗した場合は例外を投げず status:'failed' を返す。 */
export function parseStepReviewResponse(raw: string): StepReviewResult {
  const jsonBlockMatch = /```json\s*([\s\S]*?)\s*```/iu.exec(raw)
  const jsonText = jsonBlockMatch?.[1] ?? raw

  try {
    const parsed = JSON.parse(jsonText) as ParsedStepReviewResponse

    if (!isRecord(parsed) || !isStepReviewImportance(parsed.importance) || !isStepReviewRouting(parsed.routing)) {
      return {
        status: 'failed',
        summary: 'Stepレビュー応答のパースに失敗しました',
        concerns: [],
        requiredFixes: [],
        escalationReason: null,
        confidence: 0,
        generatedAt: new Date().toISOString(),
        rawResponse: raw,
      }
    }

    return {
      status: 'done',
      importance: parsed.importance,
      routing: parsed.routing,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '(summary not provided)',
      concerns: normalizeStringArray(parsed.concerns),
      requiredFixes: normalizeStringArray(parsed.requiredFixes),
      escalationReason: typeof parsed.escalationReason === 'string' ? parsed.escalationReason : null,
      confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0.5,
      generatedAt: new Date().toISOString(),
      rawResponse: raw,
    }
  } catch {
    return {
      status: 'failed',
      summary: 'Stepレビュー応答のパースに失敗しました',
      concerns: [],
      requiredFixes: [],
      escalationReason: null,
      confidence: 0,
      generatedAt: new Date().toISOString(),
      rawResponse: raw,
    }
  }
}

/**
 * Gemini Flash Stepレビューを実行する。
 * Gemini呼び出しに失敗しても（quota枯渇・ネットワークエラー等）例外を投げず、
 * status:'failed' の結果を返す。既存フロー（Step実装・commit判断等）は止めない。
 */
export async function runStepReview(input: StepReviewInput): Promise<StepReviewResult> {
  const prompt = buildStepReviewPrompt(input)

  try {
    const raw = await callGeminiWithFallback(prompt, {
      featureName: 'gemini-flash-step-review',
    })

    return parseStepReviewResponse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    return {
      status: 'failed',
      summary: `Stepレビュー呼び出しに失敗しました: ${message}`,
      concerns: [],
      requiredFixes: [],
      escalationReason: null,
      confidence: 0,
      generatedAt: new Date().toISOString(),
      rawResponse: '',
    }
  }
}

/**
 * 呼び出し条件を満たさなかった場合（Level 1等）に使う、呼び出しをスキップしたことを
 * 明示するための結果。Final Review Packetへ「未実行」として記録する際に使う。
 */
export function createNotRunStepReviewResult(reason: string): StepReviewResult {
  return {
    status: 'not_run',
    summary: reason,
    concerns: [],
    requiredFixes: [],
    escalationReason: null,
    confidence: 0,
    generatedAt: new Date().toISOString(),
    rawResponse: '',
  }
}

/** 呼び出し待ち（未着手の予約状態）を表す結果。 */
export function createPendingStepReviewResult(reason: string): StepReviewResult {
  return {
    status: 'pending',
    summary: reason,
    concerns: [],
    requiredFixes: [],
    escalationReason: null,
    confidence: 0,
    generatedAt: new Date().toISOString(),
    rawResponse: '',
  }
}
