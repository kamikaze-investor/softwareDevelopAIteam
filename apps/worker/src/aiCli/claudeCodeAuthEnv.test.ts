import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../execution/runContainedCommand.js', async () => {
  const { createContainedCommandMock } = await import('../execution/containedCommandTestBridge.js')
  return createContainedCommandMock()
})

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}))

vi.mock('../guards/changeManifest.js', () => ({
  buildWorktreeManifest: vi.fn(() => ({ changes: [], paths: [] })),
}))

import { createAiCliAdapter } from './factory.js'
import type { AiCliRequest } from '@ai-team/shared'

const execFileSyncMock = vi.mocked(execFileSync)

/**
 * Claude Code CLI へ **API key を渡さない**ことを固定する。
 *
 * CLI は `ANTHROPIC_API_KEY` が設定されているとそれを claude.ai ログインより優先する。
 * 渡していたせいで subscription があるのに従量課金の credit を消費し続け、
 * 2026-09-18 に残高切れで implement Job が全滅した（`400 Credit balance is too low`）。
 *
 * `HOME` は渡し続ける必要がある。CLI はそこから `~/.claude/` の subscription 認証情報を読む。
 */

function requestFor(provider: AiCliRequest['provider']): AiCliRequest {
  return {
    taskId: `auth-env-${provider}`,
    provider,
    workingDir: '/workspace/target',
    prompt: 'Reply with OK.',
    contextFiles: [],
    mode: 'review',
  }
}

function envOfSpawn(exe: string): NodeJS.ProcessEnv | undefined {
  const call = execFileSyncMock.mock.calls.find(([command]) => String(command).includes(exe))
  return (call?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
}

describe('claude_code の認証 env', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
    execFileSyncMock.mockReturnValue('OK')
  })

  it('ANTHROPIC_API_KEY を渡さない（渡すと subscription より優先される）', async () => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key-must-not-be-forwarded')

    await createAiCliAdapter({ provider: 'claude_code' }).run(requestFor('claude_code'))

    const env = envOfSpawn('claude')
    expect(env).toBeDefined()
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
    // 名前を変えただけの横流しも防ぐ。
    expect(env?.CLAUDE_API_KEY).toBeUndefined()
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

    vi.unstubAllEnvs()
  })

  it('HOME は渡す（subscription credential の置き場所へ到達できなくなる）', async () => {
    vi.stubEnv('HOME', '/home/ai-team')

    await createAiCliAdapter({ provider: 'claude_code' }).run(requestFor('claude_code'))

    expect(envOfSpawn('claude')?.HOME).toBe('/home/ai-team')

    vi.unstubAllEnvs()
  })

  it('他 provider の認証 env は変えていない', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-test-key')
    vi.stubEnv('OPENAI_API_KEY', 'openai-test-key')
    vi.stubEnv('GITHUB_TOKEN', 'github-test-token')

    await createAiCliAdapter({ provider: 'gemini' }).run(requestFor('gemini'))
    const gemini = envOfSpawn('gemini')
    expect(gemini?.GEMINI_API_KEY).toBe('gemini-test-key')
    expect(gemini?.ANTHROPIC_API_KEY).toBeUndefined()

    execFileSyncMock.mockReset()
    execFileSyncMock.mockReturnValue('OK')
    await createAiCliAdapter({ provider: 'copilot' }).run(requestFor('copilot'))
    expect(envOfSpawn('copilot')?.GITHUB_TOKEN).toBe('github-test-token')

    vi.unstubAllEnvs()
  })

  it('process.env の CLAUDE_API_KEY 自体は消さない（直接 API 経路が使っている）', async () => {
    // `apps/api/src/ctoAi/specAnalyzer.ts` は Anthropic API を直接叩く別経路であり、
    // 本変更の対象外。spawn env へ渡さないだけで、変数そのものは触らない。
    vi.stubEnv('CLAUDE_API_KEY', 'still-present-for-other-callers')

    await createAiCliAdapter({ provider: 'claude_code' }).run(requestFor('claude_code'))

    expect(process.env.CLAUDE_API_KEY).toBe('still-present-for-other-callers')

    vi.unstubAllEnvs()
  })
})
