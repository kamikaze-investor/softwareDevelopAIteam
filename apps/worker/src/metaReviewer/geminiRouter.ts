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
 *
 * 失敗分類（2026-09-01 CEO承認: 粗すぎた quota/非quota の2分類を4分類に拡張）:
 *   - quota:          429 / quota文言 → Copilot フォールバック（既存挙動）
 *   - transient:      timeout / network error / provider 5xx 等の明確な一時的障害
 *                      → このRouter内で固定回数（10秒→30秒）リトライ後、なお失敗なら
 *                        Copilot フォールバック
 *   - auth_or_config:  認証エラー・設定不備・CLIバイナリ不在等 → リトライせず fail-closed
 *   - unknown:         上記いずれにも一致しない → リトライせず fail-closed（安全側デフォルト）
 * 分類に使う診断情報（provider/stage/failureClass/httpStatus/exitCode/timedOut/message）は
 * すべて allowlist 方式。message は sanitizeMessage() で secret を redact・長さを制限してから
 * ログ・エラーに含める。raw stderr / stdout をそのまま外部（ログ・PRコメント）に出さない。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  /**
   * agy 呼び出し（Gemini-CLI・Antigravity/Claude フォールバック双方）に
   * `--output-format json --json-schema` を付け、呼び出し元の既存パーサー
   * （parseFocusedReviewResponse 等）が期待する形へ応答を強制する。
   * 新しい review schema/parser 仕様は作らず、呼び出し元が既に持つ contract
   * （decision/summary/findings 等）をそのまま JSON Schema として渡すことを想定する。
   * 未指定時は従来どおり素の `--print` のみ（挙動変更なし）。
   */
  cliJsonSchema?: Record<string, unknown>
  /**
   * transient（timeout/network/5xx）と判定された失敗を、固定回数（10秒→30秒）リトライしてから
   * 次の段へ進むかどうか。既定 false（挙動変更なし・即座に次の段へ）。
   *
   * 独立レビュー指摘（2026-09-01）: callGeminiWithFallback() は autoReview.ts のような使い捨て
   * CI/pre-push プロセスだけでなく、watchdog.ts・alignmentChecker.ts・reviewerAdapter.ts 経由で
   * 長時間稼働する Worker 本体からも呼ばれる。リトライを既定 ON にすると、それらの呼び出し元でも
   * 同期 sleep（Atomics.wait）が transient 障害のたびに最大40秒 event loop をブロックしてしまう。
   * そのため明示的に opt-in した呼び出し元（Meta Review CI 実行）だけがリトライする。
   */
  retryTransient?: boolean
  /** テストでの差し替え用。transient リトライ間の待機に使う。既定は同期sleep（Atomics.wait）。 */
  sleepImpl?: (ms: number) => void
}

/** transient 判定後の固定回数リトライ間隔。判定ロジックは追加しない固定値
 *（copilotRouter.ts の retry 方針と同じ考え方）。 */
const TRANSIENT_RETRY_DELAYS_MS = [10_000, 30_000] as const
const TRANSIENT_MAX_ATTEMPTS = TRANSIENT_RETRY_DELAYS_MS.length + 1

function defaultSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export type FailureClass = 'quota' | 'transient' | 'auth_or_config' | 'unknown'

/** CI・ログ・監査に安全に出せる診断情報のみを持つ allowlist 型。raw stderr/stdout は含めない。 */
export interface ProviderFailureDiagnostics {
  provider: 'gemini_api' | 'gemini_cli' | 'antigravity_claude_cli'
  stage: string
  failureClass: FailureClass
  httpStatus?: number
  exitCode?: number | null
  timedOut: boolean
  /** sanitizeMessage() 済み・長さ制限済みのメッセージ */
  message: string
}

const SECRET_ENV_KEYS = [
  'GEMINI_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY', 'API_TOKEN',
] as const

/** よくある API key / token の「形」を redact する（値が env に無くても防御する二重防御）。 */
const SECRET_SHAPE_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
]

const MAX_MESSAGE_LENGTH = 300

/** raw なエラーテキストから secret を redact し、長さを制限した安全な文字列を返す。 */
export function sanitizeMessage(raw: string): string {
  let msg = raw
  for (const key of SECRET_ENV_KEYS) {
    const val = process.env[key]
    if (val !== undefined && val.length >= 6) {
      msg = msg.split(val).join('[REDACTED]')
    }
  }
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    msg = msg.replace(pattern, '[REDACTED]')
  }
  msg = msg.replace(/[\r\n]+/g, ' ').trim()
  return msg.length > MAX_MESSAGE_LENGTH ? `${msg.slice(0, MAX_MESSAGE_LENGTH)}…` : msg
}

