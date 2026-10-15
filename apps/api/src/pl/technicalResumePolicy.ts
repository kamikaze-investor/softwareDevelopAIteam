/**
 * PL Technical Resume policy helpers.
 *
 * This module is the single mechanical contract for the Rule 5.5 recovery admitted by
 * `specs/22_safety_approval_design_principle.md` §14-3. It does not grant permission:
 * `authorizePlAction()` and the existing Design Review gate remain authoritative.
 */

import type { AuditLogEntry, Job } from '@ai-team/shared'
import { HUMAN_RECOVERY_AUDIT_OPERATION } from '../humanRecovery/recoveryAudit'
import type { IStorage } from '../storage/interface'

/** Audit operation used by `recordResumeActor()`. Kept here so readers and writers share one token. */
export const RESUME_ACTOR_AUDIT_OPERATION = 'resume_actor'

/** Value-free marker that distinguishes Rule 5.5 resumes from routine resume_task actions. */
export const TECHNICAL_RESUME_AUDIT_TOKEN = 'technical_resume'

/** One Task may receive only this many PL Technical Resumes before a human boundary resets the window. */
export const PL_MAX_TECHNICAL_RESUMES_PER_TASK = 2

export interface TechnicalRecoveryTarget {
  kind: string
  projectId: string
  taskId?: string
  jobId?: string
  referenceId?: string
}

function auditDetailHasToken(detail: string | undefined, token: string): boolean {
  return detail?.split(/\s+/).includes(token) === true
}

/**
 * Whether the stored resume-actor rows prove one exact Rule 5.5 Technical Resume.
 * Every resume-actor row must carry the same PL evidence and marker; missing or
 * conflicting rows fail closed.
 */
export function isVerifiedPlTechnicalResumeAudit(
  entries: readonly AuditLogEntry[],
  taskId: string,
): boolean {
  const rows = entries.filter((entry) => entry.operation === RESUME_ACTOR_AUDIT_OPERATION)
  return rows.length > 0 && rows.every((entry) =>
    entry.result === 'pl'
    && auditDetailHasToken(entry.detail, `task_id=${taskId}`)
    && auditDetailHasToken(entry.detail, 'resume_actor=pl')
    && auditDetailHasToken(entry.detail, 'authorization_evidence=in_process_pl')
    && auditDetailHasToken(entry.detail, TECHNICAL_RESUME_AUDIT_TOKEN),
  )
}

/**
 * Return the successful implementation whose failed review is eligible for Rule 5.5.
 * Missing or ambiguous facts fail closed. In particular, stored review decisions, credential-like
 * refusals, non-initial lineage, live successors, and non-blocked Tasks are not eligible.
 */
export function findTechnicalResumeImplementation(
  storage: IStorage,
  taskId: string,
  reviewJob: Job,
): Job | undefined {
  if (
    reviewJob.status !== 'failed'
    || reviewJob.aiCliMode !== 'review'
    || reviewJob.taskId !== taskId
    || storage.tasks.findById(taskId)?.status !== 'blocked'
    || storage.jobs.findByTaskId(taskId).some((job) => job.status === 'queued' || job.status === 'running')
  ) return undefined

  const refusal = reviewJob.failureMetadata?.refusal
  if (refusal?.kind !== 'secret_scan' || refusal.repairEligible !== true) return undefined
  if (storage.reviewResults.findByTaskId(taskId).some((review) => review.jobId === reviewJob.id)) {
    return undefined
  }

  const implementId = /^implement:([^:]+):review$/.exec(reviewJob.workflowStepKey ?? '')?.[1]
  const implementation = implementId !== undefined ? storage.jobs.findById(implementId) : undefined
  if (
    implementation?.status !== 'success'
    || implementation.aiCliMode !== 'implement'
    || implementation.taskId !== reviewJob.taskId
    || implementation.projectId !== reviewJob.projectId
  ) return undefined

  return implementation
}

/**
 * Current per-Task budget window. A verified human resume/recovery or Task completion starts a new
 * window. Equal timestamps stay in the current window because ordering across tables is unknowable.
 */
function technicalResumeWindow(storage: IStorage, taskId: string): AuditLogEntry[] {
  const completedAt = storage.taskContinuations.findByCompletedTaskId(taskId)?.createdAt
  const taskEntries = storage.auditLog.findByEntity('task', taskId)
  const jobEntries = storage.jobs.findByTaskId(taskId)
    .flatMap((job) => storage.auditLog.findByEntity('job', job.id))
  const humanBoundary = [...taskEntries, ...jobEntries]
    .filter((entry) => (
      entry.operation === HUMAN_RECOVERY_AUDIT_OPERATION
      && entry.result === 'success'
    ) || (
      entry.operation === RESUME_ACTOR_AUDIT_OPERATION
      && entry.result === 'human'
      && auditDetailHasToken(entry.detail, `task_id=${taskId}`)
      && auditDetailHasToken(entry.detail, 'authorization_evidence=admin_credential')
    ))
    .map((entry) => entry.createdAt)
    .sort()
    .pop()
  const boundary = [completedAt, humanBoundary]
    .filter((value): value is string => value !== undefined)
    .sort()
    .pop()

  return jobEntries
    .filter((entry) => boundary === undefined || entry.createdAt >= boundary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function countPlTechnicalResumes(storage: IStorage, taskId: string): number {
  return technicalResumeWindow(storage, taskId).filter((entry) =>
    isVerifiedPlTechnicalResumeAudit([entry], taskId),
  ).length
}

export function technicalResumeBudget(
  storage: IStorage,
  taskId: string,
): { attempts: number; limit: number; exhausted: boolean } {
  const attempts = countPlTechnicalResumes(storage, taskId)
  return {
    attempts,
    limit: PL_MAX_TECHNICAL_RESUMES_PER_TASK,
    exhausted: attempts >= PL_MAX_TECHNICAL_RESUMES_PER_TASK,
  }
}

export function taskTechnicalResumeAuditKey(taskId: string): string {
  return `technical_resume_task:${taskId}`
}

/** Same target identity used by execution-loop attempts and system-state projection. */
export function technicalRecoveryTargetKey(item: TechnicalRecoveryTarget): string {
  const subject = item.referenceId ?? item.jobId ?? item.taskId ?? item.projectId
  return `${item.kind}:${subject}`
}

/** Only target-wide exhaustion is projected here; the per-Task cap removes resume_task alone. */
export function isTechnicalRecoveryTargetExhausted(
  storage: IStorage,
  item: TechnicalRecoveryTarget,
): boolean {
  return storage.auditLog
    .findByEntity('pl_loop_target', technicalRecoveryTargetKey(item))
    .some((entry) => entry.operation === 'pl_loop' && entry.result === 'technical_exhausted')
}
