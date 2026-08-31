import type { ApprovalRequest, Job, Task } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'

import { canShowResumeUI, manualWorkflowIsLocked } from './taskWorkflow'

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
