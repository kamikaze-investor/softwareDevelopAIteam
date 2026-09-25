import type {
  ApprovalRequest,
  Job,
  QAResult,
  ReviewResult,
  Task,
  TaskSummary,
  WatchdogEvent,
} from '@ai-team/shared'
import { describe, expect, it } from 'vitest'

import {
  allowsProgressActions,
  allRoadmapTasksDone,
  blockerNeedsHumanDecision,
  visibleTaskActions,
  allowsRoutineRecoveryActions,
  canShowResumeUI,
  deriveJobDisplayState,
  deriveProjectExecutionHealth,
  deriveProjectSummaryState,
  deriveSummaryDisplayState,
  JOB_DISPLAY_STATE_LABEL,
  manualWorkflowIsLocked,
  PROJECT_EXECUTION_HEALTH_LABEL,
  quarantineGuidanceText,
  deriveSafeCommandQaEvidence,
  findStoredReviewRecoveryCandidate,
  qaEvidenceToRegister,
  invalidateQaEvidence,
  storedReviewApprovalState,
  storedReviewRecoveryActionLabel,
  storedReviewRecoveryNotice,
  storedReviewRecoveryView,
} from './taskWorkflow'

function makeJob(overrides: Partial<Job>): Job {
  return {
    agentRole: 'developer_ai',
    createdAt: '2026-08-01T00:00:00.000Z',
    id: 'job-1',
    projectId: 'project-1',
    safeCommand: { kind: 'git_status', workingDir: '/workspace/target' } as Job['safeCommand'],
    status: 'success',
    taskId: 'task-1',
    ...overrides,
  }
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    assignee: 'developer_ai',
    createdAt: '2026-08-01T00:00:00.000Z',
    dependencies: [],
    description: 'desc',
    id: 'task-1',
    projectId: 'project-1',
    roadmapActive: false,
    status: 'in_progress',
    title: 'title',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

const AUTOMATIC_COMMIT_STEP_KEY = 'review:review-job-1:git-commit'

describe('manualWorkflowIsLocked', () => {
  it('does not lock when a past automatic commit Job succeeded', () => {
    const jobs = [
      makeJob({ id: 'commit-1', status: 'success', workflowStepKey: AUTOMATIC_COMMIT_STEP_KEY }),
      makeJob({ id: 'implement-1', status: 'success' }),
    ]
    expect(manualWorkflowIsLocked(jobs, [])).toBe(false)
  })

  it('does not lock when a past automatic commit Job failed', () => {
    const jobs = [
      makeJob({ id: 'commit-1', status: 'failed', workflowStepKey: AUTOMATIC_COMMIT_STEP_KEY }),
      makeJob({ id: 'implement-1', status: 'success' }),
    ]
    expect(manualWorkflowIsLocked(jobs, [])).toBe(false)
  })

  it('still locks while a Job is queued', () => {
    const jobs = [makeJob({ id: 'job-1', status: 'queued' })]
    expect(manualWorkflowIsLocked(jobs, [])).toBe(true)
  })

  it('still locks while a Job is running', () => {
    const jobs = [makeJob({ id: 'job-1', status: 'running' })]
    expect(manualWorkflowIsLocked(jobs, [])).toBe(true)
  })

  it('still locks while a queued/running automatic commit Job is in flight', () => {
    const jobs = [makeJob({ id: 'commit-1', status: 'running', workflowStepKey: AUTOMATIC_COMMIT_STEP_KEY })]
    expect(manualWorkflowIsLocked(jobs, [])).toBe(true)
  })

  it('still locks while the latest Job has a waiting approval', () => {
    const jobs = [makeJob({ id: 'job-1', approvalId: 'approval-1', status: 'blocked' })]
    const approvalRequests: ApprovalRequest[] = [
      {
        changedFiles: [],
        expiresAt: '2026-08-01T01:00:00.000Z',
        id: 'approval-1',
        requestedAction: 'git_commit',
        riskLevel: 'HIGH',
        status: 'WAITING_FOR_USER',
        targetBranch: 'main',
        targetCommit: 'abc123',
        targetDiffHash: 'hash',
        taskId: 'task-1',
      },
    ]
    expect(manualWorkflowIsLocked(jobs, approvalRequests)).toBe(true)
  })
})

describe('canShowResumeUI', () => {
  it('shows resume UI when the latest Job is directly blocked (guard violation)', () => {
    const task = makeTask({ status: 'in_progress' })
    const jobs = [makeJob({ id: 'job-1', status: 'blocked' })]
    expect(canShowResumeUI(task, jobs, [])).toBe(true)
  })

  it('shows resume UI when Design Review escalation left Task blocked with a failed latest Job', () => {
    const task = makeTask({ status: 'blocked' })
    const jobs = [makeJob({ id: 'job-1', status: 'failed' })]
    expect(canShowResumeUI(task, jobs, [])).toBe(true)
  })

  it('does not show resume UI when Task is not blocked and latest Job merely failed', () => {
    const task = makeTask({ status: 'in_progress' })
    const jobs = [makeJob({ id: 'job-1', status: 'failed' })]
    expect(canShowResumeUI(task, jobs, [])).toBe(false)
  })

  it('does not show resume UI while a linked approval is still waiting for the user', () => {
    const task = makeTask({ status: 'blocked' })
    const jobs = [makeJob({ id: 'job-1', approvalId: 'approval-1', status: 'blocked' })]
    const approvalRequests: ApprovalRequest[] = [
      {
        changedFiles: [],
        expiresAt: '2026-08-01T01:00:00.000Z',
        id: 'approval-1',
        requestedAction: 'git_commit',
        riskLevel: 'HIGH',
        status: 'WAITING_FOR_USER',
        targetBranch: 'main',
        targetCommit: 'abc123',
        targetDiffHash: 'hash',
        taskId: 'task-1',
      },
    ]
    expect(canShowResumeUI(task, jobs, approvalRequests)).toBe(false)
  })
})

/**
 * MOB-001: CEO は「止まっている」だけでなく **なぜ止まっているか** を見分けられる必要がある。
 * 特に quarantine は承認や resume では解けないので、通常の blocked と混同させない。
 */
describe('MOB-001: 実行状態の見分け', () => {
  const baseJob = (over: Partial<Job>): Job => ({
    id: 'job-1',
    taskId: 'task-1',
    status: 'running',
    createdAt: '2026-09-08T00:00:00.000Z',
    startedAt: '2026-09-08T00:00:00.000Z',
    safeCommand: { kind: 'test', workingDir: '/workspace/target', params: {} },
    ...over,
  } as Job)

  const stallEvent = (over: Partial<WatchdogEvent> = {}): WatchdogEvent => ({
    id: 'wde-1',
    jobId: 'job-1',
    taskId: 'task-1',
    commandKind: 'test',
    workingDir: '/workspace/target',
    startedAt: '2026-09-08T00:00:00.000Z',
    detectedAt: '2026-09-08T00:05:00.000Z',
    stallDurationMs: 300000,
    status: 'confirmed',
    isStuck: true,
    createdAt: '2026-09-08T00:05:00.000Z',
    ...over,
  } as WatchdogEvent)

  it('healthy running と watchdog確認済み stalled を区別する', () => {
    const job = baseJob({ status: 'running' })
    expect(deriveJobDisplayState(job, [], [])).toBe('running_healthy')
    expect(deriveJobDisplayState(job, [], [stallEvent()])).toBe('running_stalled')
  })

  it('誤検知(false_alarm / isStuck:false)は stalled にしない', () => {
    const job = baseJob({ status: 'running' })
    expect(deriveJobDisplayState(job, [], [stallEvent({ isStuck: false })])).toBe('running_healthy')
    expect(deriveJobDisplayState(job, [], [stallEvent({ status: 'false_alarm' })])).toBe('running_healthy')
  })

  it('過去の実行の stall 記録を、復帰後の健全な実行へ引きずらない', () => {
    // Job は復旧後に再び running になり、そのとき startedAt が付け直される。
    const rerun = baseJob({ status: 'running', startedAt: '2026-09-08T09:00:00.000Z' })
    const oldStall = stallEvent({ startedAt: '2026-09-08T00:00:00.000Z' })
    expect(deriveJobDisplayState(rerun, [], [oldStall])).toBe('running_healthy')
  })

  it('別 Job の watchdog event では stalled にしない（jobId 一致が必要）', () => {
    // stall 判定は (jobId, startedAt) の両方一致が条件。片方でも違えば別 episode。
    const job = baseJob({ status: 'running' })
    const otherJobsStall = stallEvent({ jobId: 'job-999' })
    expect(deriveJobDisplayState(job, [], [otherJobsStall])).toBe('running_healthy')
  })

  it('watchdog event が無い running は healthy のまま（通常の running 表示）', () => {
    const job = baseJob({ status: 'running' })
    expect(deriveJobDisplayState(job, [], [])).toBe('running_healthy')
    // WatchdogEvent の取得に失敗して空配列になった場合も、画面は healthy running を保つ
    expect(deriveJobDisplayState(job, [], undefined as never)).toBe('running_healthy')
  })
  it('quarantine を通常の blocked と区別する', () => {
    const quarantined = baseJob({
      status: 'blocked',
      failureMetadata: { quarantined: true, quarantineReason: 'drain_timeout' },
    } as Partial<Job>)
    const ordinary = baseJob({ status: 'blocked' })

    expect(deriveJobDisplayState(quarantined, [], [])).toBe('quarantined')
    expect(deriveJobDisplayState(ordinary, [], [])).toBe('blocked')
  })

  it('quarantine は承認待ちより優先される（承認しても前に進まないため）', () => {
    const job = baseJob({
      status: 'blocked',
      approvalId: 'apr-1',
      failureMetadata: { quarantined: true },
    } as Partial<Job>)
    const approvals = [{ id: 'apr-1', status: 'WAITING_FOR_USER' }] as ApprovalRequest[]

    expect(deriveJobDisplayState(job, approvals, [])).toBe('quarantined')
  })

  it('承認待ちの blocked は approval_waiting として出る', () => {
    const job = baseJob({ status: 'blocked', approvalId: 'apr-1' } as Partial<Job>)
    const approvals = [{ id: 'apr-1', status: 'WAITING_FOR_USER' }] as ApprovalRequest[]
    expect(deriveJobDisplayState(job, approvals, [])).toBe('approval_waiting')
  })

  it('quarantine された Job には resume UI を出さない', () => {
    // resume しても API 側の quarantine guard が claim を拒否する。
    // 「押しても失敗する操作」をCEOに見せてはならない。
    const task = { id: 'task-1', status: 'blocked' } as Task
    const quarantined = baseJob({
      status: 'blocked',
      failureMetadata: { quarantined: true },
    } as Partial<Job>)

    expect(canShowResumeUI(task, [quarantined], [])).toBe(false)
    // quarantine でない通常の blocked では従来どおり出る
    expect(canShowResumeUI(task, [baseJob({ status: 'blocked' })], [])).toBe(true)
  })
})

/**
 * MOB-001 production evidence (2026-09-08 Phase 1/2 Operational E2E).
 *
 * 実運用で観測した状態をそのまま固定する:
 *   Project.status = running
 *   初回 implement Job = success
 *   continuation review Job = quarantined (workspace_baseline_failure)
 *   → workflow は完全停止していたが、Mobile は Running を表示し続けた。
 */
describe('MOB-001 Project実行健全性', () => {
  const task = (id: string, status: Task['status'] = 'in_progress'): Task =>
    ({ id, status } as Task)

  const job = (over: Partial<Job>): Job =>
    ({ id: 'j', status: 'success', ...over } as Job)

  it('production再現: running Project + quarantined Job は「安全停止中」を主表示にする', () => {
    const tasks = [task('t1')]
    const jobsByTaskId = {
      t1: [
        job({ aiCliMode: 'implement', id: 'j1', status: 'success' }),
        job({
          aiCliMode: 'review',
          failureMetadata: { quarantineReason: 'workspace_baseline_failure', quarantined: true },
          id: 'j2',
          status: 'blocked',
        }),
      ],
    }

    const health = deriveProjectExecutionHealth(tasks, jobsByTaskId, [])

    expect(health).toBe('quarantined')
    expect(PROJECT_EXECUTION_HEALTH_LABEL[health]).toBe('安全停止中')
    // 「実行中」を主表示にしてはいけない — これが実運用で起きた誤表示そのもの
    expect(PROJECT_EXECUTION_HEALTH_LABEL[health]).not.toBe('実行中')
  })

  it('quarantine では通常の Resume / Approval 操作を出さない', () => {
    expect(allowsRoutineRecoveryActions('quarantined')).toBe(false)
    expect(allowsRoutineRecoveryActions('approval_waiting')).toBe(true)
    expect(allowsRoutineRecoveryActions('error')).toBe(true)
    expect(allowsRoutineRecoveryActions('running_stalled')).toBe(true)
  })

  it('healthy running は「実行中」', () => {
    const health = deriveProjectExecutionHealth(
      [task('t1')],
      { t1: [job({ id: 'j1', startedAt: '2026-09-08T00:00:00Z', status: 'running' })] },
      [],
    )
    expect(health).toBe('running_healthy')
    expect(PROJECT_EXECUTION_HEALTH_LABEL[health]).toBe('実行中')
  })

  it('watchdog が stall と確認した running は「処理が進んでいません」', () => {
    const startedAt = '2026-09-08T00:00:00Z'
    const health = deriveProjectExecutionHealth(
      [task('t1')],
      { t1: [job({ id: 'j1', startedAt, status: 'running' })] },
      [],
      [{ isStuck: true, jobId: 'j1', startedAt, status: 'confirmed', taskId: 't1' } as WatchdogEvent],
    )
    expect(health).toBe('running_stalled')
    expect(PROJECT_EXECUTION_HEALTH_LABEL[health]).toBe('処理が進んでいません')
  })

  it('承認待ちは「承認待ち」', () => {
    const health = deriveProjectExecutionHealth(
      [task('t1')],
      { t1: [job({ approvalId: 'a1', id: 'j1', status: 'blocked' })] },
      [{ id: 'a1', status: 'WAITING_FOR_USER' } as ApprovalRequest],
    )
    expect(health).toBe('approval_waiting')
    expect(PROJECT_EXECUTION_HEALTH_LABEL[health]).toBe('承認待ち')
  })

  it('通常の失敗は「復旧が必要」', () => {
    const health = deriveProjectExecutionHealth(
      [task('t1', 'blocked')],
      { t1: [job({ id: 'j1', status: 'failed' })] },
      [],
    )
    expect(health).toBe('error')
    expect(PROJECT_EXECUTION_HEALTH_LABEL[health]).toBe('復旧が必要')
  })

  it('quarantine は running / approval / failure より優先される', () => {
    const startedAt = '2026-09-08T00:00:00Z'
    const health = deriveProjectExecutionHealth(
      [task('t1'), task('t2')],
      {
        t1: [job({ id: 'j1', startedAt, status: 'running' })],
        t2: [
          job({ approvalId: 'a1', id: 'j2', status: 'blocked' }),
          job({
            failureMetadata: { quarantined: true },
            id: 'j3',
            status: 'blocked',
          }),
        ],
      },
      [{ id: 'a1', status: 'WAITING_FOR_USER' } as ApprovalRequest],
    )
    expect(health).toBe('quarantined')
  })

  it('実行signalが無ければ idle（lifecycle statusをそのまま見せてよい）', () => {
    expect(deriveProjectExecutionHealth([task('t1', 'done')], { t1: [] }, [])).toBe('idle')
  })
})

/**
 * MOB-001 CEO実機フィードバック: Dashboard / 一覧 / 詳細で状態表現が一致し、
 * quarantine 中に作業を進める操作が出ないことを固定する。
 */
describe('MOB-001: 一覧・Dashboard の状態導出と action gating', () => {
  const summary = (over: Partial<TaskSummary>): TaskSummary => ({
    taskId: 't1', projectId: 'p1', projectName: 'P', title: 'T', description: '',
    taskStatus: 'pending', displayStatus: 'blocked', updatedAt: '2026-09-08T00:00:00.000Z',
    approvalSummary: { hasWaitingApproval: false, hasRejectedApproval: false },
    ...over,
  } as TaskSummary)

  it('一覧でも quarantine を通常の blocked と区別する', () => {
    const q = summary({ latestJob: { jobId: 'j1', status: 'blocked', quarantined: true } })
    const b = summary({ latestJob: { jobId: 'j2', status: 'blocked', quarantined: false } })
    expect(deriveSummaryDisplayState(q)).toBe('quarantined')
    expect(deriveSummaryDisplayState(b)).toBe('blocked')
  })

  it('一覧の承認待ちは approval_waiting になる', () => {
    const s = summary({
      latestJob: { jobId: 'j1', status: 'blocked' },
      approvalSummary: { hasWaitingApproval: true, hasRejectedApproval: false },
    })
    expect(deriveSummaryDisplayState(s)).toBe('approval_waiting')
  })

  it('一覧の stalled も episode key (jobId, startedAt) 一致が条件', () => {
    const running = summary({
      latestJob: { jobId: 'j1', status: 'running', startedAt: '2026-09-08T00:00:00.000Z' },
    })
    const match = [{ jobId: 'j1', startedAt: '2026-09-08T00:00:00.000Z', isStuck: true, status: 'confirmed' }] as never
    const otherRun = [{ jobId: 'j1', startedAt: '2026-09-08T09:00:00.000Z', isStuck: true, status: 'confirmed' }] as never
    expect(deriveSummaryDisplayState(running, match)).toBe('running_stalled')
    expect(deriveSummaryDisplayState(running, otherRun)).toBe('running_healthy')
  })

  it('Dashboard は対応が要る状態を優先して代表表示にする', () => {
    const healthy = summary({ taskId: 'a', latestJob: { jobId: 'ja', status: 'running' } })
    const quarantined = summary({ taskId: 'b', latestJob: { jobId: 'jb', status: 'blocked', quarantined: true } })
    // 健全な作業が同居していても、quarantine があれば Dashboard で気付けなければならない
    expect(deriveProjectSummaryState([healthy, quarantined])).toBe('quarantined')
    expect(deriveProjectSummaryState([healthy])).toBe('running_healthy')
  })

  it('quarantine では作業を進める操作を出さない', () => {
    expect(allowsProgressActions('quarantined')).toBe(false)
    // ordinary blocked / approval waiting では従来どおり操作を残す
    expect(allowsProgressActions('blocked')).toBe(true)
    expect(allowsProgressActions('approval_waiting')).toBe(true)
    expect(allowsProgressActions('running_healthy')).toBe(true)
  })

  it('quarantine の案内は CEO に git 操作を求めない', () => {
    const text = quarantineGuidanceText()
    expect(text).toContain('安全のため停止しています')
    expect(text).toContain('承認や再開では解除されません')
    expect(text).toContain('CEOによる操作は必要ありません')
    for (const technical of ['git', 'commit', 'worktree', 'reset', 'clean']) {
      expect(text.toLowerCase()).not.toContain(technical)
    }
  })

  it('復旧actorが無い間は「自動復旧中」と誤認させない', () => {
    // 2026-09-08 調査: quarantine を実際に解消する actor は存在せず、
    // Worker restart でも本番の dirty workspace は解消しない。
    // 進行中でない復旧を進行中と表示すると、CEO は待てば直ると誤解する。
    const text = quarantineGuidanceText()
    for (const misleading of ['復旧中', '対応中', '進行中']) {
      expect(text).not.toContain(misleading)
    }
    // 誰の担当かは明示する（放置されているように見せない）
    expect(text).toContain('自動では復旧しません')
    expect(text).toContain('AI開発チーム側で作業領域の復旧が必要です')
  })

  it('Dashboard / 一覧 / 詳細でラベルが一致する', () => {
    expect(JOB_DISPLAY_STATE_LABEL.quarantined).toBe('安全停止中')
    expect(JOB_DISPLAY_STATE_LABEL.running_stalled).toBe('停滞中')
    expect(JOB_DISPLAY_STATE_LABEL.approval_waiting).toBe('承認待ち')
    expect(JOB_DISPLAY_STATE_LABEL.blocked).toBe('停止中')
  })
})

/**
 * MOB-001 CEO実機再確認 follow-up: workflow state に対して意味のある操作だけを出す。
 */
describe('MOB-001: action eligibility と完了表示', () => {
  const job = (over: Partial<Job>): Job => makeJob({ ...over })

  it('ordinary blocked では作業を進める3操作を出さない（resume/recoveryの領分）', () => {
    const v = visibleTaskActions('blocked', [job({ status: 'blocked' })], [])
    expect(v).toEqual({ implement: false, review: false, reflect: false })
  })

  it('承認待ちでも3操作は出さない（承認が先）', () => {
    const v = visibleTaskActions('approval_waiting', [job({ status: 'blocked' })], [])
    expect(v).toEqual({ implement: false, review: false, reflect: false })
  })

  it('安全停止中でも出さない（既存の挙動を維持）', () => {
    const v = visibleTaskActions('quarantined', [job({ status: 'blocked' })], [])
    expect(v).toEqual({ implement: false, review: false, reflect: false })
  })

  it('実装成功後は「独立レビュー」だけを出し、実装開始は出さない', () => {
    const jobs = [job({ id: 'i1', status: 'success', aiCliMode: 'implement' })]
    const v = visibleTaskActions('other', jobs, [])
    expect(v.review).toBe(true)
    expect(v.implement).toBe(false)
  })

  it('成果が無ければ「実装を開始」だけを出す', () => {
    const v = visibleTaskActions('other', [], [])
    expect(v.implement).toBe(true)
    expect(v.review).toBe(false)
    expect(v.reflect).toBe(false)
  })

  it('技術的blockerではCEOの自由入力を必須にしない', () => {
    for (const c of ['code', 'environment', 'configuration'] as const) {
      expect(blockerNeedsHumanDecision(c)).toBe(false)
    }
    // Goal・方針レベルだけCEO判断
    expect(blockerNeedsHumanDecision('approval_or_policy')).toBe(true)
  })

  it('Task 0件のProjectを vacuous truth で完了にしない', () => {
    expect(allRoadmapTasksDone([])).toBe(false)
  })

  it('未着手Taskが残っていれば完了にしない（実行歴の有無で母集団を絞らない）', () => {
    // 以前の実装は「Job実行歴がある or done」で filter していたため、一度も実行されて
    // いない pending Task が母集団から外れ、この構成が誤って完了と判定されていた。
    const mixed = [
      { taskId: 'a', taskStatus: 'done', latestJob: { jobId: 'j', status: 'success' } },
      { taskId: 'b', taskStatus: 'pending' },
      { taskId: 'c', taskStatus: 'pending' },
    ] as never
    expect(allRoadmapTasksDone(mixed)).toBe(false)
  })

  it('対象Taskが1件以上あり全件doneのときだけ完了', () => {
    const allDone = [
      { taskId: 'a', taskStatus: 'done' },
      { taskId: 'b', taskStatus: 'done' },
    ] as never
    expect(allRoadmapTasksDone(allDone)).toBe(true)
  })

  it('全Task完了のProjectは「作業中」に見せない', () => {
    const done = [{ taskId: 't1', taskStatus: 'done', latestJob: { jobId: 'j', status: 'success' } }] as never
    const notDone = [{ taskId: 't1', taskStatus: 'pending', latestJob: { jobId: 'j', status: 'blocked' } }] as never
    expect(allRoadmapTasksDone(done)).toBe(true)
    expect(allRoadmapTasksDone(notDone)).toBe(false)
  })
})


// ── stored-review recovery（保存済み verdict の再投入）─────────────────────────

function makeReview(overrides: Partial<ReviewResult>): ReviewResult {
  return {
    createdAt: '2026-09-24T00:00:00.000Z',
    findings: [],
    id: 'review-result-1',
    jobId: 'review-job-1',
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: 'fix it',
    taskId: 'task-1',
    ...overrides,
  } as ReviewResult
}

function makeQa(overrides: Partial<QAResult>): QAResult {
  return {
    createdAt: '2026-09-24T00:00:00.000Z',
    id: 'qa-1',
    jobId: 'implement-1',
    status: 'passed',
    summary: 's',
    taskId: 'task-1',
    type: 'unit_test',
    ...overrides,
  } as QAResult
}

/** production c3849205 と同じ形: 成功した implement と、その canonical review の changes_requested。 */
function storedReviewShape(overrides: { taskStatus?: Task['status'], implement?: Partial<Job> } = {}) {
  const task = makeTask({ status: overrides.taskStatus ?? 'blocked' })
  const implementJob = makeJob({
    aiCliMode: 'implement',
    exitCode: 0,
    id: 'implement-1',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' } as Job['safeCommand'],
    status: 'success',
    stdoutPath: '/logs/implement-1/stdout.txt',
    workflowStepKey: 'resume:prev-1:1',
    ...overrides.implement,
  })
  const reviewJob = makeJob({
    aiCliMode: 'review',
    id: 'review-job-1',
    status: 'failed',
    workflowStepKey: 'implement:implement-1:review',
  })
  const review = makeReview({ jobId: reviewJob.id })
  return { implementJob, review, reviewJob, task }
}

describe('findStoredReviewRecoveryCandidate — 表示条件（判定の正本は backend）', () => {
  it('blocked + canonical review + changes_requested なら候補になる', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const found = findStoredReviewRecoveryCandidate(task, [implementJob, reviewJob], [review])
    expect(found?.reviewJob.id).toBe('review-job-1')
    expect(found?.implementJob.id).toBe('implement-1')
  })

  it('Task が blocked でなければ出さない', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape({ taskStatus: 'in_progress' })
    expect(findStoredReviewRecoveryCandidate(task, [implementJob, reviewJob], [review])).toBeUndefined()
  })

  it('保存済み verdict が approved なら出さない', () => {
    const { task, implementJob, reviewJob } = storedReviewShape()
    const approved = makeReview({ jobId: reviewJob.id, status: 'approved' })
    expect(findStoredReviewRecoveryCandidate(task, [implementJob, reviewJob], [approved])).toBeUndefined()
  })

  it('verdict が保存されていなければ出さない', () => {
    const { task, implementJob, reviewJob } = storedReviewShape()
    expect(findStoredReviewRecoveryCandidate(task, [implementJob, reviewJob], [])).toBeUndefined()
  })

  it('canonical review Job が無ければ出さない', () => {
    const { task, implementJob, review } = storedReviewShape()
    const nonCanonical = makeJob({ id: 'review-job-1', workflowStepKey: 'resume:review-job-0:1' })
    expect(findStoredReviewRecoveryCandidate(task, [implementJob, nonCanonical], [review])).toBeUndefined()
  })

  it('実装 Job が success でなければ出さない', () => {
    const { task, reviewJob, review } = storedReviewShape()
    const failedImplement = makeJob({
      id: 'implement-1',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' } as Job['safeCommand'],
      status: 'failed',
    })
    expect(findStoredReviewRecoveryCandidate(task, [failedImplement, reviewJob], [review])).toBeUndefined()
  })

  it('queued / running の Job があれば出さない', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const busy = makeJob({ id: 'busy', status: 'queued' })
    expect(findStoredReviewRecoveryCandidate(task, [implementJob, reviewJob, busy], [review])).toBeUndefined()
  })
})

