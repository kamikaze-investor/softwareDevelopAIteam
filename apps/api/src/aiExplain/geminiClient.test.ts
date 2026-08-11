import { GoogleGenerativeAI } from '@google/generative-ai'
import { describe, expect, it } from 'vitest'
import {
  createGeminiClient,
  parseJsonObject,
  requestText,
} from './geminiClient'

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

describe('Gemini client helpers', () => {
  it('creates the same Gemini SDK client used by explanation modules', () => {
    expect(createGeminiClient('test-key')).toBeInstanceOf(GoogleGenerativeAI)
  })

  it('returns mockResponse without making a Gemini request', async () => {
    await expect(
      requestText('system', 'user', { mockResponse: ' mocked ' }, 100),
    ).resolves.toBe(' mocked ')
  })

  it('rejects when no API key or mock response is configured', async () => {
    const previous = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      await expect(requestText('system', 'user', {}, 100)).rejects.toThrow(
        'GEMINI_API_KEY is not configured',
      )
    } finally {
      if (previous !== undefined) process.env.GEMINI_API_KEY = previous
    }
  })
})
