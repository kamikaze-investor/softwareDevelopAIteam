/**
 * commitGate × reviewer 分離チェーンの統合テスト（Phase 1 Shadow Commit Gate関連）。
 *
 * commitGate.test.ts（純粋関数の網羅）・reviewerAdapter.test.ts（アダプタ単体）で
 * 既にカバーされている分岐の再テストはしない。この ファイルは「実コード経路」で
 * 次を検証するためにのみ存在する:
 *   - 実装AI≠レビューAI（claude_code→gemini / codex→gemini）で reviewWithSeparation が成功し、
 *     evaluateCommitGate が allowed:true になること
 *   - レビューAIの blocking / 呼び出し失敗（quota等）・パース失敗が
 *     PostReviewResult.blocked:true に倒れ、evaluateCommitGate が fail-closed で
 *     allowed:false になること（黙って allowed:true にならないこと）
 *   - レビューAI未実装（implementer=gemini→claude）で runPostReview がthrowし、
 *     jobRunnerと同じcatch経路では postReviewResult がundefinedのままになり、
 *     成果物欠落として allowed:false になること
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalLevelResult } from '@ai-team/shared'

vi.mock('../metaReviewer/geminiRouter.js', () => ({
  callGeminiWithFallback: vi.fn(),
}))

import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'
import { runPostReview } from './postReviewer.js'
import type { PostReviewInput } from './postReviewer.js'
import { evaluateCommitGate } from './commitGate.js'
import type { CommitGateInput } from './commitGate.js'
import type {
  SafetyCheckId,
  SafetyCheckResult,
  SafetyVerificationResult,
} from './safetyVerifier.js'
import type { ReviewVerdict } from './reviewerAdapter.js'

const mockCallGeminiWithFallback = vi.mocked(callGeminiWithFallback)

function makeApprovalLevelResult(
  overrides: Partial<ApprovalLevelResult> = {},
): ApprovalLevelResult {
  const level = overrides.level ?? 1

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
      reviewPolicy: 'light_ai_post_review',
    },
    finalReason: 'test fixture',
    decidedAt: '2026-07-01T00:00:00.000Z',
    requiresChatGptReview: false,
    reviewPolicy: 'light_ai_post_review',
    ...overrides,
  }
}

function makePostReviewInput(
  overrides: Partial<PostReviewInput> = {},
): PostReviewInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    implementerProvider: 'codex',
    approvalLevelResult: makeApprovalLevelResult(),
    diffText: '+export const reviewed = true',
    changedFiles: ['src/feature.ts'],
    purposeSummary: '実装目的とdiffの整合を別AIで確認する',
    ...overrides,
  }
}

function makeSafetyCheck(id: SafetyCheckId, passed: boolean): SafetyCheckResult {
  return {
    id,
    passed,
    blocking: true,
    detail: passed ? `${id} passed` : `${id} failed`,
  }
}

function makePassingSafetyVerificationResult(): SafetyVerificationResult {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    overallPassed: true,
    checks: [makeSafetyCheck('TYPECHECK', true)],
    blockingFailures: [],
    verifiedAt: '2026-07-01T00:00:00.000Z',
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

function makeCommitGateInput(
  overrides: Partial<CommitGateInput> = {},
): CommitGateInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    approvalLevelResult: makeApprovalLevelResult(),
    safetyVerificationResult: makePassingSafetyVerificationResult(),
    ...overrides,
  }
}

/**
 * jobRunner.ts の Step R4-A と同じ catch 経路を再現するヘルパー。
 * runPostReview がthrowした場合、jobRunner は postReviewResult を undefined のまま
 * 後続の shadow gate へ渡す。このヘルパーも同じ契約を模倣する。
 */
async function runPostReviewLikeJobRunner(
  input: PostReviewInput,
): Promise<Awaited<ReturnType<typeof runPostReview>> | undefined> {
  try {
    return await runPostReview(input)
  } catch {
    return undefined
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitGate × reviewer分離チェーン（実コード経路）', () => {
  it('implementer:claude_code → reviewer:gemini の実呼び出しが成功し、light_ai_post_review で allowed:true', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const postReviewResult = await runPostReview(makePostReviewInput({
      implementerProvider: 'claude_code',
    }))
    const result = evaluateCommitGate(makeCommitGateInput({ postReviewResult }))

    expect(postReviewResult.blocked).toBe(false)
    expect(mockCallGeminiWithFallback).toHaveBeenCalledOnce()
    expect(result.allowed).toBe(true)
    expect(result.reviewPolicy).toBe('light_ai_post_review')
    expect(result.blockingReasons).toEqual([])
  })

  it('implementer:codex → reviewer:gemini の実呼び出しが成功し、allowed:true', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    const postReviewResult = await runPostReview(makePostReviewInput({
      implementerProvider: 'codex',
    }))
    const result = evaluateCommitGate(makeCommitGateInput({ postReviewResult }))

    expect(postReviewResult.reviewerResult.provider).toBe('gemini')
    expect(result.allowed).toBe(true)
  })

  it('レビューAIが blocking を返すと PostReviewResult.blocked:true となり allowed:false（Post-Review理由）', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('blocking'))

    const postReviewResult = await runPostReview(makePostReviewInput())
    const result = evaluateCommitGate(makeCommitGateInput({ postReviewResult }))

    expect(postReviewResult.blocked).toBe(true)
    expect(result.allowed).toBe(false)
    expect(result.blockingReasons.some(reason => reason.includes('Post-Review'))).toBe(true)
  })

  it('Gemini呼び出し失敗（quota枯渇等）でも fail-closed で allowed:false（黙って通さない）', async () => {
    mockCallGeminiWithFallback.mockRejectedValue(new Error('quota exhausted'))

    const postReviewResult = await runPostReview(makePostReviewInput())
    const result = evaluateCommitGate(makeCommitGateInput({ postReviewResult }))

    expect(postReviewResult.reviewerResult.verdict).toBe('blocking')
    expect(postReviewResult.blocked).toBe(true)
    expect(result.allowed).toBe(false)
  })

  it('Gemini応答がパース不能でも fail-closed で blocking 扱いとなり allowed:false', async () => {
    mockCallGeminiWithFallback.mockResolvedValue('not json at all')

    const postReviewResult = await runPostReview(makePostReviewInput())
    const result = evaluateCommitGate(makeCommitGateInput({ postReviewResult }))

    expect(postReviewResult.blocked).toBe(true)
    expect(result.allowed).toBe(false)
  })

  it('implementer:gemini → reviewer:claude は未実装のためrunPostReviewがthrowし、成果物欠落で allowed:false', async () => {
    mockCallGeminiWithFallback.mockResolvedValue(reviewerJson('approved'))

    await expect(runPostReview(makePostReviewInput({
      implementerProvider: 'gemini',
    }))).rejects.toThrow('ClaudeReviewerAdapter は未実装です')

    // jobRunner と同じcatch経路: postReviewResult は undefined のまま shadow gate へ渡る
    const postReviewResult = await runPostReviewLikeJobRunner(makePostReviewInput({
      implementerProvider: 'gemini',
    }))

    expect(postReviewResult).toBeUndefined()

    const result = evaluateCommitGate(makeCommitGateInput())

    expect(result.allowed).toBe(false)
    expect(result.artifactChecks.find(check => check.id === 'POST_REVIEW_RESULT')).toMatchObject({
      required: true,
      present: false,
    })
    expect(result.blockingReasons.some(reason => reason.includes('POST_REVIEW_RESULT'))).toBe(true)
  })
})
