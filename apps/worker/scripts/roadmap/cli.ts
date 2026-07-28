import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateRoadmapCurrentStateBlock,
  replaceGeneratedCurrentStateBlock,
  validateCurrentStateMarkers,
} from './currentStateSync.js'
import {
  getValidRoadmapItems,
  isRoadmapState,
  parseRoadmapMarkdown,
  updateRoadmapState,
  type RoadmapIssue,
  type RoadmapState,
} from './roadmapParser.js'

type CliCommand =
  | { kind: 'update'; id: string; state: RoadmapState }
  | { kind: 'sync' }
  | { kind: 'check' }

export interface CheckIssue {
  source: 'roadmap' | 'currentState'
  code: string
  message: string
  line?: number
}

interface RepoPaths {
  repoRoot: string
  roadmapPath: string
  currentStatePath: string
}

class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export function parseCommandArgs(args: readonly string[]): CliCommand {
  const [command, ...restArgs] = args

  if (command === 'sync') {
    assertNoExtraArgs(command, restArgs)
    return { kind: 'sync' }
  }

  if (command === 'check') {
    assertNoExtraArgs(command, restArgs)
    return { kind: 'check' }
  }

  if (command === 'update') {
    const id = readRequiredOption(restArgs, '--id')
    const state = readRequiredOption(restArgs, '--state')
    const knownOptionArgs = countKnownOptionArgs(restArgs, ['--id', '--state'])

    if (knownOptionArgs !== restArgs.length) {
      throw new CliError(`Unknown arguments for update: ${restArgs.join(' ')}`)
    }

    if (!isRoadmapState(state)) {
      throw new CliError(`Invalid state "${state}". Allowed states: planned, in_progress, blocked, deferred, done`)
    }

    return { kind: 'update', id, state }
  }

  throw new CliError('Usage: roadmap <update --id <id> --state <state> | sync | check>')
}

export function collectCheckIssues(roadmapMarkdown: string, currentStateMarkdown: string): CheckIssue[] {
  const roadmapParseResult = parseRoadmapMarkdown(roadmapMarkdown)
  const roadmapIssues = roadmapParseResult.issues.map(toCheckIssue('roadmap'))
  const currentStateMarkerIssues = validateCurrentStateMarkers(currentStateMarkdown).map(toCheckIssue('currentState'))
  const issues = [...roadmapIssues, ...currentStateMarkerIssues]

  if (roadmapIssues.length === 0 && currentStateMarkerIssues.length === 0) {
    const roadmapItems = getValidRoadmapItems(roadmapMarkdown)
    const generatedBlock = generateRoadmapCurrentStateBlock(roadmapItems)
    const syncResult = replaceGeneratedCurrentStateBlock(currentStateMarkdown, generatedBlock)

    if (syncResult.markdown !== currentStateMarkdown) {
      issues.push({
        source: 'currentState',
        code: 'generated_block_mismatch',
        message: 'docs/PROJECT_CURRENT_STATE.md generated block is not synced with tasks/roadmap.md',
      })
    }
  }

  return issues
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const command = parseCommandArgs(argv.slice(2))
  const repoPaths = resolveRepoPaths()
  assertRepoFilesExist(repoPaths)

  if (command.kind === 'update') {
    runUpdate(repoPaths, command.id, command.state)
    return
  }

  if (command.kind === 'sync') {
    runSync(repoPaths)
    return
  }

  runCheck(repoPaths)
}

function runUpdate(repoPaths: RepoPaths, id: string, state: RoadmapState): void {
  const roadmapBefore = readUtf8(repoPaths.roadmapPath)
  const currentStateBefore = readUtf8(repoPaths.currentStatePath)
  const roadmapUpdate = updateRoadmapState(roadmapBefore, id, state)
  const roadmapItems = getValidRoadmapItems(roadmapUpdate.markdown)
  const generatedBlock = generateRoadmapCurrentStateBlock(roadmapItems)
  const currentStateSync = replaceGeneratedCurrentStateBlock(currentStateBefore, generatedBlock)

  const roadmapWritten = writeIfChanged(repoPaths.roadmapPath, roadmapBefore, roadmapUpdate.markdown)
  const currentStateWritten = writeIfChanged(repoPaths.currentStatePath, currentStateBefore, currentStateSync.markdown)

  console.log(
    [
      `Updated roadmap item "${id}" to state "${state}".`,
      `roadmap.md: ${roadmapWritten ? 'updated' : 'unchanged'}`,
      `PROJECT_CURRENT_STATE.md: ${currentStateWritten ? 'updated' : 'unchanged'}`,
    ].join('\n'),
  )
}

