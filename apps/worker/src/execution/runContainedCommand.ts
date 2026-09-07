/**
 * per-job cgroup containment（P1 Phase 2）
 *
 * Job が起動した子プロセス「ツリー全体」を専用 cgroup v2 に閉じ込め、
 * 直接の子が終了しただけでは完了扱いにせず、cgroup が空（`populated 0`）になり
 * cgroup 自体を削除できたことまで確認してから呼び出し元へ戻る。
 *
 * なぜプロセスグループではなく cgroup か: `setsid` した孫はプロセスグループから
 * 抜けるが cgroup からは抜けない（本番実測済み）。
 * なぜ同期実行（execFileSync）では不可能か: 直接の子が D-state に入ると JS スレッドが
 * 復帰せず、kill / drain / reconciliation へ到達できない。加えてコマンドが exit 0 でも
 * daemon 化した孫が残り得る。
 *
 * 本モジュールは「1つのコマンドを封じ込めて実行する」プリミティブのみを提供する。
 * Job の terminalization / ownership 解放の判断は呼び出し元（jobRunner / index）が行う。
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** cgroup v2 の標準マウントポイント */
const CGROUP2_ROOT = '/sys/fs/cgroup'

/** drain（`populated 0` 待ち）の既定上限。本番実測は約31ms で、10秒は約300倍の余裕がある */
export const DEFAULT_DRAIN_MS = 10_000

/** drain のポーリング間隔 */
const DRAIN_POLL_MS = 20

/**
 * 1ストリームあたりの出力上限。`execFileSync` の既定 maxBuffer（1MiB）を明示的に再現する。
 * 非同期 spawn には暗黙の上限が無いため、これが無いと Worker のメモリが青天井になる。
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * placement 用ラッパの固定プログラム文字列。
 * 引数は必ず positional で渡し、この文字列自体は絶対に組み立てない（インジェクション防止）。
 *
 * 手順: 自分の PID を cgroup.procs へ書く → fd 3 へ ack を出す → fd 3 を閉じる →
 * 元のコマンドへ exec する。ack を out-of-band にするのは、exit code 126 では
 * 「placement 失敗」と「ワークロード自身が 126 で終了した」を区別できないため。
 */
const PLACEMENT_PROGRAM =
  'echo $$ > "$1" || exit 126; echo ok >&3; exec 3>&-; shift; exec "$@"'

/** placement ack として fd 3 に現れる文字列 */
const PLACEMENT_ACK = 'ok'

/**
 * containment の結果種別。
 * `clean` / `killed` 以外はすべて containment インフラ側の失敗であり、
 * 呼び出し元は ownership を保持したまま quarantine しなければならない。
 */
export type ContainmentOutcome =
  | 'clean'            // 正常終了し、cgroup も空になって削除できた
  | 'killed'           // timeout / cancel / 生存子孫のため cgroup.kill したが、drain と削除は成功
  | 'drain_timeout'    // cgroup.kill 後も drainMs 以内に `populated 0` にならなかった
  | 'cleanup_failed'   // rmdir に失敗した（EBUSY / ENOTEMPTY 等）
  | 'spawn_failed'     // 子プロセスを起動できなかった（ENOENT / EACCES 等）
  | 'placement_failed' // cgroup.procs への配置に失敗した（ack が来なかった）
  | 'kill_failed'      // cgroup.kill の書き込みに失敗した
  | 'events_failed'    // cgroup.events の読み取り／解析に失敗した
  | 'output_overflow'  // 出力が上限を超えたため打ち切った
  | 'unavailable'      // この環境では containment を提供できない（非 Linux 等）

/** containment が成功と見なせる結果種別 */
const SAFE_OUTCOMES: ReadonlySet<ContainmentOutcome> = new Set<ContainmentOutcome>(['clean', 'killed'])

/**
 * containment 結果が安全（workspace が静止していると証明できた）かどうか。
 * false の場合、呼び出し元は Job を terminalize してはならない。
 */
