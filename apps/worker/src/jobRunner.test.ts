import { execFileSync } from 'node:child_process'
import type { Job, Task } from '@ai-team/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const outboxMocks = vi.hoisted(() => ({
  recordPending: vi.fn(),
  deletePending: vi.fn(),
  resendPending: vi.fn(),
  hasPending: vi.fn(),
}))

vi.mock('./outbox/outboxStore.js', () => outboxMocks)

import { resolveCommand } from './commandResolver.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { saveJobLogs } from './jobLogger.js'
import { persistJobResult } from './index.js'
import {
  buildStructuredReviewPrompt,
  parseStructuredReviewOutput,
  runJob,
} from './jobRunner.js'
import {
  assertIndexClean,
  assertIndexMatchesApproved,
  assertNoHistoryRewrite,
  assertNoResidualChanges,
  buildApprovedStateMap,
  buildCommitRangeManifest,
  buildIndexStateMap,
  buildWorktreeManifest,
  diffSensitiveBaseline,
  scanSensitiveFiles,
  stageApprovedPaths,
} from './guards/changeManifest.js'
import { callGateCheck, callConsume, GateClientError } from './guards/gateClient.js'
import { resolvePolicy } from './guards/gatePolicy.js'

const { hoistedExecFileSync } = vi.hoisted(() => ({ hoistedExecFileSync: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFileSync: hoistedExecFileSync,
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
  ALWAYS_FORBIDDEN_PATTERNS: [/^.env$/, /.pem$/],
}))

vi.mock('./guards/changeManifest.js', () => ({
  ChangeDetectionError: class ChangeDetectionError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'ChangeDetectionError'
    }
  },
  captureReflogBaseline: vi.fn(() => ({ headHashes: [] })),
  assertNoHistoryRewrite: vi.fn(),
  assertIndexClean: vi.fn(),
  assertIndexMatchesApproved: vi.fn(),
  assertNoResidualChanges: vi.fn(),
  // jobRunner のオーケストレーションを検証するためのスタブ。
  // 既存テストが execFileSync 経由で変更ファイルを注入する方式をそのまま活かすため、
  // ここでは同じ git 呼び出しから manifest を組み立てる。
  // 実際の porcelain=v2 / diff --raw 解析は changeManifest.test.ts が実 git で検証する。
  buildWorktreeManifest: vi.fn((workingDir: string) => {
    const out = hoistedExecFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    })
    const paths = String(out ?? '').trim().split(/\r?\n/).filter(Boolean)
    return {
      changes: paths.map((path: string) => ({
        path,
        kind: 'modified',
        afterType: 'regular',
      })),
      paths,
    }
  }),
  buildCommitRangeManifest: vi.fn(() => ({ changes: [], paths: [] })),
  buildApprovedStateMap: vi.fn((_workingDir: string, manifest: { changes: Array<{ path: string; oldPath?: string; kind: string }> }) => {
    const states = new Map<string, { absent: boolean; blobId?: string; type?: string; mode?: string }>()
    for (const change of manifest.changes) {
      if (change.kind === 'deleted') {
        states.set(change.path, { absent: true })
      } else if (change.kind === 'renamed') {
        if (change.oldPath) states.set(change.oldPath, { absent: true })
        states.set(change.path, { absent: false, blobId: 'approved-blob', type: 'regular', mode: '100644' })
      } else {
        states.set(change.path, { absent: false, blobId: 'approved-blob', type: 'regular', mode: '100644' })
      }
    }
    return states
  }),
  buildIndexStateMap: vi.fn(() => new Map()),
  stageApprovedPaths: vi.fn(),
  // 既存テストの execFileSync 呼び出し順序（mockReturnValueOnce チェーン）を保つため、
  // 旧 getPreGateDiffText と同じ git 呼び出しを行う。
  getWorktreeDiffText: vi.fn((workingDir: string) => {
    return String(
      hoistedExecFileSync('git', ['diff', 'HEAD'], {
        cwd: workingDir,
        encoding: 'utf-8',
        shell: false,
      }) ?? '',
    )
  }),
  getCommitRangeDiffText: vi.fn(() => ''),
  scanSensitiveFiles: vi.fn(() => new Map()),
  diffSensitiveBaseline: vi.fn(() => []),
  mergeManifests: vi.fn((...manifests: any[]) => {
    const changes = manifests.flatMap((m) => m.changes)
    const paths: string[] = []
    for (const c of changes) {
      if (!paths.includes(c.path)) paths.push(c.path)
      if (c.oldPath && !paths.includes(c.oldPath)) paths.push(c.oldPath)
    }
    return { changes, paths }
  }),
  manifestFromChanges: vi.fn((changes: any[]) => ({
    changes,
    paths: changes.map((c) => c.path),
  })),
}))

vi.mock('./jobLogger.js', () => ({
  saveJobLogs: vi.fn((jobId: string, stdout: string, stderr: string) => ({
    stdoutPath: `/logs/${jobId}/stdout.txt`,
    stderrPath: `/logs/${jobId}/stderr.txt`,
    stdoutPreview: stdout.slice(0, 4000),
    stderrPreview: stderr.slice(0, 4000),
  })),
}))

vi.mock('./guards/gateClient.js', () => ({
  callGateCheck: vi.fn(),
  callConsume: vi.fn(),
  // 実装と同じく technicalFailure を持たせる（既定 true = 未知の失敗は安全側）
  GateClientError: class GateClientError extends Error {
    readonly technicalFailure: boolean
    constructor(msg: string, options?: { technicalFailure?: boolean }) {
      super(msg)
      this.name = 'GateClientError'
      this.technicalFailure = options?.technicalFailure ?? true
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

vi.mock('./approvalLevel/stepReview.js', () => ({
  runStepReview: vi.fn().mockResolvedValue({
    status: 'failed',
    summary: '(test default: runStepReview not mocked for this case)',
    concerns: [],
    requiredFixes: [],
    escalationReason: null,
    confidence: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
    rawResponse: '',
  }),
  createNotRunStepReviewResult: vi.fn((reason: string) => ({
    status: 'not_run',
    summary: reason,
    concerns: [],
    requiredFixes: [],
    escalationReason: null,
    confidence: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
    rawResponse: '',
  })),
}))

vi.mock('./approvalLevel/postReviewer.js', () => ({
  runPostReview: vi.fn().mockResolvedValue({
    jobId: 'job-1',
    taskId: 'task-1',
    reviewerResult: {
      provider: 'gemini',
      phase: 'post',
      verdict: 'approved',
      summary: '(test default)',
      issues: [],
      confidence: 0.9,
      generatedAt: '2026-01-01T00:00:00.000Z',
      rawResponse: '',
    },
    alignmentVerdict: 'aligned',
    blocked: false,
    decidedAt: '2026-01-01T00:00:00.000Z',
  }),
}))

vi.mock('./approvalLevel/commitGate.js', () => ({
  evaluateCommitGate: vi.fn(),
}))

vi.mock('./approvalLevel/observationLog.js', () => ({
  appendObservationLog: vi.fn(),
}))

// ────────────────────────────────────────────────────────────
// Mock references
// ────────────────────────────────────────────────────────────

const execFileSyncMock = vi.mocked(execFileSync)
const resolveCommandMock = vi.mocked(resolveCommand)
const fileChangeGuardMock = vi.mocked(fileChangeGuard)
const buildWorktreeManifestMock = vi.mocked(buildWorktreeManifest)
const buildCommitRangeManifestMock = vi.mocked(buildCommitRangeManifest)
const buildApprovedStateMapMock = vi.mocked(buildApprovedStateMap)
const assertIndexCleanMock = vi.mocked(assertIndexClean)
const stageApprovedPathsMock = vi.mocked(stageApprovedPaths)
const buildIndexStateMapMock = vi.mocked(buildIndexStateMap)
const assertIndexMatchesApprovedMock = vi.mocked(assertIndexMatchesApproved)
const assertNoHistoryRewriteMock = vi.mocked(assertNoHistoryRewrite)
const assertNoResidualChangesMock = vi.mocked(assertNoResidualChanges)
const scanSensitiveFilesMock = vi.mocked(scanSensitiveFiles)
const diffSensitiveBaselineMock = vi.mocked(diffSensitiveBaseline)

/** テスト内で ChangeDetectionError 相当を投げるためのスタブ */
class ChangeDetectionErrorStub extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChangeDetectionError'
  }
}
const saveJobLogsMock = vi.mocked(saveJobLogs)
const callGateCheckMock = vi.mocked(callGateCheck)
const callConsumeMock = vi.mocked(callConsume)
const resolvePolicyMock = vi.mocked(resolvePolicy)

import { permissionGuardWithGrants } from './guards/permissionGuard.js'
const permissionGuardWithGrantsMock = vi.mocked(permissionGuardWithGrants)

import { sendAlert } from './notifier/notifier.js'
const sendAlertMock = vi.mocked(sendAlert)

import { runStepReview } from './approvalLevel/stepReview.js'
const runStepReviewMock = vi.mocked(runStepReview)

import { runPostReview } from './approvalLevel/postReviewer.js'
const runPostReviewMock = vi.mocked(runPostReview)

import { evaluateCommitGate } from './approvalLevel/commitGate.js'
import type { CommitGateResult } from './approvalLevel/commitGate.js'
const evaluateCommitGateMock = vi.mocked(evaluateCommitGate)

function makeShadowGateResult(
  overrides: Partial<CommitGateResult> = {},
): CommitGateResult {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    allowed: true,
    reviewPolicy: 'mechanical_only',
    artifactChecks: [],
    blockingReasons: [],
    decidedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

import { appendObservationLog } from './approvalLevel/observationLog.js'
const appendObservationLogMock = vi.mocked(appendObservationLog)

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

/** runJob() が要求する実行時Taskポリシー（createJob のデフォルトに一致させる） */
/** execFileSync mock の既定応答。rev-parse HEAD は fail-closed 対象なので有効値を返す */
const BASE_COMMIT = 'basecommit0000000000000000000000000000000'
/**
 * git_commit 実行を伴う Job 用の execFileSync mock。
 * 呼び出し順ではなく引数で分岐するため、内部の git 呼び出し回数が変わっても壊れない。
 */
function mockGitCommitRun(before: string, after: string): void {
  let committed = false
  execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    if (!Array.isArray(args)) return ''
    if (args[0] === 'commit') {
      committed = true
      return ''
    }
    if (args.includes('--name-only')) return committed ? '' : 'src/approved.ts\n'
    if (args.includes('--abbrev-ref')) return 'main' + String.fromCharCode(10)
    if (args[0] === 'rev-parse') return committed ? after : before
    return ''
  })
}

function gitFallback(args: readonly string[] | undefined): string {
  if (Array.isArray(args) && args[0] === 'rev-parse' && !args.includes('--abbrev-ref')) {
    return BASE_COMMIT
  }
  return ''
}

function createPolicy(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    taskId: 'task-1',
    projectId: 'project-1',
    allowedPaths: Object.freeze([] as string[]),
    forbiddenPaths: Object.freeze([] as string[]),
    ...overrides,
  }) as never
}

