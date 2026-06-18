/**
 * Gemini Router — CLI (agy) と REST API の自動フォールバック
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * preferCli: true  → CLI → API → 両方失敗
 * preferCli: false → API → CLI → 両方失敗（デフォルト）
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { callGeminiForReview } from './geminiClient.js'

// agy CLI のフルパス（Windows）
const AGY_PATH = 'C:\\Users\\honka\\AppData\\Local\\agy\\bin\\agy.exe'

// REPO_ROOT: geminiRouter.ts は apps/worker/src/metaReviewer/ にあるので 4段上がる
// __dirname は CJS ビルド時にはファイルのディレクトリを指す
const ROUTER_ROOT = path.resolve(__dirname, '../../../../')

export interface GeminiRouterOptions {
  /** CLI を優先する場合 true（デフォルト false = API優先） */
  preferCli?: boolean
  /** agy コマンドで使うモデル */
  cliModel?: string
  /** REST API で使うモデル */
  apiModel?: string
  /** 機能名（ログ・通知用） */
  featureName?: string
}

/** 429 / quota 超過かどうかを判定 */
function isQuotaError(text: string): boolean {
  return text.includes('429') || text.toLowerCase().includes('quota')
}

/** agy CLI を呼び出す。成功時は stdout を返す。失敗・429 は null を返す。 */
function callCli(prompt: string, cliModel: string): string | null {
  const result = spawnSync(
    AGY_PATH,
    ['--model', cliModel, '--print', prompt],
    { encoding: 'utf-8', timeout: 120_000 },
  )

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''

  if (result.status !== 0 || !stdout.trim() || isQuotaError(stdout) || isQuotaError(stderr)) {
    return null
  }

  return stdout
}

/** REST API を呼び出す。成功時は結果を返す。失敗・429 は null を返す。 */
async function callApi(prompt: string, apiModel?: string): Promise<string | null> {
  try {
    return await callGeminiForReview(prompt, apiModel)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isQuotaError(msg)) {
      return null
    }
    // quota 以外のエラーも null で統一（フォールバック先を試させる）
    return null
  }
}

/** 両方失敗時の記録 & エラー */
function handleBothExhausted(featureName: string): never {
  const exhaustedAt = new Date().toISOString()
  const record = {
    featureName,
    exhaustedAt,
    apiExhausted: true,
    cliExhausted: true,
  }

  try {
    const dataDir = path.join(ROUTER_ROOT, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      path.join(dataDir, 'quota-exhausted.json'),
      JSON.stringify(record, null, 2),
    )
  } catch {
    // ファイル書き込み失敗はサイレントに無視
  }

  console.warn(
    `\n⛔ [geminiRouter] Gemini API・CLI 両方の quota が枯渇しています。\n` +
    `   機能: ${featureName}\n` +
    `   有料プランの検討をお勧めします: https://aistudio.google.com/`,
  )

  throw new Error(`[geminiRouter] Gemini quota exhausted (feature: ${featureName})`)
}

/**
 * CLI (agy) と REST API を使い Gemini を呼び出す。
 * 優先側が 429 / 失敗の場合、もう一方にフォールバックする。
 */
export async function callGeminiWithFallback(
  prompt: string,
  options?: GeminiRouterOptions,
): Promise<string> {
  const {
    preferCli = false,
    cliModel = 'gemini-2.5-flash',
    apiModel,
    featureName = 'unknown',
  } = options ?? {}

  if (preferCli) {
    // CLI → API
    const cliResult = callCli(prompt, cliModel)
    if (cliResult !== null) return cliResult

    const apiResult = await callApi(prompt, apiModel)
    if (apiResult !== null) return apiResult
  } else {
    // API → CLI
    const apiResult = await callApi(prompt, apiModel)
    if (apiResult !== null) return apiResult

    const cliResult = callCli(prompt, cliModel)
    if (cliResult !== null) return cliResult
  }

  return handleBothExhausted(featureName)
}
