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
      const matchedText = match[0]
      const separator = matchedText.search(/[:=]/)
      matches.push({
        kind,
        ...(GENERIC_ASSIGNMENT_KINDS.has(kind) && separator >= 0
          ? { assignedValue: matchedText.slice(separator + 1).trim() }
          : {}),
      })
    }
  }
  return matches
}

function implementationAddedText(diffText: string): string {
  return diffText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

function countKinds(matches: readonly SecretScanMatch[]): Map<SecretScanPatternKind, number> {
  const counts = new Map<SecretScanPatternKind, number>()
  for (const match of matches) counts.set(match.kind, (counts.get(match.kind) ?? 0) + 1)
  return counts
}

function allMatchesOwnedByAddedText(
  promptMatches: readonly SecretScanMatch[],
  addedMatches: readonly SecretScanMatch[],
): boolean {
  if (promptMatches.length !== addedMatches.length) return false
  const promptCounts = countKinds(promptMatches)
  const addedCounts = countKinds(addedMatches)
  return SECRET_SCAN_PATTERN_KINDS.every(
    (kind) => (promptCounts.get(kind) ?? 0) === (addedCounts.get(kind) ?? 0),
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

  const addedMatches = scanMatches(implementationAddedText(input.implementationDiff))
  if (!allMatchesOwnedByAddedText(promptMatches, addedMatches)) {
    return ineligibleRefusal(patternKinds, 'match_not_owned_by_implementation')
  }
  if (promptMatches.some((match) => looksCredentialLike(match.assignedValue ?? ''))) {
    return ineligibleRefusal(patternKinds, 'credential_like_assignment')
  }
  return eligibleRefusal(patternKinds)
}
