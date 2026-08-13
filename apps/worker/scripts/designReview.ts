import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { StrategicMetaReviewResult } from '@ai-team/shared'

export interface DesignReviewCliInput {
  taskId: string
  taskTitle: string
  changedFiles: string[]
  designText: string
  workingDir: string
}

interface ParsedDesignReviewArgs {
  taskId?: string
  taskTitle?: string
  changedFiles?: string[]
  designText?: string
  designFile?: string
  workingDir?: string
}

type EnvLike = Record<string, string | undefined>

export function parseDesignReviewArgs(argv: readonly string[]): ParsedDesignReviewArgs {
  const parsed: ParsedDesignReviewArgs = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]

    switch (flag) {
      case '--task-id':
        parsed.taskId = readOptionValue(flag, inlineValue, argv, ++index)
        break
      case '--task-title':
        parsed.taskTitle = readOptionValue(flag, inlineValue, argv, ++index)
        break
      case '--changed-files':
        parsed.changedFiles = parseChangedFiles(readOptionValue(flag, inlineValue, argv, ++index))
        break
      case '--changed-file':
        parsed.changedFiles = [
          ...(parsed.changedFiles ?? []),
          readOptionValue(flag, inlineValue, argv, ++index),
        ]
        break
      case '--design-text':
        parsed.designText = readOptionValue(flag, inlineValue, argv, ++index)
        break
      case '--design-file':
        parsed.designFile = readOptionValue(flag, inlineValue, argv, ++index)
        break
      case '--working-dir':
        parsed.workingDir = readOptionValue(flag, inlineValue, argv, ++index)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }

    if (inlineValue !== undefined) {
      index -= 1
    }
  }

  return parsed
}

export async function resolveDesignReviewInput(
  argv: readonly string[],
  env: EnvLike,
  stdinText?: string,
): Promise<DesignReviewCliInput> {
  const args = parseDesignReviewArgs(argv)
  const stdinInput = parseStdinInput(stdinText)
  const merged = {
    ...stdinInput,
    ...args,
  }

  const designText = await resolveDesignText(merged)
  const taskId = merged.taskId ?? env.TASK_ID ?? `design-review-${Date.now()}`
  const taskTitle = merged.taskTitle ?? env.TASK_TITLE ?? env.PR_TITLE ?? 'Manual Design Review'
  const changedFiles = merged.changedFiles
    ?? parseChangedFiles(env.CHANGED_FILES ?? env.TARGET_FILES ?? '')
  const workingDir = merged.workingDir ?? env.WORKING_DIR ?? process.cwd()

  if (designText.trim().length === 0) {
    throw new Error('Design text is required via JSON stdin, --design-text, or --design-file')
  }

  return {
    taskId,
    taskTitle,
    changedFiles,
    designText,
    workingDir,
  }
}

export function buildStrategicReviewInputFromDesign(input: DesignReviewCliInput): {
  taskId: string
  taskTitle: string
  changedFiles: string[]
  gitDiff: string
  workingDir: string
  materialKind: 'design'
} {
  return {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    changedFiles: input.changedFiles,
    gitDiff: input.designText,
    workingDir: input.workingDir,
    materialKind: 'design',
  }
}

export function exitCodeForStrategicResult(result: StrategicMetaReviewResult): number {
  switch (result.finalDecision) {
    case 'ALIGNED':
      return 0
    case 'CONFLICT':
      return 1
    case 'UNCERTAIN':
      return 2
    case 'REVIEW_UNAVAILABLE':
      return 3
  }
}

async function main(): Promise<void> {
  loadEnvFile()
  const stdinText = process.stdin.isTTY ? undefined : await readStdin()
  const input = await resolveDesignReviewInput(process.argv.slice(2), process.env, stdinText)
  const { runStrategicMetaReview } = await import('../src/metaReviewer/strategicReview.js')
  const result = await runStrategicMetaReview(buildStrategicReviewInputFromDesign(input))

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(exitCodeForStrategicResult(result))
}

function loadEnvFile(): void {
  const envPath = resolve(__dirname, '../../../.env')
  if (!existsSync(envPath)) {
    return
  }

  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^([^#=\s][^=]*)=(.*)$/)
    if (!match) {
      continue
    }

    const key = match[1].trim()
    if (key in process.env) {
      continue
    }

    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

function readOptionValue(
  flag: string,
  inlineValue: string | undefined,
  argv: readonly string[],
  nextIndex: number,
): string {
  if (inlineValue !== undefined) {
    return inlineValue
  }

  const value = argv[nextIndex]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }

  return value
}

function parseChangedFiles(value: string): string[] {
  return value
    .split(/[,\r\n]+/)
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
}

function parseStdinInput(stdinText: string | undefined): Partial<ParsedDesignReviewArgs> {
  if (!stdinText || stdinText.trim().length === 0) {
    return {}
  }

  const parsed = JSON.parse(stdinText) as unknown
  if (!isRecord(parsed)) {
    throw new Error('JSON stdin must be an object')
  }

  return {
    taskId: typeof parsed.taskId === 'string' ? parsed.taskId : undefined,
    taskTitle: typeof parsed.taskTitle === 'string' ? parsed.taskTitle : undefined,
    changedFiles: Array.isArray(parsed.changedFiles)
      ? parsed.changedFiles.filter((item): item is string => typeof item === 'string')
      : undefined,
    designText: typeof parsed.designText === 'string' ? parsed.designText : undefined,
    designFile: typeof parsed.designFile === 'string' ? parsed.designFile : undefined,
    workingDir: typeof parsed.workingDir === 'string' ? parsed.workingDir : undefined,
  }
}

async function resolveDesignText(input: ParsedDesignReviewArgs): Promise<string> {
  if (input.designText !== undefined) {
    return input.designText
  }

  if (input.designFile !== undefined) {
    return await readFile(input.designFile, 'utf-8')
  }

  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStdin(): Promise<string> {
  return new Promise((resolveText, reject) => {
    let text = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      text += chunk
    })
    process.stdin.on('end', () => resolveText(text))
    process.stdin.on('error', reject)
  })
}

if (require.main === module) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n`)
    process.exit(3)
  })
}
