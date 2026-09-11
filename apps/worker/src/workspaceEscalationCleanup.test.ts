/**
 * M1（`workspace-dirty-leakage-cleanup`）の実 git 検証。
 *
 * 【何を証明するか】escalate（= repair を作らずこの失敗を確定させる判断）が確定した
 * Job の変更が共有 workspace に残らず、**次の normal Job が admission できる**こと。
 * これが成り立たないと、以後すべての新規 Task が
 * `normal Job requires a clean worktree but found N changed path(s)` で死に、
 * 人間の手動 git 操作でしか復旧できない（2026-09-08 production 実測の再発防止）。
 *
 * 掃除そのものは既存の `revertBlockedJobChanges()` に委ねている。ここで固定するのは
 * 「いつ呼ばれるか」と「repair が継承する経路を壊していないか」である。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@ai-team/shared'
import type { JobRunResult } from './jobRunner.js'

const outboxMocks = vi.hoisted(() => ({
  recordPending: vi.fn(() => ({ eventId: 'evt-1', payloadHash: 'hash-1' })),
  deletePending: vi.fn(),
  resendPending: vi.fn(),
  hasPending: vi.fn(() => false),
}))

const notifierMocks = vi.hoisted(() => ({ sendAlert: vi.fn(async () => undefined) }))
const watchdogMocks = vi.hoisted(() => ({ startWatchdog: vi.fn() }))

vi.mock('./outbox/outboxStore.js', () => outboxMocks)
vi.mock('./notifier/notifier.js', () => notifierMocks)
vi.mock('./watchdog/watchdog.js', () => watchdogMocks)
vi.mock('./execution/runContainedCommand.js', async () => {
  const { createContainedCommandMock } = await import('./execution/containedCommandTestBridge.js')
  return createContainedCommandMock()
})

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', shell: false })
}

function write(relativePath: string, content: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

function headHash(): string {
  return git('rev-parse', 'HEAD').trim()
}

/** 共有 workspace を次に使う normal Job（新しい Task の初回 implement）。 */
function normalJob(): Job {
  return {
    id: 'next-job',
    taskId: 'next-task',
    projectId: 'p1',
    agentRole: 'developer_ai',
    status: 'queued',
    workflowStepKey: 'task:next-task:initial-implement',
    safeCommand: { kind: 'test', workingDir: repo, params: {} },
    createdAt: new Date().toISOString(),
  } as unknown as Job
}