export function isContainmentSafe(outcome: ContainmentOutcome): boolean {
  return SAFE_OUTCOMES.has(outcome)
}

export interface RunContainedCommandOptions {
  /** cgroup 名に使う Job ID */
  jobId: string
  /** 同一 Job の再試行を区別する試行 ID。cgroup ディレクトリは決して再利用しない */
  attemptId: string
  /** 実行する argv。`resolveCommand()` が返す配列をそのまま渡す */
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /**
   * 実行タイムアウト。`undefined` は「上限なし」を意味する。
   * 上限なしの場合 timeout 起因の containment kill は発生しない点に注意。
   */
  timeoutMs?: number
  /** drain の上限。既定 10 秒 */
  drainMs?: number
  /** 子プロセスの stdin へ書き込む文字列（`execFileSync` の `input` 相当） */
  input?: string
  /** 1ストリームあたりの出力上限バイト数 */
  maxOutputBytes?: number
  /** キャンセル。abort されると containment kill を行う */
  signal?: AbortSignal
}

export interface ContainedResult {
  outcome: ContainmentOutcome
  /** 直接の子の終了コード。シグナルで終了した場合は null */
  exitCode: number | null
  /** 直接の子を終了させたシグナル */
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** timeoutMs を超過したか */
  timedOut: boolean
  /** 直接の子の終了後も cgroup が populated で、kill を要したか */
  killedDescendants: boolean
  /** drain に要した時間（ms） */
  drainMs: number
  /** 失敗種別の詳細（errno 等）。ログ・quarantine metadata 用 */
  detail?: string
  /** 使用した cgroup の絶対パス。ログ・startup audit 用 */
  cgroupPath?: string
}

/** containment インフラ側の失敗。通常のコマンド失敗の catch に吸収させてはならない */
export class ContainmentInfrastructureError extends Error {
  readonly result: ContainedResult

  constructor(result: ContainedResult) {
    super(`containment failed: ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`)
    this.name = 'ContainmentInfrastructureError'
    this.result = result
  }
}

// ────────────────────────────────────────────────────────────
// cgroup の解決
// ────────────────────────────────────────────────────────────

/**
 * `/proc/self/cgroup` から Worker 自身の cgroup を解決する。
 *
 * cgroup v2 では `0::<path>` の1行のみが現れる。この path は cgroup namespace 相対であり、
 * `/` になったり `../` を含んだりし得るため、そのまま信用せず次を確認する:
 * - unified 行がちょうど1つであること
 * - 解決後の path が cgroup2 マウント配下から出ていないこと
 * - 実在し、かつ自分の PID を含むこと（stale path の検出）
 *
 * 解決できない場合は例外ではなく undefined を返し、呼び出し元は unavailable として扱う。
 */
export function resolveWorkerCgroup(): { path: string } | { error: string } {
  if (process.platform !== 'linux') {
    return { error: `containment requires linux (platform=${process.platform})` }
  }

  let raw: string
  try {
    raw = readFileSync('/proc/self/cgroup', 'utf-8')
  } catch (err) {
    return { error: `cannot read /proc/self/cgroup: ${describeError(err)}` }
  }

  const unified = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('0::'))

  if (unified.length !== 1) {
    return { error: `expected exactly one cgroup v2 entry, found ${unified.length}` }
  }

  const relative = unified[0].slice('0::'.length)
  if (relative === '' || !relative.startsWith('/')) {
    return { error: `unexpected cgroup v2 path "${relative}"` }
  }
  if (relative.split('/').includes('..')) {
    return { error: `cgroup path traverses upward: "${relative}"` }
  }

  const resolved = path.resolve(CGROUP2_ROOT, `.${relative}`)
  if (resolved !== CGROUP2_ROOT && !resolved.startsWith(`${CGROUP2_ROOT}/`)) {
    return { error: `resolved cgroup "${resolved}" escapes ${CGROUP2_ROOT}` }
  }
  if (!existsSync(resolved)) {
    return { error: `resolved cgroup "${resolved}" does not exist (stale or namespaced view)` }
  }

  // stale path 検出: 解決した cgroup が本当に自分を含んでいるかを確認する
  let procs: string
  try {
    procs = readFileSync(path.join(resolved, 'cgroup.procs'), 'utf-8')
  } catch (err) {
    return { error: `cannot read cgroup.procs of "${resolved}": ${describeError(err)}` }
  }
  const contained = procs.split('\n').some((line) => line.trim() === String(process.pid))
  if (!contained) {
    return { error: `resolved cgroup "${resolved}" does not contain worker pid ${process.pid}` }
  }

  return { path: resolved }
}

