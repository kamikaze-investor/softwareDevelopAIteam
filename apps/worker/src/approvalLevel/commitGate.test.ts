import { describe, expect, it } from 'vitest'
import type { ApprovalLevelResult, ApprovalLevel, ReviewPolicy } from '@ai-team/shared'
import {
  checkArtifactPresence,
  evaluateCommitGate,
  getRequiredArtifacts,
} from './commitGate.js'
import type { CommitGateInput, RequiredArtifactId } from './commitGate.js'
import type { PreReviewResult } from './preReviewer.js'
import type { PostReviewResult } from './postReviewer.js'
import type { ReviewerResult, ReviewPhase, ReviewVerdict } from './reviewerAdapter.js'
import type {
  SafetyCheckId,
  SafetyCheckResult,
  SafetyVerificationResult,
} from './safetyVerifier.js'

function levelForPolicy(reviewPolicy: ReviewPolicy): ApprovalLevel {
  switch (reviewPolicy) {
    case 'mechanical_only':
      return 0
    case 'light_ai_post_review':
      return 1
    case 'full_pre_post_review':
      return 2
    case 'ceo_required':
      return 3
  }
}

function makeApprovalLevelResult(
  reviewPolicy: ReviewPolicy = 'full_pre_post_review',
  overrides: Partial<ApprovalLevelResult> = {},
): ApprovalLevelResult {
  const level = overrides.level ?? levelForPolicy(reviewPolicy)

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
      reviewPolicy,
    },
    finalReason: 'test fixture',
    decidedAt: '2026-07-01T00:00:00.000Z',
    requiresChatGptReview: false,
    reviewPolicy,
    ...overrides,
  }
}

function makeSafetyCheck(
  id: SafetyCheckId,
  passed: boolean,
): SafetyCheckResult {
  return {
    id,
    passed,
    blocking: true,
    detail: passed ? `${id} passed` : `${id} failed`,
  }
}

