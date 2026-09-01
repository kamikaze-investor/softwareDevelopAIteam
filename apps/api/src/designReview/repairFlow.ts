/**
 * Stage 2: failure → Trusted Design Review → repair Job のTask Flow統合。
 *
 * Flow:
 *   failure facts
 *     → canonical repair prompt（1度だけ生成）
 *     → design_review_runs
 *     → Trusted Design Review
 *     → ALIGNED
 *     → 同一review済みpromptでimplement Job作成
 *
 * **review後にpromptを変更・追記しない。** 変更すればGateのhash照合で必ず落ちる。
 *
 * One Job failure != Task failure: 1つのJob失敗ではTaskを失敗にせず、
 * bounded repairを試みる。継続できない場合のみ既存のHuman escalation
 * （Task status = 'blocked' → `POST /api/tasks/:id/resume`）へ渡す。
 *
 * Stage 1（provider timeoutの同一入力retry）とは別経路であり、混同しない。
 *
 * Idempotency: 同一failure eventからStage 2 chainは1本しか作られない。
 *   - design_review_runs は (task_id) WHERE status IN ('queued','running') の partial unique index
 *   - repair Job は `workflow_step_key = repair:<taskId>:<attempt>` と既存の全体一意index
 * いずれも既存機構であり、新しい仕組みは追加していない。
 */

import type { Job, Task, ReviewResult, QAResult } from '@ai-team/shared'
import type { IStorage, DesignReviewRun } from '../storage/interface'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteDesignReview,
  executeDesignReviewRun,
  type CoordinatorDeps,
} from './designReviewCoordinator'
import { buildRepairPrompt } from './repairPromptBuilder'
import {
  REPAIR_STEP_PREFIX,
  decideRepairAction,
  type PriorRepairJob,
  type RepairFailureFacts,
} from './repairPolicy'

/**
 * Stage 2起動の**同期フェーズ**の結果。
 *
 * ここまではLLMを実行せず、pureな判定とprompt構築だけを行う。
 * 'queue' の場合、呼び出し元はterminal Job updateと同一transactionで
 * design_review_runをqueuedとして永続化しなければならない。
 * 永続化さえ済めば、以降のexecutor kickが落ちてもstartup recoveryが拾える。
 */
export type RepairPreparation =
  | {
      action: 'queue'
      run: {
        taskId: string
        taskTitle: string
        designText: string
        designTextHash: string
        changedFiles: string[]
      }
      stepKey: string
      attempt: number
    }
  | { action: 'escalate'; reason: string }
  | { action: 'skip'; reason: string }

export type RepairFlowOutcome =
  | { status: 'repair_job_created'; jobId: string; stepKey: string; attempt: number }
  | { status: 'already_started'; stepKey: string }
  | { status: 'escalated'; reason: string }
  | { status: 'skipped'; reason: string }

/** 既存Jobから、署名計算に使う失敗事実を取り出す。 */
export function extractFailureFacts(job: Job, review?: ReviewResult): RepairFailureFacts {
  return {
    exitCode: job.exitCode,
    stderr: job.stderr,
    failureKind: job.failureMetadata?.kind,
    reviewFindingRules: review?.findings.map((finding) => finding.rule ?? finding.message),
  }
}

/**
 * 既存Jobから判定材料を作る。
 *
 * 判定は「今まさに失敗したJob」の結果を永続化する**前**に行うため、storage上のその行は
 * まだ更新前の状態である。そのままだと、直前のrepairが同じ失敗で終わったことを検出できず
 * requireDifferentApproachが立たない。よって当該Jobだけは今回のfailure factsで上書きする。
 */
function toPriorRepairJobs(
  jobs: readonly Job[],
  reviews: readonly ReviewResult[],
  current: { jobId: string; status: string; facts: RepairFailureFacts },
): PriorRepairJob[] {
  return jobs.map((job) => (
    job.id === current.jobId
      ? { workflowStepKey: job.workflowStepKey, status: current.status, facts: current.facts }
      : {
          workflowStepKey: job.workflowStepKey,
          status: job.status,
          facts: extractFailureFacts(job, reviews.find((review) => review.jobId === job.id)),
        }
  ))
}

/**
 * Taskを既存のHuman escalation経路へ入れる。
 * 新しいstatusもworkflowも作らず、既存の `blocked` を使う。
 * blockedのTaskはStage 1 retryの対象外であり、既存のresumeエンドポイントで再開できる。
 */
function escalateToHuman(storage: IStorage, task: Task, reason: string): RepairFlowOutcome {
  if (task.status !== 'blocked') {
    storage.tasks.update(task.id, { status: 'blocked' })
  }
  return { status: 'escalated', reason }
}

export interface RepairFlowInput {
  failedJob: Job
  review?: ReviewResult
  qaResults?: QAResult[]
}

