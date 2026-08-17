import { execFileSync } from 'node:child_process'
import type { AiCliRequest } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('../guards/changeManifest.js', () => ({
  buildWorktreeManifest: vi.fn(() => ({ changes: [], paths: [] })),
}))

import { createAiCliAdapter } from './factory.js'

const execFileSyncMock = vi.mocked(execFileSync)

const request: AiCliRequest = {
  taskId: 'provider-timeout-test',
  provider: 'claude_code',
  workingDir: '/workspace/target',
  prompt: 'Implement the approved change.',
  contextFiles: [],
  mode: 'implement',
}

function executionError(input: {
  code: string
  status: number | null
  signal: string | null
  stderr: string
}): Error & typeof input & { stdout: string } {
  return Object.assign(new Error(input.stderr), input, { stdout: '' })
}

describe('Stage 1 provider timeout classification', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
  })

  it('classifies only ETIMEDOUT + null status + SIGTERM as provider_timeout', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw executionError({
        code: 'ETIMEDOUT',
        status: null,
        signal: 'SIGTERM',
        stderr: 'provider command timed out',
      })
    })

    const result = await createAiCliAdapter({ provider: 'claude_code' }).run(request)

    expect(result.providerFailureKind).toBe('provider_timeout')
  })

  it('does not classify stderr text containing ETIMEDOUT', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw executionError({
        code: 'EFAIL',
        status: null,
        signal: null,
        stderr: 'nested process reported ETIMEDOUT',
      })
    })

    const result = await createAiCliAdapter({ provider: 'claude_code' }).run(request)

    expect(result.providerFailureKind).toBeUndefined()
  })

  it('does not classify ENOBUFS even when signal is SIGTERM', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw executionError({
        code: 'ENOBUFS',
        status: null,
        signal: 'SIGTERM',
        stderr: 'stdout maxBuffer exceeded',
      })
    })

    const result = await createAiCliAdapter({ provider: 'claude_code' }).run(request)

    expect(result.providerFailureKind).toBeUndefined()
  })
})
