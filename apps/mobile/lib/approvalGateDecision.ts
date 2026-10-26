/**
 * `PATCH /api/approval-requests/:id/status`（human-only の承認・却下の口）へ送る path と body。
 *
 * 承認一覧（`app/approvals.tsx`）と Task 画面のワンタップ中止（`lib/taskAbort.ts`）が同じ body を送るように、
 * ここだけで組み立てる。authority は API 側（human-only route・approval_actor=human の記録）にあり、
 * Mobile は body の形を変えない。
 */

import type { ApprovalGateStatus } from '@ai-team/shared'

export type ApprovalGateDecisionStatus = Extract<ApprovalGateStatus, 'APPROVED' | 'REJECTED'>

export function approvalGateDecisionPath(requestId: string): string {
  return `/api/approval-requests/${requestId}/status`
}

export function buildApprovalGateDecisionBody(
  status: ApprovalGateDecisionStatus,
  reason?: string,
): { reason?: string; status: ApprovalGateDecisionStatus } {
  return { reason, status }
}
