import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import type { Job, ReviewResult } from '@ai-team/shared'
import { prepareRepairFlow } from './repairFlow'
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

/**
 * **repair descendant は同じ human_recovery generation の中にいる。**
 *
 * production `c3849205`（2026-09-23 実測）の形そのまま: human recovery で始めた
 * repair attempt 1 が成功し、そのレビューが `changes_requested` を返した。以前は
 * blocked admission が「resume successor ではない」として落とし、repair も escalate も
 * 作られないまま PL が `unknown` で CEO escalation していた。
 */
describe('human_recovery generation の中の repair descendant', () => {
  /**
   * epoch を consume し、その generation の repair attempt 1 まで進んだ形。
   *
   * 承認 UI 経路そのものは別の describe で確認済みなので、ここでは承認を直接
   * consume して **generation の形だけ**を作る（Stage 2 の run は残さない）。
   */
  function afterFirstRepair(storage: IStorage) {
    const { ids, implementJob, reviewJob } = productionShape(storage)

    const request = storage.approvalRequests.create({
      taskId: ids.taskId,
      targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
      riskLevel: 'HIGH',
      requestedAction: repairRecoveryActionFor(reviewJob.id),
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      invalidIf: [],
    } as never)
    approve(storage, request.id)
    expect(storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: ids.taskId,
      approvalRequestId: request.id,
      expectedAction: repairRecoveryActionFor(reviewJob.id),
    }).ok).toBe(true)

    const repair1 = makeJob(storage, ids, `repair:${implementJob.id}:1`, 'success')
    return { ids, implementJob, repair1 }
  }

  /** chain を `depth` 段まで伸ばし、末端に changes_requested のレビューを付ける。 */
  function chainTo(storage: IStorage, depth: number) {
    const { ids, implementJob, repair1 } = afterFirstRepair(storage)
    let leaf = repair1
    for (let i = 2; i <= depth; i += 1) {
      leaf = makeJob(storage, ids, `repair:${leaf.id}:1`, 'success')
    }
    const reviewJob = createReviewJob(storage, ids, leaf.id)
    const review = storeReview(storage, ids, reviewJob.id)
    return { ids, implementJob, leaf, reviewJob, review }
  }

  it('repair successor の changes_requested が canonical repair へ進む', () => {
    const storage = createSQLiteStorage(':memory:')
    const { implementJob, leaf, review } = chainTo(storage, 1)

    const preparation = prepareRepairFlow(storage, { failedJob: leaf, review })

    expect(preparation.action).toBe('queue')
    if (preparation.action !== 'queue') return
    // **generation root は最初の human recovery のまま。** repair は根にならない。
    expect(preparation.generation.rootJobId).toBe(implementJob.id)
    expect(preparation.generation.rootKind).toBe('human_recovery')
    expect(preparation.generation.depth).toBe(1)
    expect(preparation.attempt).toBe(2)
    expect(preparation.stepKey).toBe(`repair:${leaf.id}:1`)
  })

  it('新しい ApprovalRequest を要求しない（承認は generation 単位）', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = chainTo(storage, 1)
    const before = storage.approvalRequests.findByTaskId(ids.taskId).length

    const outcome = call(storage, ids.taskId, reviewJob.id)

    expect(outcome.status).toBe('queued')
    expect(storage.approvalRequests.findByTaskId(ids.taskId).length).toBe(before)
  })

  // **同じ epoch で毎回 depth 0 へ戻らない。**
  it.each([1, 2])('repair %i 段目なら次を attempt+1 として許す', (depth) => {
    const storage = createSQLiteStorage(':memory:')
    const { implementJob, leaf, review } = chainTo(storage, depth)

    const preparation = prepareRepairFlow(storage, { failedJob: leaf, review })
    expect(preparation.action).toBe('queue')
    if (preparation.action !== 'queue') return
    expect(preparation.generation.rootJobId).toBe(implementJob.id)
    expect(preparation.generation.rootKind).toBe('human_recovery')
    expect(preparation.generation.depth).toBe(depth)
    expect(preparation.attempt).toBe(depth + 1)
  })

  it('同じ epoch でも 3 段使い切れば escalate する', () => {
    const storage = createSQLiteStorage(':memory:')
    const { implementJob, leaf, review } = chainTo(storage, 3)

    const preparation = prepareRepairFlow(storage, { failedJob: leaf, review })
    expect(preparation.action).toBe('escalate')
    if (preparation.action !== 'escalate') return
    expect(preparation.code).toBe('attempt_limit')
    // 上限に達しても別 generation にはならない。
    expect(preparation.generation?.rootKind).toBe('human_recovery')
    expect(preparation.generation?.rootJobId).toBe(implementJob.id)
  })

  // 上限に達した human generation へ、route が2枚目の承認を要求しないこと。
  it('上限に達しても新しい承認を要求しない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = chainTo(storage, 3)
    const before = storage.approvalRequests.findByTaskId(ids.taskId).length

    const outcome = call(storage, ids.taskId, reviewJob.id)

    expect(outcome.status).toBe('escalated')
    expect(storage.approvalRequests.findByTaskId(ids.taskId).length).toBe(before)
  })
})

