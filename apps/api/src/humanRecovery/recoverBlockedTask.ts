/**
 * Human Recovery — Job を1件も持たないまま `blocked` で止まった Task を、
 * 人の明示的な操作で**既存の実行ループへ戻すだけ**の一歩。
 *
 * ## なぜ必要か（実測）
 *
 * `failContinuation()`（`ctoAi/taskContinuation.ts`）は、continuation の producer
 * （`createInitialImplementWorkflow()`）が非 retryable に skip したとき Task を `blocked` にする。
 * Design Review が非 ALIGNED（CONFLICT 等）を返した場合がこれに当たり、**Job は1件も作られない**。
 *
 * この状態は3経路すべてから外れる（2026-09-18 実測。`:memory:` storage に同じ状態を作って確認）:
 *   - **可視性**: `systemState.ts` の attention は全9箇所が Job か `status='pending'` を要求するため
 *     `attention = []` になる。`isReadyTaskWithoutJob()` は `status === 'pending'` を要求する
 *   - **人手**: `resumeBlockedTask()` は latestJob から新 Job を組み立てる実質 Job 複製関数であり、
 *     Job が0件だと `No jobs exist for this task` で必ず失敗する
 *   - **AI 自動**: `findRemediationSubject()`（PR #255 の Independent Remediation）も
 *     `status === 'pending'` を要求するため、**同じ CONFLICT でも continuation 経由で来たものは
 *     新しい staged recovery flow に届かない**
 *
 * さらに `occupiesProject()` は `blocked` を `roadmapActive` に関係なく占有と数えるため、
 * この Task は単一 running Project の枠を保持したまま、誰にも見えず止まり続ける。
 *
 * ## この操作がやること・やらないこと
 *
 * やるのは **`blocked` → `pending` の遷移と audit 記録だけ**である。
 * Job も Review も Approval も作らない。遷移が戻すのは「既存経路から見えること」であり、
 * その先は従来どおり:
 *   - `task_ready_without_job` attention が立つ（PL は notify-only）
 *   - roadmap 採用 Task なら `findRemediationSubject()` の対象に戻り、PR #255 の
 *     Independent Remediation が提案を作り直して**まっさらな Design Review**へ掛ける
 *   - その Review が ALIGNED になって初めて implement Job が作られる
 *
 * **fresh Design Review を省略する経路にはならない。** Job 生成の門は
 * `checkImplementJobDesignReviewEvidence()` のままで、ここは一切触れていない。
 *
 * ## 権限（CEO 決定・2026-09-18）
 *
 * > Human Recovery には up-front CEO Approval Gate を課さない。
 * > 認証済み CEO による明示的な Recovery 操作そのものを human authorization とする。
 * > Human Recovery は Job 0 件の blocked Task を既存ループへ再投入するだけに限定し、
 * > Implementation Job を直接生成せず、fresh Design Review および既存の全下流 Gate を必須とする。
 * > AI/PL による自律呼び出しにはこの例外を適用しない。操作は audit 記録し、試行回数を有界化する。
 *
 * 「AI/PL に適用しない」は**構造で担保する**:
 *   1. **新しい `PlActionKind` を作らない。** PL の語彙に入らないので
 *      `resolvePlActionPolicy()` は未知値として `forbidden` を返す
 *   2. **`executeAction()` / `allowedActionsFor()` に配線しない。** PL は自分自身へ HTTP を
 *      打たないため、in-process の PL からこの関数へ到達する経路が存在しない
 *   3. **`WORKER_ALLOWLIST` に載せない。** split credential mode では WORKER credential からの
 *      呼び出しが Default Deny で 403 になる（`auth/workerAllowlist.ts`）
 *
 * したがってこの関数は `authorizePlAction()` を通さない。**迂回ではない** ——
 * Mandatory Gate Policy は「PL の操作案に必要 Gate を決める入口」であり、
 * PL が提案できない操作はその管轄外である。ここでの authorization は ADMIN credential と
 * 人の明示的な呼び出しそのものである。
 */

