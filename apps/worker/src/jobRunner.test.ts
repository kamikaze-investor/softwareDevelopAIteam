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

vi.mock('./notifier/notifier.js', () => ({
  sendAlert: vi.fn().mockResolvedValue([]),
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

import { sendAlert } from './notifier/notifier.js'
const sendAlertMock = vi.mocked(sendAlert)

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

  // Notifier: always resolve silently by default
  sendAlertMock.mockResolvedValue([])

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
      .mockReturnValueOnce('')           // getChangedFiles (Target Project Risk Scan)
      .mockReturnValueOnce('')           // getPreGateDiffText (Target Project Risk Scan)
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

  it('continue policy → safe work check is not applied (all kinds allowed)', async () => {
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'commit', '-m', 'x'], description: 'git commit' })
    // git_commit under 'continue' policy should NOT be blocked
    execFileSyncMock
      .mockReturnValueOnce('')          // pre getChangedFiles
      .mockReturnValueOnce('')          // pre getPreGateDiffText
      .mockReturnValueOnce('main\n')    // getTargetBranch
      .mockReturnValueOnce('')          // getCommitHash (targetCommit)
      .mockReturnValueOnce('abc\n')     // beforeCommitHash
      .mockReturnValueOnce('')          // git commit
      .mockReturnValueOnce('def\n')     // afterCommitHash
      .mockReturnValueOnce('')          // post getChangedFiles

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
    })
    const result = await runJob(job)

    expect(result.status).toBe('success')
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

  it('nextAction: proceed → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
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

// ────────────────────────────────────────────────────────────
// safe_work_only 完全 CommandKind 制御 (Step 3C)
// ────────────────────────────────────────────────────────────

describe('runJob — safe_work_only CommandKind control (Step 3C)', () => {
  const SAFE_WORK_POLICY = {
    policy: 'continue_safe_work_only' as const,
    reason: 'HIGH risk',
    apiAvailable: true,
  }

  // 許可される CommandKind (table-driven)
  const ALLOWED_KINDS: Array<{ kind: string; argv: string[] }> = [
    { kind: 'git_status',  argv: ['git', 'status'] },
    { kind: 'git_diff',    argv: ['git', 'diff'] },
    { kind: 'git_log',     argv: ['git', 'log'] },
    { kind: 'typecheck',   argv: ['pnpm', 'typecheck'] },
    { kind: 'test',        argv: ['pnpm', 'test'] },
    { kind: 'lint',        argv: ['pnpm', 'lint'] },
  ]

  for (const { kind, argv } of ALLOWED_KINDS) {
    it(`continue_safe_work_only + ${kind} → existing flow continues`, async () => {
      resolvePolicyMock.mockReturnValue(SAFE_WORK_POLICY)
      resolveCommandMock.mockReturnValue({ argv, description: kind })

      const job = createJob()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(job.safeCommand as any).kind = kind
      const result = await runJob(job)

      expect(result.status).toBe('success')
      expect(resolveCommandMock).toHaveBeenCalled()
      expect(result.gatePolicy).toBeUndefined()
    })
  }

  // 禁止される CommandKind (table-driven)
  const BLOCKED_KINDS = [
    'git_commit',
    'git_revert',
    'build',
    'git_branch_create',
    'git_checkout',
  ] as const

  for (const kind of BLOCKED_KINDS) {
    it(`continue_safe_work_only + ${kind} → blocked`, async () => {
      resolvePolicyMock.mockReturnValue(SAFE_WORK_POLICY)

      const result = await runJob(createJob({ safeCommand: { kind, workingDir: '/workspace/target' } }))

      expect(result.status).toBe('blocked')
      expect(result.gatePolicy).toBe('continue_safe_work_only')
      expect(result.gateBlockReason).toContain(kind)
      expect(resolveCommandMock).not.toHaveBeenCalled()
    })
  }

  it('safe work violation → callConsume is NOT called', async () => {
    resolvePolicyMock.mockReturnValue(SAFE_WORK_POLICY)
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-x', message: 'consume' },
    })

    await runJob(createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
    }))

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('safe work allowed + nextAction: call_consume → callConsume IS called', async () => {
    resolvePolicyMock.mockReturnValue(SAFE_WORK_POLICY)
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-y', message: 'consume' },
    })
    callConsumeMock.mockResolvedValue({ ok: true })

    const result = await runJob(createJob({ safeCommand: { kind: 'test', workingDir: '/workspace/target' } }))

    expect(callConsumeMock).toHaveBeenCalledWith('req-y', expect.anything())
    expect(result.status).toBe('success')
  })
})