describe('deriveSafeCommandQaEvidence — QA 事実は Job レコードから導く', () => {
  it('kind=test / exitCode=0 なら unit_test=passed と typecheck=skipped を導く', () => {
    const { implementJob } = storedReviewShape()
    const derived = deriveSafeCommandQaEvidence(implementJob)

    expect(derived.map((q) => `${q.type}:${q.status}`)).toEqual([
      'unit_test:passed',
      'typecheck:skipped',
    ])
    expect(derived.every((q) => q.jobId === 'implement-1')).toBe(true)
  })

  it('passed と skipped を取り違えない（typecheck を passed にしない）', () => {
    const { implementJob } = storedReviewShape()
    const derived = deriveSafeCommandQaEvidence(implementJob)
    const typecheck = derived.find((q) => q.type === 'typecheck')

    expect(typecheck?.status).toBe('skipped')
    expect(typecheck?.status).not.toBe('passed')
    expect(typecheck?.summary).toContain('No typecheck SafeCommand')
    expect(typecheck?.details).toContain('選ばれた検証は上記1つだけ')
  })

  // **観測できない形からは QA を作らない。** `failed` な Job は AI CLI 段で早期失敗して
  // SafeCommand が走っていない場合もあり、Job レコードからは区別がつかない。
  it('SafeCommand が失敗していれば QA を作らない（実行の有無を断定しない）', () => {
    const { implementJob } = storedReviewShape({ implement: { exitCode: 1, status: 'failed' } })
    expect(deriveSafeCommandQaEvidence(implementJob)).toEqual([])
  })

  // `exitCode` は任意項目。未記録を `failed` へ倒すと、観測していないことを断定してしまう。
  it('exitCode が記録されていなければ QA を作らない', () => {
    const { implementJob } = storedReviewShape({ implement: { exitCode: undefined } })
    expect(deriveSafeCommandQaEvidence(implementJob)).toEqual([])
  })

  it('kind=test 以外の Job からは QA を導かない', () => {
    const gitStatus = makeJob({
      id: 'implement-1',
      safeCommand: { kind: 'git_status', workingDir: '/workspace/target' } as Job['safeCommand'],
      status: 'success',
    })
    expect(deriveSafeCommandQaEvidence(gitStatus)).toEqual([])
  })

  it('dryRun の Job からは QA を導かない（実行していない）', () => {
    const { implementJob } = storedReviewShape({ implement: { dryRun: true } })
    expect(deriveSafeCommandQaEvidence(implementJob)).toEqual([])
  })

  it('特定 Task 向けの固定値を持たない（Job の実値だけから組む）', () => {
    const { implementJob } = storedReviewShape({ implement: { id: 'another-job' } })
    const derived = deriveSafeCommandQaEvidence(implementJob)

    expect(JSON.stringify(derived)).not.toContain('c3849205')
    expect(JSON.stringify(derived)).not.toContain('569cd4ae')
    expect(JSON.stringify(derived)).not.toContain('2,961')
    expect(derived.every((q) => q.jobId === 'another-job')).toBe(true)
    expect(derived[0]?.details).toContain('another-job')
  })
})

