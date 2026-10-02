import { EventEmitter } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, Task } from '@ai-team/shared'
import { generateApprovalExplanation, type ApprovalAiContext } from '../approvalExplain/approvalAi'
import {
  CHEAP_AI_ATTEMPT_TIMEOUT_MS,
  CHEAP_AI_CONFIG,
  CHEAP_AI_KILL_GRACE_MS,
  CHEAP_AI_RETRYING_MAX_WAIT_MS,
  CHEAP_AI_RETRY_BACKOFF_MS,
  CHEAP_AI_SINGLE_ATTEMPT_MAX_WAIT_MS,
  CheapAiAttemptError,
  parseJsonObject,
  requestText,
  requestTextResult,
} from './cheapAiClient'

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

interface ControlledChild {
  pid: number
  /** 子プロセスの終了を模す（stdout / stderr を書いてから close を出す）。 */
  close: (code: number | null, signal: NodeJS.Signals | null, output?: { stdout?: string; stderr?: string }) => void
}

let nextPid = 40_000

/** 自分からは終了しない子。テストが `close` を呼ぶか、process.kill の spy が止める。 */
function arrangeControlledChild(): ControlledChild {
  const pid = nextPid++
  const stdoutStream = new PassThrough()
  const stderrStream = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams
  spawnMock.mockImplementationOnce(() => child)
  return {
    pid,
    close: (code, signal, output = {}) => {
      queueMicrotask(() => {
        if (output.stdout) stdoutStream.write(output.stdout)
        if (output.stderr) stderrStream.write(output.stderr)
        child.emit('close', code, signal)
      })
    },
  }
}

/**
 * process.kill を差し替える（テストが本物のプロセスグループへ signal を送らないため）。
 * `onSignal[pid]` があれば、`-pid` への signal でその子を反応させる。
 */
function spyOnProcessKill(onSignal: Record<number, (signal: NodeJS.Signals) => void> = {}) {
  return vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    const handler = onSignal[Math.abs(target)]
    if (handler && typeof signal === 'string') handler(signal as NodeJS.Signals)
    return true
  }) as typeof process.kill)
}

const TEXT_OK = `${JSON.stringify({ type: 'text', part: { text: 'recovered answer' } })}\n`

/** 隔離 dir の作成（実 I/O）を fake timer の前に済ませる。 */
async function primeIsolation(): Promise<void> {
  arrangeCliResult({ stdout: TEXT_OK })
  await requestText('prime', 'prime', { apiKey: 'test-key' }, 10)
  spawnMock.mockReset()
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
  vi.restoreAllMocks()
  vi.useRealTimers()
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
      detached: true,
      windowsHide: true,
    })
    // timeout は spawn に任せず自前で持つ（AIteamOS が止めた事実を区別するため）
    expect(options).not.toHaveProperty('timeout')
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

  it('converts a CLI timeout into the existing non-destructive caller result (no retry for explainers)', async () => {
    await primeIsolation()
    const child = arrangeControlledChild()
    const killSpy = spyOnProcessKill({ [child.pid]: (signal) => child.close(null, signal) })
    vi.useFakeTimers()
    try {
      const pending = generateApprovalExplanation(createApprovalContext(), { apiKey: 'test-key' })
      await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs)
      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'OpenCode CLI timed out after 60000ms',
      })
      await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs * 2)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    } finally {
      vi.useRealTimers()
    }
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

