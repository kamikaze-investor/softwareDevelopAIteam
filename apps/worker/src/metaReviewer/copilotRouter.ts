/**
 * Copilot Router — Meta Review 用 Copilot CLI 直接呼び出し
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * geminiRouter.ts の callCli() と同じ理由でBaseCliAdapterを使わない:
 * Meta Review は Control Repository 自体を審査するため、
 * BaseCliAdapter が強制する workingDir === /workspace/target 制約に合わない。
 *
 * Gemini API・CLI の両方が quota 枯渇したときのみ、
 * metaReviewFallbackRouter.ts から呼ばれる最終フォールバック。
 *
 * 認証: GITHUB_TOKEN のみ（PAT不要、実測確認済み 2026-08-26）。
 * 安全性（2026-08-26 独立レビュー2ラウンドを経て確定。すべて実測確認済み）:
 *   - --yolo / --allow-all / --allow-all-tools は使わない。
 *   - `--available-tools`（値なし）を渡し、ツールそのものをモデルから見えなくする。
 *     --allow-tool を渡さないだけでは不十分（実測: --allow-tool なしでも非対話モードで
 *     cwd 配下のファイル一覧・読み取りが確認なしで実行される）。`--available-tools`
 *     （値なし = 空allowlist）を渡すと同じ条件で `NO_FILE_ACCESS` と応答することを
 *     GitHub Actions上で実証済み。
 *   - cwd はさらに、リポジトリ外の使い捨て一時ディレクトリ（mkdtempSync、呼び出しごとに
 *     生成・実行後に削除）に固定する。bare な os.tmpdir() 直下は同一CI実行内の他ステップと
 *     共有される場所であり、隔離としては不十分なため使わない
 *     （geminiRouter.ts が --json-schema 用の一時ファイルに mkdtempSync を使うのと同じ考え方）。
 *   - env は allowlist（PATH/HOME/LANG/TERM + GITHUB_TOKEN）のみを子プロセスへ渡す。
 *     `adapter.ts` の buildSafeEnv() / geminiRouter.ts の buildAgyEnv() と同じ考え方。
 *     GEMINI_API_KEY 等の秘密情報は一切含めない。
 *   - 上記2点（ツール完全無効化 + cwd隔離）は独立した多層防御。どちらか一方が
 *     将来変更されても、もう一方が repository への到達を防ぐ。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const DEFAULT_COPILOT_META_REVIEW_MODEL = 'mai-code-1.1-flash'

/**
 * Copilot CLI 子プロセスへ渡す env。GITHUB_TOKEN 以外の秘密情報を渡さない
 * （adapter.ts の buildSafeEnv() / geminiRouter.ts の buildAgyEnv() と同じ allowlist方式）。
 */
function buildCopilotEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG
  if (process.env.TERM !== undefined) env.TERM = process.env.TERM
  // production ではこの子プロセス env に GITHUB_TOKEN 自体は渡ってこない
  // （designReviewCoordinator.ts の buildRunnerEnv() が渡すのは COPILOT_GITHUB_TOKEN のみ）。
  // copilot CLI 自体が要求する変数名は GITHUB_TOKEN のままなので、ここで詰め替える。
  if (process.env.COPILOT_GITHUB_TOKEN !== undefined) env.GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN
  return env
}

export interface CopilotFallbackOptions {
  /** 使用モデル（既定: mai-code-1.1-flash、実測確認済みのMicrosoft系モデル） */
  model?: string
  /**
   * 呼び出し用途の識別子。ログ・将来のCredit routerでの識別用。
   * 例: 'meta_review' | 'independent_review'
   */
  usage?: string
  timeoutMs?: number
}

/**
 * Copilot CLI を呼び出し、非対話モードでレビュー結果テキストを取得する。
 * 失敗時は例外を投げる（quota以外の失敗を握り潰さない。呼び出し元が判定する）。
 */
export function callCopilotForMetaReview(
  prompt: string,
  options?: CopilotFallbackOptions,
): string {
  const model = options?.model ?? DEFAULT_COPILOT_META_REVIEW_MODEL
  const usage = options?.usage ?? 'meta_review'
  const timeout = options?.timeoutMs ?? 300_000

  // 呼び出しごとの使い捨て隔離ディレクトリ（bare tmpdir() は他ステップと共有されるため使わない）
  const isolatedCwd = mkdtempSync(path.join(tmpdir(), 'copilot-meta-review-'))

  try {
    const result = spawnSync(
      'copilot',
      [
        '-p', prompt, '-s', '--no-color', '--model', model,
        '--available-tools',  // 値なし = 空allowlist。ツールをモデルから完全に見えなくする（実測確認済み）
      ],
      {
        encoding: 'utf-8',
        timeout,
        env: buildCopilotEnv(),
        cwd: isolatedCwd,
      },
    )

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''

    if (result.error) {
      throw new Error(`[copilotRouter] Copilot CLI 実行エラー（usage=${usage}）: ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`[copilotRouter] Copilot CLI が exit code ${result.status} で終了しました（usage=${usage}）: ${stderr || stdout || '(no output)'}`)
    }
    if (!stdout.trim()) {
      throw new Error(`[copilotRouter] Copilot CLI の応答が空でした（usage=${usage}）`)
    }

    return stdout
  } finally {
    try {
      rmSync(isolatedCwd, { recursive: true, force: true })
    } catch {
      // 一時ディレクトリの削除失敗はサイレントに無視
    }
  }
}
