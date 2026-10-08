import type {
  Job,
  JobRefusalMetadata,
  RefusalRepairEligibilityReason,
  SecretScanPatternKind,
} from '@ai-team/shared'
import { CONTEXT_SECRET_PATTERNS } from '@ai-team/shared'
import { isTruncatedLogPreview } from './jobLogger.js'

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

interface ReportOwnership {
  range: TextRange
  matches: SecretScanMatch[]
}

export type ImplementJobReportSource = Pick<
  Job,
  | 'id'
  | 'taskId'
  | 'projectId'
  | 'status'
  | 'changedFiles'
  | 'completedAt'
  | 'aiCliProvider'
  | 'aiCliMode'
  | 'stdout'
>

export type ReviewJobReportSource = Pick<
  Job,
  'id' | 'taskId' | 'projectId' | 'aiCliMode' | 'workflowStepKey'
>

/** The canonical report block embedded by buildStructuredReviewPrompt(). */
export function buildImplementJobReport(implementJob: ImplementJobReportSource): string {
  return `[implement Job結果]\n${JSON.stringify({
    id: implementJob.id,
    status: implementJob.status,
    changedFiles: implementJob.changedFiles ?? [],
    completedAt: implementJob.completedAt,
    aiCliProvider: implementJob.aiCliProvider,
    aiCliMode: implementJob.aiCliMode,
    stdoutPreview: implementJob.stdout,
  }, null, 2)}`
}

function uniqueExactRange(text: string, exactSection: string): TextRange | undefined {
  const start = text.indexOf(exactSection)
  if (start < 0 || text.indexOf(exactSection, start + 1) >= 0) return undefined
  return { start, end: start + exactSection.length }
}

function parseResumeSource(workflowStepKey: string): string | undefined {
  return /^resume:([^:]+):\d+$/.exec(workflowStepKey)?.[1]
}

/**
 * Resolves the reviewed implement Job through the stored review lineage only.
 * Every resume hop must stay inside the same task/project and point to a review Job.
 */
export function resolveReviewedImplementJobId(
  reviewJob: ReviewJobReportSource,
  jobs: readonly ReviewJobReportSource[],
): string | undefined {
  const storedReview = jobs.find((candidate) => candidate.id === reviewJob.id)
  if (
    storedReview === undefined
    || storedReview.taskId !== reviewJob.taskId
    || storedReview.projectId !== reviewJob.projectId
    || storedReview.aiCliMode !== 'review'
  ) {
    return undefined
  }

  const sameOwner = (candidate: ReviewJobReportSource): boolean =>
    candidate.taskId === storedReview.taskId && candidate.projectId === storedReview.projectId
  const visited = new Set<string>([storedReview.id])
  let anchor = storedReview
  for (;;) {
    const sourceId = parseResumeSource(anchor.workflowStepKey ?? '')
    if (sourceId === undefined) break
    if (visited.has(sourceId) || visited.size > jobs.length) return undefined

    const source = jobs.find((candidate) => candidate.id === sourceId)
    if (source === undefined || !sameOwner(source) || source.aiCliMode !== 'review') return undefined
    visited.add(sourceId)
    anchor = source
  }

  const implementJobId = /^implement:([^:]+):review$/.exec(anchor.workflowStepKey ?? '')?.[1]
  if (implementJobId === undefined) return undefined

  const implementJob = jobs.find((candidate) => candidate.id === implementJobId)
  return implementJob !== undefined && sameOwner(implementJob) && implementJob.aiCliMode === 'implement'
    ? implementJobId
    : undefined
}

