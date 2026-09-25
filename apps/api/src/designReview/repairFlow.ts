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
 *   - repair Job は `workflow_step_key = repair:<sourceJobId>:1` と既存の全体一意index
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
import { posix } from 'node:path'
import { recomputeDecision, type RawStrategicResult } from './designReviewCoordinator'
import {
  REPAIR_STEP_PREFIX,
  decideRepairAction,
  generationResetFacts,
  parseRepairSource,
  walkRepairGeneration,
  type PriorRepairJob,
  type RepairGeneration,
  type RepairFailureFacts,
  type ResumeActorClass,
} from './repairPolicy'
import { epochCoveredImplementationJobIds } from './repairRecoveryEpoch'
import { readResumeActorClasses, recordRepairGeneration } from './resumeActor'

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
        /**
         * successor intent。**この run が終わったら誰を repair するのか**を run 自身へ載せる。
         *
         * `stepKey` は同じ `sourceJobId` から導出される派生値であり、プロセスのスタック上に
         * しか存在しない。dispatch 前に落ちるとそれが失われるため、durable 側へはこちらを持たせる。
         * 全 create 経路が `preparation.run` をそのまま `create()` へ渡すので、
         * ここに載せるだけで4経路すべてが永続化する（呼び出し側の個別処理は作らない）。
         */
        repairSourceJobId: string
      }
      stepKey: string
      attempt: number
      /** この repair が属する generation の確定事実（`decideRepairAction` の出力）。 */
      generation: RepairGeneration
    }
  | {
      action: 'escalate'
      reason: string
      /** `decideRepairAction` の構造化理由。admission で落ちた場合は undefined。 */
      code?: 'attempt_limit' | 'lineage_unreconstructable' | 'no_actionable_information'
      /**
       * lineage を辿れた escalate でだけ入る。
       * **上限に達した generation でも、それが誰の権限で始まったかは確定している。**
       * 呼び出し側がこれを読めないと、既に human authorized な generation に対して
       * さらに authority を要求してしまう（= 承認のたびに予算が作り直される）。
       */
      generation?: RepairGeneration
    }
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
  resumeActorClasses: ReadonlyMap<string, ResumeActorClass>,
  humanRecoveryEpochJobIds: ReadonlySet<string>,
  current?: { jobId: string; status: string; facts: RepairFailureFacts },
): PriorRepairJob[] {
  return jobs.map((job) => ({
    id: job.id,
    workflowStepKey: job.workflowStepKey,
    // resume Job 以外では使われない。引けなければ渡さない（policy 側の既定は `unknown`）。
    resumeActorClass: resumeActorClasses.get(job.id),
    // consume 済み recovery approval がこの実装を根にしているか。既定は false。
    humanRecoveryEpoch: humanRecoveryEpochJobIds.has(job.id),
    ...(job.id === current?.jobId
      ? { status: current.status, facts: current.facts }
      : {
          status: job.status,
          facts: extractFailureFacts(job, reviews.find((review) => review.jobId === job.id)),
        }),
  }))
}

/**
 * `ux_jobs_workflow_step_key` の重複エラーか。
 *
 * repair 作成の手前には既に dedup がある（同じ stepKey の Job / active な design review run）。
 * ただし判定と作成の間に **Design Review の await** が挟まるため、同じ failure event を
 * 2 本同時に処理すると後発が一意制約で落ちる。それは「壊れた」のではなく
 * **既に始まっている**ことの証明なので、`already_started` として扱う。
 * 500 にすると、正しく重複排除できた側が障害に見える。
 */
export function isWorkflowStepKeyConflict(error: unknown): boolean {
  if (error === null || error === undefined) return false
  const candidate = error as { code?: unknown; message?: unknown }
  const message = typeof candidate.message === 'string' ? candidate.message : String(error)
  if (candidate.code !== 'SQLITE_CONSTRAINT_UNIQUE' && !/SQLITE_CONSTRAINT_UNIQUE/.test(message)) {
    return false
  }
  return /workflow_step_key/.test(message)
}

/**
 * 作られた repair Job の generation を、**同じ lineage から derive し直して**既存 audit へ残す。
 *
 * 決定時の値を持ち回らずに derive し直すのは、記録が「実際に存在する Job の系譜」と
 * 必ず一致するようにするためである（決定と生成の間に別 Job が挟まっても、記録は実態を指す）。
 * 判定へは一切戻さない。**ここが失敗しても repair は止めないし、budget も動かない。**
 */
