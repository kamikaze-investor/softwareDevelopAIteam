import { describe, expect, it, vi } from 'vitest'

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
    const [, options] = reviewWithProviderFallback.mock.calls[0] as [string, { cliModel?: string }]
    expect(options.cliModel).toBe('gemini-3.8-flash')
  })
})
