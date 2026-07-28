export const ALLOWED_ROADMAP_STATES = [
  'planned',
  'in_progress',
  'blocked',
  'deferred',
  'done',
] as const

export type RoadmapState = (typeof ALLOWED_ROADMAP_STATES)[number]

export type CheckboxState = 'checked' | 'unchecked'

export type RoadmapIssueCode =
  | 'duplicate_id'
  | 'invalid_metadata'
  | 'invalid_state'
  | 'missing_checkbox'
  | 'checkbox_state_mismatch'

export interface RoadmapIssue {
  code: RoadmapIssueCode
  message: string
  id?: string
  line?: number
}

export interface ParsedRoadmapItem {
  id: string
  state: string
  checkbox: CheckboxState | null
  title: string
  metadataLineIndex: number
  checkboxLineIndex: number | null
}

export interface RoadmapItem extends ParsedRoadmapItem {
  state: RoadmapState
  checkbox: CheckboxState
  checkboxLineIndex: number
}

export interface RoadmapParseResult {
  items: ParsedRoadmapItem[]
  issues: RoadmapIssue[]
}

export interface RoadmapUpdateResult {
  markdown: string
  changed: boolean
  item: RoadmapItem
}

export class RoadmapValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: RoadmapIssue[],
  ) {
    super(message)
    this.name = 'RoadmapValidationError'
  }
}

const ROADMAP_METADATA_REGEX = /^\s*<!--\s+roadmap:id=([^\s]+)\s+state=([^\s]+)\s+-->\s*$/
const ROADMAP_METADATA_PREFIX_REGEX = /^\s*<!--\s*roadmap:/
const CHECKBOX_LINE_REGEX = /^(\s*\d+\.\s+\[)( |x)(\]\s+)(.*)$/
const STATE_SET: ReadonlySet<string> = new Set(ALLOWED_ROADMAP_STATES)

export function isRoadmapState(value: string): value is RoadmapState {
  return STATE_SET.has(value)
}

export function parseRoadmapMarkdown(markdown: string): RoadmapParseResult {
  const lines = splitMarkdown(markdown).lines
  const items: ParsedRoadmapItem[] = []
  const issues: RoadmapIssue[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const metadataMatch = line.match(ROADMAP_METADATA_REGEX)

    if (!metadataMatch) {
      if (ROADMAP_METADATA_PREFIX_REGEX.test(line)) {
        issues.push({
          code: 'invalid_metadata',
          message: `Invalid roadmap metadata comment at line ${lineIndex + 1}`,
          line: lineIndex + 1,
        })
      }
      continue
    }

    const [, id, state] = metadataMatch
    const checkboxLineIndex = findNextNonEmptyLine(lines, lineIndex + 1)
    const checkboxLine = checkboxLineIndex === null ? null : lines[checkboxLineIndex]
    const checkboxMatch = checkboxLine?.match(CHECKBOX_LINE_REGEX) ?? null
    const checkbox = checkboxMatch ? parseCheckboxState(checkboxMatch[2]) : null
    const title = checkboxMatch ? extractTitle(checkboxMatch[4]) : ''

    const item: ParsedRoadmapItem = {
      id,
      state,
      checkbox,
      title,
      metadataLineIndex: lineIndex,
      checkboxLineIndex,
    }
    items.push(item)

    if (!isRoadmapState(state)) {
      issues.push({
        code: 'invalid_state',
        id,
        line: lineIndex + 1,
        message: `Roadmap item "${id}" has invalid state "${state}"`,
      })
    }

    if (!checkboxMatch || checkboxLineIndex === null) {
      issues.push({
        code: 'missing_checkbox',
        id,
        line: lineIndex + 1,
        message: `Roadmap metadata "${id}" is not followed by a checkbox line`,
      })
      continue
    }

    if (isRoadmapState(state)) {
      const expectedCheckbox = expectedCheckboxForState(state)
      if (checkbox !== expectedCheckbox) {
        issues.push({
          code: 'checkbox_state_mismatch',
          id,
          line: checkboxLineIndex + 1,
          message: `Roadmap item "${id}" has state "${state}" but checkbox is ${formatCheckboxState(checkbox)}`,
        })
      }
    }
  }

  issues.push(...findDuplicateIdIssues(items))

  return { items, issues }
}

export function getValidRoadmapItems(markdown: string): RoadmapItem[] {
  const parseResult = parseRoadmapMarkdown(markdown)
  if (parseResult.issues.length > 0) {
    throw new RoadmapValidationError('Roadmap validation failed', parseResult.issues)
  }

  return parseResult.items.map((item) => {
    if (!isRoadmapState(item.state) || item.checkbox === null || item.checkboxLineIndex === null) {
      throw new RoadmapValidationError('Roadmap validation failed', [
        {
          code: 'invalid_metadata',
          id: item.id,
          line: item.metadataLineIndex + 1,
          message: `Roadmap item "${item.id}" is not valid`,
        },
      ])
    }

    return {
      ...item,
      state: item.state,
      checkbox: item.checkbox,
      checkboxLineIndex: item.checkboxLineIndex,
    }
  })
}

