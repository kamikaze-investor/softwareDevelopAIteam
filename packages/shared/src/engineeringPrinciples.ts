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
  'scale-to-risk',
  'existing-code-grandfather',
] as const

const SLUG_SET = new Set<string>(ALL_PRINCIPLE_SLUGS)

export const BASE_PRINCIPLE_SLUGS: readonly PrincipleSlug[] = [
  'evidence-not-spec',
  'standard-design-frame',
  'observable-behavior',
] as const

const ONE_LINERS: Record<PrincipleSlug, string> = {
  'evidence-not-spec': 'Define required outcomes first; current implementation is evidence, not specification.',
  'standard-design-frame': 'Name the failure a constraint prevents before adding it.',
  'stable-contract-first': 'Prefer public APIs and stable contracts over incidental internals.',
  'deterministic-vs-heuristic': 'Use deterministic facts for gates; keep heuristics diagnostic unless justified.',
  'honest-unverifiable': 'Report unverifiable claims honestly instead of turning guesses into PASS.',
  'boundary-strictness': 'Keep security and data boundaries strict while preserving internal flexibility.',
  'observable-behavior': 'Test observable behavior and invariants, not private structure.',
  'review-integration': 'Extend existing review paths instead of creating duplicate review engines.',
  'scale-to-risk': 'Scale design detail to risk; do not force large templates onto small changes.',
  'existing-code-grandfather': 'Grandfather existing code and improve it incrementally when touched.',
} as const

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
}): PrincipleSlug[] {
  const selected: PrincipleSlug[] = [...BASE_PRINCIPLE_SLUGS]

  for (const focus of signals?.predictedFocuses ?? []) {
    selected.push(...(FOCUS_PRINCIPLE_SLUGS[focus] ?? []))
  }

  if (signals?.riskLevel !== undefined) {
    selected.push(...(RISK_PRINCIPLE_SLUGS[signals.riskLevel] ?? []))
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

export function buildEngineeringPrincipleReviewGuidance(): string {
  return [
    '## Engineering Principle Review Guidance',
    '- Flag findings or decisions coupled to current implementation details instead of stable contracts or observable behavior.',
    '- Flag constraints that do not name the specific failure they prevent and the cost they add.',
    '- Flag claims treated as verified without a formal interface that can prove them; prefer NOT_VERIFIABLE over false PASS.',
  ].join('\n')
}

function extractEngineeringPrinciples(
  content: string,
): { ok: true; bySlug: Map<PrincipleSlug, EngineeringPrinciple> } | { ok: false; reason: string } {
  const markerMatches = [...content.matchAll(/^<!--\s*principle-id:\s*([a-z0-9-]+)\s*-->\s*$/gmu)]
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
    const fullText = content.slice(textStart, textEnd).trim()
    if (fullText.length === 0) {
      return { ok: false, reason: `principle ${rawSlug} is empty` }
    }

    bySlug.set(rawSlug, {
      oneLiner: ONE_LINERS[rawSlug],
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
