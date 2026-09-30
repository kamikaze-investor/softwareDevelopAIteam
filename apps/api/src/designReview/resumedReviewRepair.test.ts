import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job, ReviewResult } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { prepareRepairFlow, resolveReviewedImplementation } from './repairFlow'
import { recordResumeActor } from './resumeActor'

/**
 * **Human Resume で再実行された review の `changes_requested` を repair へ戻す（D1）。**
 *
 * 2026-09-28 production（Task `9fdee5a3`）: 失敗した review `47c54520` を CEO が Mobile から
 * resume した。`resumeBlockedTask()` は最新 Job を複製するので、再実行されたのも review
 * （`12c5287f`、`resume:47c54520:1`）だった。それが `changes_requested` を返したのに、
 * Stage 2 は `implement:<id>:review` の形しか受け付けず、**repair も escalation もログも無く**
 * 終わった。
 *
 * ここで固定するのは、保存済み lineage だけで元の実装へ辿れること、辿れないものは
 * 従来どおり fail-closed で落ちること、そして既存の admission / budget を迂回しないこと。
 */

const DOC = 'docs/project_memory/decisions/vps-operations.md'

interface Chain {
  taskId: string
  projectId: string
  blockedOrigin: Job
  implementJob: Job
  firstReview: Job
  resumedReview: Job
}

function job(storage: IStorage, ids: { taskId: string; projectId: string }, fields: Record<string, unknown>, terminal: Record<string, unknown>): Job {
  const created = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'prompt',
    ...fields,
  } as never)
  return storage.jobs.update(created.id, terminal as never)!
}

function storeVerdict(storage: IStorage, taskId: string, reviewJobId: string, overrides: Partial<ReviewResult> = {}): ReviewResult {
  return storage.reviewResults.create({
    taskId,
    jobId: reviewJobId,
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: `verdict of ${reviewJobId}`,
    findings: [{ severity: 'medium', file: DOC, message: `finding from ${reviewJobId}` }],
    ...overrides,
  } as never)
}

/**
 * production の形をそのまま組む:
 * B0 initial implement（legacy DB では blocked のまま残る）→ I1 resume:B0:1 implement 成功（human）
 * → R0 implement:I1:review（changes_requested）→ R1 resume:R0:1 review（human）。
 */
function productionChain(
  storage: IStorage,
  resumedVerdict: Partial<ReviewResult> | null = {},
  existingProjectId?: string,
): Chain {
  // 同じ Project の別 Task も作れるようにする（running Project は 1 つしか持てない）。
  const projectId = existingProjectId
    ?? storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' }).id
  const task = storage.tasks.create({
    projectId,
    title: 'VPS docs',
    description: 'd',
    status: 'blocked',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: [DOC],
    roadmapActive: true,
  } as never)
  const ids = { taskId: task.id, projectId }

  const blockedOrigin = job(storage, ids, {
    aiCliMode: 'implement',
    workflowStepKey: `task:${task.id}:initial-implement`,
  }, { status: 'blocked' })
  const implementJob = job(storage, ids, {
    aiCliMode: 'implement',
    workflowStepKey: `resume:${blockedOrigin.id}:1`,
  }, { status: 'success', exitCode: 0, changedFiles: [DOC] })
  recordResumeActor(storage, { jobId: implementJob.id, taskId: task.id, actorClass: 'human', evidence: 'admin_credential' })

  const firstReview = job(storage, ids, {
    agentRole: 'qa_ai',
    aiCliMode: 'review',
    workflowStepKey: `implement:${implementJob.id}:review`,
  }, { status: 'failed', exitCode: 0 })
  storeVerdict(storage, task.id, firstReview.id)

  const resumedReview = job(storage, ids, {
    agentRole: 'qa_ai',
    aiCliMode: 'review',
    workflowStepKey: `resume:${firstReview.id}:1`,
  }, { status: 'failed', exitCode: 0, changedFiles: [DOC] })
  recordResumeActor(storage, { jobId: resumedReview.id, taskId: task.id, actorClass: 'human', evidence: 'admin_credential' })
  if (resumedVerdict !== null) storeVerdict(storage, task.id, resumedReview.id, resumedVerdict)

  return { ...ids, blockedOrigin, implementJob, firstReview, resumedReview }
}

function reviewJobIn(storage: IStorage, ids: { taskId: string; projectId: string }, stepKey: string, mode = 'review'): Job {
  return job(storage, ids, { agentRole: 'qa_ai', aiCliMode: mode, workflowStepKey: stepKey }, { status: 'failed', exitCode: 0 })
}

