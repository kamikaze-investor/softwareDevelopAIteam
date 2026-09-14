import { describe, it, expect } from 'vitest'
import {
  PL_ACTION_KINDS,
  PL_BLOCKED_RESPONSES,
  resolvePlActionPolicy,
  type PlActionKind,
} from './plActionPolicy'

/**
 * ここで固定しているのは「PL が自分の権限と Gate の要否を決められない」ことである。
 * 個々の Gate 割り当ての妥当性より、**PL 由来の入力で Gate が減らないこと**を優先して検査する。
 */

describe('resolvePlActionPolicy — PL は Gate を減らせない', () => {
  it('plRiskOpinion は requiredGates を一切変えない（全 action kind で）', () => {
    for (const kind of PL_ACTION_KINDS) {
      const baseline = resolvePlActionPolicy({ kind })
      const claimedLow = resolvePlActionPolicy({
        kind,
        plRiskOpinion: { level: 'LOW', rationale: 'PL が安全だと考えた' },
      })
      const claimedCritical = resolvePlActionPolicy({
        kind,
        plRiskOpinion: { level: 'CRITICAL', rationale: 'PL が危険だと考えた' },
      })

      expect(claimedLow.requiredGates, `kind=${kind}`).toEqual(baseline.requiredGates)
      expect(claimedCritical.requiredGates, `kind=${kind}`).toEqual(baseline.requiredGates)
      expect(claimedLow.disposition, `kind=${kind}`).toBe(baseline.disposition)
    }
  })

  it('plRiskOpinion は判定に使われないが、記録としては残る', () => {
    const decision = resolvePlActionPolicy({
      kind: 'propose_code_change',
      changedFiles: ['apps/api/src/routes/tasks.test.ts'],
      plRiskOpinion: { level: 'LOW', rationale: 'テストだけの変更なので低リスク' },
    })

    expect(decision.recordedPlRiskOpinion).toEqual({
      level: 'LOW',
      rationale: 'テストだけの変更なので低リスク',
    })
    // 記録されていても Gate は減っていない
    expect(decision.requiredGates).toEqual(['design_review', 'approval_gate'])
  })

  it('plProposedGates は追加にしか働かない（システム判定分は必ず残る）', () => {
    const systemOnly = resolvePlActionPolicy({ kind: 'rollback_commit' })
    const withPlProposal = resolvePlActionPolicy({
      kind: 'rollback_commit',
      // PL が「approval_gate だけで足りる」と申告しても、他が消えてはならない
      plProposedGates: ['approval_gate'],
    })

    for (const gate of systemOnly.requiredGates) {
      expect(withPlProposal.requiredGates).toContain(gate)
    }
    expect(withPlProposal.plProposedGatesAdded).toEqual([])
  })

  it('plProposedGates で Gate を増やすことはできる', () => {
    const decision = resolvePlActionPolicy({
      kind: 'retry_job',
      plProposedGates: ['independent_review'],
    })

    expect(decision.requiredGates).toContain('independent_review')
    expect(decision.plProposedGatesAdded).toEqual(['independent_review'])
  })

  it('解決できない Gate 名は無視するだけで、Gate を減らさない', () => {
    const baseline = resolvePlActionPolicy({ kind: 'resume_task' })
    const decision = resolvePlActionPolicy({
      kind: 'resume_task',
      plProposedGates: ['pl_self_review', 'lightweight_check'],
    })

    expect(decision.requiredGates).toEqual(baseline.requiredGates)
    expect(decision.plProposedGatesUnrecognized).toEqual(['pl_self_review', 'lightweight_check'])
  })
})