function createStructuredReviewContext() {
  const task: Task = {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Implement feature A',
    description: 'Add feature A without changing public APIs.',
    status: 'review',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['src/'],
    forbiddenPaths: ['.env'],
    acceptanceCriteria: ['tests pass'],
    expectedOutputs: ['src/feature.ts'],
    roadmapActive: false,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  }
  const implementJob = createJob({
    id: 'implement-job-1',
    workflowStepKey: 'task:task-1:initial-implement',
    aiCliProvider: 'claude_code',
    aiCliMode: 'implement',
    status: 'success',
    exitCode: 0,
    stdout: 'implementation complete',
    stderr: '',
    changedFiles: ['src/feature.ts'],
    completedAt: '2026-08-06T00:05:00.000Z',
    guardResult: { permissionAllowed: true, fileChangeAllowed: true },
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
  })
  return { task, implementJob }
}

// ────────────────────────────────────────────────────────────
// beforeEach: reset all mocks to safe defaults
// ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  outboxMocks.recordPending.mockReturnValue({
    eventId: 'event-1',
    payloadHash: 'payload-hash-1',
  })

  buildWorktreeManifestMock.mockImplementation((workingDir: string) => {
    const out = hoistedExecFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    })
    const paths = String(out ?? '').trim().split(/\r?\n/).filter(Boolean)
    return {
      changes: paths.map((changedPath: string) => ({
        path: changedPath,
        kind: 'modified' as const,
        afterType: 'regular' as const,
      })),
      paths,
    }
  })
  buildApprovedStateMapMock.mockImplementation((_workingDir, manifest) => {
    const states = new Map()
    for (const change of manifest.changes) {
      if (change.kind === 'deleted') {
        states.set(change.path, { absent: true })
      } else {
        if (change.oldPath) states.set(change.oldPath, { absent: true })
        states.set(change.path, {
          absent: false,
          blobId: 'approved-blob',
          type: 'regular',
          mode: '100644',
        })
      }
    }
    return states
  })
  buildIndexStateMapMock.mockReturnValue(new Map())
  assertIndexCleanMock.mockImplementation(() => {})
  stageApprovedPathsMock.mockImplementation(() => {})
  assertIndexMatchesApprovedMock.mockImplementation(() => {})
  assertNoResidualChangesMock.mockImplementation(() => {})

  // Notifier: always resolve silently by default
  sendAlertMock.mockResolvedValue([])

  // Gate mocks: default to ALLOW / continue
  callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
  resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

  // Shadow Commit Gate（Phase 1・観察モード）: デフォルトは allowed:true の結果を返すだけ。
  // jobRunner 側でログ出力に使われるのみで、Job結果には影響しない。
  evaluateCommitGateMock.mockReturnValue(makeShadowGateResult())

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

  // execFileSync: git ヘルパー呼び出しの既定値
  // rev-parse HEAD は安全判定に使われ fail-closed 対象のため、有効なハッシュを返す
  execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    if (Array.isArray(args) && args[0] === 'rev-parse' && !args.includes('--abbrev-ref')) {
      return 'basecommit0000000000000000000000000000000'
    }
    return ''
  })
})

describe('commit後のJob結果保存', () => {
  it('完全結果のAPI保存失敗後もOutboxへ結果を残し、reconciliationは行わない', async () => {
    const patchJob = vi.fn().mockResolvedValue(false)
    const reconcileJob = vi.fn().mockResolvedValue({
      outcome: 'reconciled',
      updated: true,
      currentStatus: 'failed',
    })
    const result = {
      status: 'success' as const,
      commitHash: 'created-commit-hash',
      guardResult: {
        permissionAllowed: true,
        fileChangeAllowed: true,
        fileViolations: [],
      },
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:01:00.000Z',
    }

    await persistJobResult('job-1', result, 'success', { patchJob, reconcileJob })

    expect(patchJob).toHaveBeenCalledTimes(1)
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({
      status: 'success',
      commitHash: 'created-commit-hash',
    })
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(outboxMocks.recordPending).toHaveBeenCalledWith('job-1', expect.objectContaining({
      status: 'success',
      commitHash: 'created-commit-hash',
    }))
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('structured reviewをAPIへ保存し、非approved時はCEO通知して停止する', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const result = {
      status: 'failed' as const,
      exitCode: 0,
      reviewResult: {
        status: 'changes_requested' as const,
        summary: 'A blocking fix is required.',
        findings: [{ severity: 'high' as const, message: 'Fix this issue.' }],
      },
      guardResult: {
        permissionAllowed: true,
        fileChangeAllowed: true,
        fileViolations: [],
      },
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:01:00.000Z',
    }

    await persistJobResult('review-job-1', result, 'failed', { patchJob })

    expect(patchJob).toHaveBeenCalledWith('review-job-1', expect.objectContaining({
      status: 'failed',
      reviewResult: result.reviewResult,
    }))
    expect(sendAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warning',
      sourceType: 'structured_review',
      sourceId: 'review-job-1',
    }))
  })
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

    const result = await runJob(createJob(), createPolicy())

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

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.permissionBlockEvent).toEqual(blockEvent)
    expect(callGateCheckMock).not.toHaveBeenCalled()
  })

  // 2026-08-01: 権限 API の技術障害は「権限が拒否された」ではないため、
  // 承認・手動 resume 待ちの blocked ではなく failed で止める。
  it('permissionGuard の technicalFailure → blocked ではなく failed', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      technicalFailure: true,
      reason: 'permission-grants: HTTP 401',
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.technicalFailure).toBe(true)
    expect(result.stderr).toContain('Permission check could not be completed')
    expect(result.stderr).toContain('HTTP 401')
    // 技術障害では Gate も SafeCommand も動かさない
    expect(callGateCheckMock).not.toHaveBeenCalled()
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('permissionGuard の technicalFailure では guardResult を permission 拒否として扱わない', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      technicalFailure: true,
      reason: 'permission-grants: request failed — ECONNREFUSED',
    })

    const result = await runJob(createJob(), createPolicy())

    // permissionAllowed=false にすると index.ts の resolveResultStatus() が
    // blocked へ変換してしまうため、技術障害では true のままにする
    expect(result.guardResult.permissionAllowed).toBe(true)
    expect(result.guardResult.fileChangeAllowed).toBe(true)
  })

  it('once グラントの使用済み記録失敗（technicalFailure）でも Job を続行しない', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      technicalFailure: true,
      reason: 'permission-grants/use: HTTP 500',
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('executes the resolved command with shell disabled and records changed files', async () => {
    // Route execFileSync return values by git subcommand
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === 'status') return 'M src/index.ts\n'
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/index.ts\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    // The main command must have been called with shell: false and timeout
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['status', '--short'], {
      cwd: '/workspace/target',
      shell: false,
      timeout: 120_000,
      encoding: 'utf-8',
      env: expect.any(Object),
    })
    // git diff --name-only HEAD (getChangedFiles post-execution) must have been called
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', '--name-only', 'HEAD'], {
      cwd: '/workspace/target',
      encoding: 'utf-8',
      shell: false,
    })
    // File Change Guard は string[] ではなく変更 manifest と実行時ポリシーを受け取る
    expect(fileChangeGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ['src/index.ts'] }),
      expect.objectContaining({ taskId: 'task-1', projectId: 'project-1' }),
      '/workspace/target',
    )
    expect(result.status).toBe('success')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('M src/index.ts\n')
    expect(result.stdoutPath).toBe('/logs/job-1/stdout.txt')
    expect(result.stderrPath).toBe('/logs/job-1/stderr.txt')
    expect(result.changedFiles).toEqual(['src/index.ts'])
    expect(saveJobLogsMock).toHaveBeenCalledWith('job-1', 'M src/index.ts\n', '')
  })

  describe('SafeCommand 実行の env allowlist（secrets boundary）', () => {
    const SECRET_ENV_BACKUP: Record<string, string | undefined> = {}

    beforeEach(() => {
      SECRET_ENV_BACKUP.API_TOKEN = process.env.API_TOKEN
      SECRET_ENV_BACKUP.DB_PATH = process.env.DB_PATH
      SECRET_ENV_BACKUP.OPENAI_API_KEY = process.env.OPENAI_API_KEY
      SECRET_ENV_BACKUP.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY
      SECRET_ENV_BACKUP.GEMINI_API_KEY = process.env.GEMINI_API_KEY
      SECRET_ENV_BACKUP.FUTURE_OUTBOX_SECRET = process.env.FUTURE_OUTBOX_SECRET

      process.env.API_TOKEN = 'secret-api-token'
      process.env.DB_PATH = '/secret/db.sqlite'
      process.env.OPENAI_API_KEY = 'sk-secret-openai'
      process.env.CLAUDE_API_KEY = 'sk-secret-claude'
      process.env.GEMINI_API_KEY = 'secret-gemini'
      process.env.FUTURE_OUTBOX_SECRET = 'secret-outbox-value'
    })

    afterEach(() => {
      for (const [key, value] of Object.entries(SECRET_ENV_BACKUP)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    function mainCommandEnv(): NodeJS.ProcessEnv {
      const call = execFileSyncMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].join(' ') === 'run test',
      ) ?? execFileSyncMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].join(' ') === 'run build',
      ) ?? execFileSyncMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].join(' ') === 'run lint',
      )
      if (!call) throw new Error('main command execFileSync call not found')
      return (call[2] as { env: NodeJS.ProcessEnv }).env
    }

    it('test コマンドから API_TOKEN が見えない', async () => {
      resolveCommandMock.mockReturnValue({ argv: ['pnpm', 'run', 'test'], description: 'pnpm test' })

      await runJob(createJob({ safeCommand: { kind: 'test', workingDir: '/workspace/target' } }), createPolicy())

      const env = mainCommandEnv()
      expect(env.API_TOKEN).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH)
    })

    it('build コマンドから DB_PATH が見えない', async () => {
      resolveCommandMock.mockReturnValue({ argv: ['pnpm', 'run', 'build'], description: 'pnpm build' })

      await runJob(createJob({ safeCommand: { kind: 'build', workingDir: '/workspace/target' } }), createPolicy())

      const env = mainCommandEnv()
      expect(env.DB_PATH).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH)
    })

    it('lint コマンドから全 provider API key が見えない', async () => {
      resolveCommandMock.mockReturnValue({ argv: ['pnpm', 'run', 'lint'], description: 'pnpm lint' })

      await runJob(createJob({ safeCommand: { kind: 'lint', workingDir: '/workspace/target' } }), createPolicy())

      const env = mainCommandEnv()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.CLAUDE_API_KEY).toBeUndefined()
      expect(env.GEMINI_API_KEY).toBeUndefined()
      expect(env.PATH).toBe(process.env.PATH)
    })

    it('未知の環境変数（将来の Outbox 秘密情報等）が自動継承されない', async () => {
      resolveCommandMock.mockReturnValue({ argv: ['pnpm', 'run', 'test'], description: 'pnpm test' })

      await runJob(createJob({ safeCommand: { kind: 'test', workingDir: '/workspace/target' } }), createPolicy())

      const env = mainCommandEnv()
      expect(env.FUTURE_OUTBOX_SECRET).toBeUndefined()
    })
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
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

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
      return gitFallback(args)
    })
    fileChangeGuardMock.mockReturnValue({
      allowed: false,
      violations: ['../secret.txt'],
      reasons: { '../secret.txt': 'Path traversal or outside target' },
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.guardResult.fileChangeAllowed).toBe(false)
    expect(result.guardResult.fileViolations).toEqual(['../secret.txt'])
  })

  it('git_commit job uses timeout=undefined (atomic)', async () => {
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
    mockGitCommitRun('abc123', 'def456')

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })

    await runJob(job, createPolicy())

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
    mockGitCommitRun('abc123', 'def456')

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })

    const result = await runJob(job, createPolicy())

    expect(result.rollbackInfo).toBeDefined()
    expect(result.rollbackInfo?.previousCommitHash).toBe('abc123')
    expect(result.rollbackInfo?.rollbackArgv).toContain('revert')
  })
})

