import { describe, expect, it, vi } from 'vitest'

import { AGY_REVIEW_MODEL } from '../src/metaReviewer/geminiRouter.js'

const reviewWithProviderFallback = vi.fn()

vi.mock('../src/metaReviewer/metaReviewFallbackRouter.js', () => ({
  reviewWithProviderFallback: (...args: unknown[]) => reviewWithProviderFallback(...args),
  MetaReviewProviderError: class MetaReviewProviderError extends Error {},
}))

describe('runGeminiCanary', () => {
  it('requests an explicit, currently-supported cliModel instead of relying on geminiRouter.ts\'s default', async () => {
    reviewWithProviderFallback.mockResolvedValueOnce({ providerUsed: 'gemini' })

    const { runGeminiCanary } = await import('./deployCanary.js')
    await runGeminiCanary()

    expect(reviewWithProviderFallback).toHaveBeenCalledTimes(1)
    const [, options] = reviewWithProviderFallback.mock.calls[0] as [string, { cliModel?: string; cliEffort?: string }]
    expect(options.cliModel).toBe(AGY_REVIEW_MODEL.cliModel)
    expect(options.cliEffort).toBe(AGY_REVIEW_MODEL.cliEffort)
  })

  // 2026-09-04: canary が専用モデル（gemini-3.8-flash）を持っていたため、実レビュー経路の
  // モデルが agy に拒否される状態でも canary は PASS し続けた。canary は実レビュー経路と
  // 同じ agy 設定を叩かなければ「PASS = レビューが動く」を保証できない。
  it('exercises the same agy model+effort as the real review path, not a canary-only model', async () => {
    reviewWithProviderFallback.mockResolvedValueOnce({ providerUsed: 'gemini' })

    const { runGeminiCanary } = await import('./deployCanary.js')
    await runGeminiCanary()

    const [, options] = reviewWithProviderFallback.mock.calls.at(-1) as [string, Record<string, unknown>]
    expect({ cliModel: options.cliModel, cliEffort: options.cliEffort }).toEqual({ ...AGY_REVIEW_MODEL })
  })
})
