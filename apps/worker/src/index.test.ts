import type { Job, Task } from '@ai-team/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRunResult } from './jobRunner.js'
import { ContainmentInfrastructureError } from './execution/runContainedCommand.js'

const outboxMocks = vi.hoisted(() => ({
  recordPending: vi.fn(),
  deletePending: vi.fn(),
  resendPending: vi.fn(),
  hasPending: vi.fn(),
}))

const jobStateMocks = vi.hoisted(() => ({
  recoverStaleJobs: vi.fn(),
}))

const watchdogMocks = vi.hoisted(() => ({
  startWatchdog: vi.fn(),
}))

const notifierMocks = vi.hoisted(() => ({
  sendAlert: vi.fn(),
}))

const jobRunnerMocks = vi.hoisted(() => ({
  computeWorkspaceBaseline: vi.fn(),
}))

vi.mock('./outbox/outboxStore.js', () => outboxMocks)
vi.mock('./watchdog/watchdog.js', () => watchdogMocks)
vi.mock('./notifier/notifier.js', () => notifierMocks)
vi.mock('./jobRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jobRunner.js')>()
  return {
    ...actual,
    computeWorkspaceBaseline: jobRunnerMocks.computeWorkspaceBaseline,
  }
})
vi.mock('./jobStateManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jobStateManager.js')>()
  return {
    ...actual,
    recoverStaleJobs: jobStateMocks.recoverStaleJobs,
  }
})

import {
  patchJobWithRetry,
  pollJobs,
  persistJobResult,
  processQueuedWork,
  start,
} from './index.js'

const NOW = '2026-08-08T01:02:03.000Z'
const fetchMock = vi.fn<typeof fetch>()

const CLEAN_BASELINE = { mode: 'clean', startCommitHash: 'abc123' }

const job: Job = {
  id: 'job-1',
  taskId: 'task-1',
  projectId: 'project-1',
  agentRole: 'developer_ai',
  status: 'queued',
  safeCommand: { kind: 'test', workingDir: '/workspace/target' },
  createdAt: '2026-08-08T00:00:00.000Z',
}

const task: Task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Test task',
  description: '',
  status: 'pending',
  assignee: 'developer_ai',
  dependencies: [],
  roadmapActive: false,
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
}

const runResult: JobRunResult = {
  status: 'success',
  exitCode: 0,
  stdout: 'safe stdout',
  stderr: '',
  changedFiles: ['src/feature.ts'],
  guardResult: {
    permissionAllowed: true,
    fileChangeAllowed: true,
    fileViolations: [],
  },
  startedAt: '2026-08-08T00:01:00.000Z',
  completedAt: '2026-08-08T00:02:00.000Z',
}

