import { beforeEach, describe, expect, it } from 'vitest'
import {
  describePredicateFailure,
  listRegisteredPredicates,
  registerPredicate,
  resetPredicateRegistryForTest,
  resolvePredicate,
} from './predicateRegistry.js'
import type { PredicateEvaluation } from './predicateRegistry.js'

const satisfied = async (): Promise<PredicateEvaluation> => ({ outcome: 'satisfied', evidence: {} })

describe('predicate registry (Contract D-2)', () => {
  beforeEach(() => {
    resetPredicateRegistryForTest()
  })

  it('key + version が一致したときだけ評価器を復元できる（再起動後の復元可能性）', () => {
    registerPredicate({
      key: 'ai_delegation.formal_verdict',
      version: 1,
      kind: 'ai_delegation',
      description: 'DONE / BLOCKED / ERROR のいずれかの formal verdict が得られたこと',
      evaluate: satisfied,
    })

    const resolved = resolvePredicate('ai_delegation.formal_verdict', 1)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.descriptor.kind).toBe('ai_delegation')
      expect(typeof resolved.descriptor.evaluate).toBe('function')
    }
  })

  describe('unknown predicate は fail-closed（成功にも RUNNING 継続にもしない）', () => {
    it('未登録の key', () => {
      const resolved = resolvePredicate('never.registered', 1)
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.reason).toBe('unknown_key')
    })

    it('version 不一致 — registry を更新した後に古い run を読み直した場合', () => {
      registerPredicate({
        key: 'expo_restart.ready',
        version: 2,
        kind: 'expo_restart',
        description: 'Metro READY',
        evaluate: satisfied,
      })

      const resolved = resolvePredicate('expo_restart.ready', 1)
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) {
        expect(resolved.reason).toBe('version_mismatch')
        if (resolved.reason === 'version_mismatch') {
          expect(resolved.requested).toBe(1)
          expect(resolved.available).toBe(2)
        }
      }
    })

    it('descriptor はあるが評価器が未登録（Step 2 時点の状態）', () => {
      registerPredicate({
        key: 'expo_restart.ready',
        version: 1,
        kind: 'expo_restart',
        description: 'Step 4 で評価器を実装する',
      })

      const resolved = resolvePredicate('expo_restart.ready', 1)
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.reason).toBe('no_evaluator')
    })
  })

  it('同じ key の二重登録は throw する（同一 key+version が実行時によって別の意味を持つのを防ぐ）', () => {
    registerPredicate({
      key: 'ai_delegation.formal_verdict',
      version: 1,
      kind: 'ai_delegation',
      description: 'v1',
      evaluate: satisfied,
    })

    expect(() =>
      registerPredicate({
        key: 'ai_delegation.formal_verdict',
        version: 2,
        kind: 'ai_delegation',
        description: 'v2 — 上書きは許さない',
        evaluate: satisfied,
      }),
    ).toThrow(/already registered/)
  })

  it('失敗理由は run.error へ残せる一行の文字列になる', () => {
    expect(describePredicateFailure({ ok: false, reason: 'unknown_key', key: 'x' }))
      .toMatch(/unknown completion predicate "x"/)
    expect(describePredicateFailure({ ok: false, reason: 'version_mismatch', key: 'x', requested: 1, available: 3 }))
      .toMatch(/v1.*v3/)
    expect(describePredicateFailure({ ok: false, reason: 'no_evaluator', key: 'x', version: 1 }))
      .toMatch(/no evaluator/)
  })

  it('監査用の一覧は評価器の有無を区別して返す', () => {
    registerPredicate({ key: 'a', version: 1, kind: 'ai_delegation', description: 'with', evaluate: satisfied })
    registerPredicate({ key: 'b', version: 1, kind: 'expo_restart', description: 'without' })

    expect(listRegisteredPredicates()).toEqual([
      { key: 'a', version: 1, kind: 'ai_delegation', hasEvaluator: true },
      { key: 'b', version: 1, kind: 'expo_restart', hasEvaluator: false },
    ])
  })
})
