/**
 * 「その Task はいま Project を占有しているか」— 既存の `currentTask` の意味を1箇所に出したもの。
 *
 * `apps/api/src/state/systemState.ts` が昔からこの意味で `currentTask` を決めている:
 *
 * ```ts
 * const currentTask =
 *   tasks.find((task) => task.status === 'in_progress' || task.status === 'blocked') ??
 *   activeTasks.find((task) => task.status === 'pending')   // activeTasks = roadmapActive のみ
 * ```
 *
 * **`pending` は `roadmapActive` のときだけ「次に着手される」**という点が重要である。
 * `roadmapActive=false` の `pending` Task はどの実行経路からも選ばれない
 * （`selectNextContinuableTask()` も `isReadyTaskWithoutJob()` も `roadmapActive` を要求する）。
 * つまり **parked Task**（未完了だが現在の自律実行対象外）であり、Project を占有していない。
 *
 * follow-up の成立条件「active Task なし」はこの意味で判定しなければならない。
 * 単純な `status !== 'done'` にすると、parked Task が永久に follow-up を塞ぐ。
 * **新しい active の定義を作らず、既存の意味をそのまま共有する**ためにこの関数がある。
 */
export function occupiesProject(task: { status: string; roadmapActive?: boolean }): boolean {
  if (task.status === 'in_progress' || task.status === 'blocked') return true
  return task.status === 'pending' && task.roadmapActive === true
}

/**
 * 上と同じ判定を SQL で書いたもの。`tasks` テーブルへの WHERE 断片。
 *
 * **`occupiesProject()` と必ず同じ意味にすること。** 片方だけ変えると、
 * transaction 内の再確認と呼び出し側の判定がずれる。
 */
export const OCCUPIES_PROJECT_SQL =
  "(status IN ('in_progress','blocked') OR (status = 'pending' AND roadmap_active = 1))"
