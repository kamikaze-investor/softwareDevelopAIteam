/**
 * copilotRouter テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * spawnSync をモックして callCopilotForMetaReview の挙動を検証する。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { callCopilotForMetaReview, DEFAULT_COPILOT_META_REVIEW_MODEL } from './copilotRouter.js'

const mockSpawnSync = vi.mocked(spawnSync)

function success(stdout: string): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
}

function failure(status: number, stderr: string): ReturnType<typeof spawnSync> {
  return { status, stdout: '', stderr, pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('callCopilotForMetaReview', () => {
  it('成功時は stdout を返す', () => {
    mockSpawnSync.mockReturnValue(success('{"status":"approved"}'))

    const result = callCopilotForMetaReview('review this diff')

    expect(result).toBe('{"status":"approved"}')
  })

  it('既定モデルは mai-code-1.1-flash（Microsoft系, 実測確認済み）を使う', () => {
    mockSpawnSync.mockReturnValue(success('ok'))

    callCopilotForMetaReview('prompt')

    const args = mockSpawnSync.mock.calls[0][1] as string[]
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe(DEFAULT_COPILOT_META_REVIEW_MODEL)
  })

  it('--yolo / --allow-all / --allow-all-tools を一切渡さない', () => {
    mockSpawnSync.mockReturnValue(success('ok'))

    callCopilotForMetaReview('prompt')

    const args = mockSpawnSync.mock.calls[0][1] as string[]
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--allow-all')
    expect(args).not.toContain('--allow-all-tools')
    expect(args.some(a => a.startsWith('--allow-tool'))).toBe(false)
  })

  it('cwd をリポジトリ外の一時ディレクトリに固定する（2026-08-26 独立レビュー: --allow-toolなしでも cwd 配下は確認なしで読めることを実測確認したため）', () => {
    mockSpawnSync.mockReturnValue(success('ok'))

    callCopilotForMetaReview('prompt')

    const options = mockSpawnSync.mock.calls[0][2] as { cwd?: string }
    expect(options.cwd).toBe(tmpdir())
  })

  it('子プロセスへ渡す env に秘密情報を含めない（PATH/HOME/LANG/TERM/GITHUB_TOKEN のみ、2026-08-26 独立レビュー修正）', () => {
    const originalEnv = { ...process.env }
    process.env.GEMINI_API_KEY = 'should-not-leak'
    process.env.CLAUDE_API_KEY = 'should-not-leak'
    process.env.OPENAI_API_KEY = 'should-not-leak'
    process.env.API_TOKEN = 'should-not-leak'
    process.env.GITHUB_TOKEN = 'gh-token-should-be-allowed'

    try {
      mockSpawnSync.mockReturnValue(success('ok'))

      callCopilotForMetaReview('prompt')

      const options = mockSpawnSync.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
      const env = options.env as NodeJS.ProcessEnv
      const keys = Object.keys(env).sort()
      expect(keys).toEqual(keys.filter((k) => ['PATH', 'HOME', 'LANG', 'TERM', 'GITHUB_TOKEN'].includes(k)))
      expect(env.GITHUB_TOKEN).toBe('gh-token-should-be-allowed')
      expect(env.GEMINI_API_KEY).toBeUndefined()
      expect(env.CLAUDE_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.API_TOKEN).toBeUndefined()
    } finally {
      process.env = originalEnv
    }
  })

  it('exit code != 0 のとき例外を投げる（quotaエラーを隠さない）', () => {
    mockSpawnSync.mockReturnValue(failure(1, 'authentication error'))

    expect(() => callCopilotForMetaReview('prompt')).toThrow(/authentication error/)
  })

  it('spawnSync 自体が失敗（result.error）したとき例外を投げる', () => {
    mockSpawnSync.mockReturnValue({
      status: null, stdout: '', stderr: '', pid: 1, output: [], signal: null,
      error: new Error('spawn copilot ENOENT'),
    } as unknown as ReturnType<typeof spawnSync>)

    expect(() => callCopilotForMetaReview('prompt')).toThrow(/ENOENT/)
  })

  it('stdout が空のとき例外を投げる', () => {
    mockSpawnSync.mockReturnValue(success('   '))

    expect(() => callCopilotForMetaReview('prompt')).toThrow(/応答が空/)
  })

  it('usage オプションがエラーメッセージに含まれる', () => {
    mockSpawnSync.mockReturnValue(failure(1, 'boom'))

    expect(() => callCopilotForMetaReview('prompt', { usage: 'independent_review' }))
      .toThrow(/independent_review/)
  })
})
