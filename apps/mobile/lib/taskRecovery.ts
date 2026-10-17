/**
 * blocked Task の人手復旧 API 呼び出し（Mobile 側）。
 *
 *   - `POST /api/tasks/:id/recover` — Job 0 件のまま blocked で止まった Task を `pending` へ戻す
 *     （Human Recovery。split credential mode の ADMIN でしか通らない。token は `apiFetch` が付ける）
 *
 * ボタンを出すかどうかは `canShowRecoverUI()`（共有 `evaluateRecoverAdmission()`）が決める。
 * ここは送信と、拒否 `code` を文言へ写すことだけを行う。
 */

import { apiFetch } from './api'
import { formatRecoverErrorMessage, RECOVER_ERROR_MESSAGE_FALLBACK } from './resumeErrorMessage'

/**
 * `/recover` の `reason`（監査理由。API 側上限 400 文字）。CEO に理由を書かせない ——
 * 「Mobile のボタンから CEO が実行した」こと自体が監査に残すべき事実である。
 */
export const MOBILE_RECOVER_REASON = 'CEO が Mobile の「復旧（再開待ちに戻す）」ボタンから実行'

/** 拒否応答の `{ error, code }` を読む。body が JSON でなければどちらも null。 */
export async function readApiRejection(
  response: Response,
): Promise<{ code: string | null; error: string | null }> {
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown }
    return {
      code: typeof body.code === 'string' ? body.code : null,
      error: typeof body.error === 'string' ? body.error : null,
    }
  } catch {
    return { code: null, error: null }
  }
}

export async function submitTaskRecovery(
  taskId: string,
): Promise<{ message: string; ok: false } | { ok: true }> {
  try {
    const response = await apiFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/recover`,
      {
        body: JSON.stringify({ reason: MOBILE_RECOVER_REASON }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    )
    if (response.status === 200) return { ok: true }
    const { code } = await readApiRejection(response)
    return { message: formatRecoverErrorMessage(code), ok: false }
  } catch {
    return { message: RECOVER_ERROR_MESSAGE_FALLBACK, ok: false }
  }
}
