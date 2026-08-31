/**
 * Task detail画面の手動操作可否ロジック（Job作成 / resume表示条件）。
 *
 * apps/mobile は表示専用という方針（AGENTS.md Q3）に沿い、判断ロジックをUIコンポーネントから
 * 切り出す。副作用のあるAPI呼び出しは含めず、Job/ApprovalRequestの配列から真偽値を導出するだけ。
 *
 * workingDir はMobileから送信しない。API側（POST /api/jobs）が
 * MVP-Aの正規workingDir（/workspace/target固定）をサーバー側で設定する。
 */

import type { ApprovalRequest, Job, Task } from '@ai-team/shared'

export function parseDateTime(value: string): number {
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

export function sortJobsByNewestFirst(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const aTime = parseDateTime(a.startedAt ?? a.createdAt)
    const bTime = parseDateTime(b.startedAt ?? b.createdAt)
    return bTime - aTime
  })
}

export function isImplementJob(job: Job): boolean {
  return job.aiCliMode === 'implement'
}

export function isReviewJob(job: Job): boolean {
  return job.aiCliMode === 'review'
}

export function isJobBusy(jobs: Job[]): boolean {
  return jobs.some((job) => job.status === 'queued' || job.status === 'running')
}

export function findLinkedApproval(
  job: Job | undefined,
  approvalRequests: ApprovalRequest[],
): ApprovalRequest | undefined {
  if (!job?.approvalId) return undefined
  return approvalRequests.find(request => request.id === job.approvalId)
}

export function hasWaitingLinkedApproval(
  jobs: Job[],
  approvalRequests: ApprovalRequest[],
): boolean {
  const latestJob = sortJobsByNewestFirst(jobs)[0]
  return findLinkedApproval(latestJob, approvalRequests)?.status === 'WAITING_FOR_USER'
}

/**
 * 手動操作（実装 / 独立レビュー / 反映）をロックすべきかどうか。
 *
 * ロック対象は「現在進行中の作業と衝突しうる状態」のみ:
 *   - queued/running Jobがある（isJobBusy） … 自動commit Jobの進行中もこれに含まれる
 *     （自動commit JobもJobである以上、進行中はqueued/runningを経由するため）
 *   - 直近Jobの承認待ちが残っている（hasWaitingLinkedApproval）
 *
 * 過去に自動commit Jobが存在したという履歴だけでは、その後の成否に関わらずロックしない。
 * 「過去に存在したか」で判定すると、一度でも自動commitを経たTaskが恒久的に操作不能になる。
 */
export function manualWorkflowIsLocked(
  jobs: Job[],
  approvalRequests: ApprovalRequest[],
): boolean {
  return isJobBusy(jobs) || hasWaitingLinkedApproval(jobs, approvalRequests)
}

/** 実装Jobが少なくとも1件成功しているか（独立レビューJobを起票できるか） */
export function canRunReview(jobs: Job[], approvalRequests: ApprovalRequest[]): boolean {
  if (manualWorkflowIsLocked(jobs, approvalRequests)) return false
  const latestImplement = sortJobsByNewestFirst(jobs).find(isImplementJob)
  return latestImplement?.status === 'success'
}

/**
 * 「変更を反映」を有効にする条件:
 *   最新の実装/レビュー関連Jobの中で最も新しいものが成功したレビューJobであり、
 *   かつそれより前に成功した実装Jobが存在すること
 *   （＝最新実装Jobがsuccess → その後の最新Review Jobがsuccess →
 *     Review後に新しい実装Jobが存在しない、と同値）。
 */
export function canReflectChanges(jobs: Job[], approvalRequests: ApprovalRequest[]): boolean {
  if (manualWorkflowIsLocked(jobs, approvalRequests)) return false
  const relevant = sortJobsByNewestFirst(jobs).filter(
    (job) => isImplementJob(job) || isReviewJob(job),
  )
  const [newest] = relevant
  if (newest === undefined || !isReviewJob(newest) || newest.status !== 'success') {
    return false
  }
  const priorImplement = relevant.slice(1).find(isImplementJob)
  return priorImplement?.status === 'success'
}

/**
 * resume UI（追加指示して再開）を表示すべきか。
 *
 * API側 `resumeBlockedTask` が受理する2パターンに対応する:
 *   1. 最新Jobがguard違反等で直接blockedになったケース（従来どおり）
 *   2. Design Review CONFLICT/NOT_ALIGNED等でrepair flowがTaskをblockedへ
 *      escalateしたが、Job自体はfailedのまま残っているケース
 *      （`escalateTaskToHuman` はJobを更新せずTask.statusだけをblockedにするため）。
 * 2番目を見落とすと、Design Review escalationされたTaskは資格があるのに
 * resume UIが一切表示されず、CEOがMobileから復旧できなくなる。
 */
export function canShowResumeUI(
  task: Task,
  jobs: Job[],
  approvalRequests: ApprovalRequest[],
): boolean {
  const latestJob = sortJobsByNewestFirst(jobs)[0]

  const isJobDirectlyBlocked = latestJob?.status === 'blocked'
  const isEscalatedFailure = task.status === 'blocked' && latestJob?.status === 'failed'

  if (!isJobDirectlyBlocked && !isEscalatedFailure) {
    return false
  }

  if (findLinkedApproval(latestJob, approvalRequests)?.status === 'WAITING_FOR_USER') {
    return false
  }

  return true
}