describe('qaEvidenceToRegister — 重複は登録しない', () => {
  it('同じ (jobId, type) が既にあれば除く', () => {
    const { implementJob } = storedReviewShape()
    const derived = deriveSafeCommandQaEvidence(implementJob)
    const existing = [makeQa({ jobId: 'implement-1', type: 'unit_test' })]

    const toRegister = qaEvidenceToRegister(derived, existing)
    expect(toRegister.map((q) => q.type)).toEqual(['typecheck'])
  })

  it('2件とも登録済みなら空になる（再登録しない）', () => {
    const { implementJob } = storedReviewShape()
    const derived = deriveSafeCommandQaEvidence(implementJob)
    const existing = [
      makeQa({ jobId: 'implement-1', type: 'unit_test' }),
      makeQa({ id: 'qa-2', jobId: 'implement-1', type: 'typecheck' }),
    ]

    expect(qaEvidenceToRegister(derived, existing)).toEqual([])
  })

  it('別 Job の同種 QA は重複扱いにしない', () => {
    const { implementJob } = storedReviewShape()
    const derived = deriveSafeCommandQaEvidence(implementJob)
    const existing = [makeQa({ jobId: 'other-job', type: 'unit_test' })]

    expect(qaEvidenceToRegister(derived, existing).map((q) => q.type))
      .toEqual(['unit_test', 'typecheck'])
  })

  it('QA が 1 件も無ければ 2 件とも登録対象になる', () => {
    const { implementJob } = storedReviewShape()
    const derived = deriveSafeCommandQaEvidence(implementJob)

    const toRegister = qaEvidenceToRegister(derived, [])
    expect(toRegister.map((q) => `${q.type}:${q.status}`)).toEqual([
      'unit_test:passed',
      'typecheck:skipped',
    ])
  })
})