import type { IStorage } from '../storage/interface'
import type { Task } from '@ai-team/shared'
import {
  countRemediationAttempts,
  findRemediationSubject,
  PL_MAX_REMEDIATION_ATTEMPTS,
} from '../pl/remediationStep'

/**
 * 1つの Task を Human Recovery できる回数。
 *
 * **新しいテーブルを作らず既存 `audit_log` から数える**（`isParkedTaskId()` が
 * `task_aborted` 行を読んで park を判定しているのと同じ形）。
 *
 * 実質的には Task の生涯で1回しか効かない上限である: 一度 recover して implement Job が
 * 作られると、以後この関数は `TASK_HAS_JOBS` で断り既存 `resumeBlockedTask()` 経路へ回すため、
 * 「Job 0 件の blocked」という入口条件が二度と成立しなくなる。上限が意味を持つのは
 * **recover しても Review が通らず、また Job 0 件で blocked へ戻る**場合であり、
 * そこで無制限に押し直せないようにするのがこの値の役割である。
 */
export const MAX_HUMAN_RECOVERY_ATTEMPTS = 3

/** audit_log の語彙。**新しいテーブルも metrics backend も作らない。** */
export const HUMAN_RECOVERY_AUDIT_OPERATION = 'task_human_recovered'
export const HUMAN_RECOVERY_AUDIT_ENTITY_TYPE = 'task'

export interface RecoverBlockedTaskInput {
  taskId: string
  /** なぜ再投入するのか。audit に残す。 */
  reason: string
}

/**
 * 再投入した後、実際に何がこの Task を動かすのか。
 *
 * **この関数は Job を作らない**ので、呼び出し側（Mobile / 運用者）に「次に何が起きるか」を
 * 正直に返す必要がある。推測ではなく、PR #255 の導出関数をそのまま呼んで判定する。
 */
export type HumanRecoveryNextDriver =
  /** PL の Independent Remediation が提案を作り直し、fresh Design Review へ掛ける。 */
  | 'pl_independent_remediation'
  /** 自動で進める経路は無い。attention が立ち、PL は CEO へ通知するだけ。 */
  | 'attention_only'

export type RecoverBlockedTaskResult =
  | {
    ok: true
    taskId: string
    task: Task
    /** 今回が何回目の Human Recovery か（1 起算）。 */
    attempt: number
    nextDriver: HumanRecoveryNextDriver
  }
  | {
    ok: false
    code:
      | 'TASK_NOT_FOUND'
      | 'PROJECT_UNAVAILABLE'
      | 'TASK_NOT_BLOCKED'
      | 'TASK_HAS_JOBS'
      | 'TASK_PARKED'
      | 'RECOVERY_BUDGET_EXHAUSTED'
      | 'RECOVERY_FAILED'
    reason: string
  }

/** この Task に対して既に記録された Human Recovery の回数。 */
export function countHumanRecoveryAttempts(storage: IStorage, taskId: string): number {
  return storage.auditLog
    .findByEntity(HUMAN_RECOVERY_AUDIT_ENTITY_TYPE, taskId)
    .filter((entry) => entry.operation === HUMAN_RECOVERY_AUDIT_OPERATION && entry.result === 'success')
    .length
}

/**
 * 再投入後に、この Task を自動で動かせる経路があるか。
 *
 * 判定は PR #255 の導出をそのまま呼ぶ。**ここに条件を書き写さない** ——
 * 2箇所に書くと必ずずれる（`remediationStep.ts` 側にも同じ注意が書かれている）。
 */
function resolveNextDriver(storage: IStorage, taskId: string): HumanRecoveryNextDriver {
  if (findRemediationSubject(storage, taskId) === undefined) return 'attention_only'
  if (countRemediationAttempts(storage, taskId) >= PL_MAX_REMEDIATION_ATTEMPTS) return 'attention_only'
  return 'pl_independent_remediation'
}

