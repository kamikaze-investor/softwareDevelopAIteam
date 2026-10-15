import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job } from '@ai-team/shared'
import { recomputeDecision } from './designReviewCoordinator'
import { executeQueuedRepair, prepareRepairFlow } from './repairFlow'

/**
 * **low-load の Design Review が API 側で正しい判定になること。**
 *
 * 2026-09-28 に実 recompute で実測した欠陥は 2 つあった:
 *
 *   - **成功した low-load review でも常に UNCERTAIN。** API は runner の `finalDecision`
 *     （自己申告）を読まず focus / integration から判定を組み直すが、low-load は focus を
 *     選ばず integration も載せていなかったので `resolveFinalDecision([], undefined)` が
 *     UNCERTAIN を返していた。docs-only の repair は一度も ALIGNED に届かなかった。
 *   - **実行できなかった review が `focus set mismatch` に化ける。** 本当の原因
 *     （prompt.md の ENOENT）が review ロジックの不整合に置き換わっていた。
 */

const DOCS_ONLY = ['docs/project_memory/decisions/vps-operations.md']
/** high load になる変更（期待 focus が scope_simplicity + strategic_alignment）。 */
const HIGH_FILES = ['apps/api/src/auth/credentials.ts']

const lowLoad = (extra: Record<string, unknown>) => ({
  reviewLoad: 'low',
  selectedFocuses: [],
  focusedReviewResults: [],
  ...extra,
})

describe('recomputeDecision: low-load（task kind）', () => {
  it('承認された low-load review は ALIGNED になる', () => {
    const outcome = recomputeDecision(lowLoad({
      integrationReviewResult: { decision: 'ALIGNED', summary: 'approved' },
      finalDecision: 'ALIGNED',
    }) as never, 'task', DOCS_ONLY)

    expect(outcome.decision).toBe('ALIGNED')
  })

  it('changes_requested の low-load review は CONFLICT になる', () => {
    const outcome = recomputeDecision(lowLoad({
      integrationReviewResult: { decision: 'CONFLICT', summary: 'fix it' },
      finalDecision: 'CONFLICT',
    }) as never, 'task', DOCS_ONLY)

    expect(outcome.decision).toBe('CONFLICT')
  })

  it('実行できなかった review は REVIEW_UNAVAILABLE になり、本当の理由が残る', () => {
    const outcome = recomputeDecision(lowLoad({
      finalDecision: 'REVIEW_UNAVAILABLE',
      unavailableReason: "Low-load legacy Meta Review could not complete: ENOENT: no such file or directory, open '/workspace/control/docs/meta_reviewer/prompt.md'",
    }) as never, 'task', DOCS_ONLY)

    expect(outcome.decision).toBe('REVIEW_UNAVAILABLE')
    expect(outcome.rejectedReason).toContain('ENOENT')
    expect(outcome.rejectedReason).not.toContain('focus set mismatch')
  })

  it('旧 runner の形（架空の strategic_alignment 付き）でも focus set mismatch にならない', () => {
    // 修正版 Worker の deploy 前後で旧 runner の結果が届いても、原因を取り違えない。
    const outcome = recomputeDecision(lowLoad({
      finalDecision: 'REVIEW_UNAVAILABLE',
      focusedReviewResults: [{ focus: 'strategic_alignment', decision: 'UNCERTAIN', summary: 'x', findings: [] }],
    }) as never, 'task', DOCS_ONLY)

    expect(outcome.decision).toBe('REVIEW_UNAVAILABLE')
    expect(outcome.rejectedReason ?? '').not.toContain('focus set mismatch')
  })

  it('構造化された判定が無い自己申告の ALIGNED は、従来どおり ALIGNED にしない（fail-open 防止）', () => {
    const outcome = recomputeDecision(lowLoad({ finalDecision: 'ALIGNED' }) as never, 'task', DOCS_ONLY)

    expect(outcome.decision).not.toBe('ALIGNED')
  })
})

