import { describe, expect, it } from 'vitest'
import {
  applyIndependentReviewOverride,
  isStrategicDecision,
  resolveFinalDecision,
  STRATEGIC_DECISIONS,
} from './strategicDecision'
import type { FocusedReviewResult, IntegrationReviewResult } from './types/meta_review'

/**
 * Design Review の最終判定が、runner の未知出力に対して fail-closed であることを固定する。
 *
 * この出力は design review evidence になり、Job Gate が implement Job の実行可否を
 * 判断する根拠である。したがって「CONFLICT でも UNCERTAIN でもない値」を ALIGNED として
 * 拾ってはならない。2026-09-10 に `decision: 'NOT_ALIGNED'` が ALIGNED として受理され、
 * evidence 登録と implement Job 生成まで進んだ実測がこのテストの由来である。
 */

/** テストのために enum 外の値も渡せるようにする（実行時の runner 出力を再現するため）。 */
function focused(decision: string): FocusedReviewResult {
  return { focus: 'strategic_alignment', decision } as unknown as FocusedReviewResult
}

function integration(decision: string): IntegrationReviewResult {
  return { decision } as unknown as IntegrationReviewResult
}

describe('isStrategicDecision', () => {
  it('enumの3値だけを受理する', () => {
    for (const value of STRATEGIC_DECISIONS) {
      expect(isStrategicDecision(value)).toBe(true)
    }
  })

  it('未知値・非文字列は受理しない', () => {
    for (const value of ['NOT_ALIGNED', 'aligned', 'ALIGNED ', '', 'APPROVED', undefined, null, 0, {}]) {
      expect(isStrategicDecision(value)).toBe(false)
    }
  })
})

describe('resolveFinalDecision — 有効値での挙動（従来と同一であること）', () => {
  it('全件ALIGNEDならALIGNED', () => {
    expect(resolveFinalDecision([focused('ALIGNED'), focused('ALIGNED')])).toBe('ALIGNED')
  })

  it('integrationも含めて全件ALIGNEDならALIGNED', () => {
    expect(resolveFinalDecision([focused('ALIGNED')], integration('ALIGNED'))).toBe('ALIGNED')
  })

  it('1件でもCONFLICTならCONFLICT', () => {
    expect(resolveFinalDecision([focused('ALIGNED'), focused('CONFLICT')])).toBe('CONFLICT')
    expect(resolveFinalDecision([focused('ALIGNED')], integration('CONFLICT'))).toBe('CONFLICT')
  })

  it('CONFLICTはUNCERTAINより優先する', () => {
    expect(resolveFinalDecision([focused('UNCERTAIN'), focused('CONFLICT')])).toBe('CONFLICT')
  })

  it('1件でもUNCERTAINならUNCERTAIN', () => {
    expect(resolveFinalDecision([focused('ALIGNED'), focused('UNCERTAIN')])).toBe('UNCERTAIN')
  })

  it('判定が1件も無ければUNCERTAIN', () => {
    expect(resolveFinalDecision([])).toBe('UNCERTAIN')
  })
})

describe('resolveFinalDecision — 未知値は fail-closed', () => {
  it('未知のdecision値をALIGNEDへfall-throughしない', () => {
    // 2026-09-10 の実測ケースそのもの。
    expect(resolveFinalDecision([focused('NOT_ALIGNED')])).toBe('UNCERTAIN')
  })

  it('他が全てALIGNEDでも、未知値が1件あればALIGNEDにならない', () => {
    expect(resolveFinalDecision([focused('ALIGNED'), focused('NOT_ALIGNED')])).toBe('UNCERTAIN')
  })

  it('integration側の未知値でもALIGNEDにならない', () => {
    expect(resolveFinalDecision([focused('ALIGNED')], integration('NOT_ALIGNED'))).toBe('UNCERTAIN')
  })

  it('大文字小文字違い・前後空白付きもALIGNEDとして扱わない', () => {
    expect(resolveFinalDecision([focused('aligned')])).toBe('UNCERTAIN')
    expect(resolveFinalDecision([focused('ALIGNED ')])).toBe('UNCERTAIN')
  })

  it('truncateされた値をALIGNEDとして扱わない', () => {
    expect(resolveFinalDecision([focused('ALIGN')])).toBe('UNCERTAIN')
  })

  it('未知値はCONFLICT判定を弱めない', () => {
    expect(resolveFinalDecision([focused('NOT_ALIGNED'), focused('CONFLICT')])).toBe('CONFLICT')
  })
})

describe('applyIndependentReviewOverride は未知decisionを承認へ戻さない', () => {
  it('base が UNCERTAIN（未知値由来）なら approved でも ALIGNED へ上がらない', () => {
    const base = resolveFinalDecision([focused('NOT_ALIGNED')])
    expect(applyIndependentReviewOverride(base, { verdict: 'approved', unavailable: false } as never))
      .toBe('UNCERTAIN')
  })
})