describe('CONSUMED は durable な authorization fact である', () => {
  afterEach(() => { vi.useRealTimers() })

  // **expiry は APPROVED → CONSUMED の瞬間に見る。**
  // 正当に consume された後、crash からの再試行時に「いまは expiresAt を過ぎた」
  // という理由だけで同じ epoch を無効化してはいけない。consume は「有効な時点で
  // 一度使われた」という消えない事実であり、時間で消えるものではない。
  it('consume 後に expiresAt を過ぎても epoch は生きている', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)

    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)

    const request = storage.approvalRequests.findById(first.approvalRequestId)!
    const consumed = storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: ids.taskId,
      approvalRequestId: request.id,
      expectedAction: repairRecoveryActionFor(reviewJob.id),
    })
    expect(consumed.ok).toBe(true)

    // ここで時間を進める。承認は既に使い切られている。
    vi.useFakeTimers()
    vi.setSystemTime(new Date(new Date(request.expiresAt).getTime() + 60_000))

    expect(epochCoveredImplementationJobIds(storage, ids.taskId).has(implementJob.id)).toBe(true)

    // 再駆動も通る（新しい承認を要求しない）。
    const again = call(storage, ids.taskId, reviewJob.id)
    expect(again.status).toBe('queued')
    expect(storage.approvalRequests.findByTaskId(ids.taskId).length).toBe(1)
  })
})

