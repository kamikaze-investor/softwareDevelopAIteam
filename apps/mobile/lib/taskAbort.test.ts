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
  abortApprovalState,
  buildAbortApprovalRequestBody,
  canShowAbortUI,
  createAbortApprovalRequest,
  submitTaskAbort,
  ABORT_APPROVE_FAILED_PREFIX,
  ONE_TAP_ABORT_APPROVE_REASON,
  ONE_TAP_ABORT_EXPIRED_NOTE,
  ONE_TAP_ABORT_NOT_EXECUTED_NOTE,
  approveAbortApprovalRequest,
  createOneTapAbortRunner,
  oneTapAbortConfirmMessage,
  oneTapAbortUnapprovedNote,
  oneTapAbortView,
  runOneTapAbort,
} from './taskAbort'
import type { OneTapAbortDeps } from './taskAbort'
import { buildApprovalGateDecisionBody } from './approvalGateDecision'
import { formatApprovalDecisionErrorMessage } from './resumeErrorMessage'

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

describe('abortApprovalState', () => {
  it('事実が無い・別 action だけなら none', () => {
    expect(abortApprovalState(undefined)).toEqual({ kind: 'none' })
    expect(abortApprovalState([decision('a1', 'repair_from_stored_review:r1', 'approved')])).toEqual({ kind: 'none' })
  })

  it('承認待ちの abort_task は waiting', () => {
    expect(abortApprovalState([decision('w1', 'abort_task', 'waiting')]))
      .toEqual({ approvalRequestId: 'w1', kind: 'waiting' })
  })

  it('人が承認した abort_task があれば approved を優先する（新しい起票で APPROVED を置き換えさせない）', () => {
    expect(abortApprovalState([
      decision('w1', 'abort_task', 'waiting'),
      decision('ap1', 'abort_task', 'approved'),
    ])).toEqual({ approvalRequestId: 'ap1', kind: 'approved' })
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

describe('approveAbortApprovalRequest', () => {
  it('承認一覧と同じ human-only PATCH を、同じ body builder で送る', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'req-1', status: 'APPROVED' }))

    await expect(approveAbortApprovalRequest('req-1')).resolves.toEqual({ ok: true })

    const [path, init] = apiFetchMock.mock.calls[0] ?? []
    expect(path).toBe('/api/approval-requests/req-1/status')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual(
      buildApprovalGateDecisionBody('APPROVED', ONE_TAP_ABORT_APPROVE_REASON),
    )
    expect(JSON.parse(String(init?.body))).toEqual({ reason: ONE_TAP_ABORT_APPROVE_REASON, status: 'APPROVED' })
  })

  it('拒否は承認一覧と同じ code の文言にし、code を返す', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS' }))
    await expect(approveAbortApprovalRequest('req-1')).resolves.toEqual({
      code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS',
      message: `${ABORT_APPROVE_FAILED_PREFIX}${formatApprovalDecisionErrorMessage('HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS')}`,
      ok: false,
    })
    apiFetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(approveAbortApprovalRequest('req-1')).resolves.toMatchObject({ ok: false })
  })
})

describe('oneTapAbortView / oneTapAbortConfirmMessage', () => {
  it('依頼なし → 起票・承認・実行、承認待ち → 承認・実行、承認済み → 実行だけ', () => {
    expect(oneTapAbortView(undefined).plan).toBe('create_approve_execute')
    expect(oneTapAbortView([decision('w1', 'abort_task', 'waiting')]).plan).toBe('approve_execute')
    expect(oneTapAbortView([
      decision('w1', 'abort_task', 'waiting'),
      decision('ap1', 'abort_task', 'approved'),
    ]).plan).toBe('execute')
    // 他の action の依頼は対象にしない
    expect(oneTapAbortView([decision('x1', 'repair_from_stored_review:r1', 'waiting')]).plan)
      .toBe('create_approve_execute')
  })

  it('確認文言は Task のタイトルとタスク番号・効果・承認する依頼 id を示す', () => {
    const task = { id: 'b8d0fc5d-1111-2222', title: 'ログイン画面' }
    const create = oneTapAbortConfirmMessage(task, oneTapAbortView(undefined))
    expect(create).toContain('「ログイン画面」')
    expect(create).toContain('タスク番号 #b8d0fc5d')
    expect(create).toContain('完了扱いにならず')
    expect(create).toContain('置き換えられます')

    const waiting = oneTapAbortConfirmMessage(task, oneTapAbortView([decision('w1', 'abort_task', 'waiting')]))
    expect(waiting).toContain('w1')
    expect(waiting).toContain('承認')

    const approved = oneTapAbortConfirmMessage(task, oneTapAbortView([decision('ap1', 'abort_task', 'approved')]))
    expect(approved).toContain('ap1')
  })
})

