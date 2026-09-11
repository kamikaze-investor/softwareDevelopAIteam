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

/** `StrategicDecision` として受理してよい値の全体。判定語彙の正本はここ1箇所にする。 */
export const STRATEGIC_DECISIONS = ['ALIGNED', 'CONFLICT', 'UNCERTAIN'] as const

/**
 * 値が有効な `StrategicDecision` かどうか。
 *
 * runner の出力は外部プロセス（LLM + provider CLI）由来であり、型注釈は実行時の保証に
 * ならない。decision 値を採用する側は、enum に対して明示的に検証すること。
 */
export function isStrategicDecision(value: unknown): value is StrategicDecision {
  return typeof value === 'string' && (STRATEGIC_DECISIONS as readonly string[]).includes(value)
}

/**
 * Focused / Integration の各判定から最終判定を決める。
 *
 * 1つでもCONFLICTがあればCONFLICT。**ALIGNED を返すのは、判定が1件以上あり、かつ
 * その全件が厳密に `'ALIGNED'` のときだけ**である。それ以外（空・UNCERTAIN混在・
 * enum外の未知値）はすべて `'UNCERTAIN'` へ倒す。
 *
 * 【なぜ「ALIGNED以外はUNCERTAIN」ではなく「全件ALIGNEDのときだけALIGNED」なのか】
 * 以前の実装は CONFLICT / UNCERTAIN のどちらにも当たらない値を最後に `return 'ALIGNED'` で
 * 拾っていた。有効値は `ALIGNED | CONFLICT | UNCERTAIN` の3つだけだが、decision 値は
 * enum に対して検証されていないため、runner の schema drift・typo・provider 差し替えによる
 * 語彙違い・truncate のいずれでも**未レビュー同然の変更が承認される**（2026-09-10 実測:
 * テストが `decision: 'NOT_ALIGNED'` を返したところ ALIGNED として受理され、design review
 * evidence が登録され implement Job まで作られた）。
 * この出力は design review evidence になり、Job Gate が implement Job の実行可否を
 * 判断する根拠であるため、未知値は fail-closed でなければならない。
 *
 * 有効値のみが渡る場合の結果は従来と完全に同一で、変わるのは未知値の扱いだけである。
 */
export function resolveFinalDecision(
  focusedReviewResults: readonly FocusedReviewResult[],
  integrationReviewResult?: IntegrationReviewResult,
): StrategicDecision {
  const decisions: readonly unknown[] = [
    ...focusedReviewResults.map((result) => result.decision),
    ...(integrationReviewResult ? [integrationReviewResult.decision] : []),
  ]

  if (decisions.includes('CONFLICT')) {
    return 'CONFLICT'
  }

  if (decisions.length === 0) {
    return 'UNCERTAIN'
  }

  return decisions.every((decision) => decision === 'ALIGNED') ? 'ALIGNED' : 'UNCERTAIN'
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
