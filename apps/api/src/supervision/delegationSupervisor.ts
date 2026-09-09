/**
 * ai_delegation の supervision（Contract C-1〜C-13、Step 3）
 *
 * **新しい daemon も、run ごとの新しい supervisor process も追加しない**（CEO確定構造）。
 * 責務は次のとおり分かれている:
 *
 * ```
 * launchSupervisedDelegation → supervised_runs 登録 → trusted runId/runDir
 *   → delegate.sh → delegate-watchdog.sh
 *        … 実processの監督 / progress監視 / marker・verdict生成 / stalled診断 / bounded retry
 *   → 既存Worker poll/watchdog（reconcile.ts）
 *        … runDir の事実を supervised_runs へ反映 / watchdog自身が死んだrunの検出 / continuation
 * ```
 *
 * - `delegate-watchdog.sh` … **retry actor はここだけ**
 * - `supervised_runs`      … durable な正本
 * - Worker poll/watchdog   … reconcile と continuation。**retry しない**（二重化禁止）
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import type { IStorage, SupervisedRun } from '../storage/interface'
import { resolvePredicateForRun } from './predicateResolution'
import { runDirFor } from './runDirectory'
import {
  AI_DELEGATION_PREDICATE_KEY,
  AI_DELEGATION_PREDICATE_VERSION,
  isFormalVerdict,
  observeDelegationRunDir,
  registerAiDelegationPredicate,
  terminalStatusForVerdict,
} from './aiDelegationPredicate'

export const DELEGATION_SUPERVISOR_NAME = 'delegate_watchdog'
export const DELEGATION_PROGRESS_SOURCE = 'delegate_run_dir'

export interface LaunchSupervisedDelegationInput {
  /** 委任の識別子（PR番号 / task key 等）。同一 subject の二重起動を防ぐキーになる。 */
  subjectId: string
  model: string
  prompt: string
  repoRoot: string
}

export type LaunchSupervisedDelegationResult =
  | { status: 'launched'; run: SupervisedRun; claimToken: string; runDir: string }
  | { status: 'already_active'; run: SupervisedRun }
  | { status: 'launch_failed'; run: SupervisedRun; error: string }

export interface DelegationSpawnInput {
  runDir: string
  logPath: string
  model: string
  prompt: string
  repoRoot: string
  /**
   * spawn が**非同期に**失敗したときに呼ばれる（独立レビュー指摘 Step 3 #2）。
   * `spawn()` は戻った後に 'error' を出し得るため、同期 throw だけを捕まえていると
   * `bash` 不在・EACCES・cwd 不正で **DB 行だけ RUNNING で残る**。
   */
  onAsyncError: (error: Error) => void
}

export type DelegationSpawner = (input: DelegationSpawnInput) => void

/** 既定の spawner。`scripts/delegate.sh` を detached で起動し、呼び出し元 session から切り離す。 */
export const spawnDelegateScript: DelegationSpawner = (input) => {
  const child = spawn(
    'bash',
    [path.join(input.repoRoot, 'scripts', 'delegate.sh'), input.model, input.logPath, input.prompt],
    {
      cwd: input.repoRoot,
      // session / SSH が終了しても委任と supervision が生き残るための要件（Step 3）。
      // 親の stdio を握ったままだと、親 session の終了で SIGHUP / EPIPE が波及する。
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DELEGATION_RUN_DIR: input.runDir },
    },
  )

  // spawn の失敗は同期 throw では来ない。ここで拾わないと行が RUNNING のまま残る。
  child.on('error', (err) => input.onAsyncError(err instanceof Error ? err : new Error(String(err))))

  // 親のイベントループから切り離す。以後この child は親の生死と無関係に走る。
  child.unref()
}

/**
 * **launch と supervised_run 登録を不可分にする。**
 *
 * run 行の作成が先で、作成できなければ **launch しない**。
 * これにより「起動したが誰も見ていない委任」が構造的に作れなくなる
 * （実障害ケース1がまさにこれだった）。
 *
 * 逆に、行を作った後に spawn が失敗した場合は、同期・非同期どちらでも
 * その場で run を fail-closed 終端させる。登録だけ残って RUNNING で放置される状態も作らない（C-1）。
 *
 * runDir は **server 生成の runId のみ**から決まる（独立レビュー指摘 Step 3 #3）。
 * 呼び出し元は log path も runDir も指定できない。
 */