const TRANSIENT_PATTERN =
  /\b(408|500|502|503|504)\b|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|DEADLINE_EXCEEDED|UNAVAILABLE|overloaded|internal error|service unavailable|socket hang up/i

const AUTH_OR_CONFIG_PATTERN =
  /\b(401|403)\b|unauthorized|unauthenticated|invalid[_ ]?api[_ ]?key|api key not valid|permission[_ ]denied|not authenticated|no such file or directory|command not found|ENOENT|EACCES|が設定されていません|is not set\b|not configured/i

/**
 * quota/rate-limit の「枯渇」を示す文言だけに絞る（独立レビュー指摘: 素の "quota" 部分一致では
 * "quota project not configured" のような auth/config 起因の文言まで quota 扱いになり、Copilot
 * フォールバックへ誤って倒れてしまう。exhaustion/rate-limit の形をしている場合だけ quota とする）。
 */
const QUOTA_PATTERN = /\b429\b|RESOURCE_EXHAUSTED|quota[\s_-]*(exceeded|exhausted)|rate[\s_-]*limit(ed)?/i

/** 4分類の判定。quota → transient → auth_or_config → unknown の優先順で確定させる。 */
export function classifyFailure(opts: {
  text: string
  httpStatus?: number
  exitCode?: number | null
  timedOut?: boolean
}): FailureClass {
  const { text, httpStatus, exitCode, timedOut } = opts
  if (httpStatus === 429 || QUOTA_PATTERN.test(text)) return 'quota'
  if (
    timedOut === true ||
    (httpStatus !== undefined && [500, 502, 503, 504].includes(httpStatus)) ||
    TRANSIENT_PATTERN.test(text)
  ) {
    return 'transient'
  }
  if (
    (httpStatus !== undefined && [401, 403].includes(httpStatus)) ||
    AUTH_OR_CONFIG_PATTERN.test(text) ||
    exitCode === 127
  ) {
    return 'auth_or_config'
  }
  return 'unknown'
}

/**
 * geminiRouter.ts / metaReviewFallbackRouter.ts が投げる、失敗分類付きのエラー。
 * 呼び出し元（Copilot フォールバック判定）は文字列マッチではなく failureClass を見て判定する。
 */
export class MetaReviewProviderError extends Error {
  readonly failureClass: FailureClass
  readonly diagnostics: ProviderFailureDiagnostics[]

  constructor(message: string, failureClass: FailureClass, diagnostics: ProviderFailureDiagnostics[]) {
    super(message)
    this.name = 'MetaReviewProviderError'
    this.failureClass = failureClass
    this.diagnostics = diagnostics
  }
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
  diagnostics?: ProviderFailureDiagnostics
  /**
   * true は「agy バイナリそのものが起動できなかった」（ENOENT等）ことを示す。
   * これはレビュー対象や provider の状態とは無関係な「この実行環境に agy が
   * インストールされていない」というローカル環境設定の問題であり、cross-stage の
   * failureClass 合成（他stageが実際に得た transient/quota 等の信号）を汚染しないよう、
   * combineFailureClasses() では他に実信号があれば除外して扱う
   * （CIランナーに agy 未インストールでもAPI段の本当の障害種別を正しく分類するため）。
   */
  unavailable: boolean
}

/**
 * agy は非対話の `--print` でもエージェント的な文章（「ファイルを確認します」等）を返すことが
 * あり、呼び出し元パーサーが期待する構造化 JSON と噛み合わないことがある
 * （2026-08-24 実測確認）。`--json-schema` は agy 自身の既存機能で、呼び出し元の
 * contract をそのまま強制でき、新しい review schema/parser を作らずに済む。
 */
function withToolFreeInstruction(prompt: string): string {
  return (
    'Use ONLY the input provided below. Do not use any filesystem, shell, or other tools, ' +
    'and do not explore the working directory or repository — answer directly from the given ' +
    'input alone.\n\n' + prompt
  )
}

/**
 * `--output-format json` の agy 応答（`{"structured_output": {...}, ...}`）から
 * `structured_output` を取り出し、呼び出し元パーサーがそのまま読める JSON 文字列にする。
 * 形が違えば undefined を返す（呼び出し元は生 stdout にフォールバックする）。
 */
