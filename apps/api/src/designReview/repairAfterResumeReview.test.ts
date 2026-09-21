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

  // 末尾スラッシュを落とさないと `apps/api/src/pl/` が `apps/api/src/pl//` としか
  // 一致せず、**範囲内の finding を範囲外と誤判定する**。
  it('allowedPaths の末尾スラッシュがあっても範囲内と見なす', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage, {
      allowedPaths: ['apps/api/src/pl/'],
    })
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', message: 'in scope' }],
    } as Partial<ReviewResult>)

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

  // **`allowedPaths` が空なら通さない。** 範囲外を指す finding が 1 件も無くても同じで、
  // 「直してよい範囲が無い」は「どこでも直してよい」ではない。
  // `file` を持たない finding だけの場合、範囲判定は何も弾かないのでここだけが効く。
  it('allowedPaths が空なら、file の無い finding だけでも通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage, { allowedPaths: [] })
    const implementJob = createResumedImplementJob(storage, ids)
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', message: 'no file attached' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('no allowedPaths')
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

  // **元 Job を外す根拠は `blocked` という状態であって、名前ではない。**
  // 元 Job は後から `queued` / `running` へ戻りうる（`blocked: ['queued']` の遷移が許され、
  // implement requeue 経路が実在する）。そのとき除外を続けると、本当に動いている Job の上へ
  // repair を積んでしまう（独立レビュー指摘）。
  for (const liveStatus of ['queued', 'running'] as const) {
    it(`resume の元 Job が ${liveStatus} へ戻っていれば通さない`, () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage)
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

      const implementJob = createResumedImplementJob(storage, ids, {
        workflowStepKey: `resume:${sourceJob.id}:1`,
      })
      const reviewJob = createReviewJob(storage, ids, implementJob.id)
      const review = storeReview(storage, ids, reviewJob.id)

      // 元 Job が live へ戻る。
      storage.jobs.update(sourceJob.id, { status: liveStatus } as never)

      expect(skipped(storage, implementJob, review)).toContain('live job exists')
    })
  }

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

  // **使えない範囲はその時点で落とす。** `..` を含む prefix は File Change Guard の
  // 前方一致にどのファイルも一致させないので、repair を作っても必ず止まる。
  // 範囲判定まで持ち越さず、範囲そのものを不成立として扱う。
  it('allowedPaths に .. が含まれていれば範囲として使わない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage, {
      allowedPaths: ['apps/api/src/pl/..'],
    })
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', file: 'apps/api/src/routes/jobs.ts', message: 'outside' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('unusable scope')
  })

  // **中身が空・空白・絶対パスの範囲も同じ。** task route は `z.array(z.string())` としか
  // 検証しないので保存されうる。`file` を持たない finding だけだと範囲判定が何も弾かず、
  // ここが無いと「範囲が無い Task」に repair を作ってしまう（独立レビュー指摘）。
  for (const [label, scope] of [
    ['空文字', ''],
    ['空白のみ', '   '],
    ['前後に空白', ' apps/api/src/pl '],
    ['posix 絶対パス', '/srv/ai-team/apps/api/src/pl'],
    ['Windows 絶対パス', 'C:/repo/apps/api/src/pl'],
  ] as const) {
    it(`allowedPaths が ${label} なら、file の無い finding だけでも通さない`, () => {
      const storage = createSQLiteStorage(':memory:')
      const ids = seed(storage, { allowedPaths: [scope] })
      const implementJob = createResumedImplementJob(storage, ids)
      const reviewJob = createReviewJob(storage, ids, implementJob.id)
      const review = storeReview(storage, ids, reviewJob.id, {
        findings: [{ severity: 'medium', message: 'no file attached' }],
      } as Partial<ReviewResult>)
      expect(skipped(storage, implementJob, review)).toContain('unusable scope')
    })
  }

  // 使える範囲が 1 つでも欠けていれば通さない（一部だけ拾って進めない）。
  it('使える範囲と使えない範囲が混ざっていれば通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage, {
      allowedPaths: ['apps/api/src/pl', '/srv/elsewhere'],
    })
    const review = storeReview(storage, ids, reviewJob.id, {
      findings: [{ severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', message: 'in scope' }],
    } as Partial<ReviewResult>)
    expect(skipped(storage, implementJob, review)).toContain('unusable scope')
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

  // **implement Job も id で読み直す。** 引数の object は呼び出し元が組んだもので、
  // `status` も `workflowStepKey` も自由に書ける（`routes/jobs.ts` の失敗経路は実際に
  // `{ ...existing, ...jobUpdate }` という合成 object を渡す）。引数から読むかぎり
  // 条件 3・4 は**自己申告の検査**でしかない（独立レビュー指摘）。
  it('保存された stepKey が resume 由来でなければ、引数がそう名乗っても通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    // 保存されている実体は **初回 implement**（resume successor ではない）。
    const implementJob = createResumedImplementJob(storage, ids, {
      workflowStepKey: `task:${ids.taskId}:initial-implement`,
    })
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = storeReview(storage, ids, reviewJob.id)

    // 呼び出し元が canonical な resume successor を名乗る。
    const claimed = { ...implementJob, workflowStepKey: 'resume:11111111-1111-1111-1111-111111111111:1' } as Job
    expect(skipped(storage, claimed, review)).toContain('not a canonical resume successor')
  })

  it('保存された status が success でなければ、引数がそう名乗っても通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const implementJob = createResumedImplementJob(storage, ids)
    const reviewJob = createReviewJob(storage, ids, implementJob.id)
    const review = storeReview(storage, ids, reviewJob.id)
    const stored = storage.jobs.update(implementJob.id, { status: 'failed' } as never)!

    const claimed = { ...stored, status: 'success' } as Job
    expect(skipped(storage, claimed, review)).toContain('implementation job is failed')
  })

  // 引数の `taskId` だけは宛先として使うので、**読み直した行が本当にその Task のものか**を
  // 確かめる。別 Task の Job id を、この Task の宛先で渡しても通らない。
  it('読み直した Job が別 Task のものなら通さない', () => {
    const storage = createSQLiteStorage(':memory:')
    const target = productionShape(storage)

    // 同じ Project の別 Task（running Project は 1 つまでという既存 interlock のため）。
    const otherTask = storage.tasks.create({
      projectId: target.ids.projectId,
      title: 'T2', description: 'd', status: 'blocked', assignee: 'developer_ai',
      dependencies: [], allowedPaths: ['apps/api/src/pl'],
    } as never)
    // workflow_step_key は全体で一意なので、別のものを付ける。
    const otherJob = createResumedImplementJob(storage, {
      taskId: otherTask.id, projectId: target.ids.projectId,
    }, { workflowStepKey: `resume:22222222-2222-2222-2222-222222222222:1` })

    const claimed = { ...otherJob, taskId: target.ids.taskId } as Job
    expect(skipped(storage, claimed, target.review)).toContain('belongs to another task')
  })
})