/**
 * この環境で containment を提供できるか。
 * false の場合、containment が必要な Job は「封じ込め無しで実行」ではなく fail closed とする。
 */
export function isContainmentAvailable(): boolean {
  const resolved = resolveWorkerCgroup()
  if ('error' in resolved) return false
  // sub-cgroup を作れるかどうかまで確認する。読めるだけの環境（systemd の Delegate=yes が
  // 効いていない、root 所有のままの CI runner 等）を "利用可能" と誤判定すると、
  // 実行時に mkdir が EACCES で落ちるまで気づけない。
  try {
    accessSync(resolved.path, constants.W_OK)
  } catch {
    return false
  }
  return existsSync(path.join(resolved.path, 'cgroup.procs'))
}

/** cgroup ディレクトリ名。Job ID は UUID だが、同一 Job が再 queued され得るため attempt を必ず付ける */
export function buildCgroupName(jobId: string, attemptId: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')
  return `job-${safe(jobId)}-${safe(attemptId)}`
}

// ────────────────────────────────────────────────────────────
// 本体
// ────────────────────────────────────────────────────────────

export async function runContainedCommand(
  options: RunContainedCommandOptions,
): Promise<ContainedResult> {
  const drainLimitMs = options.drainMs ?? DEFAULT_DRAIN_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  const worker = resolveWorkerCgroup()
  if ('error' in worker) {
    return baseResult('unavailable', { detail: worker.error })
  }

  const cgroupPath = path.join(worker.path, buildCgroupName(options.jobId, options.attemptId))

  // 既存ディレクトリは決して再利用しない。前回の試行が残っているなら
  // それ自体が監査対象であり、その上へ新しいワークロードを載せてはならない。
  if (existsSync(cgroupPath)) {
    return baseResult('cleanup_failed', {
      cgroupPath,
      detail: `cgroup "${cgroupPath}" already exists; refusing to reuse a stale attempt directory`,
    })
  }

  try {
    mkdirSync(cgroupPath)
  } catch (err) {
    return baseResult('unavailable', {
      cgroupPath,
      detail: `cannot create job cgroup: ${describeError(err)}`,
    })
  }

  try {
    return await runInsideCgroup(options, cgroupPath, drainLimitMs, maxOutputBytes)
  } catch (err) {
    // ここへ来るのは想定外の例外のみ。cgroup を作った後なので、
    // 未分類の rejection を漏らさず、後始末を試みてから分類済みの結果を返す。
    const cleanup = await terminateAndCleanup(cgroupPath, drainLimitMs, true)
    return {
      ...baseResult(cleanup.outcome === 'clean' ? 'kill_failed' : cleanup.outcome, {
        cgroupPath,
        detail: `unexpected containment error: ${describeError(err)}`,
      }),
      killedDescendants: true,
      drainMs: cleanup.drainMs,
    }
  }
}

