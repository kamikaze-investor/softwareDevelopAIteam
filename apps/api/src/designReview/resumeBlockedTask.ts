import type { Task } from '@ai-team/shared'
import type { IStorage, ResumeBlockedTaskResult } from '../storage/interface'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteDesignReview,
  type CoordinatorDeps,
} from './designReviewCoordinator'

export const RESUME_DESIGN_REVIEW_FAILED = 'RESUME_DESIGN_REVIEW_FAILED' as const
/**
 * Resume instruction の Design Review が**まだ判定を出していない**（runner が判定を返さず
 * run が queued に戻った）。否定的な判定ではない。同じ instruction で再度呼べば、
 * `designReviewRuns.create()` の active-run dedup により**同じ run** が再開され、ALIGNED に
 * なっていればその evidence で resume が通る（継続は保存済み状態から導かれる）。
 */
export const RESUME_DESIGN_REVIEW_PENDING = 'RESUME_DESIGN_REVIEW_PENDING' as const

export type ResumeBlockedTaskWithDesignReviewResult =
  | ResumeBlockedTaskResult
  | {
      ok: false
      code: typeof RESUME_DESIGN_REVIEW_FAILED | typeof RESUME_DESIGN_REVIEW_PENDING
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

    if (review.status === 'requeued') {
      return {
        ok: false,
        code: RESUME_DESIGN_REVIEW_PENDING,
        reason: 'Resume instruction Design Review has not produced a judgment yet; retry the same instruction',
        ...(review.error !== undefined ? { reviewError: review.error } : {}),
      }
    }
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
