import { describe, expect, it } from 'vitest'
import type { MaterialityObservation } from '../src/metaReviewer/designMateriality.js'
import {
  buildFrame,
  runState,
  sampleWithoutReplacement,
  scoreRepeatability,
  stratifiedBootstrap,
  weightedRates,
  type DetectionRecord,
} from './designMaterialityEval.js'

function observation(candidates: Array<{ file: string; mechanism: string }>, status: 'ok' | 'unavailable' = 'ok'): MaterialityObservation {
  return {
    schemaVersion: 1,
    status,
    signals: [],
    excerpts: [],
    ...(status === 'ok'
      ? {
          detection: {
            material: candidates.length > 0,
            candidates: candidates.map((c, i) => ({ id: `c${i + 1}`, kind: 'removes' as const, subject: 'mechanism' as const, evidence: '', ...c })),
            signalDisposition: [],
          },
          evaluations: [],
        }
      : {}),
  }
}

describe('sampling / frame', () => {
  it('同じ seed なら同じ抽出、違う seed なら違う抽出', () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    expect(sampleWithoutReplacement(items, 10, 1)).toEqual(sampleWithoutReplacement(items, 10, 1))
    expect(sampleWithoutReplacement(items, 10, 1)).not.toEqual(sampleWithoutReplacement(items, 10, 2))
    expect(new Set(sampleWithoutReplacement(items, 10, 1)).size).toBe(10)
  })

  it('F は全数（重み1）、N は抽出して重み |N|/n', () => {
    const commits = [
      ...Array.from({ length: 3 }, (_, i) => ({ sha: `f${i}`, subject: '', signalKinds: ['contract_member_removed' as const] })),
      ...Array.from({ length: 12 }, (_, i) => ({ sha: `n${i}`, subject: '', signalKinds: [] })),
    ]
    const frame = buildFrame(commits, { head: 'h', sample: 4, seed: 7 })
    expect(frame).toMatchObject({ fired: 3, none: 12, sampledNone: 4 })
    expect(frame.items.filter((i) => i.stratum === 'F').every((i) => i.weight === 1)).toBe(true)
    expect(frame.items.filter((i) => i.stratum === 'N').map((i) => i.weight)).toEqual([3, 3, 3, 3])
  })
})

describe('weightedRates', () => {
  it('Challenger の例: F 全数 20 中 10 material、N 280 から 60 抽出して 6 material → 重み付き recall ≈ 26%', () => {
    const points = [
      ...Array.from({ length: 10 }, () => ({ weight: 1, stratum: 'F' as const, predicted: true, actual: true })),
      ...Array.from({ length: 10 }, () => ({ weight: 1, stratum: 'F' as const, predicted: true, actual: false })),
      ...Array.from({ length: 6 }, () => ({ weight: 280 / 60, stratum: 'N' as const, predicted: false, actual: true })),
      ...Array.from({ length: 54 }, () => ({ weight: 280 / 60, stratum: 'N' as const, predicted: false, actual: false })),
    ]
    const rates = weightedRates(points)
    expect(rates.recall).toBeCloseTo(10 / (10 + 28), 5)
    expect(rates.precision).toBeCloseTo(0.5, 5)
  })

  it('分母が 0 なら null', () => {
    expect(weightedRates([])).toEqual({ recall: null, precision: null, routineFlagRate: null })
  })

  it('層別 bootstrap は決定的で、点推定を含む区間を返す', () => {
    const points = [
      ...Array.from({ length: 8 }, (_, i) => ({ weight: 1, stratum: 'F' as const, predicted: true, actual: i < 6 })),
      ...Array.from({ length: 20 }, (_, i) => ({ weight: 5, stratum: 'N' as const, predicted: false, actual: i < 2 })),
    ]
    const metric = (ps: typeof points) => weightedRates(ps).recall
    const ci = stratifiedBootstrap(points, metric, 500, 3)
    expect(ci).toEqual(stratifiedBootstrap(points, metric, 500, 3))
    const point = metric(points) as number
    expect(ci?.[0]).toBeLessThanOrEqual(point)
    expect(ci?.[1]).toBeGreaterThanOrEqual(point)
  })
})

describe('runState / repeatability（v3.1）', () => {
  const target = { file: 'apps/api/src/pl/conflictResolutionStep.ts', mechanismKeywords: ['challenge'] }

  it('target を持つ item: file と keyword が一致すれば target_detected', () => {
    expect(runState(observation([{ file: target.file, mechanism: 'Challenge stage' }]), target)).toBe('target_detected')
    expect(runState(observation([{ file: 'other.ts', mechanism: 'Challenge stage' }]), target)).toBe('not_detected')
    expect(runState(observation([], 'unavailable'), target)).toBe('unavailable')
  })

  it('target を持たない item: 候補の有無', () => {
    expect(runState(observation([]), undefined)).toBe('no_candidates')
    expect(runState(observation([{ file: 'x', mechanism: 'y' }]), undefined)).toBe('candidates_present')
  })

  const records = (itemId: string, obs: MaterialityObservation[]): DetectionRecord[] =>
    obs.map((observation, run) => ({ itemId, kind: 'mutant', run, model: 'm', observation }))

  it('3回とも同じく見逃した positive は flip ではない（hit rate 0 として別に出る）', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], records('p', [observation([]), observation([]), observation([])]))
    expect(result.items[0]).toMatchObject({ flipped: false, targetHitRate: 0 })
  })

  it('3回とも候補なしの negative は flip ではない', () => {
    const result = scoreRepeatability([{ itemId: 'n' }], records('n', [observation([]), observation([]), observation([])]))
    expect(result.items[0]).toMatchObject({ flipped: false, targetHitRate: null })
  })

  it('検出・見逃し・unavailable が混ざれば flip', () => {
    const hit = observation([{ file: target.file, mechanism: 'challenge' }])
    const result = scoreRepeatability([{ itemId: 'p', target }], records('p', [hit, observation([]), observation([], 'unavailable')]))
    expect(result.items[0]).toMatchObject({ flipped: true, states: ['target_detected', 'not_detected', 'unavailable'] })
    expect(result.flipRate).toBe(1)
  })
})