export function updateRoadmapState(
  markdown: string,
  id: string,
  nextState: string,
): RoadmapUpdateResult {
  if (!isRoadmapState(nextState)) {
    throw new RoadmapValidationError(`Invalid roadmap state "${nextState}"`, [
      {
        code: 'invalid_state',
        id,
        message: `Invalid roadmap state "${nextState}". Allowed states: ${ALLOWED_ROADMAP_STATES.join(', ')}`,
      },
    ])
  }

  const parseResult = parseRoadmapMarkdown(markdown)
  const targetItems = parseResult.items.filter((item) => item.id === id)

  if (targetItems.length === 0) {
    throw new RoadmapValidationError(`Roadmap item "${id}" was not found`, [
      {
        code: 'invalid_metadata',
        id,
        message: `Roadmap item "${id}" was not found`,
      },
    ])
  }

  const blockingIssues = parseResult.issues.filter((issue) => {
    return !(issue.code === 'checkbox_state_mismatch' && issue.id === id)
  })

  if (blockingIssues.length > 0) {
    throw new RoadmapValidationError('Roadmap validation failed', blockingIssues)
  }

  if (targetItems.length > 1) {
    throw new RoadmapValidationError(`Roadmap item "${id}" is duplicated`, [
      {
        code: 'duplicate_id',
        id,
        message: `Roadmap item "${id}" is duplicated`,
      },
    ])
  }

  const targetItem = targetItems[0]
  if (targetItem.checkboxLineIndex === null || targetItem.checkbox === null) {
    throw new RoadmapValidationError(`Roadmap item "${id}" is not followed by a checkbox line`, [
      {
        code: 'missing_checkbox',
        id,
        line: targetItem.metadataLineIndex + 1,
        message: `Roadmap metadata "${id}" is not followed by a checkbox line`,
      },
    ])
  }

  const { lines, lineEnding } = splitMarkdown(markdown)
  lines[targetItem.metadataLineIndex] = lines[targetItem.metadataLineIndex].replace(
    /state=[^\s]+/,
    `state=${nextState}`,
  )
  lines[targetItem.checkboxLineIndex] = syncCheckboxLine(lines[targetItem.checkboxLineIndex], nextState)

  const nextMarkdown = joinMarkdown(lines, lineEnding)
  const nextItems = getValidRoadmapItems(nextMarkdown)
  const nextItem = nextItems.find((item) => item.id === id)

  if (!nextItem) {
    throw new RoadmapValidationError(`Roadmap item "${id}" was not found after update`, [
      {
        code: 'invalid_metadata',
        id,
        message: `Roadmap item "${id}" was not found after update`,
      },
    ])
  }

  return {
    markdown: nextMarkdown,
    changed: nextMarkdown !== markdown,
    item: nextItem,
  }
}

export function formatRoadmapIssues(issues: readonly RoadmapIssue[]): string {
  return issues.map(formatRoadmapIssue).join('\n')
}

function splitMarkdown(markdown: string): { lines: string[]; lineEnding: string } {
  return {
    lines: markdown.split(/\r\n|\n/),
    lineEnding: markdown.includes('\r\n') ? '\r\n' : '\n',
  }
}

function joinMarkdown(lines: readonly string[], lineEnding: string): string {
  return lines.join(lineEnding)
}

function findNextNonEmptyLine(lines: readonly string[], startIndex: number): number | null {
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    if (lines[lineIndex].trim().length > 0) {
      return lineIndex
    }
  }

  return null
}

function parseCheckboxState(value: string): CheckboxState {
  return value === 'x' ? 'checked' : 'unchecked'
}

function expectedCheckboxForState(state: RoadmapState): CheckboxState {
  return state === 'done' ? 'checked' : 'unchecked'
}

function syncCheckboxLine(line: string, state: RoadmapState): string {
  const checkboxValue = state === 'done' ? 'x' : ' '
  return line.replace(CHECKBOX_LINE_REGEX, `$1${checkboxValue}$3$4`)
}

function extractTitle(checkboxText: string): string {
  const separatorIndex = checkboxText.indexOf('—')
  if (separatorIndex === -1) {
    return checkboxText.trim()
  }

  return checkboxText.slice(0, separatorIndex).trim()
}

function findDuplicateIdIssues(items: readonly ParsedRoadmapItem[]): RoadmapIssue[] {
  const firstLineById = new Map<string, number>()
  const issues: RoadmapIssue[] = []

  for (const item of items) {
    const firstLine = firstLineById.get(item.id)
    if (firstLine === undefined) {
      firstLineById.set(item.id, item.metadataLineIndex + 1)
      continue
    }

    issues.push({
      code: 'duplicate_id',
      id: item.id,
      line: item.metadataLineIndex + 1,
      message: `Roadmap item "${item.id}" is duplicated (first seen at line ${firstLine})`,
    })
  }

  return issues
}

function formatRoadmapIssue(issue: RoadmapIssue): string {
  const location = issue.line === undefined ? '' : `line ${issue.line}: `
  return `${location}${issue.message}`
}

function formatCheckboxState(state: CheckboxState | null): string {
  if (state === 'checked') {
    return '[x]'
  }

  if (state === 'unchecked') {
    return '[ ]'
  }

  return 'missing'
}