export function launchSupervisedDelegation(
  storage: IStorage,
  input: LaunchSupervisedDelegationInput,
  spawner: DelegationSpawner = spawnDelegateScript,
): LaunchSupervisedDelegationResult {
  registerAiDelegationPredicate()

  const created = storage.supervisedRuns.create({
    kind: 'ai_delegation',
    subjectId: input.subjectId,
    predicateKey: AI_DELEGATION_PREDICATE_KEY,
    predicateVersion: AI_DELEGATION_PREDICATE_VERSION,
    supervisor: DELEGATION_SUPERVISOR_NAME,
    progressSource: DELEGATION_PROGRESS_SOURCE,
    progressEvidence: { model: input.model },
    currentStage: 'launching',
  })

  // 同一 subject に active な委任がある場合、二重起動しない。
  // 既存の所有者から所有権を奪わないため claimToken も発行されない。
  if (!created.created || !created.claimToken) {
    return { status: 'already_active', run: created.run }
  }

  const claimToken = created.claimToken
  const runId = created.run.id

  let runDir: string
  try {
    runDir = runDirFor(runId)
  } catch (err) {
    const error = `cannot derive a trusted run directory: ${err instanceof Error ? err.message : String(err)}`
    storage.supervisedRuns.failClosed(runId, claimToken, error)
    return { status: 'launch_failed', run: created.run, error }
  }

  // log も runDir 配下に固定する。current_log は runDir 配下しか許可しないので、
  // ここを外に置くと predicate が自分の log を読めなくなる。
  const logPath = path.join(runDir, 'delegation.log')

  const failClosedOnSpawnError = (err: Error): void => {
    const error = `delegation launch failed: ${err.message}`
    // 既に終端していれば false が返るだけで、二重終端にはならない。
    storage.supervisedRuns.failClosed(runId, claimToken, error)
  }

  try {
    mkdirSync(runDir, { recursive: true })
    spawner({
      runDir,
      logPath,
      model: input.model,
      prompt: input.prompt,
      repoRoot: input.repoRoot,
      onAsyncError: failClosedOnSpawnError,
    })
  } catch (err) {
    const error = `delegation launch failed: ${err instanceof Error ? err.message : String(err)}`
    storage.supervisedRuns.failClosed(runId, claimToken, error)
    return { status: 'launch_failed', run: created.run, error }
  }

  storage.supervisedRuns.recordProgress(runId, claimToken, {
    currentStage: 'delegating',
    progressEvidence: { model: input.model, runDir },
  })

  return { status: 'launched', run: created.run, claimToken, runDir }
}

export type ObserveOutcome =
  | { status: 'progressed'; logBytes: number }
  | { status: 'waiting' }
  | { status: 'terminal'; terminal: 'succeeded' | 'failed'; formalVerdict: string }
  | { status: 'fail_closed'; error: string }
  | { status: 'stale_owner' }

/**
 * 終端時の automatic continuation。
 *
 * 「委任が終わったのに誰も気付かない」を構造的に潰すための唯一のフックであり、
 * **終端を durable に書けたときだけ**（＝ fencing を通過したときだけ）呼ばれる。
 * stale owner の書き込みが弾かれた場合には呼ばれないので、二重continuation は起きない。
 *
 * ここで新しい通知機構は作らない。既定は既存 notifier（`sendAlert`）へ委ねる想定で、
 * 注入可能にしてあるのは、呼び出し元（PL delegation / Job workflow）ごとに
 * 「次に何が動くか」が違うためである。
 */
export type DelegationContinuation = (input: {
  run: SupervisedRun
  terminal: 'succeeded' | 'failed'
  terminalVerdict: string
}) => void | Promise<void>

let continuationHook: DelegationContinuation | undefined

/** automatic continuation の登録。未登録なら継続動作は行われない（黙って成功扱いにはしない）。 */
export function setDelegationContinuation(hook: DelegationContinuation | undefined): void {
  continuationHook = hook
}