describe('Phase 2: git_commit staging verification', () => {
  const approvedManifest = {
    changes: [{ path: 'src/approved.ts', kind: 'modified' as const, afterType: 'regular' as const, afterMode: '100644' }],
    paths: ['src/approved.ts'],
  }
  const approvedState = new Map([
    ['src/approved.ts', { absent: false, blobId: 'approved-blob', type: 'regular' as const, mode: '100644' }],
  ])

  beforeEach(() => {
    buildWorktreeManifestMock.mockReturnValue(approvedManifest)
    buildApprovedStateMapMock.mockReturnValue(new Map(approvedState))
    buildIndexStateMapMock.mockReturnValue(new Map(approvedState))
    assertIndexCleanMock.mockImplementation(() => {})
    stageApprovedPathsMock.mockImplementation(() => {})
    assertIndexMatchesApprovedMock.mockImplementation(() => {})
    assertNoResidualChangesMock.mockImplementation(() => {})
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
  })

  function gitCommitJob(): Job {
    return createJob({
      safeCommand: {
        kind: 'git_commit',
        workingDir: '/workspace/target',
        params: { commitMessage: 'test' },
      },
    })
  }

  it('stages the approved paths, verifies the index, and creates the commit', async () => {
    mockGitCommitRun(BASE_COMMIT, 'aftercommit000000000000000000000000000000')

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(buildApprovedStateMapMock.mock.invocationCallOrder[0]).toBeLessThan(
      callGateCheckMock.mock.invocationCallOrder[0],
    )
    expect(stageApprovedPathsMock).toHaveBeenCalledWith('/workspace/target', ['src/approved.ts'])
    expect(assertIndexMatchesApprovedMock).toHaveBeenCalledWith(
      expect.any(Map),
      expect.any(Map),
    )
    expect(execFileSyncMock.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === 'commit')).toBe(true)
    expect(result.commitHash).toBe('aftercommit000000000000000000000000000000')
    expect(saveJobLogsMock.mock.calls[0]?.[1]).toContain(
      '[commit-evidence] commitHash=aftercommit000000000000000000000000000000',
    )
  })

  it('records commitHash immediately and never creates a second commit when post-commit inspection fails', async () => {
    const afterCommit = 'aftercommit-evidence000000000000000000000000'
    mockGitCommitRun(BASE_COMMIT, afterCommit)
    assertNoHistoryRewriteMock
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new ChangeDetectionErrorStub('post-commit inspection failed')
      })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.detectionFailure).toBe(true)
    expect(result.commitHash).toBe(afterCommit)
    expect(saveJobLogsMock).toHaveBeenCalledTimes(1)
    expect(saveJobLogsMock.mock.calls[0]?.[1]).toContain(`[commit-evidence] commitHash=${afterCommit}`)
    const commitCalls = execFileSyncMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'commit',
    )
    expect(commitCalls).toHaveLength(1)
  })

  it('fails before staging when the index is already dirty and never runs git reset', async () => {
    mockGitCommitRun(BASE_COMMIT, 'unused')
    assertIndexCleanMock.mockImplementationOnce(() => {
      throw new ChangeDetectionErrorStub('index already staged')
    })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.detectionFailure).toBe(true)
    expect(callGateCheckMock).not.toHaveBeenCalled()
    expect(callConsumeMock).not.toHaveBeenCalled()
    expect(stageApprovedPathsMock).not.toHaveBeenCalled()
    expect(resolveCommandMock).not.toHaveBeenCalled()
    expect(execFileSyncMock.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === 'commit')).toBe(false)
    expect(execFileSyncMock.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === 'reset')).toBe(false)
  })

  it('fails at job start before building the pre-manifest or calling the approval APIs when the index is dirty', async () => {
    assertIndexCleanMock.mockImplementationOnce(() => {
      throw new ChangeDetectionErrorStub('index dirty at job start')
    })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(assertIndexCleanMock).toHaveBeenCalledTimes(1)
    expect(buildWorktreeManifestMock).not.toHaveBeenCalled()
    expect(callGateCheckMock).not.toHaveBeenCalled()
    expect(callConsumeMock).not.toHaveBeenCalled()
    expect(stageApprovedPathsMock).not.toHaveBeenCalled()
    expect(execFileSyncMock.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === 'commit')).toBe(false)
  })

  it('fails after consume when the second index check detects a race before staging', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-index-race', message: 'consume' },
    })
    callConsumeMock.mockResolvedValueOnce({ ok: true })
    assertIndexCleanMock
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new ChangeDetectionErrorStub('index dirtied after consume')
      })
    mockGitCommitRun(BASE_COMMIT, 'unused')

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(assertIndexCleanMock).toHaveBeenCalledTimes(2)
    expect(callGateCheckMock).toHaveBeenCalledOnce()
    expect(callConsumeMock).toHaveBeenCalledOnce()
    expect(stageApprovedPathsMock).not.toHaveBeenCalled()
    expect(execFileSyncMock.mock.calls.some((call) => Array.isArray(call[1]) && call[1][0] === 'commit')).toBe(false)
  })

  it('fails before staging when HEAD changes after consume succeeds', async () => {
    let consumed = false
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-head-before-stage', message: 'consume' },
    })
    callConsumeMock.mockImplementationOnce(async () => {
      consumed = true
      return { ok: true }
    })
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--abbrev-ref')) return 'main\n'
      if (Array.isArray(args) && args[0] === 'rev-parse') {
        return consumed ? 'changed-before-stage\n' : `${BASE_COMMIT}\n`
      }
      return ''
    })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(callConsumeMock).toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('HEAD changed since job start')
    expect(stageApprovedPathsMock).not.toHaveBeenCalled()
  })

  it('fails without committing when HEAD changes after staging', async () => {
    let staged = false
    stageApprovedPathsMock.mockImplementationOnce(() => {
      staged = true
    })
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--abbrev-ref')) return 'main\n'
      if (Array.isArray(args) && args[0] === 'rev-parse') {
        return staged ? 'changed-before-commit\n' : `${BASE_COMMIT}\n`
      }
      return ''
    })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('HEAD changed immediately before commit')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('fails after consume when an unapproved path appears in the staged index', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-extra-index', message: 'consume' },
    })
    callConsumeMock.mockResolvedValueOnce({ ok: true })
    buildIndexStateMapMock.mockReturnValueOnce(new Map([
      ...approvedState,
      ['src/unapproved.ts', { absent: false, blobId: 'extra-blob', type: 'regular' as const, mode: '100644' }],
    ]))
    assertIndexMatchesApprovedMock.mockImplementationOnce((_approved, actual) => {
      if (actual.has('src/unapproved.ts')) throw new ChangeDetectionErrorStub('extra staged path')
    })
    mockGitCommitRun(BASE_COMMIT, 'unused')

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(callConsumeMock).toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('fails without committing when residual unstaged or untracked changes remain', async () => {
    mockGitCommitRun(BASE_COMMIT, 'unused')
    assertNoResidualChangesMock.mockImplementationOnce(() => {
      throw new ChangeDetectionErrorStub('residual worktree changes')
    })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('residual worktree changes')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it.each(['blobId', 'type', 'mode'])('fails without committing on an approved/staged %s mismatch', async (field) => {
    mockGitCommitRun(BASE_COMMIT, 'unused')
    assertIndexMatchesApprovedMock.mockImplementationOnce(() => {
      throw new ChangeDetectionErrorStub(`${field} mismatch`)
    })

    const result = await runJob(gitCommitJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain(`${field} mismatch`)
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────
// Gate check 統合テスト (Step 3A)
// ────────────────────────────────────────────────────────────

describe('runJob — Approval Gate integration (Step 3A)', () => {
  it('policy: continue → existing flow executes normally', async () => {
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    const result = await runJob(createJob(), createPolicy())

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

    const result = await runJob(createJob(), createPolicy())

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

    const result = await runJob(createJob(), createPolicy())

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
    const result = await runJob(job, createPolicy())

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
    const result = await runJob(job, createPolicy())

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
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('success')
    expect(resolveCommandMock).toHaveBeenCalled()
    expect(result.gatePolicy).toBeUndefined()
  })

  it('continue policy → safe work check is not applied (all kinds allowed)', async () => {
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'commit', '-m', 'x'], description: 'git commit' })
    // git_commit under 'continue' policy should NOT be blocked
    mockGitCommitRun('abc', 'def')

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'x' } },
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('success')
    expect(result.gatePolicy).toBeUndefined()
  })

  // 2026-08-01: Gate API の技術障害を safe work 継続や承認待ちへ縮退させない。
  // 以前は resolvePolicy(localResult, undefined, apiError) へ渡して
  // continue_safe_work_only へ落としていたため、認証失敗や API 停止でも
  // Job が進んでいた（かつ技術障害が「CEO承認待ち」として通知されていた）。
  it('callGateCheck throws → resolvePolicy を呼ばず technical failure で failed にする', async () => {
    callGateCheckMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await runJob(createJob(), createPolicy())

    expect(resolvePolicyMock).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.technicalFailure).toBe(true)
    expect(result.stderr).toContain('Gate check could not be completed')
    // safe work すら継続しない
    expect(resolveCommandMock).not.toHaveBeenCalled()
    // 承認待ちの blocked に変換しない（自動 resume の対象にしない）
    expect(result.gatePolicy).toBeUndefined()
  })

  it('callGateCheck が 401 で失敗しても CEO 承認待ちとして通知しない', async () => {
    callGateCheckMock.mockRejectedValue(new Error('gate/check: HTTP 401'))

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.technicalFailure).toBe(true)
    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  it('nextAction: proceed → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    const result = await runJob(createJob(), createPolicy())

    expect(callConsumeMock).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
  })

  it('permission guard blocked → Gate check is never called', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'outside TARGET_ROOT',
    })

    await runJob(createJob(), createPolicy())

    expect(callGateCheckMock).not.toHaveBeenCalled()
    expect(resolvePolicyMock).not.toHaveBeenCalled()
  })

  it('blocked result has permissionAllowed=true to distinguish from permission block', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL',
      apiAvailable: true,
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.guardResult.permissionAllowed).toBe(true)
    expect(result.guardResult.fileChangeAllowed).toBe(true)
    expect(result.guardResult.fileViolations).toEqual([])
  })

  it('callGateCheck is called with correct params including taskId and requestedAction', async () => {
    const job = createJob({ taskId: 'task-xyz' })

    await runJob(job, createPolicy({ taskId: 'task-xyz' }))

    expect(callGateCheckMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
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
      const result = await runJob(job, createPolicy())

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

      const result = await runJob(createJob({ safeCommand: { kind, workingDir: '/workspace/target' } }), createPolicy())

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
    }), createPolicy())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('safe work allowed + nextAction: call_consume → callConsume IS called', async () => {
    resolvePolicyMock.mockReturnValue(SAFE_WORK_POLICY)
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, consumedRequestId: 'req-y', message: 'consume' },
    })
    callConsumeMock.mockResolvedValue({ ok: true })

    const result = await runJob(createJob({ safeCommand: { kind: 'test', workingDir: '/workspace/target' } }), createPolicy())

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

    await runJob(createJob(), createPolicy())

    expect(callConsumeMock).toHaveBeenCalledWith(
      'req-001',
      expect.objectContaining({
        jobId: 'job-1',
        currentCommit: expect.any(String),
        currentDiffHash: expect.any(String),
      }),
    )
  })

  it('consume success → existing flow continues (status: success)', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockResolvedValue({ ok: true })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(result.gatePolicy).toBeUndefined()
  })

  it('alreadyConsumed: true → existing flow continues (status: success)', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockResolvedValue({ ok: true, alreadyConsumed: true })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(callConsumeMock).toHaveBeenCalled()
  })

  // 2026-08-01: consume 失敗を「業務上の block」と「技術障害」で分ける。
  // 404 / 409 は API 契約上意味を持つ承認フローの結果なので blocked のまま。
  it('consume が業務上の 409（stale）→ 既存どおり blocked', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(
      new GateClientError('consume(req-abc): HTTP 409 — Approval request is stale', {
        technicalFailure: false,
      }),
    )

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.gatePolicy).toBe('block_until_approved')
    expect(result.gateBlockReason).toContain('consume failed')
    expect(result.gateBlockReason).toContain('409')
    expect(result.technicalFailure).toBeUndefined()
  })

  it('consume が業務上の 404（request 不存在）→ 既存どおり blocked', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(
      new GateClientError('consume(req-abc): HTTP 404 — approval request not found', {
        technicalFailure: false,
      }),
    )

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.technicalFailure).toBeUndefined()
  })

  it('consume が技術障害（401）→ blocked ではなく failed（消費済み扱いにしない）', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(
      new GateClientError('consume(req-abc): HTTP 401', { technicalFailure: true }),
    )

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.technicalFailure).toBe(true)
    expect(result.stderr).toContain('Approval consume could not be completed')
    // 消費できたか不明なまま SafeCommand を実行しない
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('consume が GateClientError 以外の想定外エラー → 安全側で failed', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(new TypeError('unexpected'))

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.technicalFailure).toBe(true)
  })

  it('consume fails → resolveCommand is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    callConsumeMock.mockRejectedValue(new Error('network error'))

    await runJob(createJob(), createPolicy())

    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('nextAction: call_consume without consumedRequestId → blocked', async () => {
    callGateCheckMock.mockResolvedValue({
      ...ALLOW_PROCEED_RESPONSE,
      nextAction: { action: 'call_consume' as const, message: 'missing id' },
    })
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.gateBlockReason).toContain('consumedRequestId is missing')
    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('policy: block_until_approved → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'block_until_approved', reason: 'CRITICAL', apiAvailable: true })

    await runJob(createJob(), createPolicy())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('policy: re_check → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 're_check', reason: 'stale', apiAvailable: true })

    await runJob(createJob(), createPolicy())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('nextAction: proceed → callConsume is NOT called', async () => {
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob(), createPolicy())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('permission guard blocked → callConsume is NOT called', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: false, reason: 'outside TARGET_ROOT' })

    await runJob(createJob(), createPolicy())

    expect(callConsumeMock).not.toHaveBeenCalled()
  })

  it('consume uses same targetCommit and targetDiffHash as gate check', async () => {
    callGateCheckMock.mockResolvedValue(CONSUME_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob(), createPolicy())

    // consume に渡す currentCommit / currentDiffHash は gate check 時と同一値
    const gateCheckParams = callGateCheckMock.mock.calls[0][0]
    // callConsume(requestId, { currentCommit, currentDiffHash }) → calls[0] = [requestId, params]
    const consumeParams = callConsumeMock.mock.calls[0][1]
    expect(consumeParams.jobId).toBe(gateCheckParams.jobId)
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

    await runJob(createJob(), createPolicy())

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
    await runJob(job, createPolicy())

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
    await runJob(job, createPolicy({ taskId: 'task-notif-3d' }))

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
    await runJob(createJob(), createPolicy())
    expect(sendAlertMock).toHaveBeenCalledOnce()

    sendAlertMock.mockClear()

    // 2 回目 (同一 approvalRequestId)
    await runJob(createJob(), createPolicy())
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

    await runJob(createJob(), createPolicy())

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

    await runJob(createJob(), createPolicy())

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

    await runJob(createJob(), createPolicy())

    expect(sendAlertMock).toHaveBeenCalledOnce()
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', sourceType: 'gate_consume_missing_id' }),
    )
  })

  // 8. continue → sendAlert は呼ばれない
  it('continue → sendAlert は呼ばれない', async () => {
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })

    await runJob(createJob(), createPolicy())

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
    await runJob(job, createPolicy())

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
    await runJob(job, createPolicy())

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

    await runJob(createJob(), createPolicy())

    expect(sendAlertMock).not.toHaveBeenCalled()
  })

  // 12. permission guard blocked → sendAlert は呼ばれない
  it('permission guard blocked → sendAlert は呼ばれない', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'outside TARGET_ROOT',
    })

    await runJob(createJob(), createPolicy())

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

    await runJob(createJob(), createPolicy())

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

    const result = await runJob(createJob(), createPolicy())

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
  providerFailureKind: 'provider_timeout'
}> = {}) {
  return {
    taskId: 'task-1',
    provider: 'claude_code' as const,
    exitCode: 0,
    stdout: '{"is_error":false}',
    stderr: '',
    changedFiles: ['src/feature.ts'],
    durationMs: 1000,
    blocked: false,
    ...overrides,
  }
}

