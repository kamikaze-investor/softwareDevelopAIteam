/**
 * **保存済みの `changes_requested` を、履歴を変えずに canonical repair 経路へ戻す。**
 *
 * ## なぜ必要か（production 実測・2026-09-21）
 *
 * Stage 2 は review の PATCH イベントでしか起動しない
 * （`routes/jobs.ts` の `implement:<id>:review` 分岐）。Task `c3849205` では、
 * その PATCH が #266 の修正前に一度消費されてしまっていた。実装 `eec46736` は成功し、
 * Independent Review `026fe5a3` は `changes_requested` を返して保存済みなのに、
 * **イベントが過去に消費済みであることだけを理由に**誰も repair を作れない状態になった。
 *
 * 同じ review Job に2回目の verdict を付けることはできない
 * （`implement:<id>:review` は `ux_jobs_workflow_step_key` で全体一意）。
 * よってここでは**新しい review を作らず**、既に保存されている verdict を
 * 既存 `prepareRepairFlow()` へもう一度渡すだけにする。
 *
 * ## 何を authorization にしているか
 *
 * 呼び出し元が渡すのは `reviewJobId` という **selector だけ**である。verdict も findings も
 * provider も status も allowedPaths も attempt 数も受け取らない。判定材料はすべて
 * `resolveStoredReviewChain()` が保存済み行から組み直す。
 *
 * repair budget の chain 根（recovery epoch）になるのは **consume 済み ApprovalRequest** である。
 *
 * **権限の出どころは `APPROVED` であって `CONSUMED` ではない。** `APPROVED` を書く実装は
 * どれも `PATCH /api/approval-requests/:id/status` の先にしかなく、in-process の呼び出し元が
 * 無い。よって **autonomous PL loop は承認そのものを作れない**（`repairRecoveryEpoch.ts` に詳細）。
 *
 * 一方 `CONSUMED` への遷移は、ここ（`verifyAndConsumeForTaskAction()`）と既存の汎用 consume
 * route の両方が書く。**consume は承認を使い切る操作であって、承認を生む操作ではない**ので、
 * 書き手が複数あっても epoch の根拠は弱まらない —— どの経路で使い切られても、その前に
 * `APPROVED` があったことは変わらないためである。
 * 以前ここには「consume 済み ApprovalRequest は PATCH からしか作れない」と書いていたが、
 * それは `APPROVED` の話を `CONSUMED` へ広げた誤りだった（独立レビュー指摘）。
 *
 * ここで言えるのはそこまでで、「human identity が暗号的に証明された」ではない。
 *
 * ## consume は最後に置く
 *
 * 承認を使い切ってから初めて不適格が分かる、という構造にしない。approval を作る前に
 * **同じ `prepareRepairFlow()`** で下見し、admission で落ちるものや epoch では解決しない
 * escalate はそこで返す。approval を消費するのは、残る差分が budget だけになってからである。
 */

import { createHash } from 'node:crypto'
import type { IStorage } from '../storage/interface'
import type { DesignReviewRun } from '../storage/interface'
import type { Job, ReviewResult } from '@ai-team/shared'
import { escalateTaskToHuman, executeQueuedRepair, prepareRepairFlow } from './repairFlow'
import { resolveStoredReviewChain } from './repairRecoveryEpoch'

/** 承認の有効期限。既存 `APPROVAL_REQUEST_TTL_MINUTES` と同じ考え方で、新しい値を作らない。 */
const APPROVAL_TTL_MINUTES = 60

export type RepairFromStoredReviewOutcome =
  | {
      status: 'awaiting_approval'
      approvalRequestId: string
      requestedAction: string
      /** 既存の未期限リクエストを使い回した場合 true（同じ要求で行を増やさない）。 */
      reused: boolean
    }
  | { status: 'queued'; stepKey: string; runId: string }
  | { status: 'escalated'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; code: string; reason: string }

export interface RepairFromStoredReviewDeps {
  /** queued run の実行キック。既定は既存 Stage 2 executor。 */
  kick?: (storage: IStorage, run: DesignReviewRun, stepKey: string) => void
}

function defaultKick(storage: IStorage, run: DesignReviewRun, stepKey: string): void {
  void executeQueuedRepair(storage, run, stepKey).catch(() => {
    // 実行失敗は run が queued のまま残り、既存の startup recovery が拾う。
    // ここで握り潰しても、作られた run の記録は失われない。
  })
}

/**
 * schema が要求する記述欄を、保存済みの事実から埋める。
 *
 * **これらは authorization の根拠ではない。** 根拠は APPROVED 決定・Task 束縛・
 * `requestedAction` の一致・一回限りの consume の4点だけである。
 */
