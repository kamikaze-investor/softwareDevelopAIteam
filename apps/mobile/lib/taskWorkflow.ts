/**
 * Task detail画面の手動操作可否ロジック（Job作成 / resume表示条件）。
 *
 * apps/mobile は表示専用という方針（AGENTS.md Q3）に沿い、判断ロジックをUIコンポーネントから
 * 切り出す。副作用のあるAPI呼び出しは含めず、Job/ApprovalRequestの配列から真偽値を導出するだけ。
 *
 * workingDir はMobileから送信しない。API側（POST /api/jobs）が
 * MVP-Aの正規workingDir（/workspace/target固定）をサーバー側で設定する。
 */

import type { ApprovalRequest, Job, Task, WatchdogEvent } from '@ai-team/shared'

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

/**
 * MOB-001: CEO が見分けられる必要のある実行状態。
 *
 * 新しい status 体系は作らない。すべて既存の状態（Job.status /
 * failureMetadata.quarantined / WatchdogEvent / approval state）から導出する。
 */
export type JobDisplayState =
  | 'running_healthy'      // 実行中で、watchdog は stall と確認していない
  | 'running_stalled'      // 実行中だが watchdog が stall と確認した
  | 'quarantined'          // workspace の安全性が証明できず所有権を保持している
  | 'approval_waiting'     // CEO の承認待ち
  | 'blocked'              // その他の停止（Guard 違反等）
  | 'other'                // success / failed / queued 等

/**
 * MOB-001: quarantine されているか。
 *
 * P1 Phase 2 以降、`blocked` には意味の異なる2種類が混ざる:
 *   - 承認待ち・Guard 違反 → 人間が判断すれば前に進む
 *   - quarantine → workspace の状態が確認できないので所有権を保持している。
 *     人間が「承認」しても前に進まない。reconciliation / clearance が要る
 * この2つを同じ「停止中」として見せると、CEO は誤った操作へ誘導される。
 */
export function isQuarantined(job: Job | undefined): boolean {
  return job?.status === 'blocked' && job.failureMetadata?.quarantined === true
}

/**
 * MOB-001: watchdog が「本当に stall している」と確認したか。
 * 検出しただけ（detected / analyzing）や誤検知（false_alarm）は含めない。
 * `isStuck === false` と明示された誤検知は、確認済みでも stall とみなさない。
 */
export function isWatchdogConfirmedStalled(
  job: Job | undefined,
  watchdogEvents: WatchdogEvent[],
): boolean {
  if (job === undefined || job.status !== 'running') return false
  return watchdogEvents.some((event) => (
    event.jobId === job.id &&
    // 同じ Job の**この実行**に対する event だけを見る（DB-007 の episode key と同じ考え方）。
    // 過去の実行で stall した記録を、復帰後の健全な実行へ引きずらない。
    event.startedAt === job.startedAt &&
    event.isStuck === true &&
    event.status !== 'false_alarm' &&
    event.status !== 'resolved'
  ))
}

/**
 * MOB-001: 表示すべき状態を既存データだけから導出する。
 * 優先順位は「CEO が取るべき行動が変わる順」。quarantine は承認では解けないので
 * approval よりも先に判定する。
 */
export function deriveJobDisplayState(
  job: Job | undefined,
  approvalRequests: ApprovalRequest[],
  watchdogEvents: WatchdogEvent[] = [],
): JobDisplayState {
  if (job === undefined) return 'other'
  if (isQuarantined(job)) return 'quarantined'
  if (job.status === 'running') {
    return isWatchdogConfirmedStalled(job, watchdogEvents) ? 'running_stalled' : 'running_healthy'
  }
  if (job.status === 'blocked') {
    return findLinkedApproval(job, approvalRequests)?.status === 'WAITING_FOR_USER'
      ? 'approval_waiting'
      : 'blocked'
  }
  return 'other'
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

  // MOB-001 / P1 Phase 2: quarantine は resume で解けない。
  // workspace の状態を確認できていないから所有権を保持しているのであって、
  // 追加指示を出しても API 側の quarantine guard が claim を拒否する。
  // ここで resume UI を出すと、CEO を「押しても失敗する操作」へ誘導することになる。
  if (isQuarantined(latestJob)) {
    return false
  }

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
