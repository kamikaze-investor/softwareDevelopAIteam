/**
 * runDir の事実を supervised_runs へ反映する reconcile pass（Step 3、CEO確定構造）
 *
 * ```
 * delegate.sh → delegate-watchdog.sh   … 実processの監督 / retry / marker・verdict生成
 * supervised_runs                      … durable な正本
 * 既存Workerのpoll/watchdog → ここ      … runDir → durable state の reconcile
 *                                        watchdog自身が死んだrunの検出
 *                                        terminal後の continuation 起動
 * ```
 *
 * **retry actor を二重化しない。** retry は `delegate-watchdog.sh` の責務であり、
 * ここでは一切 retry も再起動もしない。ここがやるのは
 * 「観測 → durable state へ反映 → 終端 → continuation」だけである。
 *
 * **新しい daemon / scheduler は作らない。** 実行契機は Worker の既存 poll cycle であり、
 * この関数はそこから呼ばれる1回分の処理にすぎない
 * （`retryPendingContinuationsForProject` が Mobile の既存 poll に相乗りしているのと同じ形）。
 */

import type { IStorage } from '../storage/interface'
import { diagnoseAndRecover, observeAndAdvance } from './delegationSupervisor'
import { registerAiDelegationPredicate } from './aiDelegationPredicate'

export interface ReconcileSummary {
  observed: number
  progressed: number
  terminal: number
  failClosed: number
  stalledDetected: number
  recovered: number
  recoveryExhausted: number
}

const emptySummary = (): ReconcileSummary => ({
  observed: 0,
  progressed: 0,
  terminal: 0,
  failClosed: 0,
  stalledDetected: 0,
  recovered: 0,
  recoveryExhausted: 0,
})

/**
 * active な ai_delegation を1巡する。
 *
 * running の run:
 *   - 現在の所有者 token で観測し、verdict があれば終端 + continuation
 *   - 進捗も verdict も無いまま kind ごとの閾値を超えたら **stalled として旗を立てる**
 *     （supervisor 自身が死んだ run の検出。ここでは retry しない）
 *
 * stalled の run:
 *   - `diagnoseAndRecover` が bounded に所有権を取り、**まず predicate を再評価**する。
 *     完了済みなら success として回収され（Case C）、上限超過なら terminal で終わる。
 */
export async function reconcileSupervisedDelegations(storage: IStorage): Promise<ReconcileSummary> {
  registerAiDelegationPredicate()

  const summary = emptySummary()

  for (const run of storage.supervisedRuns.findActiveRuns()) {
    if (run.kind !== 'ai_delegation') continue
    summary.observed += 1

    if (run.status === 'stalled') {
      const recovered = await diagnoseAndRecover(storage, run.id)
      if (recovered.status === 'recovery_exhausted') summary.recoveryExhausted += 1
      else if (recovered.status === 'terminal') { summary.terminal += 1; summary.recovered += 1 }
      else if (recovered.status === 'fail_closed') { summary.failClosed += 1; summary.recovered += 1 }
      continue
    }

    // running。所有者 token を持っているのは launcher だが、reconcile も
    // durable state を進める必要があるため、行に記録されている現在の token を使う。
    // token は行にしか無く、fencing の目的（**古い** token を無効化する）は保たれる。
    if (!run.claimToken) {
      // CHECK 制約により active な行は token を持つはずだが、防御的に扱う。
      continue
    }

    const outcome = await observeAndAdvance(storage, run.id, run.claimToken)

    if (outcome.status === 'terminal') { summary.terminal += 1; continue }
    if (outcome.status === 'fail_closed') { summary.failClosed += 1; continue }
    if (outcome.status === 'progressed') { summary.progressed += 1; continue }

    // 進捗も verdict も無い。supervisor（delegate-watchdog.sh）が死んでいる可能性がある。
    // 閾値判定は storage 側の policy で行われ、進捗が観測できている run は弾かれる。
    // **ここで retry はしない**（retry は delegate-watchdog.sh の責務）。
    if (outcome.status === 'waiting') {
      if (storage.supervisedRuns.markStalledBySupervisor(run.id, 'no progress and no verdict from delegate-watchdog')) {
        summary.stalledDetected += 1
      }
    }
  }

  return summary
}