// ────────────────────────────────────────────────────────────
// callConsume 接続テスト (Step 3B)
// ────────────────────────────────────────────────────────────

describe('runJob — callConsume integration (Step 3B)', () => {
  const CONSUME_RESPONSE = {
    ...ALLOW_PROCEED_RESPONSE,
    outcome: { decision: 'ALLOW' as const, riskLevel: 'LOW', consumedRequestId: 'req-001' },
    nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-001', message: 'consume it' },
  }

  it('nextAction: call_consume + consumedRequestId → callConsume is called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob())

    expect(callConsumeMock).toHaveBeenCalledWith(
      'req-001',
      expect.objectContaining({ currentCommit: expect.any(String), currentDiffHash: expect.any(String) }),
    )
  })

  it('consume success → existing flow continues (status: success)', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockResolvedValue({ ok: true })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(result.gatePolicy).toBeUndefined()
  })

  it('alreadyConsumed: true → existing flow continues (status: success)', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockResolvedValue({ ok: true, alreadyConsumed: true })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(callConsumeMock).toHaveBeenCalled()
  })

  it('consume throws → status: blocked with gateBlockReason', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(new Error('HTTP 409 — Approval request is stale'))

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('block_until_approved')
    expect(result.gateBlockReason).toContain('consume failed')
    expect(result.gateBlockReason).toContain('409')
  })

  it('consume fails → resolveCommand is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(new Error('network error'))

    await runJob(createJob())

    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('nextAction: call_consume without consumedRequestId → blocked', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, message: 'missing id' },
    })
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.gateBlockReason).toContain('consumedRequestId is missing')
    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('policy: block_until_approved → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'block_until_approved', reason: 'CRITICAL', apiAvailable: true })

    await runJob(createJob())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('policy: re_check → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 're_check', reason: 'stale', apiAvailable: true })

    await runJob(createJob())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('nextAction: proceed → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('permission guard blocked → callConsume is NOT called', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: false, reason: 'outside TARGET_ROOT' })

    await runJob(createJob())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('consume uses same targetCommit and targetDiffHash as gate check', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob())

    // consume に渡す currentCommit / currentDiffHash は gate check 時と同一値
    const gateCheckParams = callGateCheckMock.mock.calls[0][0]
    // callConsume(requestId, { currentCommit, currentDiffHash }) → calls[0] = [requestId, params]
    const consumeParams = callConsumeMock.mock.calls[0][1] as { currentCommit: string; currentDiffHash: string }
    expect(consumeParams.currentCommit).toBe(gateCheckParams.targetCommit)
    expect(consumeParams.currentDiffHash).toBe(gateCheckParams.targetDiffHash)
  })
})

// ────────────────────────────────────────────────────────────
// Notifier / CEO 通知テスト (Step 3D)
// ────────────────────────────────────────────────────────────

