import { describe, expect, it } from 'vitest'
import {
  MAX_REPAIR_ATTEMPTS,
  computeFailureSignature,
  decideRepairAction,
  walkRepairGeneration,
  type PriorRepairJob,
  type RepairFailureFacts,
  type ResumeActorClass,
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

const ORIGIN_ID = 'job-origin'

/** repair でも resume でもない通常の Job。generation の根になる。 */
function originJob(
  id: string = ORIGIN_ID,
  facts: RepairFailureFacts = FACTS_B,
  status = 'failed',
): PriorRepairJob {
  return { id, workflowStepKey: `task:${id}:initial-implement`, status, facts }
}

/** `source` を直接の親に持つ repair Job。 */
function repairOf(
  source: string,
  id: string,
  status = 'failed',
  facts: RepairFailureFacts = FACTS_A,
): PriorRepairJob {
  return { id, workflowStepKey: `repair:${source}:1`, status, facts }
}

/** `source` を直接の親に持つ resume Job。actor class は省略可（= 記録が無い）。 */
function resumeOf(
  source: string,
  id: string,
  resumeActorClass?: ResumeActorClass,
  status = 'failed',
  facts: RepairFailureFacts = FACTS_B,
): PriorRepairJob {
  return { id, workflowStepKey: `resume:${source}:1`, status, facts, resumeActorClass }
}

/** origin から深さ depth の直列 repair chain を作る。tip の id は repair-<depth>。 */
function chain(
  depth: number,
  factsFor: (i: number) => RepairFailureFacts = () => FACTS_A,
  status = 'failed',
): { jobs: PriorRepairJob[]; tip: string } {
  const jobs: PriorRepairJob[] = [originJob()]
  let parent = ORIGIN_ID
  for (let i = 1; i <= depth; i += 1) {
    const id = `repair-${i}`
    jobs.push(repairOf(parent, id, status, factsFor(i)))
    parent = id
  }
  return { jobs, tip: parent }
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

// ---------------------------------------------------------------------------
// 1〜3: 既存挙動。chain 単位で数えるようにしても、1 本の chain の見え方は変わらない。
// ---------------------------------------------------------------------------

describe('decideRepairAction — 既存挙動', () => {
  it('[1] 初回の失敗では attempt 1 の repair を作る', () => {
    const decision = decideRepairAction(ORIGIN_ID, [originJob()], FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(1)
      expect(decision.stepKey).toBe(`repair:${ORIGIN_ID}:1`)
      expect(decision.requireDifferentApproach).toBe(false)
      expect(decision.generation.rootJobId).toBe(ORIGIN_ID)
      expect(decision.generation.rootKind).toBe('origin')
      expect(decision.generation.budgetReset).toBe(false)
    }
  })

  it('[2] 1 本の chain は MAX_REPAIR_ATTEMPTS で必ず止まる', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS, (i) => ({ exitCode: i, stderr: `distinct failure ${i}` }))
    const decision = decideRepairAction(built.tip, built.jobs, { exitCode: 99, stderr: 'yet another' })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('[2] hard bound の手前までは継続する', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS - 1, (i) => ({ exitCode: i, stderr: `distinct failure ${i}` }))
    const decision = decideRepairAction(built.tip, built.jobs, { exitCode: 99, stderr: 'yet another' })
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(MAX_REPAIR_ATTEMPTS)
  })

  it('[3] 異なる失敗が続く間は repair を継続する', () => {
    const built = chain(1)
    const decision = decideRepairAction(built.tip, built.jobs, FACTS_B)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.requireDifferentApproach).toBe(false)
    }
  })

  it('[3] 同じ失敗が残っていても即 escalate せず、別アプローチを要求して継続する', () => {
    const built = chain(1)
    const decision = decideRepairAction(built.tip, built.jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.requireDifferentApproach).toBe(true)
    }
  })

  it('[3] 同じ失敗かつ手がかりが無い場合のみ escalate する', () => {
    const built = chain(1, () => ({}))
    const decision = decideRepairAction(built.tip, built.jobs, {})
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('no actionable information')
  })

  it('[3] 成功した repair と同じ署名でも、失敗していなければ別アプローチ要求にしない', () => {
    const built = chain(1, () => FACTS_A, 'success')
    const decision = decideRepairAction(built.tip, built.jobs, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.requireDifferentApproach).toBe(false)
  })

  it('[3] repair 以外の既存 Job は試行回数に数えない', () => {
    const priors: PriorRepairJob[] = [
      originJob(),
      { id: 'other', workflowStepKey: 'implement:1', status: 'failed', facts: FACTS_B },
      { id: 'nokey', workflowStepKey: undefined, status: 'success', facts: {} },
    ]
    const decision = decideRepairAction(ORIGIN_ID, priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })

  it('[3] Stage 1 の retry Job は repair 試行に数えない', () => {
    const priors: PriorRepairJob[] = [
      originJob(),
      { id: 'retry-1', workflowStepKey: `retry:${ORIGIN_ID}:1`, status: 'failed', facts: FACTS_B },
    ]
    const decision = decideRepairAction('retry-1', priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })

  it('[3] 無関係な別 chain の repair は予算を食わない（Task 全体件数では数えない）', () => {
    // 3 本の独立した chain がそれぞれ 1 回ずつ直っている。旧実装ではここで Task 全体の
    // repair 件数が MAX に達し、4 本目の最初の失敗がいきなり escalate していた（実測）。
    const priors: PriorRepairJob[] = []
    for (const n of [1, 2, 3]) {
      priors.push(originJob(`origin-${n}`))
      priors.push(repairOf(`origin-${n}`, `repair-${n}`, 'success'))
    }
    priors.push(originJob('origin-4'))

    const decision = decideRepairAction('origin-4', priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.attempt).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4〜7: Human resume は新しい generation の根になる。
// ---------------------------------------------------------------------------

describe('decideRepairAction — Human resume', () => {
  it('[4] human resume は新しい generation の根になり、depth 0 から数え直す', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-human', 'human')]

    const decision = decideRepairAction('resume-human', priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(1)
      expect(decision.generation.rootJobId).toBe('resume-human')
      expect(decision.generation.rootKind).toBe('human_resume')
      expect(decision.generation.depth).toBe(0)
      expect(decision.generation.budgetReset).toBe(true)
      expect(decision.generation.previousGenerationRoot).toBe(built.tip)
      expect(decision.generation.resetReason).toBe('human_resume_started_new_generation')
    }
  })

  it('[5] 使い切った chain でも human resume 後は自動修復できる', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    expect(decideRepairAction(built.tip, built.jobs, FACTS_B).action).toBe('escalate')

    const priors = [...built.jobs, resumeOf(built.tip, 'resume-human', 'human')]
    expect(decideRepairAction('resume-human', priors, FACTS_B).action).toBe('repair')
  })

  it('[6] human resume の後でも、その generation の中の深さは正しく数える', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [
      ...built.jobs,
      resumeOf(built.tip, 'resume-human', 'human'),
      repairOf('resume-human', 'gen2-repair-1'),
    ]
    const decision = decideRepairAction('gen2-repair-1', priors, FACTS_B)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.generation.rootJobId).toBe('resume-human')
    }
  })

  it('[7] human resume で始まった generation も MAX_REPAIR_ATTEMPTS で止まる（無制限にはならない）', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-human', 'human')]
    let parent = 'resume-human'
    for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i += 1) {
      const id = `gen2-repair-${i}`
      priors.push(repairOf(parent, id, 'failed', { exitCode: i, stderr: `gen2 distinct ${i}` }))
      parent = id
    }

    const decision = decideRepairAction(parent, priors, { exitCode: 99, stderr: 'gen2 yet another' })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })
})

