import { describe, expect, it } from 'vitest'

import {
  formatResumeErrorMessage,
  RESUME_DESIGN_REVIEW_FAILED_MESSAGE,
  RESUME_ERROR_MESSAGE_FALLBACK,
} from './resumeErrorMessage'

describe('formatResumeErrorMessage', () => {
  it('事前 Design Review の不通過を「入力内容を確認」と出さない', () => {
    const message = formatResumeErrorMessage(
      'Resume instruction did not pass the pre-implementation Design Review',
    )
    expect(message).toBe(RESUME_DESIGN_REVIEW_FAILED_MESSAGE)
    expect(message).not.toBe('入力内容を確認してください。')
  })

  it('入力の検証失敗（400 Validation failed）は従来どおり入力内容の確認を促す', () => {
    expect(formatResumeErrorMessage('Validation failed')).toBe('入力内容を確認してください。')
  })

  it.each([
    ['a live job already exists for this task', '既に実行中または待機中の作業があるため、追加指示を送れませんでした。'],
    ['Task is not blocked', '現在は停止状態ではないため、追加指示を送れませんでした。'],
    ['The latest approval request is waiting for user review', '承認待ちの操作があるため、追加指示を送れませんでした。'],
  ])('既存の理由 %s の文言は変えない', (error, expected) => {
    expect(formatResumeErrorMessage(error)).toBe(expected)
  })

  it('空・未知の理由は fallback', () => {
    expect(formatResumeErrorMessage(null)).toBe(RESUME_ERROR_MESSAGE_FALLBACK)
    expect(formatResumeErrorMessage('')).toBe(RESUME_ERROR_MESSAGE_FALLBACK)
    expect(formatResumeErrorMessage('something else')).toBe(RESUME_ERROR_MESSAGE_FALLBACK)
  })
})