function recordGenerationForCreatedRepairJob(storage: IStorage, repairJob: Job): void {
  try {
    deriveAndRecordRepairGeneration(storage, repairJob)
  } catch (error: unknown) {
    // repair Job は既に作られている。記録のための読み書きで caller を失敗させない
    // （独立レビュー指摘）。落ちた場合の意味は決まっている: 後から generation を知る
    // 手がかりが 1 件減るだけで、判定も予算も変わらない。
    console.warn(
      `[repairFlow] failed to record the repair generation of job ${repairJob.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function deriveAndRecordRepairGeneration(storage: IStorage, repairJob: Job): void {
  const stepKey = repairJob.workflowStepKey
  const sourceJobId = stepKey === undefined ? undefined : parseRepairSource(stepKey)
  if (sourceJobId === undefined) return

  const jobs = storage.jobs.findByTaskId(repairJob.taskId)
  const reviews = storage.reviewResults.findByTaskId(repairJob.taskId)
  const walk = walkRepairGeneration(
    sourceJobId,
    toPriorRepairJobs(
      jobs,
      reviews,
      readResumeActorClasses(storage, jobs),
      epochCoveredImplementationJobIds(storage, repairJob.taskId),
    ),
  )
  if (!walk.ok) return

  recordRepairGeneration(storage, {
    jobId: repairJob.id,
    taskId: repairJob.taskId,
    generationRoot: walk.rootJobId,
    ancestryDepth: walk.depth,
    previousGenerationRoot: walk.previousGenerationRoot,
    // **判定と同じ導出を使う。** ここに三項式を書き直すと、root 種別が増えたときに
    // 片側だけ更新され、監査が reset を「reset していない」と記録する（独立レビュー指摘）。
    ...generationResetFacts(walk),
  })
}

/**
 * Taskを既存のHuman escalation経路へ入れる。
 * 新しいstatusもworkflowも作らず、既存の `blocked` を使う。
 * blockedのTaskはStage 1 retryの対象外であり、既存のresumeエンドポイントで再開できる。
 */
function escalateToHuman(storage: IStorage, task: Task, reason: string): RepairFlowOutcome {
  escalateTaskToHuman(storage, task.id)
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
  // park された Task の失敗を修復しない。repair は queued Job を作る経路であり、
  // Worker は Task の状態を見ずにそれを拾うため、park が黙って取り消される。
  if (storage.tasks.isParked(task.id)) {
    return { status: 'skipped', reason: 'task was parked by abort_task' }
  }

  const priorJobs = storage.jobs.findByTaskId(task.id)
  const priorReviews = storage.reviewResults.findByTaskId(task.id)
  const facts = extractFailureFacts(failedJob, review)

  const decision = decideRepairAction(
    failedJob.id,
    toPriorRepairJobs(
      priorJobs,
      priorReviews,
      readResumeActorClasses(storage, priorJobs),
      epochCoveredImplementationJobIds(storage, task.id),
      {
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

  // **この経路は run へ successor intent（`repairSourceJobId`）を載せていない。**
  // `runRepairFlow()` は review の作成と実行を同一 await の中で完結させる同期的な経路で、
  // 現在 production から呼ばれていない（参照は本 module の test だけ）。dispatch 前に
  // intent を失う窓がそもそも無いため U1 の対象外とした。
  // **再配線するなら、ここでも intent を渡すこと** —— さもないと queued のまま落ちた run が
  // 「何のための review か」を持たない状態に戻る。
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

  // Design Review を待っている間に `abort_task` がこの Task を park しうる。
  // 待つ前の判定のまま queued Job を作ると park が黙って取り消される。
  if (storage.tasks.isParked(task.id)) {
    return { status: 'skipped', reason: 'task was parked by abort_task while the review ran' }
  }

  // review済みpromptをそのままaiCliPromptにする（追記・変更しない）。
  let repairJob: Job
  try {
    repairJob = storage.jobs.create({
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
  } catch (error: unknown) {
    if (isWorkflowStepKeyConflict(error)) {
      // **`ux_jobs_workflow_step_key` は全体一意で、手前の dedup は同一 Task しか見ていない。**
      // 同じ Task が先に作ったのなら「既に進行中」でよい。だが別 Task がこの key を
      // 持っているなら lineage が壊れている（key は**この Task の**失敗 Job を名指す）ので、
      // 黙って進行中扱いにせず人へ渡す（独立レビュー指摘）。
      const ownedByThisTask = storage.jobs
        .findByTaskId(task.id)
        .some((job) => job.workflowStepKey === decision.stepKey)
      if (ownedByThisTask) {
        return { status: 'already_started', stepKey: decision.stepKey }
      }
      return escalateToHuman(
        storage,
        task,
        `repair step key ${decision.stepKey} is already used outside this task`,
      )
    }
    throw error
  }

  recordGenerationForCreatedRepairJob(storage, repairJob)

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
/**
 * `file` が `allowed` のいずれかの内側に**解決される**か。
 *
 * 文字列の前方一致だけでは足りない。`apps/api/src/pl/../routes/jobs.ts` は
 * `apps/api/src/pl/` で始まるのに、解決先は範囲外である。絶対パスや `..` で始まる形も
 * ここで落とす。判定できない形は**内側と見なさない**（fail-closed）。
 */
/**
 * その prefix が **修正範囲として実際に使えるか**。
 *
 * `allowedPaths` は task route では `z.array(z.string())` としか検証されないため、
 * `''` / `'   '` / `/srv/app` / `C:/repo` / `a/../b` が保存されうる。Worker の
 * File Change Guard は正規化せず前方一致で比べるので、これらは**どの変更ファイルにも
 * 一致しない**。そのまま repair を作れば guard で必ず止まる無駄な Job になる。
 *
 * ここで落としておくことで、下の `isInsideAllowedPaths()` が受け取る prefix は
 * 常に相対・`..` 無しになり、正規化の有無で範囲が変わる余地そのものが無くなる。
 */
function scopePrefixForMatch(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}

function isUsableScopePrefix(prefix: string): boolean {
  // **保存された文字列そのものを見る。書き換えてから判定しない。**
  //
  // 以前はここで backslash を `/` に直し、末尾スラッシュを全部剥がしてから判定していた。
  // だが Worker 側の guard は **2 つあり、扱いが違う**:
  //   - `safetyVerifier.ts` は `/+$` を全部剥がし、backslash も `/` に直す
  //   - `fileChangeGuard.ts` は末尾スラッシュを **1 つだけ** 剥がし、backslash は直さない
  // つまり「Worker の guard はこう扱う」と一意に言える形ではない。書き換えてから
  // 「使える」と判断すると、書き換えた形でしか成り立たない結論になる（独立レビュー指摘）。
  //
  // そこで **2 つの guard が同じ prefix を導く形だけ**を通す —— 素直な相対 posix path、
  // 末尾スラッシュは付いていても 1 つまで。そこから外れるものは、repair を作っても
  // どちらの guard で止まるか読めないので、範囲として使えないものとして扱う。
  if (prefix !== prefix.trim()) return false
  if (prefix.includes('\\')) return false
  if (prefix.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(prefix)) return false
  // 空文字・`//`・解決される `..` はここで落ちる（`posix.normalize('')` は `.`、
  // `a//b` は `a/b`、`a/../b` は `b` になり、いずれも元と形が変わる）。
  // 末尾スラッシュ 1 つは正規化で残るので、下の照合形で扱う。
  if (prefix !== posix.normalize(prefix)) return false
  // `.` と `..` は正規化しても残る（`.` / `..` / `../a`）。どの変更ファイルにも一致しない。
  const segments = scopePrefixForMatch(prefix).split('/')
  if (segments.includes('..') || segments.includes('.')) return false
  // 照合形が空になる入力はここまで来ない（空文字は正規化検査、`/` は絶対パス検査で落ちる）。
  // 「念のため」の長さ検査を置いていたが mutation で生き残った —— 結果を変えない検査は
  // 検査ではないので置かない。
  return true
}

function isInsideAllowedPaths(file: string, allowed: readonly string[]): boolean {
  const normalized = posix.normalize(file.split('\\').join('/'))
  if (normalized.startsWith('/') || normalized.startsWith('..')) return false

  return allowed.some((prefix) => {
    // **file 側だけ正規化する。** `apps/api/src/pl/../routes/jobs.ts` は文字列としては
    // 範囲内に見えるが、解決すると外を指す。
    //
    // prefix は `isUsableScopePrefix()` を通ったものだけなので、ここでの照合形は
    // **末尾スラッシュ 1 つを落とすだけ** —— Worker の 2 つの guard が導くのと同じ形である。
    // prefix をこれ以上書き換えない。書き換えれば、また Worker と食い違う。
    const candidate = scopePrefixForMatch(prefix)
    return normalized === candidate || normalized.startsWith(`${candidate}/`)
  })
}

/**
 * 保存済み run から **計算し直した** design review 判定。読めなければ undefined。
 *
 * `resultJson` は runner の raw 出力なので、そこに書かれた `finalDecision` は自己申告である。
 * 既存 `recomputeDecision()` は focus 判定から本来の結論を組み直すためのもので、
 * `blockedTriage` が使っているのと同じ関数である。ここでも同じものを使う。
 */
function safeRecomputedDecision(run: DesignReviewRun): string | undefined {
  if (run.resultJson === undefined) return undefined
  try {
    const raw = JSON.parse(run.resultJson) as RawStrategicResult
    const outcome = recomputeDecision(raw, run.reviewKind, run.changedFiles)
    // 形が壊れていれば rejectedReason が付き decision は UNCERTAIN になる。
    // UNCERTAIN も ALIGNED ではないので、呼び出し側でそのまま skip される。
    return outcome.decision
  } catch {
    // 壊れた結果は「読めなかった」として扱う。呼び出し側は fail-closed で skip する。
    return undefined
  }
}

/**
 * `blocked` の例外を認めるかどうかの判定結果。理由は skip reason にそのまま載る。
 *
 * 認めるときは **照合に使った保存済みレコードそのもの**を返す。呼び出し元は repair を
 * この 2 件から組む。認めた根拠と repair の材料が別物だと、片方しか検証していないことになる。
 */
type BlockedAdmission =
  | { ok: true, implementJob: Job, review: ReviewResult }
  | { ok: false, reason: string }

/**
 * **blocked な Task に repair を作ってよい唯一のケース**かを、既存レコードだけで照合する。
 *
 * ## なぜ必要か
 *
 * `resumeBlockedTask()` は Job を 1 件作るだけで Task status を変えない。よって resume で
 * 再開した実装が成功し、Independent Review が修正を要求しても、Task は `blocked` のままである。
 * 従来の無条件 skip では、その修正要求が **repair にも escalate にもならず消えていた**。
 *
 * ## 何を根拠にするか
 *
 * **呼び出し元の申告を信じない。** 「これは resume 由来だ」「repair できるはずだ」といった
 * caller / PL の主張は一切使わず、すべて保存済みレコードから機械的に確かめる。
 * 1 つでも確かめられなければ従来どおり skip する（fail-closed）。
 */
function repairableBlockedReviewRequest(
  storage: IStorage,
  task: Task,
  candidate: Job,
): BlockedAdmission {
  // 0. **Job を id で読み直す。** 引数の object は呼び出し元が組んだもので、`status` も
  //    `workflowStepKey` も自由に書ける（実際 `routes/jobs.ts` の失敗経路は
  //    `{ ...existing, ...jobUpdate }` という合成 object を渡している）。id 以外を
  //    引数から読むと、下の条件 3・4 は**自己申告の検査**にしかならない（独立レビュー指摘）。
  //    以降はすべて保存された行だけを見る。別 Task の Job を指していれば当然通さない。
  const implementJob = storage.jobs.findById(candidate.id)
  if (!implementJob) return { ok: false, reason: 'implementation job is not a stored job' }
  if (implementJob.taskId !== task.id) {
    return { ok: false, reason: 'implementation job belongs to another task' }
  }

  // 1. **この implement Job に対する review Job を、保存済み Job から引く。**
  //    引数の `review` は使わない。呼び出し元が作った object は「保存された事実」ではなく、
  //    status も findings も自由に書けるためである（独立レビュー指摘）。
  const reviewJob = storage.jobs.findByTaskId(task.id)
    .find((job) => job.workflowStepKey === `implement:${implementJob.id}:review`)
  if (!reviewJob) return { ok: false, reason: 'no review job for this implementation' }

  // 2. **その review Job に対して保存された verdict** を引く。無ければ通さない。
  const stored = storage.reviewResults.findByTaskId(task.id)
    .find((result) => result.jobId === reviewJob.id)
  if (!stored) return { ok: false, reason: 'no stored review result for this implementation' }
  if (stored.status !== 'changes_requested') {
    return { ok: false, reason: `review status is ${stored.status}` }
  }

  // 3. その実装が**成功している**こと。失敗した実装の修正要求はここでは扱わない。
  if (implementJob.status !== 'success') {
    return { ok: false, reason: `implementation job is ${implementJob.status}` }
  }

  // 4. その実装が **blocked のまま正当に成功しうる successor** であること。
  //
  //    2 種類ある。どちらも「Task を blocked のままにしたまま実装が進む」正規経路である:
  //      - `resume:<元Job>:<n>` —— `resumeBlockedTask()` が付ける規約
  //      - `repair:<元Job>:1`   —— Stage 2 が付ける規約
  //
  //    **以前は resume だけを許していた。** そのため production `c3849205` では、
  //    recovery で作られた repair（`repair:eec46736:1`）が成功し、そのレビューが
  //    `changes_requested` を返したのに、ここで「resume successor ではない」として
  //    落ち、repair も escalate も作られず PL が `unknown` で CEO escalation した
  //    （2026-09-23 production 実測）。元のコメントは resume を「唯一の正規経路」と
  //    書いていたが、それは事実として誤りだった。
  //
  //    **`repair:` で始まる、では許さない。** 規約形であることに加えて、
  //    **lineage が実際に再構築できる**ことを既存 walker で確かめる —— source Job の実在 /
  //    同一 Task / 非環 / 一意性はすべてそちらの責務である。ここに別の parser は作らない。
  const stepKey = implementJob.workflowStepKey ?? ''
  const isResumeSuccessor = /^resume:[^:]+:\d+$/.test(stepKey)
  const isRepairSuccessor = parseRepairSource(stepKey) !== undefined
  if (!isResumeSuccessor && !isRepairSuccessor) {
    return { ok: false, reason: 'implementation job is not a canonical resume or repair successor' }
  }

  //    lineage が辿れない実装は、段数も根も確定できない。**推測せず落とす。**
  const taskJobs = storage.jobs.findByTaskId(task.id)
  const lineage = walkRepairGeneration(
    implementJob.id,
    toPriorRepairJobs(
      taskJobs,
      storage.reviewResults.findByTaskId(task.id),
      readResumeActorClasses(storage, taskJobs),
      epochCoveredImplementationJobIds(storage, task.id),
    ),
  )
  if (!lineage.ok) {
    return { ok: false, reason: `repair lineage could not be reconstructed: ${lineage.reason}` }
  }

  //    **repair successor は human authority の generation の中にいなければならない。**
  //
  //    規約形であること＋lineage が再構築できること、では足りない。それを両方満たす
  //    `repair:` chain には **人の権限がどこにも無い `origin` 根のもの**が含まれる ——
  //    通常の repair が走っている最中に Task が別の理由で blocked になれば、その chain は
  //    blocked を跨いで自律継続してしまう。blocked は「人が動くまで自律実行を止める」
  //    状態なので、それは閉じ込めの解除ではなく **安全境界の後退**である
  //    （独立レビュー指摘・2026-09-23 に in-memory で再現）。
  //
  //    判定は既存 walker の `rootKind` をそのまま使う。新しい authority flag も parser も
  //    table も status も作らない。通すのは `human_resume` / `human_recovery` generation の
  //    descendant だけである。**resume successor 側の条件はここで変えない。**
  if (isRepairSuccessor && lineage.rootKind === 'origin') {
    return { ok: false, reason: 'repair successor is not inside a human-authorized generation' }
  }

  // 5. 指摘が **この Task の allowedPaths 内**で直せること。
  //    範囲外のファイルを指す指摘が 1 件でもあれば、repair は scope を越える。
  //
  //    **まず範囲そのものが使えるかを見る。** task route の `allowedPaths` は
  //    `z.array(z.string())` としか検証されないので、`''` / `'   '` / 絶対パスが保存されうる
  //    （roadmap adoption 経路だけが `.min(1)` を課している）。Worker の File Change Guard は
  //    `file === prefix || file.startsWith(prefix + '/')` で比べ、trim もしないので、
  //    そうした prefix は**どの変更ファイルにも一致しない** —— repair を作っても必ず guard で
  //    止まる。「範囲が壊れている」は「どこでも直してよい」ではないので落とす（独立レビュー指摘）。
  const allowed = task.allowedPaths ?? []
  if (allowed.length === 0) return { ok: false, reason: 'task has no allowedPaths' }
  if (!allowed.every(isUsableScopePrefix)) {
    return { ok: false, reason: 'task allowedPaths contains an unusable scope' }
  }
  // **前方一致の前に正規化する。** `apps/api/src/pl/../routes/jobs.ts` は文字列としては
  // `apps/api/src/pl/` で始まるが、解決すると範囲外を指す（独立レビュー指摘）。
  const outside = stored.findings
    .map((finding) => finding.file)
    .filter((file): file is string => typeof file === 'string' && file.length > 0)
    .filter((file) => !isInsideAllowedPaths(file, allowed))
  if (outside.length > 0) {
    return { ok: false, reason: `review findings point outside allowedPaths (${outside[0]})` }
  }

  // 6. **通常 repair で扱ってはいけない指摘が混じっていない**こと。
  //    `critical` は Safety / Authority 相当の判断を求めうるので、既存の escalation へ残す。
  if (stored.findings.some((finding) => finding.severity === 'critical')) {
    return { ok: false, reason: 'review contains a critical finding' }
  }

  // 7. **Design Review が CONFLICT / BLOCK で止まっていない**こと。
  //    その場合の復旧は別責務（`task-design-review-conflict-has-no-recovery-route`）で、
  //    ここで repair を積むと本来の経路を踏み潰す。
  //
  //    **判定は既存の reader に委ねる。** ここで `resultJson` を自前に解釈していたが、
  //    実際に保存されるのは runner の raw stdout で、判定は `finalDecision` /
  //    `focusedReviewResults` / `integrationReviewResult` の形で入る。
  //    自前パーサは `decision` という存在しない欄を読んでおり、**本物の CONFLICT を
  //    取りこぼしていた**（独立レビュー指摘）。
  //
  //    **読めなかったときは通さない。** 以前は `undefined` がそのまま通過していたが、
  //    「判定が読めない」は「CONFLICT ではない」の証明にならない。
  //
  //    **runner の自己申告（`finalDecision`）も信じない。** focus 判定が CONFLICT でも
  //    `finalDecision: ALIGNED` と書いて返せることが既存テストで示されている
  //    （`designReviewCoordinator.test.ts`「runner が finalDecision=ALIGNED と自己申告しても…」）。
  //    既存の `recomputeDecision()` で計算し直した結果だけを使う。
  //    **run があるのに結果が無い場合も通さない。** 失敗した run や attempt 上限に達した run は
  //    `resultJson` が NULL のまま残る。そこを `!== undefined` で素通りさせていたため、
  //    **判定が存在しない Design Review が「問題なし」として扱われていた**（独立レビュー指摘）。
  //    run が 1 つも無いときだけが「まだ Design Review をしていない」であり、それは通してよい。
  const latestRun = storage.designReviewRuns.findLatestByTaskId(task.id)
  if (latestRun !== undefined) {
    const recomputed = safeRecomputedDecision(latestRun)
    if (recomputed === undefined) {
      return { ok: false, reason: 'latest design review decision could not be recomputed' }
    }
    if (recomputed !== 'ALIGNED') {
      return { ok: false, reason: `latest design review is ${recomputed}` }
    }
  }

  // 8. **競合する live Job が無い**こと。動いている Job の上へ repair を積まない。
  //
  //    ただし **この resume の元 Job が `blocked` のまま残っている場合だけ**は除く。
  //    `resumeBlockedTask()` は latest Job が `blocked` のときも受理し、**元の行を blocked の
  //    まま残して** `resume:<元Job>:1` を作る（`sqlite.ts`）。除外しないと、その正規経路で
  //    再開した成果が必ずここで弾かれる —— 直そうとしている閉じ込めを別の形で作り直すことになる。
  //
  //    **除外は `blocked` に限る。** 元 Job は後から `queued` へ戻りうる
  //    （`jobResultApplicationPolicy.ts` の `blocked: ['queued']`、`routes/jobs.ts` の
  //    implement requeue 経路）。stepKey が名指しているというだけで状態を問わず外すと、
  //    **本当に動いている Job の上へ repair を積む**（独立レビュー指摘）。
  //    resume が残した `blocked` という状態そのものが除外の根拠であって、名前ではない。
  //
  //    **外すのは「実装のすぐ上に連続して並ぶ blocked な ancestor」である。**
  //
  //    件数は固定しない。CEO の REJECT → Human Resume は何度でも起こり得て、そのたびに
  //    元の行は `blocked` のまま残るので、**直上に blocked が積み上がる**。
  //    「ちょうど 1 件」にしていた頃は、2 回目の REJECT を経た正規 lineage が必ず弾かれた
  //    （2026-09-24 production 実測: `c3849205` は `7061400a` → `5472d0c1` → 実装 と
  //    blocked が 2 件連続し、canonical repair が admission だけで止まっていた）。
  //
  //    **ただし「経路上の blocked を全部」ではない。** それでは AI resume を 1 本挟むだけで、
  //    前の generation に残っている blocked 行まで一緒に外れる（`repairFromStoredReview.test.ts`
  //    の回帰。2026-09-23 に in-memory で再現済み）。前の generation の blocked は
  //    「人が動くまで自律実行を止める」という境界そのもので、そこを跨ぐのは安全境界の後退である。
  //
  //    外すのは **最初に現れた blocked から、連続している間だけ** である。
  //      - 先頭側の非 blocked（現 generation の成功した repair 段）は読み飛ばす。
  //        飛ばしても安全側は緩まない: それらが `queued` / `running` なら下の live 判定が拾う。
  //      - いったん blocked が始まったら、非 blocked に当たった時点で打ち切る。
  //        そこから上は別のエピソードで、この実装が抜け出してきた REJECT の並びではない。
  //
  //    この 1 本で 3 つの形が同時に成立する:
  //      - REJECT が 1 回 : 成功 repair 段を飛ばし、その上の blocked 元を外す（従来どおり）
  //      - REJECT が n 回 : 直上に blocked が n 件連続するので最後まで外れる（本件の修正）
  //      - AI resume 経由 : blocked の上が成功 Job なので打ち切られ、前 generation は外れない
  //
  //    順序は canonical な walk が**同じ一度の走査で**確定させた `lineageAncestorJobIds`
  //    （近い順）をそのまま使う。ここで lineage を second-guess する二本目の走査も、
  //    二つ目の parser も作らない。`lineage.ok === false`（cycle / malformed / 別 Task 参照 /
  //    非停止）は上で既に fail-closed 済みなので、復元できていない lineage は届かない。
  //
  //    **打ち切る条件が `blocked` 以外であることが要点。** ancestor は後から `queued` へ戻りうる
  //    （`jobResultApplicationPolicy.ts` の `blocked: ['queued']`、`routes/jobs.ts` の
  //    implement requeue 経路）。そうなったら連続はそこで切れ、その Job も、その上も外れない。
  //    **さらに、AI resume を跨いだ先の human root より上は見ない。** 連続を status だけで
  //    決めると、`B0(blocked) → H1(resume:B0, human, blocked) → A2(resume:H1, ai)` の形で
  //    A2 の ancestor が `[H1, B0]` となり両方 blocked なので、**AI resume 1 本で human root を
  //    跨いで前 generation の `B0` まで外せてしまう**（独立レビュー指摘）。
  //
  //    境界を張る条件は `crossedAiResume`、すなわち **現在の実装と人の権限の根との間に
  //    AI / unknown の resume が挟まっているか**である。値は walk が同じ一度の走査で
  //    確定させたもの（根が決まる前だけ立つ）で、ここで導出し直していない。
  //      - 挟まっていない: 人がこの chain を直接進めた。その上の REJECT 列は人が
  //        「この状況から続ける」と判断した対象そのものなので外してよい
  //        （production `c3849205`、および human root 下の repair chain）
  //      - 挟まっている  : AI が人の境界へ手を伸ばしている。根は含めるが、その上は 1 件も見ない
  //
  //    `origin` には守るべき人の境界が無い。`human_recovery` は「いまここから新しい
  //    generation を始めてよい」という**現時点の** authority で、その上に残る blocked 元は
  //    epoch が解消する対象そのものなので、ここで切ると承認を CONSUMED にしたまま
  //    行き止まりになる（`repairFromStoredReview.test.ts` が固定している既知の事故）。
  const ancestors = lineage.lineageAncestorJobIds
  const crossesHumanAuthority = lineage.rootKind === 'human_resume' && lineage.crossedAiResume
  const authorityBoundary = crossesHumanAuthority ? ancestors.indexOf(lineage.rootJobId) : -1
  const consideredAncestors = authorityBoundary >= 0 ? ancestors.slice(0, authorityBoundary + 1) : ancestors

  const jobsById = new Map(taskJobs.map((job) => [job.id, job]))
  const supersededBlockedAncestors = new Set<string>()
  let blockedRunStarted = false
  for (const ancestorId of consideredAncestors) {
    if (jobsById.get(ancestorId)?.status === 'blocked') {
      blockedRunStarted = true
      supersededBlockedAncestors.add(ancestorId)
      continue
    }
    if (blockedRunStarted) break
  }

  const live = taskJobs
    .filter((job) => job.id !== implementJob.id)
    .filter((job) => !supersededBlockedAncestors.has(job.id))
    .filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'blocked')
  if (live.length > 0) {
    return { ok: false, reason: `a live job exists for this task (${live[0].status})` }
  }

  return { ok: true, implementJob, review: stored }
}


export function prepareRepairFlow(storage: IStorage, input: RepairFlowInput): RepairPreparation {
  // blocked の例外を認めた場合、この 2 つは**保存済みレコードへ差し替える**（下記）。
  let { failedJob, review } = input

  const task = storage.tasks.findById(failedJob.taskId)
  if (!task) return { action: 'skip', reason: 'task not found' }

  // **`done` は従来どおり無条件 skip。** 完了した Task へ repair を作らない。
  if (task.status === 'done') return { action: 'skip', reason: 'task is done' }

  // **`blocked` は原則 skip のまま。例外は 1 つだけである。**
  //
  // 2026-09-21 production: blocked な Task を既存 resume route で再開し、implement が成功し、
  // その成果へ Independent Review が `changes_requested` を返した。ところがここが
  // `task.status === 'blocked'` で降りるため、**repair も escalate も作られず**、
  // 修正要求が誰にも渡らないまま停止した（`c3849205` / review `026fe5a3`）。
  // `resumeBlockedTask()` は Job を作るだけで Task status を変えない仕様なので、
  // resume 経由の成果は**必ず**この形になる。つまり repair route が自分で閉じていた。
  //
  // **「blocked なら repair してよい」には広げない。** 下の `repairableBlockedReviewRequest()`
  // が既存レコードだけで全条件を機械照合し、1 つでも欠ければ従来どおり skip する。
  if (task.status === 'blocked') {
    const admitted = repairableBlockedReviewRequest(storage, task, failedJob)
    if (!admitted.ok) return { action: 'skip', reason: `task is blocked (${admitted.reason})` }
    // **認めた根拠と repair の材料を同じ行に揃える。** ここで引数の object を使い続けると、
    // 「保存された無害な verdict で通し、引数の細工された verdict で prompt を組む」が
    // 成立する。照合した 2 件だけを以降の材料にする（独立レビュー指摘）。
    failedJob = admitted.implementJob
    review = admitted.review
  }

  const priorJobs = storage.jobs.findByTaskId(task.id)
  const priorReviews = storage.reviewResults.findByTaskId(task.id)
  const facts = extractFailureFacts(failedJob, review)

  const decision = decideRepairAction(
    failedJob.id,
    toPriorRepairJobs(
      priorJobs,
      priorReviews,
      readResumeActorClasses(storage, priorJobs),
      epochCoveredImplementationJobIds(storage, task.id),
      {
      jobId: failedJob.id,
      status: 'failed',
      facts,
    }),
    facts,
  )
  if (decision.action === 'escalate') {
    return {
      action: 'escalate',
      reason: decision.reason,
      code: decision.code,
      generation: decision.generation,
    }
  }

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
      // `decision.stepKey` と**同じ1つの値**から来ている（`decideRepairAction()`）。
      // ここで `failedJob.id` を書き直すと、将来 anchor の決め方が変わったときに
      // 永続値と stepKey が静かに食い違う。
      repairSourceJobId: decision.sourceJobId,
    },
    stepKey: decision.stepKey,
    generation: decision.generation,
    attempt: decision.attempt,
  }
}

