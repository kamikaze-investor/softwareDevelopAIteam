/**
 * Review provider 枯渇後の「別 provider での正式再審査」で、どの provider を使うかを決める純粋関数
 * （roadmap: `review-provider-exhausted-alternate-rereview`）。
 *
 * **ここが決めるのは provider の選択だけである。** 再審査は必ず新しい run として作られ、
 * 判定は API 側の `recomputeDecision()` だけが行う（`apps/api/src/designReview/alternateProviderReview.ts`）。
 *
 * ## 選択の根拠は既存の設定だけ
 *
 * - 候補は `role-model-registry` の `meta_reviewer` entry（有効なもの・配列順）。**候補表を二重に持たない。**
 * - 生成担当は同じ Registry の `implementer` entry から読む。「implementer は Claude のはず」という
 *   前提を定数で持たない（`reviewSeparation.ts` と同じ理由）。
 * - vendor 分離は `isGeneratorSeparatedFromFinalReviewer()` が正本。`copilot` のように vendor を
 *   特定できない provider はここで必ず落ちる（独立性の根拠にできないため）。
 *
 * ## 防いでいる失敗
 *
 * - **同じ provider での再試行を「別 provider」と呼ぶこと** … 既に試した provider は候補から外す。
 * - **provider の無限巡回** … 1つの設計に対する再審査 run の数を `ALTERNATE_PROVIDER_REVIEW_MAX_RUNS` で縛る。
 *   尽きたら選択しない（呼び出し側は CEO Escalation へ倒す）。
 * - **生成担当と同じ vendor による審査** … 分離を確認できない候補は選ばない。
 */

import { isGeneratorSeparatedFromFinalReviewer } from './reviewSeparation'
import { enabledEntriesForRole, type RoleModelRegistryConfig } from './roleModelRegistry'
import type { AiCliProvider } from './types/ai_cli'

/** 1つの設計（Task × designTextHash）に対して作ってよい別 provider 再審査 run の上限。 */
export const ALTERNATE_PROVIDER_REVIEW_MAX_RUNS = 2

/**
 * provider 指定の無い（通常の）Design Review run が使う provider の連鎖。
 *
 * worker 側 `metaReviewFallbackRouter.reviewWithProviderFallback()` の gemini → copilot と同じ並び。
 * 通常 run が attempt を使い切ったなら、この連鎖は既に試されている。ここから外さないと、
 * 「別 provider での再審査」が同じ provider で同じ障害に当たり直すだけになる。
 */
export const DEFAULT_DESIGN_REVIEW_PROVIDER_CHAIN: readonly AiCliProvider[] = Object.freeze(['gemini', 'copilot'])

export interface AlternateReviewProviderSelectionInput {
  /** 既存の Role / Provider / Model Registry。無ければ選択しない（fail-closed）。 */
  registry: RoleModelRegistryConfig | undefined
  /** この設計に対して既に試した provider（通常 run の連鎖を含む）。 */
  triedProviders: readonly string[]
  /** この設計に対して既に作った別 provider 再審査 run の数。 */
  alternateRunsSoFar: number
}

export type AlternateReviewProviderSelection =
  | { ok: true; provider: AiCliProvider; model: string }
  | { ok: false; reason: string }

export function selectAlternateReviewProvider(
  input: AlternateReviewProviderSelectionInput,
): AlternateReviewProviderSelection {
  if (input.alternateRunsSoFar >= ALTERNATE_PROVIDER_REVIEW_MAX_RUNS) {
    return {
      ok: false,
      reason: `alternate provider re-review already ran ${input.alternateRunsSoFar}/${ALTERNATE_PROVIDER_REVIEW_MAX_RUNS} times for this design`,
    }
  }
  if (input.registry === undefined) {
    return { ok: false, reason: 'no role-model registry is configured; no alternate review provider can be selected' }
  }

  // disabled な implementer も生成担当に数える（止めた行を理由に分離条件を緩めない）。
  const generators = input.registry.entries
    .filter((entry) => entry.role === 'implementer')
    .map((entry) => entry.provider)
  if (generators.length === 0) {
    return { ok: false, reason: 'the registry has no implementer entry; review independence cannot be checked' }
  }

  const tried = new Set(input.triedProviders)
  const candidate = enabledEntriesForRole(input.registry, 'meta_reviewer').find((entry) =>
    !tried.has(entry.provider)
    && generators.every((generator) => isGeneratorSeparatedFromFinalReviewer(generator, entry.provider)))

  if (candidate === undefined) {
    return {
      ok: false,
      reason: 'no enabled meta_reviewer entry is both untried for this design and vendor-separated from the implementer',
    }
  }
  return { ok: true, provider: candidate.provider, model: candidate.model }
}
