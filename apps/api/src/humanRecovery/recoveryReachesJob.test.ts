/**
 * **Human Recovery が「pending にして終わり」にならないことの検証。**
 *
 * `blocked` → `pending` だけを見て復旧成立と誤認しないために、
 * production の形（continuation 経由の CONFLICT）から **実装 Job が実際に作られる**ところまで
 * 1本のテストで通す:
 *
 * ```text
 * blocked + Job 0 件（CONFLICT 済み）
 *   → [現状] どの自動経路からも届かない
 *   → POST /api/tasks/:id/recover
 *   → pending
 *   → 既存 PL loop（runPlTick）
 *   → #255 staged recovery（Critic → PL revision）
 *   → applyRevisedSpec() → adoptRoadmapItem()
 *   → fresh Design Review（ALIGNED）
 *   → initial implement Job
 * ```
 *
 * 差し替えるのは **provider CLI 実行だけ**（Critic / PL revision / Design Review の外部呼び出し）。
 * 判定・Gate・採用・Job 生成はすべて本物を通す。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import {
  buildInitialImplementAiCliPrompt,
} from '../ctoAi/initialImplementWorkflow'
import { adoptRoadmapItem, buildAdoptedDescription } from '../ctoAi/roadmapAdoption'
import { ensureInitialWorkflowsForActiveTasks } from '../ctoAi/projectInitialization'
import { runPlTick, type PlLoopDeps } from '../pl/executionLoop'
import { DEFAULT_STALL_HINT_MS } from '../state/systemState'
import { recoverBlockedTask } from './recoverBlockedTask'

const LF = String.fromCharCode(10)
const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=conflicted-item state=planned -->',
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
].join(LF)

const LEDGER_BODY = [
  '1. [ ] **CONFLICT した項目** — より軽い代替があると指摘された',
  '   本文はここに続く。',
].join(LF)

const CONFLICT_RESULT_JSON = JSON.stringify({
  focusedReviewResults: [
    { focus: 'scope_simplicity', decision: 'CONFLICT', summary: 'より軽い代替がある' },
  ],
  finalDecision: 'CONFLICT',
})

/**
 * fresh Design Review の ALIGNED 出力。
 *
 * **focus は省略できない。** `recomputeDecision()` は期待 focus 集合との一致を構造検証しており
 * （不一致は fail-closed で UNCERTAIN）、`scope_simplicity` は medium load の既定 focus である。
 * 空の `focusedReviewResults` を返すと `fresh_review_not_aligned` になり、Job は作られない。
 */
const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED', summary: 'ok' }],
  integrationReviewResult: { decision: 'ALIGNED', summary: 'ok' },
  finalDecision: 'ALIGNED',
})

const CRITIQUE = {
  coreProblems: ['採用時の scope が ledger 本文全体を指している'],
  hiddenRisks: [],
  constraintsToPreserve: ['File Change Guard の保護範囲'],
  improvementDirections: ['既存 validation へ1件足す形に絞る'],
  thingsNotToChange: ['ledger 本文'],
  uncertainties: [],
  findingAssessments: [
    { source: 'scope_simplicity', status: 'supported', rationale: 'より軽い代替が実在する' },
  ],
}

const PL_REVISION = {
  implementationScope: '既存 validateRoadmapTasks の検査を1件足すだけ',
  allowedPaths: ['apps/api/src/storage'],
  acceptanceCriteria: ['絶対パスを含む allowedPaths が拒否される'],
  rationale: 'scope を1件へ絞った',
  respondsTo: 'scope_simplicity の指摘どおり新しい層を作らない',
}

let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'human-recovery-e2e-'))
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

/**
 * production の形をそのまま作る: `failContinuation()` が非 retryable な skip
 * （Design Review 非 ALIGNED）で Task を blocked にした直後の状態。
 */
function seedBlockedAfterConflict(): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'スマホだけでAI開発チームを運営できる', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'CONFLICT した項目',
    description: buildAdoptedDescription(LEDGER_BODY, '当初の広い scope'),
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src', 'packages/shared/src'],
    acceptanceCriteria: ['当初の受入条件'],
    roadmapTaskKey: 'conflicted-item',
    phase: 1,
    roadmapActive: true,
  } as Parameters<IStorage['tasks']['create']>[0])

  const designText = buildInitialImplementAiCliPrompt(task)
  const run = storage.designReviewRuns.create({
    taskId: task.id,
    taskTitle: task.title,
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [],
  })
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id, claimed.claimToken as string, 'succeeded', CONFLICT_RESULT_JSON,
  )

  // `failContinuation()` と同じ遷移。Job は1件も作られない。
  storage.tasks.update(task.id, { status: 'blocked' })
  return { storage, taskId: task.id }
}

/** provider CLI 実行だけを差し替える。判定・Gate・採用・Job 生成は本物。 */
function alignedCoordinatorDeps() {
  return {
    runnerCommand: 'node',
    runnerArgs: [] as string[],
    homeDirectory: ledgerRoot,
    workingDir: ledgerRoot,
    execute: async () => ({ ok: true as const, stdout: ALIGNED_STDOUT, timedOut: false }),
  }
}

