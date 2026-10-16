/**
 * Cross-project System State — PL の Observe の入口。
 *
 * **目的**: 「いまシステム全体で何が起きているか」を**1回の読み取りで**返す。既存エンドポイントは
 * すべて Project 単位か entity 単位で、横断して読む口が無かった。人間だけでなく
 * **VPS 上の PL（AI）自身が現在状態を理解できること**を目的とする。
 * ledger: `cross-project-state-api` / `vps-pl-execution-loop`。
 *
 * **新しい telemetry 基盤・新しい state store は作らない。** 既存の storage を読むだけの
 * 純粋な導出であり、副作用を持たない（GET は read-only という既存契約を守る）。
 *
 * **`attention` が PL 向けの中核**である。単なる状態羅列ではなく「今これが止まっている / 判断が要る」
 * を明示的に返す。PL はここを起点に Diagnose へ進める。ただし **`attention` は観測事実のみ**で、
 * 「どう直すか」は含めない。行動の選択は PL が行い、その実行可否は
 * `mandatory-gate-policy` が決める（本 API は権限判断をしない）。
 */

import { isLiveWorkspaceOwnerJob, occupiesProject } from '@ai-team/shared'
import { findBlockedRowsHoldingWorkspace } from './blockedRowOwnership'
import { summarizeAdoptionFailure } from '../pl/adoptionFailure'
import { latestHumanRecoveryId } from '../humanRecovery/recoveryAudit'
import { readJobsSupersededByHumanResume } from '../designReview/resumeActor'
import { designReviewRetryNotBeforeMs } from '../designReview/retryCooldown'
import { isTechnicalRecoveryTargetExhausted } from '../pl/technicalResumePolicy'
import type { IStorage } from '../storage/interface'
import { isLiveApprovedApproval, isLiveTaskScopedDecision, isLiveWaitingApproval } from '@ai-team/shared'
import type { ApprovalRequest, Job, Task, Project } from '@ai-team/shared'

/**
 * その Job が「生きている承認待ち」で止まっているか。
 *
 * 承認待ちで止まっている Job は **`approval_waiting` が既に表している**。同じ停滞を
 * `job_blocked` としても出すと、PL は人の判断待ちの相手に対して復旧を試み、試行上限まで
 * 使い切って**二重に CEO を呼ぶ**（2026-09-15 production で実測）。
 *
 * 期限切れ / STALE / REJECTED は対象外 — そちらは**誰も進められない本物の停滞**であり、
 * `job_blocked` として PL に見せなければならない（この状態が今回の復旧対象そのものだった）。
 *
 * expiry 解釈の正本は `@ai-team/shared` の `isLiveWaitingApproval`（approvalLiveness.ts）。
 * Job 起点（ここ）と Task 起点（`approval_waiting` attention）は同じ関数を使う。
 */
/**
 * Task の request を**全件**見て、live な WAITING（新しい順で最初の1件）を返す。
 *
 * 最新の active 行1件だけで判定すると、新しい APPROVED（別 action の人の判断は SUPERSEDED に
 * されず残る）や legacy の複数 active 行の陰に、古い live WAITING が隠れる（Codex review 84fe348）。
 */
function findLiveWaitingApproval(storage: IStorage, taskId: string, nowMs: number): ApprovalRequest | undefined {
  return storage.approvalRequests.findByTaskId(taskId)
    .find((request) => isLiveWaitingApproval(request, nowMs))
}

/**
 * Task に生きた **Task 単位の人の判断**（abort_task / reconcile_external_completion /
 * repair_from_stored_review:* 等の未期限 WAITING / APPROVED。Job には結び付かない）があるか（Codex round 2）。
 *
 * それがある間、人でない resume は `HUMAN_DECISION_PENDING` で断られる（C-03）。その Task の blocked Job を
 * `job_blocked` として PL に見せると、毎 tick 診断 → resume → 拒否 を繰り返す。Job に結び付いた live WAITING と
 * 同じく人の判断待ちとして扱い、`job_blocked` を出さない（判断は `approval_waiting` が表す）。
 */
function findLiveTaskScopedDecision(storage: IStorage, taskId: string, nowMs: number): ApprovalRequest | undefined {
  const decisions = storage.approvalRequests.findByTaskId(taskId)
    .filter((request) => isLiveTaskScopedDecision(request, nowMs))
  // WAITING を優先（判断そのものを待っている）。無ければ APPROVED（実行を人が待っている）。
  return decisions.find((request) => isLiveWaitingApproval(request, nowMs))
    ?? decisions.find((request) => isLiveApprovedApproval(request, nowMs))
}

function isWaitingOnLiveApproval(storage: IStorage, job: Job, nowMs: number): boolean {
  if (job.approvalId === undefined) return false
  return isLiveWaitingApproval(storage.approvalRequests.findById(job.approvalId), nowMs)
}

/** 停滞とみなす既定の閾値。Watchdog の閾値とは別で、こちらは「PL へ知らせるか」の目安。 */
export const DEFAULT_STALL_HINT_MS = 5 * 60 * 1000

/** `workspace_held_by_stalled_owner` の原因。detail 先頭に `cause=<値>` として載る。 */
export type StalledOwnerCause =
  | 'inactive_project'
  | 'multiple_live_owners'

/**
 * CEO / PL へ渡す原因ごとの要約。**実際に使える出口だけを書く。**
 *
 * done / park された Task の blocked 行には自動の出口が無い（`abort_task` は done Task を拒否し、
 * park された Task は resume も abort もできない）。そう書かずに既存操作を案内すると、
 * 案内どおりにしても何も解けない（W5 独立レビュー指摘）。
 *
 * done / park された Task の行が所有者になるのは quarantine 行だけである（shared
 * `holdsWorkspaceWhenBlocked` に park 状態を渡した `findBlockedRowsHoldingWorkspace`）。
 * 非 quarantine の stale 候補は claim guard も Worker も観測で扱うので、ここにも出ない。
 * quarantine 行は `workspace_quarantined` が既に CEO へ届くので、done / park 用の原因は持たない
 * （旧 `done_task_blocked_row` / `parked_task_blocked_row` は廃止。lifecycle repair C2）。
 */
