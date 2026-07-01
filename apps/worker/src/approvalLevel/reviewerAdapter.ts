import type { ApprovalLevelResult } from '@ai-team/shared'
import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'

export type ReviewerProvider = 'gemini' | 'claude' | 'chatgpt'
export type ImplementerProvider = 'claude_code' | 'codex' | 'gemini'
export type ReviewPhase = 'pre' | 'post'
export type ReviewVerdict = 'approved' | 'changes_requested' | 'blocking'

export interface ReviewIssue {
  severity: 'info' | 'warning' | 'critical'
  description: string
}

export interface ReviewerRequest {
  jobId: string
  taskId: string
  implementerProvider: ImplementerProvider
  reviewerProvider: ReviewerProvider
  phase: ReviewPhase
  /** preのみ使用: 変更計画テキスト */
  planText?: string
  /** postのみ使用: git diff本文 */
  diffText?: string
  /** 実装目的・タスク説明（両フェーズで使用） */
  purposeSummary: string
  /** 対象ファイル一覧 */
  targetFiles: string[]
}

export interface ReviewerResult {
  provider: ReviewerProvider
  phase: ReviewPhase
  verdict: ReviewVerdict
  summary: string
  issues: ReviewIssue[]
  /** レビューAIの自己申告信頼度（0.0-1.0）。パース失敗時は0 */
  confidence: number
  generatedAt: string
  /** レビュー生テキスト（監査用に保持） */
  rawResponse: string
}

export interface IReviewerAdapter {
  review(req: ReviewerRequest): Promise<ReviewerResult>
}

interface ParsedReviewerResponse {
  verdict?: unknown
  summary?: unknown
  issues?: unknown
  confidence?: unknown
}

const REVIEW_VERDICTS: ReviewVerdict[] = ['approved', 'changes_requested', 'blocking']
const ISSUE_SEVERITIES: ReviewIssue['severity'][] = ['info', 'warning', 'critical']

function assertNever(value: never): never {
  throw new Error(`Unhandled implementer provider: ${value}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === 'string' && REVIEW_VERDICTS.includes(value as ReviewVerdict)
}

function isIssueSeverity(value: unknown): value is ReviewIssue['severity'] {
  return typeof value === 'string' && ISSUE_SEVERITIES.includes(value as ReviewIssue['severity'])
}

function isReviewIssue(value: unknown): value is ReviewIssue {
  return isRecord(value) && isIssueSeverity(value.severity) && typeof value.description === 'string'
}

function normalizeIssues(value: unknown): ReviewIssue[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(isReviewIssue)
    .map(issue => ({
      severity: issue.severity,
      description: issue.description,
    }))
}

function buildFailureResult(
  raw: string,
  provider: ReviewerProvider,
  phase: ReviewPhase,
): ReviewerResult {
  return {
    provider,
    phase,
    verdict: 'blocking',
    summary: 'レビュー応答のパースに失敗しました',
    issues: [],
    confidence: 0,
    generatedAt: new Date().toISOString(),
    rawResponse: raw,
  }
}

export function selectReviewerProvider(implementer: ImplementerProvider): ReviewerProvider {
  switch (implementer) {
    case 'claude_code':
      return 'gemini'
    case 'codex':
      return 'gemini'
    case 'gemini':
      return 'claude'
    default:
      return assertNever(implementer)
  }
}

export function buildReviewPrompt(req: ReviewerRequest): string {
  const targetFileList = req.targetFiles.map(file => `- ${file}`).join('\n')

  const phaseSpecificContent = req.phase === 'pre'
    ? [
        'これは実装前の変更計画レビューです。',
        '',
        '変更計画:',
        req.planText ?? '',
      ].join('\n')
    : [
        'これは実装後のdiffレビューです。実装目的とdiffが整合しているか確認してください。',
        '',
        'git diff:',
        req.diffText ?? '',
      ].join('\n')

  return [
    phaseSpecificContent,
    '',
    '実装目的・タスク説明:',
    req.purposeSummary,
    '',
    '対象ファイル一覧:',
    targetFileList,
    '',
    '以下のJSON形式で回答してください。他のテキストを含めないでください。',
    '```json',
    '{',
    '  "verdict": "approved" | "changes_requested" | "blocking",',
    '  "summary": "レビューの要約（日本語1-2文）",',
    '  "issues": [{ "severity": "info"|"warning"|"critical", "description": "..." }],',
    '  "confidence": 0.0から1.0の数値',
    '}',
    '```',
  ].join('\n')
}

