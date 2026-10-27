/**
 * pending の Task continuation が**実際に進んでいるか**を、既存の記録だけから判定する。
 *
 * **continuation pending の 503 は前進の証拠ではない。** それは Job の結果と event が永続化された
 * ことの証明であって、次 Task の初回 workflow（Design Review → 初回 implement Job）が進んでいることの
 * 証明ではない（CEO 指示 2026-10-27）。ここでは次の事実だけを前進とみなす:
 *
 * - **live な Design Review**: 次 Task の**canonical な初回 review**（`createInitialImplementWorkflow()` が
 *   使うのと同じ design text・`changedFiles: []`・repair / resume 由来でない run）が `running` で claim 済み、
 *   かつ現在の claim が runner 期限（1 attempt 分 + kill 猶予）の内側にある
 * - **settlement の猶予内**: 初回 Job が既にある（あれば Job、無ければ Gate が返す ALIGNED evidence の作成時刻）
 *   から `CONTINUATION_SETTLEMENT_GRACE_MS` 以内。それを過ぎても pending なら settlement 自体が止まっている
 *
 * retry cooldown は前進ではない（実行が無い状態である）。canonical でない run（repair / resume の review）も
 * 次 Task の初回 Job を作れないので前進ではない。読めない時刻は前進とみなさない（fail-closed）。
 *
 * **戻すのは「検証された前進が無い時間」（`stuckForMs`）と、決定的な事実の列だけ。** 通知の要否は
 * 既存の PL（`DEFAULT_STALL_HINT_MS` の停滞閾値・notify-only・重複抑止）が決める。復旧操作はしない。
 */

import type { ContinuationProgressReport, Project, TaskContinuation } from '@ai-team/shared'
import { buildInitialImplementAiCliPrompt, initialWorkflowStepKey } from '../ctoAi/initialImplementWorkflow'
import { DESIGN_REVIEW_RUNNER_SIGKILL_GRACE_MS, DESIGN_REVIEW_RUNNER_TIMEOUT_MS } from '../designReview/designReviewCoordinator'
import { designReviewRetryNotBeforeMs } from '../designReview/retryCooldown'
import { checkImplementJobDesignReviewEvidence, computeDesignTextHash } from '../designReviewEvidencePolicy'
import type { DesignReviewRun, IStorage } from '../storage/interface'

/** 初回 Job / ALIGNED evidence ができてから continuation が settle するまでに許す時間。 */
export const CONTINUATION_SETTLEMENT_GRACE_MS = 60_000

/** 現在の claim を live とみなす上限（runner の 1 attempt 期限 + kill 猶予）。 */
export const CONTINUATION_LIVE_RUN_BOUND_MS = DESIGN_REVIEW_RUNNER_TIMEOUT_MS + DESIGN_REVIEW_RUNNER_SIGKILL_GRACE_MS

export interface ContinuationProgress {
  /** continuation の次 Task（無い・読めない場合は undefined）。 */
  taskId: string | undefined
  /** 検証された前進が無い時間（ms）。前進中・Project が running でない場合は 0。 */
  stuckForMs: number
  /** 通知・観測に載せる決定的な事実（秘密・本文は載せない）。 */
  detail: string
}

/** 書き込みと読み取りの順序差として許す未来方向のずれ。これを超える未来の時刻は不正とみなす。 */
export const CONTINUATION_CLOCK_SKEW_TOLERANCE_MS = 60_000

/**
 * 記録の時刻を読む。**`nowMs` より `CONTINUATION_CLOCK_SKEW_TOLERANCE_MS` を超えて未来の時刻は不正**として
 * undefined を返す（fail-closed）。時計の巻き戻し後に未来の `createdAt` / `startedAt` を信じると、停滞が
 * 「0 秒」「live」に見え続け、その時刻が来るまで無音になる（独立レビュー指摘）。許容幅の内側は now として扱う。
 */
function parseMs(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms > nowMs + CONTINUATION_CLOCK_SKEW_TOLERANCE_MS) return undefined
  return Math.min(ms, nowMs)
}

