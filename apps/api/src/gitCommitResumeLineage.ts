import type { Job } from '@ai-team/shared'

const CANONICAL_GIT_COMMIT_STEP_KEY = /^review:[^:]+:git-commit$/
const GIT_COMMIT_RESUME_STEP_KEY = /^resume:([^:]+):([1-9]\d*)$/

export function isCanonicalGitCommitAnchor(job: Job): boolean {
  return job.safeCommand.kind === 'git_commit'
    && CANONICAL_GIT_COMMIT_STEP_KEY.test(job.workflowStepKey ?? '')
}

export function parseGitCommitResumeStepKey(
  stepKey: string | undefined,
): { anchorJobId: string; generation: number } | undefined {
  const match = GIT_COMMIT_RESUME_STEP_KEY.exec(stepKey ?? '')
  if (!match) return undefined
  const generation = Number(match[2])
  if (!Number.isSafeInteger(generation) || generation <= 0) return undefined
  return { anchorJobId: match[1] as string, generation }
}

export function gitCommitResumeStepKey(anchorJobId: string, generation: number): string {
  return `resume:${anchorJobId}:${generation}`
}

export type GitCommitResumeLineageValidation =
  | {
      ok: true
      anchorJob: Job
      currentGeneration: number
      highestGeneration: number
      nextWorkflowStepKey: string
    }
  | { ok: false; reason: string }

/**
 * Validate the fixed-anchor generation set without following a Job-to-Job chain.
 *
 * `anchorJob` is loaded by exact id once by the caller. Generation rows are then
 * checked as a set so duplicate and missing generations fail closed. This is not
 * an ancestry resolver: no generation row is dereferenced to find another row.
 */
export function validateGitCommitResumeLineage(input: {
  currentJob: Job
  anchorJob: Job | undefined
  taskJobs: readonly Job[]
  requireCurrentIsLatestGeneration: boolean
}): GitCommitResumeLineageValidation {
  const { currentJob, anchorJob, taskJobs } = input
  if (currentJob.safeCommand.kind !== 'git_commit') {
    return { ok: false, reason: 'resume lineage current Job is not git_commit' }
  }

  const parsedCurrent = parseGitCommitResumeStepKey(currentJob.workflowStepKey)
  const currentGeneration = isCanonicalGitCommitAnchor(currentJob)
    ? 0
    : parsedCurrent?.generation
  if (currentGeneration === undefined) {
    return {
      ok: false,
      reason: `git_commit workflowStepKey is neither a canonical anchor nor resume:<anchor>:<positive integer> (got ${currentJob.workflowStepKey ?? 'none'})`,
    }
  }

  if (!anchorJob) {
    return {
      ok: false,
      reason: `git_commit resume anchor ${parsedCurrent?.anchorJobId ?? currentJob.id} not found`,
    }
  }
  if (parsedCurrent !== undefined && anchorJob.id !== parsedCurrent.anchorJobId) {
    return { ok: false, reason: 'git_commit resume anchor does not match the workflowStepKey' }
  }
  if (!isCanonicalGitCommitAnchor(anchorJob)) {
    return {
      ok: false,
      reason: `git_commit resume anchor ${anchorJob.id} is not a canonical review:<id>:git-commit Job`,
    }
  }
  if (anchorJob.taskId !== currentJob.taskId) {
    return { ok: false, reason: 'git_commit resume anchor belongs to a different task' }
  }
  if (anchorJob.projectId !== currentJob.projectId) {
    return { ok: false, reason: 'git_commit resume anchor belongs to a different project' }
  }

  const generations = new Map<number, Job[]>()
  for (const job of taskJobs) {
    const parsed = parseGitCommitResumeStepKey(job.workflowStepKey)
    if (!parsed || parsed.anchorJobId !== anchorJob.id) continue
    const rows = generations.get(parsed.generation) ?? []
    rows.push(job)
    generations.set(parsed.generation, rows)
  }

  const highestGeneration = generations.size === 0
    ? 0
    : Math.max(...generations.keys())
  for (let generation = 1; generation <= highestGeneration; generation += 1) {
    const rows = generations.get(generation) ?? []
    if (rows.length === 0) {
      return {
        ok: false,
        reason: `git_commit resume lineage has a missing generation ${generation} for anchor ${anchorJob.id}`,
      }
    }
    if (rows.length !== 1) {
      return {
        ok: false,
        reason: `git_commit resume lineage has duplicate generation ${generation} for anchor ${anchorJob.id}`,
      }
    }
    const row = rows[0] as Job
    if (row.taskId !== anchorJob.taskId || row.projectId !== anchorJob.projectId) {
      return {
        ok: false,
        reason: `git_commit resume generation ${generation} belongs to a different task or project`,
      }
    }
    if (row.safeCommand.kind !== 'git_commit') {
      return {
        ok: false,
        reason: `git_commit resume generation ${generation} is ${row.safeCommand.kind}, not git_commit`,
      }
    }
  }

  if (currentGeneration > 0) {
    const currentRows = generations.get(currentGeneration) ?? []
    if (currentRows.length !== 1 || currentRows[0]?.id !== currentJob.id) {
      return {
        ok: false,
        reason: `current Job is not the unique git_commit resume generation ${currentGeneration}`,
      }
    }
  } else if (highestGeneration > 0) {
    return {
      ok: false,
      reason: `git_commit resume generation 1 already exists for anchor ${anchorJob.id}`,
    }
  }

  if (input.requireCurrentIsLatestGeneration && currentGeneration !== highestGeneration) {
    return {
      ok: false,
      reason: `current git_commit resume generation ${currentGeneration} is not latest generation ${highestGeneration}`,
    }
  }
  if (highestGeneration === Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: 'git_commit resume generation exceeds the safe integer range' }
  }

  return {
    ok: true,
    anchorJob,
    currentGeneration,
    highestGeneration,
    nextWorkflowStepKey: gitCommitResumeStepKey(anchorJob.id, highestGeneration + 1),
  }
}

export function exactGitCommitResumePredecessor(input: {
  successor: Job
  lineage: Extract<GitCommitResumeLineageValidation, { ok: true }>
  taskJobs: readonly Job[]
}): Job | undefined {
  const parsed = parseGitCommitResumeStepKey(input.successor.workflowStepKey)
  if (!parsed || parsed.anchorJobId !== input.lineage.anchorJob.id) return undefined
  if (parsed.generation === 1) return input.lineage.anchorJob

  const predecessorKey = gitCommitResumeStepKey(parsed.anchorJobId, parsed.generation - 1)
  const predecessors = input.taskJobs.filter((job) => job.workflowStepKey === predecessorKey)
  return predecessors.length === 1 ? predecessors[0] : undefined
}
