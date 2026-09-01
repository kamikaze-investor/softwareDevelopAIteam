/**
 * Meta Review Fallback Router — Gemini API → Gemini CLI → Copilot CLI
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * autoReview.ts から呼ばれる。既存の callGeminiWithFallback()（geminiRouter.ts。
 * API → CLI → quota起因の場合のみ Antigravity/Claude、の既存フォールバック段）は
 * そのまま使い、そのすべてが失敗して MetaReviewProviderError が投げられたときだけ
 * Copilot CLI に落ちる。geminiRouter.ts の内部段数はここでは関知しない。
 *
 * 2026-09-01: quota/非quota の2分類を4分類（quota/transient/auth_or_config/unknown）に
 * 拡張したのに合わせ、Copilot フォールバックの判定も文字列マッチ（旧
 * GEMINI_BOTH_EXHAUSTED_MARKER）から MetaReviewProviderError.failureClass の型付きチェックに
 * 変更した。quota・transient（geminiRouter.ts 内で既に固定回数リトライ済み）は Copilot を試す。
 * auth_or_config・unknown（認証エラー・設定不備・プログラムエラー・原因不明）は Copilot で
 * 隠さず、そのまま re-throw して autoReview.ts が blocked 扱いにする（安全側デフォルト、fail-closed）。
 */

import { callGeminiWithFallback, MetaReviewProviderError, type GeminiRouterOptions } from './geminiRouter.js'
import { callCopilotForMetaReview } from './copilotRouter.js'

export {
  MetaReviewProviderError, sanitizeMessage, type FailureClass, type ProviderFailureDiagnostics,
} from './geminiRouter.js'

export type MetaReviewProvider = 'gemini' | 'copilot'

export interface MetaReviewFallbackResult {
  raw: string
  providerUsed: MetaReviewProvider
}

const COPILOT_ELIGIBLE_FAILURE_CLASSES = new Set(['quota', 'transient'])

/**
 * Gemini API → Gemini CLI → Copilot CLI の3段フォールバックでレビューを依頼する。
 * Gemini 側が auth_or_config・unknown で失敗した場合は、Copilot を試さずそのまま失敗させる。
 */
export async function reviewWithProviderFallback(
  prompt: string,
  geminiOptions?: GeminiRouterOptions,
): Promise<MetaReviewFallbackResult> {
  try {
    const raw = await callGeminiWithFallback(prompt, geminiOptions)
    return { raw, providerUsed: 'gemini' }
  } catch (err) {
    if (!(err instanceof MetaReviewProviderError) || !COPILOT_ELIGIBLE_FAILURE_CLASSES.has(err.failureClass)) {
      throw err
    }

    console.warn(
      `\n⚠️  [metaReviewFallbackRouter] Gemini API・CLI が失敗しました（分類: ${err.failureClass}）。` +
      ' Copilot CLI（Microsoft系モデル）にフォールバックします。'
    )

    const raw = callCopilotForMetaReview(prompt, { usage: 'meta_review' })
    return { raw, providerUsed: 'copilot' }
  }
}
