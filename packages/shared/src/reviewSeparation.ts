/**
 * Generator / Final Reviewer の provider 分離。
 *
 * 生成したAIが自分の成果物を最終承認する構成を禁止する。Roadmapは Project 全体の
 * 骨格を決めるため、生成者と最終判断者が同一だと相関した盲点をそのまま通してしまう。
 *
 * **判定は実際のprovider設定値から行う**。「generatorはCodexのはず」といった前提を
 * 定数で持たない — 前提が古いまま設定だけ変わると、分離しているつもりで自己承認に
 * なっていることに気付けない。
 *
 * **比較はvendor単位で行う**。文字列比較では不十分で、このリポジトリには同じvendorを指す
 * 別名が実在する: implementer側は`claude_code`、reviewer側は`claude`（どちらもAnthropic）。
 * 素朴に比較すると「Claudeが生成してClaudeが最終承認する」構成を分離済みと誤判定する
 * （独立レビュー指摘、2026-09-07）。
 *
 * 新しいGate/Queue/daemonは追加していない。既存の呼び出し経路で使う純粋関数。
 */

/** 相関した盲点を避ける単位。同一vendorのモデル同士は独立した検証にならない。 */
export type ReviewVendor = 'anthropic' | 'openai' | 'google'

/**
 * provider識別子 → vendor。
 *
 * **underlying vendorを断定できる識別子だけを載せる。** 未知の値を黙って通すと、
 * 名前を間違えただけで分離判定をすり抜けてしまうため、解決できない値は fail-closed にする。
 *
 * ここに載っていないものの代表例:
 *
 * - `copilot`: 複数vendor/modelを載せられるharnessであり、識別子だけでは
 *   underlying vendorを特定できない。「github_copilot」という独自vendorとして扱って
 *   他providerと独立と判定するのは**誤り**で、実体がClaudeやGPTなら分離は成立していない
 *   （CEO判断、2026-09-07）。将来Copilotを分離判定へ参加させる場合は、
 *   識別子ではなく**実際のunderlying model/vendorを渡せる設計にしてから**にすること。
 * - OpenCode等のharness、stealth model: 同じ理由で載せない。
 */
const PROVIDER_VENDOR: Readonly<Record<string, ReviewVendor>> = {
  // Anthropic — `claude_code`はCLI harness名、`claude`はreviewer側の名前。同一vendor。
  claude: 'anthropic',
  claude_code: 'anthropic',
  // OpenAI — `codex`はCLI harness名、`chatgpt`は将来のcost-aware review router用の拡張点。
  codex: 'openai',
  chatgpt: 'openai',
  // Google
  gemini: 'google',
}

export class ProviderSeparationError extends Error {
  constructor(
    readonly generatorProvider: string,
    readonly finalReviewerProvider: string,
    readonly reason: 'same_vendor' | 'unknown_provider',
  ) {
    super(
      reason === 'same_vendor'
        ? `[reviewSeparation] Roadmap生成者(${generatorProvider})と最終レビュアー(${finalReviewerProvider})が同一vendorです。`
          + '自分の成果物を自分で最終承認する構成は許可されません。'
        : `[reviewSeparation] provider識別子を解決できません（generator=${generatorProvider} / finalReviewer=${finalReviewerProvider}）。`
          + '未知の識別子は分離を確認できないため拒否します。',
    )
    this.name = 'ProviderSeparationError'
  }
}

/** provider識別子をvendorへ解決する。解決できなければ`undefined`。 */
export function resolveReviewVendor(provider: string): ReviewVendor | undefined {
  return PROVIDER_VENDOR[provider.trim().toLowerCase()]
}

/**
 * 生成者と最終レビュアーが別vendorかを返す。
 * **どちらかが未知の識別子なら`false`**（分離を確認できないものを分離済みと言わない）。
 */
export function isGeneratorSeparatedFromFinalReviewer(
  generatorProvider: string,
  finalReviewerProvider: string,
): boolean {
  const generatorVendor = resolveReviewVendor(generatorProvider)
  const reviewerVendor = resolveReviewVendor(finalReviewerProvider)

  if (generatorVendor === undefined || reviewerVendor === undefined) return false

  return generatorVendor !== reviewerVendor
}

/**
 * 分離していなければ throw する（fail-closed）。
 *
 * 実行前に呼ぶこと。レビュー結果を見てから判定しても、そのレビュー自体が
 * 自己承認だった場合に手遅れになる。
 */
export function assertGeneratorSeparatedFromFinalReviewer(
  generatorProvider: string,
  finalReviewerProvider: string,
): void {
  const generatorVendor = resolveReviewVendor(generatorProvider)
  const reviewerVendor = resolveReviewVendor(finalReviewerProvider)

  if (generatorVendor === undefined || reviewerVendor === undefined) {
    throw new ProviderSeparationError(generatorProvider, finalReviewerProvider, 'unknown_provider')
  }

  if (generatorVendor === reviewerVendor) {
    throw new ProviderSeparationError(generatorProvider, finalReviewerProvider, 'same_vendor')
  }
}
