/**
 * authoritative repositoryから Canonical Change Manifest を構築する。
 *
 * 2つの経路を持ち、**同一の正規形**を返す:
 *   1. worktree（Gate ALLOW時点）: HEAD と作業ツリーの差分
 *   2. commit（commit後）: parent A と commit B の差分
 *
 * 使うのはgit primitiveだけ（diff --raw / diff-tree --raw / status --porcelain=v2 /
 * hash-object）。新しいframeworkは作らない。
 *
 * Git blob IDはcontentの暗号学的identityなので、commit前後で同じ値が得られる。
 * これが「pre-commit ALLOW対象」と「post-commit B」を結び付けられる理由である。
 */

import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELETED_BLOB_MARKER,
  type ChangeKind,
  type ChangeManifestEntry,
} from './changeManifestIdentity'

export class ChangeManifestReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ChangeManifestReadError'
  }
}

const MAX_BUFFER_BYTES = 32 * 1024 * 1024

function git(workingDir: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: workingDir,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ChangeManifestReadError(`git ${args[0]} failed: ${message}`, { cause: error })
  }
}

function splitNul(raw: string): string[] {
  const parts = raw.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** mode から Git object type を決める。submodule（gitlink）だけ commit になる。 */
function objectTypeForMode(mode: string): string {
  return mode === '160000' ? 'commit' : 'blob'
}

function kindFromRawStatus(status: string): ChangeKind {
  const head = status[0]
  if (head === 'A') return 'add'
  if (head === 'D') return 'delete'
  // M（内容変更）/ T（type変更）/ R・C（rename/copyはdelete+addへ展開済み）はmodify扱い
  return 'modify'
}

function deletedEntry(path: string): ChangeManifestEntry {
  return { path, kind: 'delete', blobId: DELETED_BLOB_MARKER, mode: '', objectType: '' }
}

/**
 * worktreeの実ファイルからmodeを求める（git管理外ファイル用）。
 *
 * symlinkとdirectory（submodule等）は`hash-object`の結果がcommit側の表現と一致しない
 * （symlinkはリンク先の中身をhashしてしまう）。推測して誤ったmanifestを作るより、
 * 未対応として例外にしbindを成立させない方が安全なので fail-closed にする。
 */
function worktreeMode(workingDir: string, relativePath: string): string {
  const stats = lstatSync(join(workingDir, relativePath))
  if (!stats.isFile()) {
    throw new ChangeManifestReadError(
      `Unsupported untracked entry "${relativePath}" (only regular files are supported)`,
    )
  }
  // 実行bitの有無だけを見る。manifestの両側を同一ホストで算出するため一貫する。
  return (stats.mode & 0o111) !== 0 ? '100755' : '100644'
}

function hashObject(workingDir: string, relativePath: string): string {
  return git(workingDir, ['hash-object', '--', relativePath]).trim()
}

/**
 * `git diff --raw -z <base>` / `git diff-tree --raw -z <a> <b>` の出力を解析する。
 *
 * 形式: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`
 * rename/copy は path が2つ続くため、delete + add へ展開する。
 */
function parseRawDiff(
  workingDir: string,
  raw: string,
  resolveWorktreeBlob: boolean,
): ChangeManifestEntry[] {
  const segments = splitNul(raw)
  const entries: ChangeManifestEntry[] = []

  for (let index = 0; index < segments.length; index += 1) {
    const meta = segments[index]
    if (!meta.startsWith(':')) continue

    const fields = meta.slice(1).split(' ')
    if (fields.length < 5) {
      throw new ChangeManifestReadError(`Unexpected raw diff record: ${meta}`)
    }
    const [, dstMode, , dstSha, status] = fields
    const statusHead = status[0]

    if (statusHead === 'R' || statusHead === 'C') {
      const fromPath = segments[index + 1]
      const toPath = segments[index + 2]
      index += 2
      if (statusHead === 'R') entries.push(deletedEntry(fromPath))
      entries.push({
        path: toPath,
        kind: 'add',
        blobId: resolveWorktreeBlob && /^0+$/.test(dstSha) ? hashObject(workingDir, toPath) : dstSha,
        mode: dstMode,
        objectType: objectTypeForMode(dstMode),
      })
      continue
    }

    const path = segments[index + 1]
    index += 1
    const kind = kindFromRawStatus(status)

    if (kind === 'delete') {
      entries.push(deletedEntry(path))
      continue
    }

    entries.push({
      path,
      kind,
      // worktree側はdstShaが全0で来るため、その場合だけ hash-object で求める
      blobId: resolveWorktreeBlob && /^0+$/.test(dstSha) ? hashObject(workingDir, path) : dstSha,
      mode: dstMode,
      objectType: objectTypeForMode(dstMode),
    })
  }

  return entries
}

/** untracked（git管理外）ファイルを add として列挙する。 */
function listUntrackedEntries(workingDir: string): ChangeManifestEntry[] {
  const raw = git(workingDir, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  const entries: ChangeManifestEntry[] = []

  for (const record of splitNul(raw)) {
    if (record === '' || record[0] !== '?') continue
    const path = record.slice(2)
    const mode = worktreeMode(workingDir, path)
    entries.push({
      path,
      kind: 'add',
      blobId: hashObject(workingDir, path),
      mode,
      objectType: objectTypeForMode(mode),
    })
  }

  return entries
}

/**
 * Gate ALLOW時点の変更集合（HEAD → 作業ツリー）。
 * tracked変更 + untracked追加の両方を含む。
 */
export function buildWorktreeChangeManifest(workingDir: string): ChangeManifestEntry[] {
  const tracked = parseRawDiff(workingDir, git(workingDir, ['diff', '--raw', '-z', '--no-abbrev', 'HEAD']), true)
  return [...tracked, ...listUntrackedEntries(workingDir)]
}

/** commit A → commit B の変更集合。 */
export function buildCommitChangeManifest(
  workingDir: string,
  commitA: string,
  commitB: string,
): ChangeManifestEntry[] {
  return parseRawDiff(
    workingDir,
    git(workingDir, ['diff-tree', '--raw', '-z', '-r', '--no-abbrev', '--no-commit-id', commitA, commitB]),
    false,
  )
}

export function readHeadCommit(workingDir: string): string {
  return git(workingDir, ['rev-parse', 'HEAD']).trim()
}

/** parent が1つでない場合（merge等）は曖昧なので拒否する。 */
export function readSingleParent(workingDir: string, commit: string): string {
  const parents = git(workingDir, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/)
  if (parents.length !== 2) {
    throw new ChangeManifestReadError(
      `Commit ${commit} does not have exactly one parent (found ${parents.length - 1})`,
    )
  }
  return parents[1]
}
