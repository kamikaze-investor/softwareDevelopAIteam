/**
 * 通知ルーター
 *
 * 有効な通知チャネルに順番に送信する。
 * チャネルは .env の LINE_CHANNEL_ACCESS_TOKEN / SLACK_WEBHOOK_URL / NOTIFY_EMAIL で制御。
 *
 * R5-N1: 送信は一発勝負ではなく、**再試行可能な失敗に限って**上限付きで再送する。
 * 新しい retry / scheduler framework は追加せず、既存 `patchJobWithRetry`
 * （固定回数・固定バックオフ・注入可能な sleep）と同じ形に揃える。
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

/**
 * チャネルアダプターの返り値。
 *
 * `retryable` は「もう一度同じ送信を試す価値があるか」だけを表す。
 * ネットワーク断・タイムアウト・5xx・429 は再試行する価値があるが、
 * 設定ミスや権限エラー（その他の 4xx）は何度送っても同じなので再試行しない。
 */
export interface ChannelSendResult {
  success: boolean
  error?: string
  retryable?: boolean
}

export interface SendResult {
  channel: NotificationChannel
  success: boolean
  error?: string
  /** 送信に要した試行回数（1 = 初回で成功） */
  attempts: number
}

/**
 * 再送する価値がある HTTP status か。
 * 5xx はサーバ側の一時障害、429 はレート制限なので待てば通る。
 * それ以外の 4xx（URL 失効・権限・payload 不正）は何度送っても同じ。
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/** 送信リトライの上限とバックオフ。既存 patchJobWithRetry と同じ形に揃える */
const MAX_SEND_ATTEMPTS = 3
const SEND_BACKOFF_MS: readonly [number, number] = [500, 2_000]

export interface SendAlertOptions {
  /** テスト用。既定は実時間の sleep */
  sleepImpl?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 1チャネルへの送信を、再試行可能な失敗に限って上限付きで再試行する。
 */
async function sendWithRetry(
  channel: NotificationChannel,
  send: () => Promise<ChannelSendResult>,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<SendResult> {
  let last: ChannelSendResult = { success: false, error: 'not attempted' }

  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
    last = await send()
    if (last.success) {
      return { channel, success: true, attempts: attempt + 1 }
    }
    // 再試行しても結果が変わらない失敗（設定ミス・権限エラー等）は即座に諦める。
    // 無駄な再送は、本当に届けたい critical alert の到達を遅らせるだけ。
    if (last.retryable !== true) {
      return { channel, success: false, error: last.error, attempts: attempt + 1 }
    }
    if (attempt < MAX_SEND_ATTEMPTS - 1) {
      await sleepImpl(SEND_BACKOFF_MS[attempt])
    }
  }

  return { channel, success: false, error: last.error, attempts: MAX_SEND_ATTEMPTS }
}

/**
 * 設定されているすべてのチャネルにアラートを送信する。
 * チャネルが 1 つも設定されていなければコンソールのみ出力。
 *
 * 複数チャネルが設定されている場合、片方が失敗しても他方は独立して送信される
 * （これが実質的な fallback になる）。**全チャネルが失敗した critical alert** は
 * 「通知が届いていない」こと自体が異常なので、区別できる形で強調表示する。
 */
export async function sendAlert(
  payload: AlertPayload,
  options: SendAlertOptions = {},
): Promise<SendResult[]> {
  const sleepImpl = options.sleepImpl ?? defaultSleep
  const results: SendResult[] = []

  if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) {
    results.push(await sendWithRetry('line', () => sendLine(payload), sleepImpl))
  }

  if (process.env.SLACK_WEBHOOK_URL) {
    results.push(await sendWithRetry('slack', () => sendSlack(payload), sleepImpl))
  }

  if (results.length === 0) {
    console.warn(
      `[Notifier] ⚠️ 通知チャネルが未設定です。コンソールのみ出力:\n` +
      `  [${payload.severity.toUpperCase()}] ${payload.title}\n${payload.body}`
    )
    return results
  }

  const succeeded = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  for (const s of succeeded) {
    const retried = s.attempts > 1 ? `（${s.attempts}回目で成功）` : ''
    console.log(`[Notifier] ✅ 送信成功: ${s.channel}${retried}`)
  }
  for (const f of failed) {
    console.error(`[Notifier] ❌ 送信失敗: ${f.channel}（${f.attempts}回試行）— ${f.error}`)
  }

  // 全チャネル失敗 = CEO には何も届いていない。critical では特に、
  // 「アラートが出た」ことと「アラートが届いた」ことを混同してはならない。
  if (succeeded.length === 0) {
    const detail = results.map((r) => `${r.channel}: ${r.error ?? 'unknown'}`).join(' / ')
    console.error(
      `[Notifier] 🚨 UNDELIVERED (${payload.severity}) 全チャネルへの送信に失敗しました。` +
      `通知は届いていません:\n` +
      `  [${payload.severity.toUpperCase()}] ${payload.title}\n${payload.body}\n` +
      `  失敗内訳: ${detail}`
    )
  }

  return results
}
