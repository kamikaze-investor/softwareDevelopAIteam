import { EventEmitter } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, Task } from '@ai-team/shared'
import { generateApprovalExplanation, type ApprovalAiContext } from '../approvalExplain/approvalAi'
import { parseJsonObject, requestText } from './cheapAiClient'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

interface MockCliResult {
  stdout?: string
  stderr?: string
  code?: number | null
  signal?: NodeJS.Signals | null
}

function arrangeCliResult({
  stdout = '',
  stderr = '',
  code = 0,
  signal = null,
}: MockCliResult): void {
  spawnMock.mockImplementationOnce(() => {
    const stdoutStream = new PassThrough()
    const stderrStream = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: stdoutStream,
      stderr: stderrStream,
    }) as unknown as ChildProcessWithoutNullStreams

    queueMicrotask(() => {
      stdoutStream.write(stdout)
      stderrStream.write(stderr)
      child.emit('close', code, signal)
    })
    return child
  })
}

function getSpawnCall(): [string, string[], SpawnOptions] {
  const call = spawnMock.mock.calls[0]
  if (!call) throw new Error('Expected OpenCode CLI to be spawned')
  return call as [string, string[], SpawnOptions]
}

function createApprovalContext(): ApprovalAiContext {
  const task: Task = {
    id: 'task-cheap-ai-timeout',
    projectId: 'project-1',
    title: 'Explain an approval',
    description: 'Confirm timeout handling',
    status: 'review',
    assignee: 'developer_ai',
    dependencies: [],
    acceptanceCriteria: [],
    roadmapActive: false,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  }
  const approvalRequest: ApprovalRequest = {
    id: 'approval-cheap-ai-timeout',
    taskId: task.id,
    targetBranch: 'ai/task-cheap-ai-timeout',
    targetCommit: 'a'.repeat(40),
    targetDiffHash: 'b'.repeat(64),
    riskLevel: 'LOW',
    requestedAction: 'git_commit',
    changedFiles: [],
    triggeredRules: [],
    status: 'WAITING_FOR_USER',
    expiresAt: '2026-08-12T01:00:00.000Z',
    invalidIf: [],
    createdAt: '2026-08-12T00:00:00.000Z',
  }
  return { task, approvalRequest, reviewResults: [], qaResults: [] }
}