beforeEach(() => {
  fetchMock.mockReset()
  outboxMocks.recordPending.mockReset()
  outboxMocks.deletePending.mockReset()
  outboxMocks.resendPending.mockReset()
  outboxMocks.hasPending.mockReset()
  jobStateMocks.recoverStaleJobs.mockReset()
  watchdogMocks.startWatchdog.mockReset()
  notifierMocks.sendAlert.mockReset()
  jobRunnerMocks.computeWorkspaceBaseline.mockReset()
  outboxMocks.recordPending.mockReturnValue({
    eventId: 'event-1',
    payloadHash: 'payload-hash-1',
  })
  outboxMocks.resendPending.mockResolvedValue(undefined)
  outboxMocks.hasPending.mockReturnValue(false)
  jobStateMocks.recoverStaleJobs.mockResolvedValue(0)
  notifierMocks.sendAlert.mockResolvedValue([])
  jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({ ok: true, baseline: CLEAN_BASELINE })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('terminal result persistence', () => {
  it('provider failure metadataをterminal PATCHとOutboxへ同じ内容で渡す', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const timeoutResult: JobRunResult = {
      ...runResult,
      status: 'failed',
      exitCode: 1,
      providerFailureKind: 'provider_timeout',
      workspaceState: 'unchanged',
    }

    await persistJobResult('job-timeout', timeoutResult, 'failed', { patchJob })

    const failureMetadata = {
      kind: 'provider_timeout',
      workspaceState: 'unchanged',
    }
    expect(patchJob).toHaveBeenCalledWith('job-timeout', expect.objectContaining({ failureMetadata }))
    expect(outboxMocks.recordPending).toHaveBeenCalledWith(
      'job-timeout',
      expect.objectContaining({ failureMetadata }),
    )
  })

  it('1〜2回目の失敗後に3回目が成功すればterminal resultを成功として扱う', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const reconcileJob = vi.fn()

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(outboxMocks.deletePending).toHaveBeenCalledWith('job-1')
    expect(reconcileJob).not.toHaveBeenCalled()
  })

  it('3回とも同一terminal payloadを送信する', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
    })

    const bodies = fetchMock.mock.calls.map((call) => String(call[1]?.body))
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0])).toMatchObject({
      status: 'success',
      completedAt: runResult.completedAt,
      stdout: runResult.stdout,
      eventId: 'event-1',
      payloadHash: 'payload-hash-1',
    })
  })

  it('3回失敗後にreconcileできればCRITICAL通知しない', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    const alert = vi.fn().mockResolvedValue([])
    const reconcileJob = vi.fn()

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob,
      alert,
      now: () => NOW,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(outboxMocks.recordPending).toHaveBeenCalledTimes(1)
    expect(outboxMocks.deletePending).not.toHaveBeenCalled()
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('3回失敗後のreconcileがunrecoverableなら機密本文を含まないCRITICAL通知を1回送る', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    const alert = vi.fn().mockResolvedValue([])
    const sensitiveResult: JobRunResult = {
      ...runResult,
      stdout: 'private stdout token-secret-123',
      stderr: 'private stderr token-secret-123',
    }
    const reconcileJob = vi.fn()

    await persistJobResult('job-sensitive', sensitiveResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob,
      alert,
      now: () => NOW,
    })

    expect(outboxMocks.deletePending).not.toHaveBeenCalled()
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })
})

/** 既存POLL_INTERVAL_MSの既定値（テスト内で時間を進めるため）。 */
const POLL_INTERVAL_FOR_TEST = 5_000

/**
 * Outbox gating が守っているのは「pending がある間は新しい Job を claim しない」ことであって、
 * 「HTTP を一切出さない」ことではない。#110 Step 3 で supervised run の reconcile を
 * poll cycle 先頭へ置いたため（Outbox 滞留で supervision が止まらないようにするため）、
 * ここでは **queued Job fetch だけが呼ばれていない**ことを確認する。
 */
function expectNoQueuedJobFetch(): void {
  const jobFetches = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/jobs'))
  expect(jobFetches).toHaveLength(0)
}