describe('OpenCode supervisor and bounded recovery (retryTransientOnce)', () => {
  const PL = { apiKey: 'test-key', retryTransientOnce: true } as const
  let warnings: string[]

  beforeEach(async () => {
    await primeIsolation()
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    vi.useFakeTimers()
  })

  /** 1回目を AIteamOS 自身の timeout で止める（SIGTERM に応じて終了する子）。 */
  function timingOutChild(): ControlledChild {
    return arrangeControlledChild()
  }

  it('timeout → fresh process で1回だけ再試行し、成功すれば結果を返す（同じ隔離 HOME）', async () => {
    const first = timingOutChild()
    const second = arrangeControlledChild()
    const killSpy = spyOnProcessKill({ [first.pid]: (signal) => first.close(null, signal) })

    const pending = requestText('system', 'user prompt', PL, 100)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs)
    expect(killSpy).toHaveBeenCalledWith(-first.pid, 'SIGTERM')
    expect(spawnMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    second.close(0, null, { stdout: TEXT_OK })

    await expect(pending).resolves.toBe('recovered answer')
    const [firstCall, secondCall] = spawnMock.mock.calls as unknown as Array<[string, string[], SpawnOptions]>
    expect(secondCall?.[2].cwd).toBe(firstCall?.[2].cwd)
    expect(secondCall?.[2].env?.HOME).toBe(firstCall?.[2].env?.HOME)
    expect(warnings).toEqual([
      '[cheapAi] attempt 1/2 failed (timeout); retrying once with a fresh OpenCode process',
      '[cheapAi] attempt 2/2 succeeded (attempt 1: timeout)',
    ])
  })

  it('2回とも timeout なら従来どおり失敗し、3回目は起動しない', async () => {
    const first = timingOutChild()
    const second = timingOutChild()
    spyOnProcessKill({
      [first.pid]: (signal) => first.close(null, signal),
      [second.pid]: (signal) => second.close(null, signal),
    })

    const pending = requestText('system', 'user', PL, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs + CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs)
    const error = await pending
    expect(error).toBeInstanceOf(CheapAiAttemptError)
    expect((error as Error).message).toBe('OpenCode CLI timed out after 60000ms (attempt 2/2; attempt 1: timeout)')

    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs * 5)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(warnings.at(-1)).toBe('[cheapAi] attempt 2/2 failed (timeout; attempt 1: timeout)')
  })

  it('SIGTERM を無視する子も猶予後に SIGKILL し、close を待たずに必ず settle する', async () => {
    const stubborn = arrangeControlledChild()
    const killSpy = spyOnProcessKill()

    const pending = requestText('system', 'user', { apiKey: 'test-key' }, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs)
    expect(killSpy).toHaveBeenLastCalledWith(-stubborn.pid, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(CHEAP_AI_KILL_GRACE_MS)
    expect(killSpy).toHaveBeenLastCalledWith(-stubborn.pid, 'SIGKILL')
    expect((await pending as Error).message).toBe('OpenCode CLI timed out after 60000ms')
  })

  it('先頭の子が SIGTERM で終わっても、再試行の前にグループの残り（孫）を SIGKILL で掃く', async () => {
    const first = timingOutChild()
    const second = arrangeControlledChild()
    const killSpy = spyOnProcessKill({
      [first.pid]: (signal) => { if (signal === 'SIGTERM') first.close(null, signal) },
    })

    const pending = requestText('system', 'user', PL, 100)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs)
    expect(killSpy.mock.calls.filter(([target]) => target === -first.pid).map(([, signal]) => signal))
      .toEqual(['SIGTERM', 'SIGKILL'])
    expect(spawnMock).toHaveBeenCalledTimes(1)   // 掃いてから backoff、その後に2回目

    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
    second.close(0, null, { stdout: TEXT_OK })
    await expect(pending).resolves.toBe('recovered answer')
  })

  it('外部からの異常終了でも、再試行の前にグループの残りを SIGKILL で掃く', async () => {
    const first = arrangeControlledChild()
    const second = arrangeControlledChild()
    const killSpy = spyOnProcessKill()

    const pending = requestText('system', 'user', PL, 100)
    await vi.advanceTimersByTimeAsync(0)
    first.close(null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(killSpy).toHaveBeenCalledWith(-first.pid, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
    second.close(0, null, { stdout: TEXT_OK })
    await expect(pending).resolves.toBe('recovered answer')
  })

  it('意図的な停止（SIGTERM）ではグループへ signal を送らない（shutdown は systemd に任せる）', async () => {
    const only = arrangeControlledChild()
    const killSpy = spyOnProcessKill()

    const pending = requestText('system', 'user', PL, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    only.close(null, 'SIGTERM')
    await pending
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('AIteamOS が止めた子が exit 0 で終わっても timeout として扱う（正常終了にしない）', async () => {
    const child = arrangeControlledChild()
    spyOnProcessKill({ [child.pid]: () => child.close(0, null, { stdout: TEXT_OK }) })

    const pending = requestText('system', 'user', { apiKey: 'test-key' }, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs)
    expect((await pending as Error).message).toBe('OpenCode CLI timed out after 60000ms')
  })

  it.each(['SIGKILL', 'SIGSEGV'] as const)('外部からの異常終了（%s）は timeout と区別し、1回だけ再試行する', async (signal) => {
    const first = arrangeControlledChild()
    const second = arrangeControlledChild()
    spyOnProcessKill()

    const pending = requestText('system', 'user', PL, 100)
    await vi.advanceTimersByTimeAsync(0)
    first.close(null, signal)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    second.close(0, null, { stdout: TEXT_OK })

    await expect(pending).resolves.toBe('recovered answer')
    expect(warnings[0]).toBe('[cheapAi] attempt 1/2 failed (abnormal_termination); retrying once with a fresh OpenCode process')
  })

  it('異常終了が2回続けば abnormal の文言で失敗し、timeout とは書かない', async () => {
    const first = arrangeControlledChild()
    const second = arrangeControlledChild()
    spyOnProcessKill()

    const pending = requestText('system', 'user', PL, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    first.close(null, 'SIGSEGV')
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
    second.close(null, 'SIGSEGV')

    expect((await pending as Error).message).toBe(
      'OpenCode CLI terminated abnormally by signal SIGSEGV (attempt 2/2; attempt 1: abnormal_termination)',
    )
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    '意図的な停止（%s。service shutdown と整合）では再試行せず、新しい OpenCode を起動しない',
    async (signal) => {
      const only = arrangeControlledChild()
      spyOnProcessKill()

      const pending = requestText('system', 'user', PL, 100).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      only.close(null, signal)

      expect((await pending as Error).message).toBe(`OpenCode CLI was terminated by signal ${signal}`)
      await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs * 3)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(warnings).toEqual([])
    },
  )

  it.each([
    ['exit code != 0（auth / quota / invalid model 等）', { code: 1, stderr: 'Error: invalid model / 401 / quota' }, 'OpenCode CLI failed with exit code 1'],
    ['exit 0 でも stderr あり', { code: 0, stderr: 'warning: something' }, 'OpenCode CLI wrote to stderr'],
    ['malformed output', { code: 0, stdout: 'not-json\n' }, 'OpenCode CLI response contained invalid JSON'],
    ['text の無い出力', { code: 0, stdout: `${JSON.stringify({ type: 'step_start', part: {} })}\n` }, 'OpenCode CLI response did not contain text'],
  ] as const)('%s は再試行しない', async (_label, result, expected) => {
    const only = arrangeControlledChild()
    spyOnProcessKill()

    const pending = requestText('system', 'user', PL, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    only.close(result.code, null, result)

    expect((await pending as Error).message).toContain(expected)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs * 3)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('CLI 起動失敗は再試行しない', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    }) as unknown as ChildProcessWithoutNullStreams
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn opencode.exe ENOENT')))
      return child
    })

    const pending = requestText('system', 'user', PL, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect((await pending as Error).message).toBe('OpenCode CLI failed to start: spawn opencode.exe ENOENT')
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs * 3)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('key 未設定は OpenCode を起動せず、再試行もしない', async () => {
    const previous = process.env.OPENCODE_GO_API_KEY
    delete process.env.OPENCODE_GO_API_KEY
    try {
      await expect(requestText('system', 'user', { retryTransientOnce: true }, 100)).rejects.toThrow(
        'OPENCODE_GO_API_KEY is not configured',
      )
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      if (previous !== undefined) process.env.OPENCODE_GO_API_KEY = previous
    }
  })

  it('retryTransientOnce を指定しない caller（説明系）は timeout でも再試行しない', async () => {
    const only = timingOutChild()
    spyOnProcessKill({ [only.pid]: (signal) => only.close(null, signal) })

    const pending = requestText('system', 'user', { apiKey: 'test-key' }, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_CONFIG.timeoutMs + CHEAP_AI_RETRY_BACKOFF_MS + CHEAP_AI_CONFIG.timeoutMs)
    expect((await pending as Error).message).toBe('OpenCode CLI timed out after 60000ms')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(warnings).toEqual([])
  })

  it('SIGTERM を無視する子でも、説明経路は単一試行の上限ちょうどで settle する', async () => {
    arrangeControlledChild()
    spyOnProcessKill()

    let settled = false
    const pending = requestText('system', 'user', { apiKey: 'test-key' }, 100)
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CHEAP_AI_SINGLE_ATTEMPT_MAX_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    await pending
  })

  it('SIGTERM を無視する子が2回続いても、PL 推論は再試行込みの上限ちょうどで settle する', async () => {
    arrangeControlledChild()
    arrangeControlledChild()
    spyOnProcessKill()

    let settled = false
    const pending = requestText('system', 'user', PL, 100)
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRYING_MAX_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect((await pending as Error).message).toBe('OpenCode CLI timed out after 60000ms (attempt 2/2; attempt 1: timeout)')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('requestTextResult は timeout を throw せず reason: timeout の構造化結果で返す', async () => {
    const only = arrangeControlledChild()
    spyOnProcessKill({ [only.pid]: (signal) => only.close(null, signal) })

    const pending = requestTextResult('system', 'user', { apiKey: 'test-key' }, 100)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_ATTEMPT_TIMEOUT_MS)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      message: 'OpenCode CLI timed out after 60000ms',
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('requestTextResult は再試行後の timeout も reason: timeout で返す', async () => {
    const first = arrangeControlledChild()
    const second = arrangeControlledChild()
    spyOnProcessKill({
      [first.pid]: (signal) => first.close(null, signal),
      [second.pid]: (signal) => second.close(null, signal),
    })

    const pending = requestTextResult('system', 'user', PL, 100)
    await vi.advanceTimersByTimeAsync(CHEAP_AI_ATTEMPT_TIMEOUT_MS * 2 + CHEAP_AI_RETRY_BACKOFF_MS)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      message: 'OpenCode CLI timed out after 60000ms (attempt 2/2; attempt 1: timeout)',
    })
  })

  it('requestTextResult は timeout 以外の失敗を timeout と取り違えない', async () => {
    const only = arrangeControlledChild()
    spyOnProcessKill()

    const pending = requestTextResult('system', 'user', PL, 100)
    await vi.advanceTimersByTimeAsync(0)
    only.close(1, null, { stderr: 'quota exceeded' })
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'non_retryable',
      message: 'OpenCode CLI failed with exit code 1: quota exceeded',
    })
  })

  it('requestTextResult は key 未設定（CheapAiAttemptError 以外）を non_retryable で返し、起動しない', async () => {
    const previous = process.env.OPENCODE_GO_API_KEY
    delete process.env.OPENCODE_GO_API_KEY
    try {
      await expect(requestTextResult('system', 'user', { retryTransientOnce: true }, 100)).resolves.toEqual({
        ok: false,
        reason: 'non_retryable',
        message: 'OPENCODE_GO_API_KEY is not configured',
      })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      if (previous !== undefined) process.env.OPENCODE_GO_API_KEY = previous
    }
  })

  it('requestTextResult は成功時に text を返す', async () => {
    const only = arrangeControlledChild()
    spyOnProcessKill()

    const pending = requestTextResult('system', 'user', { apiKey: 'test-key' }, 100)
    await vi.advanceTimersByTimeAsync(0)
    only.close(0, null, { stdout: TEXT_OK })
    await expect(pending).resolves.toEqual({ ok: true, text: 'recovered answer' })
  })

  it('再試行の記録には prompt・key・provider stderr を載せない（試行番号と種類だけ）', async () => {
    const first = arrangeControlledChild()
    const second = arrangeControlledChild()
    spyOnProcessKill()

    const pending = requestText('SYSTEM-SECRET-PROMPT', 'USER-SECRET-PROMPT', PL, 100).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    first.close(null, 'SIGKILL', { stderr: 'crash dump test-key STDERR-SECRET' })
    await vi.advanceTimersByTimeAsync(CHEAP_AI_RETRY_BACKOFF_MS)
    second.close(2, null, { stderr: 'auth failed for test-key' })

    const error = (await pending) as Error
    expect(error.message).toBe(
      'OpenCode CLI failed with exit code 2: auth failed for [REDACTED] (attempt 2/2; attempt 1: abnormal_termination)',
    )
    const logged = warnings.join('\n')
    for (const secret of ['test-key', 'SECRET-PROMPT', 'STDERR-SECRET', 'crash dump']) {
      expect(logged).not.toContain(secret)
    }
  })
})
