import { describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job, ReviewResult } from '@ai-team/shared'
import { repairFromStoredReview } from './repairFromStoredReview'
import { epochCoveredImplementationJobIds, repairRecoveryActionFor } from './repairRecoveryEpoch'

/**
 * **保存済み review を canonical repair へ戻す recovery action**の回帰テスト
 * （CEO 指示・2026-09-22）。
 *
 * 形は production `c3849205` をそのまま使う: 初回 implement からの chain で repair を
 * 3回使い切り、その後 resume 経由で実装が成功し、その成果へ `changes_requested` が
 * 保存されている。review の PATCH イベントは過去に消費済みで、もう発火しない。
 *
 * 通す条件より**通さない条件**のほうを厚くしてある。budget は自律実行の安全境界なので、
 * 漏れる側の代償が大きい。
 */

const IN_SCOPE = 'apps/api/src/pl/executionLoop.ts'

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

function makeJob(
  storage: IStorage,
  ids: { taskId: string, projectId: string },
  workflowStepKey: string | undefined,
  finalStatus: string,
  extra: Record<string, unknown> = {},
): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'implement',
    aiCliProvider: 'claude_code',
    workflowStepKey,
  } as never)
  return storage.jobs.update(job.id, {
    status: finalStatus,
    exitCode: finalStatus === 'success' ? 0 : 1,
    changedFiles: [IN_SCOPE],
    ...extra,
  } as never)!
}

/**
 * `c3849205` と同じ lineage を組む。
 * initial → repair×3（使い切り） → resume → resume（成功）。
 */
function exhaustedChainThenResume(storage: IStorage, ids: { taskId: string, projectId: string }) {
  const root = makeJob(storage, ids, `task:${ids.taskId}:initial-implement`, 'failed')
  let parent = root
  for (let i = 0; i < 3; i += 1) {
    parent = makeJob(storage, ids, `repair:${parent.id}:1`, 'failed')
  }
  const resumed = makeJob(storage, ids, `resume:${parent.id}:1`, 'failed')
  const current = makeJob(storage, ids, `resume:${resumed.id}:1`, 'success')
  return { root, current }
}

function createReviewJob(storage: IStorage, ids: { taskId: string, projectId: string }, implementJobId: string): Job {
  const job = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'reviewer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'review',
    aiCliProvider: 'claude_code',
    workflowStepKey: `implement:${implementJobId}:review`,
  } as never)
  return storage.jobs.update(job.id, { status: 'failed', exitCode: 0 } as never)!
}

function storeReview(
  storage: IStorage,
  ids: { taskId: string },
  reviewJobId: string,
  overrides: Partial<ReviewResult> = {},
): ReviewResult {
  return storage.reviewResults.create({
    taskId: ids.taskId,
    jobId: reviewJobId,
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: 'fix two things',
    findings: [{ severity: 'medium', file: IN_SCOPE, message: 'state transition widened' }],
    ...overrides,
  } as never)
}

/** production と同じ形をひと揃い組む。 */
function productionShape(storage: IStorage, taskOverrides: Record<string, unknown> = {}) {
  const ids = seed(storage, taskOverrides)
  const { current } = exhaustedChainThenResume(storage, ids)
  const reviewJob = createReviewJob(storage, ids, current.id)
  const review = storeReview(storage, ids, reviewJob.id)
  return { ids, implementJob: current, reviewJob, review }
}

/** 人が Mobile の承認 UI で押す操作に相当する。 */
function approve(storage: IStorage, approvalRequestId: string) {
  return storage.approvalRequests.recordDecision(approvalRequestId, 'APPROVED')
}

const call = (storage: IStorage, taskId: string, reviewJobId: string) =>
  repairFromStoredReview(storage, { taskId, reviewJobId }, { kick: () => {} })

