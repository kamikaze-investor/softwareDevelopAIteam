/**
 * **consume 済み ApprovalRequest を repair chain の根（recovery epoch）として読む。**
 *
 * ## なぜ ApprovalRequest なのか
 *
 * repair budget（`MAX_REPAIR_ATTEMPTS`）は自律実行の安全境界である。chain の根を
 * どこに置くかがそのまま「budget を誰が更新できるか」になるので、根は
 * **PL が自力で作れない stored fact** でなければならない。
 *
 * `resume:` は使えない。`resume_task` は PL が in-process で実行でき
 * （`pl/executionLoop.ts` が `storage.jobs.resumeBlockedTask()` を直接呼ぶ）、
 * 作られる Job 行は HTTP 経由のものと**完全に同一**である（`jobs` に actor 列は無い）。
 * つまり `resume:` を根にすると、repair 上限 → blocked → resume → budget 更新、を
 * PL が自分で回せてしまう。
 *
 * `approval_requests` はそうならない。`APPROVED` を書けるのは `recordDecision()` だけで、
 * その呼び出し元は `PATCH /api/approval-requests/:id/status`（`routes/approvalGate.ts`）
 * **1 箇所しかなく、in-process の呼び出し元が存在しない**。PL は自分へ HTTP を打たないので、
 * PL からこの事実を作る経路が無い。
 *
 * ## この保証の正確な範囲
 *
 * ここで機械的に言えるのは **「autonomous PL loop では作れない外部 approval 経路を通った」**
 * までである。**「human identity が暗号的に証明された」ではない。** legacy single-token 認証の
 * 現 production では、`API_TOKEN` を持つ主体なら HTTP でこの route を呼べるためである
 * （credential split 後は ADMIN credential によって operator 認可としてさらに強く束縛される）。
 * この差をコメントでも PR でも過大に述べない。
 *
 * ## 束縛
 *
 * Task 単位だけでは「この Task の何かを承認した」以上の意味を持たない。そこで既存
 * `requestedAction` に **exact review Job id** を載せて束縛する（`abort_task` が
 * `requestedAction` を束縛材料に使っているのと同じ形で、新しい承認種別は足していない）。
 */

import type { IStorage } from '../storage/interface'
import type { Job, ReviewResult } from '@ai-team/shared'

/** `requestedAction` の接頭辞。**新しい承認種別ではなく、既存の自由文字列欄の値**である。 */
export const REPAIR_RECOVERY_ACTION_PREFIX = 'repair_from_stored_review:'

/** その review Job に対する recovery を表す `requestedAction`。 */
export function repairRecoveryActionFor(reviewJobId: string): string {
  return `${REPAIR_RECOVERY_ACTION_PREFIX}${reviewJobId}`
}

/** `requestedAction` から review Job id を取り出す。形が違えば undefined。 */
export function parseRepairRecoveryAction(requestedAction: string | undefined): string | undefined {
  if (requestedAction === undefined) return undefined
  if (!requestedAction.startsWith(REPAIR_RECOVERY_ACTION_PREFIX)) return undefined
  const reviewJobId = requestedAction.slice(REPAIR_RECOVERY_ACTION_PREFIX.length)
  return reviewJobId.length > 0 ? reviewJobId : undefined
}

/** 保存済みレコードだけで再構成した「どの実装のどのレビューか」。 */
export type StoredReviewChain =
  | { ok: true; reviewJob: Job; implementJob: Job; review: ReviewResult; expectedAction: string }
  | { ok: false; reason: string }

/**
 * review Job id から **Task / 実装 Job / 保存済み verdict** を server side で組み直す。
 *
 * 呼び出し元が渡すのは `reviewJobId` という **selector だけ**であり、ここで解決した
 * 行以外は一切 authorization の根拠にしない。関連が1つでも繋がらなければ fail-closed。
 */
export function resolveStoredReviewChain(
  storage: IStorage,
  taskId: string,
  reviewJobId: string,
): StoredReviewChain {
  const reviewJob = storage.jobs.findById(reviewJobId)
  if (!reviewJob) {
    return { ok: false, reason: `review job ${reviewJobId} does not exist` }
  }
  if (reviewJob.taskId !== taskId) {
    return { ok: false, reason: `review job ${reviewJobId} belongs to another task` }
  }

  const implementJobId = /^implement:(.+):review$/.exec(reviewJob.workflowStepKey ?? '')?.[1]
  if (implementJobId === undefined) {
    return { ok: false, reason: `job ${reviewJobId} is not a canonical implementation review` }
  }

  const implementJob = storage.jobs.findById(implementJobId)
  if (!implementJob) {
    return { ok: false, reason: `implementation job ${implementJobId} does not exist` }
  }
  if (implementJob.taskId !== taskId) {
    return { ok: false, reason: `implementation job ${implementJobId} belongs to another task` }
  }

  const review = storage.reviewResults
    .findByTaskId(taskId)
    .find((result) => result.jobId === reviewJob.id)
  if (!review) {
    return { ok: false, reason: `no stored review result for review job ${reviewJobId}` }
  }

  // **修正を要求したレビューだけを再駆動する。**
  //
  // `prepareRepairFlow()` の verdict 検査は blocked Task の admission の中にしかない。
  // Task が `pending` 等なら、そこは通らずに `decideRepairAction()` へ進む。つまり
  // この経路が自分で確かめないと、**何も要求していない approved なレビューから
  // repair と recovery epoch を作れてしまう**（独立レビュー指摘）。
  // review PATCH 側の Stage 2 分岐が `!approved` を条件にしているのと同じ制約を、
  // ここでも入口で課す。
  if (review.status !== 'changes_requested') {
    return {
      ok: false,
      reason: `stored review for ${reviewJobId} is ${review.status}, not changes_requested`,
    }
  }

  return {
    ok: true,
    reviewJob,
    implementJob,
    review,
    expectedAction: repairRecoveryActionFor(reviewJob.id),
  }
}

/**
 * この Task で **epoch が成立している実装 Job の id**。
 *
 * 成立の条件は「その review Job を名指しした ApprovalRequest が `CONSUMED` であること」。
 * `APPROVED` のままは数えない —— 承認されただけで使われていない approval は、
 * まだ epoch を開始していないからである（consume が epoch 開始の一点になる）。
 */
export function epochCoveredImplementationJobIds(
  storage: IStorage,
  taskId: string,
): Set<string> {
  const covered = new Set<string>()

  for (const request of storage.approvalRequests.findByTaskId(taskId)) {
    if (request.status !== 'CONSUMED') continue
    const reviewJobId = parseRepairRecoveryAction(request.requestedAction)
    if (reviewJobId === undefined) continue

    // 承認行の文字列を信じず、**Job 側から関連を引き直す**。
    const chain = resolveStoredReviewChain(storage, taskId, reviewJobId)
    if (!chain.ok) continue
    covered.add(chain.implementJob.id)
  }

  return covered
}
