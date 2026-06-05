import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertTransition, isTransitionAllowed, recoverStaleJobs } from './jobStateManager.js'

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

describe('recoverStaleJobs', () => {
  it('running の Job を failed に更新して件数を返す', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([
        { id: 'job-running', status: 'running' },
        { id: 'job-success', status: 'success' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-running', status: 'failed' }))

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
    expect(updateOptions).toMatchObject({
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(updateOptions?.body))).toMatchObject({
      status: 'failed',
      stderr: '[Worker] 前回の Worker が異常終了したため failed にリセットしました',
    })
  })
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
