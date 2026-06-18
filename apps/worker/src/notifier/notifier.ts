/**
 * 通知ルーター
 *
 * 有効な通知チャネルに順番に送信する。
 * チャネルは .env の LINE_CHANNEL_ACCESS_TOKEN / SLACK_WEBHOOK_URL / NOTIFY_EMAIL で制御。
 */

import type { NotificationChannel, NotificationSeverity } from '@ai-team/shared'
import { sendLine } from './lineAdapter.js'
import { sendSlack } from './slackAdapter.js'

export interface AlertPayload {
  severity: NotificationSeverity
  title: string
  body: string
  sourceType?: string
  sourceId?: string
}

interface SendResult {
  channel: NotificationChannel
  success: boolean
  error?: string
}

/**
 * 設定されているすべてのチャネルにアラートを送信する。
 * チャネルが 1 つも設定されていなければコンソールのみ出力。
 */
export async function sendAlert(payload: AlertPayload): Promise<SendResult[]> {
  const results: SendResult[] = []

  if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) {
    const result = await sendLine(payload)
    results.push({ channel: 'line', ...result })
  }

  if (process.env.SLACK_WEBHOOK_URL) {
    const result = await sendSlack(payload)
    results.push({ channel: 'slack', ...result })
  }

  if (results.length === 0) {
    console.warn(
      `[Notifier] ⚠️ 通知チャネルが未設定です。コンソールのみ出力:\n` +
      `  [${payload.severity.toUpperCase()}] ${payload.title}\n${payload.body}`
    )
  } else {
    const succeeded = results.filter((r) => r.success).map((r) => r.channel)
    const failed = results.filter((r) => !r.success)
    if (succeeded.length > 0) {
      console.log(`[Notifier] ✅ 送信成功: ${succeeded.join(', ')}`)
    }
    for (const f of failed) {
      console.error(`[Notifier] ❌ 送信失敗: ${f.channel} — ${f.error}`)
    }
  }

  return results
}