describe('storedReviewRecoveryView — 画面が出す3状態', () => {
  it('候補が無ければ hidden', () => {
    const { task, implementJob, reviewJob } = storedReviewShape()
    expect(storedReviewRecoveryView(task, [implementJob, reviewJob], [], []).kind).toBe('hidden')
  })

  it('QA を取得できていない（null）なら操作を出さない', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const view = storedReviewRecoveryView(task, [implementJob, reviewJob], [review], null)
    expect(view.kind).toBe('evidence_unavailable')
  })

  it('QA が 0 件なら ready になり、2件とも登録対象になる', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const view = storedReviewRecoveryView(task, [implementJob, reviewJob], [review], [])
    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') return
    expect(view.toRegister.map((q) => q.type)).toEqual(['unit_test', 'typecheck'])
    expect(view.candidate.reviewJob.id).toBe('review-job-1')
  })

  it('登録済みなら登録対象から外れる（表示は残る）', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const existing = [makeQa({ jobId: 'implement-1', type: 'unit_test' })]
    const view = storedReviewRecoveryView(task, [implementJob, reviewJob], [review], existing)
    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') return
    expect(view.derived).toHaveLength(2)
    expect(view.toRegister.map((q) => q.type)).toEqual(['typecheck'])
  })
})

describe('invalidateQaEvidence — 送信後は読み直すまで不明にする', () => {
  it('qaResults を null にする（再取得が失敗しても操作を出さないため）', () => {
    const before = { jobs: [], qaResults: [makeQa({})] }
    expect(invalidateQaEvidence(before)).toEqual({ jobs: [], qaResults: null })
  })

  it('data が無ければそのまま', () => {
    expect(invalidateQaEvidence(null)).toBeNull()
  })

  it('無効化した状態は evidence_unavailable になる（2つを繋いだ不変条件）', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const data = invalidateQaEvidence({ qaResults: [] as QAResult[] })
    const view = storedReviewRecoveryView(task, [implementJob, reviewJob], [review], data!.qaResults)
    expect(view.kind).toBe('evidence_unavailable')
  })
})

