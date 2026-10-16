/**
 * Gate Policy テスト
 *
 * resolvePolicy() は純粋関数なので fetch mock 不要。
 */

import { describe, it, expect } from 'vitest'
import { resolvePolicy, SAFE_WORK_ALLOWED_COMMAND_KINDS } from './gatePolicy.js'
import type { ResolvePolicyResult } from './gatePolicy.js'
import type { GateResult } from './gateProcessor.js'
import type { GateCheckResponse } from './gateClient.js'

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

function makeGateResult(overrides: Partial<GateResult> = {}): GateResult {
  return {
    finalRiskLevel: 'LOW',
    gateDecision: 'ALLOW',
    auditRiskLevel: 'LOW',
    alignmentRiskLevel: 'LOW',
    ...overrides,
  }
}

function makeCheckResponse(overrides: Partial<GateCheckResponse> = {}): GateCheckResponse {
  return {
    outcome: { decision: 'ALLOW', riskLevel: 'LOW' },
    riskReview: { riskLevel: 'LOW', triggeredRules: [], requiresIndependentReview: false },
    sideEffects: [],
    continuationPolicy: 'continue',
    nextAction: { action: 'proceed', message: 'proceed' },
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────
// API 通信失敗は「ポリシーへ縮退させない」（2026-08-01 変更）
//
// 以前は apiError を受け取り continue_safe_work_only / block_until_approved へ
// 縮退させていたが、認証失敗や API 停止でも safe work を継続してしまい、
// さらに技術障害を「CEO承認待ち」として通知していた。
// 現在、Gate API の技術障害は jobRunner が Job を failed にして止めるため、
// この関数は有効なレスポンスがある場合しか呼ばれない。
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — 有効なレスポンス必須', () => {
  it('checkResponse が無い場合はポリシーを返さず例外にする（JS からの誤用を安全側へ倒す）', () => {
    // 型の上では到達しないため、実行時ガードの確認として cast して呼ぶ
    const callWithoutResponse = () =>
      (resolvePolicy as unknown as (l: GateResult, c?: GateCheckResponse) => ResolvePolicyResult)(
        makeGateResult({ finalRiskLevel: 'LOW' }),
        undefined,
      )

    expect(callWithoutResponse).toThrow(/checkResponse is required/)
  })

  it('CRITICAL ローカルリスクでも、レスポンス無しを block_until_approved へ縮退させない', () => {
    const callWithoutResponse = () =>
      (resolvePolicy as unknown as (l: GateResult, c?: GateCheckResponse) => ResolvePolicyResult)(
        makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED' }),
        undefined,
      )

    // 承認待ちではなく例外（＝呼び出し元が技術障害として failed にする）
    expect(callWithoutResponse).toThrow(/technical failures/)
  })

  it('有効なレスポンスがあるときは apiAvailable=true になる', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), makeCheckResponse())
    expect(result.apiAvailable).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// STALE / re_check
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — STALE / re_check', () => {
  it('outcome STALE → re_check', () => {
    const result = resolvePolicy(
      makeGateResult(),
      makeCheckResponse({
        outcome: { decision: 'STALE', requestId: 'req-001', reason: 'commit changed' },
        nextAction: { action: 're_check', message: 're-check needed' },
      }),
    )
    expect(result.policy).toBe('re_check')
    expect(result.apiAvailable).toBe(true)
  })

  it('nextAction re_check → re_check（outcome が STALE でなくても）', () => {
    const result = resolvePolicy(
      makeGateResult(),
      makeCheckResponse({
        outcome: { decision: 'ALLOW', riskLevel: 'LOW' },
        nextAction: { action: 're_check', message: 're-check' },
      }),
    )
    expect(result.policy).toBe('re_check')
  })
})

