import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, JobRefusalMetadata, ReviewResult } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { recordResumeActor } from './resumeActor'
import { prepareRepairFlow } from './repairFlow'

const CHANGED_FILE = 'apps/api/src/pl/executionLoop.ts'
const ELIGIBLE_REFUSAL: JobRefusalMetadata = {
  kind: 'secret_scan',
  patternKinds: ['secret assignment'],
  repairEligible: true,
  repairEligibilityReason: 'implementation_report_generic_assignment',
}
const ALIGNED_STDOUT = JSON.stringify({
  focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'ALIGNED' }],
  integrationReviewResult: { decision: 'ALIGNED' },
  finalDecision: 'ALIGNED',
})

type Ids = { taskId: string, projectId: string }
type ResumeAuthority = 'human' | 'pl_technical' | 'pl_plain' | 'ai' | 'unknown'

function seed(storage: IStorage): Ids {
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
  } as never)
  return { taskId: task.id, projectId: project.id }
}

function implementation(storage: IStorage, ids: Ids, workflowStepKey: string): Job {
  const created = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'implement',
    aiCliProvider: 'claude_code',
    workflowStepKey,
  } as never)
  return storage.jobs.update(created.id, {
    status: 'success',
    exitCode: 0,
    changedFiles: [CHANGED_FILE],
  } as never)!
}

function reviewJob(storage: IStorage, ids: Ids, workflowStepKey: string): Job {
  const created = storage.jobs.create({
    taskId: ids.taskId,
    projectId: ids.projectId,
    agentRole: 'qa_ai',
    status: 'queued',
    safeCommand: { kind: 'noop' },
    aiCliMode: 'review',
    aiCliProvider: 'claude_code',
    workflowStepKey,
  } as never)
  return storage.jobs.update(created.id, { status: 'failed', exitCode: 1 } as never)!
}

function recordAuthority(
  storage: IStorage,
  job: Job,
  authority: ResumeAuthority,
): void {
  if (authority === 'human') {
    recordResumeActor(storage, {
      jobId: job.id,
      taskId: job.taskId,
      actorClass: 'human',
      evidence: 'admin_credential',
    })
  } else if (authority === 'pl_technical' || authority === 'pl_plain') {
    recordResumeActor(storage, {
      jobId: job.id,
      taskId: job.taskId,
      actorClass: 'pl',
      evidence: 'in_process_pl',
      technicalResume: authority === 'pl_technical',
    })
  } else if (authority === 'ai') {
    recordResumeActor(storage, {
      jobId: job.id,
      taskId: job.taskId,
      actorClass: 'ai',
      evidence: 'worker_credential',
    })
  }
}

function storedRefusalRecovery(
  storage: IStorage,
  ids: Ids,
  reviewedImplementation: Job,
  authority: ResumeAuthority,
  refusal: JobRefusalMetadata = ELIGIBLE_REFUSAL,
  resumeCount = 1,
): Job {
  let previous = reviewJob(storage, ids, `implement:${reviewedImplementation.id}:review`)
  for (let index = 0; index < resumeCount; index += 1) {
    const resumed = reviewJob(storage, ids, `resume:${previous.id}:1`)
    recordAuthority(storage, resumed, authority)
    previous = resumed
  }
  return storage.jobs.update(previous.id, {
    status: 'failed',
    exitCode: 1,
    stderr: 'Prompt refused by the pre-send secret scan',
    failureMetadata: { refusal, workspaceState: 'unchanged' },
  } as never)!
}

function changesRequested(
  storage: IStorage,
  ids: Ids,
  reviewedImplementation: Job,
): { reviewJob: Job, review: ReviewResult } {
  const review = reviewJob(storage, ids, `implement:${reviewedImplementation.id}:review`)
  const result = storage.reviewResults.create({
    taskId: ids.taskId,
    jobId: review.id,
    reviewer: 'qa_ai',
    status: 'changes_requested',
    summary: 'fix the review finding',
    findings: [{
      severity: 'medium',
      file: CHANGED_FILE,
      message: 'the recovery needs another bounded repair',
    }],
  } as never)
  return { reviewJob: review, review: result }
}

