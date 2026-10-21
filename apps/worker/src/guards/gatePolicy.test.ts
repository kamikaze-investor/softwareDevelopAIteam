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
import { findGateTechnicalStopCode } from '@ai-team/shared'

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
// D2 v4（2026-10-17）
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

describe('resolvePolicy — PENDING_APPROVAL / BLOCKED は従来どおり API の riskLevel で分岐', () => {
  it.each([
    ['PENDING_APPROVAL', 'HIGH', 'continue_safe_work_only', 'continue_safe_work_only'],
    ['BLOCKED', 'HIGH', 'continue_safe_work_only', 'continue_safe_work_only'],
    ['BLOCKED', 'HIGH', 'block_until_approved', 'continue_safe_work_only'],
    ['PENDING_APPROVAL', 'CRITICAL', 'block_until_approved', 'block_until_approved'],
    ['BLOCKED', 'CRITICAL', 'block_until_approved', 'block_until_approved'],
    ['BLOCKED', 'LOW', 'block_until_approved', 'continue_safe_work_only'],
    ['PENDING_APPROVAL', 'MEDIUM', 'block_until_approved', 'continue_safe_work_only'],
  ] as const)('%s（%s, API %s）→ %s', (decision, risk, apiPolicy, expected) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), waiting(decision, risk, apiPolicy, 'req-1'))
    expect(result.policy).toBe(expected)
    expect(result.apiAvailable).toBe(true)
  })

  it('LOW / MEDIUM（policy 起因の承認待ち）の理由は実際の riskLevel を書く（HIGH と偽らない）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), waiting('BLOCKED', 'LOW', 'block_until_approved', 'req-low'))
    expect(result.reason).toBe('BLOCKED: LOW risk — safe work only until approved. requestId=req-low')
    expect(result.reason).not.toContain('HIGH')
  })

  it('CRITICAL の理由には requestId を載せる', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'CRITICAL' }), waiting('BLOCKED', 'CRITICAL', 'block_until_approved', 'approval-critical-1'))
    expect(result.reason).toContain('approval-critical-1')
  })

  it('HIGH の BLOCKED で requestId が無くても continue_safe_work_only（safe work はそのまま続く）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), waiting('BLOCKED', 'HIGH', 'continue_safe_work_only'))
    expect(result.policy).toBe('continue_safe_work_only')
    expect(SAFE_WORK_ALLOWED_COMMAND_KINDS).toContain('git_status')
  })
})

describe('resolvePolicy — REJECTED は API の policy を採用（従来どおり）', () => {
  it.each([
    ['HIGH', 'continue_safe_work_only', 'continue_safe_work_only'],
    ['HIGH', 'block_until_approved', 'block_until_approved'],
    ['CRITICAL', 'block_until_approved', 'block_until_approved'],
    ['CRITICAL', 'continue_safe_work_only', 'block_until_approved'],
  ] as const)('REJECTED（%s, API %s）→ %s', (risk, apiPolicy, expected) => {
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: risk }), waiting('REJECTED', risk, apiPolicy, 'r')).policy).toBe(expected)
  })
})

describe('resolvePolicy — ALLOW はローカルの HIGH / CRITICAL で格下げしない（D2）', () => {
  it.each(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)('ALLOW + call_consume（%s）、ローカル同じ → continue', (risk) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), approvedConsume(risk))
    expect(result.policy).toBe('continue')
    expect(result.reason).toBe('consume it')
  })

  it.each(['LOW', 'MEDIUM'] as const)('ALLOW + proceed（%s）→ continue', (risk) => {
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: risk }), allowProceed(risk)).policy).toBe('continue')
  })

  // API の decideGateOutcome は HIGH / CRITICAL を consumedRequestId 付き（call_consume）でしか ALLOW しない。
  // HIGH / CRITICAL の ALLOW + proceed は consume 無しの実行になるので契約違反（re_check）。
  it.each(['HIGH', 'CRITICAL'] as const)('ALLOW + proceed（%s）は契約外 → re_check approval_contract_violation（consume 無しで実行しない）', (risk) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), allowProceed(risk))
    expect(result.policy).toBe('re_check')
    expect(findGateTechnicalStopCode(result.reason)).toBe('approval_contract_violation')
  })

  it('ローカルが API より低い → API に従う', () => {
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), approvedConsume('HIGH')).policy).toBe('continue')
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), waiting('BLOCKED', 'CRITICAL', 'block_until_approved')).policy)
      .toBe('block_until_approved')
  })
})

