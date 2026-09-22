import { describe, expect, it } from 'vitest'
import {
  MAX_REPAIR_ATTEMPTS,
  decideRepairAction,
  walkRepairGeneration,
  type PriorRepairJob,
  type RepairFailureFacts,
} from './repairPolicy'

/**
 * **`human_recovery` generation root の回帰テスト**（CEO 指示・2026-09-22）。
 *
 * `human_resume`（#270）は「再開した時点で human と証明された」という *resume の provenance*。
 * `human_recovery`（ここ）は「いまここから新しい repair generation を始めてよい」という
 * *現時点の authority*（consume 済み ApprovalRequest）。**2つは別の事実であり、混同しない。**
 *
 * #270 の walker / 予算 / 上限はそのまま使う。ここで確かめるのは、足した根が
 *   - 最も近い authority として効くこと
 *   - lineage の健全性検査を弱めないこと
 *   - **予算を繰り返し再発行しないこと**
 * の3点である。
 */

const FACTS: RepairFailureFacts = { exitCode: 1, stderr: 'boom' }

function job(
  id: string,
  workflowStepKey: string | undefined,
  extra: Partial<PriorRepairJob> = {},
): PriorRepairJob {
  return { id, workflowStepKey, status: 'failed', facts: FACTS, ...extra }
}

/** production `c3849205` と同じ形: origin → repair×3 → resume → resume(success)。 */
function exhaustedThenResumed(epochOn?: string): PriorRepairJob[] {
  return [
    job('origin', 'task:t1:initial-implement'),
    job('r1', 'repair:origin:1'),
    job('r2', 'repair:r1:1'),
    job('r3', 'repair:r2:1'),
    job('resumed', 'resume:r3:1'),
    job('impl', 'resume:resumed:1', {
      status: 'success',
      humanRecoveryEpoch: epochOn === 'impl',
    }),
  ]
}

describe('human_recovery — 現在の authority が generation の根になる', () => {
  it('epoch が無ければ古い generation を引き継ぐ（depth 3 で上限）', () => {
    const walk = walkRepairGeneration('impl', exhaustedThenResumed())
    expect(walk).toMatchObject({ ok: true, depth: 3, rootKind: 'origin' })
  })

  it('epoch があればその実装が根になり depth 0', () => {
    const walk = walkRepairGeneration('impl', exhaustedThenResumed('impl'))
    expect(walk).toMatchObject({
      ok: true,
      depth: 0,
      rootJobId: 'impl',
      rootKind: 'human_recovery',
      previousGenerationRoot: 'resumed',
    })
  })

  it('epoch は stepKey が resume: でも効く（実装 Job 自体が resume のことがある）', () => {
    const walk = walkRepairGeneration('impl', exhaustedThenResumed('impl'))
    expect(walk.ok && walk.rootKind).toBe('human_recovery')
  })

  it('budgetReset と resetReason が human_resume と区別される', () => {
    const decision = decideRepairAction('impl', exhaustedThenResumed('impl'), FACTS)
    expect(decision.action).toBe('repair')
    if (decision.action !== 'repair') return
    expect(decision.attempt).toBe(1)
    expect(decision.generation).toMatchObject({
      rootKind: 'human_recovery',
      budgetReset: true,
      resetReason: 'human_recovery_epoch_started_new_generation',
    })
  })
})

describe('human_recovery — 最も近い authority が勝つ', () => {
  // 上流に human_resume があっても、現在の実装に epoch があればそちらが根である。
  it('上流の human_resume は現在の epoch を上書きしない', () => {
    const jobs = [
      job('origin', 'task:t1:initial-implement'),
      job('r1', 'repair:origin:1'),
      job('humanResumed', 'resume:r1:1', { resumeActorClass: 'human' }),
      job('r2', 'repair:humanResumed:1'),
      job('impl', 'resume:r2:1', { status: 'success', humanRecoveryEpoch: true }),
    ]
    const walk = walkRepairGeneration('impl', jobs)
    expect(walk).toMatchObject({ ok: true, depth: 0, rootJobId: 'impl', rootKind: 'human_recovery' })
  })

  // 逆向き: epoch より下流（＝より近い）に human_resume があるならそちらが根。
  it('epoch より近い human_resume があればそちらが根', () => {
    const jobs = [
      job('origin', 'task:t1:initial-implement'),
      job('impl', 'resume:origin:1', { humanRecoveryEpoch: true }),
      job('r1', 'repair:impl:1'),
      job('humanResumed', 'resume:r1:1', { resumeActorClass: 'human', status: 'success' }),
    ]
    const walk = walkRepairGeneration('humanResumed', jobs)
    expect(walk).toMatchObject({ ok: true, depth: 0, rootKind: 'human_resume' })
  })
})

describe('human_recovery — lineage の健全性検査は弱めない', () => {
  // 根が決まっても walk は上流まで続く。環が上流にあれば ok:false。
  it('epoch があっても上流が環なら fail-closed', () => {
    const jobs = [
      job('a', 'repair:b:1'),
      job('b', 'repair:a:1'),
      job('impl', 'resume:a:1', { status: 'success', humanRecoveryEpoch: true }),
    ]
    const walk = walkRepairGeneration('impl', jobs)
    expect(walk.ok).toBe(false)
    if (!walk.ok) expect(walk.reason).toContain('cycle')
  })

  it('epoch があっても上流の source が居なければ fail-closed', () => {
    const jobs = [job('impl', 'resume:missing:1', { status: 'success', humanRecoveryEpoch: true })]
    const walk = walkRepairGeneration('impl', jobs)
    expect(walk.ok).toBe(false)
    if (!walk.ok) expect(walk.reason).toContain('not a job of this task')
  })
})

describe('human_recovery — 同じ epoch は予算を繰り返し再発行しない', () => {
  /** epoch 済み実装から repair を `depth` 段積んだ chain。 */
  function afterRepairs(depth: number): { jobs: PriorRepairJob[], leaf: string } {
    const jobs = exhaustedThenResumed('impl')
    let parent = 'impl'
    for (let i = 1; i <= depth; i += 1) {
      jobs.push(job(`h${i}`, `repair:${parent}:1`))
      parent = `h${i}`
    }
    return { jobs, leaf: parent }
  }

  it.each([0, 1, 2])('epoch 後 %i 段目までは次の repair を許す', (depth) => {
    const { jobs, leaf } = afterRepairs(depth)
    const decision = decideRepairAction(leaf, jobs, { exitCode: depth + 10, stderr: `d${depth}` })
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(depth + 1)
  })

  // **ここが要点。** 同じ epoch のまま 3 段使い切れば、再び上限で止まる。
  it(`epoch 後 ${MAX_REPAIR_ATTEMPTS} 段で再び escalate する`, () => {
    const { jobs, leaf } = afterRepairs(MAX_REPAIR_ATTEMPTS)
    const decision = decideRepairAction(leaf, jobs, { exitCode: 99, stderr: 'exhausted again' })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.code).toBe('attempt_limit')
  })

  it('epoch は1つの generation しか作らない（根は常に同じ Job）', () => {
    for (const depth of [0, 1, 2]) {
      const { jobs, leaf } = afterRepairs(depth)
      const walk = walkRepairGeneration(leaf, jobs)
      expect(walk).toMatchObject({ ok: true, rootJobId: 'impl', rootKind: 'human_recovery', depth })
    }
  })
})