// **認めた根拠と repair の材料は同じ行でなければならない。**
// 保存された無害な verdict で通し、引数の細工された verdict で prompt を組む、が
// 成立してはいけない（独立レビュー指摘）。
describe('repair の材料は保存済み verdict', () => {
  it('引数の review ではなく保存された review から prompt を組む', () => {
    const storage = createSQLiteStorage(':memory:')
    const { ids, implementJob, reviewJob } = shapeWithoutVerdict(storage)
    // 保存: 範囲内・medium・無害。
    storeReview(storage, ids, reviewJob.id, {
      summary: 'STORED-SUMMARY-MARKER',
      findings: [{ severity: 'medium', file: 'apps/api/src/pl/executionLoop.ts', message: 'STORED-FINDING-MARKER' }],
    } as Partial<ReviewResult>)

    // 引数: 範囲外・critical・別内容。admission を通ったあとに混入させる形。
    const crafted = {
      id: 'crafted', taskId: ids.taskId, jobId: reviewJob.id, reviewer: 'qa_ai',
      status: 'changes_requested',
      summary: 'CRAFTED-SUMMARY-MARKER',
      findings: [{ severity: 'critical', file: 'apps/api/src/routes/jobs.ts', message: 'CRAFTED-FINDING-MARKER' }],
      createdAt: new Date().toISOString(),
    } as unknown as ReviewResult

    const result = prepareRepairFlow(storage, { failedJob: implementJob, review: crafted })

    expect(result.action).toBe('queue')
    if (result.action !== 'queue') return
    expect(result.run.designText).toContain('STORED-SUMMARY-MARKER')
    expect(result.run.designText).toContain('STORED-FINDING-MARKER')
    expect(result.run.designText).not.toContain('CRAFTED-SUMMARY-MARKER')
    expect(result.run.designText).not.toContain('CRAFTED-FINDING-MARKER')
  })
})
