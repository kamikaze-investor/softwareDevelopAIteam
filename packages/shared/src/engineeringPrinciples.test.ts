import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildApplicablePrinciplesSection,
  buildDesignContract,
  buildEngineeringPrincipleReviewGuidance,
  corePrincipleSlugs,
  loadEngineeringPrinciples,
  selectPrinciples,
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

function loadForTest(): ReturnType<typeof loadEngineeringPrinciples> {
  return loadEngineeringPrinciples(principlePaths)
}

function writeSpecFixture(content: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'engineering-principles-'))
  const tempPath = path.join(tempDir, '21_outcome_oriented_generalization_principle.md')
  writeFileSync(tempPath, content)
  return tempPath
}

function writeSpecVariant(transform: (original: string) => string): string {
  const originalSpec = readFileSync(findExistingPrincipleSpecPath(), 'utf-8')
  const customSpec = transform(originalSpec)
  // transform が何も変えていないなら、そのテストは意図した状況を作れていない。
  expect(customSpec).not.toBe(originalSpec)
  return writeSpecFixture(customSpec)
}

describe('loadEngineeringPrinciples', () => {
  it('loads principle clauses by stable principle-id marker', () => {
    const result = loadForTest()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bySlug.get('evidence-not-spec')?.fullText).toContain('Current implementation is evidence, not specification.')
    expect(result.bySlug.get('stable-contract-first')?.fullText).toContain('Stable Contract First')
    expect(result.bySlug.get('observable-behavior')?.oneLiner).toBe('Test observable behavior and invariants, not private structure.')
    expect(result.bySlug.get('observation-closes-loop')?.fullText).toContain('an unfalsifiable TODO')
  })

  it('loads registry metadata from the same marker block as the body', () => {
    const result = loadForTest()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const observation = result.bySlug.get('observation-closes-loop')
    expect(observation?.tier).toBe('core')
    expect(observation?.category).toBe('verification')
    expect(observation?.scope).toBe('universal')
    expect(observation?.tags).toContain('feedback-loop')

    const grandfather = result.bySlug.get('existing-code-grandfather')
    expect(grandfather?.tier).toBe('contextual')
  })

  it('derives a version hash that ignores line-ending differences', () => {
    // 正規化した結果が元ファイルと同一になり得るので writeSpecVariant の差分ガードは使わない。
    // 確かめたいのは「CRLF と LF で版が変わらない」ことだけである。
    const lfSpec = readFileSync(findExistingPrincipleSpecPath(), 'utf-8').split('\r\n').join('\n')
    const lfPath = writeSpecFixture(lfSpec)
    const crlfPath = writeSpecFixture(lfSpec.split('\n').join('\r\n'))

    try {
      const lf = loadEngineeringPrinciples([lfPath])
      const crlf = loadEngineeringPrinciples([crlfPath])
      expect(lf.ok && crlf.ok).toBe(true)
      if (!lf.ok || !crlf.ok) return

      for (const slug of corePrincipleSlugs(lf)) {
        expect(crlf.bySlug.get(slug)?.versionHash).toBe(lf.bySlug.get(slug)?.versionHash)
      }
      expect(lf.bySlug.get('observation-closes-loop')?.versionHash).toMatch(/^[0-9a-f]{16}$/u)
    } finally {
      rmSync(path.dirname(lfPath), { recursive: true, force: true })
      rmSync(path.dirname(crlfPath), { recursive: true, force: true })
    }
  })

  it('changes the version hash when the principle body changes', () => {
    const tempPath = writeSpecVariant((spec) => spec.replace('an unfalsifiable TODO', 'a forgettable TODO'))

    try {
      const changed = loadEngineeringPrinciples([tempPath])
      const original = loadForTest()
      expect(changed.ok && original.ok).toBe(true)
      if (!changed.ok || !original.ok) return

      expect(changed.bySlug.get('observation-closes-loop')?.versionHash)
        .not.toBe(original.bySlug.get('observation-closes-loop')?.versionHash)
      // 別の原則の版は巻き添えで変わらない。
      expect(changed.bySlug.get('observable-behavior')?.versionHash)
        .toBe(original.bySlug.get('observable-behavior')?.versionHash)
    } finally {
      rmSync(path.dirname(tempPath), { recursive: true, force: true })
    }
  })

  it('loads one-liners from principle-oneliner markers', () => {
    const tempPath = writeSpecVariant((spec) => spec.replace(
      '<!-- principle-oneliner: Test observable behavior and invariants, not private structure. -->',
      '<!-- principle-oneliner: Custom observable behavior marker. -->',
    ))

    try {
      const result = loadEngineeringPrinciples([tempPath])

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.bySlug.get('observable-behavior')?.oneLiner).toBe('Custom observable behavior marker.')
    } finally {
      rmSync(path.dirname(tempPath), { recursive: true, force: true })
    }
  })

  it('fails loudly when a principle has no tier marker instead of silently demoting it', () => {
    const tempPath = writeSpecVariant((spec) => spec.replace(
      /<!-- principle-tier: core -->\r?\n<!-- principle-tags: requirements, design, contract -->\r?\n/u,
      '',
    ))

    try {
      const result = loadEngineeringPrinciples([tempPath])
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('missing principle-tier marker')
    } finally {
      rmSync(path.dirname(tempPath), { recursive: true, force: true })
    }
  })

  it('rejects an unknown tier value', () => {
    const tempPath = writeSpecVariant((spec) => spec.replace(
      '<!-- principle-tier: contextual -->',
      '<!-- principle-tier: sometimes -->',
    ))

    try {
      const result = loadEngineeringPrinciples([tempPath])
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('unknown principle-tier')
    } finally {
      rmSync(path.dirname(tempPath), { recursive: true, force: true })
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

describe('corePrincipleSlugs', () => {
  it('derives the core set from the registry rather than a hardcoded list', () => {
    const core = corePrincipleSlugs(loadForTest())

    // 期待値はこのテストにだけ書く。production の選択経路は marker だけを読む
    // （code 側に core の第二の正本を置かない）。
    expect(core).toEqual([
      'evidence-not-spec',
      'standard-design-frame',
      'observable-behavior',
      'observation-closes-loop',
    ])
  })

  it('returns nothing when the registry is unavailable', () => {
    expect(corePrincipleSlugs(loadEngineeringPrinciples([missingPath]))).toEqual([])
  })
})

describe('selectPrinciples', () => {
  it('returns the core set with zero signals, tagged as core', () => {
    const principles = loadForTest()
    const selection = selectPrinciples(undefined, principles)

    expect(selection.map((item) => item.slug)).toEqual(corePrincipleSlugs(principles))
    expect(selection.every((item) => item.source === 'core')).toBe(true)
    expect(selection[0].reason).toContain('core principle')
    expect(selection[0].versionHash).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('widens the core set from predicted focuses and records why each was selected', () => {
    const principles = loadForTest()
    const selection = selectPrinciples({ predictedFocuses: ['safety_recovery'] }, principles)

    const boundary = selection.find((item) => item.slug === 'boundary-strictness')
    expect(boundary?.source).toBe('contextual')
    expect(boundary?.reason).toBe('focus=safety_recovery')
  })

  it('records risk-derived selections separately from focus-derived ones', () => {
    const principles = loadForTest()
    const selection = selectPrinciples({ riskLevel: 'high' }, principles)

    const scaleToRisk = selection.find((item) => item.slug === 'scale-to-risk')
    expect(scaleToRisk?.source).toBe('risk')
    expect(scaleToRisk?.reason).toBe('riskLevel=high')
  })

  it('keeps the first selection reason when several signals pick the same principle', () => {
    const principles = loadForTest()
    const selection = selectPrinciples(
      { predictedFocuses: ['scope_simplicity'], riskLevel: 'high' },
      principles,
    )

    const scaleToRisk = selection.filter((item) => item.slug === 'scale-to-risk')
    expect(scaleToRisk).toHaveLength(1)
    expect(scaleToRisk[0].source).toBe('contextual')
  })

  it('returns nothing when the registry is unavailable rather than pretending core applied', () => {
    expect(selectPrinciples({ riskLevel: 'critical' }, loadEngineeringPrinciples([missingPath]))).toEqual([])
    expect(selectPrincipleSlugs(undefined, loadEngineeringPrinciples([missingPath]))).toEqual([])
  })
})

describe('buildApplicablePrinciplesSection', () => {
  it('lists one line per principle and forbids invented ids', () => {
    const principles = loadForTest()
    const section = buildApplicablePrinciplesSection(selectPrinciples(undefined, principles))

    expect(section).toContain('## Applicable Principles')
    expect(section).toContain('- observation-closes-loop: Deferring to observation requires a closed loop')
    expect(section).toContain('Do not invent principle ids')
    // 全文ではなく one-liner だけを載せる（原則数に対して prompt が線形に太らない）。
    expect(section).not.toContain('an unfalsifiable TODO')
  })

  it('says so explicitly when nothing could be selected', () => {
    const section = buildApplicablePrinciplesSection([])

    expect(section).toContain('do not report principle verdicts')
  })
})

describe('buildEngineeringPrincipleReviewGuidance', () => {
  it('renders reviewer guidance from loaded principle one-liners', () => {
    const guidance = buildEngineeringPrincipleReviewGuidance(loadForTest())

    expect(guidance).toContain('- implementation_coupling: Prefer public APIs and stable contracts over incidental internals.')
    expect(guidance).toContain('- over_constraint: Name the failure a constraint prevents before adding it.')
    expect(guidance).toContain('- unverifiable_assumption: Report unverifiable claims honestly instead of turning guesses into PASS.')
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

describe('buildDesignContract', () => {
  it('renders a compact block for the core-only path', () => {
    const principles = loadForTest()
    const core = corePrincipleSlugs(principles)
    const contract = buildDesignContract({ slugs: core, principles })

    // heading + one line per core principle. Derived so that adding a core principle is a
    // visible change here instead of an unnoticed prompt-size drift.
    expect(contract.split('\n')).toHaveLength(core.length + 1)
    expect(contract).toContain('## Design Contract')
    expect(contract).toContain('current implementation is evidence, not specification')
    expect(contract).toContain('observable behavior')
  })

  it('omits optional sections when they are empty', () => {
    const principles = loadForTest()
    const contract = buildDesignContract({
      slugs: corePrincipleSlugs(principles),
      principles,
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
      slugs: ['evidence-not-spec'],
      principles: loadEngineeringPrinciples([missingPath]),
    })

    expect(contract).toContain('Engineering principles unavailable')
    expect(contract).toContain('do not treat them as applied')
  })
})

describe('registry cache invalidation', () => {
  it('spec ファイルが書き換わったら再読み込みする（プロセス再起動を要求しない）', () => {
    const tempPath = writeSpecFixture(
      readFileSync(findExistingPrincipleSpecPath(), 'utf-8').split('\r\n').join('\n'),
    )

    try {
      const before = loadEngineeringPrinciples([tempPath])
      expect(before.ok).toBe(true)
      if (!before.ok) return
      const beforeHash = before.bySlug.get('observation-closes-loop')?.versionHash

      // 本文を書き換える。mtime も size も変わる。
      const rewritten = readFileSync(tempPath, 'utf-8').replace('an unfalsifiable TODO', 'a forgettable TODO')
      writeFileSync(tempPath, rewritten)

      const after = loadEngineeringPrinciples([tempPath])
      expect(after.ok).toBe(true)
      if (!after.ok) return
      expect(after.bySlug.get('observation-closes-loop')?.versionHash).not.toBe(beforeHash)
      expect(after.bySlug.get('observation-closes-loop')?.fullText).toContain('a forgettable TODO')
    } finally {
      rmSync(path.dirname(tempPath), { recursive: true, force: true })
    }
  })

  it('spec が壊れたら、直前の成功結果を使い続けない', () => {
    const tempPath = writeSpecFixture(
      readFileSync(findExistingPrincipleSpecPath(), 'utf-8').split('\r\n').join('\n'),
    )

    try {
      expect(loadEngineeringPrinciples([tempPath]).ok).toBe(true)

      writeFileSync(tempPath, '# no markers at all\n')
      const after = loadEngineeringPrinciples([tempPath])

      expect(after.ok).toBe(false)
      if (after.ok) return
      expect(after.reason).toContain('no principle-id markers found')
    } finally {
      rmSync(path.dirname(tempPath), { recursive: true, force: true })
    }
  })
})

describe('version hash covers tier', () => {
  it('文言を変えずに tier を動かすと版が変わる', () => {
    const original = readFileSync(findExistingPrincipleSpecPath(), 'utf-8').split('\r\n').join('\n')
    const basePath = writeSpecFixture(original)
    // observable-behavior を core -> contextual へ落とす（文言は一切変えない）。
    const movedPath = writeSpecFixture(original.replace(
      `<!-- principle-oneliner: Test observable behavior and invariants, not private structure. -->
<!-- principle-category: verification -->
<!-- principle-scope: universal -->
<!-- principle-tier: core -->`,
      `<!-- principle-oneliner: Test observable behavior and invariants, not private structure. -->
<!-- principle-category: verification -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->`,
    ))

    try {
      const base = loadEngineeringPrinciples([basePath])
      const moved = loadEngineeringPrinciples([movedPath])
      expect(base.ok && moved.ok).toBe(true)
      if (!base.ok || !moved.ok) return

      expect(base.bySlug.get('observable-behavior')?.tier).toBe('core')
      expect(moved.bySlug.get('observable-behavior')?.tier).toBe('contextual')
      // 文言は同一でも版は変わる。旧 tier 下の実績を新 tier の根拠にしない。
      expect(moved.bySlug.get('observable-behavior')?.oneLiner)
        .toBe(base.bySlug.get('observable-behavior')?.oneLiner)
      expect(moved.bySlug.get('observable-behavior')?.versionHash)
        .not.toBe(base.bySlug.get('observable-behavior')?.versionHash)
    } finally {
      rmSync(path.dirname(basePath), { recursive: true, force: true })
      rmSync(path.dirname(movedPath), { recursive: true, force: true })
    }
  })
})