function encodedStringContentLength(value: string): number {
  return JSON.stringify(value).length - 2
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function implementReportAiCliRange(
  prompt: string,
  implementJob: ImplementJobReportSource | undefined,
): ReportOwnership | undefined {
  if (
    implementJob?.stdout === undefined
    || implementJob.aiCliProvider === undefined
    || implementJob.aiCliMode === undefined
  ) {
    return undefined
  }

  const stdout = implementJob.stdout
  const aiCliHeader = `=== AI CLI (${implementJob.aiCliProvider}/${implementJob.aiCliMode}) ===`
  const aiCliHeaderPattern = new RegExp(`^${escapeRegExp(aiCliHeader)}\\r?$`, 'gm')
  const aiCliHeaderMatch = aiCliHeaderPattern.exec(stdout)
  if (aiCliHeaderMatch?.index === undefined) return undefined
  const aiCliStart = aiCliHeaderMatch.index

  const safeCommandHeaderPattern = /^=== SafeCommand \([^\r\n]*\) ===\r?$/gm
  safeCommandHeaderPattern.lastIndex = aiCliStart + aiCliHeaderMatch[0].length
  const safeCommandHeader = safeCommandHeaderPattern.exec(stdout)
  const aiCliEnd = safeCommandHeader?.index
    ?? (isTruncatedLogPreview(stdout) ? stdout.length : undefined)
  if (aiCliEnd === undefined) return undefined

  const report = buildImplementJobReport(implementJob)
  const reportRange = uniqueExactRange(prompt, report)
  // The builder emits this section exactly once and as the final prompt section.
  if (reportRange === undefined || reportRange.end !== prompt.length) return undefined

  const serializedStdout = JSON.stringify(stdout)
  const stdoutField = `  "stdoutPreview": ${serializedStdout}`
  const fieldStart = report.lastIndexOf(stdoutField)
  if (fieldStart < 0 || report.indexOf(stdoutField) !== fieldStart) return undefined

  const valueStart = reportRange.start + fieldStart + '  "stdoutPreview": '.length
  if (prompt[valueStart] !== '"') return undefined

  const promptOffset = (rawOffset: number): number =>
    valueStart + 1 + encodedStringContentLength(stdout.slice(0, rawOffset))
  const ownedStdout = stdout.slice(aiCliStart, aiCliEnd)
  return {
    range: {
      start: promptOffset(aiCliStart),
      end: promptOffset(aiCliEnd),
    },
    // Re-scan the decoded AI section so an escaped JSON newline cannot make `\S+`
    // consume the following SafeCommand header or output.
    matches: scanMatches(ownedStdout).map((match) => ({
      ...match,
      start: promptOffset(aiCliStart + match.start),
      end: promptOffset(aiCliStart + match.end),
    })),
  }
}

function normalizeReportMatches(
  promptMatches: readonly SecretScanMatch[],
  reportOwnership: ReportOwnership | undefined,
): SecretScanMatch[] {
  if (reportOwnership === undefined) return [...promptMatches]
  return promptMatches.map((match) =>
    reportOwnership.matches.find((owned) => owned.kind === match.kind && owned.start === match.start)
    ?? match)
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

type MatchOwnership = 'diff' | 'report'

function matchOwnerships(
  promptMatches: readonly SecretScanMatch[],
  addedRanges: readonly TextRange[],
  reportRange: TextRange | undefined,
): Array<MatchOwnership | undefined> {
  return promptMatches.map((match) => {
    if (addedRanges.some((range) => match.start >= range.start && match.end <= range.end)) {
      return 'diff'
    }
    if (reportRange !== undefined && match.start >= reportRange.start && match.end <= reportRange.end) {
      return 'report'
    }
    return undefined
  })
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
  | 'implementation_added_generic_assignment'
  | 'implementation_report_generic_assignment'
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

function eligibleRefusal(
  patternKinds: SecretScanPatternKind[],
  ownerships: readonly MatchOwnership[],
): JobRefusalMetadata {
  return {
    kind: 'secret_scan',
    patternKinds,
    repairEligible: true,
    repairEligibilityReason: ownerships.includes('report')
      ? 'implementation_report_generic_assignment'
      : 'implementation_added_generic_assignment',
  }
}

/**
 * Classifies a pre-send refusal without returning matched text or assigned values.
 * `implementationDiff` is the same diff embedded in the runtime review prompt.
 * `implementJob` is the same object used to build the prompt's implement-report section.
 */
export function classifyPromptRefusal(input: {
  mode: string | undefined
  prompt: string
  implementationDiff: string
  implementJob?: ImplementJobReportSource
  reviewJob?: ReviewJobReportSource
  reviewJobs?: readonly ReviewJobReportSource[]
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

  const reportOwned = input.implementJob !== undefined
    && input.reviewJob !== undefined
    && input.reviewJobs !== undefined
    && resolveReviewedImplementJobId(input.reviewJob, input.reviewJobs) === input.implementJob.id
  const reportOwnership = reportOwned
    ? implementReportAiCliRange(input.prompt, input.implementJob)
    : undefined
  const normalizedMatches = normalizeReportMatches(promptMatches, reportOwnership)
  const ownerships = matchOwnerships(
    normalizedMatches,
    addedLineRanges(input.prompt, input.implementationDiff),
    reportOwnership?.range,
  )
  if (ownerships.some((ownership) => ownership === undefined)) {
    return ineligibleRefusal(patternKinds, 'match_not_owned_by_implementation')
  }
  if (normalizedMatches.some((match) => looksCredentialLike(match.assignedValue ?? ''))) {
    return ineligibleRefusal(patternKinds, 'credential_like_assignment')
  }
  return eligibleRefusal(patternKinds, ownerships as MatchOwnership[])
}
