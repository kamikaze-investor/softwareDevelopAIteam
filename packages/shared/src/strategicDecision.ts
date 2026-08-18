/**
 * Strategic Review の最終判定ロジック（pure）。
 *
 * ここに置く理由は「設計上きれい」だからではない。API（Control Plane）がレビュー実行者の
 * 自己申告を採用せず自前で判定を再計算する必要がある一方、実装元の
 * `apps/worker/src/metaReviewer/strategicReview.ts` は geminiRouter（CLI spawn）や
 * reviewerAdapter（codex CLI）を芋づるでimportするため、そのままAPIからimportすると
 * Worker側のprovider/CLI機構がAPI runtimeへ入ってしまう。
 *
 * そこで判定に必要なpure関数だけをここへ切り出し、API・Worker双方から再利用する。
 * 副作用・I/O・node固有APIへの依存を持ち込まないこと（React Native bundleにも載るため）。
 */

import type {
  FocusedReviewResult,
  IndependentReviewOutcome,
  IntegrationReviewResult,
  StrategicDecision,
} from './types/meta_review'

/** Focused / Integration の各判定から最終判定を決める。1つでもCONFLICTがあればCONFLICT。 */
export function resolveFinalDecision(
  focusedReviewResults: readonly FocusedReviewResult[],
  integrationReviewResult?: IntegrationReviewResult,
): StrategicDecision {
  const decisions = [
    ...focusedReviewResults.map((result) => result.decision),
    ...(integrationReviewResult ? [integrationReviewResult.decision] : []),
  ]

  if (decisions.includes('CONFLICT')) {
    return 'CONFLICT'
  }

  if (decisions.length === 0 || decisions.includes('UNCERTAIN')) {
    return 'UNCERTAIN'
  }

  return 'ALIGNED'
}

/** CRITICAL時のIndependent Reviewで最終判定を上書きする（安全側にのみ倒す）。 */
export function applyIndependentReviewOverride(
  baseDecision: StrategicDecision | 'REVIEW_UNAVAILABLE',
  outcome: IndependentReviewOutcome,
): StrategicDecision | 'REVIEW_UNAVAILABLE' {
  if (outcome.unavailable) {
    return 'REVIEW_UNAVAILABLE'
  }

  if (outcome.verdict === 'blocking') {
    return 'CONFLICT'
  }

  if (outcome.verdict === 'changes_requested' && baseDecision === 'ALIGNED') {
    return 'UNCERTAIN'
  }

  return baseDecision
}
