import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BASE_PRINCIPLE_SLUGS,
  buildDesignContract,
  buildEngineeringPrincipleReviewGuidance,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from './engineeringPrinciples.js'

const principlePaths = [
  path.resolve(process.cwd(), '../../specs/21_outcome_oriented_generalization_principle.md'),
  path.resolve(process.cwd(), 'specs/21_outcome_oriented_generalization_principle.md'),
] as const
const missingPath = path.resolve(process.cwd(), '__missing__', '21_outcome_oriented_generalization_principle.md')

function findExistingPrincipleSpecPath(): string {
  const existingPath = principlePaths.find((candidatePath) => existsSync(candidatePath))
  if (existingPath === undefined) {
    throw new Error('principle spec fixture is missing')
  }

  return existingPath
}

describe('loadEngineeringPrinciples', () => {
  it('loads principle clauses by stable principle-id marker', () => {
    const result = loadEngineeringPrinciples(principlePaths)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bySlug.get('evidence-not-spec')?.fullText).toContain('Current implementation is evidence, not specification.')
    expect(result.bySlug.get('stable-contract-first')?.fullText).toContain('Stable Contract First')
    expect(result.bySlug.get('observable-behavior')?.oneLiner).toBe('Test observable behavior and invariants, not private structure.')
    expect(result.bySlug.get('whole-artifact-consistency')?.oneLiner).toBe(
      'Before declaring multi-fix work done, check the whole artifact once against accepted outcomes and invariants — not just the latest diff — then stop.',
    )
    expect(result.bySlug.get('whole-artifact-consistency')?.fullText).toContain(
      'not a license for repo-wide re-investigation',
    )
  })

  it('loads one-liners from principle-oneliner markers', () => {
    const originalSpec = readFileSync(findExistingPrincipleSpecPath(), 'utf-8')
    const customSpec = originalSpec.replace(
      '<!-- principle-oneliner: Test observable behavior and invariants, not private structure. -->',
      '<!-- principle-oneliner: Custom observable behavior marker. -->',
    )
    expect(customSpec).not.toBe(originalSpec)

    const tempDir = mkdtempSync(path.join(tmpdir(), 'engineering-principles-'))
    const tempPath = path.join(tempDir, '21_outcome_oriented_generalization_principle.md')

    try {
      writeFileSync(tempPath, customSpec)
      const result = loadEngineeringPrinciples([tempPath])

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.bySlug.get('observable-behavior')?.oneLiner).toBe('Custom observable behavior marker.')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
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

describe('buildEngineeringPrincipleReviewGuidance', () => {
  it('renders reviewer guidance from loaded principle one-liners', () => {
    const guidance = buildEngineeringPrincipleReviewGuidance(loadEngineeringPrinciples(principlePaths))

    expect(guidance.split('\n')).toHaveLength(5)
    expect(guidance).toContain('- implementation_coupling: Prefer public APIs and stable contracts over incidental internals.')
    expect(guidance).toContain('- over_constraint: Name the failure a constraint prevents before adding it.')
    expect(guidance).toContain('- unverifiable_assumption: Report unverifiable claims honestly instead of turning guesses into PASS.')
    expect(guidance).toContain(
      '- whole_artifact_consistency: Before declaring multi-fix work done, check the whole artifact once against accepted outcomes and invariants — not just the latest diff — then stop.',
    )
  })

  it('renders fail-honest notices for missing reviewed principles', () => {
    const guidance = buildEngineeringPrincipleReviewGuidance({
      ok: true,
      bySlug: new Map(),
    })

    expect(guidance.split('\n')).toHaveLength(5)
    expect(guidance).toContain(
      '- implementation_coupling: Principle stable-contract-first was not available; do not treat it as applied.',
    )
    expect(guidance).toContain(
      '- over_constraint: Principle standard-design-frame was not available; do not treat it as applied.',
    )
    expect(guidance).toContain(
      '- unverifiable_assumption: Principle honest-unverifiable was not available; do not treat it as applied.',
    )
    expect(guidance).toContain(
      '- whole_artifact_consistency: Principle whole-artifact-consistency was not available; do not treat it as applied.',
    )
  })

  it('renders an unavailable notice when principles are unavailable', () => {
    const guidance = buildEngineeringPrincipleReviewGuidance({
      ok: false,
      reason: 'missing principle spec',
      triedPaths: [missingPath],
    })

    expect(guidance).toContain('Engineering principles unavailable')
    expect(guidance).toContain('do not treat them as applied')
    expect(guidance).toContain('missing principle spec')
    expect(guidance).not.toContain('implementation_coupling')
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

  it('does not add whole-artifact-consistency without the iterative-fix signal', () => {
    expect(selectPrincipleSlugs()).not.toContain('whole-artifact-consistency')
    expect(selectPrincipleSlugs({ predictedFocuses: ['safety_recovery'] }))
      .not.toContain('whole-artifact-consistency')
  })

  it('adds whole-artifact-consistency only when isIterativeFix is true', () => {
    expect(selectPrincipleSlugs({ isIterativeFix: true })).toEqual([
      ...BASE_PRINCIPLE_SLUGS,
      'whole-artifact-consistency',
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