export function recoverBlockedTask(
  storage: IStorage,
  input: RecoverBlockedTaskInput,
): RecoverBlockedTaskResult {
  const task = storage.tasks.findById(input.taskId)
  if (!task) {
    return { ok: false, code: 'TASK_NOT_FOUND', reason: `Task ${input.taskId} does not exist` }
  }

  const project = storage.projects.findById(task.projectId)
  if (!project || project.status === 'archived') {
    return {
      ok: false,
      code: 'PROJECT_UNAVAILABLE',
      reason: `Task ${input.taskId} belongs to a project that is missing or archived`,
    }
  }

  // **`blocked` 以外は対象にしない。** `pending` は既に再投入済みか、そもそも止まっていない。
  if (task.status !== 'blocked') {
    return {
      ok: false,
      code: 'TASK_NOT_BLOCKED',
      reason: `Task ${input.taskId} is ${task.status}, not blocked; there is nothing to re-admit`,
    }
  }

  // **Job があるものはこの経路の責務ではない。** 既存 `resumeBlockedTask()` が
  // quarantine / 承認待ち / Design Review evidence の門を持っており、
  // ここで二重の復旧経路を作ると門の数だけ挙動が分岐する。
  const jobs = storage.jobs.findByTaskId(task.id)
  if (jobs.length > 0) {
    return {
      ok: false,
      code: 'TASK_HAS_JOBS',
      reason:
        `Task ${input.taskId} already has ${jobs.length} job(s); `
        + 'use the existing POST /api/tasks/:id/resume path, which carries the quarantine, '
        + 'approval and design-review-evidence gates for a task that has already executed',
    }
  }

  // park の解除は CEO の別判断（`abort_task` の取り消し）であり、復旧の副作用で起きてよくない。
  // 既存 `PATCH /api/tasks/:id` が park された Task を占有状態へ戻さないのと同じ理由である。
  if (storage.tasks.isParked(task.id)) {
    return {
      ok: false,
      code: 'TASK_PARKED',
      reason:
        `Task ${input.taskId} was parked by abort_task; re-admitting it here would silently undo the park. `
        + 'Adopt the roadmap item again as a follow-up instead',
    }
  }

  const priorAttempts = countHumanRecoveryAttempts(storage, task.id)
  if (priorAttempts >= MAX_HUMAN_RECOVERY_ATTEMPTS) {
    return {
      ok: false,
      code: 'RECOVERY_BUDGET_EXHAUSTED',
      reason:
        `Task ${input.taskId} has already been recovered ${priorAttempts} time(s) `
        + `(limit ${MAX_HUMAN_RECOVERY_ATTEMPTS}) and keeps coming back blocked without a job. `
        + 'Re-adopt the roadmap item with a corrected implementationScope / allowedPaths, '
        + 'or correct the ledger text the review is reading, instead of re-admitting it unchanged',
    }
  }

  // ── ここから状態を変える ───────────────────────────────────
  const updated = storage.tasks.update(task.id, { status: 'pending' })
  if (!updated) {
    return { ok: false, code: 'RECOVERY_FAILED', reason: `Task ${input.taskId} could not be updated` }
  }

  // **audit は状態変更の後に、成功したときだけ記録する。**
  // `countHumanRecoveryAttempts()` がこの行を数えて上限を決めるため、
  // 遷移していないのに行が残ると予算だけが減る。
  storage.auditLog.record({
    actor: 'api',
    operation: HUMAN_RECOVERY_AUDIT_OPERATION,
    entityType: HUMAN_RECOVERY_AUDIT_ENTITY_TYPE,
    entityId: task.id,
    result: 'success',
    detail: `blocked -> pending by human recovery (attempt ${priorAttempts + 1}): ${input.reason}`,
  })

  return {
    ok: true,
    taskId: task.id,
    task: updated,
    attempt: priorAttempts + 1,
    // 遷移**後**の状態で判定する（`findRemediationSubject()` は `pending` を要求する）。
    nextDriver: resolveNextDriver(storage, task.id),
  }
}
