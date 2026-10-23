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
  type WeightedPoint,
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
    const metric = (ps: readonly WeightedPoint[]) => weightedRates(ps).recall
    const ci = stratifiedBootstrap(points, metric, 500, 3)
    expect(ci).toEqual(stratifiedBootstrap(points, metric, 500, 3))
    const point = metric(points) as number
    expect(ci?.[0]).toBeLessThanOrEqual(point)
    expect(ci?.[1]).toBeGreaterThanOrEqual(point)
  })
})

describe('runState / repeatability（v3.1）', () => {
  const target = { files: ['apps/api/src/pl/conflictResolutionStep.ts'], mechanismKeywords: ['challenge'] }

  it('target を持つ item: file と keyword が一致すれば target_detected', () => {
    expect(runState(observation([{ file: target.files[0], mechanism: 'Challenge stage' }]), target)).toBe('target_detected')
    expect(runState(observation([{ file: 'other.ts', mechanism: 'Challenge stage' }]), target)).toBe('not_detected')
    expect(runState(observation([], 'unavailable'), target)).toBe('unavailable')
  })

  it('target を持たない item: 候補の有無', () => {
    expect(runState(observation([]), undefined)).toBe('no_candidates')
    expect(runState(observation([{ file: 'x', mechanism: 'y' }]), undefined)).toBe('candidates_present')
  })

  const records = (itemId: string, obs: MaterialityObservation[]): DetectionRecord[] =>
    obs.map((observation, run) => ({ itemId, kind: 'mutant', run, model: 'm', inputFingerprint: 'fp', latencyMs: 0, promptChars: 0, observation }))

  it('3回とも同じく見逃した positive は flip ではない（hit rate 0 として別に出る）', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], records('p', [observation([]), observation([]), observation([])]), 3)
    expect(result.items[0]).toMatchObject({ flipped: false, targetHitRate: 0 })
  })

  it('3回とも候補なしの negative は flip ではない', () => {
    const result = scoreRepeatability([{ itemId: 'n' }], records('n', [observation([]), observation([]), observation([])]), 3)
    expect(result.items[0]).toMatchObject({ flipped: false, targetHitRate: null })
  })

  it('検出・見逃し・unavailable が混ざれば flip', () => {
    const hit = observation([{ file: target.files[0], mechanism: 'challenge' }])
    const result = scoreRepeatability([{ itemId: 'p', target }], records('p', [hit, observation([]), observation([], 'unavailable')]), 3)
    expect(result.items[0]).toMatchObject({ flipped: true, states: ['target_detected', 'not_detected', 'unavailable'] })
    expect(result.flipRate).toBe(1)
  })
})

describe('独立レビュー指摘（code review round 1）の回帰', () => {
  const target = { files: ['apps/api/src/pl/conflictResolutionStep.ts'], mechanismKeywords: ['challenge'] }
  const record = (run: number, observation: MaterialityObservation, inputFingerprint = 'fp'): DetectionRecord =>
    ({ itemId: 'p', kind: 'positive', run, model: 'm', inputFingerprint, latencyMs: 0, promptChars: 0, observation })
  const hit = (evaluations: MaterialityObservation['evaluations'], status: 'ok' | 'unavailable' = 'ok'): MaterialityObservation => ({
    ...observation([{ file: target.files[0], mechanism: 'Challenge stage' }]),
    status,
    evaluations,
  })

  it('A1: 別入力（fingerprint 違い）の run が混ざった item は invalid として flip 率から外す', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [record(0, hit([]), 'a'), record(1, hit([]), 'b'), record(2, hit([]), 'b')], 3)
    expect(result.items[0].invalid).toBe('mixed_inputs')
    expect(result).toMatchObject({ invalidItems: 1, flipRate: null })
  })

  it('A1: run 数が期待と違えば invalid', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [record(0, hit([])), record(1, hit([]))], 3)
    expect(result.items[0].invalid).toBe('run_count')
  })

  it('A2: correctness が3回とも欠けても「安定」とは数えない（評価の欠落は別に数える）', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [0, 1, 2].map((run) => record(run, hit(undefined, 'unavailable'))), 3)
    expect(result.items[0]).toMatchObject({ responsibilities: [], evaluationMissing: 3, responsibilityStable: 'insufficient' })
  })

  it('A3: target の file は完全一致（無関係な file の候補は target 検出にならない）', () => {
    expect(runState(observation([{ file: 'apps/api/src/unrelated.ts', mechanism: 'challenge' }]), target)).toBe('not_detected')
  })
})
