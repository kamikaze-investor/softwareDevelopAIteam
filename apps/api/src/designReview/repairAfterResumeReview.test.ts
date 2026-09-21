import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job, ReviewResult } from '@ai-team/shared'
import { prepareRepairFlow } from './repairFlow'

/**
 * **blocked な Task へ repair を作ってよい唯一のケース**の回帰テスト（CEO 指示・2026-09-21）。
 *
 * ## 何を守るか
 *
 * `resumeBlockedTask()` は Job を 1 件作るだけで Task status を変えない。だから resume で
 * 再開した実装が成功し、Independent Review が `changes_requested` を返しても Task は
 * `blocked` のままである。`prepareRepairFlow()` はそこを無条件 skip していたため、
 * **修正要求が repair にも escalate にもならず消えていた**
 * （2026-09-21 production: Task `c3849205` / review `026fe5a3`）。
 *
 * ここで固定するのは 2 つ。
 * 1. その 1 ケースだけが通ること
 * 2. **それ以外の blocked は従来どおり skip されること**。緩めた分が漏れないことのほうが重要で、
 *    通らないケースのテストを厚くしてある
 */

function seed(storage: IStorage, taskOverrides: Record<string, unknown> = {}) {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: 'd',
    status: 'blocked',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src/pl'],
    ...taskOverrides,
  } as never)
  return { taskId: task.id, projectId: project.id }
}

/** canonical resume successor として成功した implement Job。 */
function createResumedImplementJob(
  storage: IStorage,
  ids: { taskId: string, projectId: string },
  overrides: Record<string, unknown> = {},
): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'implement',
    aiCliProvider: 'claude_code',
    aiCliPrompt: 'resume prompt',
    workflowStepKey: 'resume:11111111-1111-1111-1111-111111111111:1',
    ...overrides,
  } as never)
  return storage.jobs.update(job.id, {
    status: 'success',
    exitCode: 0,
    changedFiles: ['apps/api/src/pl/executionLoop.ts'],
    ...overrides,
  } as never)!
}

/** その implement Job に紐づく review Job（terminal）。 */
function createReviewJob(
  storage: IStorage,
  ids: { taskId: string, projectId: string },
  implementJobId: string,
  stepKeyOverride?: string,
): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'reviewer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'review',
    aiCliProvider: 'claude_code',
    workflowStepKey: stepKeyOverride ?? `implement:${implementJobId}:review`,
  } as never)
  return storage.jobs.update(job.id, { status: 'failed', exitCode: 0 } as never)!
}

function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    id: 'review-1',
    taskId: 'task-1',
    jobId: 'job-1',
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: 'fix the two points',
    findings: [
      { severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', line: 1290, message: 'state transition widened' },
      { severity: 'medium', message: 'no verification evidence' },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ReviewResult
}

/** production で起きた形をそのまま組む。 */
function productionShape(storage: IStorage, taskOverrides: Record<string, unknown> = {}) {
  const ids = seed(storage, taskOverrides)
  const implementJob = createResumedImplementJob(storage, ids)
  const reviewJob = createReviewJob(storage, ids, implementJob.id)
  const review = reviewResult({ taskId: ids.taskId, jobId: reviewJob.id })
  return { ids, implementJob, reviewJob, review }
}

describe('blocked Task への repair — 通るケース', () => {
  it('resume で成功した実装への changes_requested は repair を作る', () => {
    const storage = createSQLiteStorage(':memory:')
    const { implementJob, review } = productionShape(storage)

    const result = prepareRepairFlow(storage, { failedJob: implementJob, review })

    expect(result.action).toBe('queue')
    if (result.action === 'queue') {
      expect(result.stepKey).toMatch(/^repair:/)
      expect(result.run.taskId).toBe(implementJob.taskId)
    }
  })
})

describe('blocked Task への repair — 通してはいけないケース', () => {
  // **ここが本体。** 緩めた例外から余計なものが漏れないことを 1 つずつ固定する。
  const skipped = (storage: IStorage, job: Job, review: ReviewResult | undefined) => {
    const result = prepareRepairFlow(storage, { failedJob: job, review })
    expect(result.action).toBe('skip')
    return result.action === 'skip' ? result.reason ?? '' : ''
  }

  it('ふつうの blocked Task（review 無し）は従来どおり skip', () => {
    const storage = createSQLiteStorage(':memory:')
    const { implementJob } = productionShape(storage)
    expect(skipped(storage, implementJob, undefined)).toContain('no review result')
  })

  it('done な Task は無条件 skip のまま', () => {
    const storage = createSQLiteStorage(':memory:')
    const { implementJob, review } = productionShape(storage, { status: 'done' })
    expect(skipped(storage, implementJob, review)).toBe('task is done')
  })

  it('実装が失敗している場合は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids, { status: 'failed', exitCode: 1 })
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = reviewResult({ taskId: ids.taskId, jobId: reviewJob.id })
    expect(skipped(storage, implementJob, review)).toContain('implementation job is failed')
  })

  it('review と実装の association が食い違う場合は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids)
    // 別の Job を指す stepKey を持つ review Job。
    const reviewJob = createReviewJob(storage, ids, implementJob.id, 'implement:someone-else:review')
    const review = reviewResult({ taskId: ids.taskId, jobId: reviewJob.id })
    expect(skipped(storage, implementJob, review)).toContain('not associated with this implementation job')
  })

  it('canonical resume successor でない実装は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids, {
      workflowStepKey: 'task:abc:initial-implement',
    })
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = reviewResult({ taskId: ids.taskId, jobId: reviewJob.id })
    expect(skipped(storage, implementJob, review)).toContain('not a canonical resume successor')
  })

  it('allowedPaths 外を指す finding があれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    const review = reviewResult({
      taskId: ids.taskId,
      jobId: reviewJob.id,
      findings: [{ severity: 'medium', file: 'apps/worker/src/index.ts', message: 'outside' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('outside allowedPaths')
  })

  it('critical finding は通常 repair で扱わない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    const review = reviewResult({
      taskId: ids.taskId,
      jobId: reviewJob.id,
      findings: [{ severity: 'critical', file: 'apps/api/src/pl/executionLoop.ts', message: 'authority' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('critical finding')
  })

  it('Design Review が CONFLICT なら別経路へ残す', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, review } = productionShape(storage)
    const run = storage.designReviewRuns.create({
      taskId: ids.taskId,
      taskTitle: 'T',
      designText: 'd',
      designTextHash: 'h',
      changedFiles: [],
    } as never)
    // claim -> complete が正規の終端経路。claim_token 一致時のみ結果を書ける。
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    expect(claimed.claimToken).toBeDefined()
    storage.designReviewRuns.complete(
      run.id, claimed.claimToken!, 'succeeded', JSON.stringify({ decision: 'CONFLICT' }),
    )
    expect(skipped(storage, implementJob, review)).toContain('CONFLICT')
  })

  it('live な Job があれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, review } = productionShape(storage)
    storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
    } as never)
    expect(skipped(storage, implementJob, review)).toContain('live job exists')
  })

  it('changes_requested 以外の verdict は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    const review = reviewResult({ taskId: ids.taskId, jobId: reviewJob.id, status: 'approved' } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('review status is approved')
  })
})
