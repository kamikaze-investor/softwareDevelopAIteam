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
