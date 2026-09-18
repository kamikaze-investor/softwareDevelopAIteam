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

import { occupiesProject } from '@ai-team/shared'
import { summarizeAdoptionFailure } from '../pl/adoptionFailure'
import type { IStorage } from '../storage/interface'
import type { Job, Task, Project } from '@ai-team/shared'

/**
 * その Job が「生きている承認待ち」で止まっているか。
 *
 * 承認待ちで止まっている Job は **`approval_waiting` が既に表している**。同じ停滞を
 * `job_blocked` としても出すと、PL は人の判断待ちの相手に対して復旧を試み、試行上限まで
 * 使い切って**二重に CEO を呼ぶ**（2026-09-15 production で実測）。
 *
 * 期限切れ / STALE / REJECTED は対象外 — そちらは**誰も進められない本物の停滞**であり、
 * `job_blocked` として PL に見せなければならない（この状態が今回の復旧対象そのものだった）。
 */
function isWaitingOnLiveApproval(storage: IStorage, job: Job, nowMs: number): boolean {
  if (job.approvalId === undefined) return false
  const approval = storage.approvalRequests.findById(job.approvalId)
  if (approval?.status !== 'WAITING_FOR_USER') return false
  return new Date(approval.expiresAt).getTime() > nowMs
}

/** 停滞とみなす既定の閾値。Watchdog の閾値とは別で、こちらは「PL へ知らせるか」の目安。 */
export const DEFAULT_STALL_HINT_MS = 5 * 60 * 1000

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
      (task) => storage.approvalRequests.findActiveByTaskId(task.id)?.status === 'WAITING_FOR_USER',
    ).length
    approvalsWaitingTotal += waitingForProject

    let designReview: ProjectStateSummary['designReview']
    if (currentTask) {
      // 終端した run も見る。failed で終わった review は findActiveByTaskId では観測できず、
      // 停止理由（= なぜ Job が作られないか）が attention から落ちるため。
      const run = storage.designReviewRuns.findLatestByTaskId(currentTask.id)
      if (run) {
        // `queued` のまま誰も実行していない run は、外部が気付くまで進まない。
        const idle = run.status === 'queued' && run.startedAt === undefined
        designReview = {
          status: run.status,
          attemptCount: run.attemptCount,
          error: run.error,
          idle,
        }
        if (idle) {
          attention.push({
            kind: 'design_review_idle',
            projectId: project.id,
            projectName: project.name,
            taskId: currentTask.id,
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

      const hasMovableJob = jobs.some((job) => (
        job.status === 'queued' || job.status === 'running' || job.status === 'blocked'
      ))
      const stallingFailure = jobs.find((job) => job.status === 'failed' && !isQuarantined(job))
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
          && task.status !== 'done'
          && !parentIsParked
          && !isWaitingOnLiveApproval(storage, job, nowMs)
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

        if (job.status === 'running') {
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

      const approval = storage.approvalRequests.findActiveByTaskId(task.id)
      if (approval?.status === 'WAITING_FOR_USER') {
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
    attention,
  }
}
