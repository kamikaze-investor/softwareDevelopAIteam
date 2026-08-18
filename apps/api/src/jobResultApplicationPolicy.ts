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
 * 既存テストで正当と確認されている契約をSource of Truthにしている:
 *   - `queued` からの terminal 直行は正当（running観測前の完了報告、API停止中完了のOutbox再送）
 *   - `blocked` / `success` の Job へ遅れて届いた terminal 結果も**適用する**
 *     （`jobs.test.ts` の provider_timeout 再送テストがこの契約を固定している。
 *      抑止されるのは retry Job の生成であって、結果の記録ではない）
 *   - `failed` / `blocked` / `running` / `success` から `queued` への戻しはAPI起点のrequeue
 *
 * 唯一禁止しているのは **terminal から `running` への復帰**である。
 * `running` はWorkerがqueuedなJobをclaimしたときにだけ成立する状態で、
 * 終端に達したJobが結果配送によって実行中へ戻ることは無い。
 * これ以上を禁止すると上記の既存契約（at-least-once受理）を壊すため広げない。
 */
const APPLICABLE_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'success', 'failed', 'blocked'],
  running: ['success', 'failed', 'blocked', 'queued'],
  success: ['failed', 'blocked', 'queued'],
  failed: ['success', 'blocked', 'queued'],
  blocked: ['success', 'failed', 'queued'],
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
