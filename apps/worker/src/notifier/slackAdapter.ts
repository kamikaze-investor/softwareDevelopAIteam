/**
 * Slack Incoming Webhook アダプター
 *
 * SLACK_WEBHOOK_URL: Incoming Webhook の URL
 */

import type { AlertPayload } from './notifier.js'

const FETCH_TIMEOUT_MS = 8_000

const SEVERITY_EMOJI: Record<string, string> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
}

export async function sendSlack(payload: AlertPayload): Promise<{ success: boolean; error?: string }> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return { success: false, error: 'SLACK_WEBHOOK_URL が未設定' }
  }

  const emoji = SEVERITY_EMOJI[payload.severity] ?? ':bell:'
  const text = `${emoji} *${payload.title}*\n${payload.body}`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const errBody = await res.text()
      return { success: false, error: `Slack Webhook ${res.status}: ${errBody}` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
