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
// D2（2026-10-17）: API の continuationPolicy をそのまま写す。ローカルのリスクで実行可否を再判定しない。
// ────────────────────────────────────────────────────────────

type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

function waiting(
  decision: 'PENDING_APPROVAL' | 'BLOCKED' | 'REJECTED',
  risk: Risk,
  continuationPolicy: 'continue_safe_work_only' | 'block_until_approved',
  requestId?: string,
): GateCheckResponse {
  return makeCheckResponse({
    outcome: { decision, riskLevel: risk, ...(requestId ? { requestId } : {}) },
    riskReview: { riskLevel: risk, triggeredRules: [], requiresIndependentReview: risk === 'HIGH' || risk === 'CRITICAL' },
    continuationPolicy,
    nextAction: { action: 'wait_for_approval', ...(requestId ? { requestId } : {}), message: 'waiting' },
  })
}

function approvedConsume(risk: Risk): GateCheckResponse {
  return makeCheckResponse({
    outcome: { decision: 'ALLOW', riskLevel: risk, consumedRequestId: 'approval-d2' },
    riskReview: { riskLevel: risk, triggeredRules: [], requiresIndependentReview: true },
    continuationPolicy: 'continue',
    nextAction: { action: 'call_consume', consumedRequestId: 'approval-d2', message: 'consume it' },
    approvalRequest: { id: 'approval-d2', status: 'APPROVED', expiresAt: '2099-01-01T00:00:00.000Z', riskLevel: risk },
  })
}

function allowProceed(risk: Risk): GateCheckResponse {
  return makeCheckResponse({
    outcome: { decision: 'ALLOW', riskLevel: risk },
    riskReview: { riskLevel: risk, triggeredRules: [], requiresIndependentReview: risk === 'HIGH' || risk === 'CRITICAL' },
    continuationPolicy: 'continue',
    nextAction: { action: 'proceed', message: 'go' },
  })
}

describe('resolvePolicy — PENDING_APPROVAL / BLOCKED / REJECTED は API の continuationPolicy をそのまま写す', () => {
  // API の computeContinuationPolicy: HIGH → continue_safe_work_only、CRITICAL → block_until_approved、
  // policy 起因（git_commit の人間承認）→ riskLevel に関わらず block_until_approved。REJECTED も API の値をそのまま写す。
  it.each([
    ['PENDING_APPROVAL', 'HIGH', 'continue_safe_work_only'],
    ['BLOCKED', 'HIGH', 'continue_safe_work_only'],
    ['PENDING_APPROVAL', 'CRITICAL', 'block_until_approved'],
    ['BLOCKED', 'CRITICAL', 'block_until_approved'],
    ['BLOCKED', 'LOW', 'block_until_approved'],
    ['BLOCKED', 'HIGH', 'block_until_approved'],
    ['PENDING_APPROVAL', 'MEDIUM', 'block_until_approved'],
    ['REJECTED', 'HIGH', 'continue_safe_work_only'],
    ['REJECTED', 'HIGH', 'block_until_approved'],
    ['REJECTED', 'CRITICAL', 'block_until_approved'],
    ['REJECTED', 'LOW', 'block_until_approved'],
  ] as const)('%s（%s）+ API %s → そのまま', (decision, risk, apiPolicy) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), waiting(decision, risk, apiPolicy, 'req-1'))
    expect(result.policy).toBe(apiPolicy)
    expect(result.apiAvailable).toBe(true)
  })

  it('非 continue の理由には decision・risk・requestId を載せる（通知用）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      waiting('BLOCKED', 'CRITICAL', 'block_until_approved', 'approval-critical-1'),
    )
    expect(result.reason).toContain('BLOCKED (CRITICAL)')
    expect(result.reason).toContain('approval-critical-1')
  })

  it('HIGH の BLOCKED で requestId が無くても continue_safe_work_only（safe work はそのまま続く）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), waiting('BLOCKED', 'HIGH', 'continue_safe_work_only'))
    expect(result.policy).toBe('continue_safe_work_only')
    expect(SAFE_WORK_ALLOWED_COMMAND_KINDS).toContain('git_status')
  })

})

