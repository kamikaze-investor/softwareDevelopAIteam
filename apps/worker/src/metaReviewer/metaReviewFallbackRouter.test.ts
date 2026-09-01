/**
 * metaReviewFallbackRouter テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * callGeminiWithFallback / callCopilotForMetaReview をモックして
 * 3段フォールバック（Gemini API → Gemini CLI → Copilot CLI）の分岐を検証する。
 * 2026-09-01: Copilot フォールバック判定が failureClass ベースになったのに合わせ、
 * quota/transient → Copilot、auth_or_config/unknown → fail-closed（re-throw）を検証する。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./geminiRouter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./geminiRouter.js')>()
  return {
    ...actual,
    callGeminiWithFallback: vi.fn(),
  }
})
vi.mock('./copilotRouter.js', () => ({
  callCopilotForMetaReview: vi.fn(),
}))

import { callGeminiWithFallback, MetaReviewProviderError, type FailureClass } from './geminiRouter.js'
import { callCopilotForMetaReview } from './copilotRouter.js'
import { reviewWithProviderFallback } from './metaReviewFallbackRouter.js'

const mockGemini = vi.mocked(callGeminiWithFallback)
const mockCopilot = vi.mocked(callCopilotForMetaReview)

function providerError(failureClass: FailureClass, message: string): MetaReviewProviderError {
  return new MetaReviewProviderError(message, failureClass, [])
}

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

  it('failureClass: quota で失敗したら Copilot にフォールバックする', async () => {
    mockGemini.mockRejectedValue(providerError('quota', '[geminiRouter] Gemini quota exhausted (feature: meta_review)'))
    mockCopilot.mockReturnValue('copilot response')

    const result = await reviewWithProviderFallback('prompt')

    expect(result).toEqual({ raw: 'copilot response', providerUsed: 'copilot' })
    expect(mockCopilot).toHaveBeenCalledWith('prompt', { usage: 'meta_review' })
  })

  it('failureClass: transient で失敗したら（geminiRouter内でリトライ済みの前提で）Copilot にフォールバックする', async () => {
    mockGemini.mockRejectedValue(providerError('transient', '[geminiRouter] Gemini failed, transient (feature: meta_review)'))
    mockCopilot.mockReturnValue('copilot response (transient fallback)')

    const result = await reviewWithProviderFallback('prompt')

    expect(result).toEqual({ raw: 'copilot response (transient fallback)', providerUsed: 'copilot' })
    expect(mockCopilot).toHaveBeenCalledOnce()
  })

  it('failureClass: auth_or_config は Copilot を試さずそのまま re-throw する（fail-closed）', async () => {
    mockGemini.mockRejectedValue(providerError('auth_or_config', '[geminiRouter] Gemini failed, auth_or_config (feature: meta_review)'))

    await expect(reviewWithProviderFallback('prompt')).rejects.toThrow('Gemini failed, auth_or_config')
    expect(mockCopilot).not.toHaveBeenCalled()
  })

  it('failureClass: unknown は Copilot を試さずそのまま re-throw する（fail-closed、安全側デフォルト）', async () => {
    mockGemini.mockRejectedValue(providerError('unknown', '[geminiRouter] Gemini failed, unknown (feature: meta_review)'))

    await expect(reviewWithProviderFallback('prompt')).rejects.toThrow('Gemini failed, unknown')
    expect(mockCopilot).not.toHaveBeenCalled()
  })

  it('MetaReviewProviderError ではない予期しないエラー（プログラムバグ等）は Copilot を試さずそのまま re-throw する', async () => {
    mockGemini.mockRejectedValue(new TypeError('cannot read property of undefined'))

    await expect(reviewWithProviderFallback('prompt')).rejects.toThrow(
      'cannot read property of undefined'
    )
    expect(mockCopilot).not.toHaveBeenCalled()
  })

  it('quota 起因後に Copilot 自体も失敗したらそのエラーがそのまま伝播する', async () => {
    mockGemini.mockRejectedValue(providerError('quota', '[geminiRouter] Gemini quota exhausted (feature: meta_review)'))
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
