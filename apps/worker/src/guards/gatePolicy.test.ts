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

  // lifecycle repair D2: ローカル > API はルールの版ずれとして fail-closed。止める範囲は従来と同じで、
  // CRITICAL は承認待ち（block_until_approved）ではなく技術停止（re_check + technicalCause）として返す。
  it('localRisk HIGH + api LOW continue → continue_safe_work_only (risk_rule_skew)', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH', gateDecision: 'DEEP_REVIEW', reason: 'dangerous file' }),
      makeCheckResponse({ continuationPolicy: 'continue' }),
    )
    expect(result.policy).toBe('continue_safe_work_only')
    expect(result.technicalCause).toBe('risk_rule_skew')
    expect(result.reason).toContain('risk_rule_skew')
  })

  it('localRisk CRITICAL + api LOW continue → re_check (risk_rule_skew), not an approval wait', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED', reason: 'payment file' }),
      makeCheckResponse({ continuationPolicy: 'continue' }),
    )
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('risk_rule_skew')
  })

  it('localRisk CRITICAL + api continue_safe_work_only → re_check (risk_rule_skew)', () => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL', gateDecision: 'BLOCK_CEO_REQUIRED' }),
      makeCheckResponse({ continuationPolicy: 'continue_safe_work_only' }),
    )
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('risk_rule_skew')
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
// lifecycle repair D2: 承認済み（ALLOW + call_consume）の HIGH / CRITICAL は consume まで進む。
// Worker に残すのは API と食い違ったときの fail-closed（版ずれ・承認契約違反・不正な riskLevel）だけ。
// ────────────────────────────────────────────────────────────

describe('resolvePolicy — 承認済み HIGH / CRITICAL と Worker 側の fail-closed（D2）', () => {
  // id に null を渡すと consumedRequestId 無し（undefined は既定値に置き換わるため使わない）
  const consumeResponse = (risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', rawId: string | null = 'approval-1') => {
    const id = rawId ?? undefined
    return makeCheckResponse({
      outcome: { decision: 'ALLOW', riskLevel: risk, consumedRequestId: id },
      riskReview: { riskLevel: risk, triggeredRules: [], requiresIndependentReview: risk === 'HIGH' || risk === 'CRITICAL' },
      continuationPolicy: 'continue',
      nextAction: { action: 'call_consume', consumedRequestId: id, message: 'consume' },
    } as Partial<GateCheckResponse>)
  }

  it.each(['HIGH', 'CRITICAL'] as const)('approved %s (local == api) → continue, so jobRunner consumes', (risk) => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: risk }), consumeResponse(risk))
    expect(result.policy).toBe('continue')
    expect(result.technicalCause).toBeUndefined()
  })

  it('approved HIGH but local CRITICAL (rules newer on the Worker) → re_check, approval left unused', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'CRITICAL' }), consumeResponse('HIGH'))
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('risk_rule_skew')
  })

  it('approved MEDIUM-level request but local HIGH → continue_safe_work_only (risk_rule_skew)', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), consumeResponse('MEDIUM'))
    expect(result.policy).toBe('continue_safe_work_only')
    expect(result.technicalCause).toBe('risk_rule_skew')
  })

  it.each(['HIGH', 'CRITICAL'] as const)('api %s ALLOW + proceed (no approval consumed) → re_check (approval_contract_violation)', (risk) => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: risk }),
      makeCheckResponse({
        outcome: { decision: 'ALLOW', riskLevel: risk },
        riskReview: { riskLevel: risk, triggeredRules: [], requiresIndependentReview: true },
        continuationPolicy: 'continue',
        nextAction: { action: 'proceed', message: 'proceed' },
      }),
    )
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('approval_contract_violation')
  })

  it('api HIGH call_consume without a consumedRequestId → re_check (approval_contract_violation)', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), consumeResponse('HIGH', null))
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('approval_contract_violation')
  })

  it('api HIGH call_consume with an empty consumedRequestId → re_check (approval_contract_violation)', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'HIGH' }), consumeResponse('HIGH', ''))
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('approval_contract_violation')
  })

  it.each(['SEVERE', 'toString', ''])('unknown api riskLevel %j → re_check (invalid_risk_level)', (risk) => {
    const result = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'LOW' }),
      makeCheckResponse({
        riskReview: { riskLevel: risk as never, triggeredRules: [], requiresIndependentReview: false },
      }),
    )
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('invalid_risk_level')
  })

  it('unknown local riskLevel is treated as CRITICAL (fail-closed) → re_check (risk_rule_skew)', () => {
    const result = resolvePolicy(makeGateResult({ finalRiskLevel: 'toString' as never }), consumeResponse('HIGH'))
    expect(result.policy).toBe('re_check')
    expect(result.technicalCause).toBe('risk_rule_skew')
  })

  it('PENDING_APPROVAL / BLOCKED / STALE / REJECTED keep their existing policies (no technicalCause)', () => {
    const pending = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH' }),
      makeCheckResponse({
        outcome: { decision: 'PENDING_APPROVAL', riskLevel: 'HIGH', requestId: 'r1' },
        riskReview: { riskLevel: 'HIGH', triggeredRules: [], requiresIndependentReview: true },
        continuationPolicy: 'continue_safe_work_only',
        nextAction: { action: 'wait_for_approval', requestId: 'r1', message: 'wait' },
      } as Partial<GateCheckResponse>),
    )
    expect(pending.policy).toBe('continue_safe_work_only')
    expect(pending.technicalCause).toBeUndefined()

    const stale = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'HIGH' }),
      makeCheckResponse({
        outcome: { decision: 'STALE', requestId: 'r2', reason: 'changed' },
        nextAction: { action: 're_check', message: 're-check' },
      } as Partial<GateCheckResponse>),
    )
    expect(stale.policy).toBe('re_check')
    expect(stale.technicalCause).toBeUndefined()

    const rejectedCritical = resolvePolicy(
      makeGateResult({ finalRiskLevel: 'CRITICAL' }),
      makeCheckResponse({
        outcome: { decision: 'REJECTED', requestId: 'r3', riskLevel: 'CRITICAL', reason: 'no' },
        riskReview: { riskLevel: 'CRITICAL', triggeredRules: [], requiresIndependentReview: true },
        continuationPolicy: 'block_until_approved',
        nextAction: { action: 'wait_for_approval', requestId: 'r3', message: 'rejected' },
      } as Partial<GateCheckResponse>),
    )
    expect(rejectedCritical.policy).toBe('block_until_approved')
    expect(rejectedCritical.technicalCause).toBeUndefined()
  })
})