describe('structured review contract', () => {
  const approved = {
    status: 'approved',
    summary: 'No blocking findings.',
    findings: [{ severity: 'low', file: 'src/feature.ts', line: 4, message: 'Minor note', rule: 'style' }],
  }

  it('extracts the strict verdict from a Claude Code JSON envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: JSON.stringify(approved),
    })

    expect(parseStructuredReviewOutput(stdout)).toEqual(approved)
  })

  it.each([
    ['unknown status', { ...approved, status: 'approve' }],
    ['unknown severity', { ...approved, findings: [{ severity: 'major', message: 'bad' }] }],
    ['missing summary', { status: 'approved', findings: [] }],
    ['extra top-level field', { ...approved, verdict: 'approved' }],
    ['extra finding field', { ...approved, findings: [{ severity: 'low', message: 'note', extra: true }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseStructuredReviewOutput(JSON.stringify(value))).toBeUndefined()
  })

  it('rejects non-JSON even when it contains a JSON substring', () => {
    expect(parseStructuredReviewOutput(`review result: ${JSON.stringify(approved)}`)).toBeUndefined()
  })

  it('builds a prompt containing every supplied review input without requesting Git execution', () => {
    const prompt = buildStructuredReviewPrompt({
      context: createStructuredReviewContext(),
      baselineHead: BASE_COMMIT,
      changedFiles: ['src/feature.ts'],
      diffText: 'diff --git a/src/feature.ts b/src/feature.ts',
    })

    expect(prompt).toContain('Implement feature A')
    expect(prompt).toContain('Add feature A without changing public APIs.')
    expect(prompt).toContain('tests pass')
    expect(prompt).toContain(BASE_COMMIT)
    expect(prompt).toContain('src/feature.ts')
    expect(prompt).toContain('diff --git a/src/feature.ts b/src/feature.ts')
    expect(prompt).toContain('implementation complete')
    expect(prompt).toContain('"kind": "test"')
    expect(prompt).toContain('Git/Bashその他のツールを実行せず')
  })
})