describe('runOneTapAbort', () => {
  function fakeDeps(overrides: Partial<OneTapAbortDeps> = {}): { deps: OneTapAbortDeps; calls: string[] } {
    const calls: string[] = []
    const deps: OneTapAbortDeps = {
      approveRequest: vi.fn(async (id: string) => { calls.push(`approve:${id}`); return { ok: true as const } }),
      createRequest: vi.fn(async (taskId: string) => {
        calls.push(`create:${taskId}`)
        return { approvalRequestId: 'new-req', ok: true as const }
      }),
      executeAbort: vi.fn(async (taskId: string, id: string) => {
        calls.push(`execute:${taskId}:${id}`)
        return { message: ABORT_CLEANUP_REQUESTED_MESSAGE, ok: true as const, status: 'cleanup_requested' as const }
      }),
      onProgress: (stage) => { calls.push(`progress:${stage}`) },
      ...overrides,
    }
    return { calls, deps }
  }

  it('依頼なし: 起票 → 作った依頼を承認 → その依頼で実行、の順に呼ぶ', async () => {
    const { calls, deps } = fakeDeps()
    await expect(runOneTapAbort('t1', { kind: 'none' }, deps)).resolves.toEqual({
      approvalRequestId: 'new-req',
      message: ABORT_CLEANUP_REQUESTED_MESSAGE,
      ok: true,
      status: 'cleanup_requested',
    })
    expect(calls).toEqual([
      'progress:create', 'create:t1',
      'progress:approve', 'approve:new-req',
      'progress:execute', 'execute:t1:new-req',
    ])
  })

  it('起票失敗: そこで止め、承認も実行もしない', async () => {
    const { calls, deps } = fakeDeps({
      createRequest: vi.fn(async () => ({ message: ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK, ok: false as const })),
    })
    const result = await runOneTapAbort('t1', { kind: 'none' }, deps)
    expect(result).toEqual({
      message: `${ABORT_APPROVAL_REQUEST_ERROR_MESSAGE_FALLBACK}\n${ONE_TAP_ABORT_NOT_EXECUTED_NOTE}`,
      ok: false,
      stage: 'create',
    })
    expect(deps.approveRequest).not.toHaveBeenCalled()
    expect(deps.executeAbort).not.toHaveBeenCalled()
    expect(calls).toEqual(['progress:create'])
  })

  it('承認失敗: 実行せず、作った依頼が承認一覧に残ることを伝える', async () => {
    const { deps } = fakeDeps({
      approveRequest: vi.fn(async () => ({ code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS', message: 'approve-failed', ok: false as const })),
    })
    const result = await runOneTapAbort('t1', { kind: 'none' }, deps)
    expect(result).toEqual({
      approvalRequestId: 'new-req',
      message: `approve-failed\n${oneTapAbortUnapprovedNote('new-req')}`,
      ok: false,
      stage: 'approve',
    })
    expect(result.message).toContain('new-req')
    expect(result.message).toContain('承認一覧に残っています')
    expect(deps.executeAbort).not.toHaveBeenCalled()
  })

  it('承認が期限切れ: 依頼は残らないので、作り直せることを伝える', async () => {
    const { deps } = fakeDeps({
      approveRequest: vi.fn(async () => ({ code: 'APPROVAL_EXPIRED', message: 'expired', ok: false as const })),
    })
    const result = await runOneTapAbort('t1', { approvalRequestId: 'w1', kind: 'waiting' }, deps)
    expect(result).toMatchObject({ message: `expired\n${ONE_TAP_ABORT_EXPIRED_NOTE}`, ok: false, stage: 'approve' })
    expect(deps.executeAbort).not.toHaveBeenCalled()
  })

  it('実行の拒否は abort の code 文言のまま返す', async () => {
    for (const code of ['NOT_AUTHORIZED', 'LIVE_JOB_PRESENT', 'UNATTRIBUTED_DIRTY_WORKSPACE']) {
      const { deps } = fakeDeps({
        executeAbort: vi.fn(async () => ({ message: formatAbortErrorMessage(code), ok: false as const })),
      })
      await expect(runOneTapAbort('t1', { kind: 'none' }, deps)).resolves.toEqual({
        approvalRequestId: 'new-req',
        message: formatAbortErrorMessage(code),
        ok: false,
        stage: 'execute',
      })
    }
  })

  it('実行の拒否 code は submitTaskAbort 経由で formatAbortErrorMessage に写る', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { code: 'TASK_STATE_CHANGED' }))
    const { deps } = fakeDeps({ executeAbort: submitTaskAbort })
    await expect(runOneTapAbort('t1', { approvalRequestId: 'ap1', kind: 'approved' }, deps)).resolves.toMatchObject({
      message: formatAbortErrorMessage('TASK_STATE_CHANGED'),
      ok: false,
      stage: 'execute',
    })
  })

  it('人が承認済みの abort_task がある: 起票も承認もせず実行だけ', async () => {
    const { calls, deps } = fakeDeps()
    await expect(runOneTapAbort('t1', { approvalRequestId: 'ap1', kind: 'approved' }, deps)).resolves.toMatchObject({
      approvalRequestId: 'ap1',
      ok: true,
    })
    expect(deps.createRequest).not.toHaveBeenCalled()
    expect(deps.approveRequest).not.toHaveBeenCalled()
    expect(calls).toEqual(['progress:execute', 'execute:t1:ap1'])
  })

  it('承認待ちの abort_task がある: 新しく作らず、それを承認して実行', async () => {
    const { calls, deps } = fakeDeps()
    await expect(runOneTapAbort('t1', { approvalRequestId: 'w1', kind: 'waiting' }, deps)).resolves.toMatchObject({
      approvalRequestId: 'w1',
      ok: true,
    })
    expect(deps.createRequest).not.toHaveBeenCalled()
    expect(calls).toEqual(['progress:approve', 'approve:w1', 'progress:execute', 'execute:t1:w1'])
  })

  it('依存が throw しても段階に応じた文言で止まる', async () => {
    const { deps } = fakeDeps({ approveRequest: vi.fn(async () => { throw new Error('boom') }) })
    const result = await runOneTapAbort('t1', { kind: 'none' }, deps)
    expect(result).toMatchObject({ approvalRequestId: 'new-req', ok: false, stage: 'approve' })
    expect(result.message).toContain('承認一覧に残っています')
    expect(deps.executeAbort).not.toHaveBeenCalled()
  })
})

