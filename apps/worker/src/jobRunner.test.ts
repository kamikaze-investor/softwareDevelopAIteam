import { execFileSync } from 'node:child_process'
import type { Job } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCommand } from './commandResolver.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { saveJobLogs } from './jobLogger.js'
import { runJob } from './jobRunner.js'
import { callGateCheck, callConsume } from './guards/gateClient.js'
import { resolvePolicy } from './guards/gatePolicy.js'

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

vi.mock('./guards/gateClient.js', () => ({
  callGateCheck: vi.fn(),
  callConsume: vi.fn(),
  GateClientError: class GateClientError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'GateClientError'
    }
  },
}))

vi.mock('./guards/gatePolicy.js', () => ({
  resolvePolicy: vi.fn(),
  SAFE_WORK_ALLOWED_COMMAND_KINDS: ['git_status', 'git_diff', 'git_log', 'typecheck', 'test', 'lint'],
}))

// ────────────────────────────────────────────────────────────
// Mock references
// ────────────────────────────────────────────────────────────

const execFileSyncMock = vi.mocked(execFileSync)
const resolveCommandMock = vi.mocked(resolveCommand)
const fileChangeGuardMock = vi.mocked(fileChangeGuard)
const saveJobLogsMock = vi.mocked(saveJobLogs)
const callGateCheckMock = vi.mocked(callGateCheck)
const callConsumeMock = vi.mocked(callConsume)
const resolvePolicyMock = vi.mocked(resolvePolicy)

import { permissionGuardWithGrants } from './guards/permissionGuard.js'
const permissionGuardWithGrantsMock = vi.mocked(permissionGuardWithGrants)

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const ALLOW_PROCEED_RESPONSE = {
  outcome: { decision: 'ALLOW' as const, riskLevel: 'LOW' },
  riskReview: { riskLevel: 'LOW', triggeredRules: [], requiresIndependentReview: false },
  sideEffects: [] as Array<{ type: string; requestId: string }>,
  continuationPolicy: 'continue' as const,
  nextAction: { action: 'proceed' as const, message: 'proceed' },
}

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

// ────────────────────────────────────────────────────────────
// beforeEach: reset all mocks to safe defaults
// ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Gate mocks: default to ALLOW / continue
  callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
  resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

  // Permission guard: allowed by default
  permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })

  // Command resolver: default git status
  resolveCommandMock.mockReturnValue({
    argv: ['git', 'status', '--short'],
    description: 'git status',
  })

  // File change guard: allowed by default
  fileChangeGuardMock.mockReturnValue({
    allowed: true,
    violations: [],
    reasons: {},
  })

  // execFileSync: return '' for all git helper calls by default
  execFileSyncMock.mockReturnValue('')
})

// ────────────────────────────────────────────────────────────
// 既存テスト (7件): 挙動を維持
// ────────────────────────────────────────────────────────────

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
    // Gate check は permission block 時に呼ばれない
    expect(callGateCheckMock).not.toHaveBeenCalled()
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
    expect(callGateCheckMock).not.toHaveBeenCalled()
  })

  it('executes the resolved command with shell disabled and records changed files', async () => {
    // Route execFileSync return values by git subcommand
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === 'status') return 'M src/index.ts\n'
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/index.ts\n'
      return ''
    })

    const result = await runJob(createJob())

    // The main command must have been called with shell: false and timeout
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['status', '--short'], {
      cwd: '/workspace/target',
      shell: false,
      timeout: 120_000,
      encoding: 'utf-8',
    })
    // git diff --name-only HEAD (getChangedFiles post-execution) must have been called
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', '--name-only', 'HEAD'], {
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

    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === 'status') throw error
      return ''
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('partial output')
    expect(result.stderr).toBe('fatal error')
    expect(result.changedFiles).toEqual([])
    expect(saveJobLogsMock).toHaveBeenCalledWith('job-1', 'partial output', 'fatal error')
  })

  it('returns failed when File Change Guard rejects changed files', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '../secret.txt\n'
      return ''
    })
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
    // pre-gate calls (4) + beforeCommitHash + git commit + afterCommitHash + getChangedFiles
    execFileSyncMock
      .mockReturnValueOnce('')           // getChangedFiles pre-gate (git diff --name-only HEAD)
      .mockReturnValueOnce('')           // getPreGateDiffText (git diff HEAD)
      .mockReturnValueOnce('main\n')     // getTargetBranch (git rev-parse --abbrev-ref HEAD)
      .mockReturnValueOnce('')           // getCommitHash targetCommit (git rev-parse HEAD)
      .mockReturnValueOnce('abc123\n')   // beforeCommitHash (git rev-parse HEAD)
      .mockReturnValueOnce('')           // git commit stdout
      .mockReturnValueOnce('def456\n')   // afterCommitHash (git rev-parse HEAD)
      .mockReturnValueOnce('')           // getChangedFiles post-execution

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })

    await runJob(job)

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
      .mockReturnValueOnce('')           // getChangedFiles pre-gate
      .mockReturnValueOnce('')           // getPreGateDiffText
      .mockReturnValueOnce('main\n')     // getTargetBranch
      .mockReturnValueOnce('')           // getCommitHash targetCommit
      .mockReturnValueOnce('abc123\n')   // beforeCommitHash
      .mockReturnValueOnce('')           // git commit stdout
      .mockReturnValueOnce('def456\n')   // afterCommitHash
      .mockReturnValueOnce('')           // getChangedFiles post-execution

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })

    const result = await runJob(job)

    expect(result.rollbackInfo).toBeDefined()
    expect(result.rollbackInfo?.previousCommitHash).toBe('abc123')
    expect(result.rollbackInfo?.rollbackArgv).toContain('revert')
  })
})

