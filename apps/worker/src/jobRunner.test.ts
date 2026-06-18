import { execFileSync } from 'node:child_process'
import type { Job } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCommand } from './commandResolver.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { saveJobLogs } from './jobLogger.js'
import { runJob } from './jobRunner.js'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('./commandResolver.js', () => ({
  resolveCommand: vi.fn(),
}))

vi.mock('./guards/permissionGuard.js', () => ({
  permissionGuard: vi.fn(),
  permissionGuardWithGrants: vi.fn(),
}))

vi.mock('./guards/fileChangeGuard.js', () => ({
  fileChangeGuard: vi.fn(),
}))

vi.mock('./jobLogger.js', () => ({
  saveJobLogs: vi.fn((jobId: string, stdout: string, stderr: string) => ({
    stdoutPath: `/logs/${jobId}/stdout.txt`,
    stderrPath: `/logs/${jobId}/stderr.txt`,
    stdoutPreview: stdout.slice(0, 1000),
    stderrPreview: stderr.slice(0, 1000),
  })),
}))

const execFileSyncMock = vi.mocked(execFileSync)
const resolveCommandMock = vi.mocked(resolveCommand)
const fileChangeGuardMock = vi.mocked(fileChangeGuard)
const saveJobLogsMock = vi.mocked(saveJobLogs)

// Import the mocked guard to configure it
import { permissionGuardWithGrants } from './guards/permissionGuard.js'
const permissionGuardWithGrantsMock = vi.mocked(permissionGuardWithGrants)

function createJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    taskId: 'task-1',
    projectId: 'project-1',
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: {
      kind: 'git_status',
      workingDir: '/workspace/target',
    },
    createdAt: '2026-06-05T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
  resolveCommandMock.mockReturnValue({
    argv: ['git', 'status', '--short'],
    description: 'git status',
  })
  fileChangeGuardMock.mockReturnValue({
    allowed: true,
    violations: [],
    reasons: {},
  })
})

describe('runJob', () => {
  it('returns blocked when Permission Guard rejects the job', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'workingDir is outside TARGET_ROOT',
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.guardResult).toEqual({
      permissionAllowed: false,
      permissionReason: 'workingDir is outside TARGET_ROOT',
      fileChangeAllowed: true,
      fileViolations: [],
    })
    expect(resolveCommandMock).not.toHaveBeenCalled()
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('returns blocked with permissionBlockEvent when grant is expired', async () => {
    const blockEvent = {
      type: 'grant_expired' as const,
      jobId: 'job-1',
      taskId: 'task-1',
      agentRole: 'developer_ai',
      commandKind: 'git_status',
      message: 'Grant expired',
      occurredAt: new Date().toISOString(),
    }
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'Grant expired',
      blockEvent,
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.permissionBlockEvent).toEqual(blockEvent)
  })

  it('executes the resolved command with shell disabled and records changed files', async () => {
    execFileSyncMock
      .mockReturnValueOnce('M src/index.ts\n')
      .mockReturnValueOnce('src/index.ts\n')

    const result = await runJob(createJob())

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['status', '--short'], {
      cwd: '/workspace/target',
      shell: false,
      timeout: 120_000,
      encoding: 'utf-8',
    })
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['diff', '--name-only', 'HEAD'], {
      cwd: '/workspace/target',
      encoding: 'utf-8',
      shell: false,
    })
    expect(fileChangeGuardMock).toHaveBeenCalledWith(['src/index.ts'])
    expect(result.status).toBe('success')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('M src/index.ts\n')
    expect(result.stdoutPath).toBe('/logs/job-1/stdout.txt')
    expect(result.stderrPath).toBe('/logs/job-1/stderr.txt')
    expect(result.changedFiles).toEqual(['src/index.ts'])
    expect(saveJobLogsMock).toHaveBeenCalledWith('job-1', 'M src/index.ts\n', '')
  })

  it('returns failed when the command exits with a non-zero status', async () => {
    const error = new Error('command failed') as Error & {
      status: number
      stdout: string
      stderr: string
    }
    error.status = 2
    error.stdout = 'partial output'
    error.stderr = 'fatal error'
    execFileSyncMock.mockImplementationOnce(() => {
      throw error
    })
    execFileSyncMock.mockReturnValueOnce('')

    const result = await runJob(createJob())

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('partial output')
    expect(result.stderr).toBe('fatal error')
    expect(result.changedFiles).toEqual([])
    expect(saveJobLogsMock).toHaveBeenCalledWith('job-1', 'partial output', 'fatal error')
  })

  it('returns failed when File Change Guard rejects changed files', async () => {
    execFileSyncMock
      .mockReturnValueOnce('')
      .mockReturnValueOnce('../secret.txt\n')
    fileChangeGuardMock.mockReturnValue({
      allowed: false,
      violations: ['../secret.txt'],
      reasons: { '../secret.txt': 'Path traversal or outside target' },
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('failed')
    expect(result.guardResult.fileChangeAllowed).toBe(false)
    expect(result.guardResult.fileViolations).toEqual(['../secret.txt'])
  })

  it('git_commit job uses timeout=undefined (atomic)', async () => {
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
    // git rev-parse HEAD (before), git commit, git rev-parse HEAD (after), git diff
    execFileSyncMock
      .mockReturnValueOnce('abc123\n')  // beforeCommitHash
      .mockReturnValueOnce('')           // git commit stdout
      .mockReturnValueOnce('def456\n')  // afterCommitHash
      .mockReturnValueOnce('')           // git diff --name-only

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })

    await runJob(job)

    // The commit command call should have timeout: undefined
    const commitCall = execFileSyncMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes('commit')
    )
    expect(commitCall).toBeDefined()
    expect((commitCall![2] as { timeout?: number }).timeout).toBeUndefined()
  })

  it('git_commit job generates RollbackInfo', async () => {
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
    execFileSyncMock
      .mockReturnValueOnce('abc123\n')  // beforeCommitHash
      .mockReturnValueOnce('')           // git commit stdout
      .mockReturnValueOnce('def456\n')  // afterCommitHash
      .mockReturnValueOnce('')           // git diff --name-only

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })

    const result = await runJob(job)

    expect(result.rollbackInfo).toBeDefined()
    expect(result.rollbackInfo?.previousCommitHash).toBe('abc123')
    expect(result.rollbackInfo?.rollbackArgv).toContain('revert')
  })
})