describe('recovery action — 承認を経て canonical repair へ戻る', () => {
  it('1回目は承認待ちを作り、承認後の2回目で repair を queue する', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)

    const first = call(storage, ids.taskId, reviewJob.id)
    expect(first.status).toBe('awaiting_approval')
    if (first.status !== 'awaiting_approval') return
    expect(first.reused).toBe(false)
    expect(first.requestedAction).toBe(repairRecoveryActionFor(reviewJob.id))
    // 承認前に repair も run も作らない。
    // `findByTaskId` はこの store に存在しない。以前ここを optional chaining で書いていて、
    // **常に 0 になり何も確かめていなかった**。存在する reader で見る。
    expect(storage.designReviewRuns.findLatestByTaskId(ids.taskId)).toBeUndefined()

    approve(storage, first.approvalRequestId)

    const second = call(storage, ids.taskId, reviewJob.id)
    expect(second.status).toBe('queued')
    if (second.status !== 'queued') return
    expect(second.stepKey).toBe(`repair:${implementJob.id}:1`)

    // 承認は使い切られている。
    expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('CONSUMED')
  })

  it('承認前に何度呼んでも承認リクエストを増やさない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)

    const first = call(storage, ids.taskId, reviewJob.id)
    const second = call(storage, ids.taskId, reviewJob.id)
    expect(first.status).toBe('awaiting_approval')
    expect(second.status).toBe('awaiting_approval')
    if (first.status !== 'awaiting_approval' || second.status !== 'awaiting_approval') return

    expect(second.approvalRequestId).toBe(first.approvalRequestId)
    expect(second.reused).toBe(true)
    expect(
      storage.approvalRequests.findByTaskId(ids.taskId)
        .filter((r) => r.requestedAction === repairRecoveryActionFor(reviewJob.id)).length,
    ).toBe(1)
  })

  it('queue 後にもう一度呼んでも run を二重に作らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)

    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)
    expect(call(storage, ids.taskId, reviewJob.id).status).toBe('queued')

    const third = call(storage, ids.taskId, reviewJob.id)
    expect(third.status).toBe('skipped')
    expect(storage.designReviewRuns.findActiveByTaskId(ids.taskId)).toBeDefined()
  })

  // **同じ承認は二度使えない。** 既存の CAS（APPROVED → CONSUMED）がそのまま効く。
  it('同じ承認を2回 consume できない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)

    const args = {
      taskId: ids.taskId,
      approvalRequestId: first.approvalRequestId,
      expectedAction: repairRecoveryActionFor(reviewJob.id),
    }
    expect(storage.approvalRequests.verifyAndConsumeForTaskAction(args).ok).toBe(true)
    expect(storage.approvalRequests.verifyAndConsumeForTaskAction(args).ok).toBe(false)
  })
})

describe('epoch は consume ではじめて開く', () => {
  // **承認されただけでは budget は戻らない。** epoch の開始点は consume の一点である。
  it('WAITING_FOR_USER の承認は epoch を開かない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')

    expect(epochCoveredImplementationJobIds(storage, ids.taskId).size).toBe(0)
  })

  it('APPROVED でも consume 前は epoch を開かない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)

    expect(epochCoveredImplementationJobIds(storage, ids.taskId).size).toBe(0)
  })

  it('consume すると、その実装だけが epoch に覆われる', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)
    expect(call(storage, ids.taskId, reviewJob.id).status).toBe('queued')

    expect([...epochCoveredImplementationJobIds(storage, ids.taskId)]).toEqual([implementJob.id])
  })
})

describe('epoch 成立後は承認を焼き直さない', () => {
  /** consume 済みだが run がまだ無い状態（consume 直後に落ちた形）を作る。 */
  function consumeWithoutRun(storage: IStorage, ids: { taskId: string }, reviewJobId: string) {
    const request = storage.approvalRequests.create({
      taskId: ids.taskId,
      targetBranch: 'x', targetCommit: 'y', targetDiffHash: 'z',
      riskLevel: 'HIGH',
      requestedAction: repairRecoveryActionFor(reviewJobId),
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      invalidIf: [],
    } as never)
    approve(storage, request.id)
    const consumed = storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: ids.taskId,
      approvalRequestId: request.id,
      expectedAction: repairRecoveryActionFor(reviewJobId),
    })
    expect(consumed.ok).toBe(true)
    return request
  }

  // **consume と repair Job の実体化は同じ瞬間ではない。** その間に落ちても、
  // 使い切った authorization だけが失われる形にはしない。
  it('consume 済みで run が無ければ、新しい承認を要求せず続行する', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    const request = consumeWithoutRun(storage, ids, reviewJob.id)

    const outcome = call(storage, ids.taskId, reviewJob.id)

    expect(outcome.status).toBe('queued')
    if (outcome.status === 'queued') expect(outcome.stepKey).toBe(`repair:${implementJob.id}:1`)
    // 承認は増えていない（焼き直していない）。
    expect(storage.approvalRequests.findByTaskId(ids.taskId).length).toBe(1)
    expect(storage.approvalRequests.findById(request.id)?.status).toBe('CONSUMED')
  })

  it('consume 済みで run がある場合も、新しい承認を要求しない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    consumeWithoutRun(storage, ids, reviewJob.id)
    expect(call(storage, ids.taskId, reviewJob.id).status).toBe('queued')

    const again = call(storage, ids.taskId, reviewJob.id)
    expect(again.status).toBe('skipped')
    expect(storage.approvalRequests.findByTaskId(ids.taskId).length).toBe(1)
  })
})

describe('承認の束縛は storage 側でも効く', () => {
  // route 側の絞り込みとは**別に**、consume 実装自身が action 一致を要求する。
  // ここを route の filter だけに頼ると、別経路から呼ばれたときに束縛が消える。
  it('action 名が違う承認は consume できない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)

    const mismatched = storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: ids.taskId,
      approvalRequestId: first.approvalRequestId,
      expectedAction: repairRecoveryActionFor('some-other-review-job'),
    })
    expect(mismatched.ok).toBe(false)
    if (!mismatched.ok) expect(mismatched.reason).toContain('approved')
    // 失敗した consume は承認を消費しない。
    expect(storage.approvalRequests.findById(first.approvalRequestId)?.status).toBe('APPROVED')
  })

  it('別 Task を指した consume も通らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)

    const wrongTask = storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: 'another-task',
      approvalRequestId: first.approvalRequestId,
      expectedAction: repairRecoveryActionFor(reviewJob.id),
    })
    expect(wrongTask.ok).toBe(false)
  })
})