describe('outbox gating', () => {
  it('pollJobs skips queued Job fetch while pending Outbox events exist', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    expect(outboxMocks.hasPending).toHaveBeenCalled()
    expectNoQueuedJobFetch()
  })

  it('pendingがある間はresendPendingを呼び、新しいJob fetchはしない', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    expect(outboxMocks.resendPending).toHaveBeenCalled()
    expectNoQueuedJobFetch()
  })

  it('resend成功でpendingが消えると、次のpollから通常のJob fetchへ戻る', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValueOnce(true).mockReturnValue(false)
    outboxMocks.resendPending.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)
    expectNoQueuedJobFetch()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalled()
  })

  it('resend失敗でもWorkerは落ちず、同一poll内でtight retryせず次pollで再試行する', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    outboxMocks.resendPending.mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    // 1 pollにつき1 resend batchであり、同一poll内で繰り返さない
    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)
    expectNoQueuedJobFetch()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    await Promise.resolve()

    // 次pollで再試行される（pendingは保持されたまま）
    expect(outboxMocks.resendPending.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('pendingが無いときはresendPendingを呼ばない（既存挙動のまま）', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(false)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    expect(outboxMocks.resendPending).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('resendに時間がかかっても同一poll cycleが直列化され並列再送しない', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    let resolveResend: (() => void) | undefined
    outboxMocks.resendPending.mockImplementation(
      () => new Promise<void>((resolve) => { resolveResend = resolve }),
    )
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)

    // resendが未完了のまま時間が進んでも、pollはawaitで直列化されており次のbatchを開始しない
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()

    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)

    resolveResend?.()
  })

  it('pending Outbox が滞留していても supervised run の reconcile は止まらない（独立レビュー Step 3 第2ラウンド #2）', async () => {
    vi.useFakeTimers()
    // Outbox が詰まっている間 supervision も止まると、完了済みの委任が RUNNING のまま残る。
    // Job intake を止める理由（workspace 競合）は supervision には当てはまらない。
    outboxMocks.hasPending.mockReturnValue(true)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const reconcileCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/supervised-runs/reconcile'),
    )
    expect(reconcileCalls.length).toBeGreaterThanOrEqual(1)
    // それでも新しい Job は claim しない（既存の Outbox gating は維持）。
    expectNoQueuedJobFetch()
  })

  it('start does not wait for pending Outbox events before startup recovery/watchdog/polling', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    // pendingが解消しないケース（起動時に限らずずっと残る）でも、recovery/watchdog/
    // pollingの開始そのものはblockされてはならない。
    outboxMocks.hasPending.mockReturnValue(true)

    void start()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // #110 Step 3 で poll cycle の先頭に supervised run の reconcile（HTTP 1本）が入ったため、
    // resendPending へ到達するまでの microtask が1段増えている。
    await Promise.resolve()
    await Promise.resolve()

    // startup sweepとwatchdogは、pending Outboxの解消を待たずに開始する
    expect(jobStateMocks.recoverStaleJobs).toHaveBeenCalledTimes(1)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)

    // pollJobs自体も開始しており、最初のcycleでpendingの再送を試みている
    expect(outboxMocks.resendPending).toHaveBeenCalledTimes(1)
    // pendingが残っている間はqueued Job fetchだけがこのcycleでskipされる（既存仕様）
    expectNoQueuedJobFetch()
  })

  it('startupでpending Outboxが残ったままでも、Worker全体とwatchdogは停止しない', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    outboxMocks.hasPending.mockReturnValue(true)

    void start()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(jobStateMocks.recoverStaleJobs).toHaveBeenCalledTimes(1)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)

    // pending Outboxが解消しないまま複数poll cycleが進んでも、
    // poll loop自体は生きていて次のcycleへ進み続ける（system全体のhaltではない）
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 4)
    await Promise.resolve()

    expect(outboxMocks.resendPending.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(watchdogMocks.startWatchdog).toHaveBeenCalledTimes(1)
  })

  it('pendingが3poll cycle連続で解消しない場合にCRITICAL通知を1回送る', async () => {
    vi.useFakeTimers()
    outboxMocks.hasPending.mockReturnValue(true)
    vi.stubGlobal('fetch', fetchMock)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 2)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Worker Outbox resend is blocked' }),
    )

    // 4回目以降も連続して残っていても、通知は1回のまま(alert済みフラグ)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 2)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('pendingが解消した後に再び連続滞留すると、CRITICAL通知が再度送られる', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

    // 呼び出し回数（1cycleあたりhasPendingは1〜2回呼ばれうる）に依存しないよう、
    // 状態フラグで表現する。
    let pending = true
    outboxMocks.hasPending.mockImplementation(() => pending)

    void pollJobs()
    await Promise.resolve()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)

    // 一度解消させる(streak/alert済みフラグがリセットされる)
    pending = false
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST)
    await Promise.resolve()

    // 再び滞留させる
    pending = true
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FOR_TEST * 3)
    await Promise.resolve()

    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(2)
  })
})