/** Taskを既存のHuman escalation（blocked）へ入れる。呼び出し元から明示的に使う。 */
export function escalateTaskToHuman(storage: IStorage, taskId: string): void {
  // **park された Task を blocked へ上げない。**
  //
  // blocked は `roadmapActive` に関係なく project を占有する（`occupiesProject()`）ため、
  // park した Task をここで上げると park が事実上取り消され、しかも
  // `resumeBlockedTask()` は park を理由に拒否するので誰も解消できなくなる。
  // park された Task について「人へ渡す」相手はもう居ない —— CEO が既に判断した結果である。
  if (storage.tasks.isParked(taskId)) return

  const task = storage.tasks.findById(taskId)
  if (task && task.status !== 'blocked') {
    storage.tasks.update(taskId, { status: 'blocked' })
  }
}

/**
 * workspace が quarantine されているかを判定する。
 *
 * 最新Jobだけを確認せず、そのTaskの**任意の**未解除quarantine Jobから判定する
 * （quarantine は `running -> blocked` と同一transactionで一度だけ設定され、解除機構はない）。
 * quota的 workspace に対しては新しいJob・repairを生成してはならない（fail-closed）。
 */
export function isWorkspaceQuarantined(jobs: readonly Job[]): boolean {
  return jobs.some((job) => job.failureMetadata?.quarantined === true)
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

  // PR-C Tranche 3: quarantine された workspace への repair は fail-closed で拒否する。
  // 未検証 workspace を持つ Task へ repair Job を生成・実行してはならない。
  // このTaskの任意のquarantine Jobから判定する（最新Jobだけでなく）。
  if (isWorkspaceQuarantined(storage.jobs.findByTaskId(taskId))) {
    escalateTaskToHuman(storage, taskId)
    return {
      status: 'escalated',
      reason: 'workspace is quarantined; repair cannot run until the workspace is verified safe',
    }
  }

  // stepKey は `decideRepairAction()` が払い出した規約形（`repair:<sourceJobId>:1`）でしか
  // 受けない。**緩い分解（`split(':')[0]`）だと `repair:<id>:2` のような規約外の形を
  // 黙って受理し、`walkRepairGeneration()` が後で数えられない key の Job を作ってしまう。**
  const sourceJobId = parseRepairSource(stepKey)
  if (sourceJobId === undefined) {
    escalateTaskToHuman(storage, taskId)
    return { status: 'escalated', reason: `malformed repair step key: ${stepKey}` }
  }

  const sourceJob = storage.jobs.findById(sourceJobId)
  // source Jobが引けないとprojectId / safeCommand / providerを復元できない。
  // 部分的に埋めた不完全なJobを作るより、人へ渡すほうが安全side。
  if (!sourceJob) {
    escalateTaskToHuman(storage, taskId)
    return { status: 'escalated', reason: 'source job for the repair chain is missing' }
  }
  // **別 Task の Job を source にした repair を作らない。** 作ると lineage が Task を
  // またぎ、`walkRepairGeneration()` から見て「この Task に無い親」になる（数え切れない）。
  if (sourceJob.taskId !== taskId) {
    escalateTaskToHuman(storage, taskId)
    return { status: 'escalated', reason: 'source job for the repair chain belongs to another task' }
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

  // Design Review を待っている間に `abort_task` がこの Task を park しうる。
  // ここで repair Job を作ると park が黙って取り消される（escalate もしない —
  // park された Task を blocked へ上げるのは park の取り消しと同じ結果になる）。
  if (storage.tasks.isParked(taskId)) {
    return { status: 'skipped', reason: 'task was parked by abort_task while the review ran' }
  }

  // review済みpromptをそのままaiCliPromptにする（追記・変更しない）。
  // 所有権ハンドオフ: repair Job の実体化と source Job（blocked、所有権保持中）の解放を
  // **単一transaction** で行う。source Job は意図的に `blocked` のまま残して all-owned
  // workspace を守っていたが、後続 repair Job が実体化した時点で他の所有者がいない
  // 順序を作らないよう、後続を先に作ってから source を解放する。
  const repairJob = storage.jobs.createRepairJobWithHandoff({
    sourceJobId,
    repairJob: {
      taskId,
      projectId: sourceJob.projectId,
      agentRole: sourceJob.agentRole,
      status: 'queued',
      workflowStepKey: stepKey,
      safeCommand: sourceJob.safeCommand,
      aiCliMode: 'implement',
      aiCliProvider: sourceJob.aiCliProvider,
      aiCliPrompt: run.designText,
    },
  })

  if (!repairJob.ok) {
    // ここへ stepKey の重複で来ることは無い。直前の dedup 判定から
    // `createRepairJobWithHandoff()` までの間に await が無く、API は単一 process で
    // 動くため、両者の間に別経路が割り込めない（割り込める `runRepairFlow` 側では
    // `isWorkflowStepKeyConflict()` で `already_started` へ倒している）。
    // 後続の実体化に失敗した。transaction は rollback され、source Job は `blocked` の
    // まま所有権を保持する。ここで workspace を放置せず、Human escalation（Task blocked）
    // へ渡して後の介入を可能にする。
    escalateTaskToHuman(storage, taskId)
    return { status: 'escalated', reason: repairJob.reason }
  }

  recordGenerationForCreatedRepairJob(storage, repairJob.repairJob)

  return {
    status: 'repair_job_created',
    jobId: repairJob.repairJob.id,
    stepKey,
    attempt: run.attemptCount,
  }
}
