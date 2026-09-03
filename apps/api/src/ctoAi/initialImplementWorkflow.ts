import type { Job, Task } from '@ai-team/shared'
import {
  buildDesignContract,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import { mapFileToFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
import { TARGET_WORKING_DIR } from '../config/targetWorkingDir'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteDesignReview,
  type CoordinatorDeps,
} from '../designReview/designReviewCoordinator'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import type { IStorage } from '../storage/interface'

export type InitialImplementWorkflowResult =
  | { taskId: string; status: 'created'; job: Job }
  | { taskId: string; status: 'skipped'; reason: string; retryable?: boolean }

function initialWorkflowStepKey(taskId: string): string {
  return `task:${taskId}:initial-implement`
}

export function buildInitialImplementAiCliPrompt(task: Pick<Task, 'description' | 'allowedPaths'>): string {
  const designContract = buildDesignContract({
    slugs: selectPrincipleSlugs({
      predictedFocuses: (task.allowedPaths ?? []).flatMap(mapFileToFocuses),
    }),
    principles: loadEngineeringPrinciples(),
  })

  return `${task.description}\n\n${designContract}`
}

/**
 * DB Task同期とroadmap Markdown保存の成功後にだけ呼ぶ初回workflow producer。
 * promptはTask.descriptionにDesign Contractを付与したcanonical文字列を使用する。
 */
export async function createInitialImplementWorkflow(
  storage: IStorage,
  taskId: string,
  deps: CoordinatorDeps = buildDefaultCoordinatorDeps(),
): Promise<InitialImplementWorkflowResult> {
  const task = storage.tasks.findById(taskId)
  if (!task) return { taskId, status: 'skipped', reason: 'task not found' }

  const project = storage.projects.findById(task.projectId)
  if (!project || project.status === 'archived') {
    return { taskId, status: 'skipped', reason: 'project is unavailable' }
  }
  // paused (or any other non-running, non-archived status) is a temporary state: unlike
  // archived, it should not permanently fail a pending task_continuation. Marking this
  // retryable leaves the continuation 'pending' so the existing Worker Outbox resend
  // (jobs.ts's 503-on-pending-continuation response) naturally retries it once the
  // Project is running again, without a new Gate/Queue/daemon.
  if (project.status !== 'running') {
    return { taskId, status: 'skipped', reason: 'project is not running', retryable: true }
  }
  if (!isInitialWorkflowTarget(task)) {
    return { taskId, status: 'skipped', reason: 'task is not an initial workflow target' }
  }
  // selectNextContinuableTask() と同じdependency判定をproducer側にも適用する。
  // これが無いと、依存未達のTaskにも初回Jobが即座に作られ、依存元Taskの完了前に
  // 同じ共有workspaceへ書き込まれてしまう（既報Issueと同一の根本原因）。
  const siblingsById = new Map(
    storage.tasks.findByProjectId(task.projectId).map((sibling) => [sibling.id, sibling]),
  )
  if (!task.dependencies.every((dependencyId) => siblingsById.get(dependencyId)?.status === 'done')) {
    return { taskId, status: 'skipped', reason: 'task dependencies are not yet done', retryable: true }
  }

  const stepKey = initialWorkflowStepKey(task.id)
  if (storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey === stepKey)) {
    return { taskId, status: 'skipped', reason: 'initial workflow job already exists' }
  }

  // Job Gateは常に実行する。すでに同一Task・同一prompt hashのALIGNED evidenceがあれば、
  // crash/replay時にReviewを再実行せずそのevidenceを再利用する。
  const aiCliPrompt = buildInitialImplementAiCliPrompt(task)
  const jobInput: Omit<Job, 'id' | 'createdAt'> = {
    taskId: task.id,
    projectId: task.projectId,
    workflowStepKey: stepKey,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: TARGET_WORKING_DIR },
    aiCliProvider: task.provider ?? 'claude_code',
    aiCliPrompt,
    aiCliMode: 'implement',
  }
  let gate = checkImplementJobDesignReviewEvidence(jobInput, storage.designReviewEvidence)
  if (!gate.ok) {
    const review = await createAndExecuteDesignReview(storage, {
      taskId: task.id,
      taskTitle: task.title,
      designText: aiCliPrompt,
      changedFiles: [],
    }, deps)
    if (review.status !== 'evidence_registered') {
      return {
        taskId,
        status: 'skipped',
        reason: `design review did not align (${review.status})`,
        retryable: review.status === 'requeued' || review.status === 'not_claimable' || review.status === 'stale',
      }
    }
    gate = checkImplementJobDesignReviewEvidence(jobInput, storage.designReviewEvidence)
  }
  if (!gate.ok) return { taskId, status: 'skipped', reason: gate.reason }

  try {
    return { taskId, status: 'created', job: storage.jobs.create(jobInput) }
  } catch (error: unknown) {
    // unique index衝突は並行した同一producerによる既存Jobとして扱う。
    if (storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey === stepKey)) {
      return { taskId, status: 'skipped', reason: 'initial workflow job already exists' }
    }
    throw error
  }
}

function isInitialWorkflowTarget(task: Task): boolean {
  return task.roadmapActive && task.status === 'pending' && task.assignee === 'developer_ai'
}
