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
 * 安全性: --yolo / --allow-all / --allow-all-tools は使わない。
 *   ツールを一切許可せず、プロンプトに埋め込んだ diff のみで判定させる
 *   （repository を自由探索させない）。
 */

import { spawnSync } from 'node:child_process'

export const DEFAULT_COPILOT_META_REVIEW_MODEL = 'mai-code-1.1-flash'

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
      env: { ...process.env, GITHUB_TOKEN: process.env.GITHUB_TOKEN },
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