describe('runJob — Notifier / CEO通知 integration (Step 3D)', () => {
  // approvalRequest fixture (最小フィールド)
  function makeApprovalRequest(id: string) {
    return {
      id,
      status: 'WAITING_FOR_USER' as const,
      taskId: 'task-1',
      targetBranch: 'feat/test',
      targetCommit: 'abc123',
      targetDiffHash: 'deadbeef',
      riskLevel: 'HIGH' as const,
      requestedAction: 'merge',
      expiresAt: '2026-12-31T00:00:00.000Z',
      createdAt: new Date().toISOString(),
      invalidIf: [],
    }
  }

  function makeBlockedResponse(approvalRequestId: string) {
    return {
      ...ALLOW_PROCEED_RESPONSE,
      approvalRequest: makeApprovalRequest(approvalRequestId),
      nextAction: {
        action: 'wait_for_approval' as const,
        requestId: approvalRequestId,
        message: '承認待ち',
      },
    }
  }

  // 1. block_until_approved → sendAlert が severity='critical' で呼ばれる
  it('block_until_approved → sendAlert が severity=critical で呼ばれる', async () => {
    callGateCheckMock.mockResolvedValue(makeBlockedResponse('req-3d-001'))
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk',
      apiAvailable: true,
    })

    await runJob(createJob())

    expect(sendAlertMock).toHaveBeenCalledOnce()
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical' }),
    )
  })

  // 2. block_until_approved の title に safeCommand.kind が含まれる
  it('block_until_approved の title に safeCommand.kind が含まれる', async () => {
    callGateCheckMock.mockResolvedValue(makeBlockedResponse('req-3d-002'))
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL',
      apiAvailable: true,
    })

    const job = createJob({ safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } } })
    await runJob(job)

    const payload = sendAlertMock.mock.calls[0][0]
    expect(payload.title).toContain('git_commit')
  })

  // 3. block_until_approved の body に taskId / job.id / approvalRequestId が含まれる
  it('block_until_approved の body に taskId / job.id / approvalRequestId が含まれる', async () => {
    callGateCheckMock.mockResolvedValue(makeBlockedResponse('req-3d-003'))
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL',
      apiAvailable: true,
    })

    const job = createJob({ taskId: 'task-notif-3d', id: 'job-notif-3d' })
    await runJob(job)

    const payload = sendAlertMock.mock.calls[0][0]
    expect(payload.body).toContain('task-notif-3d')
    expect(payload.body).toContain('job-notif-3d')
    expect(payload.body).toContain('req-3d-003')
  })

  // 4. 同一 approvalRequestId の block_until_approved は 2 回目通知されない（dedup）
  it('同一 approvalRequestId の block_until_approved は 2 回目通知されない', async () => {
    const DEDUP_ID = 'req-3d-dedup-001'
    callGateCheckMock.mockResolvedValue(makeBlockedResponse(DEDUP_ID))
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL',
      apiAvailable: true,
    })

    // 1 回目
    await runJob(createJob())
    expect(sendAlertMock).toHaveBeenCalledOnce()

    sendAlertMock.mockClear()

    // 2 回目 (同一 approvalRequestId)
    await runJob(createJob())
    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 5. re_check → sendAlert が severity='warning' で呼ばれる
  it('re_check → sendAlert が severity=warning で呼ばれる', async () => {
    callGateCheckMock.mockResolvedValue(makeBlockedResponse('req-3d-005'))
    resolvePolicyMock.mockReturnValue({
      policy: 're_check',
      reason: 'Approval is stale',
      apiAvailable: true,
    })

    await runJob(createJob())

    expect(sendAlertMock).toHaveBeenCalledOnce()
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning' }),
    )
  })

  // 6. consume failed → sendAlert が severity='critical' で呼ばれる
  it('consume failed → sendAlert が severity=critical で呼ばれる', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-3d-006', message: 'consume' },
    })
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(new Error('HTTP 409 stale'))

    await runJob(createJob())

    expect(sendAlertMock).toHaveBeenCalledOnce()
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', sourceType: 'gate_consume_failed' }),
    )
  })

  // 7. consumedRequestId missing → sendAlert が severity='critical' で呼ばれる
  it('consumedRequestId missing → sendAlert が severity=critical で呼ばれる', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, message: 'missing id' },
    })
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob())

    expect(sendAlertMock).toHaveBeenCalledOnce()
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', sourceType: 'gate_consume_missing_id' }),
    )
  })

  // 8. continue → sendAlert は呼ばれない
  it('continue → sendAlert は呼ばれない', async () => {
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob())

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 9. continue_safe_work_only + safe command → sendAlert は呼ばれない
  it('continue_safe_work_only + safe command (test) → sendAlert は呼ばれない', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'HIGH risk',
      apiAvailable: true,
    })
    resolveCommandMock.mockReturnValue({ argv: ['pnpm', 'test'], description: 'test' })

    const job = createJob({ safeCommand: { kind: 'test', workingDir: '/workspace/target' } })
    await runJob(job)

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 10. continue_safe_work_only + unsafe command blocked → sendAlert は呼ばれない（console.warn のみ）
  it('continue_safe_work_only + unsafe command blocked → sendAlert は呼ばれない', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'HIGH risk',
      apiAvailable: true,
    })

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
    })
    await runJob(job)

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 11. alreadyConsumed → sendAlert は呼ばれない
  it('alreadyConsumed → sendAlert は呼ばれない', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-3d-011', message: 'consume' },
    })
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockResolvedValue({ ok: true, alreadyConsumed: true })

    await runJob(createJob())

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 12. permission guard blocked → sendAlert は呼ばれない
  it('permission guard blocked → sendAlert は呼ばれない', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'outside TARGET_ROOT',
    })

    await runJob(createJob())

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 13. callGateCheck failed → sendAlert は呼ばれない
  it('callGateCheck failed → sendAlert は呼ばれない', async () => {
    callGateCheckMock.mockRejectedValue(new Error('ECONNREFUSED'))
    resolvePolicyMock.mockReturnValue({
      policy: 'continue_safe_work_only',
      reason: 'Gate API unavailable',
      apiAvailable: false,
    })

    await runJob(createJob())

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 14. sendAlert が同期 throw しても blocked return は維持される
  it('sendAlert が同期 throw しても blocked return は維持される', async () => {
    callGateCheckMock.mockResolvedValue(makeBlockedResponse('req-3d-014'))
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL',
      apiAvailable: true,
    })
    sendAlertMock.mockImplementation(() => { throw new Error('sync notification error') })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('block_until_approved')
  })
})

