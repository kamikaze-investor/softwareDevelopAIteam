import type { Job, TaskHumanDecisionFact } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK,
  ABORT_ERROR_MESSAGE_FALLBACK,
  formatAbortErrorMessage,
} from './resumeErrorMessage'
import {
  ABORT_APPROVAL_REQUEST_UNREADABLE_MESSAGE,
  ABORT_CLEANUP_REQUESTED_MESSAGE,
  ABORT_PARKED_MESSAGE,
  ABORT_UNREADABLE_SUCCESS_MESSAGE,
  MOBILE_ABORT_REASON,
  abortActionView,
  abortApprovalState,
  buildAbortApprovalRequestBody,
  canShowAbortUI,
  createAbortApprovalRequest,
  submitTaskAbort,
} from './taskAbort'

vi.mock('./api', () => ({ apiFetch: vi.fn() }))
const { apiFetch } = await import('./api')
const apiFetchMock = vi.mocked(apiFetch)

function jsonResponse(status: number, body: unknown): Response {
  return { json: async () => body, ok: status >= 200 && status < 300, status } as unknown as Response
}

function unreadableResponse(status: number): Response {
  return { json: async () => { throw new Error('no json') }, ok: status >= 200 && status < 300, status } as unknown as Response
}

function job(status: Job['status'], quarantined = false): Job {
  return {
    id: `job-${status}`,
    status,
    ...(quarantined ? { failureMetadata: { quarantined: true } } : {}),
  } as unknown as Job
}

const decision = (
  approvalRequestId: string,
  requestedAction: string,
  state: TaskHumanDecisionFact['state'],
): TaskHumanDecisionFact => ({ approvalRequestId, requestedAction, state })

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('buildAbortApprovalRequestBody', () => {
  it('既存 CreateApprovalRequestBody の必須欄を埋め、abort_task を起票する（expiresAt は送らない）', () => {
    const body = buildAbortApprovalRequestBody('task-1')
    expect(body).toEqual({
      taskId: 'task-1',
      targetBranch: 'manual-abort',
      targetCommit: 'task-1',
      targetDiffHash: 'abort_task:task-1',
      riskLevel: 'HIGH',
      requestedAction: 'abort_task',
      invalidIf: [],
      reason: MOBILE_ABORT_REASON,
    })
    expect(body).not.toHaveProperty('expiresAt')
    expect(MOBILE_ABORT_REASON.trim().length).toBeGreaterThan(0)
    expect(MOBILE_ABORT_REASON.length).toBeLessThanOrEqual(2000)
  })
})

describe('canShowAbortUI', () => {
  const base = { parked: false, roadmapActive: true }

  it('blocked な Task には出す', () => {
    expect(canShowAbortUI({ ...base, status: 'blocked' }, [])).toBe(true)
  })

  it('pending で所有権を保持する blocked Job があるときだけ出す', () => {
    expect(canShowAbortUI({ ...base, status: 'pending' }, [job('blocked')])).toBe(true)
    expect(canShowAbortUI({ ...base, status: 'pending' }, [job('failed'), job('success')])).toBe(false)
    expect(canShowAbortUI({ ...base, status: 'pending' }, [])).toBe(false)
  })

  it('API が受け付けない状態（done / in_progress / park 済み / Roadmap 外）には出さない', () => {
    expect(canShowAbortUI({ ...base, status: 'done' }, [job('blocked')])).toBe(false)
    expect(canShowAbortUI({ ...base, status: 'in_progress' }, [job('blocked')])).toBe(false)
    expect(canShowAbortUI({ ...base, parked: true, status: 'blocked' }, [job('blocked')])).toBe(false)
    expect(canShowAbortUI({ ...base, roadmapActive: false, status: 'blocked' }, [])).toBe(false)
  })

  it('parked が読めない（古い API）なら出さない', () => {
    expect(canShowAbortUI({ roadmapActive: true, status: 'blocked' }, [])).toBe(false)
  })
})

describe('abortApprovalState / abortActionView', () => {
  it('事実が無い・別 action だけなら none（起票だけ押せる）', () => {
    expect(abortApprovalState(undefined)).toEqual({ kind: 'none' })
    const view = abortActionView([decision('a1', 'repair_from_stored_review:r1', 'approved')])
    expect(view.approval).toEqual({ kind: 'none' })
    expect(view.canCreateRequest).toBe(true)
    expect(view.canExecute).toBe(false)
  })

  it('承認待ちなら起票も実行も押させず、承認一覧へ案内する', () => {
    const view = abortActionView([decision('w1', 'abort_task', 'waiting')])
    expect(view.approval).toEqual({ approvalRequestId: 'w1', kind: 'waiting' })
    expect(view.canCreateRequest).toBe(false)
    expect(view.canExecute).toBe(false)
    expect(view.note).toContain('w1')
    expect(view.note).toContain('承認一覧')
  })

  it('人が承認した abort_task があれば実行だけ押せる（新しい起票で APPROVED を置き換えさせない）', () => {
    const view = abortActionView([
      decision('w1', 'abort_task', 'waiting'),
      decision('ap1', 'abort_task', 'approved'),
    ])
    expect(view.approval).toEqual({ approvalRequestId: 'ap1', kind: 'approved' })
    expect(view.canCreateRequest).toBe(false)
    expect(view.canExecute).toBe(true)
  })
})

