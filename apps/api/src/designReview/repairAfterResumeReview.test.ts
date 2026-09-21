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

/**
 * **verdict を保存する。** 以前はここで in-memory の object を作って渡していたが、
 * それでは「保存済みレコードだけで判断している」ことの証明にならない
 * （呼び出し元が status も findings も自由に書けてしまう。独立レビュー指摘）。
 * 判定は保存された行だけを見るので、テストも保存する。
 */
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
    summary: 'fix the two points',
    findings: [
      { severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', line: 1290, message: 'state transition widened' },
      { severity: 'medium', message: 'no verification evidence' },
    ],
    ...overrides,
  } as never)
}

/** Task + resume 成功 implement + review Job まで。verdict はまだ保存しない。 */
function shapeWithoutVerdict(storage: IStorage, taskOverrides: Record<string, unknown> = {}) {
  const ids = seed(storage, taskOverrides)
  const implementJob = createResumedImplementJob(storage, ids)
  const reviewJob = createReviewJob(storage, ids, implementJob.id)
  return { ids, implementJob, reviewJob }
}

/** production で起きた形をそのまま組む。 */
function productionShape(storage: IStorage, taskOverrides: Record<string, unknown> = {}) {
  const ids = seed(storage, taskOverrides)
  const implementJob = createResumedImplementJob(storage, ids)
  const reviewJob = createReviewJob(storage, ids, implementJob.id)
  const review = storeReview(storage, ids, reviewJob.id)
  return { ids, implementJob, reviewJob, review }
}

