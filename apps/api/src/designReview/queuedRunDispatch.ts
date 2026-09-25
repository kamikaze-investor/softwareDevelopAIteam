/**
 * **queued な Design Review run を、正しい executor へ送る唯一の場所。**
 *
 * ## なぜ要るか（2026-09-22 横断監査 U4 / 2026-09-25 実測）
 *
 * repair 目的の run は `executeQueuedRepair()` が駆動する必要がある。review を回すだけでなく、
 * その後 `createRepairJobWithHandoff()` で repair Job を作るのがこの経路だからである。
 * ところが queued run を実行する経路は3つあり、**3つとも `executeDesignReviewRun()` へ直行**
 * していた。run が repair 目的かどうかは実行時に一度も参照されない。
 *
 * 結果、kick を逃した repair run は recovery で**汎用 executor に terminal 化され**、
 * `findQueued()` に二度と現れなくなる。repair Job を作る機会そのものが消える。
 *
 * Checkpoint 1 の runtime E2E で実際に再現した: queued な repair-purpose run を持つ DB で
 * API を起動すると、startup recovery がそれを拾って汎用 executor へ送る。
 *
 * ## 分岐は1つだけ
 *
 * U1 が `design_review_runs.repair_source_job_id` を durable にしたので、
 * **列の有無だけ**で目的が決まる。stepKey は `repairStepKeyFor()` で導出する。
 *
 * **分岐条件を「source Job を解決できたか」にしてはならない。** 列があるのに source Job が
 * 引けない run は repair 目的であることに変わりなく、汎用 executor へ流すと
 * 「repair のはずだったものが黙って普通の review として終端する」という U4 そのものが再発する。
 * その場合は `executeQueuedRepair()` の既存 fail-closed（escalate）へ落とす。
 *
 * ## なぜ別 module なのか
 *
 * - 汎用 executor（`executeDesignReviewRun`）側に分岐を置くと、`executeQueuedRepair()` が
 *   内部でそれを呼ぶため**自己再帰**する
 * - coordinator から `repairFlow` を import すると、既存の
 *   `repairFlow → designReviewCoordinator` という依存方向を逆転させ**循環**する
 *
 * この module は両方を import するだけで、誰からも import し返されないため循環しない。
 * `recoverAndRekickAtStartup()` をここへ移したのも同じ理由である（recovery driver は
 * review primitive ではないので、置き場所としても自然になる）。
 */
import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  buildDefaultCoordinatorDeps,
  executeDesignReviewRun,
  type CoordinatorDeps,
  type ExecuteDesignReviewResult,
} from './designReviewCoordinator'
import { executeQueuedRepair, type RepairFlowOutcome } from './repairFlow'
import { repairStepKeyFor } from './repairPolicy'
import type { DesignReviewRun, IStorage } from '../storage/interface'

/**
 * どちらの executor が走ったかを保ったまま返す。
 *
 * **戻り型の統一 refactor はしない。** `ExecuteDesignReviewResult` と `RepairFlowOutcome` は
 * 別の事実を表しており、片方へ潰すと情報が落ちる。必要な呼び出し側だけが
 * `toExecuteDesignReviewResult()` で写像する。
 */
export type QueuedRunOutcome =
  | { kind: 'review'; result: ExecuteDesignReviewResult }
  | { kind: 'repair'; outcome: RepairFlowOutcome }

/**
 * queued run を、その successor intent に従って正しい executor へ送る。
 *
 * repair 目的（`repairSourceJobId` が記録されている）なら repair continuation executor、
 * それ以外は従来どおり汎用 Design Review executor。
 */
export async function executeQueuedRun(
  storage: IStorage,
  run: DesignReviewRun,
  deps: CoordinatorDeps = buildDefaultCoordinatorDeps(),
): Promise<QueuedRunOutcome> {
  const sourceJobId = run.repairSourceJobId
  if (sourceJobId !== undefined) {
    return {
      kind: 'repair',
      outcome: await executeQueuedRepair(storage, run, repairStepKeyFor(sourceJobId), deps),
    }
  }
  return { kind: 'review', result: await executeDesignReviewRun(storage, run, deps) }
}

/**
 * `ExecuteDesignReviewResult` しか受け取れない既存 consumer のための最小写像。
 *
 * **戻り値を新しい権威にしない。** 呼び出し側（PL）は実行後に durable state を読み直して
 * 判定するので、ここは「何も起きなかったか」を落とさないことだけを目的にする。
 * PL は `status !== 'stale'` を成否に使うため、その1点だけ意味が合っていればよい。
 *
 *   repair_job_created → evidence_registered （前へ進んだ）
 *   already_started    → not_claimable       （別の実行が持っている / 既に存在する）
 *   escalated          → failed + reason     （fail-closed で人へ渡した。stale ではない）
 *   skipped            → stale + reason      （本当に何も起きていない）
 */
export function toExecuteDesignReviewResult(outcome: QueuedRunOutcome): ExecuteDesignReviewResult {
  if (outcome.kind === 'review') return outcome.result

  switch (outcome.outcome.status) {
    case 'repair_job_created':
      return { status: 'evidence_registered' }
    case 'already_started':
      return { status: 'not_claimable' }
    case 'escalated':
      return { status: 'failed', error: outcome.outcome.reason }
    case 'skipped':
      return { status: 'stale', error: outcome.outcome.reason }
  }
}

/**
 * API 起動時に、前プロセスが残した run を回収して再実行する。
 *
 * （`designReviewCoordinator` から移設。本体の違いは `executeQueuedRun()` を通すことだけで、
 * 回収条件・順序・attempt 予算の扱いは変えていない。）
 */
export async function recoverAndRekickAtStartup(
  storage: IStorage,
  deps: CoordinatorDeps = buildDefaultCoordinatorDeps(),
  processStartedAt: string = new Date().toISOString(),
): Promise<ExecuteDesignReviewResult[]> {
  // processStartedAt より後に開始したrunは現プロセスのものとして除外されるため、
  // 稼働中に誤って呼ばれても実行中attemptをrequeueしてしまうことはない。
  storage.designReviewRuns.recoverStaleRunningAtStartup(DESIGN_REVIEW_MAX_ATTEMPTS, processStartedAt)

  const results: ExecuteDesignReviewResult[] = []
  for (const queued of storage.designReviewRuns.findQueued()) {
    results.push(toExecuteDesignReviewResult(await executeQueuedRun(storage, queued, deps)))
  }
  return results
}
