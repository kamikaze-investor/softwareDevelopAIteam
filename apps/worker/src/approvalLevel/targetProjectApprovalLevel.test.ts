import { describe, expect, it } from 'vitest'
import type { TargetProjectRiskScanResult } from './targetProjectRiskScan.js'
import { deriveTargetProjectApprovalLevel } from './targetProjectApprovalLevel.js'
import { evaluateCommitGate } from './commitGate.js'
import type { CommitGateInput } from './commitGate.js'
import type { ApprovalLevelResult, ReviewPolicy } from '@ai-team/shared'
import type {
  SafetyCheckId,
  SafetyCheckResult,
  SafetyVerificationResult,
} from './safetyVerifier.js'
import type { PostReviewResult } from './postReviewer.js'
import type { ReviewerResult } from './reviewerAdapter.js'

function makeRiskScanResult(
  overrides: Partial<TargetProjectRiskScanResult> = {},
): TargetProjectRiskScanResult {
  return {
    hasRisk: false,
    issues: [],
    scannedAt: '2026-08-25T00:00:00.000Z',
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

function makePassingSafetyVerificationResult(
  overrides: Partial<SafetyVerificationResult> = {},
): SafetyVerificationResult {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    overallPassed: true,
    checks: [makeSafetyCheck('TYPECHECK', true)],
    blockingFailures: [],
    verifiedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

function makePostReviewResult(
  overrides: Partial<PostReviewResult> = {},
): PostReviewResult {
  const blocked = overrides.blocked ?? false

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    reviewerResult: {
      provider: 'gemini',
      phase: 'post',
      verdict: blocked ? 'blocking' : 'approved',
      summary: `post review ${blocked ? 'blocking' : 'approved'}`,
      issues: [],
      confidence: 0.8,
      generatedAt: '2026-08-25T00:00:00.000Z',
      rawResponse: '{}',
    } as ReviewerResult,
    alignmentVerdict: blocked ? 'misaligned' : 'aligned',
    blocked,
    decidedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('deriveTargetProjectApprovalLevel', () => {
  describe('4 severity tiers の mapping', () => {
    it('highestSeverity undefined（リスクなし）→ level:0, mechanical_only, confidence:0.9', () => {
      const result = deriveTargetProjectApprovalLevel({
        jobId: 'job-1',
        taskId: 'task-1',
        riskScanResult: makeRiskScanResult(),
      })

      expect(result.level).toBe(0)
      expect(result.reviewPolicy).toBe('mechanical_only')
      expect(result.confidence).toBe(0.9)
      expect(result.requiresChatGptReview).toBe(false)
      expect(result.mechanicalGate).toEqual({ triggered: false, hits: [] })
      expect(result.classifierResult.reasons[0]?.rule).toBe('TARGET_PROJECT_RISK_SCAN_CLEAN')
      expect(result.finalReason).toContain('リスクなし')
    })

    it('highestSeverity low → level:1, light_ai_post_review, confidence:0.85', () => {
      const result = deriveTargetProjectApprovalLevel({
        jobId: 'job-1',
        taskId: 'task-1',
        riskScanResult: makeRiskScanResult({
          hasRisk: true,
          highestSeverity: 'low',
          issues: [
            {
              id: 'TEST_SKIP_ADDED',
              label: 'テストスキップの追加',
              detail: 'テストスキップ',
              evidence: ['+// @ts-ignore'],
              severity: 'low',
            },
          ],
        }),
      })

      expect(result.level).toBe(1)
      expect(result.reviewPolicy).toBe('light_ai_post_review')
      expect(result.confidence).toBe(0.85)
      expect(result.requiresChatGptReview).toBe(false)
      expect(result.classifierResult.reasons[0]?.rule).toBe('TARGET_PROJECT_RISK_SCAN_TEST_SKIP_ADDED')
    })

    it('highestSeverity medium → level:2, full_pre_post_review, confidence:0.95', () => {
      const result = deriveTargetProjectApprovalLevel({
        jobId: 'job-1',
        taskId: 'task-1',
        riskScanResult: makeRiskScanResult({
          hasRisk: true,
          highestSeverity: 'medium',
          issues: [
            {
              id: 'ENV_FILE_CHANGED',
              label: '秘密情報ファイル（.env）の変更',
              detail: '.env が変更されています',
              evidence: ['.env'],
              severity: 'medium',
            },
          ],
        }),
      })

      expect(result.level).toBe(2)
      expect(result.reviewPolicy).toBe('full_pre_post_review')
      expect(result.confidence).toBe(0.95)
      expect(result.requiresChatGptReview).toBe(false)
      expect(result.classifierResult.needsEscalation).toBe(false)
    })

    it('highestSeverity high → level:3, ceo_required, confidence:1.0', () => {
      const result = deriveTargetProjectApprovalLevel({
        jobId: 'job-1',
        taskId: 'task-1',
        riskScanResult: makeRiskScanResult({
          hasRisk: true,
          highestSeverity: 'high',
          issues: [
            {
              id: 'HARDCODED_SECRET_ADDED',
              label: 'ハードコードされた秘密情報の追加',
              detail: 'APIキー等が追加されています',
              evidence: ['+const API_KEY = "sk-..."'],
              severity: 'high',
            },
          ],
        }),
      })

      expect(result.level).toBe(3)
      expect(result.reviewPolicy).toBe('ceo_required')
      expect(result.confidence).toBe(1.0)
      expect(result.requiresChatGptReview).toBe(true)
      expect(result.classifierResult.needsEscalation).toBe(true)
      expect(result.classifierResult.escalationReason).toContain('CEO承認が必要')
    })
  })

  it('jobId / taskId が正しく渡される', () => {
    const result = deriveTargetProjectApprovalLevel({
      jobId: 'job-abc',
      taskId: 'task-xyz',
      riskScanResult: makeRiskScanResult(),
    })

    expect(result.jobId).toBe('job-abc')
    expect(result.taskId).toBe('task-xyz')
    expect(result.classifierResult.level).toBe(result.level)
    expect(result.classifierResult.reviewPolicy).toBe(result.reviewPolicy)
  })

  it('複数issuesがある場合、最も高いseverityが使われる', () => {
    const result = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult({
        hasRisk: true,
        highestSeverity: 'medium',
        issues: [
          {
            id: 'TEST_SKIP_ADDED',
            label: 'テストスキップ',
            detail: 'テストスキップ',
            evidence: [],
            severity: 'low',
          },
          {
            id: 'ENV_FILE_CHANGED',
            label: '.env変更',
            detail: '.env変更',
            evidence: ['.env'],
            severity: 'medium',
          },
        ],
      }),
    })

    expect(result.level).toBe(2)
    expect(result.reviewPolicy).toBe('full_pre_post_review')
  })

  it('classifierResult.reasons に各issueが反映される', () => {
    const result = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult({
        hasRisk: true,
        highestSeverity: 'low',
        issues: [
          {
            id: 'EMPTY_CATCH_ADDED',
            label: '空catchブロック',
            detail: '空catch',
            evidence: ['catch {}'],
            severity: 'low',
          },
        ],
      }),
    })

    expect(result.classifierResult.reasons).toHaveLength(1)
    expect(result.classifierResult.reasons[0]?.rule).toBe('TARGET_PROJECT_RISK_SCAN_EMPTY_CATCH_ADDED')
    expect(result.classifierResult.reasons[0]?.detail).toContain('low')
  })
})

