/**
 * 採用経路の Review laundering 対策。
 *
 * **穴**: `POST /api/projects/:id/roadmap-adoptions` は、対象 Task が `pending` かつ Job 0 件なら
 * spec を更新して **fresh Design Review を起こす**。ここには「却下済みと実質同じ提案か」の検査が
 * 無かったため、同じ spec を繰り返し採用し直すだけで同一テキストへの Review を何度でも引けた。
 * この repo では同一入力への判定が実行ごとに反転する実測がある
 * （ledger: `independent-review-verdict-instability`）ので、これは CONFLICT を偶然の ALIGNED で
 * 洗浄する経路になる。
 *
 * **判定器は #255 の既存 export をそのまま使う**（`collectRejectedSpecKeys()` /
 * `shortSpecKey()` / `isMateriallyDifferentSpec()`）。material-difference の定義は複製しない。
 *
 * 固定する invariant:
 *   1. 却下済みと review-visible に同一の提案は、**Design Review を起こす前に**拒否する
 *   2. AC だけ変えても「違う提案」にならない（reviewer は AC を見ない）
 *   3. scope / allowedPaths が正当に変われば通り、fresh Review が走る
 *   4. **却下歴の無い採用は1つも壊さない**（初回 / follow-up / ALIGNED 済み）
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from './initialImplementWorkflow'
import { adoptRoadmapItem } from './roadmapAdoption'
import { ensureInitialWorkflowsForActiveTasks } from './projectInitialization'

const LF = String.fromCharCode(10)
const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=conflicted-item state=planned -->',
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
].join(LF)

const CONFLICT_RESULT_JSON = JSON.stringify({
  focusedReviewResults: [
    { focus: 'scope_simplicity', decision: 'CONFLICT', summary: 'より軽い代替がある' },
  ],
})

const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED', summary: 'ok' }],
  integrationReviewResult: { decision: 'ALIGNED', summary: 'ok' },
  finalDecision: 'ALIGNED',
})

const ORIGINAL_SCOPE = '当初の広い scope'
const ORIGINAL_PATHS = ['apps/api/src', 'packages/shared/src']

let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'adoption-material-'))
  mkdirSync(join(ledgerRoot, 'tasks'), { recursive: true })
  writeFileSync(join(ledgerRoot, 'tasks', 'roadmap.md'), LEDGER, 'utf-8')
  previousTargetRoot = process.env.TARGET_ROOT
  process.env.TARGET_ROOT = ledgerRoot
})

afterAll(() => {
  if (previousTargetRoot === undefined) delete process.env.TARGET_ROOT
  else process.env.TARGET_ROOT = previousTargetRoot
  rmSync(ledgerRoot, { recursive: true, force: true })
})

function seedProject(): { storage: IStorage; projectId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  return { storage, projectId: project.id }
}

/** Job 生成（と、その内側の Design Review）を止めたまま採用する。 */
function silentDeps(counter?: { calls: number }) {
  return {
    ensureInitialWorkflows: async () => {
      if (counter) counter.calls += 1
      return []
    },
  }
}

/** 採用済み Task の現在 spec を、formal Design Review が CONFLICT で却下した状態にする。 */
function rejectCurrentSpec(storage: IStorage, taskId: string): void {
  const task = storage.tasks.findById(taskId)!
  const designText = buildInitialImplementAiCliPrompt(task)
  const run = storage.designReviewRuns.create({
    taskId, taskTitle: task.title, designText,
    designTextHash: computeDesignTextHash(designText), changedFiles: [],
  })
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(run.id, claimed.claimToken as string, 'succeeded', CONFLICT_RESULT_JSON)
}

async function adoptOriginal(storage: IStorage, projectId: string, counter?: { calls: number }) {
  return adoptRoadmapItem(storage, {
    projectId,
    roadmapId: 'conflicted-item',
    allowedPaths: ORIGINAL_PATHS,
    acceptanceCriteria: ['当初の受入条件'],
    implementationScope: ORIGINAL_SCOPE,
  }, silentDeps(counter))
}

