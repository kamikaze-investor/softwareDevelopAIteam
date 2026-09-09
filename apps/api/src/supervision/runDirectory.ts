/**
 * Trusted run directory（独立レビュー指摘 2026-09-08 Step 3 #3）
 *
 * 以前は runDir を呼び出し元の `logPath` と生の `subjectId` から組み立てていた。
 * その結果 completion predicate が「呼び出し元が指したディレクトリ」を信用して
 * DONE marker を読むことになり、**判定そのものが偽装可能**だった。
 * path traversal も止められていなかった。
 *
 * ここでは次に固定する:
 *   - runDir は **server が生成した runId のみ**から決まる（呼び出し元は一切影響できない）
 *   - runDir は必ず trusted root 配下
 *   - `current_log` は **runDir 配下の相対 path だけ**許可する
 *   - symlink / traversal で root の外へ出るものは **fail-closed**（読まない）
 */

import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * trusted root。実運用では `SUPERVISED_RUN_ROOT` を明示する。
 * 既定は OS の一時領域配下（repo 内へは置かない — 委任の出力が production source へ
 * 混入する経路を作らないため。実障害ケース2で QR artifact が repo へ入りかけた件と同じ理由）。
 */
export function resolveSupervisedRunRoot(): string {
  const configured = process.env.SUPERVISED_RUN_ROOT
  if (configured && configured.trim().length > 0) return path.resolve(configured)
  return path.join(os.tmpdir(), 'ai-team-supervised-runs')
}

/** runId は server 生成の UUID。ここで形を検証し、path segment として安全なものだけ通す。 */
const RUN_ID_PATTERN = /^[0-9a-fA-F-]{36}$/

export function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId)
}

/**
 * runId から runDir を決める。**呼び出し元の入力は使わない。**
 * これにより predicate は「行の id」だけから入力を復元でき、
 * 誰かが evidence に別の path を書き込んでも判定先は変わらない。
 */
export function runDirFor(runId: string): string {
  if (!isSafeRunId(runId)) {
    throw new Error(`unsafe supervised run id for a run directory: ${runId.slice(0, 64)}`)
  }
  return path.join(resolveSupervisedRunRoot(), runId)
}

/** `child` が `root` の中（root 自身は除く）に収まっているか。 */
function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * runDir 配下にあることを保証したうえで実 path を返す。
 *
 * symlink を辿った**後**に判定するので、runDir 内から外を指す symlink は弾かれる。
 * 解決できない・外を指す場合は `undefined`（＝読まない = fail-closed）。
 */
export function resolveInsideRunDir(runDir: string, candidate: string): string | undefined {
  // UNC path は解決先が別ホストになり得るので、containment 判定の前に落とす。
  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) return undefined

  // 相対でも絶対でも、**最終的に runDir 配下へ解決されること**だけを条件にする。
  //
  // 当初は「相対 path のみ許可」にしていたが、`delegate.sh` は current_log を絶対 path で
  // 書くため、それを相対へ直すには両スクリプトへ path 操作を足す必要があった。
  // Windows では RUN_DIR が `C:\...`（区切りが `\`）で渡るため、bash 側の
  // prefix 判定（`"$RUN_DIR"/*`）が成立せず、実測でこの経路は壊れた。
  //
  // 守るべき性質は「相対であること」ではなく「runDir の外へ出られないこと」なので、
  // 判定を containment に一本化する。realpath を解決した**後**に判定するため、
  // symlink や `..` で外を指すものは絶対・相対どちらの表記でも弾かれる。
  const joined = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(runDir, candidate)

  let realRunDir: string
  let realTarget: string
  try {
    realRunDir = realpathSync(runDir)
    realTarget = realpathSync(joined)
  } catch {
    // 存在しない / 解決できないものは読まない。
    return undefined
  }

  return isInside(realRunDir, realTarget) ? realTarget : undefined
}
