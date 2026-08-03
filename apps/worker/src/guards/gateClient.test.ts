/**
 * Gate Client テスト
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { callGateCheck, callConsume, GateClientError } from './gateClient.js'
import type { GateCheckParams, ConsumeParams, GateCheckResponse } from './gateClient.js'

// fetch をモック
const mockFetch = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', mockFetch)

const TOKEN_BACKUP: { value?: string } = {}

beforeEach(() => {
  TOKEN_BACKUP.value = process.env.API_TOKEN
  delete process.env.API_TOKEN
})

afterEach(() => {
  vi.clearAllMocks()
  if (TOKEN_BACKUP.value === undefined) delete process.env.API_TOKEN
  else process.env.API_TOKEN = TOKEN_BACKUP.value
})

function requestHeaders(callIndex = 0): Record<string, string> {
  return (mockFetch.mock.calls[callIndex][1] as RequestInit).headers as Record<string, string>
}

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

function makeGateCheckParams(overrides: Partial<GateCheckParams> = {}): GateCheckParams {
  return {
    taskId: 'task-001',
    requestedAction: 'merge feature branch',
    targetBranch: 'feat/test',
    targetCommit: 'abc123',
    targetDiffHash: 'deadbeef',
    changedFiles: ['src/feature.ts'],
    ...overrides,
  }
}

function makeConsumeParams(overrides: Partial<ConsumeParams> = {}): ConsumeParams {
  return {
    currentCommit: 'abc123',
    currentDiffHash: 'deadbeef',
    ...overrides,
  }
}

function makeGateCheckResponse(overrides: Partial<GateCheckResponse> = {}): GateCheckResponse {
  return {
    outcome: { decision: 'ALLOW', riskLevel: 'LOW' },
    riskReview: { riskLevel: 'LOW', triggeredRules: [], requiresIndependentReview: false },
    sideEffects: [],
    continuationPolicy: 'continue',
    nextAction: { action: 'proceed', message: 'proceed' },
    ...overrides,
  }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

// ────────────────────────────────────────────────────────────
// callGateCheck
// ────────────────────────────────────────────────────────────

describe('callGateCheck', () => {
  it('2xx → GateCheckResponse を返す', async () => {
    const response = makeGateCheckResponse()
    mockFetch.mockResolvedValueOnce(makeJsonResponse(response))

    const result = await callGateCheck(makeGateCheckParams())
    expect(result.outcome.decision).toBe('ALLOW')
    expect(result.continuationPolicy).toBe('continue')
  })

  it('ALLOW + call_consume → response をそのまま返す', async () => {
    const response = makeGateCheckResponse({
      outcome: { decision: 'ALLOW', riskLevel: 'HIGH', consumedRequestId: 'req-001' },
      continuationPolicy: 'continue',
      nextAction: { action: 'call_consume', consumedRequestId: 'req-001', message: 'consume it' },
    })
    mockFetch.mockResolvedValueOnce(makeJsonResponse(response))

    const result = await callGateCheck(makeGateCheckParams())
    expect(result.nextAction.action).toBe('call_consume')
    expect(result.nextAction.consumedRequestId).toBe('req-001')
  })

  it('BLOCKED → response をそのまま返す（呼び出し元が判断）', async () => {
    const response = makeGateCheckResponse({
      outcome: { decision: 'BLOCKED', riskLevel: 'CRITICAL', reason: 'CRITICAL risk' },
      continuationPolicy: 'block_until_approved',
      nextAction: { action: 'wait_for_approval', message: 'waiting' },
    })
    mockFetch.mockResolvedValueOnce(makeJsonResponse(response))

    const result = await callGateCheck(makeGateCheckParams())
    expect(result.outcome.decision).toBe('BLOCKED')
  })

  it('ネットワークエラー → GateClientError (network error メッセージ)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.message).toContain('network_error')
  })

  it('400 → GateClientError (HTTP 400 メッセージ)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Validation failed',
    } as Response)
    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.message).toContain('HTTP 400')
  })

  it('500 → GateClientError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response)

    await expect(callGateCheck(makeGateCheckParams())).rejects.toThrow(GateClientError)
  })

  // ── 認証ヘッダー ────────────────────────────────────────────

  it('API_TOKEN 設定時は Authorization header が付く', async () => {
    process.env.API_TOKEN = 'test-secret-token'
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse()))

    await callGateCheck(makeGateCheckParams())

    expect(requestHeaders().authorization).toBe('Bearer test-secret-token')
    expect(requestHeaders()['Content-Type']).toBe('application/json')
  })

  it('API_TOKEN 未設定のローカル開発モードでは Authorization header を付けない', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse()))

    await callGateCheck(makeGateCheckParams())

    expect(requestHeaders().authorization).toBeUndefined()
  })

  // ── 技術障害の分類（safe work / 承認待ちへ変換しない） ──────────

  it.each([400, 401, 403, 404, 409, 429, 500, 503])(
    'HTTP %i は technical failure（Gate 判断へ変換しない）',
    async (status) => {
      mockFetch.mockResolvedValueOnce({ ok: false, status, text: async () => 'x' } as Response)

      const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
      expect(err).toBeInstanceOf(GateClientError)
      expect(err.technicalFailure).toBe(true)
      expect(err.message).toContain(`HTTP ${status}`)
    },
  )

  it('network error は technical failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err.technicalFailure).toBe(true)
  })

  it('timeout（AbortError）は technical failure', async () => {
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    )

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('timeout')
  })

  it('不正 JSON は technical failure（Gate 判断として採用しない）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    } as unknown as Response)

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('invalid_json')
  })

  it.each([
    ['outcome 欠落', { riskReview: { riskLevel: 'LOW' }, continuationPolicy: 'continue', nextAction: { action: 'proceed', message: 'm' } }],
    ['decision が未知の値', { outcome: { decision: 'WHATEVER' }, riskReview: { riskLevel: 'LOW' }, continuationPolicy: 'continue', nextAction: { action: 'proceed', message: 'm' } }],
    ['continuationPolicy が未知の値', { outcome: { decision: 'ALLOW' }, riskReview: { riskLevel: 'LOW' }, continuationPolicy: 'go_wild', nextAction: { action: 'proceed', message: 'm' } }],
    ['nextAction.action が未知の値', { outcome: { decision: 'ALLOW' }, riskReview: { riskLevel: 'LOW' }, continuationPolicy: 'continue', nextAction: { action: 'nope', message: 'm' } }],
    ['riskReview 欠落', { outcome: { decision: 'ALLOW' }, continuationPolicy: 'continue', nextAction: { action: 'proceed', message: 'm' } }],
    ['エラー object を 200 で返す', { error: 'Unauthorized' }],
  ])('schema 不一致（%s）は technical failure', async (_label, body) => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(body))

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('invalid response')
  })

  it('REJECTED decision は schema 上有効（API が実際に返しうる）', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse({
      outcome: { decision: 'REJECTED', requestId: 'req-001', riskLevel: 'HIGH' },
      continuationPolicy: 'continue_safe_work_only',
      nextAction: { action: 'wait_for_approval', requestId: 'req-001', message: 'rejected' },
    })))

    const result = await callGateCheck(makeGateCheckParams())
    expect(result.outcome.decision).toBe('REJECTED')
  })

  // ── closure修正（Codex指摘）: riskLevel enum・call_consume schema・本文漏えい ──

  it('riskReview.riskLevel が既知の値でない場合は technical failure（Codex指摘#4a）', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse({
      riskReview: { riskLevel: 'TOTALLY-BOGUS', triggeredRules: [], requiresIndependentReview: false },
    })))

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('invalid response')
  })

  it('outcome.riskLevel が既知の値でない場合は technical failure（Codex指摘#4a）', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse({
      outcome: { decision: 'PENDING_APPROVAL', requestId: 'r1', riskLevel: 'NONSENSE' },
    })))

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err.technicalFailure).toBe(true)
  })

  it('nextAction.action が call_consume なのに consumedRequestId が無い場合は technical failure（Codex指摘#4b）', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse({
      outcome: { decision: 'ALLOW', riskLevel: 'HIGH' },
      continuationPolicy: 'continue',
      nextAction: { action: 'call_consume', message: 'consume it' }, // consumedRequestId 欠落
    })))

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('invalid response')
  })

  it('nextAction.action が call_consume で consumedRequestId が空文字列の場合も technical failure', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(makeGateCheckResponse({
      outcome: { decision: 'ALLOW', riskLevel: 'HIGH' },
      continuationPolicy: 'continue',
      nextAction: { action: 'call_consume', consumedRequestId: '', message: 'consume it' },
    })))

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err.technicalFailure).toBe(true)
  })

  it('reason へ応答本文の断片を含めない（不正 JSON の場合、Codex指摘#6b）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in <html>LEAKED-SECRET-abc123</html>') },
    } as unknown as Response)

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err.message).not.toContain('LEAKED-SECRET')
    expect(err.message).not.toContain('<html>')
  })

  it('エラーメッセージへ token を含めない', async () => {
    process.env.API_TOKEN = 'super-secret-token-value'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Invalid token' } as Response)

    const err = await callGateCheck(makeGateCheckParams()).catch(e => e)
    expect(err.message).not.toContain('super-secret-token-value')
  })
})

// ────────────────────────────────────────────────────────────
// callConsume
// ────────────────────────────────────────────────────────────

describe('callConsume', () => {
  it('2xx → { ok: true } を返す', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'req-001', status: 'CONSUMED' }))

    const result = await callConsume('req-001', makeConsumeParams())
    expect(result.ok).toBe(true)
    expect(result.alreadyConsumed).toBeUndefined()
  })

  it("409 + status='CONSUMED' → alreadyConsumed=true を返す（STOP しない）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "Cannot consume: current status is 'CONSUMED' (must be APPROVED)" }),
      text: async () => '',
    } as Response)

    const result = await callConsume('req-001', makeConsumeParams())
    expect(result.ok).toBe(true)
    expect(result.alreadyConsumed).toBe(true)
  })

  it('409 expired → GateClientError (HTTP 409 メッセージ)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Approval request has expired' }),
      text: async () => '',
    } as Response)
    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.message).toContain('HTTP 409')
  })

  it('409 stale → GateClientError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Approval request is stale: commit or diff has changed' }),
      text: async () => '',
    } as Response)
    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
  })

  it('404 → GateClientError (HTTP 404 メッセージ)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Approval request not found' }),
      text: async () => '',
    } as Response)
    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.message).toContain('HTTP 404')
  })

  it('ネットワークエラー → GateClientError (network error メッセージ)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'))
    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.message).toContain('network_error')
  })

  // ── 認証ヘッダー ────────────────────────────────────────────

  it('API_TOKEN 設定時は Authorization header が付く', async () => {
    process.env.API_TOKEN = 'test-secret-token'
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'req-001', status: 'CONSUMED' }))

    await callConsume('req-001', makeConsumeParams())

    expect(requestHeaders().authorization).toBe('Bearer test-secret-token')
  })

  it('API_TOKEN 未設定のローカル開発モードでは Authorization header を付けない', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'req-001', status: 'CONSUMED' }))

    await callConsume('req-001', makeConsumeParams())

    expect(requestHeaders().authorization).toBeUndefined()
  })

  // ── 業務上の block（API 契約上意味を持つ status） ──────────────

  it('404 は業務上の block（technicalFailure=false）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Approval request not found' }),
    } as Response)

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err.technicalFailure).toBe(false)
  })

  it.each([
    ['expired', 'Approval request has expired'],
    ['stale', 'Approval request is stale: commit or diff has changed'],
    ['non-APPROVED', "Cannot consume: current status is 'WAITING_FOR_USER' (must be APPROVED)"],
  ])('409 %s は業務上の block（technicalFailure=false）', async (_label, error) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error }),
    } as Response)

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err.technicalFailure).toBe(false)
  })

  it("409 + 'CONSUMED' の冪等成功は既存どおり継続する（technical failure にしない）", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "Cannot consume: current status is 'CONSUMED' (must be APPROVED)" }),
    } as Response)

    const result = await callConsume('req-001', makeConsumeParams())
    expect(result.ok).toBe(true)
    expect(result.alreadyConsumed).toBe(true)
  })

  // ── 技術障害（消費できたか確認できない） ───────────────────────

  it.each([400, 401, 403, 429, 500, 503])(
    'HTTP %i は technical failure（消費済み扱いにしない）',
    async (status) => {
      mockFetch.mockResolvedValueOnce({ ok: false, status, text: async () => 'x' } as Response)

      const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
      expect(err).toBeInstanceOf(GateClientError)
      expect(err.technicalFailure).toBe(true)
      expect(err.message).toContain(`HTTP ${status}`)
    },
  )

  it('network error は technical failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err.technicalFailure).toBe(true)
  })

  it('timeout（AbortError）は technical failure', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('timeout')
  })

  it('200 だが不正 JSON は technical failure（消費済み扱いにしない）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json') },
    } as unknown as Response)

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('invalid_json')
  })

  it.each([
    ['空 body', undefined],
    ['status が CONSUMED でない', { id: 'req-001', status: 'APPROVED' }],
    ['id が無い', { status: 'CONSUMED' }],
    ['エラー object', { error: 'nope' }],
  ])('200 だが schema 不一致（%s）は technical failure', async (_label, body) => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(body))

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('consumption unconfirmed')
  })

  it('エラーメッセージへ token を含めない', async () => {
    process.env.API_TOKEN = 'super-secret-token-value'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Invalid token' } as Response)

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err.message).not.toContain('super-secret-token-value')
  })

  // ── closure修正（Codex指摘）: consume 200 の id 照合・本文漏えい ──────────

  it('200 だが別の requestId を返す場合は technical failure にする（消費済み扱いにしない、Codex指摘#5b）', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ id: 'SOME-OTHER-REQUEST-ID', status: 'CONSUMED' }))

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err).toBeInstanceOf(GateClientError)
    expect(err.technicalFailure).toBe(true)
    expect(err.message).toContain('consumption unconfirmed')
  })

  it('reason へ応答本文の断片を含めない（不正 JSON の場合、Codex指摘#6b）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in <html>LEAKED-SECRET-abc123</html>') },
    } as unknown as Response)

    const err = await callConsume('req-001', makeConsumeParams()).catch(e => e)
    expect(err.message).not.toContain('LEAKED-SECRET')
    expect(err.message).not.toContain('<html>')
  })
})
