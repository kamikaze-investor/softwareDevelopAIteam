import { describe, expect, it } from 'vitest'
import type { Project, Task } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { buildInitialImplementAiCliPrompt, initialWorkflowStepKey } from '../ctoAi/initialImplementWorkflow'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { CONTINUATION_LIVE_RUN_BOUND_MS, CONTINUATION_SETTLEMENT_GRACE_MS, evaluateContinuationProgress, reportContinuationProgress } from './continuationProgress'
import { buildSystemState, DEFAULT_STALL_HINT_MS } from './systemState'
import { resetPlLoopInFlightForTest, runPlTick } from '../pl/executionLoop'

const MIN = 60_000

interface Seeded {
  storage: IStorage
  project: Project
  next: Task
  continuationId: string
}

/** 完了した Task → 次 Task の pending continuation（正常系で Worker が 503 を受ける形）。 */
function seed(): Seeded {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' })
  const base = {
    projectId: project.id,
    description: 'Implement it.',
    assignee: 'developer_ai' as const,
    dependencies: [] as string[],
    roadmapActive: true,
  }
  const done = storage.tasks.create({ ...base, title: 'done task', status: 'pending' } as Parameters<IStorage['tasks']['create']>[0])
  const next = storage.tasks.create({ ...base, title: 'next task', status: 'pending', dependencies: [] } as Parameters<IStorage['tasks']['create']>[0])
  const sourceJob = storage.jobs.create({
    taskId: done.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
    safeCommand: { kind: 'git_commit', workingDir: '/workspace/target' },
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.tasks.update(done.id, { status: 'done' })
  const continuation = storage.taskContinuations.create({
    sourceJobId: sourceJob.id, projectId: project.id, completedTaskId: done.id, nextTaskId: next.id, status: 'pending',
  })
  return { storage, project: storage.projects.findById(project.id) as Project, next, continuationId: continuation.id }
}

function progressAt(s: Seeded, nowMs: number) {
  const continuation = s.storage.taskContinuations.findById(s.continuationId)
  if (!continuation) throw new Error('continuation missing')
  return evaluateContinuationProgress(s.storage, continuation, s.storage.projects.findById(s.project.id) as Project, nowMs)
}

function startedAt(s: Seeded): number {
  const continuation = s.storage.taskContinuations.findById(s.continuationId)
  return Date.parse(continuation?.createdAt ?? '')
}

function createCanonicalRun(s: Seeded, overrides: { designText?: string; changedFiles?: string[] } = {}) {
  const designText = overrides.designText ?? buildInitialImplementAiCliPrompt(s.next)
  return s.storage.designReviewRuns.create({
    taskId: s.next.id,
    taskTitle: s.next.title,
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: overrides.changedFiles ?? [],
  })
}

describe('evaluateContinuationProgress — 503 ではなく実際の遷移で前進を判定する', () => {
  it('canonical review も Job も無ければ、起点からの時間がそのまま「前進なし」になる', () => {
    const s = seed()
    const t0 = startedAt(s)

    expect(progressAt(s, t0 + MIN).stuckForMs).toBe(MIN)
    expect(progressAt(s, t0 + 6 * MIN).stuckForMs).toBe(6 * MIN)
    expect(progressAt(s, t0 + 6 * MIN).detail).toContain('no canonical initial design review run')
  })

  it('canonical review が claim されて runner 期限内で走っていれば前進中（0）', () => {
    const s = seed()
    const run = createCanonicalRun(s)
    s.storage.designReviewRuns.claim(run.id, 3)
    const claimedAt = Date.parse(s.storage.designReviewRuns.findById(run.id)?.startedAt ?? '')

    expect(progressAt(s, claimedAt + 4 * MIN).stuckForMs).toBe(0)
  })

  it('claim が runner 期限を超えて running のまま（hung）なら前進ではない', () => {
    const s = seed()
    const run = createCanonicalRun(s)
    s.storage.designReviewRuns.claim(run.id, 3)
    const claimedAt = Date.parse(s.storage.designReviewRuns.findById(run.id)?.startedAt ?? '')

    const late = progressAt(s, claimedAt + CONTINUATION_LIVE_RUN_BOUND_MS + 1)
    expect(late.stuckForMs).toBeGreaterThanOrEqual(DEFAULT_STALL_HINT_MS)
  })

  it('canonical でない review（別の design text・changedFiles あり）は前進とみなさず、事実として載せる', () => {
    const s = seed()
    const other = createCanonicalRun(s, { designText: 'a repair prompt', changedFiles: ['apps/x.ts'] })
    s.storage.designReviewRuns.claim(other.id, 3)
    const t0 = startedAt(s)

    const result = progressAt(s, t0 + 6 * MIN)
    expect(result.stuckForMs).toBeGreaterThanOrEqual(DEFAULT_STALL_HINT_MS)
    expect(result.detail).toContain('non-canonical design review run')
  })

  it('retry cooldown は実行が無い状態なので前進ではない（最後の動きから数える）', () => {
    const s = seed()
    const run = createCanonicalRun(s)
    const claim = s.storage.designReviewRuns.claim(run.id, 3)
    s.storage.designReviewRuns.requeue(run.id, claim.claimToken as string, 'provider timeout')
    const last = s.storage.designReviewRuns.findById(run.id)
    // requeue は started_at を消す。読める時刻だけの最大（実装と同じ数え方）。
    const lastMs = Math.max(...[last?.startedAt, last?.completedAt, last?.createdAt]
      .map((value) => Date.parse(value ?? ''))
      .filter((value) => Number.isFinite(value)))

    expect(progressAt(s, lastMs + 6 * MIN).stuckForMs).toBeGreaterThanOrEqual(DEFAULT_STALL_HINT_MS)
  })

  it('初回 Job ができていれば settlement の猶予内は前進中、猶予を過ぎても pending なら停滞', () => {
    const s = seed()
    const job = s.storage.jobs.create({
      taskId: s.next.id, projectId: s.project.id, agentRole: 'developer_ai', status: 'queued',
      workflowStepKey: initialWorkflowStepKey(s.next.id), aiCliMode: 'implement',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    const jobMs = Date.parse(job.createdAt)

    expect(progressAt(s, jobMs + CONTINUATION_SETTLEMENT_GRACE_MS - 1).stuckForMs).toBe(0)
    expect(progressAt(s, jobMs + CONTINUATION_SETTLEMENT_GRACE_MS + 6 * MIN).stuckForMs).toBe(6 * MIN)
    expect(progressAt(s, jobMs + CONTINUATION_SETTLEMENT_GRACE_MS + MIN).detail).toContain('has not settled')
  })

  it('Project の名前変更などの書き込みは前進ではなく、停滞の時計を戻さない', () => {
    const s = seed()
    const t0 = startedAt(s)
    s.storage.projects.update(s.project.id, { name: 'renamed' })

    expect(progressAt(s, t0 + 6 * MIN).stuckForMs).toBe(6 * MIN)
  })

  it('Project が running でない（CEO の pause）間は停滞に数えない', () => {
    const s = seed()
    s.storage.projects.update(s.project.id, { status: 'paused' })

    expect(progressAt(s, Date.now() + 60 * MIN).stuckForMs).toBe(0)
  })
})

describe('systemState — continuation の対象 Task は汎用 task_ready_without_job ではなく continuation_pending で扱う', () => {
  it('continuation 1件につき1件、referenceId と taskId と「前進なしの時間」を載せる', () => {
    const s = seed()
    const nowIso = new Date(startedAt(s) + 6 * MIN).toISOString()

    const state = buildSystemState(s.storage, { now: () => nowIso })
    const kinds = state.attention.filter((item) => item.taskId === s.next.id || item.kind === 'continuation_pending')

    expect(kinds.map((item) => item.kind)).toEqual(['continuation_pending'])
    expect(kinds[0]).toMatchObject({ referenceId: s.continuationId, taskId: s.next.id, stuckForMs: 6 * MIN })
  })
})

describe('PL — 停滞した continuation は1回だけ通知し、前進中は通知しない', () => {
  async function tick(s: Seeded, nowMs: number, notified: string[]): Promise<void> {
    resetPlLoopInFlightForTest()
    await runPlTick(s.storage, {
      now: () => new Date(nowMs).toISOString(),
      escalate: async (payload) => { notified.push(payload.title) },
      diagnose: async () => { throw new Error('notify-only attention must not be diagnosed') },
      readLedger: () => '',
    })
  }

  it('前進が無いまま 5 分を超えたら1回だけ通知する', async () => {
    const s = seed()
    const notified: string[] = []
    const t0 = startedAt(s)

    await tick(s, t0 + 4 * MIN, notified)
    expect(notified).toHaveLength(0)
    await tick(s, t0 + 6 * MIN, notified)
    await tick(s, t0 + 7 * MIN, notified)
    expect(notified).toHaveLength(1)
  })

  it('canonical review が走っている間は 5 分を超えても通知しない', async () => {
    const s = seed()
    const run = createCanonicalRun(s)
    s.storage.designReviewRuns.claim(run.id, 3)
    const claimedAt = Date.parse(s.storage.designReviewRuns.findById(run.id)?.startedAt ?? '')
    const notified: string[] = []

    await tick(s, claimedAt + 4 * MIN, notified)

    expect(notified).toHaveLength(0)
  })
})

describe('reportContinuationProgress — 1件の評価失敗で報告全体を消さない', () => {
  it('評価できない continuation は作成からの経過を「前進なし」として報告し、他の行も残す', async () => {

    const s = seed()
    const original = s.storage.designReviewRuns.findByTaskId.bind(s.storage.designReviewRuns)
    s.storage.designReviewRuns.findByTaskId = (() => { throw new Error('poisoned row') }) as typeof original
    const t0 = startedAt(s)

    const reports = reportContinuationProgress(s.storage, t0 + 12 * MIN)

    expect(reports).toEqual([expect.objectContaining({ continuationId: s.continuationId, stuckForMs: 12 * MIN })])
  })
})
