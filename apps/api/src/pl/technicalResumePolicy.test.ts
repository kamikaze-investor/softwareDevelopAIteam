import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobRefusalMetadata } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { HUMAN_RECOVERY_AUDIT_OPERATION } from '../humanRecovery/recoveryAudit'
import {
  PL_MAX_TECHNICAL_RESUMES_PER_TASK,
  RESUME_ACTOR_AUDIT_OPERATION,
  TECHNICAL_RESUME_AUDIT_TOKEN,
  countPlTechnicalResumes,
  findTechnicalResumeImplementation,
  isTechnicalRecoveryTargetExhausted,
  technicalRecoveryTargetKey,
  technicalResumeBudget,
} from './technicalResumePolicy'

function seed(): { storage: IStorage; projectId: string; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: true,
    phase: 1,
  } as Parameters<IStorage['tasks']['create']>[0])
  return { storage, projectId: project.id, taskId: task.id }
}

const ELIGIBLE_REFUSAL: JobRefusalMetadata = {
  kind: 'secret_scan',
  patternKinds: ['secret assignment'],
  repairEligible: true,
  repairEligibilityReason: 'implementation_report_generic_assignment',
}

function eligibleReview(storage: IStorage, taskId: string, projectId: string) {
  const implementation = storage.jobs.create({
    taskId,
    projectId,
    agentRole: 'developer_ai',
    status: 'success',
    workflowStepKey: `task:${taskId}:initial-implement`,
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'codex',
    aiCliMode: 'implement',
    aiCliPrompt: 'Implement the Task Contract.',
  } as Parameters<IStorage['jobs']['create']>[0])
  const review = storage.jobs.create({
    taskId,
    projectId,
    agentRole: 'reviewer_ai',
    status: 'failed',
    workflowStepKey: `implement:${implementation.id}:review`,
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'codex',
    aiCliMode: 'review',
    aiCliPrompt: 'Review the implementation.',
    failureMetadata: { workspaceState: 'unchanged', refusal: ELIGIBLE_REFUSAL },
  } as Parameters<IStorage['jobs']['create']>[0])
  storage.tasks.update(taskId, { status: 'blocked' })
  return { implementation, review }
}

function recordTechnicalResume(storage: IStorage, taskId: string, jobId: string): void {
  storage.auditLog.record({
    actor: 'api',
    operation: RESUME_ACTOR_AUDIT_OPERATION,
    entityType: 'job',
    entityId: jobId,
    result: 'pl',
    detail: `task_id=${taskId} resume_actor=pl authorization_evidence=in_process_pl ${TECHNICAL_RESUME_AUDIT_TOKEN}`,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('technicalResumePolicy', () => {
  it('admits only an eligible Rule 5.5 failed review with no live successor or stored verdict', () => {
    const { storage, taskId, projectId } = seed()
    const { implementation, review } = eligibleReview(storage, taskId, projectId)

    expect(findTechnicalResumeImplementation(storage, taskId, review)?.id).toBe(implementation.id)

    storage.reviewResults.create({
      taskId,
      jobId: review.id,
      reviewer: 'reviewer_ai',
      status: 'changes_requested',
      summary: 'a decision already exists',
      findings: [],
    })
    expect(findTechnicalResumeImplementation(storage, taskId, review)).toBeUndefined()
  })

  it('counts only verified PL technical markers and resets the window at human recovery', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'))
    const { storage, taskId, projectId } = seed()
    const first = storage.jobs.create({
      taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    recordTechnicalResume(storage, taskId, first.id)
    storage.auditLog.record({
      actor: 'api',
      operation: RESUME_ACTOR_AUDIT_OPERATION,
      entityType: 'job',
      entityId: first.id,
      result: 'pl',
      detail: `task_id=${taskId} resume_actor=pl authorization_evidence=in_process_pl`,
    })

    vi.setSystemTime(new Date('2026-10-07T00:01:00.000Z'))
    storage.auditLog.record({
      actor: 'api',
      operation: HUMAN_RECOVERY_AUDIT_OPERATION,
      entityType: 'task',
      entityId: taskId,
      result: 'success',
      detail: 'human recovery',
    })
    vi.setSystemTime(new Date('2026-10-07T00:02:00.000Z'))
    const second = storage.jobs.create({
      taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    } as Parameters<IStorage['jobs']['create']>[0])
    recordTechnicalResume(storage, taskId, second.id)

    expect(countPlTechnicalResumes(storage, taskId)).toBe(1)
    expect(technicalResumeBudget(storage, taskId)).toEqual({
      attempts: 1,
      limit: PL_MAX_TECHNICAL_RESUMES_PER_TASK,
      exhausted: false,
    })
  })

  it('shares one target key and target-wide exhaustion projection', () => {
    const { storage, taskId, projectId } = seed()
    const target = { kind: 'job_failed', projectId, taskId, jobId: 'job-1' }
    const key = technicalRecoveryTargetKey(target)
    storage.auditLog.record({
      actor: 'api',
      operation: 'pl_loop',
      entityType: 'pl_loop_target',
      entityId: key,
      result: 'technical_exhausted',
    })

    expect(key).toBe('job_failed:job-1')
    expect(isTechnicalRecoveryTargetExhausted(storage, target)).toBe(true)
  })
})
