import type { Task } from '@ai-team/shared'
import type { IStorage, ResumeBlockedTaskResult } from '../storage/interface'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteDesignReview,
  type CoordinatorDeps,
} from './designReviewCoordinator'

export const RESUME_DESIGN_REVIEW_FAILED = 'RESUME_DESIGN_REVIEW_FAILED' as const

export type ResumeBlockedTaskWithDesignReviewResult =
  | ResumeBlockedTaskResult
  | {
      ok: false
      code: typeof RESUME_DESIGN_REVIEW_FAILED
      reason: string
      reviewError?: string
    }

/**
 * Resume a blocked Task through the existing storage producer and, when that producer reports
 * that the new instruction has no matching Design Review evidence, review exactly that prompt
 * before retrying once.
 *
 * This is the single recovery path used by both HTTP and the in-process PL. Actor attribution is
 * deliberately left to the callers because the HTTP route derives it from credentials while the
 * PL derives it from the in-process execution boundary.
 */
export async function resumeBlockedTaskWithDesignReview(
  storage: IStorage,
  input: {
    task: Pick<Task, 'id' | 'title'>
    instructionPrompt: string
    coordinatorDeps?: CoordinatorDeps
  },
): Promise<ResumeBlockedTaskWithDesignReviewResult> {
  let resumed = storage.jobs.resumeBlockedTask({
    taskId: input.task.id,
    instructionPrompt: input.instructionPrompt,
  })

  if (!resumed.ok && resumed.code === 'DESIGN_REVIEW_PRECONDITION_FAILED') {
    const review = await createAndExecuteDesignReview(storage, {
      taskId: input.task.id,
      taskTitle: input.task.title,
      designText: input.instructionPrompt,
      changedFiles: [],
    }, input.coordinatorDeps ?? buildDefaultCoordinatorDeps())

    if (review.status !== 'evidence_registered') {
      return {
        ok: false,
        code: RESUME_DESIGN_REVIEW_FAILED,
        reason: `Resume instruction Design Review returned ${review.status}`,
        ...(review.error !== undefined ? { reviewError: review.error } : {}),
      }
    }

    resumed = storage.jobs.resumeBlockedTask({
      taskId: input.task.id,
      instructionPrompt: input.instructionPrompt,
    })
  }

  return resumed
}
