/**
 * `POST /api/tasks/:id/resume` の失敗を、CEO が次に何をすべきか分かる文言へ写す。
 *
 * API の `error` 文字列を部分一致で引く。**先に書いた方が優先される**ので、
 * 具体的な理由ほど上に置く。
 */

export const RESUME_ERROR_MESSAGE_FALLBACK =
  '追加指示の送信に失敗しました。時間をおいて再度お試しください。'

/**
 * 追加指示の事前 Design Review が通らなかったとき（409）。
 *
 * API は「レビュー AI が使えなかった」と「指示が方針と合わないと判定された」を区別して返さない。
 * 前者を「入力内容を確認してください」と出すと、CEO は正しい指示を書き直してしまう
 * （2026-10-16、Gemini が使えない間に実際に起きた）。どちらの場合もあり得ると伝える。
 */
export const RESUME_DESIGN_REVIEW_FAILED_MESSAGE =
  '追加指示の事前の設計レビューを通過できませんでした。'
  + 'レビューAIが一時的に使えない場合もこの表示になるため、入力内容の誤りとは限りません。'
  + '時間をおいてもう一度送信してください。続く場合はAI開発チームに確認を依頼してください。'

const RESUME_ERROR_MESSAGE_BY_REASON: ReadonlyArray<readonly [string, string]> = [
  ['did not pass the pre-implementation design review', RESUME_DESIGN_REVIEW_FAILED_MESSAGE],
  ['already exists for this task', '既に実行中または待機中の作業があるため、追加指示を送れませんでした。'],
  ['missing AI CLI', 'AI実行設定が不足しているため、再開できませんでした。'],
  ['No jobs exist', '対象の作業履歴が見つからないため、再開できませんでした。'],
  ['not blocked', '現在は停止状態ではないため、追加指示を送れませんでした。'],
  ['instruction', '入力内容を確認してください。'],
  ['validation', '入力内容を確認してください。'],
  ['waiting for user review', '承認待ちの操作があるため、追加指示を送れませんでした。'],
]

export function formatResumeErrorMessage(errorMessage: string | null): string {
  if (errorMessage === null || errorMessage.length === 0) {
    return RESUME_ERROR_MESSAGE_FALLBACK
  }

  const normalizedErrorMessage = errorMessage.toLowerCase()
  const matchingMessage = RESUME_ERROR_MESSAGE_BY_REASON.find(
    ([reason]) => normalizedErrorMessage.includes(reason.toLowerCase()),
  )

  return matchingMessage?.[1] ?? RESUME_ERROR_MESSAGE_FALLBACK
}