export function parseReviewerResponse(
  raw: string,
  provider: ReviewerProvider,
  phase: ReviewPhase,
): ReviewerResult {
  const jsonBlockMatch = /```json\s*([\s\S]*?)\s*```/iu.exec(raw)
  const jsonText = jsonBlockMatch?.[1] ?? raw

  try {
    const parsed = JSON.parse(jsonText) as ParsedReviewerResponse

    if (!isRecord(parsed) || !isReviewVerdict(parsed.verdict)) {
      return buildFailureResult(raw, provider, phase)
    }

    return {
      provider,
      phase,
      verdict: parsed.verdict,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '(summary not provided)',
      issues: normalizeIssues(parsed.issues),
      confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0.5,
      generatedAt: new Date().toISOString(),
      rawResponse: raw,
    }
  } catch {
    return buildFailureResult(raw, provider, phase)
  }
}

export class GeminiReviewerAdapter implements IReviewerAdapter {
  async review(req: ReviewerRequest): Promise<ReviewerResult> {
    const prompt = buildReviewPrompt(req)

    try {
      const raw = await callGeminiWithFallback(prompt, {
        featureName: `approval-level-${req.phase}-review`,
      })

      return parseReviewerResponse(raw, 'gemini', req.phase)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      return {
        provider: 'gemini',
        phase: req.phase,
        verdict: 'blocking',
        summary: `レビューAI呼び出しに失敗しました: ${message}`,
        issues: [],
        confidence: 0,
        generatedAt: new Date().toISOString(),
        rawResponse: '',
      }
    }
  }
}

export function createReviewerAdapter(provider: ReviewerProvider): IReviewerAdapter {
  switch (provider) {
    case 'gemini':
      return new GeminiReviewerAdapter()
    case 'claude':
      throw new Error('ClaudeReviewerAdapter は未実装です（将来拡張ポイント）')
    case 'chatgpt':
      throw new Error('ChatGptReviewerAdapter は未実装です（将来のCost-aware Review Router用の拡張ポイント）')
  }
}

export function reviewWithSeparation(
  req: Omit<ReviewerRequest, 'reviewerProvider'>,
): Promise<ReviewerResult> {
  const reviewerProvider = selectReviewerProvider(req.implementerProvider)

  // 防御コード: 実装AIとレビューAIが同一になることは設計上あってはならない
  if (reviewerProvider === req.implementerProvider) {
    throw new Error(
      `[reviewerAdapter] 実装AI(${req.implementerProvider})とレビューAI(${reviewerProvider})が同一です。分離ルールに違反しています。`,
    )
  }

  const adapter = createReviewerAdapter(reviewerProvider)
  return adapter.review({ ...req, reviewerProvider })
}

/**
 * ChatGPTレビューへの昇格判定。
 * MVPではChatGPT Reviewer Adapter未実装のため常にfalseを返す。
 * 将来のCost-aware Review Routerで以下の条件を実装する想定:
 *   - approvalLevelResult.level === 3
 *   - approvalLevelResult.requiresChatGptReview === true
 *   - reviewerResult.confidence < 0.5
 *   - Mechanical Gate判定とレビューAI判定が矛盾する場合
 *   - CEOが代替案レビューを明示要求した場合
 */
export function shouldEscalateToChatGpt(
  approvalLevelResult: ApprovalLevelResult,
  reviewerResult: ReviewerResult,
): boolean {
  void approvalLevelResult
  void reviewerResult
  return false
}