const STALLED_OWNER_SUMMARY: Record<StalledOwnerCause, (job: Job, project: Project) => string> = {
  inactive_project: (job, project) =>
    `a ${job.status} job in the ${project.status} project holds the shared workspace. `
    + 'Exit: pause the currently running project first (only one project may run at a time), then resume '
    + 'this project so its owner can finish; archiving it or returning it to draft is refused while it '
    + 'still owns work.',
  multiple_live_owners: () =>
    'more than one task owns the shared workspace at once, so the Worker and the claim guard refuse every '
    + 'claim. Exit: decide which owner continues and terminalize or cancel the other owner jobs.',
}

export type AttentionKind =
  | 'job_blocked'
  /** 未完了 Task の最新 Job が failed で、後続が無い＝いま止まっている。履歴上の失敗は含めない。 */
  | 'job_failed'
  | 'workspace_quarantined'
  | 'approval_waiting'
  | 'design_review_failed'
  | 'design_review_idle'
  | 'continuation_pending'
  | 'task_ready_without_job'
  /**
   * Task が `blocked` なのに Job が1件も無い。**誰も動かせない状態**である。
   *
   * `failContinuation()` が非 retryable な skip（Design Review 非 ALIGNED 等）で Task を
   * blocked にすると、Job は1件も作られない。これを出さないと、他の attention が
   * すべて「Job があること」か「`status='pending'` であること」を条件にしているため、
   * **attention が1件も立たないまま Project の枠を占有し続ける**（2026-09-18 実測）。
   *
   * PL はこれを解消できない（復旧は人の明示操作＝ Human Recovery に限る）ので notify-only。
   */
  | 'task_blocked_without_job'
  | 'job_running_long'
  /**
   * Worker が次に claim するはずの head-of-line の queued Job（running Project。`fetchQueuedJob` と同じ順序と
   * 所有者制限。deployment に高々1件）が、最後に queued になってから停滞閾値（`stallHintMs`。
   * `job_running_long` と同じ）を過ぎても claim されていない（lifecycle repair C2 / RC5）。どこかで Job が
   * running なら正常な直列待ちなので出さない。Worker の停止、Worker 側の所有権 ambiguous
   * （stale な dirty 行と帰属できない dirt）、他の attention に表れない claim 拒否のどれでも
   * **黙って止まらない**ための受け皿。referenceId は Job id（1回だけ escalate される）。
   * 同じ停止を既に説明する attention（workspace_quarantined / workspace_held_by_stalled_owner は
   * claim 拒否全体を、approval_waiting / design_review_* は同じ Task を、continuation_pending は
   * 同じ Project を説明する）があれば出さない。park された Task と running 以外の Project は
   * claim を意図的に止めているので出さない。notify-only。
   */
  | 'job_queued_long'
  /**
   * 単一の共有 workspace の所有者（claim guard と同じ意味）が**自力では進まない**ため、running
   * Project の queued Job を Worker も API も claim しない。detail 先頭の `cause=` が原因:
   *
   *   - `inactive_project` … paused / draft Project の Job が所有者
   *   - `multiple_live_owners` … 所有者が2つ以上あり、互いに claim を拒否し合っている
   *
   * done / park された Task の所有者は quarantine 行だけで、`workspace_quarantined` が担当する（ここには出さない）。
   * queued は「動かせる」扱いのため、
   * これが無いと claim が止まったまま PL は idle になり誰にも知らせない（lifecycle repair W5）。
   * 解消は CEO / operator の判断（Project の再開、または手動の workspace 確認と Job の終端化）なので
   * notify-only。referenceId は所有者 Job の id（multiple_live_owners は所有者集合のキー）で、1回だけ escalate される。
   */
  | 'workspace_held_by_stalled_owner'

export interface AttentionItem {
  kind: AttentionKind
  projectId: string
  projectName: string
  taskId?: string
  jobId?: string
  /**
   * その attention の同一性を決める id（あれば）。
   *
   * 例: approval 待ちは Task 単位ではなく **approval request 単位**で1件である。
   * ここが無いと「同じ Task の2回目の承認待ち」を1回目と同一視してしまい、
   * 通知の重複排除が効きすぎて2回目を誰にも知らせないことになる。
   */
  referenceId?: string
  /** 観測事実のみ。対処方法は書かない（PL が決める）。 */
  detail: string
  /** 判明していれば、その状態が続いている時間。 */
  stuckForMs?: number
}

/**
 * 対象単位の technical recovery budget が尽きたことを、既存 audit から投影する。
 * Task 単位の resume cap は他の recovery action を止めないため、ここでは対象全体が
 * terminal になった記録だけを見る。
 */
export function isAttentionTechnicalRecoveryExhausted(
  storage: IStorage,
  item: AttentionItem,
): boolean {
  return isTechnicalRecoveryTargetExhausted(storage, item)
}

function projectAttention(storage: IStorage, item: AttentionItem): AttentionItem {
  if (!isAttentionTechnicalRecoveryExhausted(storage, item)) return item
  return {
    ...item,
    detail: `${item.detail}; PL technical recovery budget is exhausted and no CEO decision was requested`,
  }
}