async function runContinuation(
  storage: IStorage,
  runId: string,
  terminal: 'succeeded' | 'failed',
  terminalVerdict: string,
): Promise<void> {
  if (!continuationHook) return
  const run = storage.supervisedRuns.findById(runId)
  if (!run) return
  try {
    await continuationHook({ run, terminal, terminalVerdict })
  } catch (err) {
    // continuation の失敗で終端を巻き戻さない。終端は既に durable であり、
    // ここで throw すると supervisor が落ちて「終端済みなのに誰も知らない」に戻る。
    console.error(
      `[delegationSupervisor] continuation failed for run ${runId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * run_dir を1回観測し、durable state を更新する。supervisor のループから呼ぶ。
 *
 * **PID は見ない。** 見るのは log の実バイト数と formal verdict だけである
 * （C-2 / PID alive != healthy、C-2a / log activity を唯一の根拠にしない場合も
 * verdict という独立した completion signal を持つ）。
 */
export async function observeAndAdvance(
  storage: IStorage,
  runId: string,
  claimToken: string,
): Promise<ObserveOutcome> {
  const run = storage.supervisedRuns.findById(runId)
  if (!run) return { status: 'fail_closed', error: 'supervised run disappeared' }

  // predicate は毎回 registry から復元する（再起動後も同じ判定を再現するため）。
  // 解決できなければ resolvePredicateForRun がその場で fail-closed 終端させる。
  const resolved = resolvePredicateForRun(storage, run, claimToken)
  if (!resolved.ok) {
    return resolved.terminated ? { status: 'fail_closed', error: resolved.error } : { status: 'stale_owner' }
  }

  const evaluation = await resolved.evaluate({
    runId: run.id,
    kind: 'ai_delegation',
    subjectId: run.subjectId,
    progressEvidence: run.progressEvidence,
  })

  if (evaluation.outcome === 'unevaluatable') {
    // 判定不能を「待ち続ける」に倒さない（C-1 / D-2）。
    const fenced = storage.supervisedRuns.failClosed(run.id, claimToken, evaluation.reason)
    return fenced ? { status: 'fail_closed', error: evaluation.reason } : { status: 'stale_owner' }
  }

  if (evaluation.outcome === 'satisfied') {
    const formalVerdict = String(evaluation.evidence.formalVerdict ?? '')
    if (!isFormalVerdict(formalVerdict)) {
      const error = `predicate reported satisfied without a formal verdict: ${formalVerdict.slice(0, 120)}`
      const fenced = storage.supervisedRuns.failClosed(run.id, claimToken, error)
      return fenced ? { status: 'fail_closed', error } : { status: 'stale_owner' }
    }

    const terminal = terminalStatusForVerdict(formalVerdict)
    const fenced = storage.supervisedRuns.complete(run.id, claimToken, terminal, {
      terminalVerdict: formalVerdict,
      completionEvidence: evaluation.evidence,
      error: terminal === 'failed' ? formalVerdict : undefined,
    })
    if (!fenced) return { status: 'stale_owner' }

    // 終端が durable に確定した後にだけ continuation を走らせる。
    // fencing で弾かれた書き込みからは呼ばれないので、二重continuation にならない。
    await runContinuation(storage, run.id, terminal, formalVerdict)
    return { status: 'terminal', terminal, formalVerdict }
  }

  // まだ終わっていない。**実際に出力が増えたときだけ** heartbeat を進める。
  //
  // 独立レビュー指摘(Step 3 #4): 以前は previousBytes の既定を -1 にしていたため、
  // log が空・不在（observedBytes = 0）の初回観測が「0 !== -1」で progress 扱いになっていた。
  // 1 byte も出ていない状態を「生きている証拠」にするのは、この機構が潰そうとしている
  // 「PID は生きているから healthy」と同じ誤りである。
  const observedBytes = Number(evaluation.evidence.logBytes ?? 0)
  const previousBytes = Number(run.progressEvidence?.logBytes ?? 0)

  // 出力が実際に増えた場合だけ progress とみなす。減少（log rotation / attempt 切替）は
  // 増加ではないので heartbeat を進めない — 進捗の証拠になっていないため。
  const grew = observedBytes > previousBytes

  if (grew) {
    const ok = storage.supervisedRuns.recordProgress(run.id, claimToken, {
      currentStage: 'delegating',
      progressEvidence: { ...(run.progressEvidence ?? {}), ...evaluation.evidence },
    })
    return ok ? { status: 'progressed', logBytes: observedBytes } : { status: 'stale_owner' }
  }

  return { status: 'waiting' }
}

/**
 * supervisor が死んだ run の受け皿（診断 → bounded recovery → 終端）。
 *
 * **blind retry しない**（C-5）。まず completion predicate を再評価する:
 * 「実処理は完了しているが wrapper だけ終わらない」ケース（C-12 / Acceptance Case C）は
 * ここで success として回収される。実障害ケース2で実際に起きた形である。
 */
export async function diagnoseAndRecover(
  storage: IStorage,
  runId: string,
  supervisor: string = DELEGATION_SUPERVISOR_NAME,
): Promise<ObserveOutcome | { status: 'not_stalled' } | { status: 'recovery_exhausted' }> {
  registerAiDelegationPredicate()

  const stalled = storage.supervisedRuns.findById(runId)
  if (!stalled || stalled.status !== 'stalled') return { status: 'not_stalled' }

  const claimed = storage.supervisedRuns.claimForRecovery(runId, supervisor)
  if (claimed.exhausted) {
    // 独立レビュー指摘（最終ラウンド #1）: 上限超過の終端は `claimForRecovery()` の中で
    // 起きるため、observeAndAdvance を通らない。ここで continuation を呼ばないと
    // **「recovery できずに終わった run」だけが誰にも通知されない**という、
    // 最も知らせるべきケースが黙って消える。
    // 終端は claimForRecovery 内で確定済みなので、二重終端にはならない。
    await runContinuation(storage, runId, 'failed', 'recovery_exhausted')
    return { status: 'recovery_exhausted' }
  }
  if (!claimed.claimToken) return { status: 'not_stalled' }

  // 所有権を取ってから、まず**診断としての再評価**を行う。
  return observeAndAdvance(storage, runId, claimed.claimToken)
}

/** run_dir の観測値だけを見たいとき用（診断ログ・テスト向け）。 */
export { observeDelegationRunDir }
