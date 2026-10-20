import type { Task } from '@ai-team/shared'
import type { IStorage, ResumeBlockedTaskResult } from '../storage/interface'
import type { ResumeActorEvidence } from './resumeActor'
import { designReviewRunAnsweredByHumanResume } from './repairFlow'
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
 * This is the single recovery path used by both HTTP and the in-process PL. The actor is decided by
 * the callers (the HTTP route from credentials, the PL from the in-process execution boundary) and
 * passed through as `resumedBy`; storage writes the `resume_actor` row in the same transaction that
 * creates the resume Job (G-01), so a resume never commits without its authority evidence.
 */
export async function resumeBlockedTaskWithDesignReview(
  storage: IStorage,
  input: {
    task: Pick<Task, 'id' | 'title'>
    instructionPrompt: string
    resumedBy: ResumeActorEvidence
    coordinatorDeps?: CoordinatorDeps
  },
): Promise<ResumeBlockedTaskWithDesignReviewResult> {
  let resumed = storage.jobs.resumeBlockedTask({
    taskId: input.task.id,
    instructionPrompt: input.instructionPrompt,
    resumedBy: withAnsweredRun(storage, input.task.id, input.resumedBy),
  })

  if (!resumed.ok && resumed.code === 'DESIGN_REVIEW_PRECONDITION_FAILED') {
    const review = await createAndExecuteDesignReview(storage, {
      taskId: input.task.id,
      taskTitle: input.task.title,
      designText: input.instructionPrompt,
      changedFiles: [],
      // resume provenance: この review の判定を待つのは、いま resume しようとした Job である（C3-c）。
      ...(resumed.sourceJobId !== undefined ? { resumeSourceJobId: resumed.sourceJobId } : {}),
    }, input.coordinatorDeps ?? buildDefaultCoordinatorDeps())

    // 判定がまだ無い（queued / 別の同一性の active run と競合 / 別 executor が実行中で読み直しても
    // 終端していない）。否定ではないので FAILED にしない。終端していれば coordinator が読み直した
    // 結果（evidence_registered / not_aligned / failed）がここへ届く。
    if (
      review.status === 'requeued' || review.status === 'contended'
      || review.status === 'not_claimable' || review.status === 'stale'
    ) {
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

    // review を起票したときの resume 対象を固定する。待つ間に別の Job が最新になっていたら
    // storage が RESUME_TARGET_CHANGED で拒否する（review が見ていない Job を resume しない）。
    const reviewedSourceJobId = resumed.sourceJobId
    resumed = storage.jobs.resumeBlockedTask({
      taskId: input.task.id,
      instructionPrompt: input.instructionPrompt,
      resumedBy: withAnsweredRun(storage, input.task.id, input.resumedBy),
      ...(reviewedSourceJobId !== undefined ? { expectedSourceJobId: reviewedSourceJobId } : {}),
    })
  }

  return resumed
}

/**
 * Human Resume は、作成時点で Task を止めていた Design Review run を明示的に答える（R-4）。
 * その id を resume_actor 行（resume Job と同じ transaction で書かれる）へ載せる。human 以外は何も答えない。
 */
function withAnsweredRun(storage: IStorage, taskId: string, resumedBy: ResumeActorEvidence): ResumeActorEvidence {
  if (resumedBy.actorClass !== 'human') return resumedBy
  const answeredRunId = designReviewRunAnsweredByHumanResume(storage, taskId)
  return answeredRunId === undefined ? resumedBy : { ...resumedBy, answeredRunId }
}
