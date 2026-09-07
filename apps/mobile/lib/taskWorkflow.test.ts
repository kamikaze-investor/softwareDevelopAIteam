import type { ApprovalRequest, Job, Task, WatchdogEvent } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'

import { canShowResumeUI, deriveJobDisplayState, manualWorkflowIsLocked } from './taskWorkflow'

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