describe('却下歴が無いうちは、既存の採用挙動を1つも変えない', () => {
  it('新規 Roadmap item の初回採用は通る', async () => {
    const { storage, projectId } = seedProject()

    const result = await adoptOriginal(storage, projectId)

    expect(result.ok).toBe(true)
  })

  it('却下歴が無ければ、同一内容の採用し直しも通る（resume / 再実行を壊さない）', async () => {
    const { storage, projectId } = seedProject()
    await adoptOriginal(storage, projectId)

    // Design Review をまだ一度も却下していないので guard は効かない。
    const again = await adoptOriginal(storage, projectId)

    expect(again.ok).toBe(true)
  })

  it('ALIGNED evidence が付いた Task の採用し直しも通る', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    const taskId = first.ok ? first.taskId : ''
    const task = storage.tasks.findById(taskId)!
    const designText = buildInitialImplementAiCliPrompt(task)
    const run = storage.designReviewRuns.create({
      taskId, taskTitle: task.title, designText,
      designTextHash: computeDesignTextHash(designText), changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.completeWithEvidence(run.id, claimed.claimToken as string, ALIGNED_STDOUT, {
      taskId,
      subjectId: taskId,
      reviewKind: 'task',
      decision: 'ALIGNED',
      reviewLoad: 'medium',
      independentReviewRequired: false,
      designTextHash: computeDesignTextHash(designText),
    } as never)

    const again = await adoptOriginal(storage, projectId)

    expect(again.ok).toBe(true)
  })
})

describe('却下済み spec の再提出は、Design Review を起こす前に拒否する', () => {
  it('**同一 spec の再採用を拒否する**', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')
    const counter = { calls: 0 }

    const again = await adoptRoadmapItem(storage, {
      projectId,
      roadmapId: 'conflicted-item',
      allowedPaths: ORIGINAL_PATHS,
      acceptanceCriteria: ['当初の受入条件'],
      implementationScope: ORIGINAL_SCOPE,
    }, silentDeps(counter))

    expect(again).toMatchObject({ ok: false, code: 'SPEC_NOT_MATERIALLY_DIFFERENT' })
    // **Review を起こす前に落ちている。**
    expect(counter.calls).toBe(0)
  })

  it('**AC だけ変えても拒否する**（reviewer は AC を見ない）', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')
    const counter = { calls: 0 }

    const again = await adoptRoadmapItem(storage, {
      projectId,
      roadmapId: 'conflicted-item',
      allowedPaths: ORIGINAL_PATHS,
      acceptanceCriteria: ['受入条件だけ書き換えた', 'もう1つ足した'],
      implementationScope: ORIGINAL_SCOPE,
    }, silentDeps(counter))

    expect(again).toMatchObject({ ok: false, code: 'SPEC_NOT_MATERIALLY_DIFFERENT' })
    expect(counter.calls).toBe(0)
  })

  it('空白・大小・allowedPaths の順序だけの違いも「同じ」と見る', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')

    const again = await adoptRoadmapItem(storage, {
      projectId,
      roadmapId: 'conflicted-item',
      allowedPaths: [...ORIGINAL_PATHS].reverse(),
      acceptanceCriteria: ['当初の受入条件'],
      implementationScope: `  ${ORIGINAL_SCOPE.toUpperCase()}  `,
    }, silentDeps())

    expect(again).toMatchObject({ ok: false, code: 'SPEC_NOT_MATERIALLY_DIFFERENT' })
  })

  it('allowedPaths を重複させただけの再提出も「同じ」と見る', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')

    const again = await adoptRoadmapItem(storage, {
      projectId, roadmapId: 'conflicted-item',
      // 許可範囲は同一。重複しているうえ、正規化して初めて等しくなる形も混ぜる。
      allowedPaths: [
        ...ORIGINAL_PATHS,
        ...ORIGINAL_PATHS.map((path) => ` ${path.toUpperCase()} `),
      ],
      acceptanceCriteria: ['当初の受入条件'],
      implementationScope: ORIGINAL_SCOPE,
    }, silentDeps())

    expect(again).toMatchObject({ ok: false, code: 'SPEC_NOT_MATERIALLY_DIFFERENT' })
  })

  it('**A → B → A の巡回も止める**（却下済み全件と比べる）', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    const taskId = first.ok ? first.taskId : ''
    rejectCurrentSpec(storage, taskId)

    // B へ訂正 → それも却下される。
    const b = await adoptRoadmapItem(storage, {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ['apps/api/src/storage'],
      acceptanceCriteria: ['c'],
      implementationScope: '別案 B',
    }, silentDeps())
    expect(b.ok).toBe(true)
    rejectCurrentSpec(storage, taskId)

    // A へ戻す。Task 上に A はもう無いが、却下履歴には残っている。
    const backToA = await adoptRoadmapItem(storage, {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ORIGINAL_PATHS,
      acceptanceCriteria: ['当初の受入条件'],
      implementationScope: ORIGINAL_SCOPE,
    }, silentDeps())

    expect(backToA).toMatchObject({ ok: false, code: 'SPEC_NOT_MATERIALLY_DIFFERENT' })
  })
})

