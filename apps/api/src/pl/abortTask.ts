/**
 * abort_task — 未完了 Task を「完了したことにせず」park する。
 *
 * **これは復旧でも完了でもない。** 「この Task はいま進められないので、PL 全体を止めないよう
 * 現役から外す」だけの操作である。Roadmap 項目の残作業は消えず、後で follow-up 採用（#233）が
 * 別 Task identity として再開する。**ここで follow-up を作らない。**
 *
 * ## 作っていないもの
 *
 * 新しい action 語彙（`abort_task` は `PL_ACTION_KINDS` に既存）/ 新しい Gate
 * （必要 Gate は既存 `ACTION_GATE_TABLE` が `approval_gate` と決めている）/ 新しい TaskStatus /
 * `aborted` フラグ / Job cancellation 機構 / 新しい workflow。
 * 足しているのは **policy と実操作をつなぐ executor 1本**だけである。
 *
 * ## park の実体は `roadmapActive=false` ただ1つ
 *
 * status は触らない（`done` にすると受入条件を満たしたと読めてしまう）。Job 履歴も消さない。
 * `roadmapActive=false` にすると:
 *   - `occupiesProject()` が false を返し、`currentTask` から外れる
 *   - `selectNextContinuableTask()` / `isReadyTaskWithoutJob()` が選ばない
 *   - park 済み Task の blocked / failed 履歴は attention から外れ、PL 全体を止めない
 *   - `syncRoadmapTasks()` は着手済み Task を再活性化しない
 *
 * ## live Job があるときは park しない（fail-closed）
 *
 * `roadmapActive` は Worker の claim 条件に**入っていない**。Worker は running Project の全 Task を
 * 走査して queued Job を拾うため、park しても queued Job が残っていれば実行される。
 * 「止めたつもりで動いている」状態を作らないため、live Job があるうちは拒否し、
 * 既存の Job 停止・失敗処理を先に終わらせてもらう。**ここで Job を止める機構は作らない。**
 */

import { isLiveJob } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import { authorizePlAction, PlActionBlockedError } from './actionGate'

/** 監査記録の語彙。既存 `audit_log` をそのまま使う。 */
const AUDIT_OPERATION = 'task_aborted'
const AUDIT_ENTITY_TYPE = 'task'

export interface AbortTaskInput {
  taskId: string
  /** 対象 Task に紐づく APPROVED な ApprovalRequest。CEO の承認操作の実体。 */
  approvalRequestId: string
  /** なぜ park するのか。audit に残す。 */
  reason: string
  /** 記録用。省略時は 'api'。 */
  actor?: string
}

export type AbortTaskResult =
  | { ok: true; taskId: string }
  | {
    ok: false
    code:
      | 'TASK_NOT_FOUND'
      | 'TASK_ALREADY_DONE'
      | 'TASK_NOT_PARKABLE'
      | 'TASK_NOT_ACTIVE'
      | 'LIVE_JOB_PRESENT'
      | 'NOT_AUTHORIZED'
    reason: string
    details?: unknown
  }

export function abortTask(storage: IStorage, input: AbortTaskInput): AbortTaskResult {
  const task = storage.tasks.findById(input.taskId)
  if (!task) {
    return { ok: false, code: 'TASK_NOT_FOUND', reason: `Task ${input.taskId} does not exist` }
  }

  // 完了済みを park しても意味が無い。履歴を書き換える操作にしない。
  if (task.status === 'done') {
    return { ok: false, code: 'TASK_ALREADY_DONE', reason: `Task ${input.taskId} is already done` }
  }

  // **park が実際に効く status に限る。**
  //
  // `occupiesProject()` は `in_progress` / `blocked` を `roadmapActive` に関係なく占有と数える
  // （#233 で独立レビューを経て固定した契約）。したがってその2つを park しても `currentTask` から
  // 外れず、PL は進めない。**半分だけ効く操作にはしない。** それらは既存の resume /
  // fail-stuck-job 経路が扱う。
  if (task.status !== 'pending') {
    return {
      ok: false,
      code: 'TASK_NOT_PARKABLE',
      reason:
        `Task ${input.taskId} is ${task.status}; parking only takes effect for a pending task. `
        + 'Use the existing resume / fail-stuck-job path for work that is underway or blocked',
    }
  }

  // 既に park 済みなら何もしない。冪等な no-op ではなく、意図が食い違っているので明示的に断る。
  if (task.roadmapActive !== true) {
    return {
      ok: false,
      code: 'TASK_NOT_ACTIVE',
      reason: `Task ${input.taskId} is not roadmap-active; there is nothing to park`,
    }
  }

  // **live Job があるうちは park しない。** Worker は roadmapActive を見ずに queued Job を拾う。
  const liveJobs = storage.jobs.findByTaskId(task.id).filter((job) => isLiveJob(job))
  if (liveJobs.length > 0) {
    return {
      ok: false,
      code: 'LIVE_JOB_PRESENT',
      reason:
        `Task ${input.taskId} still has ${liveJobs.length} queued or running job(s) `
        + `(${liveJobs.map((job) => `${job.id}:${job.status}`).join(', ')}); `
        + 'let the existing job stop / fail handling finish before parking',
    }
  }

  // ── Mandatory Gate。許可を得る経路はここだけで、判定は提案から作り直される ──
  try {
    authorizePlAction(storage, {
      proposal: { kind: 'abort_task' },
      target: { kind: 'task', taskId: task.id },
      evidence: [{ gate: 'approval_gate', approvalRequestId: input.approvalRequestId }],
    })
  } catch (error: unknown) {
    if (error instanceof PlActionBlockedError) {
      return {
        ok: false,
        code: 'NOT_AUTHORIZED',
        reason: error.message,
        details: { missingGates: error.missingGates, rejectedEvidence: error.rejectedEvidence },
      }
    }
    throw error
  }

  // ── park。触るのは roadmapActive だけ ──
  storage.tasks.update(task.id, { roadmapActive: false })

  storage.auditLog.record({
    actor: 'api',
    operation: AUDIT_OPERATION,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: task.id,
    result: 'success',
    detail:
      `parked by ${input.actor ?? 'api'} (status kept as ${task.status}, `
      + `approval ${input.approvalRequestId}): ${input.reason.slice(0, 300)}`,
  })

  return { ok: true, taskId: task.id }
}
