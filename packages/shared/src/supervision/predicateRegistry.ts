/**
 * Completion Predicate Registry — Contract D-2
 *
 * **completion predicateをDBで実行しない。** DBが持つのは `predicate_key` /
 * `predicate_version` / evidence だけであり、判定ロジックはここ（code側）にある。
 * 自由文字列やDB内DSLを解釈・実行する経路は作らない。
 *
 * 満たすべき性質:
 *   1. **再起動後にも同じpredicateを復元できる** — key + version からregistryを引き直せば、
 *      process再起動をまたいでも同じ判定が再現される。
 *   2. **unknown predicateはfail-closedにする** — registryに無いkey、解決できないversion、
 *      評価器が未登録のいずれも、SUCCEEDEDにもRUNNING継続にもせず terminal（要escalation）
 *      へ倒す。「判定できないので成功とみなす」も「判定できないので待ち続ける」も禁止。
 *      後者はC-1（無期限RUNNING禁止）違反そのものである。
 *
 * `predicate_version` を持つのは、registry側のロジックを更新したときに
 * 「どのversionの判定で終端したか」が過去のrunから読めなくなるのを防ぐためである。
 * 判定内容を変えたら**必ずversionを上げる**（同じversionの意味を書き換えない）。
 */

import type { SupervisedRunKind } from '../types/supervised_run.js'

/**
 * predicate評価の結果。
 *
 * `satisfied: false` は「まだ満たしていない」であって「失敗」ではない。
 * 評価そのものが行えなかった場合は評価器がthrowするのではなく `unevaluatable` を返し、
 * 呼び出し側がfail-closedに倒す判断を行う。
 */
export type PredicateEvaluation =
  | { outcome: 'satisfied'; evidence: Record<string, unknown> }
  | { outcome: 'not_satisfied'; evidence: Record<string, unknown> }
  | { outcome: 'unevaluatable'; reason: string }

/** predicate評価器。Step 3 / Step 4 が kind ごとに登録する。 */
export type PredicateEvaluator = (context: PredicateContext) => Promise<PredicateEvaluation>

/** 評価器へ渡す実行時情報。run row から復元できるものだけを渡す。 */
export interface PredicateContext {
  readonly runId: string
  readonly kind: SupervisedRunKind
  readonly subjectId: string
  /** 直近に記録したprogress evidence（あれば）。 */
  readonly progressEvidence?: Record<string, unknown>
}

export interface PredicateDescriptor {
  readonly key: string
  readonly version: number
  readonly kind: SupervisedRunKind
  /** 何をもって成功とするかの人間可読な定義。監査・レビュー用であり、実行はされない。 */
  readonly description: string
  /**
   * 実際の判定。未登録（Step 2時点）なら undefined。
   * undefined のまま解決を試みると fail-closed になる（`no_evaluator`）。
   */
  readonly evaluate?: PredicateEvaluator
}

/** 解決失敗の理由。すべてfail-closed扱いであり、呼び出し側で成功にも継続にもしてはならない。 */
export type PredicateResolutionFailure =
  | { ok: false; reason: 'unknown_key'; key: string }
  | { ok: false; reason: 'version_mismatch'; key: string; requested: number; available: number }
  | { ok: false; reason: 'no_evaluator'; key: string; version: number }

export type PredicateResolution =
  | { ok: true; descriptor: PredicateDescriptor & { evaluate: PredicateEvaluator } }
  | PredicateResolutionFailure

const registry = new Map<string, PredicateDescriptor>()

/**
 * predicateを登録する。同じkeyの二重登録は**上書きせずthrowする**。
 * 上書きを許すと、同じ key + version が実行時によって違う意味を持ち得てしまい、
 * 「再起動後に同じ判定を復元できる」という性質(1)が壊れる。
 */
export function registerPredicate(descriptor: PredicateDescriptor): void {
  const existing = registry.get(descriptor.key)
  if (existing) {
    throw new Error(
      `predicate "${descriptor.key}" is already registered (v${existing.version}); ` +
      'change the version and register a new key instead of overwriting an existing one',
    )
  }
  registry.set(descriptor.key, descriptor)
}

/**
 * key + version からpredicateを復元する。
 *
 * **成功以外はすべてfail-closed**である。呼び出し側は `ok: false` を受け取ったら
 * runをterminal（failed / 要escalation）へ倒すこと。RUNNINGのまま待ち続けてはならない。
 */
export function resolvePredicate(key: string, version: number): PredicateResolution {
  const descriptor = registry.get(key)
  if (!descriptor) {
    return { ok: false, reason: 'unknown_key', key }
  }
  if (descriptor.version !== version) {
    return { ok: false, reason: 'version_mismatch', key, requested: version, available: descriptor.version }
  }
  if (!descriptor.evaluate) {
    return { ok: false, reason: 'no_evaluator', key, version }
  }
  return { ok: true, descriptor: { ...descriptor, evaluate: descriptor.evaluate } }
}

/** fail-closedの理由を、run.error へ残す一行の文字列にする。 */
export function describePredicateFailure(failure: PredicateResolutionFailure): string {
  switch (failure.reason) {
    case 'unknown_key':
      return `unknown completion predicate "${failure.key}" (fail-closed: the run cannot be judged)`
    case 'version_mismatch':
      return (
        `completion predicate "${failure.key}" version mismatch ` +
        `(run recorded v${failure.requested}, registry has v${failure.available})`
      )
    case 'no_evaluator':
      return `completion predicate "${failure.key}" v${failure.version} has no evaluator registered`
  }
}

/** テスト専用。registryを空へ戻す。 */
export function resetPredicateRegistryForTest(): void {
  registry.clear()
}

/** 監査用。登録済みpredicateの一覧（評価器の有無を含む）。 */
export function listRegisteredPredicates(): Array<{ key: string; version: number; kind: SupervisedRunKind; hasEvaluator: boolean }> {
  return [...registry.values()].map((d) => ({
    key: d.key,
    version: d.version,
    kind: d.kind,
    hasEvaluator: d.evaluate !== undefined,
  }))
}