describe('task-022: AI CLI 実行ブロック', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('aiCliProvider なし → AI CLI をスキップして SafeCommand を実行する', async () => {
    // AI CLI フィールドが未指定の通常 Job
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === 'status') return 'safe output\n'
      return gitFallback(args)
    })
    const job = createJob()
    const result = await runJob(job, createPolicy())

    expect(createAiCliAdapterMock).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
    expect(result.stdout).toBe('safe output\n')
    expect(result.stdout).not.toContain('=== SafeCommand')
  })

  it('aiCliProvider あり・CLI 成功 → SafeCommand も実行される', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult()) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === 'status') return 'safe output\n'
      return gitFallback(args)
    })

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/feature.ts にログ出力を追加してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

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
    expect(result.stdout).toContain('=== AI CLI (claude_code/implement) ===\n{"is_error":false}')
    expect(result.stdout).toContain('=== SafeCommand (git_status) ===\nsafe output\n')
  })

  it('Claude implement で変更0件かつpermission_denialsあり → failedになりSafeCommandを実行しない', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: [],
        stdout: JSON.stringify({
          is_error: false,
          permission_denials: [{
            tool_name: 'Edit',
            tool_input: { file_path: 'src/x.ts', old_string: 'secret-before', new_string: 'secret-after' },
          }],
        }),
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/x.ts を修正してください',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('Claude Code tool permission denied (tools: Edit)')
    expect(result.stderr).not.toContain('secret-before')
    expect(result.stderr).not.toContain('secret-after')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('Claude implement で変更0件かつpermission_denialsなし → no file changesでfailedになる', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: [],
        stdout: '{"is_error":false}',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/x.ts を修正してください',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('implementation produced no file changes')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('Claude implement で変更ありかつpermission_denialsあり → 通常どおりSafeCommandへ進む', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: ['src/x.ts'],
        stdout: JSON.stringify({
          is_error: false,
          permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: 'src/y.ts' } }],
        }),
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/x.ts を修正してください',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('success')
    expect(resolveCommandMock).toHaveBeenCalled()
  })

  it('Claude implement のstdoutが不正なJSON → failedになる', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({ stdout: 'not-json' })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/x.ts を修正してください',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('could not be parsed as JSON')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('Claude implement がis_error:trueを返す → 変更があってもfailedになる', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: ['src/x.ts'],
        stdout: '{"is_error":true}',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'src/x.ts を修正してください',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('Claude Code CLI reported an error result')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('implement でもdryRunなら変更0件チェックの対象外になる', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: [],
        stdout: 'dry-run output is not JSON',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      dryRun: true,
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'dry run',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('success')
    expect(resolveCommandMock).toHaveBeenCalled()
  })

  it('Claude Code以外のimplementで変更0件 → JSON解析せずno file changesでfailedになる', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: [],
        stdout: 'Codex plain text output',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'src/x.ts を修正してください',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('implementation produced no file changes')
    expect(result.stderr).not.toContain('could not be parsed as JSON')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('reviewで変更0件でもstructured verdictがapprovedなら成功する', async () => {
    const verdict = { status: 'approved', summary: 'Approved', findings: [] }
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        changedFiles: [],
        stdout: JSON.stringify({ type: 'result', result: JSON.stringify(verdict) }),
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: '変更をレビューしてください',
      aiCliMode: 'review',
    }), createPolicy(), createStructuredReviewContext())

    expect(result.status).toBe('success')
    expect(result.reviewResult).toEqual(verdict)
    expect(resolveCommandMock).toHaveBeenCalled()
    expect(mockAdapter.run).toHaveBeenCalledWith(expect.objectContaining({
      expectJson: true,
      prompt: expect.stringContaining('[baseline HEAD]'),
    }))
  })

  it.each(['changes_requested', 'rejected'] as const)(
    'review verdict %s is persisted in the result and fails the Job',
    async (status) => {
      const verdict = { status, summary: 'Stop for CEO review', findings: [] }
      const mockAdapter = {
        run: vi.fn().mockResolvedValue(makeCliResult({ stdout: JSON.stringify(verdict) })),
      }
      createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

      const result = await runJob(createJob({
        workflowStepKey: 'implement:implement-job-1:review',
        aiCliProvider: 'claude_code',
        aiCliMode: 'review',
      }), createPolicy(), createStructuredReviewContext())

      expect(result.status).toBe('failed')
      expect(result.reviewResult).toEqual(verdict)
    },
  )

  it('invalid structured review output fails closed without a ReviewResult', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        stdout: JSON.stringify({ status: 'approved', summary: 'Missing findings' }),
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      workflowStepKey: 'implement:implement-job-1:review',
      aiCliProvider: 'claude_code',
      aiCliMode: 'review',
    }), createPolicy(), createStructuredReviewContext())

    expect(result.status).toBe('failed')
    expect(result.reviewResult).toBeUndefined()
    expect(result.stderr).toContain('strict schema validation')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('AI CLI が exitCode !== 0 → status: failed で早期リターン（SafeCommand は実行されない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('compile error')
    // SafeCommand (resolveCommand) は実行されない
    // ※ execFileSyncMock は Gate フェーズの git ヘルパーでも呼ばれるためチェック対象外
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('provider timeoutかつ最終検査でHEAD・manifest・sensitive baselineが不変ならunchangedを伝播する', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        exitCode: 1,
        changedFiles: [],
        providerFailureKind: 'provider_timeout',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'Implement the approved change.',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.providerFailureKind).toBe('provider_timeout')
    expect(result.workspaceState).toBe('unchanged')
  })

  it.each([
    ['tracked', { path: 'src/tracked.ts', kind: 'modified' as const, afterType: 'regular' as const }],
    ['staged', { path: 'src/staged.ts', kind: 'modified' as const, afterType: 'regular' as const }],
    ['untracked', { path: 'src/untracked.ts', kind: 'added' as const, afterType: 'regular' as const }],
  ])('provider timeout後に%s変更があればworkspaceState=changedを伝播する', async (_label, change) => {
    buildWorktreeManifestMock
      .mockReturnValueOnce({ changes: [], paths: [] })
      .mockReturnValueOnce({ changes: [change], paths: [change.path] })
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        exitCode: 1,
        changedFiles: [change.path],
        providerFailureKind: 'provider_timeout',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'Implement the approved change.',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.providerFailureKind).toBe('provider_timeout')
    expect(result.workspaceState).toBe('changed')
  })

  it('provider timeout後にpath差分のない空commitでHEADだけ変化してもworkspaceState=changedになる', async () => {
    let headReadCount = 0
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args[0] === 'rev-parse' && !args.includes('--abbrev-ref')) {
        headReadCount += 1
        return headReadCount === 1 ? BASE_COMMIT : 'emptycommit000000000000000000000000000000'
      }
      return ''
    })
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        exitCode: 1,
        changedFiles: [],
        providerFailureKind: 'provider_timeout',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'Implement the approved change.',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.changedFiles).toEqual([])
    expect(result.workspaceState).toBe('changed')
  })

  it('provider timeout後にsensitive baseline差分だけがあってもworkspaceState=changedになる', async () => {
    diffSensitiveBaselineMock.mockReturnValueOnce([{
      path: '.env',
      kind: 'modified',
      beforeType: 'regular',
      afterType: 'regular',
    }])
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        exitCode: 1,
        changedFiles: [],
        providerFailureKind: 'provider_timeout',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'Implement the approved change.',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.changedFiles).toContain('.env')
    expect(result.workspaceState).toBe('changed')
  })

  it('provider timeout後のfinal inspection失敗はworkspaceState=unknownになる', async () => {
    buildWorktreeManifestMock
      .mockReturnValueOnce({ changes: [], paths: [] })
      .mockImplementationOnce(() => {
        throw new ChangeDetectionErrorStub('inspection failed')
      })
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        exitCode: 1,
        changedFiles: [],
        providerFailureKind: 'provider_timeout',
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const result = await runJob(createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'Implement the approved change.',
      aiCliMode: 'implement',
    }), createPolicy())

    expect(result.detectionFailure).toBe(true)
    expect(result.providerFailureKind).toBe('provider_timeout')
    expect(result.workspaceState).toBe('unknown')
  })

  it('AI CLI が blocked: true → status: failed で早期リターン', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 0, blocked: true })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'JSON をパースして返してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

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
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toContain('TARGET_ROOT')
    expect(resolveCommandMock).not.toHaveBeenCalled()
  })

  it('dryRun: true → AI CLI にも dryRun: true が伝搬する', async () => {
    const mockAdapter = {
      run: vi.fn().mockResolvedValue(makeCliResult({
        stdout: JSON.stringify({ status: 'approved', summary: 'dry run', findings: [] }),
      })),
    }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      dryRun: true,
      aiCliProvider: 'codex',
      aiCliPrompt: 'テスト実行だけ',
      aiCliMode: 'review',
    })
    await runJob(job, createPolicy(), createStructuredReviewContext())

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
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('docsのみの変更 → approvalLevelResultがmechanical_onlyになる', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') return '+# タイトル\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(result.approvalLevelResult).toBeDefined()
    expect(result.approvalLevelResult?.reviewPolicy).toBe('mechanical_only')
    expect(result.approvalLevelResult?.level).toBe(0)
  })

  it('jobRunner.ts自体を変更するJob → approvalLevelResultがfull_pre_post_reviewになる（level:2）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'apps/worker/src/jobRunner.ts\n'
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') return '+const x = 1\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(result.approvalLevelResult?.reviewPolicy).toBe('full_pre_post_review')
    expect(result.approvalLevelResult?.level).toBe(2)
  })

  it('postTestHook.ps1を変更するJob（Mechanical Gate hit）→ reviewPolicyはceo_requiredだが、Jobはまだブロックされない', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'apps/worker/scripts/postTestHook.ps1\n'
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') return '+Write-Host "test"\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

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

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.approvalLevelResult).toBeUndefined()
  })

  it('既存Approval Gateがblock_until_approvedの場合、approvalLevelResultはundefinedのまま（判定に到達しない）', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.approvalLevelResult).toBeUndefined()
  })

  it('AI CLI失敗時のJobRunResultにもapprovalLevelResultが含まれる', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return gitFallback(args)
    })

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

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
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('TARGET_ROOT外のworkingDirを持つJobは、permissionGuardでblockedされる（jobRunnerがtarget_project以外を評価することはない）', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'workingDir is outside TARGET_ROOT',
    })

    const job = createJob({
      safeCommand: { kind: 'git_status', workingDir: '/workspace/control' },
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.guardResult.permissionReason).toBe('workingDir is outside TARGET_ROOT')
    // permissionGuardの時点でblockedのため、Approval Level v2判定にも到達しない
    expect(result.approvalLevelResult).toBeUndefined()
  })

  it('TARGET_ROOT配下のworkingDirを持つ通常Jobは、既存フロー通り継続する（target_project前提の回帰確認）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/index.ts\n'
      return gitFallback(args)
    })

    const job = createJob({
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    })
    const result = await runJob(job, createPolicy())

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
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('通常の変更（docs/README.md）→ targetProjectRiskScanResult.hasRisk:false', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(result.targetProjectRiskScanResult).toBeDefined()
    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(false)
  })

  it('.env を含む変更 → targetProjectRiskScanResult.hasRisk:true、ただしstatusはsuccessのまま（停止しない）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(true)
    expect(result.targetProjectRiskScanResult?.issues.some(issue => issue.id === 'ENV_FILE_CHANGED')).toBe(true)
  })

  it('AI CLI経由で.envを変更するJob → AI CLI実行後のchangedFilesを対象にscanされる', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ changedFiles: ['.env'] })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: '設定を追加してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('success')
    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(true)
  })

  it('AI CLI失敗時も、残った変更に対する Risk Scan は実行される（内容検査を欠落させない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    // 2026-07-31 修正: AI 失敗経路でも Guard に加えて Risk Scan を実行し、
    // 内容ベースの検査結果を JobRunResult へ残す
    expect(result.targetProjectRiskScanResult).toBeDefined()
  })

  it('permissionGuardでblockedの場合、targetProjectRiskScanResultはundefinedのまま', async () => {
    permissionGuardWithGrantsMock.mockResolvedValue({
      allowed: false,
      reason: 'denied',
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.targetProjectRiskScanResult).toBeUndefined()
  })

  it('既存Approval Gateがblock_until_approvedの場合、targetProjectRiskScanResultはundefinedのまま', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.targetProjectRiskScanResult).toBeUndefined()
  })

  it('hasRisk:trueでもJobのstatusはblockedにならない（観察モードであることの確認）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'Dockerfile\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.targetProjectRiskScanResult?.hasRisk).toBe(true)
    expect(result.status).not.toBe('blocked')
  })
})

