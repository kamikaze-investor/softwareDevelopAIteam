/**
 * Meta Review Fallback Router — Gemini API → Gemini CLI → Copilot CLI
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * autoReview.ts から呼ばれる。既存の callGeminiWithFallback()（geminiRouter.ts。
 * API → CLI → quota起因の場合のみ Antigravity/Claude、の既存フォールバック段）は
 * そのまま使い、その**すべて**が quota 起因で尽きて
 * `[geminiRouter] Gemini quota exhausted` が投げられたときだけ Copilot CLI に落ちる。
 * geminiRouter.ts の内部段数はここでは関知しない（投げられたエラー文言だけを見る）。
 *
 * 重要: quota 以外の失敗（プログラムエラー・認証エラー・パースバグ等）は
 * Copilot で隠さない。callGeminiWithFallback が quota 枯渇以外のエラーで
 * 失敗した場合はそのまま re-throw し、autoReview.ts が blocked 扱いにする
 * （従来と同じ挙動）。
 */

import { callGeminiWithFallback, type GeminiRouterOptions } from './geminiRouter.js'
import { callCopilotForMetaReview } from './copilotRouter.js'

export type MetaReviewProvider = 'gemini' | 'copilot'

export interface MetaReviewFallbackResult {
  raw: string
  providerUsed: MetaReviewProvider
}

/** geminiRouter.ts の handleBothExhausted() が投げるエラーメッセージと一致させる */
const GEMINI_BOTH_EXHAUSTED_MARKER = 'Gemini quota exhausted'

function isGeminiBothExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes(GEMINI_BOTH_EXHAUSTED_MARKER)
}

/**
 * Gemini API → Gemini CLI → Copilot CLI の3段フォールバックでレビューを依頼する。
 * Gemini 側が quota 以外の理由で失敗した場合は、Copilot を試さずそのまま失敗させる。
 */
export async function reviewWithProviderFallback(
  prompt: string,
  geminiOptions?: GeminiRouterOptions,
): Promise<MetaReviewFallbackResult> {
  try {
    const raw = await callGeminiWithFallback(prompt, geminiOptions)
    return { raw, providerUsed: 'gemini' }
  } catch (err) {
    if (!isGeminiBothExhausted(err)) {
      throw err
    }

    console.warn(
      '\n⚠️  [metaReviewFallbackRouter] Gemini API・CLI の両方が quota 枯渇。' +
      ' Copilot CLI（Microsoft系モデル）にフォールバックします。'
    )

    const raw = callCopilotForMetaReview(prompt, { usage: 'meta_review' })
    return { raw, providerUsed: 'copilot' }
  }
}
