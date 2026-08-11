import type { Approval, ApprovalRequest } from '@ai-team/shared'

import { apiFetch } from './api'

export type ApprovalWithProject = Approval & { projectName: string }

interface ApprovalsCache {
  approvalRequests: ApprovalRequest[] | null
  approvals: ApprovalWithProject[] | null
}

const approvalsCache: ApprovalsCache = {
  approvalRequests: null,
  approvals: null,
}

export function getApprovalsCache(): ApprovalsCache {
  return { ...approvalsCache }
}

export function setCachedApprovalRequests(
  approvalRequests: ApprovalRequest[],
): void {
  approvalsCache.approvalRequests = approvalRequests
}

export function setCachedApprovals(approvals: ApprovalWithProject[]): void {
  approvalsCache.approvals = approvals
}

export async function fetchPendingApprovals(): Promise<ApprovalWithProject[]> {
  const response = await apiFetch('/api/approvals/pending')

  if (!response.ok) {
    throw new Error(`Failed to fetch pending approvals: ${response.status}`)
  }

  return (await response.json()) as ApprovalWithProject[]
}

export async function fetchWaitingApprovalRequests(): Promise<ApprovalRequest[]> {
  const response = await apiFetch('/api/approval-requests/waiting')

  if (!response.ok) {
    throw new Error(`Failed to fetch approval requests: ${response.status}`)
  }

  return (await response.json()) as ApprovalRequest[]
}
