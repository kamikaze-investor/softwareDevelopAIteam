/**
 * **ALIGNED 終端した repair-purpose run の successor を、Design Review を回さずに回収する。**
 *
 * ## なぜ要るか（2026-09-22 横断監査 U2）
 *
 * repair の経路は `executeQueuedRepair()` の中で
 *
 *   review 実行 → ALIGNED evidence を durable 化 → repair Job を handoff
 *
 * と続く。1 番目と 2 番目は `completeWithEvidence()` が単一 transaction で確定するが、
 * **2 番目と 3 番目の間には transaction が無い。** ここで process が落ちると:
 *
 *   - run は `succeeded`（terminal）
 *   - evidence は正しく残る
 *   - repair Job は 0 件
 *   - `findQueued()` は `queued` しか返さないので、この run は二度と拾われない
 *
 * つまり **evidence も run も正しく残るのに、successor を作る機会だけが消える。**
 * U4 は queued run を正しい executor へ送るが、terminal run には届かない
 * （`claim()` が `status='queued'` 以外を拒むため、U4 の経路は構造的に入れない）。
 *
 * ## Design Review を再実行しない
 *
 * review は既に走り、ALIGNED evidence が durable に残っている。**それが authority である。**
 * 回収時に review を回し直すと、
 *
 *   - provider を無駄に呼ぶ
 *   - 同じ設計テキストに対して前回と違う判定が出うる（判定は決定的ではない）
 *
 * この module が `CoordinatorDeps` を受け取らないのは、その禁止を型で示すためである。
 * runner を起動する手段がそもそも無い。
 *
 * ## admission / 予算を再判定しない
 *
 * `decideRepairAction()` の admission と repair 予算は **元 run の生成時**に決着しており、
 * `repair_source_job_id` と stepKey（`repair:<sourceJobId>:1`）へ durable 化されている。
 * 回収時に再評価すると、実際に走って evidence を残した review とは別の結論になりうる。
 * 予算は stepKey lineage の depth で数えるので、遅れて作っても同じ深さに着地する。
 */
import {
  completeRepairHandoff,
  resolveRepairHandoffTarget,
  safeRecomputedDecision,
  type RepairFlowOutcome,
} from './repairFlow'
import { repairStepKeyFor } from './repairPolicy'
import type { DesignReviewRun, IStorage } from '../storage/interface'

export interface TerminalRepairSuccessorRecoverySummary {
  /** 走査した候補 run の件数（`findAlignedRepairPurposeTerminal()` の返り値）。 */
  scanned: number
  /** repair Job を新しく作れた件数。 */
  recovered: number
  /** 既に successor がある / evidence が一致しない / park 済み等で何もしなかった件数。 */
  skipped: number
  /** fail-closed で Human escalation へ渡した件数。 */
  escalated: number
  /** 候補 1 件の処理が例外で落ちた件数。次の poll cycle で再試行される。 */
  failed: number
  /** 直近の例外メッセージ（log 用。判定には使わない）。 */
  lastError?: string
}

/**
 * **この run 自身の判定が ALIGNED だったか。**
 *
 * **`error IS NULL` を ALIGNED の証拠にしてはならない。** storage query の
 * `error IS NULL` は安い prefilter であって同値条件ではない ——
 * `recomputeDecision()` が `rejectedReason` を埋めるのは **`reviewKind === 'roadmap'` の
 * ときだけ**で（`designReviewCoordinator.ts`）、repair が使う `task` kind では
 * 非 ALIGNED でも `rejectedReason` が undefined になる。`complete()` は
 * `error ?? null` で保存するので、**非 ALIGNED な task run も `error IS NULL` で終端する**
 * （2026-09-25 独立レビュー指摘。初出時の「同値である」という記述は誤りだった）。
 *
 * そこで判定は run 自身の `resultJson` から計算し直す。既存 `safeRecomputedDecision()` は
 * `blockedTriage` が同じ目的で使っているものをそのまま使い、読めない / 壊れている場合は
 * undefined または UNCERTAIN を返すので、**どちらも ALIGNED ではない = 回収しない**（fail-closed）。
 */
function runItselfAligned(run: DesignReviewRun): boolean {
  return safeRecomputedDecision(run) === 'ALIGNED'
}

/**
 * この terminal run の ALIGNED evidence が、**この run のテキストに対するもの**か。
 *
 * 上の判定が「この run は ALIGNED だった」を保証し、こちらは
 * 「その判定が durable な evidence として残っている」ことを確かめる。**2 つは別の事実である。**
 *
 * `design_review_evidence` は run id を持たない（`packages/shared/src/types/meta_review.ts`）ので、
 * 束縛できるのは Task と `designTextHash` までである。repair Job の prompt は
 * `run.designText` そのものなので、その hash に対する ALIGNED evidence が無ければ
 * 「これから作る Job の内容が審査を通っている」と言えない。**言えないなら回収しない。**
 */