describe('deriveTargetProjectApprovalLevel → evaluateCommitGate 統合', () => {
  function makeCommitGateInput(
    reviewPolicy: ReviewPolicy,
    approvalLevelResult: ApprovalLevelResult,
    overrides: Partial<CommitGateInput> = {},
  ): CommitGateInput {
    return {
      jobId: approvalLevelResult.jobId,
      taskId: approvalLevelResult.taskId,
      approvalLevelResult,
      ...overrides,
    }
  }

  it('no-risk → mechanical_only: approvalLevelResult + safetyVerificationResult のみで allowed:true（post-review不要）', () => {
    const approvalLevelResult = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult(),
    })

    const gateResult = evaluateCommitGate(makeCommitGateInput('mechanical_only', approvalLevelResult, {
      safetyVerificationResult: makePassingSafetyVerificationResult(),
    }))

    expect(gateResult.allowed).toBe(true)
    expect(gateResult.reviewPolicy).toBe('mechanical_only')
    expect(gateResult.blockingReasons).toEqual([])
  })

  it('low → light_ai_post_review: post-review + safety で allowed:true', () => {
    const approvalLevelResult = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult({
        hasRisk: true,
        highestSeverity: 'low',
        issues: [
          {
            id: 'TEST_SKIP_ADDED',
            label: 'テストスキップ',
            detail: 'テストスキップ',
            evidence: [],
            severity: 'low',
          },
        ],
      }),
    })

    const gateResult = evaluateCommitGate(makeCommitGateInput('light_ai_post_review', approvalLevelResult, {
      postReviewResult: makePostReviewResult(),
      safetyVerificationResult: makePassingSafetyVerificationResult(),
    }))

    expect(gateResult.allowed).toBe(true)
    expect(gateResult.reviewPolicy).toBe('light_ai_post_review')
  })

  it('low → light_ai_post_review: post-review なしでは allowed:false（成果物欠落）', () => {
    const approvalLevelResult = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult({
        hasRisk: true,
        highestSeverity: 'low',
        issues: [
          {
            id: 'TEST_SKIP_ADDED',
            label: 'テストスキップ',
            detail: 'テストスキップ',
            evidence: [],
            severity: 'low',
          },
        ],
      }),
    })

    const gateResult = evaluateCommitGate(makeCommitGateInput('light_ai_post_review', approvalLevelResult, {
      safetyVerificationResult: makePassingSafetyVerificationResult(),
    }))

    expect(gateResult.allowed).toBe(false)
    expect(gateResult.blockingReasons.some(r => r.includes('POST_REVIEW_RESULT'))).toBe(true)
  })

  it('medium → full_pre_post_review: 全4成果物が必要。pre+post+safety で allowed:true', () => {
    const approvalLevelResult = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult({
        hasRisk: true,
        highestSeverity: 'medium',
        issues: [
          {
            id: 'ENV_FILE_CHANGED',
            label: '.env変更',
            detail: '.env変更',
            evidence: ['.env'],
            severity: 'medium',
          },
        ],
      }),
    })

    const gateResult = evaluateCommitGate(makeCommitGateInput('full_pre_post_review', approvalLevelResult, {
      preReviewResult: undefined,
      postReviewResult: makePostReviewResult(),
      safetyVerificationResult: makePassingSafetyVerificationResult(),
    }))

    // preReviewResult が undefined のため成果物欠落で blocked
    expect(gateResult.allowed).toBe(false)
    expect(gateResult.blockingReasons.some(r => r.includes('PRE_REVIEW_RESULT'))).toBe(true)
  })

  it('high → ceo_required: 何を渡しても always blocked', () => {
    const approvalLevelResult = deriveTargetProjectApprovalLevel({
      jobId: 'job-1',
      taskId: 'task-1',
      riskScanResult: makeRiskScanResult({
        hasRisk: true,
        highestSeverity: 'high',
        issues: [
          {
            id: 'HARDCODED_SECRET_ADDED',
            label: 'ハードコード秘密情報',
            detail: 'APIキー追加',
            evidence: ['+const API_KEY = "sk-..."'],
            severity: 'high',
          },
        ],
      }),
    })

    const gateResult = evaluateCommitGate(makeCommitGateInput('ceo_required', approvalLevelResult, {
      preReviewResult: undefined,
      postReviewResult: makePostReviewResult(),
      safetyVerificationResult: makePassingSafetyVerificationResult(),
    }))

    expect(gateResult.allowed).toBe(false)
    expect(gateResult.reviewPolicy).toBe('ceo_required')
    expect(gateResult.blockingReasons.some(r => r.includes('ceo_required'))).toBe(true)
  })
})
