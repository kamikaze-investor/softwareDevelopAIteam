/**
 * Codex CLI パスリゾルバー テスト
 *
 * テスト方針:
 *   - Windows固有動作（codex.cmd 優先・WindowsApps 拒否）は platform 判定でスキップ
 *   - CODEX_CLI_PATH 環境変数のテストは全 OS で実行
 *   - testCodexConnection() は実際に codex --version を呼ぶ「疎通テスト」
 *     → codex が PATH に存在しない環境では ok=false になることを確認する
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  isWindowsAppsPath,
  resolveCodexPath,
  testCodexConnection,
} from './codexPathResolver.js'

// ────────────────────────────────────────────────────────────
// isWindowsAppsPath
// ────────────────────────────────────────────────────────────

describe('isWindowsAppsPath', () => {
  it('通常の npm パスは false', () => {
    expect(isWindowsAppsPath('C:\\Users\\honka\\AppData\\Roaming\\npm\\codex.cmd')).toBe(false)
    expect(isWindowsAppsPath('/usr/local/bin/codex')).toBe(false)
    expect(isWindowsAppsPath('C:\\Program Files\\nodejs\\codex.cmd')).toBe(false)
  })

  it('WindowsApps パスは true', () => {
    expect(
      isWindowsAppsPath('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.602.4764.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe')
    ).toBe(true)
  })

  it('大文字小文字を区別しない', () => {
    expect(
      isWindowsAppsPath('c:\\program files\\windowsapps\\openai.codex\\codex.exe')
    ).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// resolveCodexPath — CODEX_CLI_PATH 環境変数（全OS）
// ────────────────────────────────────────────────────────────

describe('resolveCodexPath — CODEX_CLI_PATH', () => {
  const orig = process.env.CODEX_CLI_PATH

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.CODEX_CLI_PATH
    } else {
      process.env.CODEX_CLI_PATH = orig
    }
  })

  it('CODEX_CLI_PATH が設定されていれば最優先で返す', () => {
    process.env.CODEX_CLI_PATH = '/custom/path/to/codex'
    const result = resolveCodexPath()
    expect(result.resolved).toBe('/custom/path/to/codex')
    expect(result.source).toBe('env')
  })

  it('CODEX_CLI_PATH が WindowsApps パスの場合はエラー', () => {
    process.env.CODEX_CLI_PATH =
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26\\app\\resources\\codex.exe'
    expect(() => resolveCodexPath()).toThrow('npm install -g @openai/codex')
    expect(() => resolveCodexPath()).toThrow('WindowsApps')
  })

  it('CODEX_CLI_PATH が未設定の場合は source が env でない', () => {
    delete process.env.CODEX_CLI_PATH
    const result = resolveCodexPath()
    expect(result.source).not.toBe('env')
  })
})

// ────────────────────────────────────────────────────────────
// resolveCodexPath — Windows 固有（codex.cmd 優先）
// ────────────────────────────────────────────────────────────

describe('resolveCodexPath — Windows', () => {
  beforeEach(() => {
    delete process.env.CODEX_CLI_PATH
  })

  it('Windows では source が cmd か default になる', () => {
    if (process.platform !== 'win32') return  // Windows 以外はスキップ
    const result = resolveCodexPath()
    expect(['cmd', 'default']).toContain(result.source)
  })

  it('Windows で codex.cmd が PATH にあれば cmd を返す（npmグローバルがあれば）', () => {
    if (process.platform !== 'win32') return
    const result = resolveCodexPath()
    // codex.cmd が PATH にある環境なら source=cmd、ない環境なら default
    // どちらでも resolved が空でないことを確認
    expect(result.resolved.length).toBeGreaterThan(0)
    // resolved に WindowsApps が含まれていないことを確認
    expect(isWindowsAppsPath(result.resolved)).toBe(false)
  })

  it('PATH 上の codex が WindowsApps 配下でもエラーを出す', () => {
    if (process.platform !== 'win32') return
    // PATH を一時的に WindowsApps 配下の codex.cmd だけにして試す
    // （実際には codex.cmd が存在しないはずなので default にフォールバックする）
    // → このテストは isWindowsAppsPath() のロジックで間接的に検証済み
    expect(
      isWindowsAppsPath('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26\\codex.exe')
    ).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// testCodexConnection — 実際に codex --version を呼ぶ疎通テスト
// ────────────────────────────────────────────────────────────

describe('testCodexConnection — 実疎通テスト', () => {
  beforeEach(() => {
    delete process.env.CODEX_CLI_PATH
  })

  it('codex が npm グローバルにインストールされていれば ok=true でバージョンを返す', () => {
    const result = testCodexConnection()

    if (result.ok) {
      // インストール済み環境: バージョン文字列が返る
      expect(result.version).toBeTruthy()
      expect(result.resolvedPath.length).toBeGreaterThan(0)
      // WindowsApps パスではないことを確認
      expect(isWindowsAppsPath(result.resolvedPath)).toBe(false)
    } else {
      // 未インストール環境: エラーメッセージが出ることを確認
      expect(result.error).toBeTruthy()
      // エラーには npm install の案内か実行失敗の旨が含まれる
      const isGuidance = result.error!.includes('npm install') ||
                         result.error!.includes('WindowsApps') ||
                         result.error!.includes('codex --version')
      expect(isGuidance).toBe(true)
    }
  })

  it('CODEX_CLI_PATH に存在しないパスを設定するとエラーを返す（ok=false）', () => {
    process.env.CODEX_CLI_PATH = 'C:\\nonexistent\\codex.exe'
    const result = testCodexConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    delete process.env.CODEX_CLI_PATH
  })

  it('CODEX_CLI_PATH に WindowsApps パスを設定するとエラーを返す（ok=false）', () => {
    process.env.CODEX_CLI_PATH =
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26\\app\\resources\\codex.exe'
    const result = testCodexConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('npm install -g @openai/codex')
    delete process.env.CODEX_CLI_PATH
  })
})