// ────────────────────────────────────────────────────────────
// PENDING_APPROVAL / BLOCKED
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — PENDING_APPROVAL / BLOCKED', () => {
  it('PENDING_APPROVAL + HIGH → continue_safe_work_only', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH', gateDecision: 'DEEP_REVIEW' }),
      makeCheckResponse({
        outcome: { decision: 'PENDING_APPROVAL', requestId: 'req-001', riskLevel: 'HIGH' },
        riskReview: { riskLevel: 'HIGH', triggeredRules: ['auth'], requiresIndependentReview: true },
        continuationPolicy: 'continue_safe_work_only',
        nextAction: { action: 'wait_for_approval', requestId: 'req-001', message: 'waiting' },
      }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
    expect(result.apiAvailable).toBe(true)
  })

  it('PENDING_APPROVAL + CRITICAL → block_until_approved', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED' }),
      makeCheckResponse({
        outcome: { decision: 'PENDING_APPROVAL', requestId: 'req-002', riskLevel: 'CRITICAL' },
        riskReview: { riskLevel: 'CRITICAL', triggeredRules: ['payment'], requiresIndependentReview: true },
        continuationPolicy: 'block_until_approved',
        nextAction: { action: 'wait_for_approval', requestId: 'req-002', message: 'CEO approval required' },
      }),
    )
    expect(result.policy).toBe('block_until_approved')
  })

  it('BLOCKED + HIGH → continue_safe_work_only', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH', gateDecision: 'DEEP_REVIEW' }),
      makeCheckResponse({
        outcome: { decision: 'BLOCKED', reason: 'no existing approval', riskLevel: 'HIGH' },
        riskReview: { riskLevel: 'HIGH', triggeredRules: ['auth'], requiresIndependentReview: true },
        continuationPolicy: 'continue_safe_work_only',
        nextAction: { action: 'wait_for_approval', message: 'approval created' },
      }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
  })

  it('BLOCKED + CRITICAL → block_until_approved', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED' }),
      makeCheckResponse({
        outcome: { decision: 'BLOCKED', reason: 'CRITICAL', riskLevel: 'CRITICAL' },
        riskReview: { riskLevel: 'CRITICAL', triggeredRules: ['payment'], requiresIndependentReview: true },
        continuationPolicy: 'block_until_approved',
        nextAction: { action: 'wait_for_approval', message: 'CEO approval required' },
      }),
    )
    expect(result.policy).toBe('block_until_approved')
  })
})

// ────────────────────────────────────────────────────────────
// ローカルリスクによる escalation
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — ローカルリスク escalation', () => {
  it('localRisk LOW + api continue → continue', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'LOW' }),
      makeCheckResponse({ continuationPolicy: 'continue' }),
    )
    expect(result.policy).toBe('continue')
  })

  it('localRisk HIGH + api continue → continue_safe_work_only (escalation)', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH', gateDecision: 'DEEP_REVIEW', reason: 'dangerous file' }),
      makeCheckResponse({ continuationPolicy: 'continue' }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
    expect(result.reason).toContain('Escalating')
  })

  it('localRisk CRITICAL + api continue → block_until_approved (escalation)', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED', reason: 'payment file' }),
      makeCheckResponse({ continuationPolicy: 'continue' }),
    )
    expect(result.policy).toBe('block_until_approved')
    expect(result.reason).toContain('Escalating')
  })

  it('localRisk CRITICAL + api continue_safe_work_only → block_until_approved (escalation)', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED' }),
      makeCheckResponse({ continuationPolicy: 'continue_safe_work_only' }),
    )
    expect(result.policy).toBe('block_until_approved')
  })

  it('localRisk HIGH + api continue_safe_work_only → continue_safe_work_only (no further escalation)', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH', gateDecision: 'DEEP_REVIEW' }),
      makeCheckResponse({ continuationPolicy: 'continue_safe_work_only' }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
  })
})

// ────────────────────────────────────────────────────────────
// API policy をそのまま採用するケース
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — API policy の採用', () => {
  it('api continuationPolicy block_until_approved → block_until_approved', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'LOW' }),
      makeCheckResponse({ continuationPolicy: 'block_until_approved' }),
    )
    expect(result.policy).toBe('block_until_approved')
    expect(result.apiAvailable).toBe(true)
  })

  it('api continuationPolicy continue_safe_work_only → continue_safe_work_only', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'LOW' }),
      makeCheckResponse({ continuationPolicy: 'continue_safe_work_only' }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
  })

  it('ALLOW + proceed → continue', () => {
    const result = resolvePolicy(
      makeGateResult(),
      makeCheckResponse({
        outcome: { decision: 'ALLOW', riskLevel: 'LOW' },
        continuationPolicy: 'continue',
        nextAction: { action: 'proceed', message: 'proceed' },
      }),
    )
    expect(result.policy).toBe('continue')
  })
})

// ────────────────────────────────────────────────────────────
// 2026-10-16 b8d0fc5d: API は SAFE_WORK の HIGH に承認依頼を作らない（requestId 無しの BLOCKED）
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — 承認依頼の無い SAFE_WORK HIGH / 依頼のある CRITICAL', () => {
  it('HIGH の BLOCKED で requestId が無くても continue_safe_work_only（safe work はそのまま続く）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH' }),
      makeCheckResponse({
        outcome: { decision: 'BLOCKED', riskLevel: 'HIGH' },
        riskReview: { riskLevel: 'HIGH', triggeredRules: ['decision authority / safety policy doc'], requiresIndependentReview: true },
        continuationPolicy: 'continue_safe_work_only',
        nextAction: { action: 'wait_for_approval', message: 'safe work only' },
      }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
    expect(SAFE_WORK_ALLOWED_COMMAND_KINDS).toContain('git_status')
  })

  it('ローカルが CRITICAL でも API の HIGH BLOCKED（依頼なし）は continue_safe_work_only のまま（API 判定を採る既存挙動）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED' }),
      makeCheckResponse({
        outcome: { decision: 'BLOCKED', riskLevel: 'HIGH' },
        riskReview: { riskLevel: 'HIGH', triggeredRules: [], requiresIndependentReview: true },
        continuationPolicy: 'continue_safe_work_only',
        nextAction: { action: 'wait_for_approval', message: 'safe work only' },
      }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
  })

  it('CRITICAL の BLOCKED（承認依頼あり）は block_until_approved で、requestId を理由に載せる', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      makeCheckResponse({
        outcome: { decision: 'BLOCKED', riskLevel: 'CRITICAL' },
        riskReview: { riskLevel: 'CRITICAL', triggeredRules: ['AI instruction file'], requiresIndependentReview: true },
        continuationPolicy: 'block_until_approved',
        nextAction: { action: 'wait_for_approval', requestId: 'approval-critical-1', message: 'blocked' },
      }),
    )
    expect(result.policy).toBe('block_until_approved')
    expect(result.reason).toContain('approval-critical-1')
  })
})