function runSync(repoPaths: RepoPaths): void {
  const roadmapMarkdown = readUtf8(repoPaths.roadmapPath)
  const currentStateBefore = readUtf8(repoPaths.currentStatePath)
  const roadmapItems = getValidRoadmapItems(roadmapMarkdown)
  const generatedBlock = generateRoadmapCurrentStateBlock(roadmapItems)
  const currentStateSync = replaceGeneratedCurrentStateBlock(currentStateBefore, generatedBlock)
  const currentStateWritten = writeIfChanged(repoPaths.currentStatePath, currentStateBefore, currentStateSync.markdown)

  console.log(`Synced PROJECT_CURRENT_STATE.md: ${currentStateWritten ? 'updated' : 'unchanged'}`)
}

function runCheck(repoPaths: RepoPaths): void {
  const roadmapMarkdown = readUtf8(repoPaths.roadmapPath)
  const currentStateMarkdown = readUtf8(repoPaths.currentStatePath)
  const issues = collectCheckIssues(roadmapMarkdown, currentStateMarkdown)

  if (issues.length > 0) {
    throw new CliError(`Roadmap check failed:\n${formatCheckIssues(issues)}`)
  }

  const itemCount = parseRoadmapMarkdown(roadmapMarkdown).items.length
  console.log(`OK: ${itemCount} roadmap items, PROJECT_CURRENT_STATE.md is synced`)
}

function resolveRepoPaths(): RepoPaths {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, '../../../..')

  return {
    repoRoot,
    roadmapPath: path.join(repoRoot, 'tasks', 'roadmap.md'),
    currentStatePath: path.join(repoRoot, 'docs', 'PROJECT_CURRENT_STATE.md'),
  }
}

function assertRepoFilesExist(repoPaths: RepoPaths): void {
  const missingPaths = [repoPaths.roadmapPath, repoPaths.currentStatePath].filter((filePath) => !existsSync(filePath))

  if (missingPaths.length > 0) {
    throw new CliError(
      `Could not resolve repository root from ${repoPaths.repoRoot}. Missing files:\n${missingPaths.join('\n')}`,
    )
  }
}

function readUtf8(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

function writeIfChanged(filePath: string, before: string, after: string): boolean {
  if (before === after) {
    return false
  }

  writeFileSync(filePath, after, 'utf8')
  return true
}

function assertNoExtraArgs(command: string, args: readonly string[]): void {
  if (args.length > 0) {
    throw new CliError(`Unknown arguments for ${command}: ${args.join(' ')}`)
  }
}

function readRequiredOption(args: readonly string[], optionName: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === optionName) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new CliError(`Missing value for ${optionName}`)
      }
      return value
    }

    if (arg.startsWith(`${optionName}=`)) {
      const value = arg.slice(optionName.length + 1)
      if (!value) {
        throw new CliError(`Missing value for ${optionName}`)
      }
      return value
    }
  }

  throw new CliError(`Missing required option ${optionName}`)
}

function countKnownOptionArgs(args: readonly string[], optionNames: readonly string[]): number {
  let count = 0

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const matchingOption = optionNames.find((optionName) => arg === optionName || arg.startsWith(`${optionName}=`))

    if (!matchingOption) {
      continue
    }

    count += 1
    if (arg === matchingOption) {
      count += 1
      index += 1
    }
  }

  return count
}

function toCheckIssue(source: CheckIssue['source']): (issue: RoadmapIssue | { code: string; message: string; line?: number }) => CheckIssue {
  return (issue) => ({
    source,
    code: issue.code,
    message: issue.message,
    line: issue.line,
  })
}

function formatCheckIssues(issues: readonly CheckIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.line === undefined ? '' : ` line ${issue.line}`
      return `- ${issue.source}:${issue.code}${location} ${issue.message}`
    })
    .join('\n')
}

const currentFilePath = fileURLToPath(import.meta.url)
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : null

if (invokedFilePath === currentFilePath) {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message)
    } else {
      console.error(String(error))
    }
    process.exitCode = 1
  })
}
