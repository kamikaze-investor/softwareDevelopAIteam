/**
 * Gate Client テスト
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { callGateCheck, callConsume, GateClientError } from './gateClient.js'
import type { GateCheckParams, ConsumeParams, GateCheckResponse } from './gateClient.js'

// fetch をモック
const mockFetch = vi.fn<typeof fetch>()
vi.stubGlobal('fetch', mockFetch)

afterEach(() => {
  vi.clearAllMocks()
})

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
    expect(err.message).toContain('network error')
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
    expect(err.message).toContain('network error')
  })
})
