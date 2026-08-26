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
 * 安全性:
 *   - --yolo / --allow-all / --allow-all-tools は使わない。
 *   - env は allowlist（PATH/HOME/LANG/TERM + GITHUB_TOKEN）のみを子プロセスへ渡す。
 *     `adapter.ts` の buildSafeEnv() / geminiRouter.ts の buildAgyEnv() と同じ考え方。
 *     GEMINI_API_KEY 等の秘密情報は一切含めない
 *     （2026-08-26 独立レビューで発覚: 旧実装は ...process.env で全環境変数を渡していた）。
 *   - cwd はリポジトリ外の一時ディレクトリに固定する。Copilot CLI は --allow-tool を
 *     一切渡さなくても非対話モードで cwd 配下のファイル一覧・読み取りを確認なしで
 *     実行してしまうことを実測確認した（2026-08-26, GitHub Actions上でcanary fileを
 *     使い実証。geminiRouter.ts の callCliDetailed() が agy に対して行っている
 *     cwd: tmpdir() と同じ対策）。
 */

import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

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
  if (process.env.GITHUB_TOKEN !== undefined) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN
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

  const result = spawnSync(
    'copilot',
    ['-p', prompt, '-s', '--no-color', '--model', model],
    {
      encoding: 'utf-8',
      timeout,
      env: buildCopilotEnv(),
      // repository を自由探索させない（--allow-tool なしでも cwd 配下は確認なしで
      // 読める実測結果があるため、cwd 自体をリポジトリ外へ隔離する）
      cwd: tmpdir(),
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
}