describe('recovery action — selector が繋がらなければ何も作らない', () => {
  const rejected = (storage: IStorage, taskId: string, reviewJobId: string) => {
    const outcome = call(storage, taskId, reviewJobId)
    expect(outcome.status).toBe('rejected')
    // 承認リクエストも作らない。
    expect(storage.approvalRequests.findByTaskId(taskId).length).toBe(0)
    return outcome.status === 'rejected' ? outcome.reason : ''
  }

  it('存在しない review Job', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids } = productionShape(storage)
    expect(rejected(storage, ids.taskId, 'no-such-job')).toContain('does not exist')
  })

  it('別 Task の review Job', () => {
    const storage = createSQLiteStorage(':memory:')
    const target = productionShape(storage)
    const otherTask = storage.tasks.create({
      projectId: target.ids.projectId,
      title: 'T2', description: 'd', status: 'blocked', assignee: 'developer_ai',
      dependencies: [], allowedPaths: ['apps/api/src/pl'],
    } as never)
    const otherIds = { taskId: otherTask.id, projectId: target.ids.projectId }
    const otherImpl = makeJob(storage, otherIds, `resume:${target.implementJob.id}:1`, 'success')
    const otherReview = createReviewJob(storage, otherIds, otherImpl.id)

    const outcome = call(storage, target.ids.taskId, otherReview.id)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.reason).toContain('another task')
  })

  it('review Job でない Job を指している', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob } = productionShape(storage)
    expect(rejected(storage, ids.taskId, implementJob.id)).toContain('not a canonical implementation review')
  })

  it('保存された verdict が無い', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    expect(rejected(storage, ids.taskId, reviewJob.id)).toContain('no stored review result')
  })

  it('存在しない Task', () => {
    const storage = createSQLiteStorage(':memory:')
    const { reviewJob } = productionShape(storage)
    const outcome = call(storage, 'no-such-task', reviewJob.id)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.code).toBe('TASK_NOT_FOUND')
  })
})

describe('recovery action — admission で落ちるものに承認を要求しない', () => {
  /** 承認リクエストを作らずに終わること自体が要件である（承認を無駄にしない）。 */
  const withoutApproval = (storage: IStorage, taskId: string, reviewJobId: string) => {
    const outcome = call(storage, taskId, reviewJobId)
    expect(storage.approvalRequests.findByTaskId(taskId).length).toBe(0)
    return outcome
  }

  it('verdict が approved なら通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id, { status: 'approved' } as Partial<ReviewResult>)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('実装が成功していなければ通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    storage.jobs.update(implementJob.id, { status: 'failed' } as never)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('done な Task は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    storage.tasks.update(ids.taskId, { status: 'done' } as never)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('critical finding があれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'critical', file: IN_SCOPE, message: 'safety' }],
    } as Partial<ReviewResult>)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('allowedPaths 外の finding があれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', file: 'apps/api/src/routes/jobs.ts', message: 'outside' }],
    } as Partial<ReviewResult>)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('allowedPaths が使えない形なら通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage, { allowedPaths: ['/srv/elsewhere'] })
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('live な Job があれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
    } as never)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  it('lineage が辿れない場合は escalate し、承認を要求しない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    // 親が存在しない repair を root に持つ chain。
    const broken = makeJob(storage, ids, 'repair:missing-parent:1', 'failed')
    const current = makeJob(storage, ids, `resume:${broken.id}:1`, 'success')
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id)

    const outcome = withoutApproval(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('escalated')
    if (outcome.status === 'escalated') expect(outcome.reason).toContain('lineage')
  })
})

describe('recovery action — 承認の束縛', () => {
  it('別の review に対する承認では通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)

    // 別 review Job（同じ Task）への承認を作って承認しておく。
    const otherImpl = makeJob(storage, ids, `resume:${implementJob.id}:1`, 'success')
    const otherReview = createReviewJob(storage, ids, otherImpl.id)
    const otherRequest = storage.approvalRequests.create({
      taskId: ids.taskId,
      targetBranch: 'x', targetCommit: 'y', targetDiffHash: 'z',
      riskLevel: 'HIGH',
      requestedAction: repairRecoveryActionFor(otherReview.id),
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      invalidIf: [],
    } as never)
    approve(storage, otherRequest.id)

    // 目的の review を再駆動しようとしても、その承認は使われない。
    const outcome = call(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('awaiting_approval')
    expect(storage.approvalRequests.findById(otherRequest.id)?.status).toBe('APPROVED')
  })

  it('期限切れの承認では通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    const expired = storage.approvalRequests.create({
      taskId: ids.taskId,
      targetBranch: 'x', targetCommit: 'y', targetDiffHash: 'z',
      riskLevel: 'HIGH',
      requestedAction: repairRecoveryActionFor(reviewJob.id),
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      invalidIf: [],
    } as never)
    approve(storage, expired.id)

    const outcome = call(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('awaiting_approval')
    if (outcome.status === 'awaiting_approval') {
      expect(outcome.approvalRequestId).not.toBe(expired.id)
    }
  })
})
