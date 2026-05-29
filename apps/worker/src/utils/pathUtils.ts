/**
 * Path正規化ユーティリティ
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * レビュー指摘(2026-05-28):
 * startsWith だけでは以下のような traversal が通る
 *   /workspace/target-malicious
 *   /workspace/target/../../etc/passwd
 * path.resolveで正規化してから判定すること
 */

import path from 'node:path'
import fs from 'node:fs'

/** AIが作業してよいルートディレクトリ */
export const TARGET_ROOT = '/workspace/target'

/**
 * workingDirがTARGET_ROOT配下かを安全に検証する
 * realpathで symlink traversal も防ぐ
 */
export function isInsideTargetRoot(workingDir: string): boolean {
  try {
    // TARGET_ROOTが存在しない環境（テスト等）ではpath.resolveでフォールバック
    const realTarget = fs.existsSync(TARGET_ROOT)
      ? fs.realpathSync(TARGET_ROOT)
      : path.resolve(TARGET_ROOT)

    const realWorkingDir = fs.existsSync(workingDir)
      ? fs.realpathSync(workingDir)
      : path.resolve(workingDir)

    return (
      realWorkingDir === realTarget ||
      realWorkingDir.startsWith(realTarget + path.sep)
    )
  } catch {
    return false
  }
}

/**
 * changedFileのパスを正規化してTARGET_ROOT配下かを検証する
 * 存在しないファイル（新規作成）はpath.resolveで正規化
 */
export function normalizeAndValidateChangedFile(
  filePath: string,
  repoRoot: string = TARGET_ROOT
): { normalized: string; isValid: boolean } {
  try {
    // path.resolveで .. を解決
    const resolved = path.resolve(repoRoot, filePath)
    const normalizedRoot = path.resolve(repoRoot)

    const isValid =
      resolved === normalizedRoot ||
      resolved.startsWith(normalizedRoot + path.sep)

    // repoRootからの相対パスに戻す
    const normalized = path.relative(normalizedRoot, resolved)

    return { normalized, isValid }
  } catch {
    return { normalized: filePath, isValid: false }
  }
}