describe('recomputeDecision: 既存経路の regression', () => {
  it('T5 medium の focused review は従来どおり判定される', () => {
    const outcome = recomputeDecision({
      reviewLoad: 'medium',
      selectedFocuses: ['scope_simplicity'],
      focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED', summary: 'ok', findings: [] }],
      finalDecision: 'ALIGNED',
    } as never, 'task', ['apps/api/src/pl/executionLoop.ts'])

    expect(outcome.decision).toBe('ALIGNED')
  })

  it('T5 medium の focus 集合が合わなければ従来どおり弾く（検査を緩めていない）', () => {
    const outcome = recomputeDecision({
      reviewLoad: 'medium',
      selectedFocuses: ['operations'],
      focusedReviewResults: [{ focus: 'operations', decision: 'ALIGNED', summary: 'ok', findings: [] }],
      finalDecision: 'ALIGNED',
    } as never, 'task', ['apps/api/src/pl/executionLoop.ts'])

    expect(outcome.decision).toBe('UNCERTAIN')
    expect(outcome.rejectedReason).toContain('focus set mismatch')
  })

  it('T5 high で一部 focus が CONFLICT・一部が unavailable なら、従来どおり CONFLICT のまま', () => {
    // runner は focus が落ちても残りを実行し続けるので、この組み合わせは実際に起こる。
    // REVIEW_UNAVAILABLE に置き換えると、CONFLICT だけを対象にする remediation が動かなくなる。
    const outcome = recomputeDecision({
      reviewLoad: 'high',
      selectedFocuses: ['scope_simplicity', 'strategic_alignment'],
      focusedReviewResults: [
        { focus: 'scope_simplicity', decision: 'CONFLICT', summary: 'scope creep', findings: [] },
        { focus: 'strategic_alignment', decision: 'UNCERTAIN', summary: 'provider down', findings: [] },
      ],
      finalDecision: 'REVIEW_UNAVAILABLE',
      unavailableReason: 'provider down',
    } as never, 'task', HIGH_FILES)

    expect(outcome.reviewLoad).toBe('high')
    expect(outcome.decision).toBe('CONFLICT')
  })

  it('roadmap kind の REVIEW_UNAVAILABLE は本修正の対象外で、挙動が変わらない', () => {
    const outcome = recomputeDecision({
      reviewLoad: 'critical',
      selectedFocuses: [],
      focusedReviewResults: [],
      finalDecision: 'REVIEW_UNAVAILABLE',
      unavailableReason: 'integration unavailable',
    } as never, 'roadmap', [])

    // roadmap は integration review 必須のまま（早期 return で素通りさせない）。
    expect(outcome.decision).toBe('UNCERTAIN')
    expect(outcome.rejectedReason ?? '').not.toContain('review unavailable:')
  })
})

// --- T6: production 形の docs-only repair --------------------------------------------------

function seed(storage: IStorage): { taskId: string; projectId: string } {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  } as never)
  const task = storage.tasks.create({
    projectId: project.id, title: 'VPS docs', description: 'd',
    status: 'in_progress', assignee: 'developer_ai', dependencies: [],
  } as never)
  return { taskId: task.id, projectId: project.id }
}

/** docs だけを変更して失敗した implement Job（= repair の review が low-load になる形）。 */
function failedDocsJob(storage: IStorage, ids: { taskId: string; projectId: string }): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId, projectId: ids.projectId, agentRole: 'developer_ai', status: 'queued',
    safeCommand: { kind: 'noop' }, aiCliMode: 'implement',
    aiCliProvider: 'claude_code', aiCliPrompt: 'original prompt',
  } as never)
  return storage.jobs.update(job.id, {
    status: 'failed', exitCode: 1, stderr: 'TypeError: boom', changedFiles: DOCS_ONLY,
  } as never)!
}

function depsReturning(stdout: string) {
  return {
    runnerCommand: 'node', runnerArgs: [], homeDirectory: '/tmp', workingDir: '/tmp',
    execute: async () => ({ ok: true, stdout, timedOut: false }),
  }
}

describe('T6 production 形の docs-only repair Design Review', () => {
  it('修正版 runner の承認結果で repair Job まで届く', async () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const preparation = prepareRepairFlow(storage, { failedJob: failedDocsJob(storage, ids) })
    if (preparation.action !== 'queue') throw new Error('fixture failed')
    expect(preparation.run.changedFiles).toEqual(DOCS_ONLY)
    const run = storage.designReviewRuns.create(preparation.run)

    const outcome = await executeQueuedRepair(storage, run, preparation.stepKey, depsReturning(JSON.stringify(lowLoad({
      reviewKind: 'task',
      integrationReviewResult: { decision: 'ALIGNED', summary: 'legacy review said approved' },
      finalDecision: 'ALIGNED',
    }))) as never)

    expect(outcome.status).toBe('repair_job_created')
    expect(storage.tasks.findById(ids.taskId)?.status).not.toBe('blocked')
  })

  it('review を実行できなかった場合は escalation し、run.error に本当の原因が残る', async () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const preparation = prepareRepairFlow(storage, { failedJob: failedDocsJob(storage, ids) })
    if (preparation.action !== 'queue') throw new Error('fixture failed')
    const run = storage.designReviewRuns.create(preparation.run)

    const outcome = await executeQueuedRepair(storage, run, preparation.stepKey, depsReturning(JSON.stringify(lowLoad({
      reviewKind: 'task',
      finalDecision: 'REVIEW_UNAVAILABLE',
      unavailableReason: "Low-load legacy Meta Review could not complete: ENOENT: no such file or directory, open '/workspace/control/docs/meta_reviewer/prompt.md'",
    }))) as never)

    // 実行できなかった review から repair を作らない（fail-closed は維持）。
    expect(outcome.status).toBe('escalated')
    if (outcome.status === 'escalated') expect(outcome.reason).toContain('REVIEW_UNAVAILABLE')
    expect(storage.jobs.findByTaskId(ids.taskId).some((job) => job.workflowStepKey === preparation.stepKey)).toBe(false)
    // **原因が durable に残る。** 以前はここに focus set mismatch が入っていた。
    const stored = storage.designReviewRuns.findById(run.id)!
    expect(stored.error).toContain('ENOENT')
    expect(stored.error).not.toContain('focus set mismatch')
  })
})
