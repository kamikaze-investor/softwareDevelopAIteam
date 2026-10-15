import type { ApprovalRequest, Job } from '@ai-team/shared'

export interface LinkedGitCommitRejectionLookup {
  findJobById(id: string): Job | undefined
  findApprovalById(id: string): ApprovalRequest | undefined
}

export interface LinkedGitCommitRejection {
  ownerJob: Job
  approval: ApprovalRequest
}

/**
 * Resolve the rejected `git_commit` approval owned by a Job.
 *
 * The default preserves the existing blocked-triage/resume behavior: when a
 * resumed `git_commit` has no link of its own, exactly one `resume:<id>:1`
 * hop may inherit the source Job's link. Callers that release ownership must
 * pass `directOnly`; that path never infers approval provenance.
 */
export function resolveLinkedGitCommitRejection(
  job: Job,
  lookup: LinkedGitCommitRejectionLookup,
  options: { directOnly?: boolean } = {},
): LinkedGitCommitRejection | undefined {
  if (job.safeCommand.kind !== 'git_commit') return undefined

  let ownerJob = job
  if (!job.approvalId) {
    if (options.directOnly === true) return undefined
    const resumed = /^resume:([^:]+):1$/.exec(job.workflowStepKey ?? '')
    if (!resumed) return undefined
    const source = lookup.findJobById(resumed[1] as string)
    if (!source || !source.approvalId) return undefined
    if (source.taskId !== job.taskId || source.projectId !== job.projectId) return undefined
    if (source.safeCommand.kind !== 'git_commit') return undefined
    ownerJob = source
  }

  const approvalId = ownerJob.approvalId
  if (!approvalId) return undefined
  const approval = lookup.findApprovalById(approvalId)
  if (!approval) return undefined
  if (approval.id !== approvalId) return undefined
  if (approval.taskId !== ownerJob.taskId) return undefined
  if (approval.requestedAction !== 'git_commit') return undefined
  if (approval.status !== 'REJECTED') return undefined
  return { ownerJob, approval }
}
