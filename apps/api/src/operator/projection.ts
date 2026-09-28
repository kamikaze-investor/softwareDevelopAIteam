/**
 * Operator 向け safe projection — 外部（ChatGPT MCP / Mobile Operator Chat）と、
 * Operator Request に答える PL 診断へ渡してよい形に状態を削る。
 *
 * ## 方針: field allowlist
 *
 * **spread で丸ごと渡さない。** 1 field ずつ明示的に写す。元の型に field が増えても、
 * ここへ書き足さない限り外へは出ない（default deny）。
 *
 * 出さないもの（理由: credential 断片・prompt・モデル本文・内部パスを含みうる。
 * `jobRunner.ts` の注記と roadmap `job-raw-output-persisted-and-shown` を参照）:
 * - Job の stdout / stderr / stderrTail / aiCliPrompt / stdoutPath / stderrPath / rollbackInfo /
 *   safeCommand（workingDir を含む）/ guardResult の生値
 * - git diff 本文
 *
 * 自由文に近い field（attention.detail / design review error / quarantineReason）は
 * 観測事実として有用なので残すが、長さを切る。
 */

import type { SystemStateSnapshot, AttentionItem, ProjectStateSummary } from '../state/systemState'

/** 自由文に近い field の上限。 */
export const OPERATOR_TEXT_FIELD_MAX = 300

export function capText(value: string | undefined, max = OPERATOR_TEXT_FIELD_MAX): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function defined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

export function projectAttention(item: AttentionItem): Record<string, unknown> {
  return defined({
    kind: item.kind,
    projectId: item.projectId,
    projectName: item.projectName,
    taskId: item.taskId,
    jobId: item.jobId,
    referenceId: item.referenceId,
    detail: capText(item.detail),
    stuckForMs: item.stuckForMs,
  })
}

export function projectProjectState(project: ProjectStateSummary): Record<string, unknown> {
  const latest = project.jobs.latest
  return defined({
    id: project.id,
    name: project.name,
    status: project.status,
    startStage: project.startStage,
    roadmap: {
      totalTaskCount: project.roadmap.totalTaskCount,
      completedTaskCount: project.roadmap.completedTaskCount,
      isComplete: project.roadmap.isComplete,
    },
    currentTask: project.currentTask
      ? defined({
          id: project.currentTask.id,
          title: project.currentTask.title,
          status: project.currentTask.status,
          roadmapTaskKey: project.currentTask.roadmapTaskKey,
          allowedPaths: project.currentTask.allowedPaths,
        })
      : undefined,
    jobs: defined({
      byStatus: { ...project.jobs.byStatus },
      latest: latest
        ? defined({
            id: latest.id,
            status: latest.status,
            workflowStepKey: latest.workflowStepKey,
            provider: latest.provider,
            exitCode: latest.exitCode,
            commitHash: latest.commitHash,
            changedFiles: [...latest.changedFiles],
            createdAt: latest.createdAt,
            completedAt: latest.completedAt,
            quarantined: latest.quarantined,
            quarantineReason: capText(latest.quarantineReason),
            // stderrTail は出さない。
          })
        : undefined,
    }),
    approvalsWaiting: project.approvalsWaiting,
    continuationsPending: project.continuationsPending,
    adoptionFailure: project.adoptionFailure
      ? {
          failureClass: project.adoptionFailure.failureClass,
          escalations: project.adoptionFailure.escalations,
          since: project.adoptionFailure.since,
          lastAt: project.adoptionFailure.lastAt,
        }
      : undefined,
    designReview: project.designReview
      ? defined({
          status: project.designReview.status,
          attemptCount: project.designReview.attemptCount,
          error: capText(project.designReview.error),
          idle: project.designReview.idle,
        })
      : undefined,
  })
}

export function projectSystemState(state: SystemStateSnapshot): Record<string, unknown> {
  return {
    generatedAt: state.generatedAt,
    totals: {
      projects: { ...state.totals.projects },
      jobs: { ...state.totals.jobs },
      quarantinedJobs: state.totals.quarantinedJobs,
      approvalsWaiting: state.totals.approvalsWaiting,
      continuationsPending: state.totals.continuationsPending,
      activeDesignReviews: state.totals.activeDesignReviews,
      activeSupervisedRuns: state.totals.activeSupervisedRuns,
    },
    projects: state.projects.map(projectProjectState),
    attention: state.attention.map(projectAttention),
  }
}