// ---------------------------------------------------------------------------
// 8〜11: AI resume は generation を跨がない。
// 「AI が自分の repair 予算を作り直せない」という保証はここで固定している。
// ---------------------------------------------------------------------------

describe('decideRepairAction — AI resume', () => {
  it('[8] AI resume は予算を再発行しない（使い切った chain は使い切ったまま）', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-ai', 'ai')]

    const decision = decideRepairAction('resume-ai', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('[9] AI resume は前 generation の深さをそのまま引き継ぐ', () => {
    const built = chain(1)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-ai', 'ai')]

    const decision = decideRepairAction('resume-ai', priors, FACTS_B)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(2)
      expect(decision.generation.rootJobId).toBe(ORIGIN_ID)
      expect(decision.generation.rootKind).toBe('origin')
      expect(decision.generation.crossedAiResume).toBe(true)
      expect(decision.generation.budgetReset).toBe(false)
      expect(decision.generation.resetReason).toBe('ai_or_unknown_resume_continues_generation')
    }
  })

  it('[10] AI resume を何回挟んでも予算は増えない', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs]
    let parent = built.tip
    for (let i = 1; i <= 5; i += 1) {
      const id = `resume-ai-${i}`
      priors.push(resumeOf(parent, id, 'ai'))
      parent = id
    }

    const decision = decideRepairAction(parent, priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('[11] AI resume と repair を交互に積んでも上限は 1 generation 分のまま', () => {
    const priors: PriorRepairJob[] = [originJob()]
    let parent = ORIGIN_ID
    for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i += 1) {
      const resumeId = `resume-ai-${i}`
      priors.push(resumeOf(parent, resumeId, 'ai'))
      const repairId = `repair-${i}`
      priors.push(repairOf(resumeId, repairId, 'failed', { exitCode: i, stderr: `distinct ${i}` }))
      parent = repairId
    }

    const decision = decideRepairAction(parent, priors, { exitCode: 99, stderr: 'yet another' })
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })
})

// ---------------------------------------------------------------------------
// 12〜13: actor が判らないときは human 側へ倒さない。
// ---------------------------------------------------------------------------

describe('decideRepairAction — actor 不明の resume', () => {
  it('[12] actor の記録が無い resume は予算を再発行しない', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-norecord', undefined)]

    const decision = decideRepairAction('resume-norecord', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('[13] actor が unknown と記録された resume も予算を再発行しない', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-unknown', 'unknown')]

    const decision = decideRepairAction('resume-unknown', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
  })

  it('[13] unknown resume は ai resume と完全に同じ扱いになる', () => {
    const built = chain(1)
    const unknownWalk = walkRepairGeneration('resume-x', [...built.jobs, resumeOf(built.tip, 'resume-x', 'unknown')])
    const aiWalk = walkRepairGeneration('resume-x', [...built.jobs, resumeOf(built.tip, 'resume-x', 'ai')])
    expect(unknownWalk).toEqual(aiWalk)
  })
})

// ---------------------------------------------------------------------------
// 14〜19: lineage を数え切れないときは必ず fail-closed（depth 0 にしない）。
// ---------------------------------------------------------------------------

describe('walkRepairGeneration — 数え切れないときは fail-closed', () => {
  it('[14] repair の stepKey が壊れていたら escalate する', () => {
    const priors: PriorRepairJob[] = [
      originJob(),
      { id: 'broken', workflowStepKey: 'repair:', status: 'failed', facts: FACTS_A },
    ]
    const decision = decideRepairAction('broken', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('malformed repair step key')
  })

  it('[15] resume の stepKey が壊れていたら escalate する', () => {
    const priors: PriorRepairJob[] = [
      originJob(),
      { id: 'broken', workflowStepKey: 'resume::1', status: 'failed', facts: FACTS_A },
    ]
    const decision = decideRepairAction('broken', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('malformed resume step key')
  })

  it('[16] source Job そのものが Job 一覧に無ければ escalate する', () => {
    const decision = decideRepairAction('missing-job', [originJob()], FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('not a job of this task')
  })

  it('[17] 親が別 Task の Job（この Task に無い id）なら escalate する', () => {
    const priors: PriorRepairJob[] = [repairOf('job-of-another-task', 'repair-1')]
    const decision = decideRepairAction('repair-1', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('not a job of this task')
  })

  it('[18] lineage が環を作っていたら escalate する', () => {
    const priors: PriorRepairJob[] = [repairOf('b', 'a'), repairOf('a', 'b')]
    const decision = decideRepairAction('a', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('cycle')
  })

  it('[18] 自己参照も環として止める', () => {
    const decision = decideRepairAction('a', [repairOf('a', 'a')], FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('cycle')
  })

  it('[19] 歩数の上限を超える lineage は escalate する', () => {
    const built = chain(200, (i) => ({ exitCode: i, stderr: `distinct ${i}` }))
    const decision = decideRepairAction(built.tip, built.jobs, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('bounded walk')
  })

  it('[19] 同じ id の Job が 2 件ある入力は曖昧として escalate する', () => {
    const priors: PriorRepairJob[] = [originJob(), originJob()]
    const decision = decideRepairAction(ORIGIN_ID, priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('ambiguous lineage')
  })

  it('[19] 壊れた lineage は例外なく escalate であり、depth 0 の repair にはならない', () => {
    const broken: PriorRepairJob[][] = [
      [originJob(), { id: 'x', workflowStepKey: 'repair:', status: 'failed', facts: FACTS_A }],
      [originJob(), { id: 'x', workflowStepKey: 'resume::1', status: 'failed', facts: FACTS_A }],
      [repairOf('b', 'a'), repairOf('a', 'b')],
      [originJob(), originJob()],
    ]
    for (const priors of broken) {
      const sourceId = priors[priors.length - 1].id
      const decision = decideRepairAction(sourceId, priors, FACTS_A)
      expect(decision.action).toBe('escalate')
    }
  })
})

// ---------------------------------------------------------------------------
// human と記録されていても、lineage の矛盾までは跨がない（独立レビュー指摘）。
// 根より**上**の破損は跨いでよいが、「この resume がこの Task の Job から作られた」
// ことは確かめる。`resumeBlockedTask()` は必ず同一 Task の latestJob を親にする。
// ---------------------------------------------------------------------------

describe('walkRepairGeneration — human resume の親リンクも検証する', () => {
  it('親が Job 一覧に無い human resume は escalate する（depth 0 の予算を配らない）', () => {
    const priors: PriorRepairJob[] = [
      originJob(),
      resumeOf('job-that-does-not-exist', 'resume-human', 'human'),
    ]
    const decision = decideRepairAction('resume-human', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('not a usable parent job of this task')
  })

  it('自分自身を親にした human resume は escalate する', () => {
    const decision = decideRepairAction('resume-human', [resumeOf('resume-human', 'resume-human', 'human')], FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('not a usable parent job of this task')
  })

  it('既に辿った Job を親にした human resume は escalate する（環）', () => {
    const priors: PriorRepairJob[] = [
      repairOf('resume-human', 'repair-1'),
      resumeOf('repair-1', 'resume-human', 'human'),
    ]
    const decision = decideRepairAction('repair-1', priors, FACTS_A)
    expect(decision.action).toBe('escalate')
    if (decision.action === 'escalate') expect(decision.reason).toContain('not a usable parent job of this task')
  })

  it('親が実在する human resume は従来どおり新しい generation の根になる', () => {
    const built = chain(MAX_REPAIR_ATTEMPTS)
    const priors = [...built.jobs, resumeOf(built.tip, 'resume-human', 'human')]
    const decision = decideRepairAction('resume-human', priors, FACTS_A)
    expect(decision.action).toBe('repair')
    if (decision.action === 'repair') expect(decision.generation.rootKind).toBe('human_resume')
  })
})
