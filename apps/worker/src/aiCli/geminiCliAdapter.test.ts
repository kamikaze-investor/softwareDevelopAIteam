import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}))

vi.mock('../guards/changeManifest.js', () => ({
  buildWorktreeManifest: vi.fn(() => ({ changes: [], paths: [] })),
}))

import { createAiCliAdapter } from './factory.js'
import type { AiCliRequest } from '@ai-team/shared'

const execFileSyncMock = vi.mocked(execFileSync)

const request: AiCliRequest = {
  taskId: 'gemini-cli-trust-workspace',
  provider: 'gemini',
  workingDir: '/workspace/target',
  prompt: 'Read README.md and reply only with its first heading.',
  contextFiles: [],
  mode: 'review',
}

describe('GeminiCliAdapter', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
    execFileSyncMock.mockReturnValue('OK')
  })

  it('uses Gemini CLI headless prompt mode and trusted-workspace env without exposing other secrets', async () => {
    await createAiCliAdapter({ provider: 'gemini' }).run(request)

    const call = execFileSyncMock.mock.calls.find(([exe]) => exe === 'gemini')
    expect(call).toBeDefined()
    expect(call?.[1]).toContain('-p')

    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    expect(options?.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
    expect(options?.env?.GEMINI_API_KEY).toBe(process.env.GEMINI_API_KEY)
    expect(options?.env?.OPENAI_API_KEY).toBeUndefined()
    expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