// ────────────────────────────────────────────────────────────
// Gate check 統合テスト (Step 3A)
// ────────────────────────────────────────────────────────────

describe('runJob — Approval Gate integration (Step 3A)', () => {
  it('policy: continue → existing flow executes normally', async () => {
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(resolveCommandMock).toHaveBeenCalled()
    expect(result.gatePolicy).toBeUndefined()
  })

  it('policy: block_until_approved → blocked with gatePolicy and gateBlockReason', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('block_until_approved')
    expect(result.gateBlockReason).toBe('CRITICAL risk — CEO approval required')
    expect(resolveCommandMock).not.toHaveBeenCalled()
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      'git', ['status', '--short'], expect.anything()
    )
  })

  it('policy: re_check → blocked with gatePolicy=re_check', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 're_check',
      reason: 'Approval is stale. Re-run gate/check.',
      apiAvailable: true,
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('re_check')
    expect(result.gateBlockReason).toContain('stale')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('policy: continue_safe_work_only + git_commit → blocked', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'HIGH risk — safe work only',
      apiAvailable: true,
    })
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })
    const result = await runJob(job)

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('continue_safe_work_only')
    expect(result.gateBlockReason).toContain('git_commit')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('policy: continue_safe_work_only + git_revert → blocked', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'HIGH risk — safe work only',
      apiAvailable: true,
    })

    const job = createJob({
      safeCommand: { kind: 'git_revert', workingDir: '/workspace/target' },
    })
    const result = await runJob(job)

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('continue_safe_work_only')
    expect(result.gateBlockReason).toContain('git_revert')
  })

  it('policy: continue_safe_work_only + test → existing flow continues', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'HIGH risk — safe work only, but test is allowed',
      apiAvailable: true,
    })
    resolveCommandMock.mockReturnValue({
      argv: ['pnpm', 'test'],
      description: 'test',
    })

    const job = createJob({
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    })
    const result = await runJob(job)

    expect(result.status).toBe('success')
    expect(resolveCommandMock).toHaveBeenCalled()
    expect(result.gatePolicy).toBeUndefined()
  })

  it('callGateCheck throws → resolvePolicy called with apiError, not re-thrown', async () => {
    const networkErr = new Error('ECONNREFUSED')
    callGateCheckMock.mockRejectedValue(networkErr)
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'Gate API unavailable: ECONNREFUSED',
      apiAvailable: false,
    })

    const result = await runJob(createJob())

    // resolvePolicy must have been called with apiError
    expect(resolvePolicyMock).toHaveBeenCalledWith(
      expect.anything(),  // localGateResult
      undefined,          // checkResponse undefined (callGateCheck threw)
      networkErr,         // apiError
    )
    // Job should not throw — policy handles it
    expect(result.status).toBe('success') // continue_safe_work_only + git_status → allowed
  })

  it('nextAction: call_consume → callConsume is NOT called (deferred)', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume', consumedRequestId: 'req-001', message: 'consume it' },
    })
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    const result = await runJob(createJob())

    expect(callConsumeMock).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
  })

  it('permission guard blocked → Gate check is never called', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'outside TARGET_ROOT',
    })

    await runJob(createJob())

    expect(callGateCheckMock).not.toHaveBeenCalled()
    expect(resolvePolicyMock).not.toHaveBeenCalled()
  })

  it('blocked result has permissionAllowed=true to distinguish from permission block', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL',
      apiAvailable: true,
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.guardResult.permissionAllowed).toBe(true)
    expect(result.guardResult.fileChangeAllowed).toBe(true)
    expect(result.guardResult.fileViolations).toEqual([])
  })

  it('callGateCheck is called with correct params including taskId and requestedAction', async () => {
    const job = createJob({ taskId: 'task-xyz' })

    await runJob(job)

    expect(callGateCheckMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-xyz',
        requestedAction: 'git_status',
      })
    )
    // diffText は渡さない
    expect(callGateCheckMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ diffText: expect.anything() })
    )
  })
})
