import type { ApprovalRequest, Job } from '@ai-team/shared'

export interface LinkedGitCommitRejectionLookup {
  findApprovalById(id: string): ApprovalRequest | undefined
}

export interface LinkedGitCommitRejection {
  ownerJob: Job
  approval: ApprovalRequest
}

/**
 * Resolve the rejected `git_commit` approval **directly** linked to a Job.
 *
 * Used only by the manual abort (release) path, which must never infer approval
 * provenance. Blocked triage and resume use the lineage-aware resolver
 * (`isLinkedGitCommitRejection()` in storage / `gatherFacts()` in blockedTriage),
 * which follows the fixed-anchor generation or the legacy single hop.
 */
export function resolveLinkedGitCommitRejection(
  job: Job,
  lookup: LinkedGitCommitRejectionLookup,
): LinkedGitCommitRejection | undefined {
  if (job.safeCommand.kind !== 'git_commit') return undefined
  const approvalId = job.approvalId
  if (!approvalId) return undefined
  const approval = lookup.findApprovalById(approvalId)
  if (!approval) return undefined
  if (approval.id !== approvalId) return undefined
  if (approval.taskId !== job.taskId) return undefined
  if (approval.requestedAction !== 'git_commit') return undefined
  if (approval.status !== 'REJECTED') return undefined
  return { ownerJob: job, approval }
}