describe('running transition', () => {
  it.each([
    ['queued no-op', { outcome: 'reconciled' as const, updated: false, currentStatus: 'queued' as const }],
    ['failed convergence', { outcome: 'reconciled' as const, updated: true, currentStatus: 'failed' as const }],
  ])('does not run the Job after %s reconciliation', async (_label, reconciliation) => {
    const executeJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue(false),
      reconcileJob: vi.fn().mockResolvedValue(reconciliation),
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('sends CRITICAL and skips runJob only when reconciliation is unrecoverable', async () => {
    const executeJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue(false),
      reconcileJob: vi.fn().mockResolvedValue({
        outcome: 'unrecoverable',
        updated: false,
      }),
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('does not call runJob or its AI CLI path while the running PATCH is retrying', async () => {
    const executeJob = vi.fn().mockResolvedValue(runResult)
    const executeCountsDuringPatch: number[] = []
    fetchMock.mockImplementation(async () => {
      executeCountsDuringPatch.push(executeJob.mock.calls.length)
      const status = executeCountsDuringPatch.length < 3 ? 503 : 200
      return new Response(null, { status })
    })

    await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: retryingPatchJob(),
      reconcileJob: vi.fn(),
      executeJob,
      now: () => NOW,
    })

    expect(executeCountsDuringPatch.slice(0, 3)).toEqual([0, 0, 0])
    expect(executeJob).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('workspace baseline (PR-C)', () => {
  it('bundles the workspace baseline into the running claim PATCH (atomic claim + baseline)', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn().mockResolvedValue(runResult)

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(status).toBe('success')
    expect(jobRunnerMocks.computeWorkspaceBaseline).toHaveBeenCalledWith(job, '/workspace/target')
    expect(patchJob.mock.calls[0]?.[1]).toEqual({
      status: 'running',
      startedAt: NOW,
      workspaceBaseline: CLEAN_BASELINE,
    })
    expect(executeJob).toHaveBeenCalledTimes(1)
  })

  it('fails closed without claiming when the workspace baseline cannot be computed', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'workspace has an in-progress git operation (index.lock); ' +
        'cannot establish a durable baseline (fail-closed)',
    })

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(patchJob).toHaveBeenCalledTimes(1)
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({
      status: 'blocked',
      stderr: expect.stringContaining('index.lock'),
      completedAt: NOW,
    })
    expect(patchJob.mock.calls[0]?.[1]).not.toHaveProperty('status', 'running')
  })

  it('shuts down the Job on a dirty worktree for a normal Job (fail-closed gating)', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'normal Job requires a clean worktree but found 1 changed path(s): src/dirty.ts',
    })

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    expect(patchJob).toHaveBeenCalledTimes(1)
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({
      status: 'blocked',
      stderr: expect.stringContaining('src/dirty.ts'),
    })
  })


  it('baseline failure on an OWNING Job: ownership is retained (blocked + quarantined), not released', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    const alert = vi.fn().mockResolvedValue([])
    // workflowStepKey が initial-implement ではない queued Job は、
    // findWorkspaceOwningTaskId() 上すでに workspace を所有している。
    const owningJob: Job = { ...job, workflowStepKey: 'repair:job-0:1' }
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'fingerprint failed',
    })

    const status = await processQueuedWork({ job: owningJob, task, jobs: [owningJob] }, {
      patchJob,
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBeNull()
    expect(executeJob).not.toHaveBeenCalled()
    const payload = patchJob.mock.calls[0]?.[1]
    // 所有権を解放する 'failed' にしてはならない
    expect(payload).toMatchObject({ status: 'blocked' })
    expect(payload.failureMetadata).toMatchObject({ quarantined: true })
    expect(alert).toHaveBeenCalled()
  })

  it('baseline failure on a NON-owning initial-implement Job may still report failed', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn()
    const initialJob: Job = { ...job, workflowStepKey: `task:${job.taskId}:initial-implement` }
    jobRunnerMocks.computeWorkspaceBaseline.mockReturnValue({
      ok: false,
      reason: 'dirty worktree',
    })

    await processQueuedWork({ job: initialJob, task, jobs: [initialJob] }, {
      patchJob,
      executeJob,
      now: () => NOW,
    })

    expect(executeJob).not.toHaveBeenCalled()
    // まだ workspace を所有していないので、保持すべき所有権が無い
    expect(patchJob.mock.calls[0]?.[1]).toMatchObject({ status: 'failed' })
  })})