describe('resolvePolicy — 既知でないローカルのリスクは CRITICAL として比べる', () => {
  it('ローカルが未知の値 + API HIGH → re_check risk_rule_skew（低いと見なして実行しない）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'SEVERE' as never }), approvedConsume('HIGH'))
    expect(result.policy).toBe('re_check')
    expect(findGateTechnicalStopCode(result.reason)).toBe('risk_rule_skew')
    expect(result.reason).toContain('local CRITICAL > API HIGH')
  })

  it('ローカルが未知の値 + API CRITICAL → skew ではない（API に従う）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'SEVERE' as never }), approvedConsume('CRITICAL'))
    expect(findGateTechnicalStopCode(result.reason)).toBeUndefined()
    expect(result.policy).toBe('continue')
  })
})

describe('resolvePolicy — ローカルのリスク > API のリスク → re_check risk_rule_skew（技術的不整合。承認待ちにも safe work にもしない）', () => {
  it.each([
    ['ALLOW + proceed', 'HIGH', allowProceed('LOW')],
    ['ALLOW + proceed', 'CRITICAL', allowProceed('MEDIUM')],
    ['ALLOW + call_consume', 'CRITICAL', approvedConsume('HIGH')],
    ['ALLOW + call_consume', 'HIGH', approvedConsume('LOW')],
    ['BLOCKED（safe work only）', 'CRITICAL', waiting('BLOCKED', 'HIGH', 'continue_safe_work_only')],
    ['BLOCKED（policy 起因）', 'HIGH', waiting('BLOCKED', 'LOW', 'block_until_approved', 'r')],
    ['PENDING_APPROVAL', 'CRITICAL', waiting('PENDING_APPROVAL', 'HIGH', 'continue_safe_work_only', 'r')],
    ['REJECTED', 'CRITICAL', waiting('REJECTED', 'HIGH', 'continue_safe_work_only', 'r')],
  ] as const)('%s: ローカル %s > API → re_check', (_label, local, response) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: local }), response)
    expect(result.policy).toBe('re_check')
    expect(result.reason).toMatch(/^risk_rule_skew: /)
    expect(result.reason).toContain(`local ${local} > API ${response.riskReview.riskLevel}`)
    expect(findGateTechnicalStopCode(result.reason)).toBe('risk_rule_skew')
  })

  it('STALE は risk 比較より先に re_check（従来どおり、技術停止の理由コードは付かない）', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      makeCheckResponse({
        outcome: { decision: 'STALE', requestId: 'r', reason: 'diff changed' },
        riskReview: { riskLevel: 'LOW', triggeredRules: [], requiresIndependentReview: false },
        continuationPolicy: 'continue_safe_work_only',
        nextAction: { action: 're_check', message: 're-check' },
      }),
    )
    expect(result.policy).toBe('re_check')
    expect(findGateTechnicalStopCode(result.reason)).toBeUndefined()
  })
})

