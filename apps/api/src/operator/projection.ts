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

import type { ApprovalRequest, Job, QAResult, ReviewResult, Task, TaskSummary } from '@ai-team/shared'
import type { SystemStateSnapshot, AttentionItem, ProjectStateSummary } from '../state/systemState'
import type { LatestDesignReviewVerdict } from '../pl/blockedTriage'

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

/**
 * Design Review run の error を外へ出してよい形にする。
 *
 * run の error は `runner exited with code N: <stderr>` や `... | runner stderr: <tail>` の形で
 * **runner（provider CLI）の stderr をそのまま含む**（`designReviewCoordinator.ts`）。
 * 先頭の分類部分（最初の `:` / ` | ` より前）だけを残す。例: `runner timed out after 120000ms`。
 */
export function safeRunError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined
  const head = error.split(' | ')[0]!.split(':')[0]!.trim()
  return head === '' ? undefined : capText(head, 120)
}

/** Job の出力から detail を作る attention。 */
const JOB_OUTPUT_ATTENTION_KINDS: ReadonlySet<AttentionItem['kind']> = new Set(['job_blocked', 'job_failed'])

/**
 * attention の detail を外へ出してよい形にする。
 *
 * `job_blocked` / `job_failed` の detail は、Job の stderr 1行目が Worker の構造化行
 * （`[jobRunner] ...`）ならその行、**そうでなければ stderr の末尾そのもの**である
 * （`state/systemState.ts` の `stopReason()`）。後者は credential 断片を含みうるので出さない。
 */
export function safeAttentionDetail(item: AttentionItem): string | undefined {
  if (JOB_OUTPUT_ATTENTION_KINDS.has(item.kind) && !item.detail.trimStart().startsWith('[jobRunner] ')) {
    return 'job output withheld (not a structured [jobRunner] line); see the job status and failure kind'
  }
  // Design Review の detail は run.error（runner stderr を含みうる）を埋め込むので、その部分だけ削る。
  if (item.kind === 'design_review_failed') {
    const [head, ...rest] = item.detail.split(': ')
    const error = safeRunError(rest.join(': ') || undefined)
    return capText(error !== undefined ? `${head}: ${error}` : head)
  }
  if (item.kind === 'design_review_idle') {
    return capText(item.detail.replace(/last error: [\s\S]*\)$/, (match) =>
      `last error: ${safeRunError(match.slice('last error: '.length, -1)) ?? 'withheld'})`))
  }
  return capText(item.detail)
}

