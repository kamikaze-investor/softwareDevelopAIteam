/**
 * Task detail画面の手動操作可否ロジック（Job作成 / resume表示条件）。
 *
 * apps/mobile は表示専用という方針（AGENTS.md Q3）に沿い、判断ロジックをUIコンポーネントから
 * 切り出す。副作用のあるAPI呼び出しは含めず、Job/ApprovalRequestの配列から真偽値を導出するだけ。
 *
 * workingDir はMobileから送信しない。API側（POST /api/jobs）が
 * MVP-Aの正規workingDir（/workspace/target固定）をサーバー側で設定する。
 */

import type {
  ApprovalRequest,
  Job,
  QAResult,
  ReviewResult,
  Task,
  TaskFailureClassification,
  TaskSummary,
  WatchdogEvent,
} from '@ai-team/shared'

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

/**
 * MOB-001: 一覧・詳細・Dashboard で共通に使う状態ラベル。
 * 画面ごとに文言がずれると、CEO は「同じ状態なのか別の状態なのか」を判断できない。
 */
export const JOB_DISPLAY_STATE_LABEL: Record<JobDisplayState, string> = {
  approval_waiting: '承認待ち',
  blocked: '停止中',
  other: '',
  quarantined: '安全停止中',
  running_healthy: '実行中',
  running_stalled: '停滞中',
}

/**
 * MOB-001: 作業を前へ進める操作（実装 / 独立レビュー / 変更を反映）を出してよい状態か。
 *
 * quarantine では **false**。これらはいずれも `POST /api/jobs` で新しい Job を作り、
 * その Job は workspace を claim しようとする。安全性が確認できていない workspace に対して
 * 実行してよい操作ではない。
 *
 * 「backend が拒否するから UI は押せてもよい」という設計にはしない。押せる状態で見せること
 * 自体が、CEO に「これを押せば進む」という誤った期待を持たせる。
 */
export function allowsProgressActions(state: JobDisplayState): boolean {
  return state !== 'quarantined'
}

/**
 * MOB-001: quarantine 時に CEO へ示す状況説明。
 *
 * **「自動復旧中」とは書かない。** 2026-09-08 の調査で、それが事実でないことが判明している:
 *   - quarantine の再検証は Worker 起動時の `recoverJobsAtStartup()` だけで、定期実行は無い
 *   - 本番の workspace は実際に dirty（untracked ファイルが残っている）ため、
 *     再検証しても再び quarantine になるだけで、Worker restart では本質的に解消しない
 *   - 同じ clean-worktree quarantine が別 Project でも再発している
 *
 * 進行中でない復旧を「進行中」と表示すると、CEO は待っていれば直ると誤解し、
 * 実際には誰も動いていない状態が放置される。事実に一致する表現だけを出す。
 */
export function quarantineGuidanceText(): string {
  return '安全のため停止しています。'
    + '承認や再開では解除されません。'
    + '自動では復旧しません。AI開発チーム側で作業領域の復旧が必要です。'
    + 'CEOによる操作は必要ありません。'
}

/**
 * MOB-001: Project画面の実行健全性。
 *
 * `Project.status` は **lifecycle**（draft / running / paused / archived）であって
 * 「実際に処理が進んでいるか」ではない。両者を同じ表示に畳むと、止まっているのに
 * 動いているように見える。実運用で再現済み（2026-09-08 Phase 1/2 Operational E2E）:
 * Project.status='running' / 初回implement Job=success / continuation review Job=quarantined
 * （quarantineReason='workspace_baseline_failure'）でworkflowは完全停止していたが、
 * Mobileは「Running」を表示し続けた。
 *
 * **新しいbackend status体系は作らない。** 既存の Job.status / failureMetadata /
 * WatchdogEvent / approval state / Task state から導出するだけ。
 */
