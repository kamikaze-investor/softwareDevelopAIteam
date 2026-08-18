import { describe, expect, it } from 'vitest'
import {
  MAX_REPAIR_ATTEMPTS,
  computeFailureSignature,
  decideRepairAction,
  type PriorRepairJob,
  type RepairFailureFacts,
} from './repairPolicy'

const FACTS_A: RepairFailureFacts = {
  exitCode: 1,
  stderr: 'TypeError: x is not a function\n  at foo.ts:12:3',
  failureKind: 'ai_cli_failed',
}
const FACTS_B: RepairFailureFacts = {
  exitCode: 2,
  stderr: 'ReferenceError: y is not defined',
  failureKind: 'ai_cli_failed',
}

function repairJob(status: string, facts: RepairFailureFacts = FACTS_A, attempt = 1): PriorRepairJob {
  return { workflowStepKey: `repair:${attempt}`, status, facts }
}

describe('computeFailureSignature — ノイズは正規化する', () => {
  it('同じ失敗は同じ署名になる', () => {
    expect(computeFailureSignature(FACTS_A)).toBe(computeFailureSignature({ ...FACTS_A }))
  })

  it('絶対パスの違いは同一失敗とみなす', () => {
    expect(computeFailureSignature({ exitCode: 1, stderr: 'Error at /home/a/src/foo.ts' }))
      .toBe(computeFailureSignature({ exitCode: 1, stderr: 'Error at /home/b/src/foo.ts' }))
  })

  it('line / column の違いは同一失敗とみなす', () => {
    expect(computeFailureSignature({ stderr: 'at foo.ts:12:3' }))
      .toBe(computeFailureSignature({ stderr: 'at foo.ts:99:7' }))
  })

  it('タイムスタンプ・実行時間・メモリアドレスの違いは同一失敗とみなす', () => {
    expect(computeFailureSignature({ stderr: 'failed at 2026-08-18T10:00:00Z after 120ms (0xdeadbeef)' }))
      .toBe(computeFailureSignature({ stderr: 'failed at 2026-08-19T23:59:59Z after 4500ms (0xcafef00d)' }))
  })
})

describe('computeFailureSignature — 意味のある数値は潰さない', () => {
  it('HTTP status 401 と 500 は別失敗', () => {
    expect(computeFailureSignature({ stderr: 'request failed with HTTP 401' }))
      .not.toBe(computeFailureSignature({ stderr: 'request failed with HTTP 500' }))
  })

  it('exit code が違えば別失敗', () => {
    expect(computeFailureSignature({ exitCode: 1, stderr: 'same message' }))
      .not.toBe(computeFailureSignature({ exitCode: 2, stderr: 'same message' }))
  })

  it('expected / actual の値が違えば別失敗', () => {
    expect(computeFailureSignature({ stderr: 'expected 3 to be 5' }))
      .not.toBe(computeFailureSignature({ stderr: 'expected 3 to be 9' }))
  })

  it('失敗件数が違えば別失敗', () => {
    expect(computeFailureSignature({ stderr: '2 tests failed' }))
      .not.toBe(computeFailureSignature({ stderr: '7 tests failed' }))
  })

  it('異なるエラー種別は別失敗', () => {
    expect(computeFailureSignature(FACTS_A)).not.toBe(computeFailureSignature(FACTS_B))
  })

  it('review finding の rule が違えば別失敗', () => {
    expect(computeFailureSignature({ reviewFindingRules: ['no_business_logic_in_ui'] }))
      .not.toBe(computeFailureSignature({ reviewFindingRules: ['missing_test'] }))
  })

  it('rule の順序は署名に影響しない', () => {
    expect(computeFailureSignature({ reviewFindingRules: ['a', 'b'] }))
      .toBe(computeFailureSignature({ reviewFindingRules: ['b', 'a'] }))
  })
})

describe('decideRepairAction', () => {
  it('初回の失敗ではrepairを行う', () => {
    const decision = decideRepairAction("job-1", [], FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(1)
      expect(decision.stepKey).toBe('repair:job-1:1')
      expect(decision.requireDifferentApproach).toBe(false)
    }
  })

  it('異なる失敗が続く間はrepairを継続する', () => {
    const decision = decideRepairAction("job-1", [repairJob('failed', FACTS_A, 1)], FACTS_B)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.requireDifferentApproach).toBe(false)
    }
  })

  it('同じ失敗が残っていても即escalateせず、別アプローチを要求して継続する', () => {
    const decision = decideRepairAction("job-1", [repairJob('failed', FACTS_A, 1)], FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.requireDifferentApproach).toBe(true)
    }
  })

  it('同じ失敗が2回続いてもhard bound内なら継続する', () => {
    const priors = [repairJob('failed', FACTS_A, 1), repairJob('failed', FACTS_A, 2)]
    const decision = decideRepairAction("job-1", priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(3)
      expect(decision.requireDifferentApproach).toBe(true)
    }
  })

  it('hard boundを使い切ったらescalateする（無限repairを作らない）', () => {
    const priors: PriorRepairJob[] = []
    for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i += 1) {
      priors.push(repairJob('failed', { exitCode: i, stderr: `distinct failure ${i}` }, i))
    }

    const decision = decideRepairAction("job-1", priors, { exitCode: 99, stderr: 'yet another distinct failure' })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('同じ失敗かつ手がかりが無い場合のみescalateする', () => {
    const decision = decideRepairAction("job-1", [repairJob('failed', {}, 1)], {})
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') {
      expect(decision.reason).toContain('no actionable information')
    }
  })

  it('repair以外の既存Jobは試行回数に数えない', () => {
    const priors: PriorRepairJob[] = [
      { workflowStepKey: 'implement:1', status: 'failed', facts: FACTS_B },
      { workflowStepKey: undefined, status: 'success', facts: {} },
    ]
    const decision = decideRepairAction("job-1", priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })

  it('Stage 1のretry Jobはrepair試行に数えない', () => {
    const priors: PriorRepairJob[] = [{ workflowStepKey: 'retry:abc', status: 'failed', facts: FACTS_B }]
    const decision = decideRepairAction("job-1", priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })

  it('成功したrepairと同じ署名でも、失敗していなければ別アプローチ要求にしない', () => {
    const decision = decideRepairAction("job-1", [repairJob('success', FACTS_A, 1)], FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.requireDifferentApproach).toBe(false)
  })
})
