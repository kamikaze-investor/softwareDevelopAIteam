import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHEAP_AI_CONFIG = {
  role: 'cheap_explainer',
  provider: 'opencode-go',
  model: 'mimo-v2.5',
  timeoutMs: 60_000,
} as const

// Previous raw transport endpoint, retained only as a rollback reference:
// https://opencode.ai/zen/go/v1/chat/completions
const OPENCODE_PROJECT_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: 'deny',
} as const

interface CheapAiIsolation {
  homeDirectory: string
  workingDirectory: string
}

interface OpenCodeTextEvent {
  type?: unknown
  part?: {
    text?: unknown
  }
}

let isolationPromise: Promise<CheapAiIsolation> | undefined

export interface CheapAiRequestOptions {
  apiKey?: string
  mockResponse?: string
}

export function parseJsonObject(raw: string): unknown {
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!jsonMatch) {
    throw new Error('AI response did not contain a JSON object')
  }
  return JSON.parse(jsonMatch[1] ?? jsonMatch[0])
}

async function createIsolation(): Promise<CheapAiIsolation> {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'ai-team-cheap-ai-'))
  const homeDirectory = join(baseDirectory, 'home')
  const workingDirectory = join(baseDirectory, 'work')

  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700 }),
    mkdir(workingDirectory, { mode: 0o700 }),
  ])
  await Promise.all([
    chmod(baseDirectory, 0o700),
    chmod(homeDirectory, 0o700),
    chmod(workingDirectory, 0o700),
  ])
  await writeFile(
    join(workingDirectory, 'opencode.json'),
    `${JSON.stringify(OPENCODE_PROJECT_CONFIG, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )

  return { homeDirectory, workingDirectory }
}

function getIsolation(): Promise<CheapAiIsolation> {
  isolationPromise ??= createIsolation()
  return isolationPromise
}

function resolveOpenCodeCliEntrypoint(): string {
  const relativeEntrypoint = join('node_modules', 'opencode-ai', 'bin', 'opencode.exe')
  const candidates = [
    resolve(__dirname, '..', '..', relativeEntrypoint),
    resolve(__dirname, '..', '..', '..', relativeEntrypoint),
    resolve(__dirname, '..', '..', '..', '..', relativeEntrypoint),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function buildPrompt(system: string, userContent: string, maxTokens: number): string {
  return [
    `Role: ${CHEAP_AI_CONFIG.role}`,
    'System instructions:',
    system,
    '',
    `Keep the response within ${maxTokens} tokens.`,
    '',
    'User content:',
    userContent,
  ].join('\n')
}

function buildSubprocessEnv(homeDirectory: string, apiKey: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    LANG: process.env.LANG ?? 'C.UTF-8',
    OPENCODE_API_KEY: apiKey,
  }
}

function redactApiKey(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, '[REDACTED]')
}

function parseOpenCodeOutput(stdout: string): string {
  const textParts: string[] = []

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue

    let event: OpenCodeTextEvent
    try {
      event = JSON.parse(line) as OpenCodeTextEvent
    } catch {
      throw new Error('OpenCode CLI response contained invalid JSON')
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      textParts.push(event.part.text)
    }
  }

  const text = textParts.join('').trim()
  if (text.length === 0) {
    throw new Error('OpenCode CLI response did not contain text')
  }
  return text
}

async function runOpenCodeCli(
  system: string,
  userContent: string,
  apiKey: string,
  maxTokens: number,
): Promise<string> {
  const isolation = await getIsolation()
  const cliEntrypoint = resolveOpenCodeCliEntrypoint()
  const model = `${CHEAP_AI_CONFIG.provider}/${CHEAP_AI_CONFIG.model}`
  const prompt = buildPrompt(system, userContent, maxTokens)
  const args = [
    'run',
    '-m',
    model,
    '--format',
    'json',
    '--dir',
    isolation.workingDirectory,
    prompt,
  ]

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(cliEntrypoint, args, {
      cwd: isolation.workingDirectory,
      env: buildSubprocessEnv(isolation.homeDirectory, apiKey),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHEAP_AI_CONFIG.timeoutMs,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error: Error) => {
      const detail = redactApiKey(error.message, apiKey)
      rejectPromise(new Error(`OpenCode CLI failed to start: ${detail}`))
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal !== null) {
        rejectPromise(new Error(`OpenCode CLI timed out after ${CHEAP_AI_CONFIG.timeoutMs}ms`))
        return
      }

      const sanitizedStderr = redactApiKey(stderr.trim(), apiKey)
      if (code !== 0) {
        const detail = sanitizedStderr.length > 0 ? `: ${sanitizedStderr}` : ''
        rejectPromise(new Error(`OpenCode CLI failed with exit code ${code ?? 'unknown'}${detail}`))
        return
      }
      if (sanitizedStderr.length > 0) {
        rejectPromise(new Error(`OpenCode CLI wrote to stderr: ${sanitizedStderr}`))
        return
      }

      try {
        resolvePromise(parseOpenCodeOutput(stdout))
      } catch (error: unknown) {
        rejectPromise(error)
      }
    })
  })
}

export async function requestText(
  system: string,
  userContent: string,
  options: CheapAiRequestOptions,
  maxTokens: number,
): Promise<string> {
  if (options.mockResponse !== undefined) {
    return options.mockResponse
  }

  const apiKey = options.apiKey ?? process.env.OPENCODE_GO_API_KEY
  if (!apiKey) {
    throw new Error('OPENCODE_GO_API_KEY is not configured')
  }

  return await runOpenCodeCli(system, userContent, apiKey, maxTokens)
}