describe('createOneTapAbortRunner', () => {
  it('実行中の 2 回目は API を呼ばずに null を返す（二重送信しない）', async () => {
    let releaseCreate: (() => void) | undefined
    const createRequest = vi.fn(() => new Promise<{ ok: true; approvalRequestId: string }>((resolve) => {
      releaseCreate = () => resolve({ approvalRequestId: 'new-req', ok: true })
    }))
    const approveRequest = vi.fn(async () => ({ ok: true as const }))
    const executeAbort = vi.fn(async () => ({ message: ABORT_PARKED_MESSAGE, ok: true as const, status: 'parked' as const }))
    const runner = createOneTapAbortRunner({ approveRequest, createRequest, executeAbort })

    const first = runner.run('t1', { kind: 'none' })
    expect(runner.isRunning()).toBe(true)
    await expect(runner.run('t1', { kind: 'none' })).resolves.toBeNull()
    releaseCreate?.()
    await expect(first).resolves.toMatchObject({ ok: true, status: 'parked' })

    expect(createRequest).toHaveBeenCalledTimes(1)
    expect(approveRequest).toHaveBeenCalledTimes(1)
    expect(executeAbort).toHaveBeenCalledTimes(1)
    expect(runner.isRunning()).toBe(false)

    // 終わった後はもう一度押せる
    await expect(runner.run('t1', { approvalRequestId: 'ap1', kind: 'approved' })).resolves.toMatchObject({ ok: true })
    expect(executeAbort).toHaveBeenCalledTimes(2)
  })
})