beforeEach(() => {
  spawnMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseJsonObject', () => {
  it('parses JSON from a fenced response', () => {
    expect(parseJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('rejects a response without a JSON object', () => {
    expect(() => parseJsonObject('plain text')).toThrow(
      'AI response did not contain a JSON object',
    )
  })
})

describe('OpenCode Go CLI client', () => {
  it('extracts and joins text events from the fixed model NDJSON stream', async () => {
    arrangeCliResult({
      stdout: [
        JSON.stringify({ type: 'step_start', part: {} }),
        JSON.stringify({ type: 'text', part: { text: ' generated ' } }),
        JSON.stringify({ type: 'text', part: { text: 'text ' } }),
        '',
      ].join('\n'),
    })

    await expect(
      requestText('system prompt', 'user prompt', { apiKey: 'test-key' }, 321),
    ).resolves.toBe('generated text')

    const [command, args, options] = getSpawnCall()
    expect(command.replaceAll('\\', '/')).toMatch(
      /node_modules\/opencode-ai\/bin\/opencode\.exe$/,
    )
    expect(args.slice(0, 7)).toEqual([
      'run',
      '-m',
      'opencode-go/mimo-v2.5',
      '--format',
      'json',
      '--dir',
      options.cwd,
    ])
    expect(args.at(-1)).toContain('Role: cheap_explainer')
    expect(args.at(-1)).toContain('System instructions:\nsystem prompt')
    expect(args.at(-1)).toContain('Keep the response within 321 tokens.')
    expect(args.at(-1)).toContain('User content:\nuser prompt')
    expect(args.join(' ')).not.toContain('test-key')
    expect(options).toMatchObject({
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    })
  })

  it('throws on a non-zero CLI exit without exposing the API key', async () => {
    arrangeCliResult({ code: 2, stderr: 'provider failed for test-key' })

    const error = await requestText(
      'system',
      'user',
      { apiKey: 'test-key' },
      100,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'OpenCode CLI failed with exit code 2: provider failed for [REDACTED]',
    )
    expect((error as Error).message).not.toContain('test-key')
  })

  it('converts a CLI timeout into the existing non-destructive caller result', async () => {
    arrangeCliResult({ code: null, signal: 'SIGTERM' })

    await expect(
      generateApprovalExplanation(createApprovalContext(), { apiKey: 'test-key' }),
    ).resolves.toEqual({
      ok: false,
      error: 'OpenCode CLI timed out after 60000ms',
    })
  })

  it('passes only allowlisted environment variables to the subprocess', async () => {
    const previous = {
      API_TOKEN: process.env.API_TOKEN,
      DB_PATH: process.env.DB_PATH,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
    }
    process.env.API_TOKEN = 'api-secret'
    process.env.DB_PATH = 'db-secret'
    process.env.GITHUB_TOKEN = 'github-secret'
    process.env.OPENAI_API_KEY = 'openai-secret'
    process.env.OPENCODE_GO_API_KEY = 'go-secret'
    arrangeCliResult({
      stdout: `${JSON.stringify({ type: 'text', part: { text: 'ok' } })}\n`,
    })

    try {
      await requestText('system', 'user', { apiKey: 'option-key' }, 100)
      const [, , options] = getSpawnCall()
      expect(options.env).toEqual({
        PATH: process.env.PATH ?? process.env.Path ?? '',
        HOME: expect.any(String),
        USERPROFILE: expect.any(String),
        LANG: process.env.LANG ?? 'C.UTF-8',
        OPENCODE_API_KEY: 'option-key',
      })
      expect(options.env).not.toHaveProperty('API_TOKEN')
      expect(options.env).not.toHaveProperty('DB_PATH')
      expect(options.env).not.toHaveProperty('GITHUB_TOKEN')
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY')
      expect(options.env).not.toHaveProperty('OPENCODE_GO_API_KEY')
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('uses isolated HOME and work directories containing only permission-deny config', async () => {
    arrangeCliResult({
      stdout: `${JSON.stringify({ type: 'text', part: { text: 'ok' } })}\n`,
    })

    await requestText('system', 'user', { apiKey: 'test-key' }, 100)

    const [, args, options] = getSpawnCall()
    const directoryFlagIndex = args.indexOf('--dir')
    const workingDirectory = args[directoryFlagIndex + 1]
    const homeDirectory = options.env?.HOME
    expect(typeof workingDirectory).toBe('string')
    expect(typeof homeDirectory).toBe('string')
    if (workingDirectory === undefined || homeDirectory === undefined) return

    expect(options.cwd).toBe(workingDirectory)
    expect(relative(process.cwd(), workingDirectory).startsWith('..')).toBe(true)
    expect(homeDirectory).not.toBe(workingDirectory)
    expect(dirname(homeDirectory)).toBe(dirname(workingDirectory))
    expect(await readdir(workingDirectory)).toEqual(['opencode.json'])
    await expect(readFile(join(workingDirectory, 'opencode.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: 'deny',
      }, null, 2)}\n`,
    )
  })

  it('leaves invalid non-JSON text for the existing parser to reject', async () => {
    arrangeCliResult({
      stdout: `${JSON.stringify({ type: 'text', part: { text: 'not json' } })}\n`,
    })

    const raw = await requestText('system', 'user', { apiKey: 'test-key' }, 100)
    expect(() => parseJsonObject(raw)).toThrow(
      'AI response did not contain a JSON object',
    )
  })

  it('returns mockResponse without spawning a subprocess', async () => {
    await expect(
      requestText('system', 'user', { mockResponse: ' mocked ' }, 100),
    ).resolves.toBe(' mocked ')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects when no API key or mock response is configured', async () => {
    const previous = process.env.OPENCODE_GO_API_KEY
    delete process.env.OPENCODE_GO_API_KEY
    try {
      await expect(requestText('system', 'user', {}, 100)).rejects.toThrow(
        'OPENCODE_GO_API_KEY is not configured',
      )
    } finally {
      if (previous !== undefined) process.env.OPENCODE_GO_API_KEY = previous
    }
  })
})
