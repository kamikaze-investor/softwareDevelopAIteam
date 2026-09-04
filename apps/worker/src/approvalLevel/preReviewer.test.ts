import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalLevelResult } from '@ai-team/shared'

// callGeminiWithFallback だけを差し替え、AGY_* モデル定数など他の export は実物を使う
// （定数を落とすと呼び出し元の `...AGY_LIGHT_MODEL` が undefined 展開で壊れる）。
vi.mock('../metaReviewer/geminiRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metaReviewer/geminiRouter.js')>()),
  callGeminiWithFallback: vi.fn(),
}))

import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'
import { runPreReview } from './preReviewer.js'
import type { PreReviewInput } from './preReviewer.js'
import type { ReviewVerdict } from './reviewerAdapter.js'

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)

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

function makeInput(overrides: Partial<PreReviewInput> = {}): PreReviewInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    implementerProvider: 'codex',
    approvalLevelResult: makeApprovalLevelResult(),
    planText: 'reviewerAdapter.ts を追加する',
    targetFiles: ['apps/worker/src/approvalLevel/reviewerAdapter.ts'],
    purposeSummary: 'Level2以上の実装前レビューを分離AIで実行する',
    ...overrides,
  }
}

function reviewerJson(verdict: ReviewVerdict): string {
  return JSON.stringify({
    verdict,
    summary: `pre review ${verdict}`,
    issues: [{ severity: 'info', description: 'pre review issue' }],
    confidence: 0.7,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runPreReview', () => {
  it('Gemini が approved を返すと blocked:false', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result = await runPreReview(makeInput())

    expect(result.blocked).toBe(false)
    expect(result.reviewerResult.verdict).toBe('approved')
    expect(result.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('Gemini が changes_requested を返すと Level2以上の fail closed 仕様で blocked:true', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('changes_requested'))

    const result = await runPreReview(makeInput())

    expect(result.blocked).toBe(true)
    expect(result.reviewerResult.verdict).toBe('changes_requested')
  })

  it('Gemini が blocking を返すと blocked:true', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('blocking'))

    const result = await runPreReview(makeInput())

    expect(result.blocked).toBe(true)
    expect(result.reviewerResult.verdict).toBe('blocking')
  })

  it('Gemini 呼び出しが例外をthrowすると verdict:blocking になり blocked:true', async () => {
    mockCallGeminiWithFallback.mockRejectedValue(new Error('quota exhausted'))

    const result = await runPreReview(makeInput())

    expect(result.blocked).toBe(true)
    expect(result.reviewerResult.verdict).toBe('blocking')
    expect(result.reviewerResult.confidence).toBe(0)
  })

  it('PreReviewResult.reviewerResult に元の ReviewerResult がそのまま含まれる', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const result = await runPreReview(makeInput({
      jobId: 'job-keep',
      taskId: 'task-keep',
    }))

    expect(result.jobId).toBe('job-keep')
    expect(result.taskId).toBe('task-keep')
    expect(result.reviewerResult).toMatchObject({
      provider: 'gemini',
      phase: 'pre',
      verdict: 'approved',
      summary: 'pre review approved',
      issues: [{ severity: 'info', description: 'pre review issue' }],
      confidence: 0.7,
    })
  })

  it('Gemini には approval-level-pre-review の featureName で依頼する', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    await runPreReview(makeInput())

    expect(mockCallGeminiWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('これは実装前の変更計画レビューです'),
      { featureName: 'approval-level-pre-review' },
    )
  })
})
