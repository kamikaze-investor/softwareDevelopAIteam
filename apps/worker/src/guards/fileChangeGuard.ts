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
import type { ChangeManifest, FileChange } from './changeManifest'

// target-project/配下でも常時禁止のファイルパターン
//
// 秘密情報系はルート直下だけでなく**任意の階層**に一致させる。
// 旧 `^\.env$` はルートの .env にしか一致せず、`apps/api/.env` が素通りしていた
// （2026-07-31 Codex 独立レビューで発見）。
//
// 全パターンに `i` フラグを付ける。判定側は case-fold した文字列ではなく
// 元の大文字小文字を保持した `normalized` に対してテストする（下記参照）。
// これは Windows/macOS の大文字小文字非区別対応（`.env`/`.ENV` を同一視する）を
// 保ちながら、`jobRunner`・`changeManifest` 等のキャメルケースを含む
// CONTROL REPOSITORY 保護パターンを壊さないため。
// 【重大な回帰の教訓】当初、判定文字列側だけを toLowerCase() し、
// パターン側は大文字小文字区別のままにしていたため、`changeManifest` や
// `jobRunner` を含むこのファイル自身の保護パターンが機能しなくなっていた
// （実測: `guards/changeManifest.ts` への変更が ALWAYS_FORBIDDEN_PATTERNS を
// すり抜けることを確認。2026-07-31 発見・即修正）。
export const ALWAYS_FORBIDDEN_PATTERNS = [
  // 秘密情報
  /(^|\/)\.env$/i,
  /(^|\/)\.env\./i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /service-account\.json$/i,
  /\.secrets/i,
  // Control Repository — Guard・Worker・共有型は target 側に存在しないが念のため保護
  /guards\/safetyAuditor/i,
  /guards\/alignmentChecker/i,
  /guards\/gateProcessor/i,
  /guards\/permissionGuard/i,
  /guards\/fileChangeGuard/i,
  /guards\/changeManifest/i,       // 変更検出の安全中核（CONTROL REPOSITORY）
  /types\/safety_guard/i,
  /metaReviewer\/geminiClient/i,  // Alignment Checker が依存するGeminiクライアント
  /src\/utils\/pathUtils/i,        // Guard が依存するパスユーティリティ
  /jobRunner/i,                    // Job実行エンジン本体
  // Repository相対の完全な固有パスで一致させる（2026-07-31 Codex 5回目レビューで追加）。
  // `adapter.ts`・`index.ts`は一般的なファイル名で、target-project側に同名の正当な
  // ファイルが存在しうるため、他の行のような単語一致（例: /jobRunner/）にはしない。
  // target側に "apps/worker/src/..." という完全一致パスが存在することは通常あり得ないため、
  // 完全パス一致であれば誤検出のリスクなく安全側に倒せる。
  /^apps\/worker\/src\/aiCli\/adapter\.ts$/i,  // AI CLI Adapter（環境変数allowlistの実装元）
  /^apps\/worker\/src\/index\.ts$/i,            // Worker エントリポイント（claim・起動順序）
]

export interface FileGuardResult {
  allowed: boolean
  violations: string[]
  reasons: Record<string, string>  // file → 違反理由
}

/**
 * 実行時 Task ポリシー。
 *
 * これは「Job作成時にDBへ保存された immutable snapshot」ではなく、
 * **Worker が Job 実行を開始する時点で Task から構築し freeze した実行時ポリシー**である。
 * DBへは保存しない。1回の runJob() の中でだけ有効で、実行中は変化しない。
 * （DB に保存する snapshot 方式は project-auto-worker-trust-boundary の別論点であり、
 *   本ファイルの責務ではない）
 */
export interface RuntimeTaskPolicy {
  readonly taskId: string
  readonly projectId: string
  readonly allowedPaths: readonly string[]
  readonly forbiddenPaths: readonly string[]
}

/**
 * Task から実行時ポリシーを構築して freeze する。
 * 配列はコピーしてから freeze するため、呼び出し元が元の Task を書き換えても影響しない。
 */
export function buildRuntimeTaskPolicy(
  task: Pick<Task, 'id' | 'projectId' | 'allowedPaths' | 'forbiddenPaths'>,
): RuntimeTaskPolicy {
  if (!task.id || !task.projectId) {
    throw new Error('buildRuntimeTaskPolicy: task.id と task.projectId は必須です')
  }

  return Object.freeze({
    taskId: task.id,
    projectId: task.projectId,
    allowedPaths: Object.freeze([...(task.allowedPaths ?? [])]),
    forbiddenPaths: Object.freeze([...(task.forbiddenPaths ?? [])]),
  })
}

/**
 * forbiddenPaths の1エントリを、区切り文字と大文字小文字について判定基準と揃える。
 *
 * 変更パス側と同じ理由（POSIXではバックスラッシュは区切り文字ではなく正当な
 * ファイル名文字）で、区切り変換はWindows実行時のみ行う。当初は変更パス側
 * （normalized）だけをWindows限定にし、こちらの対応が漏れていた
 * （2026-07-31 Codex 4回目レビューで発見）。
 */
