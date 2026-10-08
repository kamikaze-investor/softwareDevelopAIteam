import { createHash, randomUUID } from 'node:crypto'
import type { AuditLogEntry, Job, Task } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import type { AttentionItem } from '../state/systemState'
import type { BlockedDiagnosis } from './blockedTriage'

export const TECHNICAL_ABORT_ROOT_CAUSES = ['protected_path'] as const
export type TechnicalAbortRootCause = (typeof TECHNICAL_ABORT_ROOT_CAUSES)[number]
export const TECHNICAL_ABORT_WORKER_REFUSAL_CODES = [
  'PRE_CLEANUP_BASELINE_MISMATCH',
  'CLEANUP_EXECUTION_FAILED',
  'CLEANUP_INCOMPLETE',
  'POST_CLEANUP_NOT_CLEAN_AT_HEAD',
] as const
export type TechnicalAbortWorkerRefusalCode = (typeof TECHNICAL_ABORT_WORKER_REFUSAL_CODES)[number]

export interface TechnicalAbortAuthorization {
  kind: 'technical_evidence'
  evidenceId: string
  rootCauseClass: TechnicalAbortRootCause
  stateFingerprint: string
  attentionKind: AttentionItem['kind']
}

export interface ManualAbortAuthorization {
  kind: 'manual_approval'
  approvalRequestId: string
}

export type AbortAuthorization = ManualAbortAuthorization | TechnicalAbortAuthorization

export interface TechnicalAbortCleanupSummary {
  changedPathCount: number
  restoredPathCount: number
  removedPathCount: number
}

export interface TechnicalAbortSuppressionSnapshot {
  version: 1
  evidenceId: string
  rootCauseClass: TechnicalAbortRootCause
  roadmapHash: string
  taskContractHash: string
  dependencyHash: string
  workspaceProgressHash: string
  recoveryHash: string
}

export interface TechnicalAbortRoadmapInput {
  id: string
  title: string
  state: string
  bodyPreview: string
}

const TECHNICAL_ABORT_EVIDENCE_OPERATION = 'technical_abort_evidence'
const TECHNICAL_ABORT_REFUSAL_OPERATION = 'technical_abort_refused'
const TECHNICAL_ABORT_EVIDENCE_ENTITY = 'technical_abort_evidence'
const EXECUTABILITY_SIGNAL_OPERATIONS = new Set([
  'task_human_recovered',
  'resume_actor',
  'repair_generation',
  'resume_source_terminalized',
])

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function allTasks(storage: IStorage): Task[] {
  return storage.projects.findAll().flatMap((project) => storage.tasks.findByProjectId(project.id))
}

