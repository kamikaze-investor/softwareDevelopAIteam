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
 * **終わった Task に取り残された blocked 行か。**
 *
 * `apps/worker/src/index.ts` の `isStaleBlockedJobOfFinishedTask()` と同じ判定である。
 *
 * **これは「所有していない」という意味ではない。** Worker は該当行を見つけると
 * `resolveWorkspaceOwnership()` で **worktree を観測**し、
 * 「次の Task を実際に始められる状態」（worktree に差分が無い / 進行中の git 操作が無い /
 * HEAD を解決できる）になって初めて所有権を手放したと見なす。それまでは所有者のままである。
 *
 * つまりこの述語が真でも、workspace の観測抜きに「所有していない」と結論してはならない。
 * quarantine されている行はそもそも候補にならない（安全と証明されるまで保有し続ける）。
 */
export function isStaleBlockedJobCandidate(
  task: { status: string },
  job: { status: string; failureMetadata?: { quarantined?: boolean } | null },
): boolean {
  return job.status === 'blocked'
    && task.status === 'done'
    && job.failureMetadata?.quarantined !== true
}

/**
 * **その blocked Job は、workspace を観測するまでもなく所有者か。**
 *
 * `findWorkspaceOwningTaskId()` が観測なしで所有者と確定させる条件と同じ。
 * stale 候補（上）はここでは false になるが、**それは「所有していない」ではなく
 * 「観測しないと決められない」**である。呼び出し側は観測による証明を用意するか、
 * 用意できないなら所有者として扱うこと（fail-closed）。
 *
 * **この意味を使う側が自前で書き直さないこと。** 2026-09-17 の Operational E2E で、
 * `abort_task` が「blocked なら無条件に所有者」と独自に判定していたために、
 * done な Task の古い blocked 行 4本が production の abort を丸ごと塞いだ。
 */
export function holdsWorkspaceWhenBlocked(
  task: { status: string },
  job: { status: string; failureMetadata?: { quarantined?: boolean } | null },
): boolean {
  if (job.status !== 'blocked') return false
  return !isStaleBlockedJobCandidate(task, job)
}

/**
 * 上と同じ判定を SQL で書いたもの。`tasks` テーブルへの WHERE 断片。
 *
 * **`occupiesProject()` と必ず同じ意味にすること。** 片方だけ変えると、
 * transaction 内の再確認と呼び出し側の判定がずれる。
 */
export const OCCUPIES_PROJECT_SQL =
  "(status IN ('in_progress','blocked') OR (status = 'pending' AND roadmap_active = 1))"