describe('policy construction failure', () => {
  it('uses the shared retry/reconcile persistence path for running and failed updates', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const reconcileJob = vi.fn()
    const executeJob = vi.fn()

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      reconcileJob,
      executeJob,
      buildPolicy: () => {
        throw new Error('invalid policy')
      },
      now: () => NOW,
    })

    expect(status).toBe('failed')
    expect(patchJob).toHaveBeenCalledTimes(2)
    expect(patchJob.mock.calls[0]?.[1]).toEqual({
      status: 'running',
      startedAt: NOW,
      workspaceBaseline: CLEAN_BASELINE,
    })
    expect(patchJob.mock.calls[1]?.[1]).toMatchObject({
      status: 'failed',
      stderr: expect.stringContaining('invalid policy'),
      completedAt: NOW,
    })
    expect(reconcileJob).not.toHaveBeenCalled()
    expect(executeJob).not.toHaveBeenCalled()
  })
})

function retryingPatchJob(): (
  jobId: string,
  payload: Parameters<typeof patchJobWithRetry>[1],
) => Promise<boolean> {
  return async (jobId, payload) => patchJobWithRetry(jobId, payload, {
    apiBaseUrl: 'http://api.test',
    headers: { authorization: 'Bearer token' },
    fetchImpl: fetchMock,
    sleepImpl: async () => {},
  })
}

/**
 * P1 Phase 2（独立レビュー B3）:
 * containment / 実行後 reconciliation の失敗が runJob から throw された場合、
 * poll loop の logger まで素通りさせてはならない。素通りすると Job は `running` のまま
 * 残り、誰も面倒を見ないまま workspace の所有権を保持し続ける。
 */
describe('P1 Phase 2: containment 失敗時の quarantine（B3）', () => {
  const containmentFailure = (outcome: string): Error =>
    new ContainmentInfrastructureError({
      outcome,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      killedDescendants: false,
      drainMs: 0,
    } as never)

  it('containment 失敗は blocked + quarantine になり、running のまま放置されない', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)
    const executeJob = vi.fn().mockRejectedValue(
      containmentFailure('drain_timeout'),
    )
    const alert = vi.fn().mockResolvedValue(undefined)

    const status = await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob,
      alert,
      now: () => NOW,
    })

    expect(status).toBe('blocked')

    const terminal = patchJob.mock.calls.at(-1)?.[1] as {
      status?: string
      failureMetadata?: { quarantined?: boolean; quarantineReason?: string; kind?: string }
    }
    // failed にしてはならない。failed は workspace を所有しないため、
    // 生き残ったプロセスを抱えたまま次の Job へ引き渡してしまう。
    expect(terminal.status).toBe('blocked')
    expect(terminal.failureMetadata?.quarantined).toBe(true)
    expect(terminal.failureMetadata?.kind).toBe('workspace_containment_failure')
    expect(terminal.failureMetadata?.quarantineReason).toContain('drain_timeout')
  })

  it('containment 失敗では CRITICAL アラートを出す', async () => {
    const alert = vi.fn().mockResolvedValue(undefined)

    await processQueuedWork({ job, task, jobs: [job] }, {
      patchJob: vi.fn().mockResolvedValue(true),
      executeJob: vi.fn().mockRejectedValue(
        containmentFailure('cleanup_failed'),
      ),
      alert,
      now: () => NOW,
    })

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }))
  })

  it('containment と無関係な例外はそのまま伝播する（quarantine で覆い隠さない）', async () => {
    const patchJob = vi.fn().mockResolvedValue(true)

    await expect(processQueuedWork({ job, task, jobs: [job] }, {
      patchJob,
      executeJob: vi.fn().mockRejectedValue(new Error('unrelated bug')),
      now: () => NOW,
    })).rejects.toThrow('unrelated bug')
  })
})