async function runInsideCgroup(
  options: RunContainedCommandOptions,
  cgroupPath: string,
  drainLimitMs: number,
  maxOutputBytes: number,
): Promise<ContainedResult> {
  const procsPath = path.join(cgroupPath, 'cgroup.procs')
  const [program, ...programArgs] = options.argv
  if (program === undefined) {
    await terminateAndCleanup(cgroupPath, drainLimitMs, false)
    return baseResult('spawn_failed', { cgroupPath, detail: 'empty argv' })
  }

  const child = spawn(
    '/bin/sh',
    ['-c', PLACEMENT_PROGRAM, 'sh', procsPath, program, ...programArgs],
    {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // fd 3 は placement ack 専用のパイプ
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    },
  )

  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let stderrBytes = 0
  let overflowed = false
  let placementAcked = false
  let spawnError: string | undefined
  let timedOut = false
  let aborted = false

  // 出力はバイト数で数える。UTF-8 デコード後の文字数では execFileSync の maxBuffer を再現できない。
  const collect = (which: 'out' | 'err') => (chunk: Buffer): void => {
    const current = which === 'out' ? stdoutBytes : stderrBytes
    const remaining = maxOutputBytes - current
    if (remaining <= 0) {
      overflowed = true
      return
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    if (chunk.length > remaining) overflowed = true
    if (which === 'out') {
      stdoutBytes += slice.length
      stdout += slice.toString('utf-8')
    } else {
      stderrBytes += slice.length
      stderr += slice.toString('utf-8')
    }
  }

  child.stdout?.on('data', collect('out'))
  child.stderr?.on('data', collect('err'))

  const ackStream = child.stdio[3]
  if (ackStream && 'on' in ackStream) {
    ackStream.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf-8').includes(PLACEMENT_ACK)) placementAcked = true
    })
    ackStream.on('error', () => { /* ack パイプの異常は placementAcked=false として現れる */ })
  }

  // stdin: エラーリスナを「書く前に」張る。EPIPE のみ許容する（子が読まずに終了した場合）。
  let stdinError: string | undefined
  if (child.stdin) {
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') stdinError = describeError(err)
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  }

  // 終了・timeout・abort の一発勝負（one-shot）。どれが勝っても後始末は必ず1回だけ走る。
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false
    const settle = (value: { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }

    const timer: NodeJS.Timeout | undefined = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          void writeCgroupKill(cgroupPath)
        }, options.timeoutMs)

    const onAbort = (): void => {
      aborted = true
      void writeCgroupKill(cgroupPath)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // `close` ではなく `exit` を待つ。stdio を共有した別プロセスが生きていると
    // `close` は遅れる（まさに封じ込めたい状況で待たされる）。
    child.on('exit', (code, signal) => settle({ code, signal }))
    child.on('error', (err) => {
      spawnError = describeError(err)
      settle({ code: null, signal: null })
    })
  })

  if (spawnError !== undefined) {
    const cleanup = await terminateAndCleanup(cgroupPath, drainLimitMs, false)
    return {
      ...baseResult(cleanup.outcome === 'clean' ? 'spawn_failed' : cleanup.outcome, {
        cgroupPath,
        detail: `spawn failed: ${spawnError}`,
      }),
      drainMs: cleanup.drainMs,
    }
  }

  // placement ack が来ていないなら、ワークロードは cgroup の外で動いた可能性がある。
  // exit code 126 での推測はしない（ワークロード自身が 126 を返し得るため）。
  const placementFailed = !placementAcked

  // 出力上限超過・stdin 異常・abort・timeout・そして「正常終了でも cgroup が空でない」場合は kill する。
  const mustKill = timedOut || aborted || overflowed || stdinError !== undefined || placementFailed
  const cleanup = await terminateAndCleanup(cgroupPath, drainLimitMs, mustKill)

  const result: ContainedResult = {
    outcome: cleanup.outcome,
    exitCode: exited.code,
    signal: exited.signal,
    stdout,
    stderr,
    timedOut,
    killedDescendants: cleanup.killed,
    drainMs: cleanup.drainMs,
    cgroupPath,
  }

  // 後始末が成功していても、実行そのものが安全でなかったケースを上書きする。
  // 順序は「封じ込めの確実性が低いものほど優先」。
  if (isContainmentSafe(cleanup.outcome)) {
    if (placementFailed) {
      return { ...result, outcome: 'placement_failed', detail: 'no placement acknowledgement before exec' }
    }
    if (stdinError !== undefined) {
      return { ...result, outcome: 'kill_failed', detail: `stdin failed: ${stdinError}` }
    }
    if (overflowed) {
      return {
        ...result,
        outcome: 'output_overflow',
        detail: `output exceeded ${maxOutputBytes} bytes per stream`,
      }
    }
  }

  return cleanup.detail === undefined ? result : { ...result, detail: cleanup.detail }
}

