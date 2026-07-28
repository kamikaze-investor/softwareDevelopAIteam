import type { RoadmapItem } from './roadmapParser.js'

export const ROADMAP_CURRENT_STATE_START = '<!-- AUTO-GENERATED:ROADMAP_CURRENT_STATE:START -->'
export const ROADMAP_CURRENT_STATE_END = '<!-- AUTO-GENERATED:ROADMAP_CURRENT_STATE:END -->'

export type CurrentStateIssueCode =
  | 'missing_markers'
  | 'missing_start_marker'
  | 'missing_end_marker'
  | 'duplicate_start_marker'
  | 'duplicate_end_marker'
  | 'invalid_marker_order'

export interface CurrentStateIssue {
  code: CurrentStateIssueCode
  message: string
  line?: number
}

export interface CurrentStateSyncResult {
  markdown: string
  changed: boolean
}

export class CurrentStateSyncError extends Error {
  constructor(
    message: string,
    public readonly issues: CurrentStateIssue[],
  ) {
    super(message)
    this.name = 'CurrentStateSyncError'
  }
}

export function generateRoadmapCurrentStateBlock(items: readonly RoadmapItem[]): string {
  const doneItems = items.filter((item) => item.state === 'done')
  const openItems = items.filter((item) => item.state !== 'done')

  return [
    '**完了項目:**',
    ...formatDoneItems(doneItems),
    '',
    '**未完了・保留項目:**',
    ...formatOpenItems(openItems),
    '',
    '詳細は `tasks/roadmap.md`「スマホ操作MVP残タスク」を参照。',
  ].join('\n')
}

export function replaceGeneratedCurrentStateBlock(
  markdown: string,
  generatedBlock: string,
): CurrentStateSyncResult {
  const { lines, lineEnding } = splitMarkdown(markdown)
  const markerResult = findMarkerLines(lines)

  if (markerResult.issues.length > 0 || markerResult.startLineIndex === null || markerResult.endLineIndex === null) {
    throw new CurrentStateSyncError('Current state generated block markers are invalid', markerResult.issues)
  }

  const generatedLines = normalizeGeneratedBlock(generatedBlock).split('\n')
  const nextLines = [
    ...lines.slice(0, markerResult.startLineIndex + 1),
    ...generatedLines,
    ...lines.slice(markerResult.endLineIndex),
  ]
  const nextMarkdown = nextLines.join(lineEnding)

  return {
    markdown: nextMarkdown,
    changed: nextMarkdown !== markdown,
  }
}

export function validateCurrentStateMarkers(markdown: string): CurrentStateIssue[] {
  return findMarkerLines(splitMarkdown(markdown).lines).issues
}

export function isCurrentStateBlockSynced(markdown: string, generatedBlock: string): boolean {
  const syncResult = replaceGeneratedCurrentStateBlock(markdown, generatedBlock)
  return syncResult.markdown === markdown
}

export function formatCurrentStateIssues(issues: readonly CurrentStateIssue[]): string {
  return issues.map(formatCurrentStateIssue).join('\n')
}

function formatDoneItems(items: readonly RoadmapItem[]): string[] {
  if (items.length === 0) {
    return ['- なし']
  }

  return items.map((item) => `- ${item.title}`)
}

function formatOpenItems(items: readonly RoadmapItem[]): string[] {
  if (items.length === 0) {
    return ['- なし']
  }

  return items.map((item) => `- ${item.title}（state: ${item.state}）`)
}

function splitMarkdown(markdown: string): { lines: string[]; lineEnding: string } {
  return {
    lines: markdown.split(/\r\n|\n/),
    lineEnding: markdown.includes('\r\n') ? '\r\n' : '\n',
  }
}

function normalizeGeneratedBlock(generatedBlock: string): string {
  return generatedBlock.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '')
}

function findMarkerLines(lines: readonly string[]): {
  startLineIndex: number | null
  endLineIndex: number | null
  issues: CurrentStateIssue[]
} {
  const startLineIndexes = findLineIndexes(lines, ROADMAP_CURRENT_STATE_START)
  const endLineIndexes = findLineIndexes(lines, ROADMAP_CURRENT_STATE_END)
  const issues: CurrentStateIssue[] = []

  if (startLineIndexes.length === 0 && endLineIndexes.length === 0) {
    issues.push({
      code: 'missing_markers',
      message: 'Current state generated block markers were not found',
    })
    return {
      startLineIndex: null,
      endLineIndex: null,
      issues,
    }
  }

  if (startLineIndexes.length === 0) {
    issues.push({
      code: 'missing_start_marker',
      message: 'Current state generated block START marker was not found',
    })
  }

  if (endLineIndexes.length === 0) {
    issues.push({
      code: 'missing_end_marker',
      message: 'Current state generated block END marker was not found',
    })
  }

  if (startLineIndexes.length > 1) {
    issues.push({
      code: 'duplicate_start_marker',
      line: startLineIndexes[1] + 1,
      message: 'Current state generated block START marker is duplicated',
    })
  }

  if (endLineIndexes.length > 1) {
    issues.push({
      code: 'duplicate_end_marker',
      line: endLineIndexes[1] + 1,
      message: 'Current state generated block END marker is duplicated',
    })
  }

  const startLineIndex = startLineIndexes[0] ?? null
  const endLineIndex = endLineIndexes[0] ?? null

  if (startLineIndex !== null && endLineIndex !== null && startLineIndex >= endLineIndex) {
    issues.push({
      code: 'invalid_marker_order',
      line: startLineIndex + 1,
      message: 'Current state generated block START marker must appear before END marker',
    })
  }

  return {
    startLineIndex,
    endLineIndex,
    issues,
  }
}

function findLineIndexes(lines: readonly string[], marker: string): number[] {
  const indexes: number[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lines[lineIndex].trim() === marker) {
      indexes.push(lineIndex)
    }
  }

  return indexes
}

function formatCurrentStateIssue(issue: CurrentStateIssue): string {
  const location = issue.line === undefined ? '' : `line ${issue.line}: `
  return `${location}${issue.message}`
}
