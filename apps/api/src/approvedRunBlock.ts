/**
 * **承認後の実行が blocked で終わったとき、Worker が実際に送った証拠だけから原因を分類する**（D2・Codex round 2）。
 *
 * Worker は gate の block 理由（gatePolicy / gateBlockReason）を結果 payload に載せない
 * （送っているのは guardResult・stderr・failureMetadata）。よって API が言えるのは:
 *
 *   - `permissionAllowed === false` … Permission Guard の拒否（例: once grant 使用済み）
 *   - `fileChangeAllowed === false` … File Change Guard の違反
 *   - quarantine … workspace の隔離（別の既存経路が扱う）
 *   - 両 Guard が通過と報告され quarantine でもない … 実行前の Gate 段階で止まった
 *     （gate/check の後に Worker 側の gate policy が拒んだ、または consume に失敗した）
 *   - guardResult が無い … 分からない
 *
 * 保存（`jobs.update`）と PL triage（rule 6.9）は**同じこの関数**で判定する。原因を推測で書かない。
 */

import type { Job } from '@ai-team/shared'

export type ApprovedRunBlockCause =
  | 'permission_denied'
  | 'file_change_guard'
  | 'workspace_quarantined'
  | 'gate_refusal'
  | 'unknown'

export function classifyApprovedRunBlock(
  job: Pick<Job, 'guardResult' | 'failureMetadata'>,
): ApprovedRunBlockCause {
  if (job.failureMetadata?.quarantined === true) return 'workspace_quarantined'
  const guard = job.guardResult
  if (guard === undefined) return 'unknown'
  if (guard.permissionAllowed === false) return 'permission_denied'
  if (guard.fileChangeAllowed === false) return 'file_change_guard'
  if (guard.permissionAllowed === true && guard.fileChangeAllowed === true) return 'gate_refusal'
  return 'unknown'
}

/**
 * 原因ごとの停止理由（attention detail は末尾 200 字なので短く保つ）。Worker の stderr が空のときだけ使う。
 * 事実として言えることだけを書く。gate_refusal で「どの policy か」は Worker が送らないので断定しない。
 */
export function describeApprovedRunBlock(
  cause: ApprovedRunBlockCause,
  input: { approvalId: string; kind: string; permissionReason?: string; fileViolations?: readonly string[] },
): string {
  const clip = (value: string) => (value.length <= 120 ? value : `${value.slice(0, 117)}...`)
  switch (cause) {
    case 'gate_refusal':
      return `approved_but_worker_blocked: approval ${input.approvalId} is APPROVED and unconsumed; guards passed`
        + ` but the Worker gate step blocked ${input.kind} (e.g. safe_work_only or consume failure)`
    case 'permission_denied':
      return `approved_run_permission_denied: ${clip(input.permissionReason ?? 'permission guard denied the command')}`
    case 'file_change_guard':
      return `approved_run_file_change_guard: ${clip((input.fileViolations ?? []).join(', ') || 'file change guard violation')}`
    case 'workspace_quarantined':
      return 'approved_run_blocked: workspace quarantined'
    case 'unknown':
      return `approved_run_blocked: approval ${input.approvalId} is APPROVED; the Worker reported blocked without a guard result`
  }
}