/**
 * 失敗を受けてStage 2を1回だけ起動する。
 * 呼び出し元がPATCH再送やOutbox resendで複数回呼んでも、chainは1本しか作られない。
 */
export async function runRepairFlow(
  storage: IStorage,
  input: RepairFlowInput,
  deps: CoordinatorDeps = buildDefaultCoordinatorDeps(),
): Promise<RepairFlowOutcome> {
  const { failedJob, review } = input

  const task = storage.tasks.findById(failedJob.taskId)
  if (!task) {
    return { status: 'skipped', reason: 'task not found' }
  }
  if (task.status === 'blocked' || task.status === 'done') {
    return { status: 'skipped', reason: `task is ${task.status}` }
  }

  const priorJobs = storage.jobs.findByTaskId(task.id)
  const priorReviews = storage.reviewResults.findByTaskId(task.id)
  const facts = extractFailureFacts(failedJob, review)

  const decision = decideRepairAction(
    failedJob.id,
    toPriorRepairJobs(priorJobs, priorReviews, {
      jobId: failedJob.id,
      status: 'failed',
      facts,
    }),
    facts,
  )
  if (decision.action === 'escalate') {
    return escalateToHuman(storage, task, decision.reason)
  }

  // 冪等性(1): 同じstepKeyのJobが既にあるなら、この failure event のchainは既に作られている。
  if (priorJobs.some((job) => job.workflowStepKey === decision.stepKey)) {
    return { status: 'already_started', stepKey: decision.stepKey }
  }

  // 冪等性(2): 同一Taskにactiveなdesign review runがあるなら、chainは進行中である。
  if (storage.designReviewRuns.findActiveByTaskId(task.id)) {
    return { status: 'already_started', stepKey: decision.stepKey }
  }

  // canonical promptはここで1度だけ生成し、以降変更しない。
  const repairPrompt = buildRepairPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    job: {
      exitCode: failedJob.exitCode,
      stderr: failedJob.stderr,
      changedFiles: failedJob.changedFiles,
      failureKind: failedJob.failureMetadata?.kind,
      workspaceState: failedJob.failureMetadata?.workspaceState,
    },
    review: review
      ? { status: review.status, summary: review.summary, findings: review.findings }
      : undefined,
    qa: input.qaResults?.map((qa) => ({
      type: qa.type,
      status: qa.status,
      summary: qa.summary,
      details: qa.details,
    })),
    attempt: decision.attempt,
    requireDifferentApproach: decision.requireDifferentApproach,
  })

  const reviewOutcome = await createAndExecuteDesignReview(
    storage,
    {
      taskId: task.id,
      taskTitle: task.title,
      designText: repairPrompt,
      changedFiles: failedJob.changedFiles ?? [],
    },
    deps,
  )

  if (reviewOutcome.status !== 'evidence_registered') {
    // Design Reviewが通らない修正案は実行しない。安全に自律継続できないので人へ渡す。
    return escalateToHuman(
      storage,
      task,
      `design review did not align (${reviewOutcome.status}${reviewOutcome.decision ? `: ${reviewOutcome.decision}` : ''})`,
    )
  }

  // review済みpromptをそのままaiCliPromptにする（追記・変更しない）。
  const repairJob = storage.jobs.create({
    taskId: task.id,
    projectId: failedJob.projectId,
    agentRole: failedJob.agentRole,
    status: 'queued',
    workflowStepKey: decision.stepKey,
    safeCommand: failedJob.safeCommand,
    aiCliMode: 'implement',
    aiCliProvider: failedJob.aiCliProvider,
    aiCliPrompt: repairPrompt,
  } as never)

  return {
    status: 'repair_job_created',
    jobId: repairJob.id,
    stepKey: decision.stepKey,
    attempt: decision.attempt,
  }
}

/**
 * Stage 2起動の同期フェーズ。LLMを実行せず、pureな判定とcanonical prompt構築のみを行う。
 *
 * 戻り値が 'queue' の場合、呼び出し元は **terminal Job update と同一transaction** で
 * design_review_run を queued として永続化する。これによりcrashしても
 * 「Jobはfailed / runは無い」というlost-trigger windowが生じない。
 */
