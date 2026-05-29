/**
 * File Change Guard
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * AIが変更したファイルを3段階で検証する:
 * 1. パス正規化（traversal防止）
 * 2. target-project/配下のみ許可（Control Repository保護）
 * 3. タスクごとのallowedPaths制限
 * 4. 常時禁止ファイルパターン（秘密情報・設定ファイル）
 *
 * レビュー指摘(2026-05-28):
 * - パス正規化がなかった（../apps/api/index.ts などが通った）
 * - target-project/配下のみ許可にすることでGuardがシンプルかつ強固になる
 * - タスクのallowedPathsで変更範囲をさらに絞る
 */

import type { Task } from '@ai-team/shared'
import { normalizeAndValidateChangedFile } from '../utils/pathUtils'

// target-project/配下でも常時禁止のファイルパターン
const ALWAYS_FORBIDDEN_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
  /service-account\.json$/,
  /\.secrets/,
]

export interface FileGuardResult {
  allowed: boolean
  violations: string[]
  reasons: Record<string, string>  // file → 違反理由
}

export function fileChangeGuard(
  changedFiles: string[],
  task?: Pick<Task, 'allowedPaths' | 'forbiddenPaths'>
): FileGuardResult {
  const violations: string[] = []
  const reasons: Record<string, string> = {}

  for (const file of changedFiles) {
    // 1. パス正規化 + target-project/配下チェック
    const { normalized, isValid } = normalizeAndValidateChangedFile(file, '/workspace/target')

    if (!isValid) {
      violations.push(file)
      reasons[file] = `Path traversal or outside target: "${file}"`
      continue
    }

    // 2. 常時禁止パターンチェック
    const isForbidden = ALWAYS_FORBIDDEN_PATTERNS.some((p) => p.test(normalized))
    if (isForbidden) {
      violations.push(file)
      reasons[file] = `Always-forbidden file pattern: "${normalized}"`
      continue
    }

    // 3. タスクのforbiddenPathsチェック
    if (task?.forbiddenPaths?.some((fp) => normalized.startsWith(fp))) {
      violations.push(file)
      reasons[file] = `Forbidden by task.forbiddenPaths: "${normalized}"`
      continue
    }

    // 4. タスクのallowedPathsチェック（指定がある場合のみ）
    if (task?.allowedPaths && task.allowedPaths.length > 0) {
      const isAllowed = task.allowedPaths.some(
        (ap) => normalized === ap || normalized.startsWith(ap + '/')
      )
      if (!isAllowed) {
        violations.push(file)
        reasons[file] = `Not in task.allowedPaths: "${normalized}"`
        continue
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    reasons,
  }
}