function normalizeForbiddenPath(forbiddenPath: string): string {
  const withForwardSlashes =
    process.platform === 'win32' ? forbiddenPath.split('\\').join('/') : forbiddenPath
  return withForwardSlashes.toLowerCase()
}

/** 変更後の実体が regular 以外なら MVP では拒否する */
function disallowedEntryTypeReason(change: FileChange): string | undefined {
  if (change.kind === 'deleted') return undefined

  const after = change.afterType
  if (after === undefined) return undefined
  if (after === 'regular') return undefined

  if (after === 'symlink') {
    return change.beforeType === 'symlink'
      ? 'Symlink change is not allowed in MVP'
      : 'Type change to symlink is not allowed in MVP'
  }
  if (after === 'gitlink') {
    return 'Nested repository / submodule (gitlink) is not allowed in MVP'
  }

  return `Unclassifiable entry type is not allowed in MVP: "${after}"`
}

/**
 * 変更 manifest を検証する。
 *
 * rename は旧パス・新パスの**両方**を独立に全ルールへ通し、
 * どちらか一方でも違反すればその変更を拒否する。
 *
 * @param manifest      検査対象の変更一覧（buildWorktreeManifest / buildCommitTreeManifest 由来）
 * @param policy        実行時 Task ポリシー（required。省略や undefined は許容しない）
 * @param worktreeRoot  パス正規化の基準となる作業ツリールート
 */
export function fileChangeGuard(
  manifest: ChangeManifest,
  policy: RuntimeTaskPolicy,
  worktreeRoot: string,
): FileGuardResult {
  const violations: string[] = []
  const reasons: Record<string, string> = {}

  const reject = (file: string, reason: string): void => {
    if (!violations.includes(file)) violations.push(file)
    reasons[file] = reason
  }

  for (const change of manifest.changes) {
    // 0. 実体種別チェック（symlink / gitlink / 分類不能）
    const typeReason = disallowedEntryTypeReason(change)
    if (typeReason !== undefined) {
      reject(change.path, `${typeReason}: "${change.path}"`)
      // 種別違反でも、旧パス側のパスルール検査は継続する
    }

    // rename は旧パスも同じルールへ通す
    const targets = change.oldPath !== undefined ? [change.path, change.oldPath] : [change.path]

    for (const file of targets) {
      // 1. パス正規化 + 作業ツリー配下チェック
      const { normalized: rawNormalized, isValid } = normalizeAndValidateChangedFile(file, worktreeRoot)

      if (!isValid) {
        reject(file, `Path traversal or outside target: "${file}"`)
        continue
      }

      // Windows では path.relative() が "src\\index.ts" を返すため、
      // allowedPaths / forbiddenPaths / 禁止パターンの比較が OS 依存にならないよう
      // 区切り文字を "/" へ揃える（判定基準そのものは変更しない）。
      // POSIX ではバックスラッシュは区切り文字ではなく正当なファイル名の一部
      // （例: 実ファイル名 "src\\escape.ts"）であり、無条件変換すると
      // allowedPaths のスコープを実質的に拡大してしまう
      // （2026-07-31 Codex 最終レビューで発見）。Windows 実行時のみ変換する。
      const normalized = process.platform === 'win32' ? rawNormalized.split('\\').join('/') : rawNormalized

      // Windows / macOS はファイルシステムが大文字小文字を区別しないため、
      // ".ENV" は ".env" と同一ファイルを指す。禁止側（forbidden pattern /
      // forbiddenPaths）を大文字小文字区別のまま判定すると、大文字小文字を変えるだけで
      // 禁止対象を素通りできてしまう（2026-07-31 Codex 最終レビューで発見）。
      // 「under-block = 秘密漏洩」となる禁止側だけ case-fold する
      // （許可側 allowedPaths は over-block が安全側のため区別のまま維持する）。
      const normalizedForForbidCheck = normalized.toLowerCase()

      // 2. 常時禁止パターンチェック
      // パターン自体が `i` フラグ付きの case-insensitive のため、大文字小文字を
      // 保持した normalized に対してテストする（normalizedForForbidCheck を使うと
      // `jobRunner`/`changeManifest` 等キャメルケースを含むパターン自体を
      // 破壊してしまうため使わない）。
      const isForbidden = ALWAYS_FORBIDDEN_PATTERNS.some((p) => p.test(normalized))
      if (isForbidden) {
        reject(file, `Always-forbidden file pattern: "${normalized}"`)
        continue
      }

      // 3. タスクのforbiddenPathsチェック
      if (
        policy.forbiddenPaths.some((fp) =>
          normalizedForForbidCheck.startsWith(normalizeForbiddenPath(fp)),
        )
      ) {
        reject(file, `Forbidden by task.forbiddenPaths: "${normalized}"`)
        continue
      }

      // 4. タスクのallowedPathsチェック（指定がある場合のみ）
      if (policy.allowedPaths.length > 0) {
        const isAllowed = policy.allowedPaths.some(
          (ap) => normalized === ap || normalized.startsWith(ap + '/')
        )
        if (!isAllowed) {
          reject(file, `Not in task.allowedPaths: "${normalized}"`)
          continue
        }
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    reasons,
  }
}