describe('Risk Scan Console Warning（観察モード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('.env を含む変更 → console.warnが呼ばれ、Target Project Risk Scan summaryを含む', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    await runJob(createJob(), createPolicy())

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Target Project Risk Scan]'))

    warnSpy.mockRestore()
  })

  it('通常の変更（src/index.ts）→ console.warnが呼ばれない（hasRisk:falseのため）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/index.ts\n'
      return gitFallback(args)
    })

    await runJob(createJob(), createPolicy())

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Target Project Risk Scan]'))

    warnSpy.mockRestore()
  })

  it('AI CLI失敗時 → console.warnが呼ばれない（scanポイントに到達しないため）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    await runJob(job, createPolicy())

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Target Project Risk Scan]'))

    warnSpy.mockRestore()
  })

  it('既存Approval Gateがblock_until_approvedの場合 → console.warnが呼ばれない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    await runJob(createJob(), createPolicy())

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Target Project Risk Scan]'))

    warnSpy.mockRestore()
  })

  it('console.warnが呼ばれても、statusはblockedにならない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Target Project Risk Scan]'))
    expect(result.status).not.toBe('blocked')

    warnSpy.mockRestore()
  })
})

describe('Gemini Flash Stepレビュー接続（Step R3・観察モード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('リスクなしの変更（Risk Scan severity: none）→ runStepReviewは呼ばれず、stepReviewResult.status:not_run', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(runStepReviewMock).not.toHaveBeenCalled()
    expect(result.stepReviewResult?.status).toBe('not_run')
  })

  it('Risk Scan severity: medium（.env変更）→ runStepReviewが呼ばれ、結果がJobRunResultに含まれる', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })
    runStepReviewMock.mockResolvedValue({
      status: 'done',
      importance: 'medium',
      routing: 'proceed_candidate',
      summary: '軽微な懸念のみ',
      concerns: [],
      requiredFixes: [],
      escalationReason: null,
      confidence: 0.8,
      generatedAt: '2026-01-01T00:00:00.000Z',
      rawResponse: '',
    })

    const result = await runJob(createJob(), createPolicy())

    expect(runStepReviewMock).toHaveBeenCalledTimes(1)
    expect(result.stepReviewResult?.status).toBe('done')
    expect(result.stepReviewResult?.importance).toBe('medium')
    expect(result.status).toBe('success')
  })

  it('Gemini呼び出しが失敗（quota枯渇等）してもJobのstatusはsuccessのまま（Jobを止めない）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })
    runStepReviewMock.mockResolvedValue({
      status: 'failed',
      summary: 'Stepレビュー呼び出しに失敗しました: quota exhausted',
      concerns: [],
      requiredFixes: [],
      escalationReason: null,
      confidence: 0,
      generatedAt: '2026-01-01T00:00:00.000Z',
      rawResponse: '',
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(result.stepReviewResult?.status).toBe('failed')
  })

  it('AI CLI失敗時、stepReviewResultはundefinedのまま（scanポイントに到達しない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stepReviewResult).toBeUndefined()
    expect(runStepReviewMock).not.toHaveBeenCalled()
  })

  it('既存Approval Gateがblock_until_approvedの場合、stepReviewResultはundefinedのまま', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.stepReviewResult).toBeUndefined()
    expect(runStepReviewMock).not.toHaveBeenCalled()
  })
})

