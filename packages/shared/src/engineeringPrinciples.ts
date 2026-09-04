import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { MetaReviewFocus, MetaRiskLevel } from './types/meta_review.js'

const PRINCIPLE_SPEC_FILENAME = '21_outcome_oriented_generalization_principle.md'

const ENGINEERING_PRINCIPLE_PATHS = [
  `/workspace/control/specs/${PRINCIPLE_SPEC_FILENAME}`,
  path.resolve(process.cwd(), `../../specs/${PRINCIPLE_SPEC_FILENAME}`),
  path.resolve(process.cwd(), `specs/${PRINCIPLE_SPEC_FILENAME}`),
] as const

export type PrincipleSlug =
  | 'evidence-not-spec'
  | 'standard-design-frame'
  | 'stable-contract-first'
  | 'deterministic-vs-heuristic'
  | 'honest-unverifiable'
  | 'boundary-strictness'
  | 'observable-behavior'
  | 'review-integration'
  | 'whole-artifact-consistency'
  | 'scale-to-risk'
  | 'existing-code-grandfather'

type EngineeringPrinciple = {
  oneLiner: string
  fullText: string
}

export type EngineeringPrinciplesResult =
  | { ok: true; bySlug: Map<PrincipleSlug, EngineeringPrinciple> }
  | { ok: false; reason: string; triedPaths: readonly string[] }

const ALL_PRINCIPLE_SLUGS: readonly PrincipleSlug[] = [
  'evidence-not-spec',
  'standard-design-frame',
  'stable-contract-first',
  'deterministic-vs-heuristic',
  'honest-unverifiable',
  'boundary-strictness',
  'observable-behavior',
  'review-integration',
  'whole-artifact-consistency',
  'scale-to-risk',
  'existing-code-grandfather',
] as const

const SLUG_SET = new Set<string>(ALL_PRINCIPLE_SLUGS)

export const BASE_PRINCIPLE_SLUGS: readonly PrincipleSlug[] = [
  'evidence-not-spec',
  'standard-design-frame',
  'observable-behavior',
] as const

const FOCUS_PRINCIPLE_SLUGS: Partial<Record<MetaReviewFocus, readonly PrincipleSlug[]>> = {
  safety_recovery: [
    'stable-contract-first',
    'deterministic-vs-heuristic',
    'honest-unverifiable',
    'boundary-strictness',
  ],
  operations: [
    'stable-contract-first',
    'deterministic-vs-heuristic',
    'honest-unverifiable',
    'boundary-strictness',
  ],
  data_state_integrity: [
    'honest-unverifiable',
    'boundary-strictness',
  ],
  architecture_responsibility: [
    'stable-contract-first',
    'scale-to-risk',
  ],
  scope_simplicity: [
    'scale-to-risk',
    'existing-code-grandfather',
  ],
} as const

const RISK_PRINCIPLE_SLUGS: Partial<Record<MetaRiskLevel, readonly PrincipleSlug[]>> = {
  medium: ['scale-to-risk'],
  high: ['scale-to-risk', 'boundary-strictness'],
  critical: ['scale-to-risk', 'boundary-strictness', 'honest-unverifiable'],
} as const

// Repair jobs, review-finding resolutions, and any other re-entry into an
// already-attempted task are exactly the "multiple accepted requirements have
// accumulated" case this principle targets — not a new taxonomy, just one more
// existing-style signal a caller can already identify from its own context.
const ITERATIVE_FIX_PRINCIPLE_SLUGS: readonly PrincipleSlug[] = [
  'whole-artifact-consistency',
] as const

const resultCache = new Map<string, EngineeringPrinciplesResult>()