describe('resolvePolicy — 組の整合（全 decision × continuationPolicy × nextAction）', () => {
  const decisions = ['ALLOW', 'PENDING_APPROVAL', 'BLOCKED', 'REJECTED', 'STALE'] as const
  const policies = ['continue', 'continue_safe_work_only', 'block_until_approved'] as const
  const actions = ['proceed', 'call_consume', 'wait_for_approval', 're_check'] as const
  // build() は riskLevel HIGH を返すので、ALLOW + proceed は契約外（LOW / MEDIUM のときだけ整合。上の describe）。
  const coherent = new Set<string>([
    'ALLOW|continue|call_consume',
    ...['PENDING_APPROVAL', 'BLOCKED', 'REJECTED'].flatMap((d) => [
      `${d}|continue_safe_work_only|wait_for_approval`,
      `${d}|block_until_approved|wait_for_approval`,
    ]),
    ...policies.map((p) => `STALE|${p}|re_check`),
  ])
  const all = decisions.flatMap((d) => policies.flatMap((p) => actions.map((a) => [d, p, a] as const)))

  function build(decision: string, policy: string, action: string): GateCheckResponse {
    return makeCheckResponse({
      outcome: { decision: decision as never, riskLevel: 'HIGH', ...(action === 'call_consume' ? { consumedRequestId: 'x' } : { requestId: 'x' }) },
      riskReview: { riskLevel: 'HIGH', triggeredRules: [], requiresIndependentReview: true },
      continuationPolicy: policy as never,
      nextAction: { action: action as never, message: 'm', ...(action === 'call_consume' ? { consumedRequestId: 'x' } : {}) },
      // call_consume は consume する承認（同じ id）を返す（G-2: id の一致も整合の一部）。
      ...(action === 'call_consume' ? { approvalRequest: { id: 'x', status: 'APPROVED', expiresAt: '2099-01-01T00:00:00.000Z', riskLevel: 'HIGH' } } : {}),
    })
  }

  it.each(all.filter((t) => !coherent.has(t.join('|'))))('%s / %s / %s → re_check approval_contract_violation', (d, p, a) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), build(d, p, a))
    expect(result.policy).toBe('re_check')
    expect(findGateTechnicalStopCode(result.reason)).toBe('approval_contract_violation')
    expect(result.reason).toContain(`decision=${d} continuationPolicy=${p} nextAction=${a}`)
  })

  it.each(all.filter((t) => coherent.has(t.join('|'))))('%s / %s / %s → 契約違反にしない', (d, p, a) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), build(d, p, a))
    expect(findGateTechnicalStopCode(result.reason)).toBeUndefined()
  })

  it('契約違反はローカルのリスク比較より先（ローカル CRITICAL でも理由は approval_contract_violation）', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'CRITICAL' }), build('BLOCKED', 'continue', 'wait_for_approval'))
    expect(findGateTechnicalStopCode(result.reason)).toBe('approval_contract_violation')
  })
})

describe('resolvePolicy — call_consume の承認 id の食い違いは契約外（G-2）', () => {
  it.each([
    ['outcome.consumedRequestId が無い', { ...approvedConsume('HIGH'), outcome: { decision: 'ALLOW', riskLevel: 'HIGH' } }],
    ['outcome.consumedRequestId が違う', { ...approvedConsume('HIGH'), outcome: { decision: 'ALLOW', riskLevel: 'HIGH', consumedRequestId: 'other' } }],
    ['approvalRequest が無い', { ...approvedConsume('HIGH'), approvalRequest: undefined }],
    ['approvalRequest.id が違う', { ...approvedConsume('HIGH'), approvalRequest: { id: 'other', status: 'APPROVED', expiresAt: '2099-01-01T00:00:00.000Z', riskLevel: 'HIGH' } }],
  ] as const)('%s → re_check approval_contract_violation（failed にしない）', (_label, response) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), response as unknown as GateCheckResponse)
    expect(result.policy).toBe('re_check')
    expect(findGateTechnicalStopCode(result.reason)).toBe('approval_contract_violation')
  })

  it('一致していれば従来どおり continue', () => {
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), approvedConsume('HIGH')).policy).toBe('continue')
  })
})

describe('resolvePolicy — outcome.riskLevel と riskReview.riskLevel の食い違いは契約外', () => {
  it.each([
    ['ALLOW + call_consume', { ...approvedConsume('HIGH'), outcome: { decision: 'ALLOW', riskLevel: 'CRITICAL', consumedRequestId: 'approval-d2' } }],
    ['ALLOW + proceed', { ...allowProceed('LOW'), outcome: { decision: 'ALLOW', riskLevel: 'HIGH' } }],
    ['BLOCKED', { ...waiting('BLOCKED', 'HIGH', 'continue_safe_work_only', 'r'), outcome: { decision: 'BLOCKED', riskLevel: 'LOW', requestId: 'r' } }],
  ] as const)('%s with a differing outcome.riskLevel → re_check approval_contract_violation', (_label, response) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'LOW' }), response as GateCheckResponse)
    expect(result.policy).toBe('re_check')
    expect(findGateTechnicalStopCode(result.reason)).toBe('approval_contract_violation')
  })

  it('outcome.riskLevel が無い（STALE 等）のは食い違いにしない / 一致していれば通常どおり', () => {
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), approvedConsume('HIGH')).policy).toBe('continue')
    const noOutcomeRisk = { ...approvedConsume('HIGH'), outcome: { decision: 'ALLOW', consumedRequestId: 'approval-d2' } } as GateCheckResponse
    expect(resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), noOutcomeRisk).policy).toBe('continue')
  })
})