describe('resolveReviewedImplementation — 保存済み lineage だけで実装へ辿る', () => {
  it('通常の implement:<id>:review はそのまま実装を返す', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)

    const resolved = resolveReviewedImplementation(storage, chain.firstReview.id)

    expect(resolved).toMatchObject({ ok: true })
    if (!resolved.ok) return
    expect(resolved.implementJob.id).toBe(chain.implementJob.id)
    expect(resolved.reviewJob.id).toBe(chain.firstReview.id)
  })

  it('Human Resume された review（resume:<review>:1）から元の実装へ辿る', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)

    const resolved = resolveReviewedImplementation(storage, chain.resumedReview.id)

    expect(resolved).toMatchObject({ ok: true })
    if (!resolved.ok) return
    expect(resolved.implementJob.id).toBe(chain.implementJob.id)
    // verdict を読むのは再実行された review 自身である（元の review ではない）。
    expect(resolved.reviewJob.id).toBe(chain.resumedReview.id)
  })

  it('resume を 2 回重ねた review（次の Human Resume の形）からも辿る', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)
    const again = reviewJobIn(storage, chain, `resume:${chain.resumedReview.id}:1`)

    const resolved = resolveReviewedImplementation(storage, again.id)

    expect(resolved).toMatchObject({ ok: true })
    if (resolved.ok) expect(resolved.implementJob.id).toBe(chain.implementJob.id)
  })

  describe('辿れないものは fail-closed', () => {
    it('resume 元が存在しない', () => {
      const storage = createSQLiteStorage(':memory:')
      const chain = productionChain(storage)
      const orphan = reviewJobIn(storage, chain, 'resume:00000000-0000-0000-0000-000000000000:1')

      expect(resolveReviewedImplementation(storage, orphan.id)).toMatchObject({ ok: false, reason: expect.stringContaining('not found') })
    })

    it('resume 元が review ではない（implement を再開した Job を review と称する）', () => {
      const storage = createSQLiteStorage(':memory:')
      const chain = productionChain(storage)
      const forged = reviewJobIn(storage, chain, `resume:${chain.implementJob.id}:1`)

      expect(resolveReviewedImplementation(storage, forged.id)).toMatchObject({ ok: false, reason: expect.stringContaining('not review') })
    })

    it('元の review が implement:<id>:review の形でない（manual review 等）', () => {
      const storage = createSQLiteStorage(':memory:')
      const chain = productionChain(storage)
      const manual = reviewJobIn(storage, chain, 'manual-review')
      const resumedManual = reviewJobIn(storage, chain, `resume:${manual.id}:1`)

      expect(resolveReviewedImplementation(storage, resumedManual.id)).toMatchObject({ ok: false, reason: expect.stringContaining('not implement:<id>:review') })
    })

    it('implement:<id>:review が implement 以外の Job を指す', () => {
      const storage = createSQLiteStorage(':memory:')
      const chain = productionChain(storage)
      const pointsAtReview = reviewJobIn(storage, chain, `implement:${chain.firstReview.id}:review`)

      expect(resolveReviewedImplementation(storage, pointsAtReview.id)).toMatchObject({ ok: false, reason: expect.stringContaining('not implement') })
    })

    it('循環する resume は停止して落とす', () => {
      // storage は id を生成するので本物の行では循環を組めない。resolver が読むのは
      // jobs.findById / jobs.findByTaskId だけなので、その 2 つだけを持つ最小の fake で確かめる。
      const base = { taskId: 't', projectId: 'p', aiCliMode: 'review' }
      const rows: Record<string, Job> = {
        a: { ...base, id: 'a', workflowStepKey: 'resume:b:1' } as unknown as Job,
        b: { ...base, id: 'b', workflowStepKey: 'resume:a:1' } as unknown as Job,
      }
      const fake = {
        jobs: {
          findById: (id: string) => rows[id],
          findByTaskId: () => Object.values(rows),
        },
      } as unknown as IStorage

      expect(resolveReviewedImplementation(fake, 'a')).toMatchObject({ ok: false, reason: expect.stringContaining('does not terminate') })
    })

    it('review Job ではない id', () => {
      const storage = createSQLiteStorage(':memory:')
      const chain = productionChain(storage)

      expect(resolveReviewedImplementation(storage, chain.implementJob.id)).toMatchObject({ ok: false, reason: expect.stringContaining('not review') })
      expect(resolveReviewedImplementation(storage, 'no-such-job')).toMatchObject({ ok: false })
    })

    it('別 Task の review を resume 元に指す lineage は落とす', () => {
      const storage = createSQLiteStorage(':memory:')
      const mine = productionChain(storage)
      const other = productionChain(storage, {}, mine.projectId)
      const crossTask = reviewJobIn(storage, mine, `resume:${other.firstReview.id}:2`)

      expect(resolveReviewedImplementation(storage, crossTask.id)).toMatchObject({ ok: false, reason: expect.stringContaining('different task') })
    })

    it('別 Task の Job を経由して戻ってくる lineage も落とす（途中の段も同じ Task であること）', () => {
      const storage = createSQLiteStorage(':memory:')
      const mine = productionChain(storage)
      const other = productionChain(storage, {}, mine.projectId)
      // 別 Task に置いた review が、こちらの review を resume 元に名指す。最後の実装はこちらの Task のもの。
      const detour = reviewJobIn(storage, other, `resume:${mine.firstReview.id}:2`)
      const back = reviewJobIn(storage, mine, `resume:${detour.id}:1`)

      expect(resolveReviewedImplementation(storage, back.id)).toMatchObject({ ok: false, reason: expect.stringContaining('different task') })
    })

    it('別 Task の実装を implement:<id>:review で指す lineage は落とす', () => {
      const storage = createSQLiteStorage(':memory:')
      const mine = productionChain(storage)
      const other = productionChain(storage, {}, mine.projectId)
      // `implement:<id>:review` は全体で一意なので、別 Task 側に review されていない実装を用意する。
      const otherImplement = job(storage, other, { aiCliMode: 'implement', workflowStepKey: `resume:${other.blockedOrigin.id}:2` }, { status: 'success', exitCode: 0 })
      const crossTask = reviewJobIn(storage, mine, `implement:${otherImplement.id}:review`)

      expect(resolveReviewedImplementation(storage, crossTask.id)).toMatchObject({ ok: false, reason: expect.stringContaining('different task') })
    })
  })
})