function extractStructuredOutput(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { structured_output?: unknown }
    if (parsed.structured_output !== undefined && parsed.structured_output !== null) {
      return JSON.stringify(parsed.structured_output)
    }
  } catch {
    // JSON として読めない場合は undefined を返す
  }
  return undefined
}

/** agy CLI を1回だけ呼び出す。失敗時は分類済み診断情報を添えて返す。 */
function callCliOnce(
  prompt: string,
  cliModel: string,
  provider: ProviderFailureDiagnostics['provider'],
  stage: string,
  jsonSchema?: Record<string, unknown>,
): CliOutcome {
  let schemaDir: string | undefined
  const argv = ['--model', cliModel]
  let effectivePrompt = prompt

  if (jsonSchema !== undefined) {
    schemaDir = mkdtempSync(path.join(tmpdir(), 'agy-schema-'))
    const schemaPath = path.join(schemaDir, 'schema.json')
    writeFileSync(schemaPath, JSON.stringify(jsonSchema))
    argv.push('--output-format', 'json', '--json-schema', schemaPath)
    effectivePrompt = withToolFreeInstruction(prompt)
  }
  argv.push('--print', effectivePrompt)

  try {
    const result = spawnSync(
      AGY_PATH,
      // --add-dir 等でリポジトリを追加公開しない。review input（prompt）だけを渡す。
      // cwd もリポジトリ外の一時ディレクトリに固定し、agy が cwd 経由で暗黙にプロジェクトを
      // 検出してファイルへアクセスすることを避ける（2026-08-24 CEO承認・実測確認済み:
      // --add-dir なし・非リポジトリ cwd でも `--print` の単発応答は正常に動作する）。
      argv,
      { encoding: 'utf-8', timeout: 120_000, env: buildAgyEnv(), cwd: tmpdir() },
    )

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const spawnErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
    const unavailable = spawnErrorCode === 'ENOENT'
    const timedOut = result.signal !== null && result.signal !== undefined
    const rawText = [stderr, stdout, result.error?.message ?? ''].filter(Boolean).join(' ') || '(no output)'

    if (result.status !== 0 || !stdout.trim()) {
      const failureClass = classifyFailure({ text: rawText, exitCode: result.status, timedOut })
      return {
        ok: false,
        text: null,
        unavailable,
        diagnostics: {
          provider, stage, failureClass,
          exitCode: result.status, timedOut,
          message: sanitizeMessage(rawText),
        },
      }
    }

    if (jsonSchema !== undefined) {
      const extracted = extractStructuredOutput(stdout)
      if (extracted !== undefined) {
        return { ok: true, text: extracted, unavailable: false }
      }
      // structured_output を取り出せなかった場合は生の stdout のまま返す。
      // 呼び出し元パーサーは複数候補から JSON を探すため、そのまま渡しても壊れない
      // （fail-open ではなく、既存の多段パースにそのまま委ねるだけ）。
    }

    return { ok: true, text: stdout, unavailable: false }
  } finally {
    if (schemaDir !== undefined) {
      try {
        rmSync(schemaDir, { recursive: true, force: true })
      } catch {
        // 一時ディレクトリの削除失敗はサイレントに無視
      }
    }
  }
}

/**
 * agy CLI を呼び出す。retryTransient かつ failureClass が transient のときだけ固定回数リトライする
 * （既定 false の呼び出し元は従来どおり1回で結果を返す。長時間稼働する Worker からの呼び出しで
 * event loop を同期 sleep でブロックしないため）。
 */
function callCliDetailed(
  prompt: string,
  cliModel: string,
  provider: ProviderFailureDiagnostics['provider'],
  stage: string,
  retryTransient: boolean,
  sleepImpl: (ms: number) => void,
  jsonSchema?: Record<string, unknown>,
): CliOutcome {
  let outcome = callCliOnce(prompt, cliModel, provider, stage, jsonSchema)
  for (
    let attempt = 1;
    retryTransient &&
      attempt < TRANSIENT_MAX_ATTEMPTS && !outcome.ok && outcome.diagnostics?.failureClass === 'transient';
    attempt++
  ) {
    sleepImpl(TRANSIENT_RETRY_DELAYS_MS[attempt - 1])
    outcome = callCliOnce(prompt, cliModel, provider, stage, jsonSchema)
  }
  return outcome
}

interface ApiOutcome {
  ok: boolean
  text: string | null
  diagnostics?: ProviderFailureDiagnostics
}

