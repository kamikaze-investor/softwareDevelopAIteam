import type { Job, Task } from '@ai-team/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRunResult } from './jobRunner.js'
import {
  patchJobWithRetry,
  persistJobResult,
  processQueuedWork,
} from './index.js'

const NOW = '2026-08-08T01:02:03.000Z'
const fetchMock = vi.fn<typeof fetch>()

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
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminal result persistence', () => {
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
    })
  })

  it('3回失敗後にreconcileできればCRITICAL通知しない', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    const alert = vi.fn().mockResolvedValue([])

    await persistJobResult('job-1', runResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob: vi.fn().mockResolvedValue({
        outcome: 'reconciled',
        updated: false,
        currentStatus: 'success',
      }),
      alert,
      now: () => NOW,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
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

    await persistJobResult('job-sensitive', sensitiveResult, 'success', {
      patchJob: retryingPatchJob(),
      reconcileJob: vi.fn().mockResolvedValue({
        outcome: 'unrecoverable',
        updated: false,
      }),
      alert,
      now: () => NOW,
    })

    expect(alert).toHaveBeenCalledTimes(1)
    const notification = JSON.stringify(alert.mock.calls[0]?.[0])
    expect(notification).toContain('job-sensitive')
    expect(notification).toContain('technical failure')
    expect(notification).not.toContain('private stdout')
    expect(notification).not.toContain('private stderr')
    expect(notification).not.toContain('token-secret-123')
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
    expect(patchJob.mock.calls[0]?.[1]).toEqual({ status: 'running', startedAt: NOW })
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