/** escalate された Job の実行結果（AI CLI 失敗後の検査を終えた形）。 */
async function failedResultWithChanges(startCommitHash: string, preChangedPaths: string[]): Promise<JobRunResult> {
  const { buildWorktreeManifest } = await import('./guards/changeManifest.js')
  return {
    status: 'failed',
    exitCode: 1,
    guardResult: {
      permissionAllowed: true,
      permissionReason: undefined,
      fileChangeAllowed: true,
      fileViolations: [],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    changedFiles: buildWorktreeManifest(repo).paths,
    finalChangeManifest: buildWorktreeManifest(repo),
    workspaceCleanup: { workingDir: repo, startCommitHash, preChangedPaths },
  } as JobRunResult
}

beforeEach(() => {
  vi.clearAllMocks()
  outboxMocks.recordPending.mockReturnValue({ eventId: 'evt-1', payloadHash: 'hash-1' })
  repo = mkdtempSync(path.join(tmpdir(), 'workspace-escalation-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('base.txt', 'baseline\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('escalate 時の共有 workspace 後始末', () => {
  it('escalate が確定すると、その Job の変更が取り消され、次の normal Job が admission できる', async () => {
    const { persistJobResult } = await import('./index.js')
    const { computeWorkspaceBaseline } = await import('./jobRunner.js')

    const startCommitHash = headHash()

    // 失敗した implement Job が残した変更（production で観測したのは untracked ディレクトリ）。
    write('base.txt', 'half-finished edit\n')
    write('e2e/spec.txt', 'created by the failed job\n')

    // 掃除前は、次の normal Job は clean worktree 要件で admission できない。
    const before = computeWorkspaceBaseline(normalJob(), repo)
    expect(before.ok).toBe(false)
    if (!before.ok) expect(before.reason).toContain('clean worktree')

    const result = await failedResultWithChanges(startCommitHash, [])
    await persistJobResult('job-a', result, 'failed', {
      // API が escalate を確定した応答。
      patchJob: async () => ({ ok: true, workspaceCleanupRequired: true }),
    })

    // 掃除後は admission できる。これが本 Finding の完了条件そのもの。
    const after = computeWorkspaceBaseline(normalJob(), repo)
    expect(after.ok).toBe(true)
    expect(git('status', '--porcelain').trim()).toBe('')
    expect(existsSync(path.join(repo, 'e2e/spec.txt'))).toBe(false)
  })

  it('escalate されていない（repair が継承する）場合は掃除しない', async () => {
    const { persistJobResult } = await import('./index.js')

    const startCommitHash = headHash()
    write('src.txt', 'work in progress\n')

    const result = await failedResultWithChanges(startCommitHash, [])
    await persistJobResult('job-a', result, 'failed', {
      // repair を queue した応答にはフラグが付かない。
      patchJob: async () => ({ ok: true }),
    })

    // repair / retry / resume は INTENTIONALLY-DIRTY としてこの状態を正統に継承する。
    expect(existsSync(path.join(repo, 'src.txt'))).toBe(true)
  })

  it('素の boolean を返す既存呼び出し元とは後方互換（掃除しない）', async () => {
    const { persistJobResult } = await import('./index.js')

    const startCommitHash = headHash()
    write('src.txt', 'work in progress\n')

    const result = await failedResultWithChanges(startCommitHash, [])
    await persistJobResult('job-a', result, 'failed', { patchJob: async () => true })

    expect(existsSync(path.join(repo, 'src.txt'))).toBe(true)
  })

  it('Job 開始前から存在した変更（preChangedPaths）には escalate でも触れない', async () => {
    const { persistJobResult } = await import('./index.js')

    // Job 開始**前**から dirty だった path。
    write('pre-existing.txt', 'not this job\n')
    const startCommitHash = headHash()

    write('mine.txt', 'created by the failed job\n')

    const result = await failedResultWithChanges(startCommitHash, ['pre-existing.txt'])
    await persistJobResult('job-a', result, 'failed', {
      patchJob: async () => ({ ok: true, workspaceCleanupRequired: true }),
    })

    expect(existsSync(path.join(repo, 'mine.txt'))).toBe(false)
    expect(readFileSync(path.join(repo, 'pre-existing.txt'), 'utf-8')).toBe('not this job\n')
  })

  it('HEAD が Job 開始時から動いていれば取り消さず、CRITICAL 通知を出す（fail-open しない）', async () => {
    const { persistJobResult } = await import('./index.js')

    const startCommitHash = headHash()
    write('committed.txt', 'committed by the job itself\n')
    git('add', '-A')
    git('commit', '-qm', 'job made a commit')
    write('left-over.txt', 'still dirty\n')

    const result = await failedResultWithChanges(startCommitHash, [])
    await persistJobResult('job-a', result, 'failed', {
      patchJob: async () => ({ ok: true, workspaceCleanupRequired: true }),
      alert: notifierMocks.sendAlert,
    })

    // 履歴を書き換えるような復元はしない（既存 helper の skip 条件をそのまま維持）。
    expect(existsSync(path.join(repo, 'left-over.txt'))).toBe(true)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Workspace cleanup incomplete after escalation' }),
    )
  })

  it('変更検出に失敗して manifest が無い結果では掃除しない（帰属不能なものを消さない）', async () => {
    const { persistJobResult } = await import('./index.js')

    write('unknown.txt', 'who made this?\n')

    const result = {
      status: 'failed',
      exitCode: 1,
      guardResult: {
        permissionAllowed: true,
        permissionReason: undefined,
        fileChangeAllowed: true,
        fileViolations: [],
      },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      detectionFailure: true,
    } as JobRunResult

    await persistJobResult('job-a', result, 'failed', {
      patchJob: async () => ({ ok: true, workspaceCleanupRequired: true }),
    })

    expect(existsSync(path.join(repo, 'unknown.txt'))).toBe(true)
  })

  it('PATCH が失敗した結果では掃除しない（Outbox 再送で結果が生き残るため）', async () => {
    const { persistJobResult } = await import('./index.js')

    const startCommitHash = headHash()
    write('src.txt', 'work in progress\n')

    const result = await failedResultWithChanges(startCommitHash, [])
    await persistJobResult('job-a', result, 'failed', {
      patchJob: async () => ({ ok: false, workspaceCleanupRequired: true }),
    })

    expect(existsSync(path.join(repo, 'src.txt'))).toBe(true)
  })

  it('同じ結果で二度掃除しても状態は変わらない（duplicate cleanup 耐性）', async () => {
    const { persistJobResult } = await import('./index.js')
    const { computeWorkspaceBaseline } = await import('./jobRunner.js')

    const startCommitHash = headHash()
    write('base.txt', 'half-finished edit\n')
    write('e2e/spec.txt', 'created by the failed job\n')

    const result = await failedResultWithChanges(startCommitHash, [])
    const escalated = { patchJob: async () => ({ ok: true, workspaceCleanupRequired: true }) }

    await persistJobResult('job-a', result, 'failed', escalated)
    await persistJobResult('job-a', result, 'failed', escalated)

    expect(computeWorkspaceBaseline(normalJob(), repo).ok).toBe(true)
    expect(git('status', '--porcelain').trim()).toBe('')
  })
})