describe('却下されていない案を、却下済みとして扱わない', () => {
  it('**採用が失敗した提案は却下履歴に残らない**（後でそのまま出し直せる）', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')

    // B を出すが、AC が空で validation に落ちる。
    const invalid = await adoptRoadmapItem(storage, {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ['apps/api/src/storage'],
      acceptanceCriteria: [],
      implementationScope: '別案 B',
    }, silentDeps())
    expect(invalid.ok).toBe(false)

    // AC を直して同じ B を出し直す。**B は一度も formal review に落とされていない。**
    const retried = await adoptRoadmapItem(storage, {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ['apps/api/src/storage'],
      acceptanceCriteria: ['直した受入条件'],
      implementationScope: '別案 B',
    }, silentDeps())

    expect(retried.ok).toBe(true)
  })

  it('**A を置き換えた直後の B は、まだ却下されていない**（review が流れても出し直せる）', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')

    // A → B。この時点で audit には A が、Task には B が入る。
    const b = {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ['apps/api/src/storage'],
      acceptanceCriteria: ['c'],
      implementationScope: '別案 B',
    }
    expect((await adoptRoadmapItem(storage, b, silentDeps())).ok).toBe(true)

    // B の review は走らなかった（UNAVAILABLE / 例外などで Job も作られていない）。
    // **B は一度も却下されていないので、そのまま出し直せなければならない。**
    const retryB = await adoptRoadmapItem(storage, b, silentDeps())

    expect(retryB.ok).toBe(true)
  })

  it('**未レビューの spec を、次の採用が却下済みとして記録しない**（A → B → C → B）', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')

    const b = {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ['apps/api/src/storage'], acceptanceCriteria: ['c'],
      implementationScope: '別案 B',
    }
    // A（却下済み）→ B。B の review は走らなかった。
    expect((await adoptRoadmapItem(storage, b, silentDeps())).ok).toBe(true)
    // B（未レビュー）→ C。ここで B を却下済みとして書いてはならない。
    expect((await adoptRoadmapItem(storage, {
      projectId, roadmapId: 'conflicted-item',
      allowedPaths: ['packages/shared/src'], acceptanceCriteria: ['c'],
      implementationScope: '別案 C',
    }, silentDeps())).ok).toBe(true)

    // B は一度も formal review に落とされていないので、戻れなければならない。
    expect((await adoptRoadmapItem(storage, b, silentDeps())).ok).toBe(true)
  })

  it('**後から出た CONFLICT を、古い ALIGNED evidence で無かったことにしない**', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    const taskId = first.ok ? first.taskId : ''
    const task = storage.tasks.findById(taskId)!
    const designText = buildInitialImplementAiCliPrompt(task)
    const hash = computeDesignTextHash(designText)

    // 同じテキストに対して、まず ALIGNED evidence が付いた。
    const alignedRun = storage.designReviewRuns.create({
      taskId, taskTitle: task.title, designText, designTextHash: hash, changedFiles: [],
    })
    const alignedClaim = storage.designReviewRuns.claim(alignedRun.id, 3)
    storage.designReviewRuns.completeWithEvidence(
      alignedRun.id, alignedClaim.claimToken as string, ALIGNED_STDOUT,
      {
        taskId, subjectId: taskId, reviewKind: 'task', decision: 'ALIGNED',
        reviewLoad: 'medium', independentReviewRequired: false, designTextHash: hash,
      } as never,
    )

    // その**後**、同じテキストの再実行が CONFLICT を返した（判定の揺れ）。
    rejectCurrentSpec(storage, taskId)

    const again = await adoptOriginal(storage, projectId)

    expect(again).toMatchObject({ ok: false, code: 'SPEC_NOT_MATERIALLY_DIFFERENT' })
  })
})