describe('createAbortApprovalRequest', () => {
  it('既存の POST /api/approval-requests を呼び、201 の id を返す（承認はしない）', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'req-1', status: 'WAITING_FOR_USER' }))

    await expect(createAbortApprovalRequest('task-1')).resolves.toEqual({ approvalRequestId: 'req-1', ok: true })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = apiFetchMock.mock.calls[0] ?? []
    expect(path).toBe('/api/approval-requests')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(buildAbortApprovalRequestBody('task-1'))
  })

  it('201 で id が読めなければ「作成されたが読めない」と伝える（失敗とは言わない）', async () => {
    apiFetchMock.mockResolvedValueOnce(unreadableResponse(201))
    await expect(createAbortApprovalRequest('t')).resolves.toEqual({
      message: ABORT_APPROVAL_REQUEST_UNREADABLE_MESSAGE,
      ok: false,
    })
  })

  it('拒否・通信失敗は fallback', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'Validation failed' }))
    await expect(createAbortApprovalRequest('t')).resolves.toEqual({
      message: ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK,
      ok: false,
    })
    apiFetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(createAbortApprovalRequest('t')).resolves.toEqual({
      message: ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK,
      ok: false,
    })
  })
})

describe('submitTaskAbort', () => {
  it('既存の POST /api/tasks/:id/abort を approvalRequestId と reason だけの body で呼ぶ', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, status: 'cleanup_requested', taskId: 't 1', jobIds: ['j'] }))

    await expect(submitTaskAbort('t 1', 'ap1')).resolves.toEqual({
      message: ABORT_CLEANUP_REQUESTED_MESSAGE,
      ok: true,
      status: 'cleanup_requested',
    })

    const [path, init] = apiFetchMock.mock.calls[0] ?? []
    expect(path).toBe('/api/tasks/t%201/abort')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ approvalRequestId: 'ap1', reason: MOBILE_ABORT_REASON })
    expect(ABORT_CLEANUP_REQUESTED_MESSAGE).toContain('Worker が作業場所を確認し、clean なら park されます')
  })

  it('200 parked は park 済みと伝える', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, status: 'parked', taskId: 't' }))
    await expect(submitTaskAbort('t', 'ap1')).resolves.toEqual({ message: ABORT_PARKED_MESSAGE, ok: true, status: 'parked' })
  })

  it('200 で結果が読めなければ失敗とは言わず、更新を促す', async () => {
    apiFetchMock.mockResolvedValueOnce(unreadableResponse(200))
    await expect(submitTaskAbort('t', 'ap1')).resolves.toEqual({ message: ABORT_UNREADABLE_SUCCESS_MESSAGE, ok: false })
  })

  it('拒否は code の文言にする', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'x', code: 'NOT_AUTHORIZED' }))
    await expect(submitTaskAbort('t', 'ap1')).resolves.toEqual({
      message: formatAbortErrorMessage('NOT_AUTHORIZED'),
      ok: false,
    })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'x', code: 'LIVE_JOB_PRESENT' }))
    await expect(submitTaskAbort('t', 'ap1')).resolves.toMatchObject({ ok: false })
  })

  it('JSON でない応答・通信失敗は fallback', async () => {
    apiFetchMock.mockResolvedValueOnce(unreadableResponse(500))
    await expect(submitTaskAbort('t', 'ap1')).resolves.toEqual({ message: ABORT_ERROR_MESSAGE_FALLBACK, ok: false })
    apiFetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(submitTaskAbort('t', 'ap1')).resolves.toEqual({ message: ABORT_ERROR_MESSAGE_FALLBACK, ok: false })
  })
})

describe('formatAbortErrorMessage', () => {
  const codes = [
    'TASK_NOT_FOUND', 'TASK_ALREADY_DONE', 'TASK_NOT_PARKABLE', 'TASK_NOT_ACTIVE', 'LIVE_JOB_PRESENT',
    'FOREIGN_BLOCKED_JOB', 'JOB_QUARANTINED', 'OWNERSHIP_UNPROVEN', 'UNATTRIBUTED_DIRTY_WORKSPACE',
    'TASK_STATE_CHANGED', 'TECHNICAL_EVIDENCE_INELIGIBLE', 'NOT_AUTHORIZED', 'PARK_FAILED',
  ]

  it('AbortTaskResult の全 code に専用の文言がある', () => {
    for (const code of codes) {
      expect(formatAbortErrorMessage(code), code).not.toBe(ABORT_ERROR_MESSAGE_FALLBACK)
    }
    expect(new Set(codes.map((code) => formatAbortErrorMessage(code))).size).toBe(codes.length)
  })

  it('未知・無い code は fallback（prototype のキーも引かない）', () => {
    expect(formatAbortErrorMessage(null)).toBe(ABORT_ERROR_MESSAGE_FALLBACK)
    expect(formatAbortErrorMessage('SOMETHING_NEW')).toBe(ABORT_ERROR_MESSAGE_FALLBACK)
    expect(formatAbortErrorMessage('toString')).toBe(ABORT_ERROR_MESSAGE_FALLBACK)
  })
})