// ────────────────────────────────────────────────────────────
// kill / drain / cleanup
// ────────────────────────────────────────────────────────────

interface CleanupResult {
  outcome: ContainmentOutcome
  killed: boolean
  drainMs: number
  detail?: string
}

/**
 * 直接の子の終了後に必ず通る経路。
 *
 * 正常終了（exit 0）でも cgroup が populated なら kill する。v1 設計では kill を
 * timeout / 例外時のみに限定していたが、それだと daemon 化した子孫が drain 上限まで
 * worktree を書き換え続けられてしまう。
 */
async function terminateAndCleanup(
  cgroupPath: string,
  drainLimitMs: number,
  forceKill: boolean,
): Promise<CleanupResult> {
  const started = Date.now()

  let populated: boolean
  try {
    populated = readPopulated(cgroupPath)
  } catch (err) {
    return { outcome: 'events_failed', killed: false, drainMs: 0, detail: describeError(err) }
  }

  let killed = false
  if (forceKill || populated) {
    const killError = writeCgroupKill(cgroupPath)
    if (killError !== undefined) {
      return { outcome: 'kill_failed', killed: false, drainMs: Date.now() - started, detail: killError }
    }
    killed = true
  }

  // drain: `populated 0` になるまで待つ。直接の子の終了だけでは完了扱いにしない。
  while (populated) {
    if (Date.now() - started >= drainLimitMs) {
      return {
        outcome: 'drain_timeout',
        killed,
        drainMs: Date.now() - started,
        detail: `cgroup still populated after ${drainLimitMs}ms`,
      }
    }
    await sleep(DRAIN_POLL_MS)
    try {
      populated = readPopulated(cgroupPath)
    } catch (err) {
      return { outcome: 'events_failed', killed, drainMs: Date.now() - started, detail: describeError(err) }
    }
  }

  const drainMs = Date.now() - started

  try {
    rmdirSync(cgroupPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT は「この試行の cgroup が `populated 0` になったことを確認済み」の場合のみ
    // 冪等な成功として扱う（systemd による unit tree 掃除と競合し得るため）。
    if (code !== 'ENOENT') {
      return { outcome: 'cleanup_failed', killed, drainMs, detail: describeError(err) }
    }
  }

  return { outcome: killed ? 'killed' : 'clean', killed, drainMs }
}

/** `cgroup.events` の `populated` を読む。読み取り・解析の失敗は例外にして fail-closed にする */
function readPopulated(cgroupPath: string): boolean {
  const raw = readFileSync(path.join(cgroupPath, 'cgroup.events'), 'utf-8')
  for (const line of raw.split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (key === 'populated') {
      if (value === '0') return false
      if (value === '1') return true
      throw new Error(`unexpected cgroup.events populated value "${value}"`)
    }
  }
  throw new Error('cgroup.events has no "populated" field')
}

/** `cgroup.kill` へ 1 を書く。カーネルが子孫と競合 fork をまとめて処理する */
function writeCgroupKill(cgroupPath: string): string | undefined {
  try {
    writeFileSync(path.join(cgroupPath, 'cgroup.kill'), '1')
    return undefined
  } catch (err) {
    // 既に消えている場合は kill 不要（drain 側で確認される）
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return describeError(err)
  }
}

// ────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────

function baseResult(
  outcome: ContainmentOutcome,
  extra: { detail?: string; cgroupPath?: string } = {},
): ContainedResult {
  return {
    outcome,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    killedDescendants: false,
    drainMs: 0,
    ...extra,
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code === undefined ? err.message : `${code}: ${err.message}`
  }
  return String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
