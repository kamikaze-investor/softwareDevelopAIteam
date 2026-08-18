/**
 * Result State Application Policy（API / Control Plane側）。
 *
 * Worker側の execution FSM（`apps/worker/src/jobStateManager.ts`）とは**責務が異なる**ため、
 * 同一化しない。Worker FSMは「Workerが自分の実行をどう進めるか」を表す。こちらは
 * 「届いた結果でDB stateを変更してよいか」を表す。
 *
 * 契約:
 *   - payload/authが正当な再送・遅延resultは**HTTP 200で受理する**（at-least-once配送を壊さない）
 *   - DB stateを変更してよいかだけをここで厳格に判定する
 *   - stale / duplicate resultは 200 + no-op（statusを適用しない）
 *   - 不正なstate mutationは適用しない
 *
 * 許可集合は既存テストで正当と確認されている契約から最小定義している:
 *   - `queued` からの terminal 直行は正当（Workerが running 観測前に完了報告することがある。
 *     API停止中に完了した結果がOutbox再送で遅れて届く場合も同じ形になる）
 *   - terminal（success/failed/blocked）から別の terminal への変更は stale とみなし適用しない
 *   - `failed` / `blocked` / `running` から `queued` への戻しは、API起点のrequeueとして正当
 *   - `success` は終端で、以後 status を変更しない
 */

import type { JobStatus } from '@ai-team/shared'

/**
 * 結果適用として state を変更してよい遷移。
 *
 * 方針: **確定済みのterminal stateを、遅れて届いた結果で上書きしない。**
 * これはこのコードベース自身の既存の意図と一致する:
 *   - `failIfRunning` は `WHERE id = ? AND status = 'running'` で terminal を保護する
 *   - `persistProviderTimeoutFailure` は `source.status !== 'running'` のとき no-op を返す
 * 一般PATCH経路だけが terminal を上書きできる状態だったため、ここで揃える。
 *
 * 受理そのものは止めない。HTTPは200のままで、DBへ status を適用しないだけである
 * （at-least-once配送の正当な遅延・重複resultを失わない）。
 *
 *   - `queued` からは running / terminal のどちらへも進める
 *     （running観測前の完了報告、API停止中に完了した結果のOutbox再送）
 *   - `running` からは terminal へ進める
 *   - terminal からは **requeue（→ `queued`）のみ**。API起点の明示的な再実行であり、
 *     遅延resultによる上書きではない
 */
const APPLICABLE_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'success', 'failed', 'blocked'],
  running: ['success', 'failed', 'blocked', 'queued'],
  success: ['queued'],
  failed: ['queued'],
  blocked: ['queued'],
}

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['success', 'failed', 'blocked']

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status)
}

/**
 * 届いた結果の status を DB へ適用してよいか。
 * `from === to` は遷移ではなく冪等な再送なので、状態を変えない意味で false を返す。
 */
export function canApplyJobResultStatus(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false
  return APPLICABLE_TRANSITIONS[from]?.includes(to) ?? false
}

export function describeApplicableJobStatuses(from: JobStatus): string {
  const allowed = APPLICABLE_TRANSITIONS[from]
  return allowed && allowed.length > 0 ? allowed.join(', ') : 'なし'
}