export function prepareRepairFlow(storage: IStorage, input: RepairFlowInput): RepairPreparation {
  const { failedJob, review } = input

  const task = storage.tasks.findById(failedJob.taskId)
  if (!task) return { action: 'skip', reason: 'task not found' }
  if (task.status === 'blocked' || task.status === 'done') {
    return { action: 'skip', reason: `task is ${task.status}` }
  }

  const priorJobs = storage.jobs.findByTaskId(task.id)
  const priorReviews = storage.reviewResults.findByTaskId(task.id)
  const facts = extractFailureFacts(failedJob, review)

  const decision = decideRepairAction(
    failedJob.id,
    toPriorRepairJobs(priorJobs, priorReviews, {
      jobId: failedJob.id,
      status: 'failed',
      facts,
    }),
    facts,
  )
  if (decision.action === 'escalate') return { action: 'escalate', reason: decision.reason }

  if (priorJobs.some((job) => job.workflowStepKey === decision.stepKey)) {
    return { action: 'skip', reason: 'repair job already exists for this failure' }
  }
  if (storage.designReviewRuns.findActiveByTaskId(task.id)) {
    return { action: 'skip', reason: 'a design review run is already active for this task' }
  }

  const designText = buildRepairPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    job: {
      exitCode: failedJob.exitCode,
      stderr: failedJob.stderr,
      changedFiles: failedJob.changedFiles,
      failureKind: failedJob.failureMetadata?.kind,
      workspaceState: failedJob.failureMetadata?.workspaceState,
    },
    review: review
      ? { status: review.status, summary: review.summary, findings: review.findings }
      : undefined,
    qa: input.qaResults?.map((qa) => ({
      type: qa.type, status: qa.status, summary: qa.summary, details: qa.details,
    })),
    attempt: decision.attempt,
    requireDifferentApproach: decision.requireDifferentApproach,
  })

  return {
    action: 'queue',
    run: {
      taskId: task.id,
      taskTitle: task.title,
      designText,
      designTextHash: computeDesignTextHash(designText),
      changedFiles: failedJob.changedFiles ?? [],
    },
    stepKey: decision.stepKey,
    attempt: decision.attempt,
  }
}

/** Taskを既存のHuman escalation（blocked）へ入れる。呼び出し元から明示的に使う。 */
export function escalateTaskToHuman(storage: IStorage, taskId: string): void {
  const task = storage.tasks.findById(taskId)
  if (task && task.status !== 'blocked') {
    storage.tasks.update(taskId, { status: 'blocked' })
  }
}

/**
 * durable にqueuedとなったrunを実行し、ALIGNEDならrepair Jobを作る。
 *
 * startup recovery からも、PATCH直後のkickからも同じ経路で呼ばれる。
 * claim_token fencing により、両方から同時に呼ばれても実行は1本に絞られる。
 */
export async function executeQueuedRepair(
  storage: IStorage,
  run: DesignReviewRun,
  stepKey: string,
  deps: CoordinatorDeps = buildDefaultCoordinatorDeps(),
): Promise<RepairFlowOutcome> {
  // Repairは「あるTaskの実装をやり直す」という概念そのものがTask固有であり、
  // review_kind='roadmap'（Whole-Roadmap Review、まだ存在しない）はここへは来ない設計。
  // taskId は型上optionalになった（DesignReviewRun.taskId?: string）ため、想定外に
  // roadmap kindのrunがここへ渡された場合はnon-null assertionで握り潰さずfail-closedにする。
  if (run.reviewKind !== 'task' || run.taskId === undefined) {
    return {
      status: 'escalated',
      reason: `executeQueuedRepair only supports reviewKind=task, got ${run.reviewKind}`,
    }
  }
  const taskId = run.taskId

  const sourceJobId = stepKey.slice(REPAIR_STEP_PREFIX.length).split(':')[0]
  const sourceJob = storage.jobs.findById(sourceJobId)
  // source Jobが引けないとprojectId / safeCommand / providerを復元できない。
  // 部分的に埋めた不完全なJobを作るより、人へ渡すほうが安全side。
  if (!sourceJob) {
    escalateTaskToHuman(storage, taskId)
    return { status: 'escalated', reason: 'source job for the repair chain is missing' }
  }

  const outcome = await executeDesignReviewRun(storage, run, deps)
  if (outcome.status === 'stale' || outcome.status === 'not_claimable') {
    return { status: 'already_started', stepKey }
  }
  if (outcome.status !== 'evidence_registered') {
    escalateTaskToHuman(storage, taskId)
    return {
      status: 'escalated',
      reason: `design review did not align (${outcome.status}${outcome.decision ? `: ${outcome.decision}` : ''})`,
    }
  }

  if (storage.jobs.findByTaskId(taskId).some((job) => job.workflowStepKey === stepKey)) {
    return { status: 'already_started', stepKey }
  }

  // review済みpromptをそのままaiCliPromptにする（追記・変更しない）。
  const repairJob = storage.jobs.create({
    taskId,
    projectId: sourceJob.projectId,
    agentRole: sourceJob.agentRole,
    status: 'queued',
    workflowStepKey: stepKey,
    safeCommand: sourceJob.safeCommand,
    aiCliMode: 'implement',
    aiCliProvider: sourceJob.aiCliProvider,
    aiCliPrompt: run.designText,
  } as never)

  return { status: 'repair_job_created', jobId: repairJob.id, stepKey, attempt: run.attemptCount }
}
