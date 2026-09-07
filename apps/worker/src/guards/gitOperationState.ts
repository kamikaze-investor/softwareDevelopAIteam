/**
 * 進行中の git 操作検出（PR-C workspace baseline 用）
 *
 * Worker クラッシュ後の起動時、workspace が「クラッシュした Job が見たまま」かどうかを
 * 判断する前に、git 操作が中途半端な状態で残っていないかを確認する。
 * `index.lock` や `MERGE_HEAD` 等のマーカーが残っている workspace は
 * そのまま baseline 化せず、別扱い（quarantine 等）にするため検出する。
 *
 * 本モジュールは pure / read-only であり、repo に対していかなる変更も行わない。
 * 検出結果は決定的（固定順で返す）にしてユニットテスト可能にする。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { assertWorktreeRoot } from './changeManifest.js'

/** git 操作マーカー検出の失敗を表す。呼び出し元は fail-closed で扱う */
export class GitOperationStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitOperationStateError'
  }
}

const GIT_TIMEOUT_MS = 10_000

/** `git rev-parse --git-path <name>` で実 git ディレクトリ配下のマーカー path を解決する */
function resolveGitPath(workingDir: string, name: string): string {
  try {
    const resolved = execFileSync('git', ['rev-parse', '--git-path', name], {
      cwd: workingDir,
      shell: false,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (resolved === '') {
      throw new GitOperationStateError(`git rev-parse --git-path ${name} returned empty for "${workingDir}"`)
    }
    // `--git-path` は git 実行 cwd（workingDir）基準の相対パスを返すことがあるため、
    // Node プロセスの cwd ではなく workingDir を基準に絶対化する。
    return path.resolve(workingDir, resolved)
  } catch (err: unknown) {
    if (err instanceof GitOperationStateError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new GitOperationStateError(
      `git rev-parse --git-path ${name} failed in ${workingDir}: ${message}`,
    )
  }
}

/**
 * ファイル型・ディレクトリ型マーカー。
 * `resolveGitPath` を使うため、linked worktree（.git が file）でも
 * 実 git ディレクトリ（共通の .git）配下の正しい path を参照できる。
 */
const FILE_MARKERS: Array<{ operation: string; name: string }> = [
  { operation: 'index.lock', name: 'index.lock' },
  { operation: 'merge', name: 'MERGE_HEAD' },
  { operation: 'cherry-pick', name: 'CHERRY_PICK_HEAD' },
  { operation: 'revert', name: 'REVERT_HEAD' },

  // 独立レビュー指摘（PR-C）: 以下は HEAD も worktree も変化させないまま残り得るため、
  // 検出漏れがあると「変化なし」と誤判定して ownership を解放してしまう。
  { operation: 'bisect', name: 'BISECT_START' },
  { operation: 'head.lock', name: 'HEAD.lock' },
  { operation: 'packed-refs.lock', name: 'packed-refs.lock' },
  { operation: 'shallow.lock', name: 'shallow.lock' },
]

const DIR_MARKERS: Array<{ operation: string; name: string }> = [
  { operation: 'rebase-merge', name: 'rebase-merge' },
  { operation: 'rebase-apply', name: 'rebase-apply' },
  { operation: 'sequencer', name: 'sequencer' },
]

/** ref lock ファイル（refs/ 配下の *.lock）を再帰的に収集する。無ければ空配列 */
function findRefLockFiles(refsDir: string): string[] {
  const found: string[] = []
  const stack: string[] = [refsDir]

  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    if (!existsSync(dir)) continue

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // refs 配下の一部が読めない場合、lock 検出を安全側へ倒すため
      // 検出不能として扱う（検出漏れより false positive が安全）
      throw new GitOperationStateError(`Failed to read refs directory "${dir}"`)
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.lock')) {
        found.push(absolute)
      }
    }
  }

  return found.sort()
}

/**
 * 進行中の git 操作を検出し、operation 識別子のリストで返す。
 * 未検出（クリーン）の場合は空配列を返す。
 *
 * 検出対象: index.lock / MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD /
 * rebase-merge/ / rebase-apply/ / sequencer/ / refs 配下の *.lock。
 * 返り値の順序は決定的。
 */
export function detectGitOperationState(workingDir: string): string[] {
  // workingDir 自身が worktree root であることを既存ヘルパーで確認する。
  // これが無いと、workingDir が repo でない場合に git が上位ディレクトリの repo を
  // 解決してしまい、無関係な repo のマーカーを見てしまう（実測: %TEMP% が
  // C:/Users/honka の repo 配下に入る環境がある）。fail-closed。
  assertWorktreeRoot(workingDir)

  const detected: string[] = []

  for (const marker of FILE_MARKERS) {
    if (existsSync(resolveGitPath(workingDir, marker.name))) {
      detected.push(marker.operation)
    }
  }

  for (const marker of DIR_MARKERS) {
    if (existsSync(resolveGitPath(workingDir, marker.name))) {
      detected.push(marker.operation)
    }
  }

  if (findRefLockFiles(resolveGitPath(workingDir, 'refs')).length > 0) {
    detected.push('refs.lock')
  }

  return detected
}