// ────────────────────────────────────────────────────────────
// task-022: AI CLI → jobRunner 接続テスト
// ────────────────────────────────────────────────────────────

vi.mock('./aiCli/factory.js', () => ({
  createAiCliAdapter: vi.fn(),
}))

import { createAiCliAdapter } from './aiCli/factory.js'
const createAiCliAdapterMock = vi.mocked(createAiCliAdapter)

function makeCliResult(overrides: Partial<{
  exitCode: number
  stdout: string
  stderr: string
  changedFiles: string[]
  blocked: boolean
  stdoutPath: string
  stderrPath: string
}> = {}) {
  return {
    taskId: 'task-1',
    provider: 'claude_code' as const,
    exitCode: 0,
    stdout: 'AI CLIの実行結果',
    stderr: '',
    changedFiles: ['src/feature.ts'],
    durationMs: 1000,
    blocked: false,
    ...overrides,
  }
}

describe('task-022: AI CLI 実行ブロック', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockReturnValue('')
  })

  it('aiCliProvider なし → AI CLI をスキップして SafeCommand を実行する', async () => {
    // AI CLI フィールドが未指定の通常 Job
    const job = createJob()
    const result = await runJob(job)

    expect(createAiCliAdapterMock).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
  })

  it('aiCliProvider あり・CLI 成功 → SafeCommand も実行される', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult()) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/feature.ts にログ出力を追加してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(createAiCliAdapterMock).toHaveBeenCalledWith({ provider: 'claude_code' })
    expect(mockAdapter.run).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      provider: 'claude_code',
      workingDir: '/workspace/target',
      prompt: 'src/feature.ts にログ出力を追加してください',
      contextFiles: [],
      mode: 'implement',
    }))
    // SafeCommand も実行された
    expect(execFileSyncMock).toHaveBeenCalled()
    expect(result.status).toBe('success')
  })

  it('AI CLI が exitCode !== 0 → status: failed で早期リターン（SafeCommand は実行されない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('compile error')
    // SafeCommand (resolveCommand) は実行されない
    // ※ execFileSyncMock は Gate フェーズの git ヘルパーでも呼ばれるためチェック対象外
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('AI CLI が blocked: true → status: failed で早期リターン', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 0, blocked: true })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'JSON をパースして返してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(result.status).toBe('failed')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('AI CLI が throw → status: failed で早期リターン（エラーメッセージが stderr に入る）', async () => {
    const mockAdapter = { run: vi.fn().mockRejectedValue(new Error('workingDir が TARGET_ROOT 外')) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: '実装してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('TARGET_ROOT')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('dryRun: true → AI CLI にも dryRun: true が伝搬する', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult()) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      dryRun: true,
      aiCliProvider: 'codex',
      aiCliPrompt: 'テスト実行だけ',
      aiCliMode: 'review',
    })
    await runJob(job)

    expect(mockAdapter.run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })
})

describe('Step6-A2: Approval Level v2 判定接続（観察モード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockReturnValue('')
  })

  it('docsのみの変更 → approvalLevelResultがmechanical_onlyになる', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') return '+# タイトル\n'
      return ''
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(result.approvalLevelResult).toBeDefined()
    expect(result.approvalLevelResult?.reviewPolicy).toBe('mechanical_only')
    expect(result.approvalLevelResult?.level).toBe(0)
  })

  it('jobRunner.ts自体を変更するJob → approvalLevelResultがfull_pre_post_reviewになる（level:2）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'apps/worker/src/jobRunner.ts\n'
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') return '+const x = 1\n'
      return ''
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(result.approvalLevelResult?.reviewPolicy).toBe('full_pre_post_review')
    expect(result.approvalLevelResult?.level).toBe(2)
  })

  it('postTestHook.ps1を変更するJob（Mechanical Gate hit）→ reviewPolicyはceo_requiredだが、Jobはまだブロックされない', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'apps/worker/scripts/postTestHook.ps1\n'
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') return '+Write-Host "test"\n'
      return ''
    })

    const result = await runJob(createJob())

    // 観察モード: ceo_requiredでもまだ既存フロー通りに進み、statusはblockedにならない
    expect(result.status).toBe('success')
    expect(result.approvalLevelResult?.reviewPolicy).toBe('ceo_required')
    expect(result.approvalLevelResult?.level).toBe(3)
    expect(resolveCommandMock).toHaveBeenCalled()
  })

  it('permissionGuardでblockedの場合、approvalLevelResultはundefinedのまま（判定に到達しない）', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'denied',
      blockEvent: {
        type: 'grant_expired' as const,
        jobId: 'job-1',
        taskId: 'task-1',
        agentRole: 'developer_ai',
        commandKind: 'git_status',
        message: 'denied',
        occurredAt: new Date().toISOString(),
      },
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.approvalLevelResult).toBeUndefined()
  })

  it('既存Approval Gateがblock_until_approvedの場合、approvalLevelResultはundefinedのまま（判定に到達しない）', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.approvalLevelResult).toBeUndefined()
  })

  it('AI CLI失敗時のJobRunResultにもapprovalLevelResultが含まれる', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return ''
    })

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(result.status).toBe('failed')
    expect(result.approvalLevelResult).toBeDefined()
    expect(result.approvalLevelResult?.reviewPolicy).toBe('mechanical_only')
  })
})