// ────────────────────────────────────────────────────────────
// D2（2026-10-17）: 人間承認を使い切る ALLOW + call_consume はローカル escalation で格下げしない。
// 実行は直後の atomic consume が成功したときだけ進む（jobRunner は不変）。
// ────────────────────────────────────────────────────────────

function approvedConsume(
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  overrides: Partial<GateCheckResponse> = {},
): GateCheckResponse {
  return makeCheckResponse({
    outcome: { decision: 'ALLOW', riskLevel: risk, consumedRequestId: 'approval-d2' },
    riskReview: { riskLevel: risk, triggeredRules: [], requiresIndependentReview: true },
    continuationPolicy: 'continue',
    nextAction: { action: 'call_consume', consumedRequestId: 'approval-d2', message: 'consume it' },
    approvalRequest: { id: 'approval-d2', status: 'APPROVED', expiresAt: '2099-01-01T00:00:00.000Z', riskLevel: risk },
    ...overrides,
  })
}

describe('resolvePolicy — D2 承認済み call_consume', () => {
  it('HIGH ALLOW + call_consume、ローカル HIGH → continue（承認済み commit を consume 前に止めない）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), approvedConsume('HIGH'))
    expect(result.policy).toBe('continue')
    expect(result.reason).toBe('consume it')
  })

  it('CRITICAL ALLOW + call_consume、ローカル CRITICAL → continue（承認後は HIGH と同じ）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'CRITICAL' }), approvedConsume('CRITICAL'))
    expect(result.policy).toBe('continue')
  })

  it('ALLOW + proceed（承認を使わない）、ローカル HIGH → continue_safe_work_only（escalation は残る）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH' }),
      makeCheckResponse({ outcome: { decision: 'ALLOW', riskLevel: 'LOW' }, nextAction: { action: 'proceed', message: 'go' } }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
  })

  it('ALLOW + proceed、ローカル CRITICAL → block_until_approved（escalation は残る）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      makeCheckResponse({ outcome: { decision: 'ALLOW', riskLevel: 'LOW' }, nextAction: { action: 'proceed', message: 'go' } }),
    )
    expect(result.policy).toBe('block_until_approved')
  })

  it('call_consume でも consumedRequestId が空・continuationPolicy が continue でない → 例外扱いしない', () => {
    expect(resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH' }),
      approvedConsume('HIGH', { nextAction: { action: 'call_consume', consumedRequestId: '', message: 'x' } }),
    ).policy).toBe('continue_safe_work_only')
    expect(resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      approvedConsume('CRITICAL', { continuationPolicy: 'continue_safe_work_only' }),
    ).policy).toBe('block_until_approved')
  })

  it.each([
    ['PENDING_APPROVAL', 'HIGH', 'continue_safe_work_only'],
    ['BLOCKED', 'HIGH', 'continue_safe_work_only'],
    ['PENDING_APPROVAL', 'CRITICAL', 'block_until_approved'],
    ['BLOCKED', 'CRITICAL', 'block_until_approved'],
  ] as const)('%s（%s）は承認前のまま（%s）', (decision, risk, expected) => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: risk }),
      approvedConsume(risk, {
        outcome: { decision, riskLevel: risk, requestId: 'approval-d2' },
        continuationPolicy: risk === 'CRITICAL' ? 'block_until_approved' : 'continue_safe_work_only',
        nextAction: { action: 'wait_for_approval', requestId: 'approval-d2', message: 'waiting' },
      }),
    )
    expect(result.policy).toBe(expected)
  })

  it('STALE は re_check のまま', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH' }),
      approvedConsume('HIGH', {
        outcome: { decision: 'STALE', requestId: 'approval-d2', reason: 'diff changed' },
        nextAction: { action: 're_check', message: 're-check' },
      }),
    )
    expect(result.policy).toBe('re_check')
  })
})