describe('storedReviewRecoveryNotice — backend の事実を言い換えない', () => {
  it('awaiting_approval は承認が必要だと伝える', () => {
    const notice = storedReviewRecoveryNotice({ ok: true, status: 'awaiting_approval' })
    expect(notice.title).toContain('承認が必要')
    expect(notice.message).toContain('承認画面')
  })

  it('queued は正常系として伝える（失敗と誤解させない）', () => {
    const notice = storedReviewRecoveryNotice({ detail: '', ok: true, status: 'queued' })
    expect(notice.title).toBe('修正を開始しました')
    expect(notice.title).not.toContain('開始されませんでした')
  })

  it.each(['skipped', 'escalated'] as const)('%s は未開始として、理由をそのまま出す', (status) => {
    const notice = storedReviewRecoveryNotice({ detail: 'a live job exists', ok: true, status })
    expect(notice.title).toBe('修正は開始されませんでした')
    expect(notice.message).toContain(status)
    expect(notice.message).toContain('a live job exists')
  })

  it('失敗はそのまま失敗として出す', () => {
    const notice = storedReviewRecoveryNotice({ message: 'HTTP 409', ok: false })
    expect(notice.title).toBe('起票失敗')
    expect(notice.message).toBe('HTTP 409')
  })
})

describe('承認状態と操作文言 — 「承認すれば勝手に始まる」とは言わない', () => {
  const action = (status: string, expiresAt = '2999-01-01T00:00:00.000Z') => ({
    createdAt: '2026-09-25T00:00:00.000Z',
    expiresAt,
    id: 'approval-1',
    requestedAction: 'repair_from_stored_review:review-job-1',
    status,
    taskId: 'task-1',
  }) as unknown as ApprovalRequest

  it('該当する承認が無ければ none', () => {
    expect(storedReviewApprovalState('review-job-1', [])).toBe('none')
  })

  it('別 review Job 向けの承認は数えない', () => {
    const other = { ...action('APPROVED'), requestedAction: 'repair_from_stored_review:other' } as ApprovalRequest
    expect(storedReviewApprovalState('review-job-1', [other])).toBe('none')
  })

  it('WAITING_FOR_USER は waiting、APPROVED は approved', () => {
    expect(storedReviewApprovalState('review-job-1', [action('WAITING_FOR_USER')])).toBe('waiting')
    expect(storedReviewApprovalState('review-job-1', [action('APPROVED')])).toBe('approved')
  })

  it('view が承認状態を持つ', () => {
    const { task, implementJob, reviewJob, review } = storedReviewShape()
    const view = storedReviewRecoveryView(task, [implementJob, reviewJob], [review], [], [action('APPROVED')])
    expect(view.kind).toBe('ready')
    if (view.kind !== 'ready') return
    expect(view.approval).toBe('approved')
  })

  it('未申請の案内は「承認後にもう一度押す」ことを明示する', () => {
    const { note } = storedReviewRecoveryActionLabel('none', false)
    expect(note).toContain('もう一度押す')
  })

  it('承認待ちの案内は「承認だけでは始まらない」ことを明示する', () => {
    const { label, note } = storedReviewRecoveryActionLabel('waiting', false)
    expect(label).toContain('承認待ち')
    expect(note).toContain('承認だけでは修正は始まりません')
  })

  it('承認済みならもう一度押せば始まると伝える', () => {
    const { label, note } = storedReviewRecoveryActionLabel('approved', false)
    expect(label).toContain('承認済み')
    expect(note).toContain('もう一度押すと修正が始まります')
  })

  it('送信中は文言を差し替える', () => {
    expect(storedReviewRecoveryActionLabel('none', true).label).toBe('送信中...')
  })

  it('awaiting_approval の通知も「承認だけでは始まらない」と伝える', () => {
    const notice = storedReviewRecoveryNotice({ ok: true, status: 'awaiting_approval' })
    expect(notice.message).toContain('もう一度')
    expect(notice.message).toContain('承認だけでは修正は始まりません')
  })
})