/** REST API を1回だけ呼び出す。失敗時は分類済み診断情報を添えて返す。 */
async function callApiOnce(prompt: string, stage: string, apiModel?: string): Promise<ApiOutcome> {
  try {
    const text = await callGeminiForReview(prompt, apiModel)
    return { ok: true, text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // @google/generative-ai の一部エラーは .status に HTTP status を持つ（best-effort、無ければ undefined）
    const httpStatus = typeof (err as { status?: unknown })?.status === 'number'
      ? (err as { status: number }).status
      : undefined
    const timedOut = /timed?\s*out|ETIMEDOUT|DEADLINE_EXCEEDED/i.test(msg)
    const failureClass = classifyFailure({ text: msg, httpStatus, timedOut })
    return {
      ok: false,
      text: null,
      diagnostics: {
        provider: 'gemini_api', stage, failureClass, httpStatus, exitCode: null, timedOut,
        message: sanitizeMessage(msg),
      },
    }
  }
}

/**
 * REST API を呼び出す。retryTransient かつ failureClass が transient のときだけ固定回数リトライする
 * （既定 false の呼び出し元は従来どおり1回で結果を返す）。
 */
async function callApiDetailed(
  prompt: string,
  stage: string,
  retryTransient: boolean,
  sleepImpl: (ms: number) => void,
  apiModel?: string,
): Promise<ApiOutcome> {
  let outcome = await callApiOnce(prompt, stage, apiModel)
  for (
    let attempt = 1;
    retryTransient &&
      attempt < TRANSIENT_MAX_ATTEMPTS && !outcome.ok && outcome.diagnostics?.failureClass === 'transient';
    attempt++
  ) {
    sleepImpl(TRANSIENT_RETRY_DELAYS_MS[attempt - 1])
    outcome = await callApiOnce(prompt, stage, apiModel)
  }
  return outcome
}

/**
 * 複数 stage の failureClass を1つに合成する。
 * unavailable（agy バイナリ不在等、環境未整備）な stage は、他に実信号があれば除外する
 * （CIで agy 未インストールなだけの状態が、API段の本当の transient/quota 判定を
 * auth_or_config で覆い隠さないようにするため）。
 */
function combineFailureClasses(diagnostics: ProviderFailureDiagnostics[]): FailureClass {
  if (diagnostics.length === 0) return 'unknown'
  const classes = diagnostics.map((d) => d.failureClass)
  if (classes.every((c) => c === 'quota')) return 'quota'
  if (classes.includes('transient') && classes.every((c) => c === 'quota' || c === 'transient')) return 'transient'
  if (classes.includes('auth_or_config')) return 'auth_or_config'
  return 'unknown'
}

/** cliOutcome/apiOutcome/claudeOutcome の diagnostics を集め、unavailable stage は実信号があれば除外する。 */
function collectDiagnosticsForCombination(outcomes: Array<CliOutcome | ApiOutcome>): ProviderFailureDiagnostics[] {
  const all = outcomes
    .map((o) => o.diagnostics)
    .filter((d): d is ProviderFailureDiagnostics => d !== undefined)
  const reachable = all.filter((_, i) => {
    const outcome = outcomes[i]
    return !('unavailable' in outcome && outcome.unavailable)
  })
  return reachable.length > 0 ? reachable : all
}

/**
 * 両方失敗時の記録 & エラー。
 *
 * failureClass が 'quota' のときだけ quota-exhausted.json に記録する（従来どおり）。
 * それ以外（transient / auth_or_config / unknown）は quota 起因という誤情報を残さないため
 * 記録しない。呼び出し元（metaReviewFallbackRouter.ts）は failureClass を見て、
 * quota・transient のときだけ Copilot フォールバックを試みる。auth_or_config・unknown は
 * リトライ・フォールバックせず fail-closed で終わる（安全側デフォルト）。
 */
function handleBothExhausted(featureName: string, diagnostics: ProviderFailureDiagnostics[]): never {
  const failureClass = combineFailureClasses(diagnostics)

  for (const d of diagnostics) {
    console.warn(
      `[geminiRouter] attempt failed: provider=${d.provider} stage=${d.stage} failureClass=${d.failureClass} ` +
      `httpStatus=${d.httpStatus ?? '-'} exitCode=${d.exitCode ?? '-'} timedOut=${d.timedOut} message=${d.message}`,
    )
  }

  if (failureClass === 'quota') {
    const exhaustedAt = new Date().toISOString()
    const record = { featureName, exhaustedAt, apiExhausted: true, cliExhausted: true }
    try {
      const dataDir = path.join(ROUTER_ROOT, 'data')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(path.join(dataDir, 'quota-exhausted.json'), JSON.stringify(record, null, 2))
    } catch {
      // ファイル書き込み失敗はサイレントに無視
    }
    console.warn(
      `\n⛔ [geminiRouter] Gemini API・CLI 両方の quota が枯渇しています。\n` +
      `   機能: ${featureName}\n` +
      `   有料プランの検討をお勧めします: https://aistudio.google.com/`,
    )
    throw new MetaReviewProviderError(
      `[geminiRouter] Gemini quota exhausted (feature: ${featureName})`, 'quota', diagnostics,
    )
  }

  if (failureClass === 'transient') {
    console.warn(
      `\n⚠️  [geminiRouter] Gemini API・CLI 双方が一時的障害（timeout/network/5xx等）で失敗しました。\n` +
      `   機能: ${featureName}（固定回数リトライ済み）`,
    )
    throw new MetaReviewProviderError(
      `[geminiRouter] Gemini failed, transient (feature: ${featureName})`, 'transient', diagnostics,
    )
  }

  console.warn(
    `\n⚠️  [geminiRouter] Gemini API・CLI 双方が失敗しましたが、quota起因とは確認できません（分類: ${failureClass}）。\n` +
    `   機能: ${featureName}\n` +
    `   quota以外の障害（認証・設定・プログラムエラー等）の可能性があるため、quota-exhausted.json には記録しません。`,
  )
  throw new MetaReviewProviderError(
    `[geminiRouter] Gemini failed, ${failureClass} (feature: ${featureName})`, failureClass, diagnostics,
  )
}

/**
 * CLI (agy/Gemini) と REST API (Gemini) を使い Gemini を呼び出す。
 * 優先側が失敗の場合、もう一方にフォールバックする（transient はこの関数の中で固定回数
 * リトライしてから次の段へ移る）。それでも両方が quota 起因で失敗した場合だけ、
 * Antigravity CLI (agy) 経由の Claude Sonnet へフォールバックする。quota 以外の失敗
 * （プロンプト不正・agy 未認証等）では Claude フォールバックを試みず、そのまま両方失敗として
 * 扱う（無条件フォールバックにしない）。
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
    cliJsonSchema,
    retryTransient = false,
    sleepImpl = defaultSleepSync,
  } = options ?? {}

  let cliOutcome: CliOutcome
  let apiOutcome: ApiOutcome

  if (preferCli) {
    // CLI → API
    cliOutcome = callCliDetailed(prompt, cliModel, 'gemini_cli', featureName, retryTransient, sleepImpl, cliJsonSchema)
    if (cliOutcome.ok) return cliOutcome.text as string

    apiOutcome = await callApiDetailed(prompt, featureName, retryTransient, sleepImpl, apiModel)
    if (apiOutcome.ok) return apiOutcome.text as string
  } else {
    // API → CLI
    apiOutcome = await callApiDetailed(prompt, featureName, retryTransient, sleepImpl, apiModel)
    if (apiOutcome.ok) return apiOutcome.text as string

    cliOutcome = callCliDetailed(prompt, cliModel, 'gemini_cli', featureName, retryTransient, sleepImpl, cliJsonSchema)
    if (cliOutcome.ok) return cliOutcome.text as string
  }

  // Gemini（API・CLI 双方）が quota 起因で失敗した場合だけ Antigravity/Claude を試す。
  const geminiBothQuota =
    cliOutcome.diagnostics?.failureClass === 'quota' && apiOutcome.diagnostics?.failureClass === 'quota'
  let claudeOutcome: CliOutcome | undefined
  if (geminiBothQuota) {
    claudeOutcome = callCliDetailed(
      prompt, ANTIGRAVITY_CLAUDE_FALLBACK_MODEL, 'antigravity_claude_cli', featureName, retryTransient, sleepImpl, cliJsonSchema,
    )
    if (claudeOutcome.ok) return claudeOutcome.text as string
    // 2026-08-26 独立レビュー指摘: Claude段が非quota理由（認証エラー・プログラムエラー等）で
    // 失敗した場合、それをquota起因と混同してCopilotへ静かにフォールバックしてはいけない。
    // 以降の combineFailureClasses() が claudeOutcome の診断情報も含めて再判定するため、
    // ここで個別に判定する必要はない。
  }

  const outcomes = geminiBothQuota && claudeOutcome !== undefined
    ? [cliOutcome, apiOutcome, claudeOutcome]
    : [cliOutcome, apiOutcome]
  const diagnostics = collectDiagnosticsForCombination(outcomes)

  return handleBothExhausted(featureName, diagnostics)
}