describe('blocked Task への repair — 通るケース', () => {
  // **`resumeBlockedTask()` は元 Job が `blocked` のときも受理し、その行を blocked のまま残す。**
  // stepKey が名指しする元 Job を live 判定から外さないと、その正規経路で再開した成果が
  // 必ず弾かれる —— 直そうとしている閉じ込めを別の形で作り直すことになる（独立レビュー指摘）。
  // 元の resume 元が実際に blocked で残っている形を、production と同じように組む。
  it('元 Job が blocked のまま残っていても repair を作る', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)

    // 元 Job（blocked のまま残る）。
    const sourceJob = storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
      aiCliMode: 'implement',
      aiCliProvider: 'claude_code',
    } as never)
    storage.jobs.update(sourceJob.id, { status: 'blocked' } as never)

    // その Job を元にした resume successor。
    const implementJob = createResumedImplementJob(storage, ids, {
      workflowStepKey: `resume:${sourceJob.id}:1`,
    })
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = storeReview(storage, ids, reviewJob.id)

    const result = prepareRepairFlow(storage, { failedJob: implementJob, review })
    expect(result.action).toBe('queue')
  })

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

  // review Job も verdict も無い、ふつうの blocked Task。
  it('ふつうの blocked Task（review 無し）は従来どおり skip', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids)
    expect(skipped(storage, implementJob, undefined)).toContain('no review job')
  })

  // **保存された verdict が無いなら、引数で渡されても通さない。**
  // ここが「保存済みレコードだけで判断する」ことの本体である。
  it('引数の review が changes_requested でも、保存が無ければ通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids)
    createReviewJob(storage, ids, implementJob.id)
    const fabricated = {
      id: 'fabricated', taskId: ids.taskId, jobId: 'whatever', reviewer: 'qa_ai',
      status: 'changes_requested', summary: 's',
      findings: [{ severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', message: 'm' }],
      createdAt: new Date().toISOString(),
    } as ReviewResult
    expect(skipped(storage, implementJob, fabricated)).toContain('no stored review result')
  })

  // **保存が approved なら、引数が changes_requested でも通さない。**
  it('保存済み verdict が approved なら、引数の changes_requested を信じない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids)
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    storeReview(storage, ids, reviewJob.id, { status: 'approved' } as Partial<ReviewResult>)
    const fabricated = {
      id: 'fabricated', taskId: ids.taskId, jobId: reviewJob.id, reviewer: 'qa_ai',
      status: 'changes_requested', summary: 's',
      findings: [{ severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', message: 'm' }],
      createdAt: new Date().toISOString(),
    } as ReviewResult
    expect(skipped(storage, implementJob, fabricated)).toContain('review status is approved')
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
    const review = storeReview(storage, ids, reviewJob.id)
    expect(skipped(storage, implementJob, review)).toContain('implementation job is failed')
  })

  // review Job の stepKey が別の実装を指すなら、この実装に対する review は存在しない。
  it('review と実装の association が食い違う場合は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids)
    const reviewJob = createReviewJob(storage, ids, implementJob.id, 'implement:someone-else:review')
    const review = storeReview(storage, ids, reviewJob.id)
    expect(skipped(storage, implementJob, review)).toContain('no review job for this implementation')
  })

  it('canonical resume successor でない実装は通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids, {
      workflowStepKey: 'task:abc:initial-implement',
    })
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = storeReview(storage, ids, reviewJob.id)
    expect(skipped(storage, implementJob, review)).toContain('not a canonical resume successor')
  })

  it('allowedPaths 外を指す finding があれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage)
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', file: 'apps/worker/src/index.ts', message: 'outside' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('outside allowedPaths')
  })

  it('critical finding は通常 repair で扱わない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage)
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'critical', file: 'apps/api/src/pl/executionLoop.ts', message: 'authority' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('critical finding')
  })

  // **自己申告の `finalDecision` は使わない。** runner は focus 判定が CONFLICT でも
  // `finalDecision: ALIGNED` と書いて返せる（designReviewCoordinator.test.ts に既存の証明がある）。
  // 判定は `recomputeDecision()` で計算し直し、**ALIGNED 以外はすべて通さない**。
  it('再計算した Design Review 判定が ALIGNED でなければ通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, review } = productionShape(storage)
    const run = storage.designReviewRuns.create({
      taskId: ids.taskId,
      taskTitle: 'T',
      designText: 'd',
      designTextHash: 'h',
      changedFiles: [],
    } as never)
    // **runner が ALIGNED と自己申告し、focus 判定が CONFLICT** という形。
    // `finalDecision` をそのまま読む実装ならこれを通してしまう。
    // `{"decision":"CONFLICT"}` のような作り物では、`finalDecision` を読む実装でも
    // undefined になって偶然 skip するため、**バグを捕まえられない**（独立レビュー指摘）。
    const selfDeclaredAligned = {
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'CONFLICT' },
        { focus: 'scope_simplicity', decision: 'ALIGNED' },
      ],
      integrationReviewResult: { decision: 'ALIGNED' },
      independentReviewResult: { verdict: 'approved' },
      finalDecision: 'ALIGNED',
    }
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    expect(claimed.claimToken).toBeDefined()
    storage.designReviewRuns.complete(
      run.id, claimed.claimToken!, 'succeeded', JSON.stringify(selfDeclaredAligned),
    )
    // 再計算すれば ALIGNED にならない。自己申告を読む実装だけが通してしまう。
    expect(skipped(storage, implementJob, review)).toContain('latest design review is')
  })

  // **結果の無い run も通さない。** 失敗した run / attempt 上限に達した run は
  // `resultJson` が NULL のまま残る。判定が存在しないことは「問題なし」ではない。
  it('Design Review run はあるが結果が無い場合も通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, review } = productionShape(storage)
    storage.designReviewRuns.create({
      taskId: ids.taskId,
      taskTitle: 'T',
      designText: 'd',
      designTextHash: 'h',
      changedFiles: [],
    } as never)
    expect(skipped(storage, implementJob, review)).toContain('could not be recomputed')
  })

  // **パスは解決してから比べる。** 文字列の前方一致だけだと範囲外を指せる。
  it('.. を含む finding path は allowedPaths 内と見なさない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage)
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{
        severity: 'medium',
        file: 'apps/api/src/pl/../routes/jobs.ts',
        message: 'escapes the scope',
      }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('outside allowedPaths')
  })

  // 元 Job を外すのは **stepKey が名指しする 1 件だけ**。無関係な blocked は従来どおり拒む。
  it('resume の元ではない blocked Job は従来どおり通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, review } = productionShape(storage)
    const unrelated = storage.jobs.create({
      taskId: ids.taskId,
      projectId: ids.projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
    } as never)
    storage.jobs.update(unrelated.id, { status: 'blocked' } as never)
    expect(skipped(storage, implementJob, review)).toContain('live job exists')
  })

  // **allowedPaths の prefix を正規化して広げない。**
  // `apps/api/src/pl/..` を `apps/api/src` へ解決すると、保存値より緩い範囲を許してしまう。
  it('allowedPaths に .. が含まれていても範囲を広げない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage, {
      allowedPaths: ['apps/api/src/pl/..'],
    })
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', file: 'apps/api/src/routes/jobs.ts', message: 'outside' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('outside allowedPaths')
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
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage)
    const review = storeReview(storage, ids, reviewJob.id, { status: 'approved' } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('review status is approved')
  })
})