export function loadEngineeringPrinciples(
  candidatePaths: readonly string[] = ENGINEERING_PRINCIPLE_PATHS,
): EngineeringPrinciplesResult {
  const cacheKey = candidatePaths.join('\0')
  const cached = resultCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const failures: string[] = []

  for (const candidatePath of candidatePaths) {
    let content: string
    try {
      content = readFileSync(candidatePath, 'utf-8')
    } catch (err: unknown) {
      failures.push(`${candidatePath}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const parsed = extractEngineeringPrinciples(content)
    if (!parsed.ok) {
      failures.push(`${candidatePath}: ${parsed.reason}`)
      continue
    }

    const result: EngineeringPrinciplesResult = { ok: true, bySlug: parsed.bySlug }
    resultCache.set(cacheKey, result)
    return result
  }

  const result: EngineeringPrinciplesResult = {
    ok: false,
    reason: failures.join(' / ') || 'no candidate path was tried',
    triedPaths: candidatePaths,
  }
  resultCache.set(cacheKey, result)
  return result
}

export function selectPrincipleSlugs(signals?: {
  predictedFocuses?: MetaReviewFocus[]
  riskLevel?: MetaRiskLevel
  /** True when the caller already knows this is a repair, retry, or other
   * re-entry into a task that has prior accepted requirements to stay
   * consistent with — not derived here, the caller's own context is the signal. */
  isIterativeFix?: boolean
}): PrincipleSlug[] {
  const selected: PrincipleSlug[] = [...BASE_PRINCIPLE_SLUGS]

  for (const focus of signals?.predictedFocuses ?? []) {
    selected.push(...(FOCUS_PRINCIPLE_SLUGS[focus] ?? []))
  }

  if (signals?.riskLevel !== undefined) {
    selected.push(...(RISK_PRINCIPLE_SLUGS[signals.riskLevel] ?? []))
  }

  if (signals?.isIterativeFix === true) {
    selected.push(...ITERATIVE_FIX_PRINCIPLE_SLUGS)
  }

  return uniqueSlugs(selected)
}

export function buildDesignContract(input: {
  slugs: readonly PrincipleSlug[]
  principles: EngineeringPrinciplesResult
  extra?: {
    invariants?: string[]
    freedom?: string
    risks?: string[]
    riskTreatment?: string
    avoidedOverConstraints?: string[]
  }
}): string {
  const lines: string[] = ['## Design Contract']

  if (!input.principles.ok) {
    lines.push(`- Engineering principles unavailable; do not treat them as applied. Reason: ${input.principles.reason}`)
  } else {
    for (const slug of uniqueSlugs(input.slugs)) {
      const principle = input.principles.bySlug.get(slug)
      lines.push(`- ${principle?.oneLiner ?? `Principle ${slug} was not available; do not treat it as applied.`}`)
    }
  }

  const extra = input.extra
  appendListSection(lines, 'Non-Negotiable Invariants', extra?.invariants)
  appendTextSection(lines, 'Implementation Freedom / Change Tolerance', extra?.freedom)
  appendListSection(lines, 'Relaxation Risks', extra?.risks)
  appendTextSection(lines, 'Risk Treatment', extra?.riskTreatment)
  appendListSection(lines, 'Avoided Over-Constraints', extra?.avoidedOverConstraints)

  return lines.join('\n')
}

export function buildEngineeringPrincipleReviewGuidance(principles: EngineeringPrinciplesResult): string {
  if (!principles.ok) {
    return [
      '## Engineering Principle Review Guidance',
      `- Engineering principles unavailable; do not treat them as applied. Reason: ${principles.reason}`,
    ].join('\n')
  }

  const stableContract = principles.bySlug.get('stable-contract-first')
  const standardDesignFrame = principles.bySlug.get('standard-design-frame')
  const honestUnverifiable = principles.bySlug.get('honest-unverifiable')
  const wholeArtifactConsistency = principles.bySlug.get('whole-artifact-consistency')

  return [
    '## Engineering Principle Review Guidance',
    `- implementation_coupling: ${stableContract?.oneLiner ?? 'Principle stable-contract-first was not available; do not treat it as applied.'}`,
    `- over_constraint: ${standardDesignFrame?.oneLiner ?? 'Principle standard-design-frame was not available; do not treat it as applied.'}`,
    `- unverifiable_assumption: ${honestUnverifiable?.oneLiner ?? 'Principle honest-unverifiable was not available; do not treat it as applied.'}`,
    `- whole_artifact_consistency: ${wholeArtifactConsistency?.oneLiner ?? 'Principle whole-artifact-consistency was not available; do not treat it as applied.'}`,
  ].join('\n')
}

function extractEngineeringPrinciples(
  content: string,
): { ok: true; bySlug: Map<PrincipleSlug, EngineeringPrinciple> } | { ok: false; reason: string } {
  const markerMatches = [...content.matchAll(/^<!--[ \t]*principle-id:[ \t]*([a-z0-9-]+)[ \t]*-->[ \t]*$/gmu)]
  if (markerMatches.length === 0) {
    return { ok: false, reason: 'no principle-id markers found' }
  }

  const bySlug = new Map<PrincipleSlug, EngineeringPrinciple>()

  for (let index = 0; index < markerMatches.length; index += 1) {
    const match = markerMatches[index]
    const rawSlug = match[1]
    if (!isPrincipleSlug(rawSlug)) {
      continue
    }

    if (bySlug.has(rawSlug)) {
      return { ok: false, reason: `duplicate principle-id marker: ${rawSlug}` }
    }

    const textStart = (match.index ?? 0) + match[0].length
    const textEnd = markerMatches[index + 1]?.index ?? content.length
    const blockText = content.slice(textStart, textEnd).replace(/^\r?\n/, '')
    const oneLinerMatch = blockText.match(/^<!--[ \t]*principle-oneliner:[ \t]*(.*?)[ \t]*-->[ \t]*(?:\r?\n|$)/u)
    if (oneLinerMatch === null) {
      return { ok: false, reason: `principle ${rawSlug} is missing principle-oneliner marker` }
    }

    const oneLiner = oneLinerMatch[1].trim()
    if (oneLiner.length === 0) {
      return { ok: false, reason: `principle ${rawSlug} one-liner is empty` }
    }

    const fullText = blockText.slice(oneLinerMatch[0].length).trim()
    if (fullText.length === 0) {
      return { ok: false, reason: `principle ${rawSlug} is empty` }
    }

    bySlug.set(rawSlug, {
      oneLiner,
      fullText,
    })
  }

  const missing = ALL_PRINCIPLE_SLUGS.filter((slug) => !bySlug.has(slug))
  if (missing.length > 0) {
    return { ok: false, reason: `missing principle-id markers: ${missing.join(', ')}` }
  }

  return { ok: true, bySlug }
}

function isPrincipleSlug(value: string): value is PrincipleSlug {
  return SLUG_SET.has(value)
}

function uniqueSlugs(slugs: readonly PrincipleSlug[]): PrincipleSlug[] {
  return [...new Set(slugs)]
}

function appendTextSection(lines: string[], heading: string, value: string | undefined): void {
  const trimmed = value?.trim()
  if (!trimmed) {
    return
  }

  lines.push('', `### ${heading}`, trimmed)
}

function appendListSection(lines: string[], heading: string, values: readonly string[] | undefined): void {
  const nonEmptyValues = values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? []
  if (nonEmptyValues.length === 0) {
    return
  }

  lines.push('', `### ${heading}`, ...nonEmptyValues.map((value) => `- ${value}`))
}