function describeTarget(implementJobId: string, reviewJobId: string): {
  targetBranch: string
  targetCommit: string
  targetDiffHash: string
} {
  return {
    targetBranch: 'stored-review-recovery',
    targetCommit: implementJobId,
    targetDiffHash: createHash('sha256').update(`${implementJobId}:${reviewJobId}`).digest('hex'),
  }
}

function isUnexpired(expiresAt: string): boolean {
  const ms = new Date(expiresAt).getTime()
  return Number.isFinite(ms) && ms > Date.now()
}

export function repairFromStoredReview(
  storage: IStorage,
  input: { taskId: string; reviewJobId: string },
  deps: RepairFromStoredReviewDeps = {},
): RepairFromStoredReviewOutcome {
  const task = storage.tasks.findById(input.taskId)
  if (!task) {
    return { status: 'rejected', code: 'TASK_NOT_FOUND', reason: `Task ${input.taskId} does not exist` }
  }

  // 1. **この経路は `blocked` な Task 専用である。**
  //
  //    `prepareRepairFlow()` の admission（実装が成功しているか / canonical な resume
  //    successor か / review と実装の対応 / allowedPaths が使えるか・範囲内か /
  //    critical finding / Design Review が ALIGNED か / live Job 競合）は
  //    **`task.status === 'blocked'` の枝の中にしかない**。他の状態の Task はそこを
  //    通らずに `decideRepairAction()` へ進むので、この経路が blocked 以外も受け付けると、
  //    それら全部を迂回できてしまう（独立レビュー指摘・round 3。round 2 で verdict だけを
  //    塞いだが、同じ形の穴が他の条件にも残っていた）。
  //
  //    admission を別実装で呼び直すと**同じ規則が2箇所**になるので、そうはしない。
  //    admission が実際に走る状態だけを受け付ける。復旧が要るのは止まった Task であり、
  //    それは定義上 `blocked` である（production `c3849205` もそうだった）。
  if (task.status !== 'blocked') {
    return {
      status: 'rejected',
      code: 'TASK_NOT_BLOCKED',
      reason:
        `Task ${input.taskId} is ${task.status}, not blocked; the stored-review recovery path`
        + ' only runs where the full repair admission runs',
    }
  }

  // 2. selector から trusted chain を組み直す。ここが繋がらなければ何も作らない。
  const chain = resolveStoredReviewChain(storage, task.id, input.reviewJobId)
  if (!chain.ok) {
    return { status: 'rejected', code: 'INVALID_REVIEW_SELECTOR', reason: chain.reason }
  }

  // 3. **approval を作る前に下見する。** 同じ `prepareRepairFlow()` を使うので、
  //    ここに簡易判定は無い。epoch があっても変わらない不適格は、この時点で返す。
  const dryRun = prepareRepairFlow(storage, {
    failedJob: chain.implementJob,
    review: chain.review,
  })
  if (dryRun.action === 'skip') {
    return { status: 'skipped', reason: dryRun.reason }
  }
  if (dryRun.action === 'escalate' && dryRun.code !== 'attempt_limit') {
    // budget 以外の理由での escalate は recovery epoch では解決しない。承認を無駄にしない。
    return { status: 'escalated', reason: dryRun.reason }
  }

  // 4. **この generation が既に human authorized なら、承認をもう一度要求しない。**
  //
  //    判断材料は canonical な repair 判定が出した `generation` そのものである。
  //    **route 側で ancestry を数え直さない。**
  //
  //    以前ここは「この実装 Job 自身が consume 済み epoch に含まれるか」だけを見ていた。
  //    それだと repair descendant を認識できない —— production `c3849205` では
  //    `eec46736` の human_recovery generation に属する `repair:eec46736:1` が
  //    「未 authorized」と判定され、**同じ generation に対して2枚目の承認を要求し、
  //    それを消費すれば depth が 0 に戻って予算が作り直されるところだった**
  //    （CEO 指示・2026-09-23）。
  //
    //  `escalate` でも同じ判定を使う。上限に達した human generation に対して
    //  さらに承認を要求すると、承認のたびに予算が作り直せてしまう。その場合は
    //  `evaluateAndAct()` がそのまま escalate を返す（新しい承認は作らない）。
  if (dryRun.generation?.rootKind === 'human_recovery') {
    return evaluateAndAct(storage, task.id, chain, deps)
  }

  // 5. この exact review に束縛された承認を探す。
  const existing = storage.approvalRequests
    .findByTaskId(task.id)
    .filter((request) => request.requestedAction === chain.expectedAction)

  const approved = existing.find(
    (request) => request.status === 'APPROVED' && isUnexpired(request.expiresAt),
  )

  if (!approved) {
    const waiting = existing.find(
      (request) => request.status === 'WAITING_FOR_USER' && isUnexpired(request.expiresAt),
    )
    if (waiting) {
      // **同じ要求で行を増やさない。** 既存の未期限リクエストをそのまま返す。
      return {
        status: 'awaiting_approval',
        approvalRequestId: waiting.id,
        requestedAction: chain.expectedAction,
        reused: true,
      }
    }

    const created = storage.approvalRequests.create({
      taskId: task.id,
      ...describeTarget(chain.implementJob.id, chain.reviewJob.id),
      riskLevel: 'HIGH',
      requestedAction: chain.expectedAction,
      status: 'WAITING_FOR_USER',
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60 * 1000).toISOString(),
      invalidIf: [],
      reason:
        `Re-drive the stored review verdict for implementation ${chain.implementJob.id}`
        + ` (review job ${chain.reviewJob.id}).`,
    } as never)

    return {
      status: 'awaiting_approval',
      approvalRequestId: created.id,
      requestedAction: chain.expectedAction,
      reused: false,
    }
  }

  // 6. **最後の authorization step として使い切る。** Task 束縛・action 一致・APPROVED・
  //    未失効を既存実装が再確認し、CAS で一度だけ CONSUMED にする。
  const consumed = storage.approvalRequests.verifyAndConsumeForTaskAction({
    taskId: task.id,
    approvalRequestId: approved.id,
    expectedAction: chain.expectedAction,
  })
  if (!consumed.ok) {
    return { status: 'rejected', code: 'APPROVAL_NOT_CONSUMABLE', reason: consumed.reason }
  }

  // 7. epoch が成立した状態で**もう一度**同じ判定を通す。こちらが正本である。
  //    下見の結果は使わない（consume の前後で storage が変わっているため）。
  return evaluateAndAct(storage, task.id, chain, deps)
}