export type ProjectExecutionHealth =
  | 'running_healthy'      // 実際に進んでいる
  | 'running_stalled'      // watchdogがstallと確認した
  | 'quarantined'          // workspaceの安全性が証明できず所有権を保持している
  | 'approval_waiting'     // CEOの承認待ち
  | 'error'                // 通常の失敗。復旧が必要
  | 'idle'                 // 実行signalが無い。lifecycle statusをそのまま見せてよい

export const PROJECT_EXECUTION_HEALTH_LABEL: Record<ProjectExecutionHealth, string> = {
  approval_waiting: '承認待ち',
  error: '復旧が必要',
  idle: '',
  quarantined: '安全停止中',
  running_healthy: '実行中',
  running_stalled: '処理が進んでいません',
}

/**
 * quarantine では通常の Resume / Approval を出さない。
 *
 * quarantine は「承認すれば進む」状態ではなく、workspace verification /
 * reconciliation / clearance を経なければ解けない。ここで通常の復旧操作を見せると、
 * CEO は「承認したのに進まない」誤った操作へ誘導される。
 */
export function allowsRoutineRecoveryActions(health: ProjectExecutionHealth): boolean {
  return health !== 'quarantined'
}

/**
 * Project全体の実行健全性を、既存データだけから導出する。
 *
 * 優先順位は「CEOが取るべき行動が変わる順」:
 *   quarantined … 承認でもresumeでも解けない唯一の状態なので最優先
 *   running_stalled … 進行中に見えて進んでいない異常
 *   approval_waiting … 止まっているが原因も操作も明確
 *   running_healthy … 実際に動いている作業がある
 *   error … 動いている作業が無く、失敗/blockedが残っている
 *
 * `running_healthy` を `error` より先に見るのは、進行中の作業がある限り
 * 「復旧が必要」を主表示にすると、過去に1件失敗しただけのProjectが恒久的に
 * 異常表示になってしまうため。停止しているときだけ復旧を促す。
 */
