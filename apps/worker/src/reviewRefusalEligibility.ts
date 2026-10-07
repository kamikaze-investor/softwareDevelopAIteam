import type {
  JobRefusalMetadata,
  RefusalRepairEligibilityReason,
  SecretScanPatternKind,
} from '@ai-team/shared'
import { CONTEXT_SECRET_PATTERNS } from '@ai-team/shared'

export const SECRET_SCAN_PATTERN_KINDS: readonly SecretScanPatternKind[] = [
  'ANTHROPIC_API_KEY assignment',
  'CLAUDE_API_KEY assignment',
  'GEMINI_API_KEY assignment',
  'GITHUB_TOKEN assignment',
  'private key header',
  'RSA private key header',
  'password assignment',
  'secret assignment',
]

const GENERIC_ASSIGNMENT_KINDS = new Set<SecretScanPatternKind>([
  'password assignment',
  'secret assignment',
])

interface SecretScanMatch {
  kind: SecretScanPatternKind
  start: number
  end: number
  /** Used only during this synchronous classification and never returned or persisted. */
  assignedValue?: string
}

function scanMatches(text: string): SecretScanMatch[] {
  const matches: SecretScanMatch[] = []
  for (let index = 0; index < CONTEXT_SECRET_PATTERNS.length; index += 1) {
    const pattern = CONTEXT_SECRET_PATTERNS[index]!
    const kind = SECRET_SCAN_PATTERN_KINDS[index]!
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const globalPattern = new RegExp(pattern.source, flags)
    for (const match of text.matchAll(globalPattern)) {
      if (match.index === undefined) continue
      const matchedText = match[0]
      const separator = matchedText.search(/[:=]/)
      matches.push({
        kind,
        start: match.index,
        end: match.index + matchedText.length,
        ...(GENERIC_ASSIGNMENT_KINDS.has(kind) && separator >= 0
          ? { assignedValue: matchedText.slice(separator + 1).trim() }
          : {}),
      })
    }
  }
  return matches
}

interface TextRange {
  start: number
  end: number
}

function promptDiffRange(prompt: string, implementationDiff: string): TextRange | undefined {
  const markers = [...prompt.matchAll(/^\[diffText\]\r?\n/gm)]
  const marker = markers.at(-1)
  if (marker?.index === undefined) return undefined
  const start = marker.index + marker[0].length
  const end = start + implementationDiff.length
  if (prompt.slice(start, end) !== implementationDiff) return undefined
  return { start, end }
}

function addedLineRanges(prompt: string, implementationDiff: string): TextRange[] {
  const diffRange = promptDiffRange(prompt, implementationDiff)
  if (diffRange === undefined) return []

  const ranges: TextRange[] = []
  let lineStart = 0
  while (lineStart <= implementationDiff.length) {
    const newline = implementationDiff.indexOf('\n', lineStart)
    const rawLineEnd = newline === -1 ? implementationDiff.length : newline
    const lineEnd = implementationDiff[rawLineEnd - 1] === '\r' ? rawLineEnd - 1 : rawLineEnd
    const line = implementationDiff.slice(lineStart, lineEnd)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      ranges.push({
        start: diffRange.start + lineStart + 1,
        end: diffRange.start + lineEnd,
      })
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return ranges
}

function allMatchesOwnedByAddedLines(
  promptMatches: readonly SecretScanMatch[],
  ranges: readonly TextRange[],
): boolean {
  return promptMatches.every(
    (match) => ranges.some((range) => match.start >= range.start && match.end <= range.end),
  )
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function looksCredentialLike(rawValue: string): boolean {
  const value = rawValue
    .replace(/^["'`]+/, '')
    .replace(/["'`,;\)\]\}]+$/, '')
  if (value.length >= 20) return true
  if (/^(?:sk[-_]|gh[pousr]_|github_pat_|AIza|AKIA|ASIA|xox[a-z]-|glpat-|npm_|pypi-)/i.test(value)) {
    return true
  }
  return value.length >= 12 && shannonEntropy(value) >= 3.5
}

type IneligibleReason = Exclude<
  RefusalRepairEligibilityReason,
  'implementation_added_generic_assignment'
>

function ineligibleRefusal(
  patternKinds: SecretScanPatternKind[],
  repairEligibilityReason: IneligibleReason,
): JobRefusalMetadata {
  return {
    kind: 'secret_scan',
    patternKinds,
    repairEligible: false,
    repairEligibilityReason,
  }
}

function eligibleRefusal(patternKinds: SecretScanPatternKind[]): JobRefusalMetadata {
  return {
    kind: 'secret_scan',
    patternKinds,
    repairEligible: true,
    repairEligibilityReason: 'implementation_added_generic_assignment',
  }
}

/**
 * Classifies a pre-send refusal without returning matched text or assigned values.
 * `implementationDiff` is the same diff embedded in the runtime review prompt.
 */
export function classifyPromptRefusal(input: {
  mode: string | undefined
  prompt: string
  implementationDiff: string
}): JobRefusalMetadata {
  const promptMatches = scanMatches(input.prompt)
  const patternKinds = [...new Set(promptMatches.map((match) => match.kind))]

  if (input.mode !== 'review') {
    return ineligibleRefusal(patternKinds, 'not_post_implementation_review')
  }
  if (promptMatches.length === 0) {
    return ineligibleRefusal(patternKinds, 'match_origin_unclear')
  }
  if (promptMatches.some((match) => !GENERIC_ASSIGNMENT_KINDS.has(match.kind))) {
    return ineligibleRefusal(patternKinds, 'non_generic_assignment_kind')
  }

  const ownedRanges = addedLineRanges(input.prompt, input.implementationDiff)
  if (!allMatchesOwnedByAddedLines(promptMatches, ownedRanges)) {
    return ineligibleRefusal(patternKinds, 'match_not_owned_by_implementation')
  }
  if (promptMatches.some((match) => looksCredentialLike(match.assignedValue ?? ''))) {
    return ineligibleRefusal(patternKinds, 'credential_like_assignment')
  }
  return eligibleRefusal(patternKinds)
}