export interface ProjectStateSummary {
  id: string
  name: string
  status: Project['status']
  startStage?: string
  roadmap: { totalTaskCount: number; completedTaskCount: number; isComplete: boolean }
  currentTask?: {
    id: string
    title: string
    status: Task['status']
    roadmapTaskKey?: string
    allowedPaths?: string[]
  }
  jobs: {
    byStatus: Record<string, number>
    latest?: {
      id: string
      status: Job['status']
      workflowStepKey?: string
      provider?: string
      exitCode?: number
      commitHash?: string
      changedFiles: string[]
      createdAt: string
      completedAt?: string
      /** 失敗時の末尾のみ。全文は既存の Job 詳細エンドポイントで取る。 */
      stderrTail?: string
      quarantined: boolean
      quarantineReason?: string
    }
  }
  approvalsWaiting: number
  continuationsPending: number
  /**
   * 採用が繰り返し失敗している状態。**通知を抑えても障害自体は見えていなければならない。**
   *
   * CEO への LINE は incident 単位で1回だけになったので、これが無いと
   * 「running だが currentTask も attention も無い、静かな Project」に見えてしまい、
   * 現在進行形の失敗が Mobile から消える（独立レビュー指摘）。
   *
   * **attention には出さない。** `maybeAdoptNext()` は attention が1件でもあると採用を
   * 見送るため、ここを attention にすると採用が永久に止まる（通知を直すために
   * 機能を殺すことになる）。見せるだけの事実として Project 側に置く。
   */
  adoptionFailure?: {
    /** 直近の失敗分類（`adoption=<status> code=<code>` から作った構造化された値）。 */
    failureClass: string
    /** 連続して失敗している escalation の回数。 */
    escalations: number
    /** 最初に失敗し始めた時刻。 */
    since: string
    /** 最後に失敗した時刻。 */
    lastAt: string
  }
  designReview?: {
    status: DesignReviewSnapshot['status']
    attemptCount: number
    error?: string
    idle: boolean
    /** 判定の出なかった attempt の後の retry cooldown 中なら、再試行できるようになる時刻（ISO）。 */
    retryNotBefore?: string
  }
}

interface DesignReviewSnapshot {
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  attemptCount: number
  error?: string
  startedAt?: string
  createdAt: string
}

export interface SystemStateSnapshot {
  generatedAt: string
  /** running / queued / blocked など、Project を跨いだ集計。 */
  totals: {
    projects: Record<string, number>
    jobs: Record<string, number>
    quarantinedJobs: number
    approvalsWaiting: number
    continuationsPending: number
    activeDesignReviews: number
    activeSupervisedRuns: number
  }
  projects: ProjectStateSummary[]
  /** **PL が最初に読むべき配列。** 止まっているもの・判断が要るものだけを返す。 */
  attention: AttentionItem[]
}

function tail(value: string | undefined, max = 400): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= max ? trimmed : trimmed.slice(-max)
}

/**
 * 停止理由として人へ見せる1片。**`[jobRunner]` の先頭注記があればそれを優先する。**
 *
 * `jobRunner` は Guard で止めたとき、決定的な診断を **stderr の先頭**へ置く
 * （`withLeadingNote()`。末尾へ足すとプレビュー切り詰め 4000 字で消えるため）。
 * 一方ここは `tail()` で**末尾**を取っていたので、両者が「どちらの端が重要か」で食い違い、
 * CEO への Escalation 本文に **Root Cause と無関係な provider 警告**が載っていた。
 *
 * 実測（2026-09-15）: 実際の原因は File Change Guard の allowedPaths 不一致だったのに、
 * 通知の「何が起きているか」は
 * `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY …` だった。
 *
 * 先頭注記が無ければ**従来どおり末尾**を使う。provider の出力そのものが理由になるケース
 * （テスト失敗の末尾など）を壊さないため。**新しいフィールドも抽出機構も作らない。**
 */
function stopReason(value: string | undefined, max = 200): string | undefined {
  const firstLine = value?.trimStart().split('\n')[0]?.trim()
  if (firstLine !== undefined && firstLine.startsWith('[jobRunner] ')) {
    return firstLine.length <= max ? firstLine : firstLine.slice(0, max)
  }
  return tail(value, max)
}

/**
 * Job が**最後に queued になった時刻**（`job_queued_long` の起点）。根拠の無い requeue なら undefined。
 *
 * Job を queued にする経路と、それぞれが残す永続的な時刻:
 *   - 新規作成（initial implement / repair / retry / resume / git_commit 後続 等）… `createdAt`
 *   - git_commit 承認による再開（`approveAndResumeJob`）… 同じ Job を queued に戻し started_at /
 *     completed_at を消す。時刻は紐づく承認の `reviewedAt`
 *   - quarantine 解除（clear-quarantine）… `failureMetadata.quarantineClearedAt`（解除まで queued は
 *     Worker から隠されている）
 *   - 汎用 `PATCH /api/jobs/:id` の requeue（terminal / running → queued）… started_at / completed_at を
 *     残したまま queued になり、時刻を残す audit も無い。**保守的に undefined（通知しない）**
 * started_at / completed_at が残っている queued Job は最後の経路でしか生まれない（承認再開は消す）。
 */
function queuedSinceOf(storage: IStorage, job: Job): string | undefined {
  if (job.startedAt !== undefined || job.completedAt !== undefined) return undefined
  const times = [job.createdAt]
  if (job.failureMetadata?.quarantineClearedAt !== undefined) times.push(job.failureMetadata.quarantineClearedAt)
  if (job.approvalId !== undefined) {
    const approval = storage.approvalRequests.findById(job.approvalId)
    if (approval?.reviewedAt !== undefined && (approval.status === 'APPROVED' || approval.status === 'CONSUMED')) {
      times.push(approval.reviewedAt)
    }
  }
  return times
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .pop()
}

function elapsedMs(from: string | undefined, nowMs: number): number | undefined {
  if (from === undefined) return undefined
  const started = Date.parse(from)
  return Number.isNaN(started) ? undefined : Math.max(0, nowMs - started)
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) out[v] = (out[v] ?? 0) + 1
  return out
}