describe('resolvePlActionPolicy — PL が決められない操作', () => {
  const alwaysForbidden: PlActionKind[] = [
    'change_safety_boundary',
    'change_own_permission',
    'override_gate_block',
    'skip_required_review',
  ]

  it.each(alwaysForbidden)('%s は常に forbidden で、override 経路を持たない', (kind) => {
    const decision = resolvePlActionPolicy({ kind })

    expect(decision.disposition).toBe('forbidden')
    expect(decision.requiredGates).toEqual([])
    expect(decision.allowedResponsesWhenBlocked).toEqual(PL_BLOCKED_RESPONSES)
    expect(decision.allowedResponsesWhenBlocked).not.toContain('override')
  })

  it('PL の自己申告を足しても forbidden は解けない', () => {
    const decision = resolvePlActionPolicy({
      kind: 'override_gate_block',
      plRiskOpinion: { level: 'LOW', rationale: '誤検知だと判断した' },
      plProposedGates: ['approval_gate'],
    })

    expect(decision.disposition).toBe('forbidden')
    expect(decision.requiredGates).toEqual([])
  })

  it('未知の操作は素通しではなく forbidden へ倒す', () => {
    const decision = resolvePlActionPolicy({ kind: 'delete_production_database' })

    expect(decision.disposition).toBe('forbidden')
    expect(decision.reasons[0]).toContain('unknown action kind')
  })
})

describe('resolvePlActionPolicy — Independent Review の独立性は PL より上位', () => {
  it('生成者と最終レビュアーが同一 vendor になる provider 切替は forbidden', () => {
    const decision = resolvePlActionPolicy({
      kind: 'switch_provider',
      providerChange: { generator: 'claude_code', finalReviewer: 'claude' },
    })

    expect(decision.disposition).toBe('forbidden')
    expect(decision.reasons[0]).toContain('review independence')
  })

  it('vendor を特定できない provider への切替も forbidden（fail-closed）', () => {
    const decision = resolvePlActionPolicy({
      kind: 'switch_provider',
      providerChange: { generator: 'codex', finalReviewer: 'copilot' },
    })

    expect(decision.disposition).toBe('forbidden')
  })

  it('切替後の構成が示されていなければ検査できないので forbidden', () => {
    const decision = resolvePlActionPolicy({ kind: 'switch_provider' })

    expect(decision.disposition).toBe('forbidden')
  })

  it('vendor が分離されていれば CEO 承認付きで通せる', () => {
    const decision = resolvePlActionPolicy({
      kind: 'switch_provider',
      providerChange: { generator: 'codex', finalReviewer: 'gemini' },
    })

    expect(decision.disposition).toBe('gates_required')
    expect(decision.requiredGates).toContain('ceo_approval')
  })
})

describe('resolvePlActionPolicy — 変更ファイルは既存判定器へそのまま通す', () => {
  it('HIGH risk のファイルを含むと independent_review が追加される', () => {
    const decision = resolvePlActionPolicy({
      kind: 'propose_code_change',
      changedFiles: ['apps/api/src/storage/migrations/003_add_column.ts'],
    })

    expect(decision.requiredGates).toContain('independent_review')
  })

  it('CRITICAL risk のファイルは CEO 承認まで上がる', () => {
    const decision = resolvePlActionPolicy({
      kind: 'propose_code_change',
      changedFiles: ['AGENTS.md'],
    })

    expect(decision.requiredGates).toContain('independent_review')
    expect(decision.requiredGates).toContain('ceo_approval')
  })

  it('Mechanical Gate に当たる安全中核ファイルは safety_review まで上がる', () => {
    const decision = resolvePlActionPolicy({
      kind: 'propose_code_change',
      changedFiles: ['apps/worker/src/guards/gatePolicy.ts'],
    })

    expect(decision.requiredGates).toContain('safety_review')
    expect(decision.requiredGates).toContain('independent_review')
    expect(decision.requiredGates).toContain('ceo_approval')
  })

  it('低リスクな変更でも design_review と approval_gate は外れない', () => {
    const decision = resolvePlActionPolicy({
      kind: 'propose_code_change',
      changedFiles: ['docs/notes.md'],
    })

    expect(decision.requiredGates).toEqual(['design_review', 'approval_gate'])
  })

  // 独立レビュー指摘（2026-09-14）: 申告を空にすれば file 由来の Gate が全て外れてしまう。
  it.each(['propose_code_change', 'delegate_implementation'] as const)(
    '%s は変更集合の申告が無ければ forbidden（空申告で Gate を外せない）',
    (kind) => {
      expect(resolvePlActionPolicy({ kind }).disposition).toBe('forbidden')
      expect(resolvePlActionPolicy({ kind, changedFiles: [] }).disposition).toBe('forbidden')
    },
  )

  it('変更集合の申告を絞っても、申告分に対する Gate は必ず付く', () => {
    // 申告を docs だけに絞っても design_review / approval_gate は残る。
    // 実差分に対する権威ある判定は File Change Guard と Job の gate/check が行う。
    const narrowed = resolvePlActionPolicy({
      kind: 'propose_code_change',
      changedFiles: ['docs/notes.md'],
    })

    expect(narrowed.disposition).toBe('gates_required')
    expect(narrowed.requiredGates).toContain('design_review')
    expect(narrowed.requiredGates).toContain('approval_gate')
  })
})