function jobsUsingWorkingDir(storage: IStorage, workingDir: string | undefined): Job[] {
  if (workingDir === undefined || workingDir === '') return []
  return allTasks(storage)
    .flatMap((task) => storage.jobs.findByTaskId(task.id))
    .filter((job) => job.safeCommand?.workingDir === workingDir)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

/**
 * TOCTOU re-check 用 fingerprint。protected_path は triage の最優先規則なので、Task と全 Job、
 * latest Job の guard facts が同一なら root-cause 判定を変える入力も同一である。
 */
export function technicalAbortStateFingerprint(
  task: Task,
  taskJobs: readonly Job[],
  attention: Pick<AttentionItem, 'kind' | 'taskId' | 'jobId' | 'referenceId'>,
): string {
  return hash({
    task: {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      provider: task.provider,
      dependencies: task.dependencies,
      branchName: task.branchName,
      allowedPaths: task.allowedPaths,
      forbiddenPaths: task.forbiddenPaths,
      acceptanceCriteria: task.acceptanceCriteria,
      expectedOutputs: task.expectedOutputs,
      roadmapTaskKey: task.roadmapTaskKey,
      phase: task.phase,
      roadmapActive: task.roadmapActive,
    },
    attention: {
      kind: attention.kind,
      taskId: attention.taskId,
      jobId: attention.jobId,
      referenceId: attention.referenceId,
    },
    jobs: taskJobs.map((job) => ({
      id: job.id,
      status: job.status,
      workingDir: job.safeCommand?.workingDir,
      baseline: job.workspaceBaseline,
      changedFiles: job.changedFiles,
      commitHash: job.commitHash,
      workflowStepKey: job.workflowStepKey,
      quarantined: job.failureMetadata?.quarantined === true,
      guardResult: job.guardResult,
    })),
  })
}

export function isEligibleTechnicalAbortDiagnosis(
  diagnosis: BlockedDiagnosis,
): diagnosis is BlockedDiagnosis & { rootCauseClass: TechnicalAbortRootCause } {
  return diagnosis.rootCauseClass === 'protected_path'
    && diagnosis.confidence === 'high'
    && diagnosis.requiresSafetyBoundaryChange !== true
    && diagnosis.requiresAuthorityChange !== true
    && diagnosis.irreversible !== true
}

export function recordTechnicalAbortEvidence(
  storage: IStorage,
  input: {
    task: Task
    taskJobs: readonly Job[]
    attention: AttentionItem
    diagnosis: BlockedDiagnosis & { rootCauseClass: TechnicalAbortRootCause }
    roadmap: TechnicalAbortRoadmapInput
  },
): TechnicalAbortAuthorization {
  const evidenceId = randomUUID()
  const stateFingerprint = technicalAbortStateFingerprint(input.task, input.taskJobs, input.attention)
  const authorization: TechnicalAbortAuthorization = {
    kind: 'technical_evidence',
    evidenceId,
    rootCauseClass: input.diagnosis.rootCauseClass,
    stateFingerprint,
    attentionKind: input.attention.kind,
  }
  const snapshot = buildTechnicalAbortSuppressionSnapshot(
    storage,
    input.task,
    input.roadmap,
    authorization,
  )
  storage.auditLog.record({
    actor: 'api',
    operation: TECHNICAL_ABORT_EVIDENCE_OPERATION,
    entityType: TECHNICAL_ABORT_EVIDENCE_ENTITY,
    entityId: evidenceId,
    result: 'verified',
    // hashes / ids / enum labels only。path・review text・failure output は保存しない。
    detail: JSON.stringify(snapshot),
  })
  return authorization
}

export function recordTechnicalAbortRefusal(
  storage: IStorage,
  input: { taskId: string; code: string; stage: string; evidenceId?: string },
): void {
  const duplicate = storage.auditLog.findByEntity('task', input.taskId).some((entry) => {
    if (entry.operation !== TECHNICAL_ABORT_REFUSAL_OPERATION || entry.result !== 'refused') return false
    const detail = parseJsonRecord(entry.detail)
    return detail?.code === input.code
      && detail.evidenceId === input.evidenceId
  })
  if (duplicate) return

  storage.auditLog.record({
    actor: 'api',
    operation: TECHNICAL_ABORT_REFUSAL_OPERATION,
    entityType: 'task',
    entityId: input.taskId,
    result: 'refused',
    // value-free classification only。reason / path / provider output は記録しない。
    detail: JSON.stringify({
      code: input.code,
      stage: input.stage,
      ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
    }),
  })
}

export function findTechnicalAbortEvidence(
  storage: IStorage,
  evidenceId: string,
): TechnicalAbortSuppressionSnapshot | undefined {
  const entry = storage.auditLog
    .findByEntity(TECHNICAL_ABORT_EVIDENCE_ENTITY, evidenceId)
    .find((candidate) => candidate.operation === TECHNICAL_ABORT_EVIDENCE_OPERATION && candidate.result === 'verified')
  if (entry === undefined) return undefined
  return parseTechnicalAbortSnapshot(entry)
}

export function findLatestTechnicalAbortSnapshot(
  storage: IStorage,
  taskId: string,
): TechnicalAbortSuppressionSnapshot | undefined {
  const aborts = storage.auditLog.findByEntity('task', taskId)
    .filter((entry) => entry.operation === 'task_aborted' && entry.result === 'success')
  for (const entry of aborts) {
    const detail = parseJsonRecord(entry.detail)
    const evidenceId = typeof detail?.technicalEvidenceId === 'string'
      ? detail.technicalEvidenceId
      : undefined
    if (evidenceId === undefined) continue
    const snapshot = findTechnicalAbortEvidence(storage, evidenceId)
    if (snapshot !== undefined) return snapshot
  }
  return undefined
}

export function buildTechnicalAbortSuppressionSnapshot(
  storage: IStorage,
  task: Task,
  roadmap: TechnicalAbortRoadmapInput,
  authorization: Pick<TechnicalAbortAuthorization, 'evidenceId' | 'rootCauseClass'>,
): TechnicalAbortSuppressionSnapshot {
  const taskJobs = storage.jobs.findByTaskId(task.id)
  const workingDir = taskJobs[0]?.safeCommand?.workingDir
  const workspaceJobs = jobsUsingWorkingDir(storage, workingDir)
  const dependencyFacts = task.dependencies.map((dependencyId) => {
    const dependency = storage.tasks.findById(dependencyId)
    return {
      id: dependencyId,
      status: dependency?.status ?? 'missing',
      roadmapActive: dependency?.roadmapActive ?? false,
      updatedAt: dependency?.updatedAt ?? 'missing',
    }
  })
  const recoveryEntries = [
    ...storage.auditLog.findByEntity('task', task.id),
    ...taskJobs.flatMap((job) => storage.auditLog.findByEntity('job', job.id)),
  ]
    // Only an existing recovery/lineage signal can re-enable adoption. Unrelated audit traffic,
    // repeated classification, and elapsed time must leave the fingerprint unchanged.
    .filter((entry) => EXECUTABILITY_SIGNAL_OPERATIONS.has(entry.operation))
    .map((entry) => ({ id: entry.id, operation: entry.operation, result: entry.result }))

  return {
    version: 1,
    evidenceId: authorization.evidenceId,
    rootCauseClass: authorization.rootCauseClass,
    roadmapHash: hash(roadmap),
    taskContractHash: hash({
      title: task.title,
      description: task.description,
      assignee: task.assignee,
      provider: task.provider,
      dependencies: task.dependencies,
      branchName: task.branchName,
      allowedPaths: task.allowedPaths,
      forbiddenPaths: task.forbiddenPaths,
      acceptanceCriteria: task.acceptanceCriteria,
      expectedOutputs: task.expectedOutputs,
      roadmapTaskKey: task.roadmapTaskKey,
      phase: task.phase,
    }),
    dependencyHash: hash(dependencyFacts),
    workspaceProgressHash: hash(workspaceJobs.map((job) => ({
      id: job.id,
      taskId: job.taskId,
      createdAt: job.createdAt,
      workflowStepKey: job.workflowStepKey,
      startCommitHash: job.workspaceBaseline?.startCommitHash,
      commitHash: job.commitHash,
    }))),
    recoveryHash: hash(recoveryEntries),
  }
}

export function technicalAbortFingerprintChanged(
  storage: IStorage,
  task: Task,
  roadmap: TechnicalAbortRoadmapInput,
  previous: TechnicalAbortSuppressionSnapshot,
): boolean {
  const current = buildTechnicalAbortSuppressionSnapshot(storage, task, roadmap, previous)
  return current.roadmapHash !== previous.roadmapHash
    || current.taskContractHash !== previous.taskContractHash
    || current.dependencyHash !== previous.dependencyHash
    || current.workspaceProgressHash !== previous.workspaceProgressHash
    || current.recoveryHash !== previous.recoveryHash
}

function parseTechnicalAbortSnapshot(entry: AuditLogEntry): TechnicalAbortSuppressionSnapshot | undefined {
  const value = parseJsonRecord(entry.detail)
  if (
    value?.version !== 1
    || typeof value.evidenceId !== 'string'
    || value.rootCauseClass !== 'protected_path'
    || typeof value.roadmapHash !== 'string'
    || typeof value.taskContractHash !== 'string'
    || typeof value.dependencyHash !== 'string'
    || typeof value.workspaceProgressHash !== 'string'
    || typeof value.recoveryHash !== 'string'
  ) return undefined
  return value as unknown as TechnicalAbortSuppressionSnapshot
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
