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

/**
 * **本物の lineage を組む。** budget は「Task 内の repair 数」ではなく
 * 「この chain の repair 段数」で数えるので、親を持たない repair Job を並べても
 * 試行回数にはならない。`leafId` が「いま直そうとしている Job」である。
 *
 * 以前の fixture は `repair:1` のような親の無い key を並べ、`decideRepairAction` へ
 * priors に含まれない `"job-1"` を source として渡していた。production では
 * `toPriorRepairJobs()` が Task の全 Job を渡すので source は必ず含まれる ——
 * 含まれない形は lineage を辿れないため、いまは fail-closed になる。
 */
function chain(
  repairs: readonly { status: string, facts?: RepairFailureFacts }[],
  rootKey = 'task:t1:initial-implement',
): { jobs: PriorRepairJob[], leafId: string } {
  const jobs: PriorRepairJob[] = [
    { id: 'root', workflowStepKey: rootKey, status: 'failed', facts: {} },
  ]
  let parentId = 'root'
  repairs.forEach((repair, index) => {
    const id = `r${index + 1}`
    jobs.push({
      id,
      workflowStepKey: `repair:${parentId}:1`,
      status: repair.status,
      facts: repair.facts ?? FACTS_A,
    })
    parentId = id
  })
  return { jobs, leafId: parentId }
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
    const { jobs, leafId } = chain([])
    const decision = decideRepairAction(leafId, jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(1)
      expect(decision.stepKey).toBe(`repair:${leafId}:1`)
      expect(decision.requireDifferentApproach).toBe(false)
    }
  })

  it('異なる失敗が続く間はrepairを継続する', () => {
    const { jobs, leafId } = chain([{ status: 'failed', facts: FACTS_A }])
    const decision = decideRepairAction(leafId, jobs, FACTS_B)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.requireDifferentApproach).toBe(false)
    }
  })

  it('同じ失敗が残っていても即escalateせず、別アプローチを要求して継続する', () => {
    const { jobs, leafId } = chain([{ status: 'failed', facts: FACTS_A }])
    const decision = decideRepairAction(leafId, jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.requireDifferentApproach).toBe(true)
    }
  })

  it('同じ失敗が2回続いてもhard bound内なら継続する', () => {
    const { jobs, leafId } = chain([
      { status: 'failed', facts: FACTS_A },
      { status: 'failed', facts: FACTS_A },
    ])
    const decision = decideRepairAction(leafId, jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(3)
      expect(decision.requireDifferentApproach).toBe(true)
    }
  })

  it('hard boundを使い切ったらescalateする（無限repairを作らない）', () => {
    const { jobs, leafId } = chain(
      Array.from({ length: MAX_REPAIR_ATTEMPTS }, (_, i) => ({
        status: 'failed',
        facts: { exitCode: i + 1, stderr: `distinct failure ${i + 1}` },
      })),
    )
    const decision = decideRepairAction(leafId, jobs, { exitCode: 99, stderr: 'yet another distinct failure' })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('同じ失敗かつ手がかりが無い場合のみescalateする', () => {
    const { jobs, leafId } = chain([{ status: 'failed', facts: {} }])
    const decision = decideRepairAction(leafId, jobs, {})
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') {
      expect(decision.reason).toContain('no actionable information')
    }
  })

  it('repair以外の既存Jobは試行回数に数えない', () => {
    const jobs: PriorRepairJob[] = [
      { id: 'leaf', workflowStepKey: 'implement:1', status: 'failed', facts: FACTS_B },
      { id: 'other', workflowStepKey: undefined, status: 'success', facts: {} },
    ]
    const decision = decideRepairAction('leaf', jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })

  it('Stage 1のretry Jobはrepair試行に数えない', () => {
    const jobs: PriorRepairJob[] = [
      { id: 'leaf', workflowStepKey: 'retry:abc', status: 'failed', facts: FACTS_B },
    ]
    const decision = decideRepairAction('leaf', jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })

  it('成功したrepairと同じ署名でも、失敗していなければ別アプローチ要求にしない', () => {
    const { jobs, leafId } = chain([{ status: 'success', facts: FACTS_A }])
    const decision = decideRepairAction(leafId, jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.requireDifferentApproach).toBe(false)
  })
})