export function deriveProjectExecutionHealth(
  tasks: Task[],
  jobsByTaskId: Record<string, Job[]>,
  approvalRequests: ApprovalRequest[],
  watchdogEvents: WatchdogEvent[] = [],
): ProjectExecutionHealth {
  const jobs = tasks.flatMap((task) => jobsByTaskId[task.id] ?? [])
  const states = jobs.map(
    (job) => deriveJobDisplayState(job, approvalRequests, watchdogEvents),
  )

  if (states.includes('quarantined')) return 'quarantined'
  if (states.includes('running_stalled')) return 'running_stalled'
  if (states.includes('approval_waiting')) return 'approval_waiting'
  if (states.includes('running_healthy')) return 'running_healthy'

  const hasFailure = jobs.some((job) => job.status === 'failed')
    || states.includes('blocked')
    || tasks.some((task) => task.status === 'blocked')

  return hasFailure ? 'error' : 'idle'
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

/**
 * MOB-001: TaskSummary（一覧/Dashboard が使う read-model）から実行状態を導出する。
 * 詳細画面の deriveJobDisplayState と **同じ優先順位・同じ episode key** を使う。
 * 画面ごとに判定がずれると、CEO は同じ状態を別物として受け取ってしまう。
 */
export function deriveSummaryDisplayState(
  summary: TaskSummary,
  watchdogEvents: WatchdogEvent[] = [],
): JobDisplayState {
  const job = summary.latestJob
  if (job === undefined) return 'other'
  if (job.status === 'blocked' && job.quarantined === true) return 'quarantined'
  if (job.status === 'running') {
    const stalled = watchdogEvents.some((event) => (
      event.jobId === job.jobId &&
      event.startedAt === job.startedAt &&
      event.isStuck === true &&
      event.status !== 'false_alarm' &&
      event.status !== 'resolved'
    ))
    return stalled ? 'running_stalled' : 'running_healthy'
  }
  if (job.status === 'blocked') {
    return summary.approvalSummary.hasWaitingApproval ? 'approval_waiting' : 'blocked'
  }
  return 'other'
}

/** Dashboard カードに出す、Project 単位の代表状態。優先順位は詳細画面と同じ。 */
const SUMMARY_STATE_PRIORITY: readonly JobDisplayState[] = [
  'quarantined',
  'running_stalled',
  'approval_waiting',
  'blocked',
  'running_healthy',
]

/**
 * MOB-001: Project 配下の Task 群から、Dashboard に出す代表状態を決める。
 * CEO が Dashboard を見ただけで異常に気付けることが目的なので、
 * 「対応が要る状態」を優先して昇格させる。
 */
export function deriveProjectSummaryState(
  summaries: TaskSummary[],
  watchdogEvents: WatchdogEvent[] = [],
): JobDisplayState {
  const states = new Set(summaries.map((s) => deriveSummaryDisplayState(s, watchdogEvents)))
  return SUMMARY_STATE_PRIORITY.find((state) => states.has(state)) ?? 'other'
}

/**
 * MOB-001（CEO実機再確認）: 「システム内部で可能な操作」ではなく
 * 「CEOが今この状態で実際に判断・操作すべきもの」だけを出すための可視判定。
 *
 * 既存の can* predicate をそのまま再利用し、新しい workflow state machine は作らない。
 * 変えたのは「無効化して見せる」から「出さない」への一点だけ。押せるボタンが並ぶこと自体が
 * 「これを押せば進む」という誤った期待を作る。
 */
export interface VisibleTaskActions {
  implement: boolean
  review: boolean
  reflect: boolean
}

export function visibleTaskActions(
  state: JobDisplayState,
  jobs: Job[],
  approvalRequests: ApprovalRequest[],
): VisibleTaskActions {
  const none: VisibleTaskActions = { implement: false, review: false, reflect: false }

  // 安全停止中は workspace の安全性が未確認。いずれの操作も新しい Job を作って claim を試みる。
  if (state === 'quarantined') return none

  // 停止中（Guard 違反・承認待ち）で必要なのは「新しい作業の開始」ではなく、
  // その blocker に対する resume / recovery。実装や反映を並べても前へ進まない。
  if (state === 'blocked' || state === 'approval_waiting') return none

  // 実行中は割り込ませない（既存 manualWorkflowIsLocked と同じ意図）。
  if (manualWorkflowIsLocked(jobs, approvalRequests)) return none

  return {
    // 実装は「まだレビュー待ち・反映待ちの成果が無い」ときにだけ意味がある。
    implement: !canRunReview(jobs, approvalRequests) && !canReflectChanges(jobs, approvalRequests),
    review: canRunReview(jobs, approvalRequests),
    reflect: canReflectChanges(jobs, approvalRequests),
  }
}

/**
 * MOB-001: blocker の解消を CEO の自由入力に頼ってよいかどうか。
 *
 * 既存の `TaskFailureClassification` をそのまま使う。新しい classifier は作らない。
 * code / environment / configuration は技術的な問題であり、CEO に
 * 「何を指示すればよいか」を考えさせるのは筋が悪い。AI/PL 側の復旧経路が主で、
 * 自由入力は主導線にしない。
 */
export function blockerNeedsHumanDecision(
  classification: TaskFailureClassification | undefined,
): boolean {
  return classification === 'approval_or_policy'
}

/**
 * 全 roadmap Task が完了しているか（Dashboard で「作業中」に見せないための判定）。
 *
 * - Task が1件も無い Project を vacuous truth で「完了」にしない
 * - **対象 Task を絞り込まない**。以前は「Job実行歴がある or done」で filter していたため、
 *   一度も実行されていない pending Task が母集団から外れ、
 *   「1件 done + 2件 未着手」の Project が誤って完了と判定されていた
 */
export function allRoadmapTasksDone(summaries: TaskSummary[]): boolean {
  if (summaries.length === 0) return false
  return summaries.every((summary) => summary.taskStatus === 'done')
}

// ── stored-review recovery（保存済み changes_requested の再投入）──────────────
//
// **ここは表示制御だけである。** 実際に通すかどうかは backend の
// `repairFromStoredReview()` / `prepareRepairFlow()` の admission が正本で、
// ここで通しても backend が拒否すればそれが結果になる。Mobile 側の判定で
// backend Gate を代替しない（AGENTS.md Q3 の「Mobile は表示専用」と同じ立場）。

const CANONICAL_REVIEW_STEP_KEY = /^implement:(.+):review$/

/** 再投入の対象となりうる、保存済み verdict とその実装/レビュー Job の組。 */
export interface StoredReviewRecoveryCandidate {
  implementJob: Job
  reviewJob: Job
  review: ReviewResult
}

/**
 * 保存済み `changes_requested` を canonical repair へ戻せる候補を、既存の読み取りデータだけから導く。
 *
 * 条件（いずれも backend の admission が改めて検査する）:
 *   - Task が `blocked`
 *   - canonical な review Job（`implement:<id>:review`）が存在する
 *   - その実装 Job が `success`
 *   - その review Job に保存された verdict が `changes_requested`
 *   - queued / running の Job が無い（動いている最中に操作させない）
 *
 * **reviewJobId は人が書き換えられない。** ここで選んだ実データの id をそのまま使う。
 */
export function findStoredReviewRecoveryCandidate(
  task: Task,
  jobs: Job[],
  reviews: ReviewResult[],
): StoredReviewRecoveryCandidate | undefined {
  if (task.status !== 'blocked') return undefined
  if (isJobBusy(jobs)) return undefined

  for (const reviewJob of sortJobsByNewestFirst(jobs)) {
    const matched = CANONICAL_REVIEW_STEP_KEY.exec(reviewJob.workflowStepKey ?? '')
    if (!matched) continue

    const implementJob = jobs.find((job) => job.id === matched[1])
    if (!implementJob || implementJob.status !== 'success') continue

    const review = reviews.find((result) => result.jobId === reviewJob.id)
    if (!review || review.status !== 'changes_requested') continue

    return { implementJob, reviewJob, review }
  }
  return undefined
}

/**
 * repair へ渡す QA 事実。**人が書く欄ではなく、Job レコードから導く。**
 * 自由入力にすると「機械検証」の欄へ人の作文が入り、証跡の意味が壊れる。
 */
export interface DerivedQaEvidence {
  jobId: string
  type: 'unit_test' | 'typecheck'
  status: 'passed' | 'failed' | 'skipped'
  summary: string
  details: string
}

/**
 * implement Job の **SafeCommand 実行結果**から QA 事実を導く。
 *
 * Worker は AI CLI 終了後に SafeCommand を別途実行し、その終了コードが Job の `exitCode` である
 * （実装 AI の自己申告ではない）。1 Job = 1 SafeCommand なので、`kind=test` の Job では
 * **typecheck の SafeCommand は選ばれていない** —— Job レコードから確定するのはここまでである。
 * 「typecheck が一度も走っていない」とまでは言えない（test script が内部で呼ぶ構成があり得る）。
 *
 * **特定 Task 向けの定数は持たない。** 値はすべて渡された Job から組み立てる。
 */
export function deriveSafeCommandQaEvidence(implementJob: Job): DerivedQaEvidence[] {
  const kind = implementJob.safeCommand?.kind
  if (kind !== 'test') return []
  if (implementJob.dryRun === true) return []

  // **「実行されて、こう終わった」と証明できる形だけから作る。**
  //   - `exitCode` は任意項目なので、記録が無ければ成否を主張しない
  //     （未記録を `failed` へ倒すと、観測していないことを断定してしまう）
  //   - `failed` な Job は AI CLI 段で早期失敗して SafeCommand が走っていない場合もあり、
  //     Job レコードからはその区別がつかない
  // どちらも「分からない」ので、QA 事実そのものを作らない（独立レビュー指摘）。
  if (implementJob.status !== 'success' || implementJob.exitCode !== 0) return []

  const evidence = `Job ${implementJob.id}: SafeCommand kind=${kind} status=${implementJob.status}`
    + ` exitCode=${implementJob.exitCode}.`
    + ' Worker が AI CLI 終了後に別途実行した結果であり、実装 AI の自己申告ではない。'
    + (implementJob.stdoutPath ? ` 完全なログ: ${implementJob.stdoutPath}` : '')

  return [
    {
      jobId: implementJob.id,
      type: 'unit_test',
      status: 'passed',
      summary: `Worker SafeCommand (kind=${kind}) passed`,
      details: evidence,
    },
    {
      jobId: implementJob.id,
      type: 'typecheck',
      status: 'skipped',
      // **Job レコードから観測できることだけを書く。** 「typecheck は実行されていない」とは
      // 言い切れない —— `pnpm test` が pretest 等で typecheck を子プロセスとして走らせる
      // 構成もあり得るからで、それは Job レコードには現れない（独立レビュー指摘）。
      // ここで確定しているのは「typecheck の SafeCommand は選ばれていない」ことだけである。
      summary: 'No typecheck SafeCommand was selected for this Job',
      details: `Job ${implementJob.id}: safeCommand.kind=${kind}.`
        + ' 1 Job = 1 SafeCommand なので、この Job で選ばれた検証は上記1つだけである。'
        + ' test script 自身が typecheck を内部で呼ぶかどうかは Job レコードからは判定できない。',
    },
  ]
}

/**
 * 既に同じ事実が登録済みなら再登録しない。**同一性は (jobId, type) で見る。**
 * status や文言で見ると、同じ検証について相反する行を積み増してしまう。
 */
export function qaEvidenceToRegister(
  derived: DerivedQaEvidence[],
  existing: QAResult[],
): DerivedQaEvidence[] {
  return derived.filter((candidate) => !existing.some(
    (qa) => qa.jobId === candidate.jobId && qa.type === candidate.type,
  ))
}

/** この再投入に対する承認の状態。**backend の action 文字列そのもので突き合わせる。** */
export type StoredReviewApprovalState = 'none' | 'waiting' | 'approved'

export function storedReviewApprovalState(
  reviewJobId: string,
  approvalRequests: ApprovalRequest[],
  now: Date = new Date(),
): StoredReviewApprovalState {
  const action = `repair_from_stored_review:${reviewJobId}`
  // **期限切れは数えない。** backend は未失効のものしか使わないので、期限切れの APPROVED を
  // 「承認済み」と出すと、押しても新しい承認待ちになって案内と食い違う（独立レビュー指摘）。
  const unexpired = (request: ApprovalRequest): boolean => {
    const expiresAt = Date.parse(request.expiresAt)
    return Number.isNaN(expiresAt) ? false : expiresAt > now.getTime()
  }
  const related = approvalRequests.filter(
    (request) => request.requestedAction === action && unexpired(request),
  )
  if (related.some((request) => request.status === 'APPROVED')) return 'approved'
  if (related.some((request) => request.status === 'WAITING_FOR_USER')) return 'waiting'
  return 'none'
}

/** 画面が出す3状態。分岐そのものをテストできるよう、描画から切り離す。 */
export type StoredReviewRecoveryView =
  | { kind: 'hidden' }
  /** 登録済み QA が分からない。重複登録を避けられないので操作を出さない */
  | { kind: 'evidence_unavailable' }
  | {
      kind: 'ready'
      candidate: StoredReviewRecoveryCandidate
      derived: DerivedQaEvidence[]
      toRegister: DerivedQaEvidence[]
      approval: StoredReviewApprovalState
    }

/**
 * 再投入セクションが出すべき状態。
 *
 * **`qaResults === null`（取得できなかった）を「0件」と同じに扱わない。** 同じに扱うと、
 * 既に登録済みの事実をもう一度送って重複行を作る。分からないときは操作を出さない。
 *
 * `approval` は「承認したのに何も起きない」を防ぐために出す。backend は承認そのものでは
 * 動かず、**承認後にもう一度この操作を呼んで初めて** APPROVED を consume して queued にする。
 */
export function storedReviewRecoveryView(
  task: Task,
  jobs: Job[],
  reviews: ReviewResult[],
  qaResults: QAResult[] | null,
  approvalRequests: ApprovalRequest[] = [],
): StoredReviewRecoveryView {
  const candidate = findStoredReviewRecoveryCandidate(task, jobs, reviews)
  if (!candidate) return { kind: 'hidden' }
  if (qaResults === null) return { kind: 'evidence_unavailable' }

  const derived = deriveSafeCommandQaEvidence(candidate.implementJob)
  return {
    approval: storedReviewApprovalState(candidate.reviewJob.id, approvalRequests),
    candidate,
    derived,
    kind: 'ready',
    toRegister: qaEvidenceToRegister(derived, qaResults),
  }
}

/** 承認状態に応じたボタン文言と補足。**「承認すれば勝手に始まる」とは言わない。** */
export function storedReviewRecoveryActionLabel(
  approval: StoredReviewApprovalState,
  isSubmitting: boolean,
): { label: string; note: string } {
  if (isSubmitting) return { label: '送信中...', note: '' }
  if (approval === 'approved') {
    return {
      label: '承認済み — 修正を開始する',
      note: 'この操作の承認は下りています。もう一度押すと修正が始まります。',
    }
  }
  if (approval === 'waiting') {
    return {
      label: '承認待ち — もう一度申請する',
      note: '承認画面で承認したあと、この画面に戻ってもう一度押してください。承認だけでは修正は始まりません。',
    }
  }
  return {
    label: '修正を開始する（承認が必要）',
    note: '押すと承認待ちになります。承認画面で承認したあと、この画面に戻ってもう一度押すと修正が始まります。',
  }
}

/**
 * 送信直後は登録済み QA の状態が変わっている。**読み直すまで「不明」にする。**
 *
 * 再取得そのものが失敗して古い値が残ったときでも、セクションが
 * `evidence_unavailable` 側へ倒れるようにするための一手である（独立レビュー指摘）。
 */
export function invalidateQaEvidence<T extends { qaResults: QAResult[] | null }>(
  data: T | null,
): T | null {
  return data === null ? data : { ...data, qaResults: null }
}

/** 再投入の結果を CEO へどう伝えるか。**backend の事実を言い換えない。** */
export interface StoredReviewRecoveryNotice {
  title: string
  message: string
}

export function storedReviewRecoveryNotice(
  result:
    | { ok: true; status: 'awaiting_approval' }
    | { ok: true; status: 'queued' | 'escalated' | 'skipped'; detail: string }
    | { ok: false; message: string },
): StoredReviewRecoveryNotice {
  if (!result.ok) return { message: result.message, title: '起票失敗' }
  if (result.status === 'awaiting_approval') {
    // **承認だけでは始まらない。** backend は承認後にこの操作をもう一度受けて、
    // そこで APPROVED を consume して初めて queued にする（独立レビュー指摘）。
    return {
      message: '修正の開始を申請しました。承認画面で承認したあと、この画面に戻って'
        + 'もう一度「修正を開始する」を押してください。承認だけでは修正は始まりません。',
      title: '修正開始の承認が必要です',
    }
  }
  if (result.status === 'queued') {
    // **承認後の2回目はこれが正常系である。** 「開始されなかった」と出すと、
    // CEO が失敗と誤解して不要な再試行をする。
    return {
      message: '修正作業の準備を開始しました。進行は作業履歴で確認できます。',
      title: '修正を開始しました',
    }
  }
  // skipped / escalated。**自動で再試行しない。** 事実をそのまま出す。
  return {
    message: `状態: ${result.status}${result.detail ? `\n${result.detail}` : ''}`,
    title: '修正は開始されませんでした',
  }
}
