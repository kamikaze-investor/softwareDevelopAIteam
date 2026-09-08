import type { ApprovalRequest, Job, Task, TaskSummary, WatchdogEvent } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'

import {
  allowsProgressActions,
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
