import type { Job, Task } from '@ai-team/shared'
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
  | { taskId: string; status: 'skipped'; reason: string }

function initialWorkflowStepKey(taskId: string): string {
  return `task:${taskId}:initial-implement`
}

/**
 * DB Task同期とroadmap Markdown保存の成功後にだけ呼ぶ初回workflow producer。
 * promptは既存の手動implement経路と同じTask.descriptionをそのまま使用する。
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
  if (!isInitialWorkflowTarget(task)) {
    return { taskId, status: 'skipped', reason: 'task is not an initial workflow target' }
  }

  const stepKey = initialWorkflowStepKey(task.id)
  if (storage.jobs.findByTaskId(task.id).some((job) => job.workflowStepKey === stepKey)) {
    return { taskId, status: 'skipped', reason: 'initial workflow job already exists' }
  }

  const review = await createAndExecuteDesignReview(storage, {
    taskId: task.id,
    taskTitle: task.title,
    designText: task.description,
    changedFiles: [],
  }, deps)
  if (review.status !== 'evidence_registered') {
    return { taskId, status: 'skipped', reason: `design review did not align (${review.status})` }
  }

  // coordinatorが保存したevidenceはtask.descriptionのhashに対して作られている。
  // 既存Job Gateを明示的に再利用し、想定外のcoordinator結果ではfail-closedにする。
  const jobInput: Omit<Job, 'id' | 'createdAt'> = {
    taskId: task.id,
    projectId: task.projectId,
    workflowStepKey: stepKey,
    agentRole: 'developer_ai',
    status: 'queued',
    safeCommand: { kind: 'test', workingDir: TARGET_WORKING_DIR },
    aiCliProvider: task.provider ?? 'claude_code',
    aiCliPrompt: task.description,
    aiCliMode: 'implement',
  }
  const gate = checkImplementJobDesignReviewEvidence(jobInput, storage.designReviewEvidence)
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
