import type { ApprovalLevelResult } from '@ai-team/shared'
import { reviewWithSeparation } from './reviewerAdapter.js'
import type {
  ImplementerProvider,
  ReviewerResult,
  ReviewVerdict,
} from './reviewerAdapter.js'
import type { SafetyVerificationInput } from './safetyVerifier.js'

type PostReviewAlignmentVerdict = NonNullable<SafetyVerificationInput['postReviewAlignmentVerdict']>

export interface PostReviewInput {
  jobId: string
  taskId: string
  implementerProvider: ImplementerProvider
  approvalLevelResult: ApprovalLevelResult
  diffText: string
  changedFiles: string[]
  purposeSummary: string
}

export interface PostReviewResult {
  jobId: string
  taskId: string
  reviewerResult: ReviewerResult
  /**
   * safetyVerifier.ts の SafetyVerificationInput.postReviewAlignmentVerdict に
   * そのまま渡せる値。型を完全一致させること。
   */
  alignmentVerdict: PostReviewAlignmentVerdict
  /**
   * verdict==='blocking'の場合のみtrue。
   * 注意: alignmentVerdict==='unknown'（changes_requestedの場合含む）はここではblocked:falseだが、
   * safetyVerifier.ts の checkPurposeDiffAlignment() が unknown を fail closed で
   * blocking:true として扱うため、最終的にcommitは止まる。
   * この postReviewer 単体の blocked は「レビュー呼び出し自体が致命的に失敗したか」を示すに留まる。
   */
  blocked: boolean
  decidedAt: string
}

export async function runPostReview(input: PostReviewInput): Promise<PostReviewResult> {
  void input.approvalLevelResult

  const reviewerResult = await reviewWithSeparation({
    jobId: input.jobId,
    subjectId: input.taskId,
    taskId: input.taskId,
    implementerProvider: input.implementerProvider,
    phase: 'post',
    diffText: input.diffText,
    purposeSummary: input.purposeSummary,
    targetFiles: input.changedFiles,
  })

  const alignmentVerdict = toAlignmentVerdict(reviewerResult.verdict)
  const blocked = reviewerResult.verdict === 'blocking'

  return {
    jobId: input.jobId,
    taskId: input.taskId,
    reviewerResult,
    alignmentVerdict,
    blocked,
    decidedAt: new Date().toISOString(),
  }
}

/**
 * ReviewerResult.verdict を safetyVerifier 向けの alignmentVerdict に変換する。
 *   approved            → aligned
 *   changes_requested    → unknown
 *     （safetyVerifier.checkPurposeDiffAlignment()はunknownをfail closedで
 *       blocking:trueとして扱うため、changes_requestedが出た場合は
 *       最終的にcommitが止まる仕様である。これは意図的な設計。）
 *   blocking             → misaligned
 */
function toAlignmentVerdict(verdict: ReviewVerdict): PostReviewAlignmentVerdict {
  switch (verdict) {
    case 'approved':
      return 'aligned'
    case 'changes_requested':
      return 'unknown'
    case 'blocking':
      return 'misaligned'
  }
}
