/**
 * Gemini Router — CLI (agy) と REST API の自動フォールバック
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * preferCli: true  → CLI → API → （両方 quota 起因なら）Antigravity/Claude → 両方失敗
 * preferCli: false → API → CLI → （両方 quota 起因なら）Antigravity/Claude → 両方失敗（デフォルト）
 *
 * Antigravity CLI（agy）経由の Claude Sonnet フォールバックは、Gemini（API・CLI 双方）が
 * quota 起因で失敗した場合だけ行う。プロンプト不正等の quota 以外の失敗では行わない
 * （2026-08-24 CEO承認: 既存 API→CLI フォールバックの延長として追加。新しい Router/Gate は
 * 追加しない。agy 自体の認証は account-auth（OAuth、HOME 配下に保存）で完結し、
 * GEMINI_API_KEY 等の秘密情報は一切渡さない）。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { callGeminiForReview } from './geminiClient.js'

// agy CLI の実行パス。絶対パスをハードコードしていた旧実装は Windows ローカル環境専用で
// production（Linux）では起動不能だった（AV-001の CONTROL_ROOT ハードコード問題と同種の
// 不具合）。PATH 解決に一本化し、環境差分は AGY_CLI_PATH で上書き可能にする。
const AGY_PATH = process.env.AGY_CLI_PATH ?? 'agy'

// Gemini（API・CLI 双方）が quota 起因で失敗した場合だけ使う、Antigravity CLI 経由の
// Claude フォールバックモデル。
const ANTIGRAVITY_CLAUDE_FALLBACK_MODEL = 'claude-sonnet-4-6'

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

/**
 * agy サブプロセスへ渡す env。agy 自身の認証は OAuth トークン（HOME 配下）で完結するため、
 * PATH・HOME・LANG・TERM のみを allowlist で渡す（`aiCli/adapter.ts` の buildSafeEnv() と
 * 同じ考え方）。CLAUDE_API_KEY・GEMINI_API_KEY・API_TOKEN・DB_PATH 等の秘密情報は一切含めない。
 */
function buildAgyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG
  if (process.env.TERM !== undefined) env.TERM = process.env.TERM
  return env
}

interface CliOutcome {
  ok: boolean
  text: string | null
  /** true の場合、失敗理由が quota（429）起因であることが判明している */
  quota: boolean
}

/** agy CLI を呼び出す。成功時は ok:true。失敗時は quota 起因かどうかを付けて返す。 */
function callCliDetailed(prompt: string, cliModel: string): CliOutcome {
  const result = spawnSync(
    AGY_PATH,
    // --add-dir 等でリポジトリを追加公開しない。review input（prompt）だけを渡す。
    // cwd もリポジトリ外の一時ディレクトリに固定し、agy が cwd 経由で暗黙にプロジェクトを
    // 検出してファイルへアクセスすることを避ける（2026-08-24 CEO承認・実測確認済み:
    // --add-dir なし・非リポジトリ cwd でも `--print` の単発応答は正常に動作する）。
    ['--model', cliModel, '--print', prompt],
    { encoding: 'utf-8', timeout: 120_000, env: buildAgyEnv(), cwd: tmpdir() },
  )

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const quota = isQuotaError(stdout) || isQuotaError(stderr)

  if (result.status !== 0 || !stdout.trim() || quota) {
    return { ok: false, text: null, quota }
  }

  return { ok: true, text: stdout, quota: false }
}

interface ApiOutcome {
  ok: boolean
  text: string | null
  /** true の場合、失敗理由が quota（429）起因であることが判明している */
  quota: boolean
}

/** REST API を呼び出す。成功時は ok:true。失敗時は quota 起因かどうかを付けて返す。 */
async function callApiDetailed(prompt: string, apiModel?: string): Promise<ApiOutcome> {
  try {
    const text = await callGeminiForReview(prompt, apiModel)
    return { ok: true, text, quota: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, text: null, quota: isQuotaError(msg) }
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
 * CLI (agy/Gemini) と REST API (Gemini) を使い Gemini を呼び出す。
 * 優先側が 429 / 失敗の場合、もう一方にフォールバックする。
 * それでも両方が quota 起因で失敗した場合だけ、Antigravity CLI (agy) 経由の
 * Claude Sonnet へフォールバックする。quota 以外の失敗（プロンプト不正・agy 未認証等）
 * では Claude フォールバックを試みず、そのまま両方失敗として扱う
 * （無条件フォールバックにしない）。
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

  let cliOutcome: CliOutcome
  let apiOutcome: ApiOutcome

  if (preferCli) {
    // CLI → API
    cliOutcome = callCliDetailed(prompt, cliModel)
    if (cliOutcome.ok) return cliOutcome.text as string

    apiOutcome = await callApiDetailed(prompt, apiModel)
    if (apiOutcome.ok) return apiOutcome.text as string
  } else {
    // API → CLI
    apiOutcome = await callApiDetailed(prompt, apiModel)
    if (apiOutcome.ok) return apiOutcome.text as string

    cliOutcome = callCliDetailed(prompt, cliModel)
    if (cliOutcome.ok) return cliOutcome.text as string
  }

  // Gemini（API・CLI 双方）が quota 起因で失敗した場合だけ Antigravity/Claude を試す。
  if (cliOutcome.quota && apiOutcome.quota) {
    const claudeOutcome = callCliDetailed(prompt, ANTIGRAVITY_CLAUDE_FALLBACK_MODEL)
    if (claudeOutcome.ok) return claudeOutcome.text as string
  }

  return handleBothExhausted(featureName)
}
