import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalLevelResult } from '@ai-team/shared'

// callGeminiWithFallback だけを差し替え、AGY_* モデル定数など他の export は実物を使う
// （定数を落とすと呼び出し元の `...AGY_LIGHT_MODEL` が undefined 展開で壊れる）。
vi.mock('../metaReviewer/geminiRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metaReviewer/geminiRouter.js')>()),
  callGeminiWithFallback: vi.fn(),
}))

import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'
import { runPostReview } from './postReviewer.js'
import type { PostReviewInput, PostReviewResult } from './postReviewer.js'
import type { ReviewVerdict } from './reviewerAdapter.js'
import type { SafetyVerificationInput } from './safetyVerifier.js'

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)

type SafetyAlignmentVerdict = NonNullable<SafetyVerificationInput['postReviewAlignmentVerdict']>

function makeApprovalLevelResult(overrides: Partial<ApprovalLevelResult> = {}): ApprovalLevelResult {
  const level = overrides.level ?? 2

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    level,
    confidence: 0.9,
    mechanicalGate: {
      triggered: false,
      hits: [],
    },
    classifierResult: {
      level,
      confidence: 0.9,
      reasons: [],
      needsEscalation: false,
      reviewPolicy: 'full_pre_post_review',
    },
    finalReason: 'test fixture',
    decidedAt: '2026-07-01T00:00:00.000Z',
    requiresChatGptReview: false,
    reviewPolicy: 'full_pre_post_review',
    ...overrides,
  }
}

function makeInput(overrides: Partial<PostReviewInput> = {}): PostReviewInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    implementerProvider: 'codex',
    approvalLevelResult: makeApprovalLevelResult(),
    diffText: '+export const reviewed = true',
    changedFiles: ['apps/worker/src/approvalLevel/postReviewer.ts'],
    purposeSummary: '実装目的とdiffの整合を別AIで確認する',
    ...overrides,
  }
}

function reviewerJson(verdict: ReviewVerdict): string {
  return JSON.stringify({
    verdict,
    summary: `post review ${verdict}`,
    issues: [{ severity: 'warning', description: 'post review issue' }],
    confidence: 0.75,
  })
}

function acceptSafetyAlignmentVerdict(value: SafetyAlignmentVerdict): SafetyAlignmentVerdict {
  return value
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runPostReview', () => {
  it('Gemini が approved を返すと alignmentVerdict:aligned, blocked:false', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result = await runPostReview(makeInput())

    expect(result.alignmentVerdict).toBe('aligned')
    expect(result.blocked).toBe(false)
    expect(result.reviewerResult.verdict).toBe('approved')
    expect(result.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('Gemini が changes_requested を返すと alignmentVerdict:unknown, blocked:false（safetyVerifierではunknownがblocking:true）', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('changes_requested'))

    const result = await runPostReview(makeInput())

    expect(result.alignmentVerdict).toBe('unknown')
    expect(result.blocked).toBe(false)
    expect(result.reviewerResult.verdict).toBe('changes_requested')
  })

  it('Gemini が blocking を返すと alignmentVerdict:misaligned, blocked:true', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('blocking'))

    const result = await runPostReview(makeInput())

    expect(result.alignmentVerdict).toBe('misaligned')
    expect(result.blocked).toBe(true)
    expect(result.reviewerResult.verdict).toBe('blocking')
  })

  it('Gemini 呼び出しが例外をthrowすると fail closed で misaligned かつ blocked:true', async () => {
    mockCallGeminiWithFallback.mockRejectedValue(new Error('quota exhausted'))

    const result = await runPostReview(makeInput())

    expect(result.alignmentVerdict).toBe('misaligned')
    expect(result.blocked).toBe(true)
    expect(result.reviewerResult.verdict).toBe('blocking')
    expect(result.reviewerResult.confidence).toBe(0)
  })

  it('PostReviewResult.alignmentVerdict は safetyVerifier と互換の3値のみ', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result: PostReviewResult = await runPostReview(makeInput())
    const compatibleValue = acceptSafetyAlignmentVerdict(result.alignmentVerdict)
    const allowedValues: SafetyAlignmentVerdict[] = ['aligned', 'misaligned', 'unknown']

    expect(allowedValues).toContain(compatibleValue)
    expect(allowedValues).toHaveLength(3)
  })

  it('Gemini には approval-level-post-review の featureName で依頼する', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    await runPostReview(makeInput())

    expect(mockCallGeminiWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('これは実装後のdiffレビューです'),
      { featureName: 'approval-level-post-review' },
    )
  })
})
