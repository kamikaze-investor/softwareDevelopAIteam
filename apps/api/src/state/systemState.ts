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

import type { IStorage } from '../storage/interface'
import type { Job, Task, Project } from '@ai-team/shared'

/** 停滞とみなす既定の閾値。Watchdog の閾値とは別で、こちらは「PL へ知らせるか」の目安。 */
export const DEFAULT_STALL_HINT_MS = 5 * 60 * 1000

export type AttentionKind =
  | 'job_blocked'
  | 'workspace_quarantined'
  | 'approval_waiting'
  | 'design_review_failed'
  | 'design_review_idle'
  | 'continuation_pending'
  | 'task_ready_without_job'
  | 'job_running_long'

export interface AttentionItem {
  kind: AttentionKind
  projectId: string
  projectName: string
  taskId?: string
  jobId?: string
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
    const currentTask =
      tasks.find((task) => task.status === 'in_progress' || task.status === 'blocked') ??
      activeTasks.find((task) => task.status === 'pending')

    const continuationsPending = storage.taskContinuations.findPendingByProjectId(project.id).length
    continuationsPendingTotal += continuationsPending

    const waitingForProject = tasks.filter(
      (task) => storage.approvalRequests.findActiveByTaskId(task.id)?.status === 'WAITING_FOR_USER',
    ).length
    approvalsWaitingTotal += waitingForProject

    let designReview: ProjectStateSummary['designReview']
    if (currentTask) {
      const run = storage.designReviewRuns.findActiveByTaskId(currentTask.id)
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
        } else if (job.status === 'blocked') {
          attention.push({
            kind: 'job_blocked',
            projectId: project.id,
            projectName: project.name,
            taskId: task.id,
            jobId: job.id,
            detail: tail(job.stderr, 200) ?? 'job is blocked',
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
          detail: `approval request ${approval.id} is waiting for a human decision`,
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
