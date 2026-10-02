import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * ## latency / timeout 契約（cheap AI = OpenCode CLI の1経路だけ）
 *
 * AI CLI 呼び出しは `runOpenCodeCli` の1種類だけで、caller の種類で試行回数だけが変わる。
 *
 * | caller | 試行 | 1試行の期限 | CLI 起動後の最悪待ち |
 * | --- | --- | --- | --- |
 * | 説明・質問（approvalAi / taskFailureAi） | 1回 | `CHEAP_AI_ATTEMPT_TIMEOUT_MS` | `CHEAP_AI_SINGLE_ATTEMPT_MAX_WAIT_MS` |
 * | PL 推論（`retryTransientOnce: true`） | 最大2回 | 同上 | `CHEAP_AI_RETRYING_MAX_WAIT_MS` |
 *
 * - **timeout**: 期限到達で AIteamOS がプロセスグループへ SIGTERM、`CHEAP_AI_KILL_GRACE_MS` 後に SIGKILL して
 *   close を待たずに決着する。CLI 起動後の1試行が `CHEAP_AI_SINGLE_ATTEMPT_MAX_WAIT_MS` を超えることはない。
 *   上限は CLI 起動から数える。プロセスごとに初回だけ行う隔離 dir の作成（`getIsolation()`）は含まない。
 * - **retry**: `retryTransientOnce` の caller に限り、`timeout` / `abnormal_termination` のときだけ
 *   `CHEAP_AI_RETRY_BACKOFF_MS` 待って新しいプロセスで1回だけ再試行する。それ以外（exit code != 0・stderr・
 *   不正出力・起動失敗・key 未設定・意図的な停止 signal）は再試行しない。説明系は HTTP の待ちを倍にしないため再試行しない。
 * - **fallback**: 別 provider / 別 model への切り替えはしない（provider 抽象は本 client の責務外）。
 *   失敗は `CheapAiAttemptError`（`kind` で理由を区別）として throw し、`requestTextResult` を使う caller には
 *   `{ ok: false, reason }` の構造化結果として返す。CLI が遅い・使えないときに部分的な回答や推測で埋めない。
 * - 期限 60 秒は暫定値であり、記録済みの実 latency（66〜74 秒）の分布に基づいて決めたものではない。
 *   値を変えるときは本定数だけを変える（caller・テストは定数を参照する）。
 */
export const CHEAP_AI_ATTEMPT_TIMEOUT_MS = 60_000

export const CHEAP_AI_CONFIG = {
  role: 'cheap_explainer',
  provider: 'opencode-go',
  model: 'mimo-v2.5',
  timeoutMs: CHEAP_AI_ATTEMPT_TIMEOUT_MS,
} as const

/** この経路の provider/model id。診断表示専用で、routing には使わない。 */
export const CHEAP_AI_PROPOSER_ID = `${CHEAP_AI_CONFIG.provider}/${CHEAP_AI_CONFIG.model}`

/**
 * timeout で止めた OpenCode が SIGTERM に応じないときに SIGKILL へ昇格させるまでの猶予。
 * 猶予後は close を待たずに settle する（孫プロセスが stdout を掴んだままでも宙吊りにしない）。
 * 値と止め方は Design Review runner（`designReviewCoordinator.ts` の `killTree`）と同じ。
 */
export const CHEAP_AI_KILL_GRACE_MS = 5_000

/** bounded retry の2回目を始める前の待ち。固定値（判定ロジックは足さない）。 */
export const CHEAP_AI_RETRY_BACKOFF_MS = 3_000

/** CLI 起動後の1試行（説明・質問経路）の上限。期限 + SIGKILL 昇格までの猶予。初回の隔離 dir 作成は含まない。 */
export const CHEAP_AI_SINGLE_ATTEMPT_MAX_WAIT_MS = CHEAP_AI_ATTEMPT_TIMEOUT_MS + CHEAP_AI_KILL_GRACE_MS

/** `retryTransientOnce` の caller（PL 推論）の CLI 起動後の上限。2試行 + backoff。初回の隔離 dir 作成は含まない。 */
export const CHEAP_AI_RETRYING_MAX_WAIT_MS =
  CHEAP_AI_SINGLE_ATTEMPT_MAX_WAIT_MS * 2 + CHEAP_AI_RETRY_BACKOFF_MS

