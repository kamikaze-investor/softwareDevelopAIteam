import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseJsonObject, requestText } from './cheapAiClient'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseJsonObject', () => {
  it('parses JSON from a fenced response', () => {
    expect(parseJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('rejects a response without a JSON object', () => {
    expect(() => parseJsonObject('plain text')).toThrow(
      'AI response did not contain a JSON object',
    )
  })
})

describe('OpenCode Go client', () => {
  it('requests text with the fixed cheap explainer model and chat roles', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: ' generated text ' } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestText('system prompt', 'user prompt', { apiKey: 'test-key' }, 321),
    ).resolves.toBe('generated text')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'user prompt' },
          ],
          max_tokens: 321,
          temperature: 0.1,
        }),
      },
    )
  })

  it('throws on a non-successful API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))

    await expect(
      requestText('system', 'user', { apiKey: 'test-key' }, 100),
    ).rejects.toThrow('OpenCode Go request failed with status 401')
  })

  it('leaves invalid non-JSON text for the existing parser to reject', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'not json' } }],
    }), { status: 200 })))

    const raw = await requestText('system', 'user', { apiKey: 'test-key' }, 100)
    expect(() => parseJsonObject(raw)).toThrow(
      'AI response did not contain a JSON object',
    )
  })

  it('returns mockResponse without making an HTTP request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestText('system', 'user', { mockResponse: ' mocked ' }, 100),
    ).resolves.toBe(' mocked ')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects when no API key or mock response is configured', async () => {
    const previous = process.env.OPENCODE_GO_API_KEY
    delete process.env.OPENCODE_GO_API_KEY
    try {
      await expect(requestText('system', 'user', {}, 100)).rejects.toThrow(
        'OPENCODE_GO_API_KEY is not configured',
      )
    } finally {
      if (previous !== undefined) process.env.OPENCODE_GO_API_KEY = previous
    }
  })
})