describe('ledger 本文の訂正は「違う提案」として通す（手順書の正規経路）', () => {
  it('**scope / allowedPaths が同じでも、ledger 本文を訂正したなら再レビューできる**', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    rejectCurrentSpec(storage, first.ok ? first.taskId : '')

    // CONFLICT の原因が ledger 本文の陳腐化だったので、本文だけを訂正する
    // （手順書 `human_recovery.md` 手順 2 の「Source of Truth 側の問題」）。
    writeFileSync(join(ledgerRoot, 'tasks', 'roadmap.md'), [
      '# Roadmap',
      '',
      '<!-- roadmap:id=conflicted-item state=planned -->',
      '1. [ ] **CONFLICT した項目** — 実仕様に合わせて本文を訂正した',
      '   訂正後の本文。reviewer が読む内容が変わっている。',
    ].join(LF), 'utf-8')

    // scope も allowedPaths も当初のまま。**それでも通らなければならない。**
    const corrected = await adoptOriginal(storage, projectId)

    expect(corrected.ok).toBe(true)
  })
})

describe('本当に違う提案は通り、fresh Design Review が走る', () => {
  it('scope と allowedPaths を訂正した提案は採用され、ALIGNED なら Job が作られる', async () => {
    const { storage, projectId } = seedProject()
    const first = await adoptOriginal(storage, projectId)
    const taskId = first.ok ? first.taskId : ''
    rejectCurrentSpec(storage, taskId)

    const corrected = await adoptRoadmapItem(storage, {
      projectId,
      roadmapId: 'conflicted-item',
      allowedPaths: ['apps/api/src/storage'],
      acceptanceCriteria: ['絶対パスを含む allowedPaths が拒否される'],
      implementationScope: '既存 validateRoadmapTasks の検査を1件足すだけ',
    }, {
      // 訂正版は本物の Job 生成経路へ流す（内側の Review だけ ALIGNED stub）。
      ensureInitialWorkflows: (st, pid) => ensureInitialWorkflowsForActiveTasks(st, pid, {
        runnerCommand: 'node', runnerArgs: [], homeDirectory: ledgerRoot, workingDir: ledgerRoot,
        execute: async () => ({ ok: true, stdout: ALIGNED_STDOUT, timedOut: false }),
      } as never),
    })

    expect(corrected.ok).toBe(true)
    // fresh Design Review が ALIGNED になり、実装 Job まで到達している。
    const evidence = storage.designReviewEvidence.findLatestByTaskId(taskId)
    expect(evidence?.decision).toBe('ALIGNED')
    expect(storage.jobs.findByTaskId(taskId)
      .filter((job) => job.workflowStepKey === `task:${taskId}:initial-implement`)).toHaveLength(1)
  })
})