describe('resolvePolicy — ALLOW はローカルのリスクで格下げしない（D2）', () => {
  it.each(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)('ALLOW + call_consume（%s）、ローカル同じ → continue', (risk) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), approvedConsume(risk))
    expect(result.policy).toBe('continue')
    expect(result.reason).toBe('consume it')
  })

  it.each(['HIGH', 'CRITICAL'] as const)('ALLOW + proceed（%s、将来の Evidence 経路）、ローカル同じ → continue（再ブロックしない）', (risk) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), allowProceed(risk))
    expect(result.policy).toBe('continue')
  })

  it('ローカルが API より低い（LOW < HIGH）→ API に従う', () => {
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), approvedConsume('HIGH')).policy).toBe('continue')
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), waiting('BLOCKED', 'CRITICAL', 'block_until_approved')).policy)
      .toBe('block_until_approved')
  })
})

describe('resolvePolicy — ローカルのリスク > API のリスク は block_until_approved（rule の版ずれ。実行も safe work も consume もしない）', () => {
  it.each([
    ['ALLOW + proceed', 'HIGH', allowProceed('LOW')],
    ['ALLOW + proceed', 'CRITICAL', allowProceed('MEDIUM')],
    ['ALLOW + call_consume', 'CRITICAL', approvedConsume('HIGH')],
    ['BLOCKED', 'CRITICAL', waiting('BLOCKED', 'HIGH', 'continue_safe_work_only')],
    ['PENDING_APPROVAL', 'CRITICAL', waiting('PENDING_APPROVAL', 'HIGH', 'continue_safe_work_only', 'r')],
  ] as const)('%s: ローカル %s > API → block_until_approved（例外にしない）', (_label, local, response) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: local }), response)
    expect(result.policy).toBe('block_until_approved')
    expect(result.reason).toBe(`risk inconsistency: local ${local} > API ${response.riskReview.riskLevel} (worker/api rule skew)`)
  })

  it('ローカルのリスク値が読めない → block_until_approved', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'SEVERE' as never }), allowProceed('CRITICAL'))
    expect(result.policy).toBe('block_until_approved')
    expect(result.reason).toContain('risk inconsistency')
  })

  it('STALE / re_check はリスク比較より先に re_check（従来どおり）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      makeCheckResponse({
        outcome: { decision: 'STALE', requestId: 'r', reason: 'diff changed' },
        riskReview: { riskLevel: 'LOW', triggeredRules: [], requiresIndependentReview: false },
        nextAction: { action: 're_check', message: 're-check' },
      }),
    )
    expect(result.policy).toBe('re_check')
  })
})

describe('resolvePolicy — 項目間の契約が破れた応答は block_until_approved（gateClient が先に技術障害にする。二重の防御）', () => {
  it.each<[string, GateCheckResponse]>([
    ['call_consume なのに decision が ALLOW でない', { ...approvedConsume('HIGH'), outcome: { decision: 'PENDING_APPROVAL', riskLevel: 'HIGH', requestId: 'approval-d2' } }],
    ['call_consume なのに consumedRequestId が空', { ...approvedConsume('HIGH'), nextAction: { action: 'call_consume', consumedRequestId: '', message: 'x' } }],
    ['outcome と nextAction の consumedRequestId が違う', { ...approvedConsume('HIGH'), outcome: { decision: 'ALLOW', riskLevel: 'HIGH', consumedRequestId: 'other' } }],
    ['ALLOW なのに continue でない', { ...approvedConsume('HIGH'), continuationPolicy: 'continue_safe_work_only' }],
    ['ALLOW なのに wait_for_approval', { ...allowProceed('LOW'), nextAction: { action: 'wait_for_approval', message: 'x' } }],
    ['BLOCKED なのに continue', { ...waiting('BLOCKED', 'HIGH', 'continue_safe_work_only'), continuationPolicy: 'continue' }],
    ['REJECTED なのに continue', { ...waiting('REJECTED', 'HIGH', 'block_until_approved'), continuationPolicy: 'continue' }],
    ['PENDING_APPROVAL なのに proceed', { ...waiting('PENDING_APPROVAL', 'HIGH', 'continue_safe_work_only'), nextAction: { action: 'proceed', message: 'x' } }],
  ])('%s → block_until_approved', (_label, response) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), response)
    expect(result.policy).toBe('block_until_approved')
    expect(result.reason).toContain('incoherent Gate response')
  })
})
