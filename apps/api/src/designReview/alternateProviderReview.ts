/**
 * Review provider 枯渇後の **別 provider での正式再審査**（roadmap: `review-provider-exhausted-alternate-rereview`）。
 *
 * provider 側の一時障害で Design Review run が attempt を使い切って `failed` 終端したとき、
 * 同じ Task・同じ設計に対して**新しい run** を作り、Registry から選んだ別 provider で審査させる。
 *
 * ## CEO 判断（2026-09-15）の不変条件と、それをどこで守っているか
 *
 * - **Review を skip しない** … 必ず `createAndExecuteDesignReview()` で新しい run を作って実行する。
 *   ここは evidence も判定も書かない。
 * - **判定は既存の `recomputeDecision()` だけ** … 新しい run の採否は `executeDesignReviewRun()` が
 *   通常 run と同じ経路で再計算し、ALIGNED のときだけ evidence が登録される。
 * - **attempt を使い切った run を再利用しない** … 枯渇 run は読むだけで、claim も requeue もしない。
 *   新しい run は attempt 予算が新品になる。
 * - **既存 BLOCK を override しない** … 同じ設計に否定判定（CONFLICT / UNCERTAIN）で終わった run が
 *   1本でもあれば作らない。provider を替えて否定判定を引き直す経路にしない。
 * - **独立性・有界** … provider 選択は `selectAlternateReviewProvider()`（Registry・vendor 分離・
 *   試行済み除外・回数上限）。選べなければ作らず、呼び出し側は CEO Escalation へ倒す。
 *
 * repair 目的の run（`repairSourceJobId` 付き）は扱わない。repair の successor は
 * `queuedRunDispatch` が持っており、ここから run を作るとその continuation が失われる。
 */

import {
  DEFAULT_DESIGN_REVIEW_PROVIDER_CHAIN,
  selectAlternateReviewProvider,
  type RoleModelRegistryConfig,
} from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import {
  DESIGN_REVIEW_MAX_ATTEMPTS,
  classifyStoredRunJudgment,
  createAndExecuteDesignReview,
  type CoordinatorDeps,
  type ExecuteDesignReviewResult,
} from './designReviewCoordinator'

export type AlternateProviderReviewResult =
  | { ok: false; reason: string }
  | { ok: true; runProvider: string; runModel: string; review: ExecuteDesignReviewResult }

export async function createAlternateProviderDesignReview(
  storage: IStorage,
  input: {
    /** attempt を使い切って終端した run。 */
    exhaustedRunId: string
    /** 既存の Role / Provider / Model Registry。無ければ作らない。 */
    registry: RoleModelRegistryConfig | undefined
  },
  deps: CoordinatorDeps,
): Promise<AlternateProviderReviewResult> {
  const run = storage.designReviewRuns.findById(input.exhaustedRunId)
  if (run === undefined) {
    return { ok: false, reason: `design review run ${input.exhaustedRunId} not found` }
  }
  if (run.reviewKind !== 'task' || run.taskId === undefined) {
    return { ok: false, reason: `design review run ${run.id} is not a task-kind run` }
  }
  if (run.status !== 'failed' || run.attemptCount < DESIGN_REVIEW_MAX_ATTEMPTS) {
    return {
      ok: false,
      reason: `design review run ${run.id} is not exhausted (status=${run.status}, attempt ${run.attemptCount}/${DESIGN_REVIEW_MAX_ATTEMPTS})`,
    }
  }
  if (run.repairSourceJobId !== undefined) {
    return { ok: false, reason: `design review run ${run.id} is a repair-purpose run; its continuation is owned by the repair flow` }
  }
  if (storage.tasks.findById(run.taskId) === undefined) {
    return { ok: false, reason: `task ${run.taskId} not found` }
  }
  // 枯渇 run がもう Task の最新でなければ、誰かが既に次の review を始めている。重ねて作らない。
  if (storage.designReviewRuns.findLatestByTaskId(run.taskId)?.id !== run.id) {
    return { ok: false, reason: `design review run ${run.id} is no longer the latest run for task ${run.taskId}` }
  }

  const sameDesign = storage.designReviewRuns.findByTaskId(run.taskId)
    .filter((candidate) => candidate.designTextHash === run.designTextHash)

  const negative = sameDesign.find((candidate) => classifyStoredRunJudgment(candidate) === 'negative')
  if (negative !== undefined) {
    return {
      ok: false,
      reason: `design review run ${negative.id} already returned a negative judgment for this design; a provider change does not override it`,
    }
  }

  const selection = selectAlternateReviewProvider({
    registry: input.registry,
    // provider 指定の無い run は既定連鎖を試したものとして数える。
    triedProviders: sameDesign.flatMap<string>((candidate) =>
      candidate.reviewProvider !== undefined ? [candidate.reviewProvider] : DEFAULT_DESIGN_REVIEW_PROVIDER_CHAIN),
    alternateRunsSoFar: sameDesign.filter((candidate) => candidate.reviewProvider !== undefined).length,
  })
  if (!selection.ok) {
    return { ok: false, reason: selection.reason }
  }

  const review = await createAndExecuteDesignReview(storage, {
    taskId: run.taskId,
    taskTitle: run.taskTitle,
    designText: run.designText,
    changedFiles: run.changedFiles,
    reviewProvider: selection.provider,
    reviewModel: selection.model,
  }, deps)

  return { ok: true, runProvider: selection.provider, runModel: selection.model, review }
}
