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
import { realpathSync } from 'node:fs'

// Control Repository の絶対パス（環境変数で上書き可能）
const CONTROL_ROOT = path.resolve(
  process.env.CONTROL_ROOT ?? path.join(__dirname, '../../../../'),
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

// ────────────────────────────────────────────────────────────
// Context Pack 用の読み取り範囲（security fix）
// ────────────────────────────────────────────────────────────

/**
 * 設定済みの target root。`routes/ctoAi.ts` と同じ規則（`TARGET_ROOT ?? /workspace/target`）で、
 * 呼び出しごとに読む（テスト・設定変更に追従するため）。
 */
export function configuredTargetRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.TARGET_ROOT || '/workspace/target')
}

/** パス文字列として受け付けない入力（NUL 等の制御文字）。 */
function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f]/.test(value)
}

/** `..` を**セグメントとして**含むか（`a..b` のようなファイル名は許す）。 */
function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes('..')
}

export type ContextPackRootResult = { ok: true; realRoot: string } | { ok: false; reason: string }

/**
 * `POST /api/context-pack` の targetProjectRoot を検証し、読み取りの基準になる realpath を返す。
 *
 * **拒否リストではなく allowlist**: 受け付けるのは設定済み target root そのものだけである
 * （`/srv`・`/home`・`/tmp` 等を個別に塞ぐのではなく、それ以外を全部拒否する）。
 * 要求値は正規化の前後どちらで比べても一致しなければならず、realpath も設定 root の realpath と
 * 一致しなければならない（別名の symlink から同じ場所へ到達させない）。root が存在しなければ拒否する。
 */
export function resolveContextPackRoot(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): ContextPackRootResult {
  if (requested.trim() === '' || hasControlCharacter(requested)) {
    return { ok: false, reason: 'targetProjectRoot が不正です' }
  }
  if (!path.isAbsolute(requested) || hasParentSegment(requested)) {
    return { ok: false, reason: 'targetProjectRoot は ".." を含まない絶対パスで指定してください' }
  }
  const configured = configuredTargetRoot(env)
  if (path.resolve(requested) !== configured) {
    return { ok: false, reason: 'targetProjectRoot は設定済みの target root と一致しなければなりません' }
  }
  let realRequested: string
  let realConfigured: string
  try {
    realRequested = realpathSync(requested)
    realConfigured = realpathSync(configured)
  } catch {
    return { ok: false, reason: 'target root が存在しません' }
  }
  if (realRequested !== realConfigured) {
    return { ok: false, reason: 'targetProjectRoot は設定済みの target root と一致しなければなりません' }
  }
  return { ok: true, realRoot: realConfigured }
}

/**
 * context-pack の allowedPaths を検証する。root の内側を指すことを**区切り文字込みで**確かめる
 * （`/ws` に対して `/ws-evil/...` を通さない）。symlink の最終的な行き先は読み取り時に realpath で判定する。
 */
export function validateContextPackAllowedPaths(allowedPaths: readonly string[], root: string): PathGuardResult {
  const resolvedRoot = path.resolve(root)
  for (const entry of allowedPaths) {
    if (entry.trim() === '' || hasControlCharacter(entry) || hasParentSegment(entry)) {
      return { ok: false, reason: `allowedPaths が不正です: ${JSON.stringify(entry)}` }
    }
    const resolved = path.resolve(resolvedRoot, entry)
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, reason: `allowedPaths は targetProjectRoot 配下のみ許可されます: ${entry}` }
    }
  }
  return { ok: true }
}

/** realpath が root（realpath 済み）の内側なら、その realpath を返す。外・存在しない・読めないなら undefined。 */
export function containedRealPath(realRoot: string, candidate: string): string | undefined {
  try {
    const real = realpathSync(candidate)
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : undefined
  } catch {
    return undefined
  }
}