/**
 * canonical な初回 review か。storage の active run 再利用条件（design hash・changedFiles・repair 由来でない）に
 * resume 由来でないことを加えた、`createInitialImplementWorkflow()` が待つ run の同一性。
 */
function isCanonicalInitialRun(run: DesignReviewRun, canonicalHash: string): boolean {
  return run.designTextHash === canonicalHash
    && run.changedFiles.length === 0
    && run.repairSourceJobId === undefined
    && run.resumeSourceJobId === undefined
}

export function evaluateContinuationProgress(
  storage: IStorage,
  continuation: TaskContinuation,
  project: Project,
  nowMs: number,
): ContinuationProgress {
  const facts: string[] = [`continuation ${continuation.id} pending since ${continuation.createdAt}`]
  // 起点は continuation の作成時刻。Project の `updatedAt` は使わない: 名前の変更や同じ status の再 PATCH でも
  // 書き換わるので、前進ではない書き込みが停滞の時計を戻し続けうる（独立レビュー指摘）。running への遷移時刻の
  // 記録は無いので、pause 中は下で 0 を返すだけにし、再開直後に前進が無ければ早めに鳴る側へ倒す（fail-safe）。
  // 読めなければ 0（= 十分古い）として扱う（fail-closed）。
  const episodeStartMs = parseMs(continuation.createdAt, nowMs) ?? 0
  const stuckSince = (sinceMs: number): number => Math.max(0, nowMs - Math.max(episodeStartMs, sinceMs))

  if (project.status !== 'running') {
    return {
      taskId: continuation.nextTaskId,
      stuckForMs: 0,
      detail: `${facts[0]}; project is ${project.status}, so the continuation waits for the Project to run`,
    }
  }

  const task = continuation.nextTaskId !== undefined ? storage.tasks.findById(continuation.nextTaskId) : undefined
  if (task === undefined) {
    facts.push(continuation.nextTaskId === undefined ? 'no next task recorded' : `next task ${continuation.nextTaskId} not found`)
    return { taskId: continuation.nextTaskId, stuckForMs: stuckSince(episodeStartMs), detail: facts.join('; ') }
  }
  facts.push(`next task ${task.id} (${task.status})`)

  const siblings = new Map(storage.tasks.findByProjectId(task.projectId).map((sibling) => [sibling.id, sibling]))
  const dependenciesDone = task.dependencies.every((dependencyId) => siblings.get(dependencyId)?.status === 'done')
  facts.push(`dependencies ${dependenciesDone ? 'done' : 'NOT done'}`)

  // ── settlement: 初回 Job（あれば優先）または Gate が返す ALIGNED evidence ─────────────
  const initialJob = storage.jobs.findByTaskId(task.id).find((job) => job.workflowStepKey === initialWorkflowStepKey(task.id))
  const aiCliPrompt = buildInitialImplementAiCliPrompt(task)
  const gate = initialJob === undefined
    ? checkImplementJobDesignReviewEvidence({ taskId: task.id, aiCliMode: 'implement', aiCliPrompt }, storage.designReviewEvidence)
    : undefined
  const settledAtMs = initialJob !== undefined
    ? parseMs(initialJob.createdAt, nowMs)
    : gate?.ok === true && gate.evidence !== undefined ? parseMs(gate.evidence.createdAt, nowMs) : undefined
  if (initialJob !== undefined || (gate?.ok === true && gate.evidence !== undefined)) {
    facts.push(initialJob !== undefined
      ? `initial job ${initialJob.id} exists (created ${initialJob.createdAt}) but the continuation has not settled`
      : 'aligned design review evidence exists but no initial job yet')
    // 時刻が読めなければ猶予を与えない（fail-closed）。
    if (settledAtMs !== undefined && nowMs < settledAtMs + CONTINUATION_SETTLEMENT_GRACE_MS) {
      return { taskId: task.id, stuckForMs: 0, detail: facts.join('; ') }
    }
    return {
      taskId: task.id,
      stuckForMs: stuckSince(settledAtMs !== undefined ? settledAtMs + CONTINUATION_SETTLEMENT_GRACE_MS : episodeStartMs),
      detail: facts.join('; '),
    }
  }

  // ── live な canonical review ──────────────────────────────────────────────
  const canonicalHash = computeDesignTextHash(aiCliPrompt)
  const runs = storage.designReviewRuns.findByTaskId(task.id)
  const canonical = runs.find((run) => isCanonicalInitialRun(run, canonicalHash))
  const nonCanonicalActive = runs.find((run) => (
    (run.status === 'queued' || run.status === 'running') && !isCanonicalInitialRun(run, canonicalHash)))
  if (nonCanonicalActive !== undefined) {
    facts.push(`non-canonical design review run ${nonCanonicalActive.id} (${nonCanonicalActive.status}) is active for the task`)
  }
  if (canonical === undefined) {
    facts.push('no canonical initial design review run')
    return { taskId: task.id, stuckForMs: stuckSince(episodeStartMs), detail: facts.join('; ') }
  }

  const startedMs = parseMs(canonical.startedAt, nowMs)
  const cooldownMs = designReviewRetryNotBeforeMs(canonical)
  facts.push(
    `canonical run ${canonical.id} ${canonical.status} attempt ${canonical.attemptCount}`
    + (canonical.startedAt !== undefined ? ` claimed ${canonical.startedAt}` : '')
    + (cooldownMs !== undefined && nowMs < cooldownMs ? ` in retry cooldown until ${new Date(cooldownMs).toISOString()}` : ''),
  )
  if (canonical.status === 'running' && startedMs !== undefined && nowMs - startedMs <= CONTINUATION_LIVE_RUN_BOUND_MS) {
    return { taskId: task.id, stuckForMs: 0, detail: facts.join('; ') }
  }
  // 最後に動いた時刻（claim・終了・作成の最も遅いもの）から停滞を数える。
  const lastActivityMs = Math.max(
    startedMs ?? 0,
    parseMs(canonical.completedAt, nowMs) ?? 0,
    parseMs(canonical.createdAt, nowMs) ?? 0,
  )
  return { taskId: task.id, stuckForMs: stuckSince(lastActivityMs), detail: facts.join('; ') }
}

