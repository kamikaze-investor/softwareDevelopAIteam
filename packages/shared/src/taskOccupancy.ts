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
 * **Task の状態とは別に、Job が生きているか。**
 *
 * parked（`pending` かつ `roadmapActive=false`）でも、その Task に queued Job が残っていれば
 * Worker は実行する — `apps/worker/src/index.ts` の claim は running Project の**全 Task**を
 * 走査し、`roadmapActive` も Task status も見ずに queued Job を拾う（独立レビューで確認）。
 * したがって「占有していない」ことだけでは「動いていない」と言えない。
 * follow-up の成立条件はこの両方を見なければならない。
 */
export const LIVE_JOB_STATUSES = ['queued', 'running'] as const

export function isLiveJob(job: { status: string }): boolean {
  return (LIVE_JOB_STATUSES as readonly string[]).includes(job.status)
}

/**
 * **その blocked Job はまだ workspace を所有しているか。**
 *
 * `apps/worker/src/index.ts` の `findWorkspaceOwningTaskId()` が昔からこの意味で
 * 所有者を決めている: blocked Job は原則として workspace を保有するが、
 * **Task が `done` になった後に残っている blocked 行は履歴であって所有者ではない**
 * （quarantine されている行だけは例外で、安全と証明されるまで保有し続ける）。
 *
 * 旧 blocked 行を残すのは既存設計（`resumeBlockedGitCommitJob.test.ts` が固定している）なので、
 * 行を消すのではなく所有権の述語でだけ区別する。
 *
 * **この意味を使う側が自前で書き直さないこと。** 2026-09-17 の Operational E2E で、
 * `abort_task` が「blocked なら所有者」と独自に判定していたために、
 * done な Task の古い blocked 行 4本が production の abort を丸ごと塞いだ。
 */
export function holdsWorkspaceWhenBlocked(
  task: { status: string },
  job: { status: string; failureMetadata?: { quarantined?: boolean } | null },
): boolean {
  if (job.status !== 'blocked') return false
  if (job.failureMetadata?.quarantined === true) return true
  return task.status !== 'done'
}

/**
 * 上と同じ判定を SQL で書いたもの。`tasks` テーブルへの WHERE 断片。
 *
 * **`occupiesProject()` と必ず同じ意味にすること。** 片方だけ変えると、
 * transaction 内の再確認と呼び出し側の判定がずれる。
 */
export const OCCUPIES_PROJECT_SQL =
  "(status IN ('in_progress','blocked') OR (status = 'pending' AND roadmap_active = 1))"