/**
 * 再投入した Task を PL が拾える時刻。
 *
 * `task_ready_without_job` は既存 `DEFAULT_STALL_HINT_MS`（5分）を過ぎたものだけを対象にする
 * （採用直後に必ず一度立つため、即時に鳴らすと誤報になる）。テストで作る Task は
 * `createdAt` が今なので、その閾値を越えた時刻から観測する。**実運用で止まっている Task は
 * `createdAt` が十分古いので、再投入の次の tick で即座に対象になる。**
 */
function afterStallThreshold(): string {
  return new Date(Date.now() + DEFAULT_STALL_HINT_MS + 60_000).toISOString()
}

function plDeps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
  return {
    now: afterStallThreshold,
    escalate: async () => {},
    readLedger: () => LEDGER,
    diagnose: async () => { throw new Error('CONFLICT 解決経路では diagnose を呼ばない') },
    proposeAdoption: async () => { throw new Error('attention が残るうちは採用しない') },
    conflictDeps: {
      readLedger: () => LEDGER,
      runnerDeps: {
        runnerCommand: 'noop',
        runnerArgs: [],
        homeDirectory: ledgerRoot,
        workingDir: ledgerRoot,
        execute: async () => ({ ok: true, stdout: JSON.stringify(CRITIQUE), timedOut: false }),
      },
      revise: async () => JSON.stringify(PL_REVISION),
      // **本物の採用を通す。** ただし内側の fresh Design Review は ALIGNED を返す stub にする。
      adopt: (async (s: IStorage, input: Parameters<typeof adoptRoadmapItem>[1]) =>
        adoptRoadmapItem(s, input, {
          ensureInitialWorkflows: (st, pid) =>
            ensureInitialWorkflowsForActiveTasks(st, pid, alignedCoordinatorDeps() as never),
        })) as never,
    } as never,
    ...over,
  }
}

function initialJobs(storage: IStorage, taskId: string) {
  return storage.jobs.findByTaskId(taskId)
    .filter((job) => job.workflowStepKey === `task:${taskId}:initial-implement`)
}

describe('blocked + Job 0 件は、まず本当に手詰まりである', () => {
  it('PL tick は #255 の Remediation へ入れず、CEO へ上げて終わる', async () => {
    const { storage, taskId } = seedBlockedAfterConflict()
    const sent: Array<{ title: string; body: string }> = []

    const result = await runPlTick(storage, plDeps({
      escalate: async (p) => { sent.push(p) },
      // Remediation/解決 Round が走ったら失敗させる（届かないことを固定する）。
      resolveConflict: async () => { throw new Error('blocked な Task へ解決 Round が走ってはならない') },
    }))

    expect(result.status).toBe('escalated')
    expect(result.target?.kind).toBe('task_blocked_without_job')
    // Triage は「試したが駄目」ではなく「そもそも届かない」と報告する。
    expect(sent[0].body).toContain('一度も実行できていません')
    expect(sent[0].body).toContain('/recover')
    expect(initialJobs(storage, taskId)).toHaveLength(0)
  })
})

describe('Human Recovery は pending で止まらず、実装 Job まで到達する', () => {
  it('recover → PL loop → #255 → applyRevisedSpec → fresh Review → initial Job', async () => {
    const { storage, taskId } = seedBlockedAfterConflict()

    // ── 1. 人の明示操作で再投入する ──
    const recovered = recoverBlockedTask(storage, { taskId, reason: 'CONFLICT を確認したので再投入' })
    expect(recovered).toMatchObject({ ok: true, nextDriver: 'pl_independent_remediation' })
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
    expect(initialJobs(storage, taskId)).toHaveLength(0)

    // ── 2. 既存 PL loop がそのまま引き取る（新しい driver を足していない）──
    const result = await runPlTick(storage, plDeps())

    // ── 3. 実装 Job が実際に作られている ──
    expect(result.status).toBe('acted')
    const jobs = initialJobs(storage, taskId)
    expect(jobs).toHaveLength(1)

    // ── 4. Job は fresh Design Review の ALIGNED evidence に裏付けられている ──
    const evidence = storage.designReviewEvidence.findLatestByTaskId(taskId)
    expect(evidence?.decision).toBe('ALIGNED')
    expect(evidence?.designTextHash).toBe(computeDesignTextHash(jobs[0].aiCliPrompt as string))

    // ── 5. 訂正後の scope が Task に入っている（元の広い scope のままではない）──
    expect(storage.tasks.findById(taskId)?.allowedPaths).toEqual(PL_REVISION.allowedPaths)
  })

  it('**notify-only で再停止しない。** 再投入後の tick は通知ではなく実行になる', async () => {
    const { storage, taskId } = seedBlockedAfterConflict()
    recoverBlockedTask(storage, { taskId, reason: 'r' })
    let escalations = 0

    const result = await runPlTick(storage, plDeps({
      escalate: async () => { escalations += 1 },
    }))

    expect(result.status).not.toBe('escalated')
    expect(escalations).toBe(0)
  })
})
