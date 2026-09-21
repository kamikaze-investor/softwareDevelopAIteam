/**
 * Human Recovery の audit 語彙と、そこからの読み取り。
 *
 * **`recoverBlockedTask.ts` から切り出してあるのは依存の向きのためである。**
 * `systemState.ts`（attention の導出）もこの語彙を必要とするが、
 * `recoverBlockedTask.ts` は `pl/remediationStep` を読み込むため、そのまま import させると
 * state 導出が PL 側の重い依存を引き込む。ここは `IStorage` の型以外に依存しない。
 *
 * **新しいテーブルは作らない。** park 判定が `audit_log` の `task_aborted` 行だけで成立して
 * いるのと同じ形で、再投入の履歴も `audit_log` にだけ存在する。
 */

import { occupiesProject, type ApprovalRequest, type Task } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'

/**
 * 再投入したとき、その Task を**自律ループが実際に拾えるか**。
 *
 * `blocked` の可視化（`task_blocked_without_job`）は `roadmapActive` を条件にしないが、
 * 遷移先で立つはずの `task_ready_without_job` は
 * `roadmapActive && assignee === 'developer_ai'` を要求する（`isReadyTaskWithoutJob()`）。
 * 満たさない Task を `pending` にすると、**いま出ている attention が消えて代わりが立たない**。
 *
 * **これは受理の可否を決める述語ではない。** 到達できない Task でも Human Recovery は
 * 受理する（`nextDriver = 'none'` を返す）—— 断ると `abort_task` も採用し直しも
 * `pending` を要求するため、**どこからも動かせない Task** が残るからである。
 * 旧 `TASK_NOT_REACHABLE` 設計の名残りをここに書き戻さないこと。
 *
 * **定義はここ1箇所だけに置く。** いま共有しているのは次の2つで、どちらも
 * 「戻した**後**に何が起きるか」の説明である:
 *
 *   1. `predictHumanRecoveryDriver()` —— 再投入後の `nextDriver` の判定
 *   2. `triageBlocked()` —— CEO へ出す「戻した後に何が動くか」の本文
 *
 * 2つが別々に条件を組み立てると、**案内が endpoint の返す値と食い違う**。
 */
export function isReachableByAutonomousLoop(
  task: Pick<Task, 'roadmapActive' | 'assignee'>,
): boolean {
  return task.roadmapActive === true && task.assignee === 'developer_ai'
}

/**
 * 再投入すると、この Task は **Project の枠を手放すか**。
 *
 * **到達可能性とは別の問いである。** `isReachableByAutonomousLoop()` は
 * `roadmapActive && assignee === 'developer_ai'` を見るが、枠の占有は
 * `occupiesProject()` が `roadmapActive` だけで決める。したがって
 * `roadmapActive=true` かつ `assignee='cto_ai'` の Task は
 * **到達できないのに枠も手放さない** —— 両者を同じ述語で語ると、
 * 「戻せば枠が空く」と嘘の案内をすることになる（独立レビュー round 4 指摘）。
 *
 * 規則を書き写さず `occupiesProject()` を遷移後の形へ当てて判定する。
 */
export function recoveryReleasesProjectSlot(task: Pick<Task, 'roadmapActive'>): boolean {
  return !occupiesProject({ status: 'pending', roadmapActive: task.roadmapActive })
}

/**
 * その Task に**有効な承認待ちがあるか**。あるなら別の復旧を同時に始めない。
 *
 * **既存 `resumeBlockedTask()` の不変条件をそのまま借りる。** 意味を広げも狭めもしない:
 *
 *   - 見るのは **`created_at` が最新の1行だけ**（`ORDER BY created_at DESC LIMIT 1`）
 *   - 拒否するのは `WAITING_FOR_USER` **かつ未期限**のときだけ
 *   - **`APPROVED` では拒否しない。** resume の現契約がそうであり、ここで拡張しない
 *   - **期限切れ `WAITING_FOR_USER` でも拒否しない。** 行を `EXPIRED` へ進める actor が
 *     居ないため、期限切れを承認待ちとして扱うと Task がどこからも復旧できなくなる
 *     （2026-09-12 に Production で実際に起きた。`sqlite.ts` の resume 側の注記を参照）
 *
 * これは**新しい Approval Gate ではない**。Human Recovery が承認を要求するようになった
 * わけではなく、**人の判断がすでに1件待っているときに2本目の駆動を始めない**という
 * 整合性条件である。放置すると `approval_waiting` と `task_ready_without_job` が同時に立ち、
 * PL は `approval_waiting` を先に処理するため、`/recover` が返した `nextDriver` と
 * 実際に進行を止めるものが食い違う（独立レビュー指摘・2026-09-21）。
 *
 * **純関数にしてあるのは、precheck と transaction 内の再確認が同じ判定を使うためである。**
 * 条件を2箇所へ書き写すと、片方だけ直したときに precheck と commit が食い違う。
 */
export function hasActiveApprovalWaiting(
  latestApproval: Pick<ApprovalRequest, 'status' | 'expiresAt'> | undefined,
  nowIso: string,
): boolean {
  if (latestApproval?.status !== 'WAITING_FOR_USER') return false
  return new Date(latestApproval.expiresAt) > new Date(nowIso)
}

/** 承認待ちで Human Recovery を断るときの理由文。precheck と transaction で同じ文を使う。 */
export const APPROVAL_WAITING_REASON =
  'An active approval request is waiting for human review; resolve it before recovering'

export const HUMAN_RECOVERY_AUDIT_OPERATION = 'task_human_recovered'
export const HUMAN_RECOVERY_AUDIT_ENTITY_TYPE = 'task'

/**
 * 直近に成功した Human Recovery の audit 行 id。まだ無ければ `undefined`。
 *
 * **回数を数えない。** CEO 決定（2026-09-18）は Human Recovery について
 * 「新しい attempt counter / table / 数字を追加しない」と定めている。
 * エピソードの識別に必要なのは「前回の再投入を指す安定した値」だけで、通し番号ではない ——
 * 既存 audit 行の id がちょうどそれである（再投入のたびに新しい行が1つ増え、
 * 次の再投入まで変わらない）。
 *
 * `findByEntity()` は `created_at DESC, rowid DESC` で返すので先頭が最新である。
 */
export function latestHumanRecoveryId(storage: IStorage, taskId: string): string | undefined {
  return storage.auditLog
    .findByEntity(HUMAN_RECOVERY_AUDIT_ENTITY_TYPE, taskId)
    .find((entry) =>
      entry.operation === HUMAN_RECOVERY_AUDIT_OPERATION && entry.result === 'success')
    ?.id
}