describe('同じ epoch を何度 re-drive しても予算は増えない', () => {
  // route は常に実装 Job を source にするので stepKey は `repair:<impl>:1` に固定される。
  // 既存 dedup がそのまま効き、2 本目の repair は作られない。
  it('repair が既にあれば、再呼び出しは新しい repair を作らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)

    const first = call(storage, ids.taskId, reviewJob.id)
    if (first.status !== 'awaiting_approval') throw new Error('expected awaiting_approval')
    approve(storage, first.approvalRequestId)
    const queued = call(storage, ids.taskId, reviewJob.id)
    expect(queued.status).toBe('queued')
    if (queued.status !== 'queued') return

    // Stage 2 が実体化した後の姿を作る（repair Job が既にある）。
    storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'noop' },
      workflowStepKey: queued.stepKey,
    } as never)

    const before = storage.jobs.findByTaskId(ids.taskId).length
    const again = call(storage, ids.taskId, reviewJob.id)
    expect(again.status).not.toBe('queued')
    expect(storage.jobs.findByTaskId(ids.taskId).length).toBe(before)
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

  // **修正を要求していないレビューは再駆動しない。**
  // `prepareRepairFlow()` の verdict 検査は blocked Task の admission の中にしかないので、
  // Task が blocked でなければそこを通らない。入口で確かめないと、approved な
  // レビューから repair と epoch を作れてしまう（独立レビュー指摘）。
  it.each(['approved', 'pending'] as const)('verdict が %s なら通さない', (verdict) => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id, { status: verdict } as Partial<ReviewResult>)

    const outcome = withoutApproval(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.reason).toContain('not changes_requested')
  })

  it('実装が成功していなければ通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = productionShape(storage)
    storage.jobs.update(implementJob.id, { status: 'failed' } as never)
    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('skipped')
  })

  // **blocked 以外は入口で落とす。** admission が走らない状態だからである。
  it.each(['done', 'pending', 'in_progress'] as const)('%s な Task は通さない', (taskStatus) => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = productionShape(storage)
    storage.tasks.update(ids.taskId, { status: taskStatus } as never)

    const outcome = withoutApproval(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.code).toBe('TASK_NOT_BLOCKED')
  })

  // **round 3 で見つかった穴の本体。** blocked の admission にしか無い条件を、
  // blocked 以外の Task からこの経路で迂回できてはいけない。
  it.each([
    ['critical finding', { findings: [{ severity: 'critical', file: IN_SCOPE, message: 'safety' }] }],
    ['範囲外の finding', { findings: [{ severity: 'medium', file: 'apps/api/src/routes/jobs.ts', message: 'outside' }] }],
  ] as const)('pending Task の %s でも repair を作らない', (_label, overrides) => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage, { status: 'pending' })
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id, overrides as unknown as Partial<ReviewResult>)

    const outcome = withoutApproval(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('rejected')
    expect(storage.designReviewRuns.findLatestByTaskId(ids.taskId)).toBeUndefined()
  })

  it('pending Task に live Job があっても repair を作らない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage, { status: 'pending' })
    const { current } = exhaustedChainThenResume(storage, ids)
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id)
    storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
    } as never)

    expect(withoutApproval(storage, ids.taskId, reviewJob.id).status).toBe('rejected')
    expect(storage.designReviewRuns.findLatestByTaskId(ids.taskId)).toBeUndefined()
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

  // lineage が辿れない実装は **admission の時点で**落ちる（段数も根も確定できないため）。
  // どちらにせよ承認は要求しない —— それがこのテストの要点である。
  it('lineage が辿れない場合は承認を要求せず止まる', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    // 親が存在しない repair を root に持つ chain。
    const broken = makeJob(storage, ids, 'repair:missing-parent:1', 'failed')
    const current = makeJob(storage, ids, `resume:${broken.id}:1`, 'success')
    const reviewJob = createReviewJob(storage, ids, current.id)
    storeReview(storage, ids, reviewJob.id)

    const outcome = withoutApproval(storage, ids.taskId, reviewJob.id)
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') expect(outcome.reason).toContain('lineage')
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

/**
 * **元 Job が `blocked` のまま残る human generation の repair descendant**
 * （独立レビュー指摘・2026-09-23 の HIGH 回帰）。
 *
 * production `c3849205` の形そのもの: `resumeBlockedTask()` は元の行を `blocked` の
 * まま残して `resume:<元Job>:1` を作る。その resume 成果へ recovery epoch を張って
 * repair を始めると、attempt 2 以降の実装は `repair:` 規約になるため、**自分の stepKey
 * からは元の resume 元を辿れない**。live Job の除外が implementJob 自身の `resume:` キー
 * だけを見ていたので、人が承認した chain が attempt 1 の次で必ず止まっていた。
 *
 * 既存の descendant fixture は祖先が全部 `failed` なので、この欠陥に当たらなかった。
 */
describe('元 Job が blocked のまま残る human_recovery generation', () => {
  /** blocked B → resume R（epoch で覆う）→ repair を `depth` 段。 */
  function blockedPredecessorChain(
    storage: IStorage,
    depth: number,
    sourceStatus: string = 'blocked',
  ) {
    const ids = seed(storage)
    const source = makeJob(storage, ids, `task:${ids.taskId}:initial-implement`, sourceStatus)
    // 状態遷移が拒否されていたら、この fixture は何も測っていない。
    expect(storage.jobs.findById(source.id)?.status).toBe(sourceStatus)

    const resumed = makeJob(storage, ids, `resume:${source.id}:1`, 'success')

    // その resume 成果へ張られた recovery epoch を consume して generation を開く。
    const resumedReviewJob = createReviewJob(storage, ids, resumed.id)
    storeReview(storage, ids, resumedReviewJob.id)
    const request = storage.approvalRequests.create({
      taskId: ids.taskId,
      targetBranch: 'b', targetCommit: 'c', targetDiffHash: 'd',
      riskLevel: 'HIGH',
      requestedAction: repairRecoveryActionFor(resumedReviewJob.id),
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      invalidIf: [],
    } as never)
    approve(storage, request.id)
    expect(storage.approvalRequests.verifyAndConsumeForTaskAction({
      taskId: ids.taskId,
      approvalRequestId: request.id,
      expectedAction: repairRecoveryActionFor(resumedReviewJob.id),
    }).ok).toBe(true)
    expect(epochCoveredImplementationJobIds(storage, ids.taskId)).toContain(resumed.id)

    let leaf = resumed
    for (let i = 1; i <= depth; i += 1) {
      leaf = makeJob(storage, ids, `repair:${leaf.id}:1`, 'success')
    }
    const reviewJob = createReviewJob(storage, ids, leaf.id)
    const review = storeReview(storage, ids, reviewJob.id)
    return { ids, source, resumed, leaf, reviewJob, review }
  }

  it.each([1, 2])('元 Job が blocked のままでも repair %i 段目の次へ進む', (depth) => {
    const storage = createSQLiteStorage(':memory:')
    const { resumed, leaf, review } = blockedPredecessorChain(storage, depth)

    const preparation = prepareRepairFlow(storage, { failedJob: leaf, review })

    expect(preparation.action).toBe('queue')
    if (preparation.action !== 'queue') return
    // 根は epoch を張った resume 成果のまま。repair は根にならない。
    expect(preparation.generation.rootJobId).toBe(resumed.id)
    expect(preparation.generation.rootKind).toBe('human_recovery')
    expect(preparation.generation.depth).toBe(depth)
    expect(preparation.attempt).toBe(depth + 1)
    expect(preparation.stepKey).toBe(`repair:${leaf.id}:1`)
  })

  it('元 Job が blocked のままでも 3 段使い切れば escalate する', () => {
    const storage = createSQLiteStorage(':memory:')
    const { resumed, leaf, review } = blockedPredecessorChain(storage, 3)

    const preparation = prepareRepairFlow(storage, { failedJob: leaf, review })

    expect(preparation.action).toBe('escalate')
    if (preparation.action !== 'escalate') return
    expect(preparation.code).toBe('attempt_limit')
    // 上限に達しても別 generation にはならない。
    expect(preparation.generation?.rootKind).toBe('human_recovery')
    expect(preparation.generation?.rootJobId).toBe(resumed.id)
  })

  it('承認済み chain が attempt 2 へ進んでも新しい ApprovalRequest を要求しない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, reviewJob } = blockedPredecessorChain(storage, 1)
    const before = storage.approvalRequests.findByTaskId(ids.taskId).length

    const outcome = call(storage, ids.taskId, reviewJob.id)

    expect(outcome.status).toBe('queued')
    expect(storage.approvalRequests.findByTaskId(ids.taskId).length).toBe(before)
  })

  // **除外の根拠は `blocked` という状態そのもの。** 名前でも lineage 上の位置でもない。
  // 元 Job が動いているなら、その上へ repair を積んではならない。
  it.each(['queued', 'running'])('元 Job が %s へ戻っていれば live として通さない', (status) => {
    const storage = createSQLiteStorage(':memory:')
    const { leaf, review } = blockedPredecessorChain(storage, 1, status)

    const result = prepareRepairFlow(storage, { failedJob: leaf, review })

    expect(result.action).toBe('skip')
    if (result.action !== 'skip') return
    expect(result.reason ?? '').toContain('a live job exists')
  })

  // **外すのは lineage から導いた resume 元ちょうど 1 件だけ。**
  // 「generation 内の blocked Job を全部無視」にはしない。
  it('lineage から導いた resume 元以外の blocked Job は外さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, leaf, review } = blockedPredecessorChain(storage, 1)

    // lineage に属さない、無関係な blocked Job。
    const unrelated = storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
      aiCliMode: 'implement',
      aiCliProvider: 'claude_code',
    } as never)
    storage.jobs.update(unrelated.id, { status: 'blocked' } as never)

    const result = prepareRepairFlow(storage, { failedJob: leaf, review })

    expect(result.action).toBe('skip')
    if (result.action !== 'skip') return
    expect(result.reason ?? '').toContain('a live job exists')
  })
})
