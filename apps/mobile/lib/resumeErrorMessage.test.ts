import { describe, expect, it } from 'vitest'

import {
  APPROVAL_DECISION_ERROR_MESSAGE_FALLBACK,
  formatApprovalDecisionErrorMessage,
  formatRecoverErrorMessage,
  formatResumeErrorMessage,
  RECOVER_ERROR_MESSAGE_FALLBACK,
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

describe('formatResumeErrorMessage（stable code）', () => {
  it.each([
    ['AI_CLI_PROVIDER_MISSING', 'AI実行設定（使用するAI）が記録されていないため、再開できませんでした。AI開発チームに確認を依頼してください。'],
    ['TASK_DONE', 'このTaskは完了しているため、再開できません。'],
    ['PROJECT_NOT_RUNNING', 'Projectが実行中ではないため、再開できませんでした。先にProjectを再開してください。'],
    ['TASK_PARKED', 'このTaskは中止（保留）されているため、再開できません。'],
    ['WORKSPACE_QUARANTINED', '安全のため停止しているため、追加指示では再開できません。AI開発チーム側で作業領域の復旧が必要です。'],
    ['LIVE_JOB_EXISTS', '既に実行中または待機中の作業があるため、追加指示を送れませんでした。'],
    ['APPROVAL_WAITING', '承認待ちの操作があるため、追加指示を送れませんでした。'],
    ['NO_JOBS', 'このTaskには作業履歴が無いため、追加指示では再開できません。「復旧（再開待ちに戻す）」を使ってください。'],
  ])('code %s は専用の文言（error 文字列より優先）', (code, expected) => {
    expect(formatResumeErrorMessage('Validation failed', code)).toBe(expected)
  })

  it('設計レビュー不通過の code は既存の文言', () => {
    expect(formatResumeErrorMessage(null, 'RESUME_DESIGN_REVIEW_FAILED')).toBe(RESUME_DESIGN_REVIEW_FAILED_MESSAGE)
  })

  it('未知の code は従来の error 文字列の照合へ落ちる', () => {
    expect(formatResumeErrorMessage('Task is not blocked', 'SOMETHING_NEW')).toBe('現在は停止状態ではないため、追加指示を送れませんでした。')
    expect(formatResumeErrorMessage(null, 'SOMETHING_NEW')).toBe(RESUME_ERROR_MESSAGE_FALLBACK)
    expect(formatResumeErrorMessage(null, 'toString')).toBe(RESUME_ERROR_MESSAGE_FALLBACK)
  })
})

describe('formatRecoverErrorMessage', () => {
  it.each([
    ['PROJECT_NOT_RUNNING', 'Projectが実行中ではないため、復旧できませんでした。先にProjectを再開してください。'],
    ['TASK_HAS_JOBS', 'このTaskには作業履歴があるため、「追加指示を出す」から再開してください。'],
    ['APPROVAL_WAITING', '承認待ちの操作があるため、復旧できませんでした。先に承認画面で判断してください。'],
  ])('code %s', (code, expected) => {
    expect(formatRecoverErrorMessage(code)).toBe(expected)
  })

  it('code が無い・未知なら fallback', () => {
    expect(formatRecoverErrorMessage(null)).toBe(RECOVER_ERROR_MESSAGE_FALLBACK)
    expect(formatRecoverErrorMessage('RECOVERY_FAILED')).toBe(RECOVER_ERROR_MESSAGE_FALLBACK)
  })
})

describe('formatApprovalDecisionErrorMessage', () => {
  it('human-only の 403 code は CEO 専用である旨を出す（C-02）', () => {
    expect(formatApprovalDecisionErrorMessage('HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS')).toContain('CEO専用')
  })

  it('期限切れの 409 code は「記録されなかった」ことを出す（fallback にしない）', () => {
    const message = formatApprovalDecisionErrorMessage('APPROVAL_EXPIRED')
    expect(message).not.toBe(APPROVAL_DECISION_ERROR_MESSAGE_FALLBACK)
    expect(message).toContain('期限が切れて')
    expect(message).toContain('記録されませんでした')
  })

  it('code が無い・未知なら fallback', () => {
    expect(formatApprovalDecisionErrorMessage(null)).toBe(APPROVAL_DECISION_ERROR_MESSAGE_FALLBACK)
    expect(formatApprovalDecisionErrorMessage('SOMETHING')).toBe(APPROVAL_DECISION_ERROR_MESSAGE_FALLBACK)
  })
})
