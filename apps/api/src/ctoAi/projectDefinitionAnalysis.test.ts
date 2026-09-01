import { describe, expect, it } from 'vitest'
import { analyzeProjectDefinition, buildSpecTextFromProjectDefinition } from './projectDefinitionAnalysis'

describe('buildSpecTextFromProjectDefinition', () => {
  it('includes the goal', () => {
    const text = buildSpecTextFromProjectDefinition({ goal: 'Ship the thing', designPhilosophy: [] })
    expect(text).toContain('Ship the thing')
  })

  it('includes design philosophy items when present', () => {
    const text = buildSpecTextFromProjectDefinition({ goal: 'G', designPhilosophy: ['小さく変更', '全自動優先'] })
    expect(text).toContain('小さく変更')
    expect(text).toContain('全自動優先')
  })

  it('omits the Design Philosophy section entirely when empty (no empty heading noise)', () => {
    const text = buildSpecTextFromProjectDefinition({ goal: 'G', designPhilosophy: [] })
    expect(text).not.toContain('Design Philosophy')
  })

  it('includes non-empty Gap answers, keyed by the original question', () => {
    const text = buildSpecTextFromProjectDefinition({
      goal: 'G', designPhilosophy: [],
      gapAnswers: { '対象ユーザーは?': '経理担当者', '空欄は無視されるべき': '' },
    })
    expect(text).toContain('対象ユーザーは?')
    expect(text).toContain('経理担当者')
    expect(text).not.toContain('空欄は無視されるべき')
  })

  it('omits the answers section entirely when no answers are given', () => {
    const text = buildSpecTextFromProjectDefinition({ goal: 'G', designPhilosophy: [] })
    expect(text).not.toContain('CEOからの追加回答')
  })
})

describe('analyzeProjectDefinition', () => {
  function mockResponse(gaps: Array<{ severity: 'must_resolve' | 'should_resolve' | 'optional' }>): string {
    return JSON.stringify({
      goal: 'G', designPhilosophy: [],
      mvpScope: { description: 'G', includedFeatures: [], excludedFeatures: [] },
      targetUsers: [], techStack: [],
      gaps: gaps.map((g, i) => ({ category: 'business', description: `gap-${i}`, severity: g.severity, suggestion: 's' })),
      requiredExternalServices: [], readinessScore: 80, readinessReason: 'r',
    })
  }

  it('filters importantGaps to severity: must_resolve only', async () => {
    const { importantGaps } = await analyzeProjectDefinition(
      { goal: 'G', designPhilosophy: [] },
      { mockResponse: mockResponse([{ severity: 'must_resolve' }, { severity: 'should_resolve' }, { severity: 'optional' }]) },
    )
    expect(importantGaps).toHaveLength(1)
    expect(importantGaps[0].severity).toBe('must_resolve')
  })

  it('returns an empty importantGaps array when there are no must_resolve gaps', async () => {
    const { importantGaps } = await analyzeProjectDefinition(
      { goal: 'G', designPhilosophy: [] },
      { mockResponse: mockResponse([{ severity: 'should_resolve' }, { severity: 'optional' }]) },
    )
    expect(importantGaps).toHaveLength(0)
  })
})