/**
 * **明らかな異常終了**だけを表す signal。AIteamOS が送っていないのにこれで終わったときだけ、
 * `retryTransientOnce` の caller に限って1回だけ再試行する（OOM killer の SIGKILL・crash 等）。
 *
 * SIGTERM / SIGINT / SIGHUP / SIGQUIT は**意図的な停止**（systemd の stop は
 * `KillMode=control-group` で子にも SIGTERM を送る）と区別できないので再試行しない。
 * shutdown 中に新しい OpenCode を起動しないのはこの境界による。
 */
const ABNORMAL_TERMINATION_SIGNALS: ReadonlySet<string> = new Set([
  'SIGKILL',
  'SIGSEGV',
  'SIGBUS',
  'SIGILL',
  'SIGFPE',
  'SIGABRT',
])

// Previous raw transport endpoint, retained only as a rollback reference:
// https://opencode.ai/zen/go/v1/chat/completions
const OPENCODE_PROJECT_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: 'deny',
} as const

interface CheapAiIsolation {
  homeDirectory: string
  workingDirectory: string
}

interface OpenCodeTextEvent {
  type?: unknown
  part?: {
    text?: unknown
  }
}

let isolationPromise: Promise<CheapAiIsolation> | undefined

export interface CheapAiRequestOptions {
  apiKey?: string
  mockResponse?: string
  /**
   * PL の provider 推論（Operator Request の回答・対象選択、自律 PL の診断・採用・修正案）だけが
   * true にする。1回目が **AIteamOS 自身の timeout** か **明らかな異常終了**で失敗したときに限り、
   * 新しい OpenCode プロセスで1回だけ再試行する（3回目は無い）。
   *
   * 再試行するのは推論だけで、caller はどれも action 実行より前にこれを呼ぶ。
   * 説明系（approvalAi / taskFailureAi）は HTTP の待ち時間を倍にしないため指定しない。
   */
  retryTransientOnce?: boolean
}

/** 1回の OpenCode 実行が失敗した種類。再試行してよいのは `timeout` と `abnormal_termination` だけ。 */
export type CheapAiAttemptFailureKind = 'timeout' | 'abnormal_termination' | 'non_retryable'

export class CheapAiAttemptError extends Error {
  constructor(message: string, readonly kind: CheapAiAttemptFailureKind) {
    super(message)
    this.name = 'CheapAiAttemptError'
  }
}

/**
 * `requestText` の失敗を throw せずに返す構造化結果。`reason` は `CheapAiAttemptError.kind` と同じ値で、
 * `CheapAiAttemptError` 以外（key 未設定・隔離 dir の作成失敗など）は `non_retryable` に寄せる。
 * 再試行後の失敗は2回目の種類を `reason` にする（`message` に1回目の種類も残る）。
 */
export type CheapAiTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: CheapAiAttemptFailureKind; message: string }

export function toCheapAiFailure(error: unknown): Extract<CheapAiTextResult, { ok: false }> {
  return {
    ok: false,
    reason: error instanceof CheapAiAttemptError ? error.kind : 'non_retryable',
    message: error instanceof Error ? error.message : String(error),
  }
}

export function parseJsonObject(raw: string): unknown {
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!jsonMatch) {
    throw new Error('AI response did not contain a JSON object')
  }
  return JSON.parse(jsonMatch[1] ?? jsonMatch[0])
}