describe('postReviewer接続（Step R4-A・観察モード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('Risk Scan severity: medium + aiCliProviderあり → runPostReviewが呼ばれ、結果がJobRunResultに含まれる', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ changedFiles: ['.env'] })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    runPostReviewMock.mockResolvedValue({
      jobId: 'job-1',
      taskId: 'task-1',
      reviewerResult: {
        provider: 'gemini',
        phase: 'post',
        verdict: 'approved',
        summary: '整合している',
        issues: [],
        confidence: 0.9,
        generatedAt: '2026-01-01T00:00:00.000Z',
        rawResponse: '',
      },
      alignmentVerdict: 'aligned',
      blocked: false,
      decidedAt: '2026-01-01T00:00:00.000Z',
    })

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: '.envに設定を追加してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(runPostReviewMock).toHaveBeenCalledTimes(1)
    expect(result.postReviewResult?.alignmentVerdict).toBe('aligned')
    expect(result.status).toBe('success')
  })

  it('Risk Scan severity: low/none → runPostReviewは呼ばれず、postReviewResultはundefined', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(runPostReviewMock).not.toHaveBeenCalled()
    expect(result.postReviewResult).toBeUndefined()
  })

  it('severity: medium だが job.aiCliProvider がない → runPostReviewは呼ばれず、postReviewResultはundefined', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(runPostReviewMock).not.toHaveBeenCalled()
    expect(result.postReviewResult).toBeUndefined()
  })

  it('runPostReviewが例外を投げても（実装AIとレビューAIが同一等）catchされ、Jobはsuccess継続', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ changedFiles: ['.env'] })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)
    runPostReviewMock.mockRejectedValue(
      new Error('[reviewerAdapter] 実装AI(gemini)とレビューAI(gemini)が同一です。分離ルールに違反しています。'),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const job = createJob({
      aiCliProvider: 'claude_code',
      aiCliPrompt: '.envに設定を追加してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('success')
    expect(result.postReviewResult).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('postReviewer呼び出し失敗'))

    warnSpy.mockRestore()
  })

  it('AI CLI失敗時、postReviewResultはundefinedのまま（scanポイントに到達しない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    expect(result.postReviewResult).toBeUndefined()
    expect(runPostReviewMock).not.toHaveBeenCalled()
  })

  it('既存Approval Gateがblock_until_approvedの場合、postReviewResultはundefinedのまま', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.postReviewResult).toBeUndefined()
    expect(runPostReviewMock).not.toHaveBeenCalled()
  })
})

describe('Review Observation Log 接続（観察結果の最小永続化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('観察対象（Risk Scan/Step Review/postReview）計算後にappendObservationLogが1回呼ばれる', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(appendObservationLogMock).toHaveBeenCalledTimes(1)
    expect(appendObservationLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', taskId: 'task-1' }),
    )
    expect(result.status).toBe('success')
  })

  it('AI CLI失敗時（scanポイントに到達しない）は、appendObservationLogは呼ばれない', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    await runJob(job, createPolicy())

    expect(appendObservationLogMock).not.toHaveBeenCalled()
  })
})

describe('safetyVerifier接続（Step R4-B・観察モード）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAlertMock.mockResolvedValue([])
    callGateCheckMock.mockResolvedValue(ALLOW_PROCEED_RESPONSE)
    resolvePolicyMock.mockReturnValue({ policy: 'continue', reason: 'ok', apiAvailable: true })
    permissionGuardWithGrantsMock.mockResolvedValue({ allowed: true })
    resolveCommandMock.mockReturnValue({ argv: ['git', 'status', '--short'], description: 'git status' })
    fileChangeGuardMock.mockReturnValue({ allowed: true, violations: [], reasons: {} })
    execFileSyncMock.mockImplementation((_c: string, a: readonly string[] | undefined) => gitFallback(a))
  })

  it('Risk Scan severity: medium → safetyVerificationResultが計算され、JobRunResultに含まれる', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.safetyVerificationResult).toBeDefined()
    expect(result.safetyVerificationResult?.checks).toHaveLength(12)
    expect(result.status).toBe('success')
  })

  it('overallPassed:falseであってもJobのstatusはsuccessのまま（観察モードであることの確認）', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return '.env\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    // typecheck/test実行結果を渡していないため、TYPECHECK/RELATED_TESTS/FULL_TESTSがfail-closedになり
    // overallPassedはfalseになる想定（危険検出ではなく未接続項目による）。それでもJobは止めない。
    expect(result.safetyVerificationResult?.overallPassed).toBe(false)
    expect(result.safetyVerificationResult?.blockingFailures).toEqual(
      expect.arrayContaining(['TYPECHECK', 'RELATED_TESTS', 'FULL_TESTS']),
    )
    expect(result.status).toBe('success')
  })

  it('Risk Scan severity: low/none → safetyVerificationResultは呼ばれずundefinedのまま', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'docs/README.md\n'
      return gitFallback(args)
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.safetyVerificationResult).toBeUndefined()
  })

  it('AI CLI失敗時、safetyVerificationResultはundefinedのまま（scanポイントに到達しない）', async () => {
    const mockAdapter = { run: vi.fn().mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'compile error' })) }
    createAiCliAdapterMock.mockReturnValue(mockAdapter as any)

    const job = createJob({
      aiCliProvider: 'codex',
      aiCliPrompt: 'バグを修正してください',
      aiCliMode: 'implement',
    })
    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    expect(result.safetyVerificationResult).toBeUndefined()
  })

  it('既存Approval Gateがblock_until_approvedの場合、safetyVerificationResultはundefinedのまま', async () => {
    resolvePolicyMock.mockReturnValue({
      policy: 'block_until_approved',
      reason: 'CRITICAL risk — CEO approval required',
      apiAvailable: true,
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('blocked')
    expect(result.safetyVerificationResult).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────
// 変更ファイル検出契約（2026-07-31 critical 修正）
// ────────────────────────────────────────────────────────────

describe('変更ファイル検出契約', () => {
  it('Task と Job の Project が一致しない場合、AI 実行前に failed で停止する', async () => {
    const job = createJob({ projectId: 'project-other' })

    const result = await runJob(job, createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toMatch(/Project が一致しません/)
    // AI 実行にも Gate にも到達しない
    expect(callGateCheckMock).not.toHaveBeenCalled()
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('Task ポリシーの taskId が Job と一致しない場合も AI 実行前に停止する', async () => {
    const result = await runJob(createJob(), createPolicy({ taskId: 'task-mismatch' }))

    expect(result.status).toBe('failed')
    expect(result.stderr).toMatch(/task policy mismatch/i)
    expect(callGateCheckMock).not.toHaveBeenCalled()
  })

  it('変更検出に失敗した場合は blocked ではなく failed で fail-closed になる', async () => {
    buildWorktreeManifestMock.mockImplementationOnce(() => {
      throw new ChangeDetectionErrorStub('git status parse failed')
    })

    const result = await runJob(createJob(), createPolicy())

    expect(result.status).toBe('failed')
    expect(result.stderr).toMatch(/変更ファイル検出/)
    // 技術的失敗は detectionFailure で表す。
    // fileChangeAllowed を false にすると index.ts が blocked（承認・手動resume待ち）へ
    // 変換してしまい、Guard 違反と区別できなくなるため false にしない。
    expect(result.detectionFailure).toBe(true)
    expect(result.guardResult.fileChangeAllowed).toBe(true)
  })

  it('File Change Guard へは string[] ではなく manifest と実行時ポリシーを渡す', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/a.ts\n'
      return gitFallback(args)
    })

    await runJob(createJob(), createPolicy({ allowedPaths: ['src'] }))

    expect(fileChangeGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ paths: expect.arrayContaining(['src/a.ts']) }),
      expect.objectContaining({ allowedPaths: ['src'] }),
      '/workspace/target',
    )
  })

  it('SafeCommand が実行中に作った新規ファイルも最終検査の対象になる（Stage B）', async () => {
    // SafeCommand 実行前は空、実行後に新規ファイルが現れるケース
    buildWorktreeManifestMock
      .mockReturnValueOnce({ changes: [], paths: [] })   // pre-gate
      .mockReturnValueOnce({ changes: [], paths: [] })   // Stage A（AI作業後）
      .mockReturnValueOnce({                              // Stage B（SafeCommand実行後）
        changes: [{ path: 'build/generated.env', kind: 'added', afterType: 'regular' }],
        paths: ['build/generated.env'],
      })

    await runJob(createJob(), createPolicy())

    const lastCall = fileChangeGuardMock.mock.calls[fileChangeGuardMock.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ paths: ['build/generated.env'] }),
    )
  })

  it('commit 後に working tree 差分が空でも commit tree の変更を最終検査する（Stage C）', async () => {
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
    // beforeCommitHash / afterCommitHash が変わる = commit が作られた
    mockGitCommitRun('before111', 'after222')
    // Approval Gate時点では承認対象があり、その後はcommit済みなのでworking treeはクリーン。
    buildWorktreeManifestMock
      .mockReturnValueOnce({
        changes: [{ path: 'src/approved.ts', kind: 'modified', afterType: 'regular', afterMode: '100644' }],
        paths: ['src/approved.ts'],
      })
      .mockReturnValue({ changes: [], paths: [] })
    // commit tree には禁止ファイルが含まれる
    buildCommitRangeManifestMock.mockReturnValue({
      changes: [{ path: '.env', kind: 'added', afterType: 'regular' }],
      paths: ['.env'],
    })

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })
    await runJob(job, createPolicy())

    expect(buildCommitRangeManifestMock).toHaveBeenCalled()
    const lastCall = fileChangeGuardMock.mock.calls[fileChangeGuardMock.mock.calls.length - 1]
    expect(lastCall[0].paths).toContain('.env')
  })

  it('Stage A 後に SafeCommand が同じ path の内容を変更して commit しても最終 commit diff で検出する', async () => {
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
    mockGitCommitRun('before111', 'after222')
    // Stage A では安全な内容だった同じ path が、commit tree では別 blob になっている
    buildWorktreeManifestMock
      .mockReturnValueOnce({
        changes: [{ path: 'src/app.ts', kind: 'modified', afterType: 'regular', afterMode: '100644' }],
        paths: ['src/app.ts'],
      })
      .mockReturnValue({ changes: [], paths: [] })
    buildCommitRangeManifestMock.mockReturnValue({
      changes: [
        {
          path: 'src/app.ts',
          kind: 'modified',
          afterType: 'regular',
          beforeHash: 'aaaaaaa',
          afterHash: 'bbbbbbb',
        },
      ],
      paths: ['src/app.ts'],
    })

    const job = createJob({
      safeCommand: { kind: 'git_commit', workingDir: '/workspace/target', params: { commitMessage: 'test' } },
    })
    const result = await runJob(job, createPolicy())

    // 最終検査は commit tree 由来の manifest（blob hash 付き）を使う
    const lastCall = fileChangeGuardMock.mock.calls[fileChangeGuardMock.mock.calls.length - 1]
    const committedChange = lastCall[0].changes.find((c: { path: string }) => c.path === 'src/app.ts')
    expect(committedChange?.afterHash).toBe('bbbbbbb')
    expect(result.finalChangeManifest?.paths).toContain('src/app.ts')
  })

  it('ignored な機密ファイルの変化を manifest へ合流させる', async () => {
    scanSensitiveFilesMock
      .mockReturnValueOnce(new Map())  // Job 開始時ベースライン: .env は存在しない
    diffSensitiveBaselineMock.mockReturnValue([
      { path: '.env', kind: 'added', afterType: 'regular' },
    ])

    await runJob(createJob(), createPolicy())

    const lastCall = fileChangeGuardMock.mock.calls[fileChangeGuardMock.mock.calls.length - 1]
    expect(lastCall[0].paths).toContain('.env')
  })
})

