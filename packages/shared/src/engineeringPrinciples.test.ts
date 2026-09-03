import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  BASE_PRINCIPLE_SLUGS,
  buildDesignContract,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from './engineeringPrinciples.js'

const principlePaths = [
  path.resolve(process.cwd(), '../../specs/21_outcome_oriented_generalization_principle.md'),
  path.resolve(process.cwd(), 'specs/21_outcome_oriented_generalization_principle.md'),
] as const
const missingPath = path.resolve(process.cwd(), '__missing__', '21_outcome_oriented_generalization_principle.md')

describe('loadEngineeringPrinciples', () => {
  it('loads principle clauses by stable principle-id marker', () => {
    const result = loadEngineeringPrinciples(principlePaths)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bySlug.get('evidence-not-spec')?.fullText).toContain('Current implementation is evidence, not specification.')
    expect(result.bySlug.get('stable-contract-first')?.fullText).toContain('Stable Contract First')
    expect(result.bySlug.get('observable-behavior')?.oneLiner).toContain('observable behavior')
  })

  it('fails honestly when the spec file is missing', () => {
    expect(() => loadEngineeringPrinciples([missingPath])).not.toThrow()

    const result = loadEngineeringPrinciples([missingPath])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('21_outcome_oriented_generalization_principle.md')
    expect(result.triedPaths).toEqual([missingPath])
  })
})

describe('selectPrincipleSlugs', () => {
  it('returns the base set with zero signals', () => {
    expect(selectPrincipleSlugs()).toEqual(BASE_PRINCIPLE_SLUGS)
    expect(selectPrincipleSlugs({})).toEqual(BASE_PRINCIPLE_SLUGS)
  })

  it('widens the base set from predicted focuses without duplicates', () => {
    expect(selectPrincipleSlugs({
      predictedFocuses: ['safety_recovery', 'operations'],
    })).toEqual([
      ...BASE_PRINCIPLE_SLUGS,
      'stable-contract-first',
      'deterministic-vs-heuristic',
      'honest-unverifiable',
      'boundary-strictness',
    ])
  })
})

describe('buildDesignContract', () => {
  it('renders a compact block for the base-only path', () => {
    const result = loadEngineeringPrinciples(principlePaths)
    const contract = buildDesignContract({
      slugs: BASE_PRINCIPLE_SLUGS,
      principles: result,
    })

    expect(contract.split('\n')).toHaveLength(4)
    expect(contract).toContain('## Design Contract')
    expect(contract).toContain('current implementation is evidence, not specification')
    expect(contract).toContain('observable behavior')
  })

  it('omits optional sections when they are empty', () => {
    const contract = buildDesignContract({
      slugs: BASE_PRINCIPLE_SLUGS,
      principles: loadEngineeringPrinciples(principlePaths),
      extra: {
        invariants: [],
        freedom: '  ',
        risks: [],
        avoidedOverConstraints: ['Do not pin process topology.'],
      },
    })

    expect(contract).not.toContain('Non-Negotiable Invariants')
    expect(contract).not.toContain('Implementation Freedom')
    expect(contract).not.toContain('Relaxation Risks')
    expect(contract).toContain('Avoided Over-Constraints')
    expect(contract).toContain('Do not pin process topology.')
  })

  it('renders an unavailable notice instead of silently omitting principles', () => {
    const contract = buildDesignContract({
      slugs: BASE_PRINCIPLE_SLUGS,
      principles: loadEngineeringPrinciples([missingPath]),
    })

    expect(contract).toContain('Engineering principles unavailable')
    expect(contract).toContain('do not treat them as applied')
  })
})