function isQuarantined(job: Job): boolean {
  return job.failureMetadata?.quarantined === true
}

/**
 * 「次に着手できるはずなのに Job が無い Task」を検出する。
 *
 * `createInitialImplementWorkflow()` の eligibility と同じ条件を使う。これが検出されるのは
 * 採用直後（Project がまだ running でない間に skip された）や、Design Review が failed で
 * Job 生成まで到達しなかった場合であり、**外部が気付くまで永久に進まない**状態である
 * （ledger: `vps-pl-execution-loop` の production evidence）。
 */
function isReadyTaskWithoutJob(task: Task, jobs: readonly Job[]): boolean {
  return (
    task.roadmapActive &&
    task.status === 'pending' &&
    task.assignee === 'developer_ai' &&
    jobs.length === 0
  )
}

/**
 * いま採用が繰り返し失敗しているか。**既存 `audit_log` から導くだけで、新しい state は持たない。**
 *
 * 直近の成功（`acted`）より後の escalation を数える。成功すれば消える。
 * CEO への通知は incident 単位で1回に絞られたので、**ここが唯一の「まだ続いている」表示**になる。
 */
function adoptionFailureOf(
  storage: IStorage,
  projectId: string,
): ProjectStateSummary['adoptionFailure'] {
  // 判定の実体は `pl/adoptionFailure.ts` 1箇所にある。CEO への通知と同じ定義を使うので、
  // 「通知された障害」と「画面に出ている障害」がずれない。
  return summarizeAdoptionFailure(
    storage.auditLog.findByEntity('pl_loop_target', `adopt:${projectId}`),
  )
}