/**
 * epoch が開いている前提で、**同じ `prepareRepairFlow()`** を通して結果を適用する。
 *
 * consume 直後と、consume 済みの再試行と、両方からここを通る。判定を2箇所に書かない。
 */
function evaluateAndAct(
  storage: IStorage,
  taskId: string,
  chain: { implementJob: Job, review: ReviewResult },
  deps: RepairFromStoredReviewDeps,
): RepairFromStoredReviewOutcome {
  // **保存済み QA 結果も canonical prompt へ載せる。**
  //
  // 通常の review 経路（`routes/jobs.ts`）は既に `qaResults` を `prepareRepairFlow()` へ
  // 渡しており、そこから `buildRepairPrompt()` の `qa` 欄になる。stored-review recovery だけが
  // その配線を持っていなかったので、**同じ責務をここでも使うだけ**である（新しい入力経路は無い）。
  //
  // これが要るのは、保存済み verdict が「その時点で reviewer が見られた証拠」でしかないためで、
  // 後から機械的に確認された事実（例: テストは実際に通っていた）を併せて提示しないと、
  // repair AI は誤った前提のまま修正しに行く。**negative review は消さない。** 両方を
  // 事実として並べ、矛盾は repair AI が扱う。
  //
  // `qaResults` は `prepareRepairFlow()` の中で `buildRepairPrompt()` へ渡るだけで、
  // admission / authority(`rootKind`) / generation budget のどの判定にも入らない。
  // そのため上の dry-run へは配線しない —— 判定が変わらないところで同じ読み取りを
  // 二重に走らせても、承認要否は 1 文字も変わらないためである。
  const preparation = prepareRepairFlow(storage, {
    failedJob: chain.implementJob,
    review: chain.review,
    qaResults: storage.qaResults.findByTaskId(taskId),
  })

  if (preparation.action === 'escalate') {
    escalateTaskToHuman(storage, taskId)
    return { status: 'escalated', reason: preparation.reason }
  }
  if (preparation.action === 'skip') {
    return { status: 'skipped', reason: preparation.reason }
  }

  // `create()` 自身が partial unique index と同じ条件を transaction 内で先に見て、
  // **二重起票せず既存 run を返す**（`storage/sqlite.ts`）。ここで例外を待ち受ける必要は無い。
  const run = storage.designReviewRuns.create(preparation.run)
  ;(deps.kick ?? defaultKick)(storage, run, preparation.stepKey)
  return { status: 'queued', stepKey: preparation.stepKey, runId: run.id }
}