function makeSafetyVerificationResult(
  overrides: Partial<SafetyVerificationResult> = {},
): SafetyVerificationResult {
  const blockingFailures = overrides.blockingFailures ?? []
  const overallPassed = overrides.overallPassed ?? blockingFailures.length === 0

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    overallPassed,
    checks: [
      makeSafetyCheck('TYPECHECK', true),
      ...blockingFailures.map(id => makeSafetyCheck(id, false)),
    ],
    blockingFailures,
    verifiedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeReviewerResult(
  phase: ReviewPhase,
  verdict: ReviewVerdict,
): ReviewerResult {
  return {
    provider: 'gemini',
    phase,
    verdict,
    summary: `${phase} ${verdict}`,
    issues: [],
    confidence: 0.8,
    generatedAt: '2026-07-01T00:00:00.000Z',
    rawResponse: '{}',
  }
}

function makePreReviewResult(overrides: Partial<PreReviewResult> = {}): PreReviewResult {
  const blocked = overrides.blocked ?? false

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    reviewerResult: makeReviewerResult('pre', blocked ? 'blocking' : 'approved'),
    blocked,
    decidedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makePostReviewResult(overrides: Partial<PostReviewResult> = {}): PostReviewResult {
  const blocked = overrides.blocked ?? false

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    reviewerResult: makeReviewerResult('post', blocked ? 'blocking' : 'approved'),
    alignmentVerdict: blocked ? 'misaligned' : 'aligned',
    blocked,
    decidedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeInput(
  reviewPolicy: ReviewPolicy,
  overrides: Partial<CommitGateInput> = {},
): CommitGateInput {
  const approvalLevelResult =
    overrides.approvalLevelResult ?? makeApprovalLevelResult(reviewPolicy)

  return {
    jobId: 'job-1',
    taskId: 'task-1',
    approvalLevelResult,
    ...overrides,
  }
}

function expectBlockingReasonContaining(result: { blockingReasons: string[] }, value: string): void {
  expect(result.blockingReasons.some(reason => reason.includes(value))).toBe(true)
}

describe('getRequiredArtifacts', () => {
  it('mechanical_only は approval-level-result のみを必須にする（Phase 1c: safety-verification-result は不要）', () => {
    expect(getRequiredArtifacts('mechanical_only')).toEqual([
      'APPROVAL_LEVEL_RESULT',
    ])
  })

  it('light_ai_post_review は approval-level-result と post-review-result を必須にする（Phase 1c: safety-verification-result は不要）', () => {
    expect(getRequiredArtifacts('light_ai_post_review')).toEqual([
      'APPROVAL_LEVEL_RESULT',
      'POST_REVIEW_RESULT',
    ])
  })

  it('full_pre_post_review は approval-level-result と post-review-result のみを必須にする（Phase 1c: pre/safety は不要）', () => {
    expect(getRequiredArtifacts('full_pre_post_review')).toEqual([
      'APPROVAL_LEVEL_RESULT',
      'POST_REVIEW_RESULT',
    ])
  })

  it('ceo_required は成果物リストではなく別の無条件blockingで扱うため空配列を返す', () => {
    expect(getRequiredArtifacts('ceo_required')).toEqual([])
  })
})

describe('checkArtifactPresence', () => {
  it('required:true かつ実際に存在する場合は present:true を返す', () => {
    const input = makeInput('full_pre_post_review', {
      preReviewResult: makePreReviewResult(),
    })

    const result = checkArtifactPresence(
      'PRE_REVIEW_RESULT',
      input,
      ['PRE_REVIEW_RESULT'],
    )

    expect(result).toMatchObject({
      id: 'PRE_REVIEW_RESULT',
      present: true,
      required: true,
    })
  })

  it('required:true かつ実際に存在しない場合は present:false を返す', () => {
    const input = makeInput('full_pre_post_review')

    const result = checkArtifactPresence(
      'POST_REVIEW_RESULT',
      input,
      ['POST_REVIEW_RESULT'],
    )

    expect(result).toMatchObject({
      id: 'POST_REVIEW_RESULT',
      present: false,
      required: true,
    })
  })

  it('required:false の不要な成果物は present:true として欠落扱いしない', () => {
    const input = makeInput('mechanical_only')

    const result = checkArtifactPresence(
      'PRE_REVIEW_RESULT',
      input,
      ['APPROVAL_LEVEL_RESULT', 'SAFETY_VERIFICATION_RESULT'],
    )

    expect(result).toMatchObject({
      id: 'PRE_REVIEW_RESULT',
      present: true,
      required: false,
    })
  })
})

describe('evaluateCommitGate', () => {
  it('mechanical_only は approval-level-result のみで allowed:true（Phase 1c: safety不要）', () => {
    const result = evaluateCommitGate(makeInput('mechanical_only'))

    expect(result.allowed).toBe(true)
    expect(result.artifactChecks.find(check => check.id === 'PRE_REVIEW_RESULT')).toMatchObject({
      required: false,
      present: true,
    })
    expect(result.artifactChecks.find(check => check.id === 'POST_REVIEW_RESULT')).toMatchObject({
      required: false,
      present: true,
    })
    expect(result.artifactChecks.find(check => check.id === 'SAFETY_VERIFICATION_RESULT')).toMatchObject({
      required: false,
      present: true,
    })
  })

  it('mechanical_only で approvalLevelResult が存在し safetyVerificationResult渡しても allowed:true（両方不要）', () => {
    const result = evaluateCommitGate(makeInput('mechanical_only', {
      safetyVerificationResult: makeSafetyVerificationResult(),
    }))

    expect(result.allowed).toBe(true)
  })

  it('light_ai_post_review は post-review-result のみで allowed:true（Phase 1c: safety不要）', () => {
    const result = evaluateCommitGate(makeInput('light_ai_post_review', {
      postReviewResult: makePostReviewResult(),
    }))

    expect(result.allowed).toBe(true)
    expect(result.artifactChecks.find(check => check.id === 'PRE_REVIEW_RESULT')).toMatchObject({
      required: false,
      present: true,
    })
    expect(result.artifactChecks.find(check => check.id === 'SAFETY_VERIFICATION_RESULT')).toMatchObject({
      required: false,
      present: true,
    })
  })

  it('light_ai_post_review で post-review-result が欠落している場合は allowed:false', () => {
    const result = evaluateCommitGate(makeInput('light_ai_post_review', {}))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'POST_REVIEW_RESULT')
  })

  it('full_pre_post_review は approval-level-result と post-review-result のみで allowed:true（Phase 1c: pre/safety不要）', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      postReviewResult: makePostReviewResult(),
    }))

    expect(result.allowed).toBe(true)
  })

  it('full_pre_post_review で post-review-result が欠落している場合は allowed:false', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {}))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'POST_REVIEW_RESULT')
  })

  it('full_pre_post_review で safetyVerificationResult渡しても allowed:true（artifact ではないが overallPassed:false は blocking）', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      postReviewResult: makePostReviewResult(),
      safetyVerificationResult: makeSafetyVerificationResult(),
    }))

    expect(result.allowed).toBe(true)
  })

  it('full_pre_post_review で safetyVerificationResult.overallPassed:false なら blockingFailures を理由に含める（artifact以外のblocking判定）', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      postReviewResult: makePostReviewResult(),
      safetyVerificationResult: makeSafetyVerificationResult({
        overallPassed: false,
        blockingFailures: ['TYPECHECK', 'FULL_TESTS'],
      }),
    }))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'TYPECHECK')
    expectBlockingReasonContaining(result, 'FULL_TESTS')
  })

  it('full_pre_post_review で preReviewResult.blocked:true なら allowed:false（artifact未要求でも渡された場合のblocking判定）', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      preReviewResult: makePreReviewResult({ blocked: true }),
      postReviewResult: makePostReviewResult(),
    }))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'Pre-Review')
  })

  it('full_pre_post_review で postReviewResult.blocked:true なら allowed:false', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      postReviewResult: makePostReviewResult({ blocked: true }),
    }))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'Post-Review')
  })

  it('ceo_required は成果物が揃っていても allowed:false', () => {
    const result = evaluateCommitGate(makeInput('ceo_required', {
      postReviewResult: makePostReviewResult(),
    }))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'ceo_required')
  })

  it('level:3 が ceo_required 以外に誤設定されても level3 の二重防御だけで allowed:false', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      approvalLevelResult: makeApprovalLevelResult('full_pre_post_review', { level: 3 }),
      postReviewResult: makePostReviewResult(),
    }))

    expect(result.allowed).toBe(false)
    expectBlockingReasonContaining(result, 'Level3')
    expect(result.blockingReasons.some(reason => reason.includes('ceo_required'))).toBe(false)
  })

  it('成果物欠落と safety 未通過が同時発生した場合は両方の理由を列挙する', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      safetyVerificationResult: makeSafetyVerificationResult({
        overallPassed: false,
        blockingFailures: ['TYPECHECK'],
      }),
    }))

    expect(result.allowed).toBe(false)
    expect(result.blockingReasons.length).toBeGreaterThanOrEqual(2)
    expectBlockingReasonContaining(result, 'POST_REVIEW_RESULT')
    expectBlockingReasonContaining(result, 'TYPECHECK')
  })

  it('task-023相当の full_pre_post_review で approval-level-result と post-review-result が有効なら allowed:true', () => {
    const result = evaluateCommitGate(makeInput('full_pre_post_review', {
      approvalLevelResult: makeApprovalLevelResult('full_pre_post_review', {
        jobId: 'job-task-023',
        taskId: 'task-023',
      }),
      jobId: 'job-task-023',
      taskId: 'task-023',
      postReviewResult: makePostReviewResult({
        jobId: 'job-task-023',
        taskId: 'task-023',
      }),
    }))

    expect(result).toMatchObject({
      jobId: 'job-task-023',
      taskId: 'task-023',
      allowed: true,
    })
  })

  it('CommitGateResult.reviewPolicy は input.approvalLevelResult.reviewPolicy と一致する', () => {
    const input = makeInput('light_ai_post_review', {
      postReviewResult: makePostReviewResult(),
    })

    const result = evaluateCommitGate(input)

    expect(result.reviewPolicy).toBe(input.approvalLevelResult.reviewPolicy)
  })

  it('artifactChecks は常に4種類を同じ順序で返す', () => {
    const expectedIds: RequiredArtifactId[] = [
      'APPROVAL_LEVEL_RESULT',
      'PRE_REVIEW_RESULT',
      'POST_REVIEW_RESULT',
      'SAFETY_VERIFICATION_RESULT',
    ]

    const result = evaluateCommitGate(makeInput('mechanical_only'))

    expect(result.artifactChecks.map(check => check.id)).toEqual(expectedIds)
  })
})
