/**
 * copilotRouter テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * spawnSync をモックして callCopilotForMetaReview の挙動を検証する。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
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

  it('--available-tools（値なし）を渡し、ツール自体を無効化する（2026-08-26 独立レビュー round2: --allow-tool なしだけでは非対話モードでファイルアクセスが確認なしで実行されることを実測確認したため、--available-tools 空allowlistで完全に無効化する）', () => {
    mockSpawnSync.mockReturnValue(success('ok'))

    callCopilotForMetaReview('prompt')

    const args = mockSpawnSync.mock.calls[0][1] as string[]
    expect(args).toContain('--available-tools')
    // 値を伴わない（次の要素は別のフラグか末尾であるべき、モデル名等の値ではない）
    const idx = args.indexOf('--available-tools')
    expect(idx).toBe(args.length - 1)
  })

  it('cwd をリポジトリ外の使い捨て一時ディレクトリに固定し、実行後に削除する（2026-08-26 独立レビュー round2: bare tmpdir() は他ステップと共有されるため不十分と指摘され、呼び出しごとの一意ディレクトリへ変更）', () => {
    mockSpawnSync.mockReturnValue(success('ok'))

    callCopilotForMetaReview('prompt')

    const options = mockSpawnSync.mock.calls[0][2] as { cwd?: string }
    expect(options.cwd).toBeDefined()
    expect(options.cwd).not.toBe(tmpdir())
    expect((options.cwd as string).startsWith(tmpdir())).toBe(true)
    // 実行後にクリーンアップされている（残存しない）
    expect(existsSync(options.cwd as string)).toBe(false)
  })

  it('子プロセスへ渡す env に秘密情報を含めない（PATH/HOME/LANG/TERM/GITHUB_TOKEN のみ、2026-08-26 独立レビュー修正）', () => {
    const originalEnv = { ...process.env }
    process.env.GEMINI_API_KEY = 'should-not-leak'
    process.env.CLAUDE_API_KEY = 'should-not-leak'
    process.env.OPENAI_API_KEY = 'should-not-leak'
    process.env.API_TOKEN = 'should-not-leak'
    // production では designReviewCoordinator.ts の buildRunnerEnv() が
    // COPILOT_GITHUB_TOKEN のみを子プロセスへ渡す（GITHUB_TOKEN 自体は渡ってこない）。
    // copilot CLI 自体が要求する変数名は GITHUB_TOKEN のままなので、ここで詰め替える。
    delete process.env.GITHUB_TOKEN
    process.env.COPILOT_GITHUB_TOKEN = 'gh-token-should-be-allowed'

    try {
      mockSpawnSync.mockReturnValue(success('ok'))

      callCopilotForMetaReview('prompt')

      const options = mockSpawnSync.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
      const env = options.env as NodeJS.ProcessEnv
      const keys = Object.keys(env).sort()
      expect(keys).toEqual(keys.filter((k) => ['PATH', 'HOME', 'LANG', 'TERM', 'GITHUB_TOKEN'].includes(k)))
      expect(env.GITHUB_TOKEN).toBe('gh-token-should-be-allowed')
      expect(env).not.toHaveProperty('COPILOT_GITHUB_TOKEN')
      expect(env.GEMINI_API_KEY).toBeUndefined()
      expect(env.CLAUDE_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.API_TOKEN).toBeUndefined()
    } finally {
      process.env = originalEnv
    }
  })

  it('COPILOT_GITHUB_TOKEN が未設定なら GITHUB_TOKEN も渡さない（プレーンな GITHUB_TOKEN 単体では認証しない）', () => {
    const originalEnv = { ...process.env }
    delete process.env.COPILOT_GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'plain-github-token-must-not-leak'

    try {
      mockSpawnSync.mockReturnValue(success('ok'))

      callCopilotForMetaReview('prompt')

      const options = mockSpawnSync.mock.calls[0][2] as { env?: NodeJS.ProcessEnv }
      const env = options.env as NodeJS.ProcessEnv
      expect(env).not.toHaveProperty('GITHUB_TOKEN')
    } finally {
      process.env = originalEnv
    }
  })

  it('exit code != 0 が3回続いたとき最後の失敗内容で例外を投げる（quotaエラーを隠さない）', () => {
    mockSpawnSync.mockReturnValue(failure(1, 'authentication error'))

    expect(() => callCopilotForMetaReview('prompt', { sleepImpl: () => {} })).toThrow(/authentication error/)
    expect(mockSpawnSync).toHaveBeenCalledTimes(3)
  })

  it('spawnSync 自体が失敗（result.error）したとき3回retryしたうえで例外を投げる', () => {
    mockSpawnSync.mockReturnValue({
      status: null, stdout: '', stderr: '', pid: 1, output: [], signal: null,
      error: new Error('spawn copilot ENOENT'),
    } as unknown as ReturnType<typeof spawnSync>)

    expect(() => callCopilotForMetaReview('prompt', { sleepImpl: () => {} })).toThrow(/ENOENT/)
    expect(mockSpawnSync).toHaveBeenCalledTimes(3)
  })

  it('stdout が空の応答が3回続いたとき例外を投げる', () => {
    mockSpawnSync.mockReturnValue(success('   '))

    expect(() => callCopilotForMetaReview('prompt', { sleepImpl: () => {} })).toThrow(/応答が空/)
    expect(mockSpawnSync).toHaveBeenCalledTimes(3)
  })

  it('usage オプションがエラーメッセージに含まれる', () => {
    mockSpawnSync.mockReturnValue(failure(1, 'boom'))

    expect(() => callCopilotForMetaReview('prompt', { usage: 'independent_review', sleepImpl: () => {} }))
      .toThrow(/independent_review/)
  })
})

describe('callCopilotForMetaReview bounded retry (attempt 1 -> 10s -> attempt 2 -> 30s -> attempt 3 -> fail-closed)', () => {
  it('1回目失敗・2回目成功なら2回で成功を返し、2回だけsleepせず1回だけsleepする', () => {
    mockSpawnSync
      .mockReturnValueOnce(failure(1, 'transient error'))
      .mockReturnValueOnce(success('ok-on-attempt-2'))
    const sleepImpl = vi.fn()

    const result = callCopilotForMetaReview('prompt', { sleepImpl })

    expect(result).toBe('ok-on-attempt-2')
    expect(mockSpawnSync).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledTimes(1)
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10_000)
  })

  it('1・2回目失敗、3回目成功なら3回で成功を返し、10秒→30秒の順でsleepする', () => {
    mockSpawnSync
      .mockReturnValueOnce(failure(1, 'transient error 1'))
      .mockReturnValueOnce(failure(1, 'transient error 2'))
      .mockReturnValueOnce(success('ok-on-attempt-3'))
    const sleepImpl = vi.fn()

    const result = callCopilotForMetaReview('prompt', { sleepImpl })

    expect(result).toBe('ok-on-attempt-3')
    expect(mockSpawnSync).toHaveBeenCalledTimes(3)
    expect(sleepImpl).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10_000)
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 30_000)
  })

  it('3回とも失敗したら既存のfail-closedどおり最後の失敗内容で例外を投げ、4回目は呼ばない', () => {
    mockSpawnSync
      .mockReturnValueOnce(failure(1, 'attempt 1 failed'))
      .mockReturnValueOnce(failure(1, 'attempt 2 failed'))
      .mockReturnValueOnce(failure(1, 'attempt 3 failed'))
    const sleepImpl = vi.fn()

    expect(() => callCopilotForMetaReview('prompt', { sleepImpl })).toThrow(/attempt 3 failed/)
    expect(mockSpawnSync).toHaveBeenCalledTimes(3)
    expect(sleepImpl).toHaveBeenCalledTimes(2)
  })

  it('1回目で成功したら追加retryせず、sleepも呼ばない', () => {
    mockSpawnSync.mockReturnValueOnce(success('ok-on-attempt-1'))
    const sleepImpl = vi.fn()

    const result = callCopilotForMetaReview('prompt', { sleepImpl })

    expect(result).toBe('ok-on-attempt-1')
    expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    expect(sleepImpl).not.toHaveBeenCalled()
  })
})
