/**
 * metaReviewFallbackRouter テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * callGeminiWithFallback / callCopilotForMetaReview をモックして
 * 3段フォールバック（Gemini API → Gemini CLI → Copilot CLI）の分岐を検証する。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./geminiRouter.js', () => ({
  callGeminiWithFallback: vi.fn(),
}))
vi.mock('./copilotRouter.js', () => ({
  callCopilotForMetaReview: vi.fn(),
}))

import { callGeminiWithFallback } from './geminiRouter.js'
import { callCopilotForMetaReview } from './copilotRouter.js'
import { reviewWithProviderFallback } from './metaReviewFallbackRouter.js'

const mockGemini = vi.mocked(callGeminiWithFallback)
const mockCopilot = vi.mocked(callCopilotForMetaReview)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reviewWithProviderFallback', () => {
  it('Gemini が成功したら Copilot を呼ばず gemini 結果を返す', async () => {
    mockGemini.mockResolvedValue('gemini response')

    const result = await reviewWithProviderFallback('prompt')

    expect(result).toEqual({ raw: 'gemini response', providerUsed: 'gemini' })
    expect(mockCopilot).not.toHaveBeenCalled()
  })

  it('Gemini が両方 quota 枯渇（geminiRouter のエラー文言）で失敗したら Copilot にフォールバックする', async () => {
    mockGemini.mockRejectedValue(new Error('[geminiRouter] Gemini quota exhausted (feature: meta_review)'))
    mockCopilot.mockReturnValue('copilot response')

    const result = await reviewWithProviderFallback('prompt')

    expect(result).toEqual({ raw: 'copilot response', providerUsed: 'copilot' })
    expect(mockCopilot).toHaveBeenCalledWith('prompt', { usage: 'meta_review' })
  })

  it('quota 以外の失敗（プログラムエラー等）は Copilot を試さずそのまま re-throw する', async () => {
    mockGemini.mockRejectedValue(new Error('TypeError: cannot read property of undefined'))

    await expect(reviewWithProviderFallback('prompt')).rejects.toThrow(
      'TypeError: cannot read property of undefined'
    )
    expect(mockCopilot).not.toHaveBeenCalled()
  })

  it('quota 枯渇後に Copilot 自体も失敗したらそのエラーがそのまま伝播する', async () => {
    mockGemini.mockRejectedValue(new Error('[geminiRouter] Gemini quota exhausted (feature: meta_review)'))
    mockCopilot.mockImplementation(() => {
      throw new Error('[copilotRouter] Copilot CLI が exit code 1 で終了しました')
    })

    await expect(reviewWithProviderFallback('prompt')).rejects.toThrow(/Copilot CLI が exit code 1/)
  })

  it('geminiOptions をそのまま callGeminiWithFallback に渡す', async () => {
    mockGemini.mockResolvedValue('ok')

    await reviewWithProviderFallback('prompt', { preferCli: true, featureName: 'meta_review' })

    expect(mockGemini).toHaveBeenCalledWith('prompt', { preferCli: true, featureName: 'meta_review' })
  })
})
