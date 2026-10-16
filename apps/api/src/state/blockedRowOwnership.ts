/**
 * blocked 行が、観測なしで共有 workspace の所有者と確定するか — API 側の唯一の判定。
 *
 * **claim guard（`jobs.update` queued→running）・`activeLifecycleKindsOf`（archive / draft の拒否）・
 * systemState の `workspace_held_by_stalled_owner`・`reconcileExternalCompletion` の拒否は
 * すべてここを使う。** 所有の意味を呼び出し側で書き直さない（2026-09-17 の abort 事故と同じ構図を防ぐ）。
 *
 * 1. shared の `holdsWorkspaceWhenBlocked()` に、Task の park 状態（`ITaskStorage.isParked()`）を
 *    渡す。done / park された Task の非 quarantine 行は stale 候補で、所有者ではなく
 *    「観測しないと決められない」行である。観測は Worker（clean worktree・HEAD 解決可能・git 操作
 *    なしを確認して初めて解放）と、次の initial implement の `computeWorkspaceBaseline` admission
 *    （dirty なら fail-closed）が担う。Worker も同じ述語を `GET /api/tasks` の `parked` で評価する。
 * 2. Human Resume で後継が作られた旧行（`readJobsSupersededByHumanResume`）は除く。
 *    **ただし quarantine 行は除かない**（quarantine が優先）。startup reconciliation は quarantine 行を
 *    意図的に blocked のまま残し、Worker はすべての quarantine 行を所有者として扱うので、
 *    ここで除くと API と Worker の所有者がずれる。
 */

import { holdsWorkspaceWhenBlocked } from '@ai-team/shared'
import type { Job, Task } from '@ai-team/shared'
import { readJobsSupersededByHumanResume } from '../designReview/resumeActor'
import type { IStorage } from '../storage/interface'

export function findBlockedRowsHoldingWorkspace(
  storage: IStorage,
  task: Task,
  jobs: readonly Job[],
): Job[] {
  if (!jobs.some((job) => job.status === 'blocked')) return []
  const subject = { status: task.status, parked: storage.tasks.isParked(task.id) }
  const superseded = readJobsSupersededByHumanResume(storage, jobs)
  return jobs.filter((job) => (
    holdsWorkspaceWhenBlocked(subject, job)
    && (job.failureMetadata?.quarantined === true || !superseded.has(job.id))
  ))
}
