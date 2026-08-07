import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTransition,
  isTransitionAllowed,
  reconcileRunningJob,
  recoverStaleJobs,
} from './jobStateManager.js'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isTransitionAllowed', () => {
  it('queued -> running は許可', () => {
    expect(isTransitionAllowed('queued', 'running')).toBe(true)
  })

  it('running -> success は許可', () => {
    expect(isTransitionAllowed('running', 'success')).toBe(true)
  })

  it('running -> failed は許可', () => {
    expect(isTransitionAllowed('running', 'failed')).toBe(true)
  })

  it('running -> blocked は許可', () => {
    expect(isTransitionAllowed('running', 'blocked')).toBe(true)
  })

  it('blocked -> queued は許可', () => {
    expect(isTransitionAllowed('blocked', 'queued')).toBe(true)
  })

  it('failed -> queued は許可', () => {
    expect(isTransitionAllowed('failed', 'queued')).toBe(true)
  })

  it('success -> running は禁止', () => {
    expect(isTransitionAllowed('success', 'running')).toBe(false)
  })

  it('queued -> success は禁止', () => {
    expect(isTransitionAllowed('queued', 'success')).toBe(false)
  })
})

describe('assertTransition', () => {
  it('不正な遷移は Error を投げる', () => {
    expect(() => assertTransition('success', 'running')).toThrow('不正な状態遷移')
  })

  it('正常な遷移はエラーなし', () => {
    expect(() => assertTransition('queued', 'running')).not.toThrow()
  })
})

describe('reconcileRunningJob', () => {
  it('updated=true は reconciled として返す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      updated: true,
      currentStatus: 'failed',
      job: { id: 'job-1', status: 'failed' },
    }))

    const result = await reconcileRunningJob(
      'job-1',
      { stderr: 'technical failure', completedAt: '2026-08-08T00:00:00.000Z' },
      { apiBaseUrl: 'http://api.test', headers: { authorization: 'Bearer token' } },
    )

    expect(result).toEqual({ outcome: 'reconciled', updated: true, currentStatus: 'failed' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/jobs/job-1/fail-if-running',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      }),
    )
  })

  it.each(['success', 'failed', 'blocked', 'queued'] as const)(
    'updated=false, currentStatus=%s は reconciled として返す',
    async (currentStatus) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ updated: false, currentStatus, job: {} }))

      const result = await reconcileRunningJob(
        'job-1',
        { stderr: 'technical failure', completedAt: '2026-08-08T00:00:00.000Z' },
        { apiBaseUrl: 'http://api.test' },
      )

      expect(result).toEqual({ outcome: 'reconciled', updated: false, currentStatus })
    },
  )

  it('updated=false, currentStatus=running は unrecoverable として返す', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      updated: false,
      currentStatus: 'running',
      job: { id: 'job-1', status: 'running' },
    }))

    const result = await reconcileRunningJob(
      'job-1',
      { stderr: 'technical failure', completedAt: '2026-08-08T00:00:00.000Z' },
      { apiBaseUrl: 'http://api.test' },
    )

    expect(result).toEqual({ outcome: 'unrecoverable', updated: false, currentStatus: 'running' })
  })

  it('404 は unrecoverable として返す', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))

    const result = await reconcileRunningJob(
      'missing-job',
      { stderr: 'technical failure', completedAt: '2026-08-08T00:00:00.000Z' },
      { apiBaseUrl: 'http://api.test' },
    )

    expect(result).toEqual({ outcome: 'unrecoverable', updated: false })
  })

  it('通信失敗は unrecoverable として返す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

    const result = await reconcileRunningJob(
      'job-1',
      { stderr: 'technical failure', completedAt: '2026-08-08T00:00:00.000Z' },
      { apiBaseUrl: 'http://api.test' },
    )

    expect(result).toEqual({ outcome: 'unrecoverable', updated: false })
  })
})

describe('recoverStaleJobs', () => {
  it('reconciliationで実際にrunningからfailedへ遷移したJobだけを回収件数へ加算する', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'job-running', status: 'running' },
        { id: 'job-raced', status: 'running' },
      ]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'failed',
        job: { id: 'job-running', status: 'failed' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        updated: false,
        currentStatus: 'success',
        job: { id: 'job-raced', status: 'success' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', {
      authorization: 'Bearer token',
    })

    expect(recovered).toBe(1)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://api.test/api/projects', {
      headers: { authorization: 'Bearer token' },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://api.test/api/tasks?projectId=project%201',
      { headers: { authorization: 'Bearer token' } }
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://api.test/api/jobs?taskId=task%201',
      { headers: { authorization: 'Bearer token' } }
    )

    const updateOptions = fetchMock.mock.calls[3]?.[1]
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'http://api.test/api/jobs/job-running/fail-if-running',
    )
    expect(updateOptions).toMatchObject({
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(updateOptions?.body))).toMatchObject({
      stderr: '[Worker] 前回の Worker が異常終了したため failed にリセットしました',
      completedAt: expect.any(String),
    })
  })
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
