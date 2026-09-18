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
 * ## 試行の有界性について（**新しい上限値を作らない**）
 *
 * CEO 決定は「試行回数を有界化する」と要求している。これを**新しいマジックナンバーでは
 * 実現しない**。有界性は次の3つで既に成立しており、独自の上限はむしろ害になる。
 *
 * **1. 入口条件そのものが idempotency guard である。** 受理するのは
 * 「`blocked` かつ Job 0 件」だけで、成功すると Task は `pending` になる。もう一度
 * 呼ぶには、システムが**独立に**この dead state へ再突入していなければならない。
 * 再突入経路は `failContinuation()` だけで、それは producer が動いた
 * （= Design Review なり Gate 判定なりが実際に走った）ことを意味する。
 * つまり「同じ instruction の連打」は構造的に成立しない。
 *
 * **2. 自動ループ側の予算には一切触れない。** この関数は Job も Review も作らないので、
 * `PL_MAX_REMEDIATION_ATTEMPTS` / `PL_MAX_ATTEMPTS_PER_TARGET` /
 * `DESIGN_REVIEW_MAX_ATTEMPTS` のどれも消費せず、リセットもしない。
 * 再投入しても自動ループが無限化しないのはこのためである。
 *
 * **3. 却下済み spec の履歴を消さない。** #255 の `isMateriallyDifferentSpec()` が参照する
 * 却下履歴は `audit_log` の `remediate:<taskId>` 行にあり、この関数は読みも書きもしない。
 * 再投入は「却下された案をもう一度通す」経路にならない。
 *
 * ## 生涯上限を**置いてはならない**理由（実測・2026-09-18）
 *
 * `syncRoadmapTasks()` の spec 更新条件は
 * `isUnstarted = taskJobs.length === 0 && existingTask.status === 'pending'` である。
 * **`blocked` の Task を採用し直すと、「着手済み Task の spec 変更」と判定されて
 * `SYNC_FAILED` で失敗する**（`Roadmap task spec conflicts detected for started/completed tasks`）。
 * したがって「訂正した implementationScope / allowedPaths で採用し直す」復旧は、
 * **先に Human Recovery で `pending` へ戻さなければ成立しない**。
 * ここに生涯上限を置くと、上限に達した Task は**訂正版の spec を適用する経路ごと失われる**。
 * 「N 回を超えたら二度と復旧不能」にすることは目的ではない。
 *
 * 回数は**数えて返すが、門にはしない**（`attempt`）。連打の有無は audit から後で数えられる。
 */

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

  // 回数は記録と報告のためだけに数える。**門にはしない**（上の「試行の有界性」参照）。
  const priorAttempts = countHumanRecoveryAttempts(storage, task.id)

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