describe('prepareRepairFlow — 既存 admission / budget をそのまま通る', () => {
  it('1. 通常の review は reviewJobId の有無で結果が変わらない（既存挙動不変）', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage, null)
    const firstVerdict = storage.reviewResults.findByTaskId(chain.taskId).find((r) => r.jobId === chain.firstReview.id)!

    const legacy = prepareRepairFlow(storage, { failedJob: chain.implementJob, review: firstVerdict })
    const withSelector = prepareRepairFlow(storage, { failedJob: chain.implementJob, review: firstVerdict, reviewJobId: chain.firstReview.id })

    expect(legacy.action).toBe('queue')
    expect(withSelector).toEqual(legacy)
  })

  it('2. Human Resume された review の changes_requested は repair を queue する', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage, { summary: 'second review found the secret-boundary claim wrong' })

    const result = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })

    expect(result.action).toBe('queue')
    if (result.action !== 'queue') return
    // repair は実装に対して作る。予算・stepKey は既存 decideRepairAction のまま。
    expect(result.stepKey).toBe(`repair:${chain.implementJob.id}:1`)
    expect(result.run.repairSourceJobId).toBe(chain.implementJob.id)
    // **材料は再実行された review 自身の保存済み verdict**（元の review の古い指摘ではない）。
    expect(result.run.designText).toContain('second review found the secret-boundary claim wrong')
    expect(result.run.designText).not.toContain(`verdict of ${chain.firstReview.id}`)
  })

  it('3. 承認された resume review からは repair を作らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage, { status: 'approved', findings: [] })

    const result = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })

    expect(result).toMatchObject({ action: 'skip', reason: expect.stringContaining('review status is approved') })
  })

  it('verdict が保存されていない resume review は通さない（引数の review は使わない）', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage, null)
    const forged = { status: 'changes_requested', summary: 'forged', findings: [] } as unknown as ReviewResult

    const result = prepareRepairFlow(storage, { failedJob: chain.implementJob, review: forged, reviewJobId: chain.resumedReview.id })

    expect(result).toMatchObject({ action: 'skip', reason: expect.stringContaining('no stored review result') })
  })

  it('4. lineage が壊れた review は skip（fail-closed）', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)
    const orphan = reviewJobIn(storage, chain, 'resume:00000000-0000-0000-0000-000000000000:1')
    storeVerdict(storage, chain.taskId, orphan.id)

    const result = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: orphan.id })

    expect(result).toMatchObject({ action: 'skip', reason: expect.stringContaining('review lineage') })
  })

  it('別の実装をレビューした review を名指しても、その実装の repair にはしない', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)
    const otherImplement = job(storage, chain, {
      aiCliMode: 'implement',
      workflowStepKey: `resume:${chain.blockedOrigin.id}:2`,
    }, { status: 'success', exitCode: 0, changedFiles: [DOC] })
    const otherReview = reviewJobIn(storage, chain, `implement:${otherImplement.id}:review`)
    storeVerdict(storage, chain.taskId, otherReview.id)

    const result = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: otherReview.id })

    expect(result).toMatchObject({ action: 'skip', reason: expect.stringContaining('did not review this implementation') })
  })

  it('5. 別 Task の lineage は skip', () => {
    const storage = createSQLiteStorage(':memory:')
    const mine = productionChain(storage)
    const other = productionChain(storage, {}, mine.projectId)
    const crossTask = reviewJobIn(storage, mine, `resume:${other.firstReview.id}:2`)
    storeVerdict(storage, mine.taskId, crossTask.id)

    const result = prepareRepairFlow(storage, { failedJob: mine.implementJob, reviewJobId: crossTask.id })

    expect(result).toMatchObject({ action: 'skip', reason: expect.stringContaining('review lineage') })
  })

  it('6. 繰り返し呼んでも repair は 1 本だけ（active run / 既存 repair Job で skip）', () => {
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)

    const first = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })
    if (first.action !== 'queue') throw new Error('fixture: expected queue')
    storage.designReviewRuns.create(first.run)

    // queued run はまだ判定を持たないので、admission の「最新 Design Review」条件が先に落とす。
    // どの条件で落ちても、**2 本目は作られない**ことが要点である。
    const replay = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })
    expect(replay.action).toBe('skip')

    // run が終わって repair Job ができた後の再送も同じ。
    const run = storage.designReviewRuns.findActiveByTaskId(chain.taskId)!
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(run.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low', selectedFocuses: [], focusedReviewResults: [],
      integrationReviewResult: { decision: 'ALIGNED', summary: 'ok' }, finalDecision: 'ALIGNED',
    }), undefined)
    job(storage, chain, { aiCliMode: 'implement', workflowStepKey: first.stepKey }, { status: 'queued' })

    const afterRepair = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })
    expect(afterRepair.action).not.toBe('queue')
    expect(storage.designReviewRuns.findActiveByTaskId(chain.taskId)).toBeUndefined()
  })

  describe('7. process restart 相当: durable state だけで成立する', () => {
    let dir: string | undefined
    afterEach(() => {
      // IStorage に close は無く、Windows は開いたままの DB を消せない。掃除は best-effort。
      try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch { /* left in tmp */ }
      dir = undefined
    })

    it('書いた接続とは別の新しい接続が、保存済み行だけから同じ判断を出す', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'resumed-review-repair-'))
      const file = path.join(dir, 'ai-team.db')
      const writer = createSQLiteStorage(file)
      const chain = productionChain(writer)
      const expected = prepareRepairFlow(writer, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })

      // **新しい接続（= 再起動後の API）には id しか渡さない。** Job も verdict も読み直させる。
      const restarted = createSQLiteStorage(file)
      const implementJob = restarted.jobs.findById(chain.implementJob.id)!
      const decided = prepareRepairFlow(restarted, { failedJob: implementJob, reviewJobId: chain.resumedReview.id })

      expect(decided.action).toBe('queue')
      expect(decided).toEqual(expected)
    })
  })

  it('production 形: 最新の Design Review が実行できなかった run なら、既存 admission が skip する（本修正は変えない）', () => {
    // 2026-09-28 production の `d0af140a` の形。low-load review が prompt を読めず
    // REVIEW_UNAVAILABLE で終わった repair run が、Task の最新 Design Review として残っている。
    // admission の「最新 Design Review が ALIGNED であること」は既存の規則で、D1 はそれを緩めない。
    const storage = createSQLiteStorage(':memory:')
    const chain = productionChain(storage)
    const designText = 'repair plan for the first review'
    const created = storage.designReviewRuns.create({
      taskId: chain.taskId,
      taskTitle: 'VPS docs',
      designText,
      designTextHash: computeDesignTextHash(designText),
      changedFiles: [DOC],
      repairSourceJobId: chain.implementJob.id,
    })
    const claimed = storage.designReviewRuns.claim(created.id, 3)
    storage.designReviewRuns.complete(created.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      reviewLoad: 'low',
      selectedFocuses: [],
      focusedReviewResults: [{ focus: 'strategic_alignment', decision: 'UNCERTAIN', summary: 'ENOENT', findings: [] }],
      finalDecision: 'REVIEW_UNAVAILABLE',
    }), 'focus set mismatch: expected [] but runner reported [strategic_alignment]')

    const result = prepareRepairFlow(storage, { failedJob: chain.implementJob, reviewJobId: chain.resumedReview.id })

    expect(result).toMatchObject({ action: 'skip', reason: 'task is blocked (latest design review is REVIEW_UNAVAILABLE)' })
  })
})