export function projectAttention(item: AttentionItem): Record<string, unknown> {
  return defined({
    kind: item.kind,
    projectId: item.projectId,
    projectName: item.projectName,
    taskId: item.taskId,
    jobId: item.jobId,
    referenceId: item.referenceId,
    detail: safeAttentionDetail(item),
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
          error: safeRunError(project.designReview.error),
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

// ────────────────────────────────────────────────────────────
// Entity projection（`/api/operator/*` の safe read で使う）
// ────────────────────────────────────────────────────────────

/** 1 Task あたりに返す review finding の上限。 */
export const OPERATOR_FINDINGS_MAX = 10

export function projectTask(task: Task): Record<string, unknown> {
  return defined({
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: capText(task.description, 1000),
    status: task.status,
    provider: task.provider,
    roadmapTaskKey: task.roadmapTaskKey,
    phase: task.phase,
    roadmapActive: task.roadmapActive,
    dependencies: [...task.dependencies],
    allowedPaths: task.allowedPaths ? [...task.allowedPaths] : undefined,
    forbiddenPaths: task.forbiddenPaths ? [...task.forbiddenPaths] : undefined,
    acceptanceCriteria: task.acceptanceCriteria?.map((line) => capText(line) ?? ''),
    branchName: task.branchName,
    commitHash: task.commitHash,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  })
}

export function projectTaskSummary(summary: TaskSummary): Record<string, unknown> {
  return defined({
    taskId: summary.taskId,
    projectId: summary.projectId,
    projectName: summary.projectName,
    title: summary.title,
    taskStatus: summary.taskStatus,
    displayStatus: summary.displayStatus,
    latestJob: summary.latestJob
      ? defined({
          jobId: summary.latestJob.jobId,
          status: summary.latestJob.status,
          approvalId: summary.latestJob.approvalId,
          startedAt: summary.latestJob.startedAt,
          completedAt: summary.latestJob.completedAt,
          quarantined: summary.latestJob.quarantined,
        })
      : undefined,
    approvalSummary: defined({
      hasWaitingApproval: summary.approvalSummary.hasWaitingApproval,
      hasRejectedApproval: summary.approvalSummary.hasRejectedApproval,
      latestApprovalRequestId: summary.approvalSummary.latestApprovalRequestId,
      latestApprovalStatus: summary.approvalSummary.latestApprovalStatus,
      latestApprovalRiskLevel: summary.approvalSummary.latestApprovalRiskLevel,
    }),
    updatedAt: summary.updatedAt,
  })
}

/**
 * Job の projection。**stdout / stderr / aiCliPrompt / パス / safeCommand の中身 / rollbackInfo は出さない。**
 * safeCommand からは種類（kind）だけを出す。
 */
export function projectJob(job: Job): Record<string, unknown> {
  const failure = job.failureMetadata
  const guard = job.guardResult
  return defined({
    id: job.id,
    taskId: job.taskId,
    projectId: job.projectId,
    status: job.status,
    workflowStepKey: job.workflowStepKey,
    agentRole: job.agentRole,
    commandKind: job.safeCommand?.kind,
    aiCliMode: job.aiCliMode,
    aiCliProvider: job.aiCliProvider,
    exitCode: job.exitCode,
    commitHash: job.commitHash,
    changedFiles: job.changedFiles ? [...job.changedFiles] : undefined,
    approvalId: job.approvalId,
    failure: failure
      ? defined({
          kind: failure.kind,
          workspaceState: failure.workspaceState,
          quarantined: failure.quarantined,
          quarantineReason: capText(failure.quarantineReason),
          quarantineClearedAt: failure.quarantineClearedAt,
        })
      : undefined,
    guard: guard
      ? defined({
          permissionAllowed: guard.permissionAllowed,
          permissionReason: capText(guard.permissionReason),
          fileChangeAllowed: guard.fileChangeAllowed,
          fileViolations: guard.fileViolations ? [...guard.fileViolations] : undefined,
        })
      : undefined,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  })
}

/** Approval request の projection。CEO メモ（`reason`）は出さない。 */
export function projectApprovalRequest(request: ApprovalRequest): Record<string, unknown> {
  return defined({
    id: request.id,
    taskId: request.taskId,
    status: request.status,
    riskLevel: request.riskLevel,
    requestedAction: capText(request.requestedAction),
    targetBranch: request.targetBranch,
    targetCommit: request.targetCommit,
    changedFiles: request.changedFiles ? [...request.changedFiles] : undefined,
    triggeredRules: request.triggeredRules ? [...request.triggeredRules] : undefined,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
  })
}

export function projectReviewResult(review: ReviewResult): Record<string, unknown> {
  return {
    id: review.id,
    jobId: review.jobId,
    reviewer: review.reviewer,
    status: review.status,
    summary: capText(review.summary),
    findingCount: review.findings.length,
    findings: review.findings.slice(0, OPERATOR_FINDINGS_MAX).map((finding) => defined({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      rule: finding.rule,
      message: capText(finding.message),
    })),
    createdAt: review.createdAt,
  }
}

/** QA の projection。`details`（ツール出力を含みうる）は出さない。 */
export function projectQaResult(qa: QAResult): Record<string, unknown> {
  return {
    id: qa.id,
    jobId: qa.jobId,
    type: qa.type,
    status: qa.status,
    summary: capText(qa.summary),
    createdAt: qa.createdAt,
  }
}

/** 最新 Design Review の projection。`summary` / `error` は長さを切る。run の生結果 JSON は出さない。 */
export function projectLatestDesignReview(
  review: LatestDesignReviewVerdict | undefined,
): Record<string, unknown> | undefined {
  if (!review) return undefined
  return defined({
    status: review.status,
    attemptCount: review.attemptCount,
    decision: review.decision,
    summary: capText(review.summary),
    error: safeRunError(review.error),
  })
}
