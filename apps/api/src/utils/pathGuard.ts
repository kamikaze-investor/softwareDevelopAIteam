/**
 * Path Guard — targetProjectRoot / allowedPaths の境界検証
 *
 * [codex-review P1修正]
 *
 * API が受け取る targetProjectRoot は任意のパスを指定できてしまうため、
 * Control Repository や OS ルートへの読み書きを防ぐ。
 *
 * ルール:
 *   1. 絶対パスであること（相対パスによるトラバーサル防止）
 *   2. `..\` / `../` を含まないこと（パストラバーサル防止）
 *   3. Control Repository（このリポジトリ）を指さないこと
 *   4. OS の危険パス（/ C:\Windows 等）を指さないこと
 */

import path from 'node:path'

// Control Repository の絶対パス（環境変数で上書き可能）
const CONTROL_ROOT = path.resolve(
  process.env.CONTROL_ROOT ?? path.join(import.meta.dirname ?? __dirname, '../../../../'),
)

// 絶対に許可しないパスの prefix リスト
const FORBIDDEN_PREFIXES = [
  CONTROL_ROOT,
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/root',
  '/var',
  '/sys',
  '/proc',
]

export interface PathGuardResult {
  ok: boolean
  reason?: string
}

/**
 * targetProjectRoot が安全かどうか検証する
 */
export function validateTargetRoot(targetRoot: string): PathGuardResult {
  // 1. 空チェック
  if (!targetRoot || targetRoot.trim() === '') {
    return { ok: false, reason: 'targetProjectRoot が空です' }
  }

  // 2. パストラバーサルチェック
  if (targetRoot.includes('..')) {
    return { ok: false, reason: 'targetProjectRoot に ".." を含めることはできません' }
  }

  // 3. 絶対パスチェック
  if (!path.isAbsolute(targetRoot)) {
    return { ok: false, reason: 'targetProjectRoot は絶対パスで指定してください' }
  }

  const normalized = path.normalize(targetRoot)

  // 4. Control Repository チェック
  if (normalized.startsWith(CONTROL_ROOT)) {
    return {
      ok: false,
      reason: `targetProjectRoot が Control Repository (${CONTROL_ROOT}) を指しています。target-project のパスを指定してください`,
    }
  }

  // 5. 危険パスチェック
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (normalized.startsWith(forbidden)) {
      return {
        ok: false,
        reason: `targetProjectRoot に禁止パス (${forbidden}) は指定できません`,
      }
    }
  }

  return { ok: true }
}

/**
 * allowedPaths の各エントリを検証する
 * allowedPaths は相対パス（target-project 基準）か
 * target-project 配下の絶対パスのみ許可
 */
export function validateAllowedPaths(
  allowedPaths: string[],
  targetRoot: string,
): PathGuardResult {
  for (const p of allowedPaths) {
    // ".." によるトラバーサル禁止
    if (p.includes('..')) {
      return { ok: false, reason: `allowedPaths に ".." を含めることはできません: ${p}` }
    }

    // 絶対パスの場合は targetRoot 配下に限定
    if (path.isAbsolute(p)) {
      const normalized = path.normalize(p)
      const normalizedRoot = path.normalize(targetRoot)
      if (!normalized.startsWith(normalizedRoot)) {
        return {
          ok: false,
          reason: `allowedPaths の絶対パスは targetProjectRoot 配下のみ許可されます: ${p}`,
        }
      }
    }
  }

  return { ok: true }
}
