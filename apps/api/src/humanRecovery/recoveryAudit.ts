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

/** その Task に対して成功した Human Recovery の件数。 */
export function countHumanRecoveryAttempts(storage: IStorage, taskId: string): number {
  return storage.auditLog
    .findByEntity(HUMAN_RECOVERY_AUDIT_ENTITY_TYPE, taskId)
    .filter((entry) =>
      entry.operation === HUMAN_RECOVERY_AUDIT_OPERATION && entry.result === 'success')
    .length
}
