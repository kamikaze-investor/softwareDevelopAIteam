import { describe, it, expect } from 'vitest'
import { checkLatestChallengeCoversCurrentFacts } from './metaCriticalFactsCheck'

describe('checkLatestChallengeCoversCurrentFacts', () => {
  it('facts未指定 → ok:false CRITICAL_FACTS_STALE', () => {
    const result = checkLatestChallengeCoversCurrentFacts({
      currentCriticalFactsHash: undefined,
      latestEvidenceCriticalFactsHash: 'abc123',
    })
    expect(result).toEqual({
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'current critical facts hash is required',
    })
  })

  it('一致 → ok:true（不要なBLOCKERを出さない）', () => {
    const result = checkLatestChallengeCoversCurrentFacts({
      currentCriticalFactsHash: 'abc123',
      latestEvidenceCriticalFactsHash: 'abc123',
    })
    expect(result).toEqual({ ok: true })
  })

  it('不一致 → ok:false CRITICAL_FACTS_STALE', () => {
    const result = checkLatestChallengeCoversCurrentFacts({
      currentCriticalFactsHash: 'abc123',
      latestEvidenceCriticalFactsHash: 'def456',
    })
    expect(result).toEqual({
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'Critical design facts have changed since last challenge pass',
    })
  })

  it('evidence側undefined + current有り → ok:false CRITICAL_FACTS_STALE', () => {
    const result = checkLatestChallengeCoversCurrentFacts({
      currentCriticalFactsHash: 'abc123',
      latestEvidenceCriticalFactsHash: undefined,
    })
    expect(result).toEqual({
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'No design challenge evidence found for current critical facts',
    })
  })
})