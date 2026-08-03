/**
 * Gate Policy テスト
 *
 * resolvePolicy() は純粋関数なので fetch mock 不要。
 */

import { describe, it, expect } from 'vitest'
import { resolvePolicy } from './gatePolicy.js'
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
