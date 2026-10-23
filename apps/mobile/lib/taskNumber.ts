/**
 * Task を人が見分けるための短い番号（Task id の先頭 8 文字）。
 *
 * CEO への報告・承認依頼・ログでは Task を `b8d0fc5d` のような id 先頭で呼ぶので、
 * Mobile の一覧・詳細・承認画面にも同じ番号を出して突き合わせられるようにする。
 * 新しい採番はしない（id 以外の番号を作ると、報告と画面で別の呼び名が生まれる）。
 */
export const TASK_NUMBER_LENGTH = 8

export function formatTaskNumber(taskId: string | null | undefined): string | null {
  if (typeof taskId !== 'string') return null
  const trimmed = taskId.trim()
  if (trimmed.length === 0) return null
  return `#${trimmed.slice(0, TASK_NUMBER_LENGTH)}`
}

/** タスク番号の表示スタイル（各画面で同じ見た目にする。React Native の style object）。 */
export const TASK_NUMBER_TEXT_STYLE = { color: '#9ca3af', fontSize: 12, marginTop: 2 } as const

/** 画面に出す1行の表記。id が無いときは何も出さない（null）。 */
export function taskNumberLabel(taskId: string | null | undefined): string | null {
  const number = formatTaskNumber(taskId)
  return number === null ? null : `タスク番号 ${number}`
}
