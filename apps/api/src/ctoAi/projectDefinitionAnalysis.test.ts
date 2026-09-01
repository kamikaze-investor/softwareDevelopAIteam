import { describe, expect, it } from 'vitest'
import {
  analyzeProjectDefinition,
  buildSpecTextFromProjectDefinition,
  computeProjectDefinitionHash,
  isProjectDefinitionReady,
} from './projectDefinitionAnalysis'
import type { SpecAnalysis } from './specAnalyzer'

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

  it('returns the canonical Project Definition text and hash used for analysis', async () => {
    const result = await analyzeProjectDefinition(
      {
        goal: 'Ship the thing',
        designPhilosophy: ['Small steps'],
        gapAnswers: { 'Who is the user?': 'Internal operators' },
      },
      { mockResponse: mockResponse([]) },
    )

    expect(result.canonicalDefinitionText).toContain('# Goal')
    expect(result.canonicalDefinitionText).toContain('Internal operators')
    expect(result.definitionHash).toBe(computeProjectDefinitionHash(result.canonicalDefinitionText))
  })

  it('returns an empty importantGaps array when there are no must_resolve gaps', async () => {
    const { importantGaps } = await analyzeProjectDefinition(
      { goal: 'G', designPhilosophy: [] },
      { mockResponse: mockResponse([{ severity: 'should_resolve' }, { severity: 'optional' }]) },
    )
    expect(importantGaps).toHaveLength(0)
  })
})

describe('computeProjectDefinitionHash', () => {
  it('uses deterministic sha256 hashing', () => {
    expect(computeProjectDefinitionHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('isProjectDefinitionReady', () => {
  function analysis(overrides: Partial<SpecAnalysis> = {}): SpecAnalysis {
    return {
      goal: 'G',
      designPhilosophy: [],
      mvpScope: { description: 'G', includedFeatures: [], excludedFeatures: [] },
      targetUsers: [],
      techStack: [],
      gaps: [],
      structuredConstraints: [],
      requiredExternalServices: [],
      readinessScore: 80,
      readinessReason: 'ready enough',
      ...overrides,
    }
  }

  it('blocks when a must_resolve gap exists even if readinessScore is high', () => {
    const result = isProjectDefinitionReady(analysis({
      gaps: [{ category: 'business', description: 'missing audience', severity: 'must_resolve', suggestion: 'ask' }],
      readinessScore: 95,
    }))

    expect(result.ready).toBe(false)
    expect(result.reason).toBe('Project Definition has unresolved gaps')
    expect(result.importantGaps).toHaveLength(1)
  })

  it('blocks low readiness even without must_resolve gaps, synthesizing one answerable Gap', () => {
    const result = isProjectDefinitionReady(analysis({
      readinessScore: 60,
      readinessReason: 'Scope is too vague.',
    }))

    expect(result.ready).toBe(false)
    // The Mobile gaps screen only renders question cards with an input; a bare "not ready"
    // message with an empty Gap list would be a dead end, so a concrete must_resolve Gap is
    // synthesized from the readiness reason (independent-review fix, 2026-09-01).
    expect(result.importantGaps).toHaveLength(1)
    expect(result.importantGaps[0].severity).toBe('must_resolve')
    expect(result.importantGaps[0].suggestion).toBe('Scope is too vague.')
    expect(result.readinessReason).toBe('Scope is too vague.')
  })

  it('accepts analysis with no must_resolve gaps and readinessScore at the threshold', () => {
    const result = isProjectDefinitionReady(analysis({ readinessScore: 70 }))

    expect(result.ready).toBe(true)
    expect(result.importantGaps).toEqual([])
  })
})
