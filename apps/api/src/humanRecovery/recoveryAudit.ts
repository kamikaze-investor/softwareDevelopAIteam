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

import type { IStorage } from '../storage/interface'

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