async function createIsolation(): Promise<CheapAiIsolation> {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'ai-team-cheap-ai-'))
  const homeDirectory = join(baseDirectory, 'home')
  const workingDirectory = join(baseDirectory, 'work')

  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700 }),
    mkdir(workingDirectory, { mode: 0o700 }),
  ])
  await Promise.all([
    chmod(baseDirectory, 0o700),
    chmod(homeDirectory, 0o700),
    chmod(workingDirectory, 0o700),
  ])
  await writeFile(
    join(workingDirectory, 'opencode.json'),
    `${JSON.stringify(OPENCODE_PROJECT_CONFIG, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )

  return { homeDirectory, workingDirectory }
}

function getIsolation(): Promise<CheapAiIsolation> {
  isolationPromise ??= createIsolation()
  return isolationPromise
}

function resolveOpenCodeCliEntrypoint(): string {
  const relativeEntrypoint = join('node_modules', 'opencode-ai', 'bin', 'opencode.exe')
  const candidates = [
    resolve(__dirname, '..', '..', relativeEntrypoint),
    resolve(__dirname, '..', '..', '..', relativeEntrypoint),
    resolve(__dirname, '..', '..', '..', '..', relativeEntrypoint),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function buildPrompt(system: string, userContent: string, maxTokens: number): string {
  return [
    `Role: ${CHEAP_AI_CONFIG.role}`,
    'System instructions:',
    system,
    '',
    `Keep the response within ${maxTokens} tokens.`,
    '',
    'User content:',
    userContent,
  ].join('\n')
}

function buildSubprocessEnv(homeDirectory: string, apiKey: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    LANG: process.env.LANG ?? 'C.UTF-8',
    OPENCODE_API_KEY: apiKey,
  }
}

function redactApiKey(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, '[REDACTED]')
}

function parseOpenCodeOutput(stdout: string): string {
  const textParts: string[] = []

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue

    let event: OpenCodeTextEvent
    try {
      event = JSON.parse(line) as OpenCodeTextEvent
    } catch {
      throw new Error('OpenCode CLI response contained invalid JSON')
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      textParts.push(event.part.text)
    }
  }

  const text = textParts.join('').trim()
  if (text.length === 0) {
    throw new Error('OpenCode CLI response did not contain text')
  }
  return text
}

/**
 * OpenCode を1回実行する。**timeout は spawn のオプションに任せず自前で持つ。**
 *
 * - AIteamOS が期限到達を観測して止めたことを `timedOutByUs` で保持する。signal 名だけでは
 *   「自分で止めた」「外から止められた」「crash した」を区別できないため
 *   （Worker adapter が containment の `timedOut` を唯一の真実にしているのと同じ考え方）。
 * - 子を新しいプロセスグループのリーダーにして（`detached: true`）グループごと SIGTERM を送り、
 *   猶予後も残っていれば SIGKILL へ昇格させ、close を待たずに settle する。
 *   OpenCode は初回に大きな初期化を行うので、孫が生き残ると次の試行と同じ HOME を奪い合う。
 * - 別グループにするので、**API 自体が落ちたときの子の回収は systemd の `KillMode=control-group` に依存する**
 *   （Design Review runner と同じ前提。systemd 外で API だけを止めると子は残りうる）。
 */
async function runOpenCodeCli(
  system: string,
  userContent: string,
  apiKey: string,
  maxTokens: number,
): Promise<string> {
  const isolation = await getIsolation()
  const cliEntrypoint = resolveOpenCodeCliEntrypoint()
  const model = `${CHEAP_AI_CONFIG.provider}/${CHEAP_AI_CONFIG.model}`
  const prompt = buildPrompt(system, userContent, maxTokens)
  const args = [
    'run',
    '-m',
    model,
    '--format',
    'json',
    '--dir',
    isolation.workingDirectory,
    prompt,
  ]
  const timeoutMessage = `OpenCode CLI timed out after ${CHEAP_AI_ATTEMPT_TIMEOUT_MS}ms`

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(cliEntrypoint, args, {
      cwd: isolation.workingDirectory,
      env: buildSubprocessEnv(isolation.homeDirectory, apiKey),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOutByUs = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const killTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // 既に終了している。
        }
      }
    }

    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      outcome()
    }
    const fail = (message: string, kind: CheapAiAttemptFailureKind): void => {
      settle(() => rejectPromise(new CheapAiAttemptError(message, kind)))
    }

    const timer = setTimeout(() => {
      timedOutByUs = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => {
        killTree('SIGKILL')
        fail(timeoutMessage, 'timeout')
      }, CHEAP_AI_KILL_GRACE_MS)
    }, CHEAP_AI_ATTEMPT_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    // on（once ではない）: kill の fallback 等で2回目の error が来ても未処理にしない。settle が二重決着を防ぐ。
    child.on('error', (error: Error) => {
      const detail = redactApiKey(error.message, apiKey)
      fail(`OpenCode CLI failed to start: ${detail}`, 'non_retryable')
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // 自分で止めたものは、どう終わっても timeout として扱う（正常終了扱いにしない）。
      // 先頭の子だけが SIGTERM で終わっても孫がグループに残りうるので、SIGKILL で掃いてから決着させる
      // （残った孫が再試行と同じ隔離 HOME を奪い合わないように）。
      if (timedOutByUs) {
        killTree('SIGKILL')
        fail(timeoutMessage, 'timeout')
        return
      }
      if (signal !== null) {
        if (ABNORMAL_TERMINATION_SIGNALS.has(signal)) {
          killTree('SIGKILL')
          fail(`OpenCode CLI terminated abnormally by signal ${signal}`, 'abnormal_termination')
        } else {
          fail(`OpenCode CLI was terminated by signal ${signal}`, 'non_retryable')
        }
        return
      }

      const sanitizedStderr = redactApiKey(stderr.trim(), apiKey)
      if (code !== 0) {
        const detail = sanitizedStderr.length > 0 ? `: ${sanitizedStderr}` : ''
        fail(`OpenCode CLI failed with exit code ${code ?? 'unknown'}${detail}`, 'non_retryable')
        return
      }
      if (sanitizedStderr.length > 0) {
        fail(`OpenCode CLI wrote to stderr: ${sanitizedStderr}`, 'non_retryable')
        return
      }

      try {
        const text = parseOpenCodeOutput(stdout)
        settle(() => resolvePromise(text))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        fail(message, 'non_retryable')
      }
    })
  })
}

function isRetryable(error: unknown): error is CheapAiAttemptError {
  return error instanceof CheapAiAttemptError && error.kind !== 'non_retryable'
}

function attemptKindOf(error: unknown): CheapAiAttemptFailureKind {
  return toCheapAiFailure(error).reason
}

/** `requestText` と同じ試行・timeout・再試行で実行し、失敗を throw せず `CheapAiTextResult` で返す。 */
export async function requestTextResult(
  system: string,
  userContent: string,
  options: CheapAiRequestOptions,
  maxTokens: number,
): Promise<CheapAiTextResult> {
  try {
    return { ok: true, text: await requestText(system, userContent, options, maxTokens) }
  } catch (error: unknown) {
    return toCheapAiFailure(error)
  }
}

export async function requestText(
  system: string,
  userContent: string,
  options: CheapAiRequestOptions,
  maxTokens: number,
): Promise<string> {
  if (options.mockResponse !== undefined) {
    return options.mockResponse
  }

  const apiKey = options.apiKey ?? process.env.OPENCODE_GO_API_KEY
  if (!apiKey) {
    throw new Error('OPENCODE_GO_API_KEY is not configured')
  }

  if (options.retryTransientOnce !== true) {
    return await runOpenCodeCli(system, userContent, apiKey, maxTokens)
  }

  // bounded recovery: 最大2回。記録するのは試行番号と失敗の種類だけ
  // （prompt・key・provider stderr はログにも audit にも新たに載せない）。
  try {
    return await runOpenCodeCli(system, userContent, apiKey, maxTokens)
  } catch (firstError: unknown) {
    if (!isRetryable(firstError)) throw firstError
    console.warn(`[cheapAi] attempt 1/2 failed (${firstError.kind}); retrying once with a fresh OpenCode process`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, CHEAP_AI_RETRY_BACKOFF_MS))

    try {
      const text = await runOpenCodeCli(system, userContent, apiKey, maxTokens)
      console.warn(`[cheapAi] attempt 2/2 succeeded (attempt 1: ${firstError.kind})`)
      return text
    } catch (secondError: unknown) {
      console.warn(`[cheapAi] attempt 2/2 failed (${attemptKindOf(secondError)}; attempt 1: ${firstError.kind})`)
      const message = secondError instanceof Error ? secondError.message : String(secondError)
      throw new CheapAiAttemptError(
        `${message} (attempt 2/2; attempt 1: ${firstError.kind})`,
        attemptKindOf(secondError),
      )
    }
  }
}