describe('resolvePlActionPolicy — 観測と表の網羅性', () => {
  it('read-only な観測は Gate を要さない', () => {
    for (const kind of ['observe_state', 'read_logs', 'read_roadmap'] as const) {
      const decision = resolvePlActionPolicy({ kind })
      expect(decision.disposition, `kind=${kind}`).toBe('no_gate_required')
      expect(decision.requiredGates, `kind=${kind}`).toEqual([])
    }
  })

  it('PL_ACTION_KINDS の全てが判定表に存在する（表の穴を素通しにしない）', () => {
    for (const kind of PL_ACTION_KINDS) {
      const decision = resolvePlActionPolicy({ kind })
      expect(decision.reasons.length, `kind=${kind}`).toBeGreaterThan(0)
      expect(decision.reasons[0], `kind=${kind}`).not.toContain('unknown action kind')
    }
  })

  it('requiredGates の並び順は入力順で揺れない', () => {
    const a = resolvePlActionPolicy({
      kind: 'rollback_commit',
      plProposedGates: ['design_review', 'independent_review'],
    })
    const b = resolvePlActionPolicy({
      kind: 'rollback_commit',
      plProposedGates: ['independent_review', 'design_review'],
    })

    expect(a.requiredGates).toEqual(b.requiredGates)
  })
})

describe('resolvePlActionPolicy — 実在する復旧操作が語彙から漏れていない', () => {
  /**
   * fail-closed は正しいが、**語彙に無い操作は「実行できない操作」と同義**である。
   * ここで固定しているのは、実際の復旧経路が表に載っていることであって、
   * fail-closed の緩和ではない（未知の値は依然として forbidden）。
   */
  it('CEO Escalation は Gate を要さず、決して forbidden にならない', () => {
    const decision = resolvePlActionPolicy({ kind: 'escalate_to_ceo' })

    expect(decision.disposition).toBe('no_gate_required')
    expect(decision.requiredGates).toEqual([])
    // BLOCK 時に PL へ返す選択肢に含まれている以上、それ自体が塞がれていてはならない
    expect(PL_BLOCKED_RESPONSES).toContain('escalate_to_ceo')
  })

  it('PL の自己申告では CEO Escalation にも Gate を足せない…わけではない（union は許す）が、外せない', () => {
    const decision = resolvePlActionPolicy({
      kind: 'escalate_to_ceo',
      plRiskOpinion: { level: 'CRITICAL', rationale: 'PL が重大だと考えた' },
    })

    // 自己申告は判定に効かない。escalation は常に通る
    expect(decision.disposition).toBe('no_gate_required')
  })

  it('Design Review の再kick は forbidden ではなく、既存の bounded retry 経路へ載る', () => {
    // vps-pl-execution-loop の production evidence（requeue された run を誰も再開しなかった）で
    // 実際に必要だった操作。ここが forbidden だと PL 基盤の動機そのものが満たせない。
    const decision = resolvePlActionPolicy({ kind: 'rekick_design_review' })

    expect(decision.disposition).toBe('gates_required')
    expect(decision.requiredGates).toEqual(['approval_gate'])
  })

  it('停止 Job の強制終端は abort と同じ扱いで、無Gateでは通らない', () => {
    const decision = resolvePlActionPolicy({ kind: 'fail_stuck_job' })

    expect(decision.disposition).toBe('gates_required')
    expect(decision.requiredGates).toEqual(['approval_gate'])
  })

  it('語彙に追加しても「未知は forbidden」は保たれている', () => {
    for (const kind of ['rekick_design_reviews', 'fail_stuck_jobs', 'escalate', 'restart']) {
      expect(resolvePlActionPolicy({ kind }).disposition, `kind=${kind}`).toBe('forbidden')
    }
  })
})
