// Meta Reviewer Critical Design Facts Final Check
//
// この関数は Critical Design Facts の整合性確認のみを行う。
// DB設計の良し悪し・アーキテクチャの妥当性・命名規約等の
// Design Quality Review は一切行わない。
// 「現在の facts と最新 Challenge PASS 時の facts が一致するか」だけを判定する。

export type MetaCriticalFactsResult =
  | { ok: true }
  | { ok: false; code: 'CRITICAL_FACTS_STALE'; reason: string }

export function checkLatestChallengeCoversCurrentFacts(input: {
  currentCriticalFactsHash?: string
  latestEvidenceCriticalFactsHash?: string
}): MetaCriticalFactsResult {
  const { currentCriticalFactsHash, latestEvidenceCriticalFactsHash } = input

  // currentCriticalFactsHash が未指定の場合は検査を素通りさせない
  if (currentCriticalFactsHash === undefined) {
    return {
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'current critical facts hash is required',
    }
  }

  // 最新 Challenge が存在しない場合
  if (latestEvidenceCriticalFactsHash === undefined) {
    return {
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'No design challenge evidence found for current critical facts',
    }
  }

  // hash が異なる場合
  if (currentCriticalFactsHash !== latestEvidenceCriticalFactsHash) {
    return {
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'Critical design facts have changed since last challenge pass',
    }
  }

  // 一致する場合
  return { ok: true }
}