/**
 * running Project の pending continuation について「前進が無い時間」を返す（読み取りのみ）。
 *
 * **Worker の独立した backstop の材料。** Worker は poll cycle ごとに reconcile route を呼んでいるので、
 * その応答に載せれば、PL loop（無効・latch）や escalation の配達に依存せずに Worker が停滞を知れる。
 * 時刻は永続化済みの記録から計算するので、Worker の再起動で失われない。pause 中に作られて Outbox から
 * 消えた continuation も、再開後はここに現れる（Outbox の滞留だけでは見えない形）。
 */
export function reportContinuationProgress(storage: IStorage, nowMs: number): ContinuationProgressReport[] {
  const reports: ContinuationProgressReport[] = []
  for (const project of storage.projects.findAll()) {
    if (project.status !== 'running') continue
    for (const continuation of storage.taskContinuations.findPendingByProjectId(project.id)) {
      // 1件の評価失敗で報告全体を消さない（1件の壊れた行が全 continuation の backstop を黙らせる）。
      // 評価できない行は、作成からの経過時間をそのまま「前進なし」として報告する（fail-closed）。
      let stuckForMs: number
      let taskId = continuation.nextTaskId
      try {
        const progress = evaluateContinuationProgress(storage, continuation, project, nowMs)
        stuckForMs = progress.stuckForMs
        taskId = progress.taskId
      } catch {
        stuckForMs = Math.max(0, nowMs - (parseMs(continuation.createdAt, nowMs) ?? 0))
      }
      reports.push({
        continuationId: continuation.id,
        projectId: project.id,
        ...(taskId !== undefined ? { taskId } : {}),
        stuckForMs,
      })
    }
  }
  return reports
}