function hasMatchingAlignedEvidence(storage: IStorage, run: DesignReviewRun): boolean {
  if (run.taskId === undefined) return false
  return storage.designReviewEvidence
    .findByTaskId(run.taskId)
    .some((evidence) =>
      evidence.decision === 'ALIGNED' && evidence.designTextHash === run.designTextHash)
}

/**
 * 候補 1 件を回収する。**戻り値は既存 `RepairFlowOutcome` のまま**で、新しい種別を作らない。
 *
 * guard は `resolveRepairHandoffTarget()` / `completeRepairHandoff()` の既存実装をそのまま
 * 通す（quarantine / source Job 実在 / 同一 Task / 規約形 stepKey / stepKey dedup /
 * park / 所有権ハンドオフ / escalation）。**U2 用に第二実装を作らない。**
 */
export function recoverTerminalRepairSuccessor(
  storage: IStorage,
  run: DesignReviewRun,
): RepairFlowOutcome {
  const sourceJobId = run.repairSourceJobId
  if (sourceJobId === undefined) {
    // storage query が `repair_source_job_id IS NOT NULL` で絞っているので通常は来ない。
    // 推測で repair 目的として扱わない（U1 以前の行を巻き込まない）。
    return { status: 'skipped', reason: 'run has no durable repair successor intent' }
  }

  // **この run 自身が ALIGNED だったことを確かめる。** query の `error IS NULL` では
  // 足りない（task kind の非 ALIGNED も NULL で終端する）。U3 が扱う非 ALIGNED 終端を
  // ここで拾ってはならない。
  if (!runItselfAligned(run)) {
    return { status: 'skipped', reason: 'run did not terminate as ALIGNED' }
  }

  if (!hasMatchingAlignedEvidence(storage, run)) {
    return { status: 'skipped', reason: 'no ALIGNED evidence matches this run design text' }
  }

  const stepKey = repairStepKeyFor(sourceJobId)
  const target = resolveRepairHandoffTarget(storage, run, stepKey)
  if (!target.ok) return target.outcome

  return completeRepairHandoff(storage, run, stepKey, target.taskId, target.sourceJob)
}

/**
 * ALIGNED 終端した repair-purpose run を走査し、successor の無いものだけ回収する。
 *
 * **新しい timer / daemon / queue / processed 列は作らない。** 実行契機は Worker の既存 poll
 * （`POST /api/task-continuations/reconcile`）だけであり、冪等性は既存機構だけで閉じている:
 *
 *   - 同じ run を何度走査しても、`completeRepairHandoff()` の stepKey dedup で 1 件
 *   - repair Job を作った直後に落ちても、次回は dedup が効いて no-op
 *   - 並走しても `ux_jobs_workflow_step_key`（全体一意）が最後の砦で、衝突は
 *     `already_started` へ収束する（false escalation にしない）
 *
 * 1 件の失敗で走査全体を止めない。fail-closed の escalation は既存経路が済ませており、
 * 残りの候補は独立している。
 */
export function recoverTerminalRepairSuccessors(
  storage: IStorage,
): TerminalRepairSuccessorRecoverySummary {
  const candidates = storage.designReviewRuns.findAlignedRepairPurposeTerminal()
  const summary: TerminalRepairSuccessorRecoverySummary = {
    scanned: candidates.length,
    recovered: 0,
    skipped: 0,
    escalated: 0,
    failed: 0,
  }

  for (const run of candidates) {
    // **1 件の例外で後続の候補を飢えさせない。** 候補どうしは独立しており、
    // storage の一過性の失敗が先頭に当たるたびに残りが回収されないのでは、
    // この sweep 自体が新しい Lost Completion になる（独立レビュー指摘・2026-09-25）。
    // 失敗は次の poll cycle で再試行される（durable state だけを見るので状態は残らない）。
    let outcome: RepairFlowOutcome
    try {
      outcome = recoverTerminalRepairSuccessor(storage, run)
    } catch (error: unknown) {
      summary.failed += 1
      summary.lastError = error instanceof Error ? error.message : String(error)
      continue
    }
    if (outcome.status === 'repair_job_created') summary.recovered += 1
    else if (outcome.status === 'escalated') summary.escalated += 1
    else summary.skipped += 1
  }

  return summary
}
