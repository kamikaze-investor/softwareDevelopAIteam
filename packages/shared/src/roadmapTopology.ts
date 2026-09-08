/**
 * Whole-Roadmap の生成者と最終レビュアーを**1か所で**決める。
 *
 * 生成はAPI側（`roadmapGenerator.ts`）、レビューはWorker側（`strategicReview.ts`）で
 * 実行されるので、両者が別々に provider を決めていると、片方だけ変更したときに
 * 「生成したAIが自分の成果物を最終承認する」構成へ静かに滑り込む。
 * 分離判定は**ここに書かれた実設定から**導出する。
 */
import { assertGeneratorSeparatedFromFinalReviewer } from './reviewSeparation'

/** Roadmapを生成するprovider。 */
export const ROADMAP_GENERATOR_PROVIDER = 'codex'

/**
 * Roadmapの最終統合レビューを行うprovider。
 * roadmap kind では旧Codex independent reviewは実行しない（generatorと同一vendorになるため）。
 */
export const ROADMAP_FINAL_REVIEWER_PROVIDER = 'claude'

/**
 * 生成と最終レビューが別vendorであることを強制する（fail-closed）。
 *
 * **モデルを呼ぶ前に実行すること。** 設定ミスに気付くのが生成後だと、
 * 最上位モデルの実行枠を無駄に消費したうえで捨てることになる。
 */
export function assertRoadmapTopologySeparated(): void {
  assertGeneratorSeparatedFromFinalReviewer(
    ROADMAP_GENERATOR_PROVIDER,
    ROADMAP_FINAL_REVIEWER_PROVIDER,
  )
}
