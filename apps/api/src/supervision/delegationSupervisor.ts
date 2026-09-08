/**
 * ai_delegation の supervision（Contract C-1〜C-13、Step 3）
 *
 * **新しい daemon は追加しない。** 既存の `scripts/delegate.sh` /
 * `scripts/delegate-watchdog.sh` をそのまま実行主体として使い、
 * ここは「launch と supervised_run 登録を不可分にする」層と
 * 「run_dir の観測を durable state へ写す」層だけを足す。
 *
 * 監視主体は **run ごとの detached process** であり、常駐daemonではない
 * （delegate-watchdog.sh が既にその形をしているのと同じ）。
 * その supervisor 自身が死んだ場合は、Step 2 で入れた
 * markStalledBySupervisor → claimForRecovery → 終端 の経路が受け止める。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import type { IStorage, SupervisedRun } from '../storage/interface'
import { resolvePredicateForRun } from './predicateResolution'
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
  /** delegate.sh が書く log の先。run_dir はこの隣に作る。 */
  logPath: string
  repoRoot: string
}

export type LaunchSupervisedDelegationResult =
  | { status: 'launched'; run: SupervisedRun; claimToken: string; runDir: string }
  | { status: 'already_active'; run: SupervisedRun }
  | { status: 'launch_failed'; run: SupervisedRun; error: string }

export interface DelegationSpawner {
  (input: { runDir: string; logPath: string; model: string; prompt: string; repoRoot: string }): void
}

/** 既定の spawner。`scripts/delegate.sh` を detached で起動し、呼び出し元 session から切り離す。 */
export const spawnDelegateScript: DelegationSpawner = ({ runDir, logPath, model, prompt, repoRoot }) => {
  const child = spawn('bash', [path.join(repoRoot, 'scripts', 'delegate.sh'), model, logPath, prompt], {
    cwd: repoRoot,
    // session / SSH が終了しても委任と supervision が生き残るための要件（Step 3）。
    // 親の stdio を握ったままだと、親 session の終了で SIGHUP / EPIPE が波及する。
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DELEGATION_RUN_DIR: runDir },
  })
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
 * 逆に、行を作った後に spawn が失敗した場合は、その場で run を fail-closed 終端させる。
 * 登録だけ残って RUNNING で放置される状態も作らない（C-1）。
 */
export function launchSupervisedDelegation(
  storage: IStorage,
  input: LaunchSupervisedDelegationInput,
  spawner: DelegationSpawner = spawnDelegateScript,
): LaunchSupervisedDelegationResult {
  registerAiDelegationPredicate()

  const runDir = path.join(path.dirname(input.logPath), `.delegate-${input.subjectId}-${Date.now()}`)

  const created = storage.supervisedRuns.create({
    kind: 'ai_delegation',
    subjectId: input.subjectId,
    predicateKey: AI_DELEGATION_PREDICATE_KEY,
    predicateVersion: AI_DELEGATION_PREDICATE_VERSION,
    supervisor: DELEGATION_SUPERVISOR_NAME,
    progressSource: DELEGATION_PROGRESS_SOURCE,
    // run_dir は completion predicate の入力そのものなので、起動前に確定して記録する。
    progressEvidence: { runDir, model: input.model },
    currentStage: 'launching',
  })

  // 同一 subject に active な委任がある場合、二重起動しない。
  // 既存の所有者から所有権を奪わないため claimToken も発行されない。
  if (!created.created || !created.claimToken) {
    return { status: 'already_active', run: created.run }
  }

  try {
    mkdirSync(runDir, { recursive: true })
    spawner({ runDir, logPath: input.logPath, model: input.model, prompt: input.prompt, repoRoot: input.repoRoot })
  } catch (err) {
    const error = `delegation launch failed: ${err instanceof Error ? err.message : String(err)}`
    storage.supervisedRuns.failClosed(created.run.id, created.claimToken, error)
    return { status: 'launch_failed', run: created.run, error }
  }

  storage.supervisedRuns.recordProgress(created.run.id, created.claimToken, {
    currentStage: 'delegating',
    progressEvidence: { runDir, model: input.model },
  })

  return { status: 'launched', run: created.run, claimToken: created.claimToken, runDir }
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

  // まだ終わっていない。実進捗（log が伸びた）が観測できたときだけ heartbeat を進める。
  const observedBytes = Number(evaluation.evidence.logBytes ?? 0)
  const previousBytes = Number(run.progressEvidence?.logBytes ?? -1)

  if (observedBytes !== previousBytes) {
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
  if (claimed.exhausted) return { status: 'recovery_exhausted' }
  if (!claimed.claimToken) return { status: 'not_stalled' }

  // 所有権を取ってから、まず**診断としての再評価**を行う。
  return observeAndAdvance(storage, runId, claimed.claimToken)
}

/** run_dir の観測値だけを見たいとき用（診断ログ・テスト向け）。 */
export { observeDelegationRunDir }
