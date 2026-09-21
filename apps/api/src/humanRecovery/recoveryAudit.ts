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

import { occupiesProject, type Task } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'

/**
 * 再投入したとき、その Task を**自律ループが実際に拾えるか**。
 *
 * `blocked` の可視化（`task_blocked_without_job`）は `roadmapActive` を条件にしないが、
 * 遷移先で立つはずの `task_ready_without_job` は
 * `roadmapActive && assignee === 'developer_ai'` を要求する（`isReadyTaskWithoutJob()`）。
 * 満たさない Task を `pending` にすると、**いま出ている attention が消えて代わりが立たない**。
 *
 * **定義はここ1箇所だけに置く。** `recoverBlockedTask()`（受理の可否）と
 * `triageBlocked()`（CEO へ出す選択肢）が同じ述語を使わないと、
 * **「Human Recovery を使え」と案内しておきながら endpoint が 409 で断る**という
 * 食い違いが起きる（独立レビュー指摘・2026-09-21）。
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