describe('typecheck の QA は観測できる事実だけを書く', () => {
  it('「typecheck を実行していない」とは言い切らない', () => {
    const { implementJob } = storedReviewShape()
    const typecheck = deriveSafeCommandQaEvidence(implementJob).find((q) => q.type === 'typecheck')

    expect(typecheck?.status).toBe('skipped')
    expect(typecheck?.summary).toBe('No typecheck SafeCommand was selected for this Job')
    // test script が内部で typecheck を呼ぶ可能性を否定しない
    expect(typecheck?.details).toContain('Job レコードからは判定できない')
    expect(typecheck?.details).not.toContain('typecheck は未検証のままである')
  })
})

describe('承認の期限 — 期限切れを「承認済み」と出さない', () => {
  const approval = (status: string, expiresAt: string) => ({
    createdAt: '2026-09-25T00:00:00.000Z',
    expiresAt,
    id: 'approval-1',
    requestedAction: 'repair_from_stored_review:review-job-1',
    status,
    taskId: 'task-1',
  }) as unknown as ApprovalRequest

  const NOW = new Date('2026-09-25T12:00:00.000Z')

  it('期限切れの APPROVED は none 扱い', () => {
    expect(storedReviewApprovalState('review-job-1', [approval('APPROVED', '2026-09-25T11:00:00.000Z')], NOW)).toBe('none')
  })

  it('期限切れの WAITING_FOR_USER も none 扱い', () => {
    expect(storedReviewApprovalState('review-job-1', [approval('WAITING_FOR_USER', '2026-09-25T11:00:00.000Z')], NOW)).toBe('none')
  })

  it('未失効なら従来どおり反映する', () => {
    expect(storedReviewApprovalState('review-job-1', [approval('APPROVED', '2026-09-25T13:00:00.000Z')], NOW)).toBe('approved')
  })

  it('expiresAt が壊れていれば使わない（fail-closed）', () => {
    expect(storedReviewApprovalState('review-job-1', [approval('APPROVED', 'not-a-date')], NOW)).toBe('none')
  })
})
