/**
 * LINE Messaging API アダプター
 *
 * LINE_CHANNEL_ACCESS_TOKEN: チャネルアクセストークン
 * LINE_USER_ID: 送信先ユーザー ID（マイ LINE ID）
 */

import type { AlertPayload } from './notifier.js'

const LINE_API = 'https://api.line.me/v2/bot/message/push'
const FETCH_TIMEOUT_MS = 8_000

const SEVERITY_EMOJI: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
}

export async function sendLine(payload: AlertPayload): Promise<{ success: boolean; error?: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const userId = process.env.LINE_USER_ID
  if (!token || !userId) {
    return { success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN または LINE_USER_ID が未設定' }
  }

  const emoji = SEVERITY_EMOJI[payload.severity] ?? '📢'
  const text = `${emoji} ${payload.title}\n\n${payload.body}`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(LINE_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text }],
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const errBody = await res.text()
      return { success: false, error: `LINE API ${res.status}: ${errBody}` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
