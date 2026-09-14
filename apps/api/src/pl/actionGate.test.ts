import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import { authorizePlAction, assertPlActionExecutable, PlActionBlockedError } from './actionGate'

describe('authorizePlAction — 判定を必ず監査記録へ残す', () => {
  it('許可された操作も記録する（境界が効いているかを後から検証できるように）', () => {
    const storage = createSQLiteStorage(':memory:')

    const { decision, actionId } = authorizePlAction(storage, { kind: 'retry_job' })

    expect(decision.disposition).toBe('gates_required')
    const entries = storage.auditLog.findByEntity('pl_action', actionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].operation).toBe('pl_action_policy')
    expect(entries[0].result).toBe('gates_required')
    expect(entries[0].detail).toContain('kind=retry_job')
    expect(entries[0].detail).toContain('policy=pl-action-policy-v1')
  })

  it('禁止された操作も記録する', () => {
    const storage = createSQLiteStorage(':memory:')

    const { decision, actionId } = authorizePlAction(storage, { kind: 'override_gate_block' })

    expect(decision.disposition).toBe('forbidden')
    expect(storage.auditLog.findByEntity('pl_action', actionId)[0].result).toBe('forbidden')
  })

  it('detail に diff や prompt のような大きな payload を載せない', () => {
    const storage = createSQLiteStorage(':memory:')

    const { actionId } = authorizePlAction(storage, {
      kind: 'propose_code_change',
      changedFiles: ['apps/api/src/storage/migrations/004_x.ts'],
      plRiskOpinion: { level: 'LOW', rationale: 'x'.repeat(5000) },
    })

    const detail = storage.auditLog.findByEntity('pl_action', actionId)[0].detail ?? ''
    expect(detail.length).toBeLessThan(200)
    expect(detail).not.toContain('xxxxx')
  })
})

describe('assertPlActionExecutable — 必要 Gate が揃うまで通さない', () => {
  it('Gate が欠けていれば投げ、欠けている Gate を名指しする', () => {
    const storage = createSQLiteStorage(':memory:')
    const { decision } = authorizePlAction(storage, { kind: 'rollback_commit' })

    let thrown: unknown
    try {
      assertPlActionExecutable(decision, ['approval_gate'])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(PlActionBlockedError)
    const blocked = thrown as PlActionBlockedError
    expect(blocked.missingGates).toContain('ceo_approval')
    expect(blocked.missingGates).toContain('safety_review')
  })

  it('全ての必要 Gate が揃っていれば通す', () => {
    const storage = createSQLiteStorage(':memory:')
    const { decision } = authorizePlAction(storage, { kind: 'rollback_commit' })

    expect(() =>
      assertPlActionExecutable(decision, ['safety_review', 'approval_gate', 'ceo_approval']),
    ).not.toThrow()
  })

  it('forbidden な操作は、どれだけ Gate を揃えても通らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { decision } = authorizePlAction(storage, { kind: 'change_own_permission' })

    expect(() =>
      assertPlActionExecutable(decision, [
        'strategic_alignment_review',
        'design_review',
        'safety_review',
        'independent_review',
        'approval_gate',
        'ceo_approval',
      ]),
    ).toThrow(PlActionBlockedError)
  })

  it('Gate を要さない観測操作はそのまま通る', () => {
    const storage = createSQLiteStorage(':memory:')
    const { decision } = authorizePlAction(storage, { kind: 'observe_state' })

    expect(decision.disposition).toBe('no_gate_required')
    expect(() => assertPlActionExecutable(decision, [])).not.toThrow()
  })

  it('PL が LOW と申告しても、必要 Gate は減らないまま充足を要求される', () => {
    const storage = createSQLiteStorage(':memory:')
    const { decision } = authorizePlAction(storage, {
      kind: 'clear_workspace_quarantine',
      plRiskOpinion: { level: 'LOW', rationale: 'ゴミファイルだけだと判断した' },
      plProposedGates: [],
    })

    expect(decision.requiredGates).toEqual(['safety_review', 'approval_gate'])
    expect(() => assertPlActionExecutable(decision, ['approval_gate'])).toThrow(PlActionBlockedError)
  })
})
