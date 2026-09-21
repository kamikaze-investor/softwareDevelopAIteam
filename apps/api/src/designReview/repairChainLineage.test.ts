import { describe, expect, it } from 'vitest'
import {
  MAX_REPAIR_ATTEMPTS,
  computeRepairLineage,
  decideRepairAction,
  type PriorRepairJob,
  type RepairFailureFacts,
} from './repairPolicy'

/**
 * **repair budget は chain 単位**であることの回帰テスト（CEO 指示・2026-09-22）。
 *
 * 守るのは2方向である。
 *
 * 1. 別 chain の古い repair を数えない —— production `c3849205` はこれで永久停止した
 * 2. **同じ chain の段数はきちんと数える** —— こちらが安全境界そのもので、
 *    `resume:` を跨いでも budget が戻らないことを含む
 */

const FACTS: RepairFailureFacts = { exitCode: 1, stderr: 'boom', failureKind: 'ai_cli_failed' }

function job(id: string, workflowStepKey: string | undefined, status = 'failed'): PriorRepairJob {
  return { id, workflowStepKey, status, facts: FACTS }
}

/** root → repair×n の素直な chain。 */
function repairChain(depth: number): PriorRepairJob[] {
  const jobs = [job('root', 'task:t1:initial-implement')]
  let parent = 'root'
  for (let i = 1; i <= depth; i += 1) {
    jobs.push(job(`r${i}`, `repair:${parent}:1`))
    parent = `r${i}`
  }
  return jobs
}

const NO_EPOCH = new Set<string>()

describe('computeRepairLineage — 段数の数え方', () => {
  it('chain の根は depth 0', () => {
    const lineage = computeRepairLineage('root', repairChain(0), NO_EPOCH)
    expect(lineage).toMatchObject({ ok: true, depth: 0 })
  })

  it('repair 1 段は depth 1', () => {
    const lineage = computeRepairLineage('r1', repairChain(1), NO_EPOCH)
    expect(lineage).toMatchObject({ ok: true, depth: 1 })
  })

  it('repair 3 段は depth 3', () => {
    const lineage = computeRepairLineage('r3', repairChain(3), NO_EPOCH)
    expect(lineage).toMatchObject({ ok: true, depth: 3 })
  })

  // **`resume:` は境界にしない。** `resume_task` は PL が in-process で実行できるため、
  // 境界にすると PL が budget を自力で更新できてしまう。跨いで辿り、段数には数えない。
  it('resume を跨いでも前の chain の repair 段数を引き継ぐ', () => {
    const jobs = [
      ...repairChain(3),
      job('resumed', 'resume:r3:1'),
    ]
    const lineage = computeRepairLineage('resumed', jobs, NO_EPOCH)
    expect(lineage).toMatchObject({ ok: true, depth: 3 })
  })

  it('resume が2段続いても同じ', () => {
    const jobs = [
      ...repairChain(3),
      job('resumed1', 'resume:r3:1'),
      job('resumed2', 'resume:resumed1:1'),
    ]
    expect(computeRepairLineage('resumed2', jobs, NO_EPOCH)).toMatchObject({ ok: true, depth: 3 })
  })

  // **epoch に覆われた Job がそこから先の根になる。**
  it('epoch に覆われた Job は depth 0', () => {
    const jobs = [...repairChain(3), job('resumed', 'resume:r3:1')]
    const lineage = computeRepairLineage('resumed', jobs, new Set(['resumed']))
    expect(lineage).toMatchObject({ ok: true, depth: 0 })
  })

  it('epoch より手前の repair だけを数える', () => {
    const jobs = [
      ...repairChain(3),
      job('resumed', 'resume:r3:1'),
      job('after1', 'repair:resumed:1'),
    ]
    const lineage = computeRepairLineage('after1', jobs, new Set(['resumed']))
    expect(lineage).toMatchObject({ ok: true, depth: 1 })
  })

  it('repair が success でも段数は減らない（成功では budget を戻さない）', () => {
    const jobs = [
      job('root', 'task:t1:initial-implement'),
      job('r1', 'repair:root:1', 'success'),
      job('r2', 'repair:r1:1', 'success'),
      job('r3', 'repair:r2:1', 'success'),
    ]
    expect(computeRepairLineage('r3', jobs, NO_EPOCH)).toMatchObject({ ok: true, depth: 3 })
  })
})