// ────────────────────────────────────────────────────────────
// Shadow Commit Gate（Phase 1・観察モード）の配線検証
// - git_commit Job のみで evaluateCommitGate() が呼ばれること
// - allowed:false を返しても実際の Job 結果に影響しないこと
// - shadow gate 内部エラーでも Job が壊れないこと（try/catch）
// ────────────────────────────────────────────────────────────
describe('Shadow Commit Gate (Phase 1 observation wiring)', () => {
  // ファイル内の先行テストが diffSensitiveBaseline / scanSensitiveFiles に設定した
  // 実装は clearAllMocks では消えないため、この describe 内では benign な既定値へ固定する
  // （'.env' が manifest に合流すると Risk Scan severity が medium になり、
  //   本テストの目的と無関係に safetyVerifier が実行されてしまう）。
  beforeEach(() => {
    scanSensitiveFilesMock.mockReturnValue(new Map())
    diffSensitiveBaselineMock.mockReturnValue([])
  })

  function gitCommitShadowJob(): Job {
    return createJob({
      safeCommand: {
        kind: 'git_commit',
        workingDir: '/workspace/target',
        params: { commitMessage: 'test' },
      },
    })
  }

  function setupSuccessfulGitCommit(): void {
    resolveCommandMock.mockReturnValue({
      argv: ['git', 'commit', '-m', 'test'],
      description: 'git commit',
    })
    mockGitCommitRun(BASE_COMMIT, 'aftercommit000000000000000000000000000000')
  }

  it('git_commit Job で SafeCommand 実行前に1回だけ呼ばれ、3つの観察成果物を渡す', async () => {
    setupSuccessfulGitCommit()

    const result = await runJob(gitCommitShadowJob(), createPolicy())

    expect(result.status).toBe('success')
    expect(evaluateCommitGateMock).toHaveBeenCalledTimes(1)
    expect(evaluateCommitGateMock).toHaveBeenCalledWith({
      jobId: 'job-1',
      taskId: 'task-1',
      approvalLevelResult: expect.objectContaining({
        jobId: 'job-1',
        taskId: 'task-1',
        // target_project向けファイルは分類器の既知パターンに一致せず
        // UNMATCHED_FALLBACK → Level3/ceo_required になる（Phase 1では期待通りの観測値）
        level: 3,
        reviewPolicy: 'ceo_required',
      }),
      preReviewResult: undefined,
      postReviewResult: undefined,
      safetyVerificationResult: undefined,
    })
    // 配線位置の証明: shadow gate は SafeCommand（resolveCommand→execFileSync）より前に走る
    expect(evaluateCommitGateMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveCommandMock.mock.invocationCallOrder[0],
    )
  })

  it('非git_commit Job（test等）では呼ばれない', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if (Array.isArray(args) && args.includes('--name-only')) return 'src/a.ts\n'
      return gitFallback(args)
    })

    const job = createJob({
      safeCommand: { kind: 'test' as never, workingDir: '/workspace/target' },
    })
    await runJob(job, createPolicy())

    expect(evaluateCommitGateMock).not.toHaveBeenCalled()
  })

  it('allowed:false を返しても Job の status / commitHash は変わらない', async () => {
    setupSuccessfulGitCommit()
    evaluateCommitGateMock.mockReturnValue(makeShadowGateResult({
      allowed: false,
      reviewPolicy: 'ceo_required',
      blockingReasons: [
        'reviewPolicy が ceo_required のため、CEOの事前承認なしに自動commitできません',
      ],
    }))

    const result = await runJob(gitCommitShadowJob(), createPolicy())

    expect(evaluateCommitGateMock).toHaveBeenCalledOnce()
    expect(result.status).toBe('success')
    expect(result.commitHash).toBe('aftercommit000000000000000000000000000000')
  })

  it('shadow gate 内部で例外が起きても Job は成功し、警告ログのみ残る', async () => {
    setupSuccessfulGitCommit()
    evaluateCommitGateMock.mockImplementation(() => {
      throw new Error('shadow gate internal error')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await runJob(gitCommitShadowJob(), createPolicy())

      expect(result.status).toBe('success')
      expect(result.commitHash).toBe('aftercommit000000000000000000000000000000')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Shadow Commit Gate'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('jobId=job-1'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('観察ログには Shadow Commit Gate の主要フィールドと実Gate比較が出力される', async () => {
    setupSuccessfulGitCommit()
    evaluateCommitGateMock.mockReturnValue(makeShadowGateResult({
      allowed: false,
      reviewPolicy: 'ceo_required',
      blockingReasons: ['reviewPolicy が ceo_required'],
    }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await runJob(gitCommitShadowJob(), createPolicy())

      const shadowLog = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(message => message.includes('Shadow Commit Gate (observation only'))
      expect(shadowLog).toBeDefined()
      expect(shadowLog).toContain('allowed=false')
      expect(shadowLog).toContain('reviewPolicy=ceo_required')

      const comparisonLog = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(message => message.includes('real-gate comparison'))
      expect(comparisonLog).toBeDefined()
      // 実Gateの判定（ALLOW_PROCEED_RESPONSE相当）が併記されていること
      expect(comparisonLog).toContain('decision=ALLOW')
      expect(comparisonLog).toContain('riskLevel=LOW')
    } finally {
      logSpy.mockRestore()
    }
  })
})
