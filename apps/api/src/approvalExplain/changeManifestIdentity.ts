/**
 * Canonical Change Manifest（Gate ALLOW対象の変更集合を表す正規形）とその hash。
 *
 * 目的は1つだけである。「Gateが実際にALLOWした変更集合」と「後から現れた commit B の
 * 変更集合」が**同一かどうか**を、API/Control Plane側がauthoritative repositoryから
 * 独立に判定できるようにすること。
 *
 * なぜdiff textではなくmanifestなのか:
 *   既存の`targetDiffHash`は`git diff HEAD` + untrackedの独自合成形式で作られるため、
 *   commit後の`git diff A..B`とcanonical formが構造的に一致せず再現できない（実測確認済み）。
 *   Git blob IDはcontentの暗号学的identityで、commit前（worktree）でもcommit後（tree）でも
 *   同じ値が得られるため、両側で同一の正規形を作れる。
 *
 * 新しいframeworkは作らない。使うのはgit primitive（hash-object / ls-tree / diff-tree）だけ。
 */

import { createHash } from 'node:crypto'

export type ChangeKind = 'add' | 'modify' | 'delete'

/** deleteのcontent位置に入れる明示marker（空blobと区別するため）。 */
export const DELETED_BLOB_MARKER = 'deleted'

export interface ChangeManifestEntry {
  path: string
  kind: ChangeKind
  /** add/modifyはGit blob ID。deleteは DELETED_BLOB_MARKER。 */
  blobId: string
  /** Git上意味のあるmode（例: 100644 / 100755 / 120000 / 160000）。deleteは空文字。 */
  mode: string
  /** Git object type（通常 blob。submoduleは commit）。deleteは空文字。 */
  objectType: string
}

/**
 * manifestを正規化して1本の文字列にする。
 *
 * - path昇順で安定ソート（同一集合なら常に同一文字列）
 * - 1行1エントリ、TAB区切り、LF連結
 * - renameは特別扱いせず delete + add として表現される前提
 *
 * 承認対象の**集合全体**を対象にするため、commit後に未承認ファイルが1つでも
 * 増減すれば行数か内容が変わり、必ずhash不一致になる。
 */
export function canonicalizeChangeManifest(entries: readonly ChangeManifestEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => [e.path, e.kind, e.blobId, e.mode, e.objectType].join('\t'))
    .join('\n')
}

export function computeChangeManifestHash(entries: readonly ChangeManifestEntry[]): string {
  return createHash('sha256').update(canonicalizeChangeManifest(entries), 'utf-8').digest('hex')
}