describe('computeRepairLineage — 辿れない形は推測しない', () => {
  it('source Job が存在しなければ fail-closed', () => {
    const jobs = [job('r1', 'repair:missing:1')]
    const lineage = computeRepairLineage('r1', jobs, NO_EPOCH)
    expect(lineage.ok).toBe(false)
    if (!lineage.ok) expect(lineage.reason).toContain('not a job of this task')
  })

  // 別 Task の Job は `priorJobs`（= その Task の全 Job）に居ないので、同じ経路で落ちる。
  it('別 Task の Job を指していれば fail-closed', () => {
    const jobs = [job('r1', 'repair:job-of-another-task:1')]
    expect(computeRepairLineage('r1', jobs, NO_EPOCH).ok).toBe(false)
  })

  it('規約に合わない repair stepKey は fail-closed', () => {
    const jobs = [job('r1', 'repair:parent')]
    const lineage = computeRepairLineage('r1', jobs, NO_EPOCH)
    expect(lineage.ok).toBe(false)
    if (!lineage.ok) expect(lineage.reason).toContain('malformed')
  })

  it('attempt 番号が :1 でない repair stepKey も fail-closed', () => {
    const jobs = [job('root', 'task:t1:initial-implement'), job('r1', 'repair:root:2')]
    expect(computeRepairLineage('r1', jobs, NO_EPOCH).ok).toBe(false)
  })

  it('循環していれば fail-closed', () => {
    const jobs = [job('a', 'repair:b:1'), job('b', 'repair:a:1')]
    const lineage = computeRepairLineage('a', jobs, NO_EPOCH)
    expect(lineage.ok).toBe(false)
    if (!lineage.ok) expect(lineage.reason).toContain('cyclic')
  })

  it('自分自身を指していても fail-closed', () => {
    expect(computeRepairLineage('a', [job('a', 'repair:a:1')], NO_EPOCH).ok).toBe(false)
  })

  it('深すぎる chain は fail-closed（推測して打ち切らない）', () => {
    const jobs = [job('root', 'task:t1:initial-implement')]
    let parent = 'root'
    for (let i = 1; i <= 200; i += 1) {
      jobs.push(job(`r${i}`, `resume:${parent}:1`))
      parent = `r${i}`
    }
    const lineage = computeRepairLineage(parent, jobs, NO_EPOCH)
    expect(lineage.ok).toBe(false)
    if (!lineage.ok) expect(lineage.reason).toContain('deeper than')
  })
})

describe('decideRepairAction — budget は chain 単位', () => {
  it.each([0, 1, 2])('depth %i なら次の repair を許す', (depth) => {
    const jobs = repairChain(depth)
    const leaf = depth === 0 ? 'root' : `r${depth}`
    const decision = decideRepairAction(leaf, jobs, { exitCode: 99, stderr: 'new failure' })
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(depth + 1)
  })

  it(`depth ${MAX_REPAIR_ATTEMPTS} なら escalate する`, () => {
    const jobs = repairChain(MAX_REPAIR_ATTEMPTS)
    const decision = decideRepairAction(`r${MAX_REPAIR_ATTEMPTS}`, jobs, {
      exitCode: 99, stderr: 'new failure',
    })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.code).toBe('attempt_limit')
  })

  // **production `c3849205` の形。** 別 chain で使い切った repair を数えてはいけない。
  it('別 chain の古い repair は数えない', () => {
    const jobs = [
      ...repairChain(MAX_REPAIR_ATTEMPTS),
      job('resumed', 'resume:r3:1'),
      job('current', 'resume:resumed:1'),
    ]
    // epoch が無ければ resume を跨いで数えるので、まだ上限のまま。
    const withoutEpoch = decideRepairAction('current', jobs, { exitCode: 9, stderr: 'x' })
    expect(withoutEpoch.action).toBe('escalate')

    // epoch が成立してはじめて新しい chain になる。
    const withEpoch = decideRepairAction('current', jobs, { exitCode: 9, stderr: 'x' }, new Set(['current']))
    expect(withEpoch.action).toBe('repair')
    if (withEpoch.action === 'repair') expect(withEpoch.attempt).toBe(1)
  })

  it('辿れない lineage は escalate（budget を推測しない）', () => {
    const decision = decideRepairAction('r1', [job('r1', 'repair:missing:1')], FACTS)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.code).toBe('lineage_undeterminable')
  })
})