// ────────────────────────────────────────────────────────────
// Step6-B0: Approval Scope（jobRunner経由のJobは常にtarget_project）
//
// このdescribeブロックは新しい機能を検証するものではなく、
// 既存の安全保証（permissionGuardWithGrants → isInsideTargetRoot）が
// 引き続き機能していることを可視化するための回帰テストである。
//
// jobRunner.ts で evaluateJobApprovalLevel() に渡される
// changedFiles / diffText は、この保証により常に target_project
// （AIチームOSが開発する対象アプリ）側の差分であり、
// AIチームOS自身（control repo）の差分ではない。
// ────────────────────────────────────────────────────────────
describe('Step6-B0: Approval Scope（jobRunner経由のJobはtarget_project前提）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockReturnValue('')
  })

  it('TARGET_ROOT外のworkingDirを持つJobは、permissionGuardでblockedされる（jobRunnerがtarget_project以外を評価することはない）', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'workingDir is outside TARGET_ROOT',
    })

    const job = createJob({
      safeCommand: { kind: 'git_status', workingDir: '/workspace/control' },
    })
    const result = await runJob(job)

    expect(result.status).toBe('blocked')
    expect(result.guardResult.permissionReason).toBe('workingDir is outside TARGET_ROOT')
    // permissionGuardの時点でblockedのため、Approval Level v2判定にも到達しない
    expect(result.approvalLevelResult).toBeUndefined()
  })

  it('TARGET_ROOT配下のworkingDirを持つ通常Jobは、既存フロー通り継続する（target_project前提の回帰確認）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/index.ts\n'
      return ''
    })

    const job = createJob({
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    })
    const result = await runJob(job)

    // permissionGuardを通過し、既存フロー（resolveCommand実行）まで到達する
    expect(result.status).toBe('success')
    expect(resolveCommandMock).toHaveBeenCalled()
    // approvalLevelResultは計算されるが、これはtarget_project向けの観察用参考ラベルに過ぎない
    expect(result.approvalLevelResult).toBeDefined()
  })
})

describe('Target Project Risk Scan 接続（観察モード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockReturnValue('')
  })

  it('通常の変更（docs/README.md）→ targetProjectRiskScanResult.hasRisk:false', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return ''
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(result.targetProjectRiskScanResult).toBeDefined()
    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(false)
  })

  it('.env を含む変更 → targetProjectRiskScanResult.hasRisk:true、ただしstatusはsuccessのまま（停止しない）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return ''
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('success')
    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(true)
    expect(result.targetProjectRiskScanResult?.issues.some(issue => issue.id === 'ENV_FILE_CHANGED')).toBe(true)
  })

  it('AI CLI経由で.envを変更するJob → AI CLI実行後のchangedFilesを対象にscanされる', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ changedFiles: ['.env'] })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return ''
    })

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: '設定を追加してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(result.status).toBe('success')
    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(true)
  })

  it('AI CLI失敗時、targetProjectRiskScanResultはundefinedのまま（scanポイントに到達しない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job)

    expect(result.status).toBe('failed')
    expect(result.targetProjectRiskScanResult).toBeUndefined()
  })

  it('permissionGuardでblockedの場合、targetProjectRiskScanResultはundefinedのまま', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'denied',
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.targetProjectRiskScanResult).toBeUndefined()
  })

  it('既存Approval Gateがblock_until_approvedの場合、targetProjectRiskScanResultはundefinedのまま', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob())

    expect(result.status).toBe('blocked')
    expect(result.targetProjectRiskScanResult).toBeUndefined()
  })

  it('hasRisk:trueでもJobのstatusはblockedにならない（観察モードであることの確認）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'Dockerfile\n'
      return ''
    })

    const result = await runJob(createJob())

    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(true)
    expect(result.status).not.toBe('blocked')
  })
})
