/**
 * Predicate resolution → run terminalization の結合（Contract D-2）
 *
 * 独立レビュー指摘(2026-09-08): registry が `ok: false` を返すことと、run が terminal になることが
 * 別々のAPIだと、**呼び出し側が解決失敗を観測したまま待ち続けられてしまう**。
 * それは C-1（無期限RUNNING禁止）違反そのものであり、この基盤が防ぐべき当の失敗である。
 *
 * したがって「predicateを解決する」唯一の入口をここに置き、
 * **解決できなかった場合はその場で run を fail-closed 終端させる**。
 * 呼び出し側が「解決できなかったが待ち続ける」を選ぶ余地を残さない。
 */

import { describePredicateFailure, resolvePredicate } from '@ai-team/shared'
import type { PredicateEvaluator, PredicateResolutionFailure } from '@ai-team/shared'
import type { IStorage, SupervisedRun } from '../storage/interface'

export type ResolveForRunResult =
  | { ok: true; evaluate: PredicateEvaluator }
  | {
      ok: false
      failure: PredicateResolutionFailure
      /** run を terminal へ確定できたか。false は既に終端済み、または fencing で弾かれたことを意味する。 */
      terminated: boolean
      error: string
    }

/**
 * run の predicate を復元する。復元できなければ run を fail-closed で終端させてから返す。
 *
 * `claimToken` は run の現在の所有者のもの。fail-closed も終端書き込みなので fencing される
 * （stale な所有者がこの経路から終端を書けてはならない）。
 */
export function resolvePredicateForRun(
  storage: IStorage,
  run: SupervisedRun,
  claimToken: string,
): ResolveForRunResult {
  const resolution = resolvePredicate(run.predicateKey, run.predicateVersion)

  if (resolution.ok) {
    return { ok: true, evaluate: resolution.descriptor.evaluate }
  }

  // 「判定できないので成功とみなす」も「判定できないので待ち続ける」も禁止（D-2）。
  const error = describePredicateFailure(resolution)
  const terminated = storage.supervisedRuns.failClosed(run.id, claimToken, error)

  return { ok: false, failure: resolution, terminated, error }
}
