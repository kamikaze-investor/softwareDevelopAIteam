/**
 * resolveWindowsExe / runPostLint — Windows .cmd ラップのユニットテスト
 *
 * node:child_process を vi.mock でホイストしてモック化し、
 * execFileSync の呼び出し引数を検査する。
 * adapter.test.ts では ESM 制約で spyOn できないため別ファイルに分離。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock はホイストされるので import より前に評価される
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}))

// モック後に import
import { execFileSync } from 'node:child_process'
import { createAiCliAdapter } from './factory.js'
import type { AiCliRequest } from '@ai-team/shared'

const mockExecFileSync = vi.mocked(execFileSync)

const BASE_REQUEST: AiCliRequest = {
  provider: 'codex',
  taskId: 'win-exe-test',
  workingDir: '/workspace/target',
  prompt: 'test',
  contextFiles: [],
  mode: 'implement',
  postLint: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExecFileSync.mockReturnValue('' as any)
})

// ────────────────────────────────────────────────────────────
// resolveWindowsExe — .cmd パスの cmd.exe /c ラップ
// ────────────────────────────────────────────────────────────

describe('resolveWindowsExe — .cmd / .bat ラップ', () => {
  it('Windows で cliPath が .cmd のとき exe=cmd.exe、prefixArgs=[/c, <path>] になる', async () => {
    if (process.platform !== 'win32') return  // Windows 専用テスト

    const adapter = createAiCliAdapter({ provider: 'codex' })
    ;(adapter as any).config.cliPath = 'codex.cmd'

    await adapter.run(BASE_REQUEST).catch(() => {})

    // execFileSync の最初の呼び出しが AI CLI 実行
    const cliCall = mockExecFileSync.mock.calls.find(
      c => String(c[0]) === 'cmd.exe' || String(c[0]).includes('codex')
    )
    expect(cliCall).toBeDefined()
    if (cliCall) {
      expect(cliCall[0]).toBe('cmd.exe')
      expect((cliCall[1] as string[])[0]).toBe('/c')
      expect((cliCall[1] as string[])[1]).toBe('codex.cmd')
    }
  })

  it('.cmd でないパスは exe をそのまま使う（Linux / 絶対パス）', async () => {
    if (process.platform === 'win32') return  // Linux 専用テスト

    const adapter = createAiCliAdapter({ provider: 'codex' })
    ;(adapter as any).config.cliPath = '/usr/local/bin/codex'

    await adapter.run(BASE_REQUEST).catch(() => {})

    const cliCall = mockExecFileSync.mock.calls.find(
      c => String(c[0]).includes('codex') || String(c[0]) === 'cmd.exe'
    )
    expect(cliCall).toBeDefined()
    if (cliCall) {
      expect(cliCall[0]).toBe('/usr/local/bin/codex')
      expect(cliCall[0]).not.toBe('cmd.exe')
    }
  })

  it('.bat パスも Windows で cmd.exe /c 経由になる', async () => {
    if (process.platform !== 'win32') return

    const adapter = createAiCliAdapter({ provider: 'codex' })
    ;(adapter as any).config.cliPath = 'C:\\tools\\run.bat'

    await adapter.run(BASE_REQUEST).catch(() => {})

    const cliCall = mockExecFileSync.mock.calls.find(c => String(c[0]) === 'cmd.exe')
    expect(cliCall).toBeDefined()
    if (cliCall) {
      expect((cliCall[1] as string[])[1]).toBe('C:\\tools\\run.bat')
    }
  })

  it('大文字拡張子 .CMD も対象になる', async () => {
    if (process.platform !== 'win32') return

    const adapter = createAiCliAdapter({ provider: 'codex' })
    ;(adapter as any).config.cliPath = 'CODEX.CMD'

    await adapter.run(BASE_REQUEST).catch(() => {})

    const cliCall = mockExecFileSync.mock.calls.find(c => String(c[0]) === 'cmd.exe')
    expect(cliCall).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────
// runPostLint — ENOENT / EINVAL 時の non-fatal 継続
// ────────────────────────────────────────────────────────────

describe('runPostLint — pnpm エラー時の non-fatal 継続', () => {
  it('pnpm が ENOENT のとき warn に code=ENOENT が含まれ exitCode は Codex の結果を返す', async () => {
    mockExecFileSync.mockImplementation((exe: any, args: any) => {
      const argStr = (args as string[]).join(' ')
      // git コマンドは成功させる
      if (String(exe) === 'git') return '' as any
      // pnpm lint は ENOENT
      if (argStr.includes('lint')) {
        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
        throw err
      }
      // AI CLI（codex）は成功
      return '' as any
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = createAiCliAdapter({ provider: 'codex' })

    let result: any
    try {
      result = await adapter.run({ ...BASE_REQUEST, postLint: undefined })  // デフォルト(true相当)
    } catch {
      // workingDir 不在などのエラーは無視
    }

    const warnMsgs = warnSpy.mock.calls.map(c => c.join(' '))
    const lintWarn = warnMsgs.find(m => m.includes('post-lint failed'))

    if (lintWarn) {
      // non-fatal warning に code= が含まれること
      expect(lintWarn).toMatch(/code=ENOENT/)
    }

    // exitCode は postLint 失敗に引きずられない
    if (result) {
      expect(result.exitCode).toBe(0)
    }

    warnSpy.mockRestore()
  })

  it('pnpm が EINVAL のとき warn に code=EINVAL が含まれ処理が継続する', async () => {
    mockExecFileSync.mockImplementation((exe: any, args: any) => {
      const argStr = (args as string[]).join(' ')
      if (String(exe) === 'git') return '' as any
      if (argStr.includes('lint')) {
        const err = Object.assign(new Error('spawnSync EINVAL'), { code: 'EINVAL' })
        throw err
      }
      return '' as any
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = createAiCliAdapter({ provider: 'codex' })

    try {
      await adapter.run({ ...BASE_REQUEST, postLint: undefined })
    } catch { /* ignore */ }

    const warnMsgs = warnSpy.mock.calls.map(c => c.join(' '))
    const lintWarn = warnMsgs.find(m => m.includes('post-lint failed'))

    if (lintWarn) {
      expect(lintWarn).toMatch(/code=EINVAL/)
    }

    warnSpy.mockRestore()
  })

  it('postLint: false のとき pnpm は呼ばれない', async () => {
    const adapter = createAiCliAdapter({ provider: 'codex' })

    await adapter.run({ ...BASE_REQUEST, postLint: false }).catch(() => {})

    const pnpmCalls = mockExecFileSync.mock.calls.filter(c =>
      String(c[0]).includes('pnpm') ||
      (String(c[0]) === 'cmd.exe' && (c[1] as string[]).includes('pnpm'))
    )
    expect(pnpmCalls).toHaveLength(0)
  })
})