function advanceTime(): void {
  vi.advanceTimersByTime(1_000)
}

function createAdmissionRun(storage: IStorage, ids: Ids, root: Job): void {
  advanceTime()
  const run = storage.designReviewRuns.create({
    taskId: ids.taskId,
    taskTitle: 'T',
    designText: 'repair refusal',
    designTextHash: 'refusal-repair-hash',
    changedFiles: [CHANGED_FILE],
    repairSourceJobId: root.id,
  })
  advanceTime()
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  expect(claimed.claimToken).toBeDefined()
  advanceTime()
  expect(storage.designReviewRuns.complete(
    run.id,
    claimed.claimToken!,
    'succeeded',
    ALIGNED_STDOUT,
  )).toBe(true)
}

function firstRepairFromRefusalAdmission(storage: IStorage, ids: Ids, root: Job): Job {
  createAdmissionRun(storage, ids, root)
  advanceTime()
  return implementation(storage, ids, `repair:${root.id}:1`)
}

function rejectionReason(storage: IStorage, candidate: Job, review: ReviewResult): string {
  const preparation = prepareRepairFlow(storage, { failedJob: candidate, review })
  expect(preparation.action).toBe('skip')
  return preparation.action === 'skip' ? preparation.reason : ''
}

describe('eligible refusal recovery provenance for an origin-root repair generation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('multi-hop Human Resumes authorize the exact origin chain without resetting its budget', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    storedRefusalRecovery(storage, ids, root, 'human', ELIGIBLE_REFUSAL, 2)

    let candidate = firstRepairFromRefusalAdmission(storage, ids, root)
    for (let depth = 1; depth <= 2; depth += 1) {
      const { review } = changesRequested(storage, ids, candidate)
      const preparation = prepareRepairFlow(storage, { failedJob: candidate, review })

      expect(preparation.action).toBe('queue')
      if (preparation.action !== 'queue') throw new Error('expected queue')
      expect(preparation.stepKey).toBe(`repair:${candidate.id}:1`)
      expect(preparation.attempt).toBe(depth + 1)
      expect(preparation.generation).toMatchObject({
        rootJobId: root.id,
        rootKind: 'origin',
        depth,
        budgetReset: false,
      })
      candidate = implementation(storage, ids, preparation.stepKey)
    }

    const { review } = changesRequested(storage, ids, candidate)
    const exhausted = prepareRepairFlow(storage, { failedJob: candidate, review })
    expect(exhausted.action).toBe('escalate')
    if (exhausted.action !== 'escalate') throw new Error('expected attempt_limit')
    expect(exhausted.code).toBe('attempt_limit')
    expect(exhausted.generation).toMatchObject({
      rootJobId: root.id,
      rootKind: 'origin',
      depth: 3,
      budgetReset: false,
    })
    expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
  })

  it('a PL Rule 5.5 technical_resume authorizes the exact origin chain', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    storedRefusalRecovery(storage, ids, root, 'pl_technical')
    const candidate = firstRepairFromRefusalAdmission(storage, ids, root)
    const { review } = changesRequested(storage, ids, candidate)

    const preparation = prepareRepairFlow(storage, { failedJob: candidate, review })
    expect(preparation.action).toBe('queue')
    if (preparation.action === 'queue') {
      expect(preparation.stepKey).toBe(`repair:${candidate.id}:1`)
      expect(preparation.generation.budgetReset).toBe(false)
    }
    expect(storage.tasks.findById(ids.taskId)?.status).toBe('blocked')
  })

  it.each([
    ['plain PL', 'pl_plain'],
    ['AI', 'ai'],
    ['unknown', 'unknown'],
  ] as const)('%s resume does not authorize an origin-root repair successor', (_label, authority) => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    storedRefusalRecovery(storage, ids, root, authority)
    const candidate = implementation(storage, ids, `repair:${root.id}:1`)
    const { review } = changesRequested(storage, ids, candidate)

    expect(rejectionReason(storage, candidate, review))
      .toContain('not inside a human-authorized generation')
  })

  it('a Human Resume followed by a plain PL resume on the same refused review chain is not admitted', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    const originalReview = reviewJob(storage, ids, `implement:${root.id}:review`)
    const humanResume = reviewJob(storage, ids, `resume:${originalReview.id}:1`)
    recordAuthority(storage, humanResume, 'human')
    const plainPlResume = reviewJob(storage, ids, `resume:${humanResume.id}:1`)
    recordAuthority(storage, plainPlResume, 'pl_plain')
    storage.jobs.update(plainPlResume.id, {
      status: 'failed',
      exitCode: 1,
      stderr: 'Prompt refused by the pre-send secret scan',
      failureMetadata: { refusal: ELIGIBLE_REFUSAL, workspaceState: 'unchanged' },
    } as never)
    const candidate = firstRepairFromRefusalAdmission(storage, ids, root)
    const { review } = changesRequested(storage, ids, candidate)

    expect(rejectionReason(storage, candidate, review))
      .toContain('not inside a human-authorized generation')
  })

  it.each([
    [{ ...ELIGIBLE_REFUSAL, repairEligible: false, repairEligibilityReason: 'match_origin_unclear' }],
    [{ ...ELIGIBLE_REFUSAL, patternKinds: [] }],
  ] as Array<[JobRefusalMetadata]>)('an ineligible stored refusal does not authorize the generation', (refusal) => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    storedRefusalRecovery(storage, ids, root, 'human', refusal)
    const candidate = implementation(storage, ids, `repair:${root.id}:1`)
    const { review } = changesRequested(storage, ids, candidate)

    expect(rejectionReason(storage, candidate, review))
      .toContain('not inside a human-authorized generation')
  })

  it('a refusal for another Task does not authorize the candidate Task', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    const candidate = implementation(storage, ids, `repair:${root.id}:1`)

    const otherTask = storage.tasks.create({
      projectId: ids.projectId,
      title: 'Other',
      description: 'd',
      status: 'blocked',
      assignee: 'developer_ai',
      dependencies: [],
      allowedPaths: ['apps/api/src/pl'],
    } as never)
    const otherIds = { taskId: otherTask.id, projectId: ids.projectId }
    const otherRoot = implementation(storage, otherIds, `task:${otherTask.id}:initial-implement`)
    storedRefusalRecovery(storage, otherIds, otherRoot, 'human')

    const { review } = changesRequested(storage, ids, candidate)
    expect(rejectionReason(storage, candidate, review))
      .toContain('not inside a human-authorized generation')
  })

  it('a refusal for another implementation in the same Task does not authorize the root', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    const unrelated = implementation(storage, ids, `task:${ids.taskId}:unrelated-implement`)
    storedRefusalRecovery(storage, ids, unrelated, 'human')
    const candidate = implementation(storage, ids, `repair:${root.id}:1`)
    const { review } = changesRequested(storage, ids, candidate)

    expect(rejectionReason(storage, candidate, review))
      .toContain('not inside a human-authorized generation')
  })

  it('a later unrelated refusal cannot authorize a normal repair generation started while pending', () => {
    const storage = createSQLiteStorage(':memory:')
    const ids = seed(storage)
    storage.tasks.update(ids.taskId, { status: 'in_progress' })
    const root = implementation(storage, ids, `task:${ids.taskId}:initial-implement`)
    const normalReview = changesRequested(storage, ids, root)
    createAdmissionRun(storage, ids, root)
    advanceTime()
    const candidate = implementation(storage, ids, `repair:${root.id}:1`)

    storage.tasks.update(ids.taskId, { status: 'blocked' })
    advanceTime()
    // This separate review recovery concerns the same old root, but happened only after the
    // ordinary generation had already started. It cannot retroactively authorize that generation.
    const refusedResume = reviewJob(storage, ids, `resume:${normalReview.reviewJob.id}:1`)
    recordAuthority(storage, refusedResume, 'human')
    storage.jobs.update(refusedResume.id, {
      status: 'failed',
      exitCode: 1,
      stderr: 'Prompt refused by the pre-send secret scan',
      failureMetadata: { refusal: ELIGIBLE_REFUSAL, workspaceState: 'unchanged' },
    } as never)
    const { review } = changesRequested(storage, ids, candidate)

    expect(rejectionReason(storage, candidate, review))
      .toContain('not inside a human-authorized generation')
  })
})
