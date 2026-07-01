import type { ApprovalLevelResult } from '@ai-team/shared'
import { reviewWithSeparation } from './reviewerAdapter.js'
import type { ImplementerProvider, ReviewerResult } from './reviewerAdapter.js'

export interface PreReviewInput {
  jobId: string
  taskId: string
  implementerProvider: ImplementerProvider
  approvalLevelResult: ApprovalLevelResult
  planText: string
  targetFiles: string[]
  purposeSummary: string
}

export interface PreReviewResult {
  jobId: string
  taskId: string
  reviewerResult: ReviewerResult
  /**
   * 実装フェーズに進めない場合 true。
   * Level 2以上ではchanges_requestedもblocked:trueとする（fail closed）。
   * 理由: Level2は中リスク作業のため、実装前レビューで修正要求が出た状態のまま
   *       自動実装に進むべきではない。
   */
  blocked: boolean
  decidedAt: string
}

/**
 * runPreReview() は Level 1 のタスクに対しては呼び出さない設計とする
 * （Level 1 は postReview のみで十分という方針のため）。
 * この関数自体はLevelを判定しない。呼び出し元（Step6のjobRunner接続時）が
 * ApprovalLevelResult.level >= 2 の場合のみこの関数を呼ぶこと。
 */
export async function runPreReview(input: PreReviewInput): Promise<PreReviewResult> {
  void input.approvalLevelResult

  const reviewerResult = await reviewWithSeparation({
    jobId: input.jobId,
    taskId: input.taskId,
    implementerProvider: input.implementerProvider,
    phase: 'pre',
    planText: input.planText,
    purposeSummary: input.purposeSummary,
    targetFiles: input.targetFiles,
  })

  // Level 2以上: approved以外は全てblocked:true（fail closed）
  // changes_requestedであっても、中リスク作業の実装前レビューで修正要求が
  // 出ている状態のまま実装フェーズへ進めることは許容しない。
  const blocked = reviewerResult.verdict !== 'approved'

  return {
    jobId: input.jobId,
    taskId: input.taskId,
    reviewerResult,
    blocked,
    decidedAt: new Date().toISOString(),
  }
}
