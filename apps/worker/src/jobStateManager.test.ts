import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTransition,
  isTransitionAllowed,
  reconcileRunningJob,
  recoverStaleJobs,
} from './jobStateManager.js'

const fetchMock = vi.fn<typeof fetch>()

const workspaceVerificationMocks = vi.hoisted(() => ({
  verifyWorkspaceAgainstBaseline: vi.fn(),
}))

const notifierMocks = vi.hoisted(() => ({
  sendAlert: vi.fn(),
}))

vi.mock('./workspaceVerification.js', () => workspaceVerificationMocks)
vi.mock('./notifier/notifier.js', () => notifierMocks)

import { verifyWorkspaceAgainstBaseline } from './workspaceVerification.js'
import { sendAlert } from './notifier/notifier.js'

const WORKING_DIR = '/workspace/target'

function runningJob(id: string): Record<string, unknown> {
  return {
    id,
    status: 'running',
    taskId: 'task 1',
    projectId: 'project 1',
    safeCommand: { workingDir: WORKING_DIR },
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReset()
  notifierMocks.sendAlert.mockReset()
  notifierMocks.sendAlert.mockResolvedValue([])
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
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: true })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([
        runningJob('job-running'),
        runningJob('job-raced'),
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
      workspaceVerified: true,
    })
  })

  it('clean baseline + clean tree + matching HEAD => workspaceVerified:true を送信する', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: true })
    const job = {
      ...runningJob('job-clean'),
      workspaceBaseline: { mode: 'clean', startCommitHash: 'abc123' },
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([job]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'failed',
        job: { id: 'job-clean', status: 'failed' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(1)
    expect(verifyWorkspaceAgainstBaseline).toHaveBeenCalledWith(
      WORKING_DIR,
      { mode: 'clean', startCommitHash: 'abc123' },
    )
    const patchCall = fetchMock.mock.calls[3]
    const body = JSON.parse(String(patchCall?.[1]?.body))
    expect(body.workspaceVerified).toBe(true)
    expect(body.quarantineReason).toBeUndefined()
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
  })

  it('HEAD moved but tree clean => workspaceVerified:false（reason付き）を送信し、CRITICAL alert を出す', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'HEAD moved since job start (expected abc123, now def456)',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([runningJob('job-moved')]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-moved', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    const patchCall = fetchMock.mock.calls[3]
    expect(patchCall?.[0]).toBe('http://api.test/api/jobs/job-moved/fail-if-running')
    const body = JSON.parse(String(patchCall?.[1]?.body))
    expect(body.workspaceVerified).toBe(false)
    expect(body.quarantineReason).toContain('HEAD moved since job start')
    expect(body.failureMetadata).toBeUndefined()
    expect(notifierMocks.sendAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      sourceType: 'workspace_quarantine',
      sourceId: 'job-moved',
    }))
  })

  it('git operation marker present => NOT verified', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'in-progress git operation detected (index.lock)',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([runningJob('job-gitmarker')]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-gitmarker', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    const body = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))
    expect(body.workspaceVerified).toBe(false)
    expect(body.quarantineReason).toContain('in-progress git operation')
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('missing baseline => NOT verified', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'workspace baseline is missing (legacy row or crash before the baseline was written)',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ ...runningJob('job-nobaseline'), workspaceBaseline: undefined }]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-nobaseline', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    const body = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))
    expect(body.workspaceVerified).toBe(false)
    expect(body.quarantineReason).toContain('workspace baseline is missing')
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('dirty baseline が完全一致 => verified（workspaceVerified:true）', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: true })
    const dirtyBaseline = {
      mode: 'dirty' as const,
      startCommitHash: 'abc123',
      entries: [{
        path: 'src/a.ts',
        kind: 'modified' as const,
        xyStatus: ' M',
        afterType: 'regular' as const,
        afterMode: '100644',
        worktreeHash: 'hash1',
      }],
    }
    const job = { ...runningJob('job-dirty'), workspaceBaseline: dirtyBaseline }

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([job]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'failed',
        job: { id: 'job-dirty', status: 'failed' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(1)
    expect(verifyWorkspaceAgainstBaseline).toHaveBeenCalledWith(WORKING_DIR, dirtyBaseline)
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).workspaceVerified).toBe(true)
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
  })

  it('dirty baseline が不一致（内容hash変更） => NOT verified', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'dirty entry differs at "src/a.ts": worktreeHash is "newhash" (expected "hashi")',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([runningJob('job-dirty-hash')]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-dirty-hash', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    const body = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))
    expect(body.workspaceVerified).toBe(false)
    expect(body.quarantineReason).toContain('worktreeHash')
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('dirty baseline が不一致（余分なpath） => NOT verified', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'dirty entry count differs (baseline 1, current 2)',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([runningJob('job-dirty-extra')]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-dirty-extra', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).workspaceVerified).toBe(false)
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('dirty baseline が不一致（path欠落） => NOT verified', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'dirty entry count differs (baseline 2, current 1)',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([runningJob('job-dirty-missing')]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-dirty-missing', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).workspaceVerified).toBe(false)
  })

  it('dirty baseline が不一致（xyStatus変更） => NOT verified', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'dirty entry differs at "src/a.ts": xyStatus is "M " (expected " M")',
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([runningJob('job-dirty-xystatus')]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-dirty-xystatus', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).workspaceVerified).toBe(false)
  })

  it('safeCommand.workingDir が無い Job は fail-closed（NOT verified）', async () => {
    const job = { id: 'job-nodir', status: 'running', taskId: 'task 1', projectId: 'project 1' }

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([job]))
      .mockResolvedValueOnce(jsonResponse({
        updated: true,
        currentStatus: 'blocked',
        job: { id: 'job-nodir', status: 'blocked' },
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    expect(verifyWorkspaceAgainstBaseline).not.toHaveBeenCalled()
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      workspaceVerified: false,
    })
    expect(notifierMocks.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('startup recovery clears a previously quarantined Job whose workspace now verifies clean', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({ verified: true })
    const quarantinedJob = {
      id: 'job-quarantined',
      status: 'blocked',
      taskId: 'task 1',
      projectId: 'project 1',
      safeCommand: { workingDir: WORKING_DIR },
      workspaceBaseline: { mode: 'clean', startCommitHash: 'abc123' },
      failureMetadata: { quarantined: true, quarantineReason: 'workspace not verified safe after crash' },
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([quarantinedJob]))
      .mockResolvedValueOnce(jsonResponse({
        cleared: true,
        clearedJobCount: 1,
        alreadyCleared: false,
      }))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    expect(verifyWorkspaceAgainstBaseline).toHaveBeenCalledWith(
      WORKING_DIR,
      { mode: 'clean', startCommitHash: 'abc123' },
    )
    const clearCall = fetchMock.mock.calls[3]
    expect(clearCall?.[0]).toBe('http://api.test/api/jobs/job-quarantined/clear-quarantine')
    expect(clearCall?.[1]).toMatchObject({
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
    })
    const body = JSON.parse(String(clearCall?.[1]?.body))
    expect(body.workspaceVerified).toBe(true)
    expect(body.quarantineClearedReason).toContain('startup recovery: workspace verified clean')
    // 再検証は alert を再送しない（CRITICAL は対象外）
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
  })

  it('startup recovery leaves a still-unverified quarantined Job alone (no clearance request, no duplicate alert)', async () => {
    workspaceVerificationMocks.verifyWorkspaceAgainstBaseline.mockReturnValue({
      verified: false,
      reason: 'HEAD moved since job start (expected abc123, now def456)',
    })
    const quarantinedJob = {
      id: 'job-quarantined-bad',
      status: 'blocked',
      taskId: 'task 1',
      projectId: 'project 1',
      safeCommand: { workingDir: WORKING_DIR },
      workspaceBaseline: { mode: 'clean', startCommitHash: 'abc123' },
      failureMetadata: { quarantined: true, quarantineReason: 'workspace not verified safe after crash' },
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: 'project 1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task 1' }]))
      .mockResolvedValueOnce(jsonResponse([quarantinedJob]))

    const recovered = await recoverStaleJobs('http://api.test', { authorization: 'Bearer token' })

    expect(recovered).toBe(0)
    // clear-quarantine への要求は一切送らない（検証成功なしでは解除を申請しない）
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('clear-quarantine'))).toBe(false)
    expect(notifierMocks.sendAlert).not.toHaveBeenCalled()
  })
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
