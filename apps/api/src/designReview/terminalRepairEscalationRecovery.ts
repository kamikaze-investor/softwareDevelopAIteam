/**
 * **却下で終端した repair-purpose run の Human escalation を、着地していなければ着地させる。**
 *
 * ## なぜ要るか（2026-09-22 横断監査 U3）
 *
 * `executeQueuedRepair()` は判定が ALIGNED でなければ人へ渡す。ところがその 2 段は
 * transaction で結ばれていない:
 *
 *   executeDesignReviewRun()
 *     └ 非 ALIGNED → complete(run, 'succeeded', stdout, rejectedReason)   ← durable
 *     └ return { status: 'not_aligned' }
 *          ★ ここで落ちると ★
 *   escalateTaskToHuman(storage, taskId)                                  ← 実行されない
 *
 * 結果、run は terminal、evidence は無く、**Task は blocked にならない**。
 * 却下そのものは durable に残っているのに、それが誰にも渡らないまま停止する。
 *
 * U2（ALIGNED → repair Job）と同型で、**失われる successor が Human escalation** である点だけが
 * 違う。`succeeded` な run に対する attention producer は `idle`（queued）と `failed` しか
 * 見ていないため（`systemState.ts`）、この状態は attention にも現れない。
 *
 * ## 何を対象にしないか
 *
 * **`status='failed'` は対象にしない。** あちらは既存 `design_review_failed` attention が
 * 観測しており、ここで拾うと同じ停止に 2 つの escalation を作る。shared read が
 * `succeeded` しか返さないことでそれを機械的に保証している。
 *
 * **ALIGNED は絶対に escalate しない。** それは U2 の領分（repair Job successor）である。
 * 判定は run 自身の `resultJson` を計算し直して決める（`safeRecomputedDecision()`）。
 * 同じ判定を再実装しない。
 */
import { escalateTaskToHuman, safeRecomputedDecision } from './repairFlow'
import { repairStepKeyFor } from './repairPolicy'
import type { DesignReviewRun, IStorage } from '../storage/interface'

export interface TerminalRepairEscalationRecoverySummary {
  /** 走査した終端 repair run の件数（shared read の返り値）。 */
  scanned: number
  /** Task を `blocked` へ上げて人へ渡した件数。 */
  escalated: number
  /** ALIGNED / successor 既存 / 既に blocked / park / done で何もしなかった件数。 */
  skipped: number
  /** 候補 1 件の処理が例外で落ちた件数。次の poll cycle で再試行される。 */
  failed: number
  /** 直近の例外メッセージ（log 用。判定には使わない）。 */
  lastError?: string
}

export type TerminalRepairEscalationOutcome =
  | { status: 'escalated' }
  | { status: 'skipped'; reason: string }

/**
 * この run の判定が「人へ渡すべき結果」だったか。
 *
 * production の escalation 条件は `executeQueuedRepair()` の
 * `outcome.status !== 'evidence_registered'` であり、**ALIGNED 以外はすべて人へ渡す**
 * （`CONFLICT` / `UNCERTAIN` / `REVIEW_UNAVAILABLE` のどれも通過ではない ——
 * `actionGate` / `conflictResolutionStep` も同じ扱いをしている）。ここはその鏡像なので
 * 判定は `!== 'ALIGNED'` の 1 つで足り、決定名の列挙を増やさない。
 *
 * `undefined`（`resultJson` が無い / JSON として読めない）も ALIGNED ではないので人へ渡す。
 * **U2 とは向きが逆**である点に注意: U2 は「読めないなら repair Job を作らない」で
 * 自律実行を止めるのが fail-closed だが、こちらの action は自律実行を止めて人へ渡すこと
 * そのものなので、読めない結果を放置するほうが危険側になる。
 * なお production で `succeeded` かつ読めない `resultJson` は作れない
 * （unparsable な runner 出力は `finalizeFailure()` が `failed` / `requeued` にする）。
 */
function runNeedsHumanEscalation(run: DesignReviewRun): boolean {
  return safeRecomputedDecision(run) !== 'ALIGNED'
}

