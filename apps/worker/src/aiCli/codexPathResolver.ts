/**
 * Codex CLI パスリゾルバー
 *
 * 目的:
 *   Windows では `codex` の実体が WindowsApps（UWP 保護領域）にある場合、
 *   外部プロセスから直接実行できず "Access is denied" になる。
 *   npm グローバルインストール（`npm install -g @openai/codex`）された
 *   `codex.cmd` / `codex` を優先して使うことで安定した呼び出しを実現する。
 *
 * 解決順序:
 *   1. CODEX_CLI_PATH 環境変数（最優先）
 *   2. Windows: codex.cmd（npm グローバル）
 *   3. その他: codex
 *
 * 禁止パス:
 *   WindowsApps / AppData\Local\Microsoft\WindowsApps 配下は直接実行できないため拒否。
 *   → npm install -g @openai/codex を案内する。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// ────────────────────────────────────────────────────────────
// WindowsApps 検出
// ────────────────────────────────────────────────────────────

const WINDOWS_PROTECTED_PREFIXES = [
  'C:\\Program Files\\WindowsApps',
  'C:\\Program Files (x86)\\WindowsApps',
]

// LOCALAPPDATA は通常 C:\Users\<user>\AppData\Local
const localAppData = process.env.LOCALAPPDATA ?? ''
if (localAppData) {
  WINDOWS_PROTECTED_PREFIXES.push(
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
  )
}

export function isWindowsAppsPath(p: string): boolean {
  const normalized = path.normalize(p).toLowerCase()
  return WINDOWS_PROTECTED_PREFIXES.some(prefix =>
    normalized.startsWith(prefix.toLowerCase())
  )
}

// ────────────────────────────────────────────────────────────
// パス解決
// ────────────────────────────────────────────────────────────

export interface CodexPathResult {
  resolved: string
  source: 'env' | 'cmd' | 'default'
}

/**
 * 実際に呼ぶべき codex CLI のパスを解決する。
 * WindowsApps 配下だった場合は Error を throw する。
 */
export function resolveCodexPath(): CodexPathResult {
  // 1. 環境変数が最優先
  const envPath = process.env.CODEX_CLI_PATH
  if (envPath) {
    if (isWindowsAppsPath(envPath)) {
      throwWindowsAppsError(envPath, 'CODEX_CLI_PATH')
    }
    return { resolved: envPath, source: 'env' }
  }

  // 2. Windows: codex.cmd を探す（npm グローバルインストール）
  if (process.platform === 'win32') {
    const npmGlobalCmd = findNpmGlobalCmd('codex.cmd')
    if (npmGlobalCmd) {
      if (isWindowsAppsPath(npmGlobalCmd)) {
        throwWindowsAppsError(npmGlobalCmd, 'codex.cmd in PATH')
      }
      return { resolved: npmGlobalCmd, source: 'cmd' }
    }
  }

  // 3. デフォルト: `codex`（PATH から解決される）
  //    where/which で実体パスを確認して WindowsApps かチェックする
  const whichPath = tryWhich('codex')
  if (whichPath && isWindowsAppsPath(whichPath)) {
    throwWindowsAppsError(whichPath, 'codex in PATH')
  }

  return { resolved: 'codex', source: 'default' }
}

// ────────────────────────────────────────────────────────────
// 疎通テスト（codex --version）
// ────────────────────────────────────────────────────────────

export interface CodexVersionResult {
  ok: boolean
  version?: string
  error?: string
  resolvedPath: string
}

/**
 * 実際に `codex --version` を呼んで疎通確認する。
 * dryRun ではなく実際に execFileSync を呼ぶ。
 */
export function testCodexConnection(): CodexVersionResult {
  let resolved: string
  try {
    const result = resolveCodexPath()
    resolved = result.resolved
  } catch (err: any) {
    return { ok: false, error: err.message, resolvedPath: 'unknown' }
  }

  try {
    const stdout = execFileSync(resolved, ['--version'], {
      shell: false,
      timeout: 10_000,
      encoding: 'utf-8',
    }).trim()

    return { ok: true, version: stdout, resolvedPath: resolved }
  } catch (err: any) {
    const stderr = typeof err.stderr === 'string' ? err.stderr : String(err)
    return {
      ok: false,
      error: `codex --version 失敗: ${stderr || err.message}`,
      resolvedPath: resolved,
    }
  }
}

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

function findNpmGlobalCmd(cmdName: string): string | null {
  // PATH の各エントリを走査して cmdName を探す
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of pathDirs) {
    const full = path.join(dir, cmdName)
    if (existsSync(full)) return full
  }
  return null
}

function tryWhich(cmd: string): string | null {
  try {
    const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = execFileSync(whichCmd, [cmd], {
      shell: false,
      timeout: 5_000,
      encoding: 'utf-8',
    }).trim()
    // where.exe は複数行返すことがある → 最初の行だけ使う
    return result.split('\n')[0]?.trim() ?? null
  } catch {
    return null
  }
}

function throwWindowsAppsError(foundPath: string, source: string): never {
  throw new Error(
    `[CodexAdapter] ${source} が Windows Store アプリ領域 (WindowsApps) を指しています。\n` +
    `  検出パス: ${foundPath}\n` +
    `\n` +
    `  Windows Store 版 Codex は外部プロセスから直接実行できません（Access is denied）。\n` +
    `  npm グローバルインストール版を使用してください:\n` +
    `\n` +
    `    npm install -g @openai/codex\n` +
    `\n` +
    `  インストール後に PATH を確認: where codex\n` +
    `  または環境変数で明示指定: CODEX_CLI_PATH=C:\\Users\\<name>\\AppData\\Roaming\\npm\\codex.cmd`
  )
}
