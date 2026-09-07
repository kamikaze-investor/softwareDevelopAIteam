import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// fetch をモック
const mockFetch = vi.fn()
global.fetch = mockFetch

// モジュールを動的インポートで隔離
async function importNotifier() {
  vi.resetModules()
  return import('./notifier.js')
}

describe('sendAlert', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN
    delete process.env.LINE_USER_ID
    delete process.env.SLACK_WEBHOOK_URL
  })

  it('チャネル未設定ならコンソール警告のみで空配列を返す', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 'テスト', body: '本文' })
    expect(results).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('LINE のみ設定されていれば LINE に送信', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token'
    process.env.LINE_USER_ID = 'test-user'
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'warning', title: 'スタル', body: '詳細' })
    expect(results).toHaveLength(1)
    expect(results[0].channel).toBe('line')
    expect(results[0].success).toBe(true)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.line.me/v2/bot/message/push')
    const body = JSON.parse(opts.body)
    expect(body.to).toBe('test-user')
    expect(body.messages[0].type).toBe('text')
  })

  it('Slack のみ設定されていれば Slack に送信', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'info', title: '完了', body: '詳細' })
    expect(results).toHaveLength(1)
    expect(results[0].channel).toBe('slack')
    expect(results[0].success).toBe(true)
    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('https://hooks.slack.com/test')
  })

  it('LINE と Slack 両方設定されていれば両方に送信', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok'
    process.env.LINE_USER_ID = 'uid'
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 'エラー', body: '詳細' })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.success)).toBe(true)
  })

  it('LINE API が 400 を返したら success=false', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok'
    process.env.LINE_USER_ID = 'uid'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad Request' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 'テスト', body: '本文' })
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('400')
  })
})

/**
 * R5-N1: 通知は一発勝負ではない。一時的な失敗で CRITICAL alert を落とすと、
 * Phase 2 の quarantine のように「通知が届いて初めて意味がある」機構が黙って壊れる。
 */
describe('sendAlert — 再送とfallback（R5-N1）', () => {
  const noSleep = async (): Promise<void> => {}

  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN
    delete process.env.LINE_USER_ID
    delete process.env.SLACK_WEBHOOK_URL
  })

  it('5xx は再送し、成功したら success を返す', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert(
      { severity: 'critical', title: 't', body: 'b' },
      { sleepImpl: noSleep },
    )

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].attempts).toBe(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('429（レート制限）も再送対象', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'warning', title: 't', body: 'b' }, { sleepImpl: noSleep })

    expect(results[0].success).toBe(true)
    expect(results[0].attempts).toBe(2)
  })

  it('ネットワークエラーは再送する', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 't', body: 'b' }, { sleepImpl: noSleep })

    expect(results[0].success).toBe(true)
    expect(results[0].attempts).toBe(2)
  })

  it('恒久的な失敗（404）は再送せず1回で諦める', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'gone' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 't', body: 'b' }, { sleepImpl: noSleep })

    expect(results[0].success).toBe(false)
    // 設定ミスに対して何度も投げても届かない。無駄な再送で他の通知を遅らせない。
    expect(results[0].attempts).toBe(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('再送上限を超えたら諦める（無限リトライしない）', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 't', body: 'b' }, { sleepImpl: noSleep })

    expect(results[0].success).toBe(false)
    expect(results[0].attempts).toBe(3)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('片方のチャネルが恒久失敗でも、もう片方は独立して送信される（fallback）', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token'
    process.env.LINE_USER_ID = 'user'
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('line')) {
        return { ok: false, status: 401, text: async () => 'bad token' }
      }
      return { ok: true, status: 200, text: async () => '' }
    })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 't', body: 'b' }, { sleepImpl: noSleep })

    const line = results.find((r) => r.channel === 'line')
    const slack = results.find((r) => r.channel === 'slack')
    expect(line?.success).toBe(false)
    expect(slack?.success).toBe(true)
  })

  it('全チャネル失敗時は UNDELIVERED として区別できる形で報告する', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 'quarantined', body: 'b' }, { sleepImpl: noSleep })

    expect(results.every((r) => !r.success)).toBe(true)
    const undelivered = errorSpy.mock.calls.some((c) => String(c[0]).includes('UNDELIVERED'))
    expect(undelivered).toBe(true)
    errorSpy.mockRestore()
  })
})

/**
 * R5-N1 残件: `UNDELIVERED` という状態名だけ残って alert の中身と身元が消えるなら、
 * 「何の通知が失われたのか」を後から特定できず、Finding は閉じていない。
 */
describe('sendAlert — 未配信 alert の追跡可能性（R5-N1 残件）', () => {
  const noSleep = async (): Promise<void> => {}

  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN
    delete process.env.LINE_USER_ID
    delete process.env.SLACK_WEBHOOK_URL
  })

  it('全チャネル失敗時、severity / title / 発生源 / チャネル別理由がすべてログに残る', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { sendAlert } = await importNotifier()
    await sendAlert({
      severity: 'critical',
      title: 'Workspace quarantined after Job execution',
      body: 'Job ID: job-42',
      sourceType: 'watchdog_event',
      sourceId: 'wde-99',
    }, { sleepImpl: noSleep })

    const undelivered = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('UNDELIVERED'))

    expect(undelivered).toBeDefined()
    expect(undelivered).toContain('severity=critical')
    // 発生源（WatchdogEvent / Job）が特定できること
    expect(undelivered).toContain('source=watchdog_event:wde-99')
    // 何の alert だったのかが残ること
    expect(undelivered).toContain('Workspace quarantined after Job execution')
    expect(undelivered).toContain('job-42')
    // どのチャネルがなぜ落ちたのか
    expect(undelivered).toContain('slack=')
    expect(undelivered).toContain('boom')
    errorSpy.mockRestore()
  })

  it('チャネル単体の失敗ログにも発生源が含まれる', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { sendAlert } = await importNotifier()
    await sendAlert({
      severity: 'warning',
      title: 't',
      body: 'b',
      sourceType: 'job_persistence',
      sourceId: 'job-7',
    }, { sleepImpl: noSleep })

    const failure = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('送信失敗'))
    expect(failure).toContain('source=job_persistence:job-7')
    errorSpy.mockRestore()
  })

  it('HTTP 408 Request Timeout は恒久失敗に巻き込まず再送する', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example.com/x'
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 408, text: async () => 'request timeout' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })

    const { sendAlert } = await importNotifier()
    const results = await sendAlert({ severity: 'critical', title: 't', body: 'b' }, { sleepImpl: noSleep })

    expect(results[0].success).toBe(true)
    expect(results[0].attempts).toBe(2)
  })
})