/**
 * escalation successor が**まだ着地していない**か。
 *
 * `escalateTaskToHuman()` の到達点は Task `blocked` なので、そこを見れば着地判定になる。
 * 既に着地しているもの・もう人へ渡す相手が居ないものを再度触らない:
 *   - `blocked`  … 既に人へ渡っている
 *   - `done`     … 完了した Task へ却下を持ち込まない
 *   - park 済み  … CEO が既に判断した結果。`escalateTaskToHuman()` 自身も park を除外する
 *   - successor 既存 … repair Job があるなら chain は進んでいて、止まっていない
 */
function escalationAlreadySettled(
  storage: IStorage,
  run: DesignReviewRun,
  taskId: string,
): string | undefined {
  const task = storage.tasks.findById(taskId)
  if (!task) return 'task not found'
  if (task.status === 'blocked') return 'task is already blocked'
  if (task.status === 'done') return 'task is done'
  if (storage.tasks.isParked(taskId)) return 'task was parked by abort_task'

  const sourceJobId = run.repairSourceJobId
  if (sourceJobId === undefined) return 'run has no durable repair successor intent'
  const stepKey = repairStepKeyFor(sourceJobId)
  if (storage.jobs.findByTaskId(taskId).some((job) => job.workflowStepKey === stepKey)) {
    return 'repair successor already exists for this chain'
  }

  return undefined
}

/**
 * 候補 1 件を回収する。**action は `escalateTaskToHuman()` の再利用 1 回だけ。**
 * 新しい status / Approval 種別 / Gate / audit 機構 / Human Recovery route は作らない。
 */
export function recoverTerminalRepairEscalation(
  storage: IStorage,
  run: DesignReviewRun,
): TerminalRepairEscalationOutcome {
  if (run.taskId === undefined) {
    // repair は Task 固有なので、ここへ roadmap kind は来ない。推測で Task を触らない。
    return { status: 'skipped', reason: 'run has no task' }
  }
  if (!runNeedsHumanEscalation(run)) {
    // ALIGNED は U2 の領分。**絶対に escalate しない。**
    return { status: 'skipped', reason: 'run aligned; repair successor recovery owns this run' }
  }

  const settled = escalationAlreadySettled(storage, run, run.taskId)
  if (settled !== undefined) return { status: 'skipped', reason: settled }

  escalateTaskToHuman(storage, run.taskId)
  return { status: 'escalated' }
}

/**
 * 却下で終端した repair run を走査し、escalation が着地していないものだけ人へ渡す。
 *
 * **新しい timer / daemon / queue / processed 列は作らない。** 実行契機は Worker の既存 poll
 * （`POST /api/task-continuations/reconcile`）だけで、冪等性は既存 durable state で閉じる:
 *
 *   - escalate に成功すると Task が `blocked` になり、次回以降は候補から外れる
 *   - 既に blocked なら何もしない
 *   - park 済みは skip し、park を維持する（park は durable なので毎 poll 安い skip を
 *     繰り返す。それを消すためだけの state は作らない —— CEO 判断・2026-09-28）
 *
 * 1 件の失敗で走査全体を止めない。候補どうしは独立している。
 */
export function recoverTerminalRepairEscalations(
  storage: IStorage,
): TerminalRepairEscalationRecoverySummary {
  const candidates = storage.designReviewRuns.findTerminalRepairPurposeRuns()
  const summary: TerminalRepairEscalationRecoverySummary = {
    scanned: candidates.length,
    escalated: 0,
    skipped: 0,
    failed: 0,
  }

  for (const run of candidates) {
    let outcome: TerminalRepairEscalationOutcome
    try {
      outcome = recoverTerminalRepairEscalation(storage, run)
    } catch (error: unknown) {
      summary.failed += 1
      summary.lastError = error instanceof Error ? error.message : String(error)
      continue
    }
    if (outcome.status === 'escalated') summary.escalated += 1
    else summary.skipped += 1
  }

  return summary
}