export function buildSystemState(
  storage: IStorage,
  options: { now?: () => string; stallHintMs?: number } = {},
): SystemStateSnapshot {
  const nowIso = (options.now ?? (() => new Date().toISOString()))()
  const nowMs = Date.parse(nowIso)
  const stallHintMs = options.stallHintMs ?? DEFAULT_STALL_HINT_MS

  const allProjects = storage.projects.findAll()
  const attention: AttentionItem[] = []
  const projects: ProjectStateSummary[] = []

  const jobStatusTotals: string[] = []
  let quarantinedJobs = 0
  let approvalsWaitingTotal = 0
  let continuationsPendingTotal = 0

  // archived は観測対象から外す。履歴は既存の Project 単位エンドポイントで読める。
  const observed = allProjects.filter((project) => project.status !== 'archived')

  // 共有 workspace を自力では進まない所有者が握っているか（`workspace_held_by_stalled_owner`）。
  const stalledOwners: Array<{ project: Project; task: Task; job: Job; cause: StalledOwnerCause }> = []
  // claim guard が所有者と数える全 Task（1 Task につき代表 Job 1件）。
  const allOwners: Array<{ project: Project; task: Task; job: Job }> = []
  const runningQueuedTaskIds = new Set<string>()
  // Worker（`fetchQueuedJob`）が claim を試みる順の queued Job（`job_queued_long` の head-of-line 判定用）。
  // 順序は Worker と同じ: `GET /api/projects`（findAll）→ `GET /api/tasks`（findByProjectId）→
  // 各 Task の `GET /api/jobs`（findByTaskId）で最初の queued。quarantine された Task の queued は
  // `GET /api/jobs` が隠すので候補にしない。claim するのは running Project の Task だけ。
  const claimOrderQueued: Array<{ project: Project; task: Task; job: Job }> = []
  // archived 以外の Project に running Job があるか。単一の共有 workspace を Worker が直列に使うので、
  // その間の queued は正常な待ちである（長い実行は `job_running_long` が扱う）。
  let anyJobRunning = false

  for (const project of observed) {
    const tasks = storage.tasks.findByProjectId(project.id)
    const activeTasks = tasks.filter((task) => task.roadmapActive)
    const completedTaskCount = activeTasks.filter((task) => task.status === 'done').length

    const jobsByTask = new Map<string, Job[]>()
    const projectJobs: Job[] = []
    for (const task of tasks) {
      const jobs = storage.jobs.findByTaskId(task.id)
      jobsByTask.set(task.id, jobs)
      projectJobs.push(...jobs)
    }
    jobStatusTotals.push(...projectJobs.map((job) => job.status))

    const latest = [...projectJobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop()

    // 「現在の Task」は、着手中があればそれ、無ければ次に着手できる roadmapActive な pending。
    // 判定は `occupiesProject()` に一本化してある（follow-up 成立条件と同じ意味を共有するため）。
    const currentTask =
      tasks.find((task) => task.status === 'in_progress' || task.status === 'blocked') ??
      tasks.find((task) => occupiesProject(task))

    const continuationsPending = storage.taskContinuations.findPendingByProjectId(project.id).length
    continuationsPendingTotal += continuationsPending

    const waitingForProject = tasks.filter(
      // attention の `approval_waiting` と同じ意味で数える（期限切れ WAITING は誰も待っていない）。
      // status だけで数えると、attention には出ないのに「承認待ち N 件」と表示される（2026-10-16 監査 A2）。
      (task) => findLiveWaitingApproval(storage, task.id, nowMs) !== undefined,
    ).length
    approvalsWaitingTotal += waitingForProject

    let designReview: ProjectStateSummary['designReview']
    if (currentTask) {
      // 終端した run も見る。failed で終わった review は findActiveByTaskId では観測できず、
      // 停止理由（= なぜ Job が作られないか）が attention から落ちるため。
      const run = storage.designReviewRuns.findLatestByTaskId(currentTask.id)
      if (run) {
        // `queued` のまま誰も実行していない run は、外部が気付くまで進まない。
        // 判定の出なかった attempt の後の retry cooldown 中は idle ではない（claim が拒むので
        // rekick は空振りになる）。cooldown が明けると idle に戻り、従来どおり rekick される。
        const retryNotBeforeMs = designReviewRetryNotBeforeMs(run)
        const retryNotBefore = retryNotBeforeMs !== undefined && nowMs < retryNotBeforeMs
          ? new Date(retryNotBeforeMs).toISOString()
          : undefined
        const idle = run.status === 'queued' && run.startedAt === undefined && retryNotBefore === undefined
        designReview = {
          status: run.status,
          attemptCount: run.attemptCount,
          error: run.error,
          idle,
          ...(retryNotBefore !== undefined ? { retryNotBefore } : {}),
        }
        // 両 attention とも同一性は **run 単位**（`referenceId: run.id`）。Task 単位だと、
        // 1回目の episode を escalation 済み・budget 消費済みとした記録が、同じ Task の
        // 新しい Design Review run（2回目の episode）まで黙らせる（task_blocked_without_job と同じ理由）。
        if (idle) {
          attention.push({
            kind: 'design_review_idle',
            projectId: project.id,
            projectName: project.name,
            taskId: currentTask.id,
            referenceId: run.id,
            detail:
              `design review run is queued with no execution in progress `
              + `(attempt ${run.attemptCount}${run.error ? `, last error: ${run.error}` : ''})`,
            stuckForMs: elapsedMs(run.createdAt, nowMs),
          })
        }
        if (run.status === 'failed') {
          attention.push({
            kind: 'design_review_failed',
            projectId: project.id,
            projectName: project.name,
            taskId: currentTask.id,
            referenceId: run.id,
            detail: `design review failed after ${run.attemptCount} attempt(s)`
              + `${run.error ? `: ${run.error}` : ''}`,
            stuckForMs: elapsedMs(run.completedAt ?? run.createdAt, nowMs),
          })
        }
      }
    }

    for (const task of tasks) {
      const jobs = jobsByTask.get(task.id) ?? []

      // **いま Task を止めている failed Job だけを attention にする。**
      // `failed` を一律に出すと、過去に失敗して後続 Job で解決済みのものまで永久に鳴り続ける。
      // 出すのは次をすべて満たすときだけ:
      //   1. Task が未完了（done なら履歴であり、誰も動かさない）
      //   2. その Task の**最新 Job** が failed（後続 Job があれば既に引き継がれている）
      //   3. quarantine ではない（quarantine は専用の attention があり、二重に出さない）
      // 実測（2026-09-15 production）: implement Job が provider timeout で failed になると、
      // Task は止まっているのに `task_ready_without_job`（Job が無い条件）にも該当せず、
      // attention が一切出なかった。**PL から見えないまま静かに止まる**状態だった。
      // 「最新の Job が failed か」を createdAt の順序で決めない。同一ミリ秒の Job が並ぶと
      // 順序が曖昧になり、判定が揺れる（実際にこの書き方で回帰テストが落ちた）。
      // 代わりに **「動かせる Job が1つも無いか」** を見る。queued / running は Worker が進め、
      // blocked は resume の対象で `job_blocked` が別に出る。どれも無ければ誰も進めない。
      // **park された Task の履歴を「いま対応が要る」扱いにしない。**
      //
      // abort_task は Task を done にせず `roadmapActive=false` にするだけなので、
      // blocked / failed だった Job は履歴としてそのまま残る（Mobile からも audit からも消えない）。
      // ただし parent Task が park 済みなら、それを解消できる者はいない。
      // 出し続けると PL は毎 tick それを見て何もできず、attention が永久に消えない —
      // done な Task の blocked Job を除外している既存の判断と同じ理由である。
      // **park だけを対象にする。** `roadmapActive === false` は sync による非活性化や
      // 手動 Task でも起きるので、それらの attention まで消してはならない
      // （独立レビュー Finding 6）。park 判定は storage の唯一の述語を使う。
      const parentIsParked = task.roadmapActive !== true
        && task.status !== 'done'
        && storage.tasks.isParked(task.id)

      // **Human Resume で後継が作られた blocked / failed Job は、いま Task を止めている Job ではない。**
      //
      // 2026-09-30 以降の `resumeBlockedTask()` は元の行を failed へ終端化する。下の導出は、
      // それ以前に作られた行や startup reconciliation が安全上触れない quarantine 行にも耐える
      // compatibility rule として残す。元の blocked 行を「動かせる Job」と数え続けると、
      // 後継が失敗しても `job_failed` が一切出ず、しかも古い
      // `job_blocked:<元Job>` は PL が escalate 済みで dedup されているので、**新しい失敗が
      // 誰にも見えないまま止まる**（2026-09-28 production・Task `9fdee5a3`）。
      // 判定は保存済みの resume lineage と `resume_actor` だけから導く（`readJobsSupersededByHumanResume`）。
      // AI / unknown / malformed の resume は superseded にしない。
      const superseded = task.status === 'done'
        ? new Set<string>()
        : readJobsSupersededByHumanResume(storage, jobs)

      if (project.status === 'running' && jobs.some((job) => job.status === 'queued')) {
        runningQueuedTaskIds.add(task.id)
      }
      {
        // 所有者の意味は claim guard（storage の `taskHoldsWorkspaceViaBlockedRow`）と完全に同じ:
        // live な所有者か、`findBlockedRowsHoldingWorkspace`（shared 述語 + park 状態 + quarantine が
        // 優先する superseded 除外）が返す blocked 行。done / park された Task の非 quarantine 行
        // （stale 候補）は Worker の観測に任せるので数えない（数えると guard とずれ、出口の無い警報になる）。
        const blockedOwner = findBlockedRowsHoldingWorkspace(storage, task, jobs)[0]
        const owner = jobs.find((job) => isLiveWorkspaceOwnerJob(task.id, job)) ?? blockedOwner
        if (owner !== undefined) allOwners.push({ project, task, job: owner })
        // done / park された Task の blocked 所有者は quarantine 行だけ（上の述語）で、
        // `workspace_quarantined` が CEO へ届けるので重ねない。inactive_project として Project の
        // 再開を案内しても、その Task は動かせないので所有者は消えない（W5 独立レビュー指摘）。
        const finishedTaskQuarantinedOwner = owner?.status === 'blocked'
          && (task.status === 'done' || storage.tasks.isParked(task.id))
        if (finishedTaskQuarantinedOwner) {
          // allOwners には数えたまま（multiple_live_owners の判定は guard と一致させる）。
        } else if (owner !== undefined && project.status !== 'running') {
          stalledOwners.push({ project, task, job: owner, cause: 'inactive_project' })
        }
      }
      const hasMovableJob = jobs.some((job) => (
        job.status === 'queued' || job.status === 'running'
        || (job.status === 'blocked' && !superseded.has(job.id))
      ))
      const stallingFailure = jobs.find((job) => (
        job.status === 'failed' && !isQuarantined(job) && !superseded.has(job.id)
      ))
      if (task.status !== 'done' && !parentIsParked && !hasMovableJob && stallingFailure !== undefined) {
        attention.push({
          kind: 'job_failed',
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          jobId: stallingFailure.id,
          detail: stopReason(stallingFailure.stderr) ?? 'job failed and nothing is left to move the task',
          stuckForMs: elapsedMs(stallingFailure.completedAt ?? stallingFailure.createdAt, nowMs),
        })
      }

      for (const job of jobs) {
        if (isQuarantined(job)) {
          quarantinedJobs += 1
          attention.push({
            kind: 'workspace_quarantined',
            projectId: project.id,
            projectName: project.name,
            taskId: task.id,
            jobId: job.id,
            detail: job.failureMetadata?.quarantineReason ?? 'workspace is quarantined',
            stuckForMs: elapsedMs(job.completedAt ?? job.createdAt, nowMs),
          })
        } else if (
          job.status === 'blocked'
          && !superseded.has(job.id)
          && task.status !== 'done'
          && !parentIsParked
          && !isWaitingOnLiveApproval(storage, job, nowMs)
          && findLiveTaskScopedDecision(storage, task.id, nowMs) === undefined
        ) {
          // **done な Task の blocked Job は attention にしない。**
          // Task が終端に達している以上その Job は履歴であり、誰も解消できない
          // （resume の対象は blocked Task であって done Task ではない）。
          // ここを出し続けると、PL は毎 tick それを見て何もできず、attention が永久に消えない。
          // 実例（2026-09-15）: `roadmap-adoption-followups` の implement Job が File Change Guard で
          // blocked → 実装は外部セッションで完了し Task は done。以後 `job_blocked` だけが残り続けた。
          // workspace の quarantine は Task status と無関係に実在の異常なので、上の分岐で従来どおり出す。
          attention.push({
            kind: 'job_blocked',
            projectId: project.id,
            projectName: project.name,
            taskId: task.id,
            jobId: job.id,
            detail: stopReason(job.stderr) ?? 'job is blocked',
            stuckForMs: elapsedMs(job.completedAt ?? job.createdAt, nowMs),
          })
        }

        if (
          job.status === 'queued'
          && project.status === 'running'
          && job === jobs.find((candidate) => candidate.status === 'queued')
          && !jobs.some(isQuarantined)
        ) {
          claimOrderQueued.push({ project, task, job })
        }

        if (job.status === 'running') {
          anyJobRunning = true
          const runningFor = elapsedMs(job.startedAt ?? job.createdAt, nowMs)
          if (runningFor !== undefined && runningFor >= stallHintMs) {
            attention.push({
              kind: 'job_running_long',
              projectId: project.id,
              projectName: project.name,
              taskId: task.id,
              jobId: job.id,
              detail: `job has been running for ${Math.round(runningFor / 1000)}s`,
              stuckForMs: runningFor,
            })
          }
        }
      }

      // **blocked なのに Job が1件も無い Task。**
      //
      // 上の分岐はすべて Job を前提にしており（`job_failed` は `stallingFailure` を、
      // `job_blocked` / `workspace_quarantined` は Job 本体を要求する）、下の
      // `isReadyTaskWithoutJob()` は `status === 'pending'` を要求する。よってこの状態は
      // **どの attention にも該当せず、完全に見えないまま Project を占有する**
      // （`occupiesProject()` は blocked を roadmapActive に関係なく占有と数える）。
      //
      // `roadmapActive` は条件にしない。`failContinuation()` は roadmapActive を見ずに
      // blocked へ上げるため、ここで要求すると同じ静かな停止を作り直すことになる。
      // park 済みの Task は除く（解消できる者がいないものを鳴らし続けない。上の
      // `parentIsParked` と同じ判断）。
      if (
        project.status === 'running'
        && task.status === 'blocked'
        && jobs.length === 0
        && !storage.tasks.isParked(task.id)
      ) {
        attention.push({
          kind: 'task_blocked_without_job',
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          // **エピソード単位の identity を持たせる。**
          // `targetKeyOf()` は referenceId を優先し、`hasEscalated()` はそのキーで
          // 生涯にわたり重複通知を抑止する。taskId だけだと、再投入して**もう一度**この
          // dead state に落ちたとき CEO へ二度と通知されない（独立レビュー指摘・2026-09-18）。
          // 直近の再投入 audit 行の id を使う。**通し番号は作らない**（CEO 決定）——
          // 必要なのは「前回の再投入を指す安定した値」だけで、エピソード内で不変、
          // 次の再投入で必ず変わるという性質は既存の行 id がそのまま満たす。
          referenceId: `${task.id}:${latestHumanRecoveryId(storage, task.id) ?? 'first'}`,
          detail:
            'task is blocked but has no job at all; no resume, retry or remediation path can reach it '
            + 'without an explicit human recovery',
          stuckForMs: elapsedMs(task.updatedAt, nowMs),
        })
      }

      if (project.status === 'running' && isReadyTaskWithoutJob(task, jobs)) {
        attention.push({
          kind: 'task_ready_without_job',
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          detail: 'task is roadmap-active and pending but has no job; nothing will start it on its own',
          stuckForMs: elapsedMs(task.createdAt, nowMs),
        })
      }

      // `findActiveByTaskId()` は `status IN ('WAITING_FOR_USER','APPROVED')` で引くだけで
      // **expiry を見ない**。status だけで判定すると、誰も待っていない期限切れ承認が
      // `approval_waiting` として残り続け、(1) `maybeAdoptNext()` が attention 全件で
      // 採用を止め続ける、(2) `blockedTriage` が「生きている承認待ち」として
      // `ceo_escalation`（AI にできることは無い）へ誤誘導する、の2つを同時に起こす。
      // 期限切れは「人の判断待ち」ではないので、ここでは出さない —— その Job は
      // `isWaitingOnLiveApproval()` が false を返すことで `job_blocked` 側に現れ、
      // 復旧経路は従来どおり残る。**行そのものは書き換えない**（lazy expiry を壊さない）。
      // 最新の active 行ではなく、実際に live な WAITING 行を referenceId に使う。
      const approval = findLiveWaitingApproval(storage, task.id, nowMs)
      if (approval !== undefined) {
        attention.push({
          kind: 'approval_waiting',
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          referenceId: approval.id,
          detail:
            `approval request ${approval.id} (${approval.requestedAction}, risk ${approval.riskLevel}) `
            + 'is waiting for a human decision',
          stuckForMs: elapsedMs(approval.createdAt, nowMs),
        })
      } else {
        // **APPROVED のまま実行されていない Task 単位の判断**（例: CEO が承認した abort_task を CEO が
        // /abort でまだ実行していない）も人の判断待ちである。新しい attention kind は作らず、同じ
        // notify-only の `approval_waiting`（referenceId = その承認。1件につき1回だけ通知）で見せる。
        // ここで出さないと、上で `job_blocked` を抑止した Task が誰にも見えないまま止まる。
        const decided = findLiveTaskScopedDecision(storage, task.id, nowMs)
        if (decided !== undefined && decided.status === 'APPROVED' && task.status !== 'done' && !parentIsParked) {
          attention.push({
            kind: 'approval_waiting',
            projectId: project.id,
            projectName: project.name,
            taskId: task.id,
            referenceId: decided.id,
            detail:
              `approval request ${decided.id} (${decided.requestedAction}, risk ${decided.riskLevel}) `
              + 'is APPROVED but not yet executed; the task waits for a human to carry out or replace that decision',
            stuckForMs: elapsedMs(decided.reviewedAt ?? decided.createdAt, nowMs),
          })
        }
      }
    }

    if (continuationsPending > 0) {
      attention.push({
        kind: 'continuation_pending',
        projectId: project.id,
        projectName: project.name,
        detail: `${continuationsPending} task continuation(s) still pending`,
      })
    }

    projects.push({
      id: project.id,
      name: project.name,
      status: project.status,
      startStage: project.startStage,
      roadmap: {
        totalTaskCount: activeTasks.length,
        completedTaskCount,
        isComplete: activeTasks.length > 0 && completedTaskCount === activeTasks.length,
      },
      currentTask: currentTask && {
        id: currentTask.id,
        title: currentTask.title,
        status: currentTask.status,
        roadmapTaskKey: currentTask.roadmapTaskKey,
        allowedPaths: currentTask.allowedPaths,
      },
      jobs: {
        byStatus: countBy(projectJobs.map((job) => job.status)),
        latest: latest && {
          id: latest.id,
          status: latest.status,
          workflowStepKey: latest.workflowStepKey,
          provider: latest.aiCliProvider,
          exitCode: latest.exitCode,
          commitHash: latest.commitHash,
          changedFiles: latest.changedFiles ?? [],
          createdAt: latest.createdAt,
          completedAt: latest.completedAt,
          stderrTail: tail(latest.stderr),
          quarantined: isQuarantined(latest),
          quarantineReason: latest.failureMetadata?.quarantineReason,
        },
      },
      approvalsWaiting: waitingForProject,
      continuationsPending,
      adoptionFailure: adoptionFailureOf(storage, project.id),
      designReview,
    })
  }

  // **claim guard が実際に拒否する queued の仕事（running Project の、所有者とは別 Task）があるときだけ**
  // 出す。pause は CEO の停止スイッチであり、誰も待っていないのに鳴らすと pause のたびに誤報になる。
  // **同じ Job に既に CEO 向けの attention（quarantine / 承認待ち）があれば重ねて鳴らさない。**
  // それぞれが notify-only で1回ずつ escalate されるため、出すと同じ所有者で2回 page する。
  const quarantinedJobIds = new Set(attention
    .filter((item) => item.kind === 'workspace_quarantined' && item.jobId !== undefined)
    .map((item) => item.jobId!))
  const waitingApprovalIds = new Set(attention
    .filter((item) => item.kind === 'approval_waiting' && item.referenceId !== undefined)
    .map((item) => item.referenceId!))
  const alreadyNotified = (job: Job): boolean => quarantinedJobIds.has(job.id)
    || (job.approvalId !== undefined && waitingApprovalIds.has(job.approvalId))

  // **単一所有者の原因は、所有者がちょうど1つのときだけ出す。** 2つ以上あるときに個別の原因
  // （例: inactive_project）を出すと、その出口（paused を running へ戻す）を取っても所有者は
  // 2つのまま claim は止まり続ける。複数のときは下の multiple_live_owners だけを出す（W5 独立レビュー指摘）。
  const singleOwner = allOwners.length === 1
  for (const { project, task, job, cause } of singleOwner ? stalledOwners : []) {
    if (![...runningQueuedTaskIds].some((taskId) => taskId !== task.id)) continue
    if (alreadyNotified(job)) continue
    attention.push({
      kind: 'workspace_held_by_stalled_owner',
      projectId: project.id,
      projectName: project.name,
      taskId: task.id,
      jobId: job.id,
      referenceId: job.id,
      detail: `cause=${cause}: ${STALLED_OWNER_SUMMARY[cause](job, project)} `
        + 'Queued work in the running project cannot be claimed until this owner is resolved.',
      stuckForMs: elapsedMs(job.completedAt ?? job.startedAt ?? job.createdAt, nowMs),
    })
  }

  // **所有者が2つ以上**（例: running Project の2 Task がそれぞれ非 initial-implement の queued Job を
  // 持つ、または paused Project の所有者と running Project の所有者が並ぶ）。Worker は ambiguous で
  // claim せず、API の claim guard も互いを所有者として拒否するので、誰も進めないまま止まる。
  // いずれかの所有者に quarantine / 承認待ちの attention があれば、そちらが CEO へ届くので重ねない。
  // referenceId は所有者集合の安定キーで、同じ incident は1回だけ escalate される（集合が変われば別 incident）。
  if (
    allOwners.length > 1
    && runningQueuedTaskIds.size > 0
    && !allOwners.some((owner) => alreadyNotified(owner.job))
  ) {
    const ordered = [...allOwners].sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt)
      || a.job.id.localeCompare(b.job.id))
    const newest = ordered[ordered.length - 1]!
    attention.push({
      kind: 'workspace_held_by_stalled_owner',
      projectId: newest.project.id,
      projectName: newest.project.name,
      taskId: newest.task.id,
      jobId: newest.job.id,
      referenceId: `owners:${ordered.map((owner) => owner.job.id).sort().join('+')}`,
      detail: `cause=multiple_live_owners: ${STALLED_OWNER_SUMMARY.multiple_live_owners(newest.job, newest.project)} `
        + `owner jobs: ${ordered.map((owner) => `${owner.job.id} (${owner.job.status}, task ${owner.task.id})`).join(', ')}. `
        + 'Queued work in the running project cannot be claimed until only one owner remains.',
      stuckForMs: elapsedMs(newest.job.createdAt, nowMs),
    })
  }

  // **claim されない queued Job（`job_queued_long`）。deployment に高々1件。**
  //
  // 対象は Worker が次に claim するはずの head-of-line だけ（`fetchQueuedJob` と同じ順序・同じ所有者制限:
  // 所有者 Task が1つならその Task の queued だけ、2つ以上なら誰も claim しない）。running Job が
  // どこかにあれば正常な直列待ちなので出さない。経過は「最後に queued になった時刻」から数える
  // （`queuedSinceOf`。根拠の無い requeue は保守的に出さない）。
  // 他の attention が同じ停止を既に説明していれば出さない。workspace_quarantined /
  // workspace_held_by_stalled_owner は claim 全体の拒否を説明する（所有者は別 Task）ので全体を抑止する。
  const headOfLine = anyJobRunning || allOwners.length > 1
    ? undefined
    : claimOrderQueued.find(({ task }) => allOwners.length === 0 || allOwners[0]!.task.id === task.id)
  const headQueuedSince = headOfLine !== undefined && !storage.tasks.isParked(headOfLine.task.id)
    ? queuedSinceOf(storage, headOfLine.job)
    : undefined
  const headQueuedFor = elapsedMs(headQueuedSince, nowMs)
  const queuedLongCandidates = headOfLine !== undefined && headQueuedFor !== undefined && headQueuedFor >= stallHintMs
    ? [{ ...headOfLine, queuedForMs: headQueuedFor }]
    : []
  {
    const claimWideExplained = attention.some((item) => (
      item.kind === 'workspace_quarantined' || item.kind === 'workspace_held_by_stalled_owner'
    ))
    const taskExplained = new Set(attention
      .filter((item) => (
        item.kind === 'approval_waiting' || item.kind === 'design_review_failed' || item.kind === 'design_review_idle'
      ) && item.taskId !== undefined)
      .map((item) => item.taskId!))
    const projectExplained = new Set(attention
      .filter((item) => item.kind === 'continuation_pending')
      .map((item) => item.projectId))
    for (const { project, task, job, queuedForMs } of claimWideExplained ? [] : queuedLongCandidates) {
      if (taskExplained.has(task.id) || projectExplained.has(project.id)) continue
      attention.push({
        kind: 'job_queued_long',
        projectId: project.id,
        projectName: project.name,
        taskId: task.id,
        jobId: job.id,
        referenceId: job.id,
        detail: `job has been queued for ${Math.round(queuedForMs / 1000)}s without being claimed `
          + '(the Worker may be down, or it cannot attribute workspace ownership); nothing else explains it',
        stuckForMs: queuedForMs,
      })
    }
  }

  return {
    generatedAt: nowIso,
    totals: {
      projects: countBy(allProjects.map((project) => project.status)),
      jobs: countBy(jobStatusTotals),
      quarantinedJobs,
      approvalsWaiting: approvalsWaitingTotal,
      continuationsPending: continuationsPendingTotal,
      activeDesignReviews: storage.designReviewRuns.findQueued().length,
      activeSupervisedRuns: storage.supervisedRuns.findActiveRuns().length,
    },
    projects,
    attention: attention.map((item) => projectAttention(storage, item)),
  }
}
