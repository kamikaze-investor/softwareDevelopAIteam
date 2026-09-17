/**
 * abort_task — 未完了 Task を「完了したことにせず」安全に park する。
 *
 * **これは復旧でも完了でもない。** 「この Task はいま進められないので、PL 全体を止めないよう
 * 現役から外す」だけの操作である。Roadmap 項目の残作業は消えず、後で follow-up 採用（#233）が
 * 別 Task identity として再開する。**ここで follow-up を作らない。**
 *
 * ## 段階操作である理由
 *
 * park の実体は `roadmapActive=false` だが、それだけでは成立しない。**`roadmapActive` は
 * Worker の claim 条件にも workspace 所有権の判定にも入っていない**ため、所有権を保持する
 * blocked Job を残したまま park すると:
 *   - `findWorkspaceOwningTaskId()` がその Job を所有者と見なし続け、Worker は以降の
 *     全 Task をスキップして何も claim しない（**静かな停止**）
 *   - 次の Roadmap 採用時、`syncRoadmapTasks()` の非活性化ガードが blocked Job を
 *     「まだ動いている作業」と見なして `SYNC_FAILED` になる
 *
 * よって「先に Task を quiescent にしてから park する」段階操作にする（CEO 判断・2026-09-17）。
 *
 * ```text
 * 1. 前提条件 + CEO Approval を検証
 * 2. 所有権を保持する blocked Job があれば cleanup を要求（サーバ側が対象を決める）
 * 3. Worker が既存の観測経路で workspace を観測して報告
 * 4. API が観測を再検証し、一致したときだけ blocked -> failed で所有権解放
 * 5. 同一 transaction で Task を park し、audit を残す
 * ```
 *
 * 検証に失敗したら **park しない**。Job は blocked のまま所有権を保持する（fail-closed）。
 *
 * ## 作っていないもの
 *
 * 新しい action 語彙（`abort_task` は既存）/ 新しい Gate（必要 Gate は `ACTION_GATE_TABLE` が
 * `approval_gate` と決めている）/ 新しい TaskStatus / `aborted` フラグ / 新しい Job status /
 * cancellation queue / cleanup 実装。cleanup は既存の観測・検証経路を**起動するだけ**である。
 *
 * ## workspace の revert について
 *
 * `revertBlockedJobChanges()` は `ChangeManifest` と `preExistingPaths` を要求するが、
 * **どちらも Job 行に永続化されていない**（実測 2026-09-17）。実行中プロセスの
 * `JobRunResult` にしか存在しないため、過去に blocked になった Job に対しては呼べない。
 * したがってこの経路は revert を行わず、**workspace が既に baseline と一致していることの
 * 確認だけ**を行う。一致しなければ park を拒否する。
 * dirty なまま残った blocked Job の revert は別責務（Finding）として分離する。
 */

import { holdsWorkspaceWhenBlocked, isLiveJob } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import type { Job, JobWorkspaceBaseline } from '@ai-team/shared'
import { authorizePlAction, PlActionBlockedError } from './actionGate'

export interface AbortTaskInput {
  taskId: string
  /** 対象 Task に紐づく APPROVED な ApprovalRequest。CEO の承認操作の実体。 */
  approvalRequestId: string
  /** なぜ park するのか。audit に残す。 */
  reason: string
}

export type AbortTaskResult =
  | { ok: true; status: 'parked'; taskId: string }
  /** 所有権を保持する Job があるので、先に cleanup が要る。park はまだ成立していない。 */
  | { ok: true; status: 'cleanup_requested'; taskId: string; jobIds: string[] }
  | {
    ok: false
    code:
      | 'TASK_NOT_FOUND'
      | 'TASK_ALREADY_DONE'
      | 'TASK_NOT_PARKABLE'
      | 'TASK_NOT_ACTIVE'
      | 'LIVE_JOB_PRESENT'
      | 'FOREIGN_BLOCKED_JOB'
      | 'JOB_QUARANTINED'
      | 'NOT_AUTHORIZED'
      | 'PARK_FAILED'
    reason: string
    details?: unknown
  }

/**
 * 所有権を保持している（= park の妨げになる）Job か。
 *
 * **`blocked` であることと所有していることは同じではない。** done な Task に残る blocked 行は
 * 履歴であって所有者ではない、というのが既存 `findWorkspaceOwningTaskId()` の判定である。
 * ここで独自に「blocked なら所有者」と決めていたため、2026-09-17 の Operational E2E では
 * done な Task の古い blocked 行 4本が production の abort を丸ごと塞いだ。
 */
function holdsWorkspaceOwnership(task: { status: string }, job: Job): boolean {
  return holdsWorkspaceWhenBlocked(task, job)
}

export function abortTask(storage: IStorage, input: AbortTaskInput): AbortTaskResult {
  const task = storage.tasks.findById(input.taskId)
  if (!task) {
    return { ok: false, code: 'TASK_NOT_FOUND', reason: `Task ${input.taskId} does not exist` }
  }
  if (task.status === 'done') {
    return { ok: false, code: 'TASK_ALREADY_DONE', reason: `Task ${input.taskId} is already done` }
  }

  // `occupiesProject()` は in_progress / blocked を roadmapActive に関係なく占有と数える
  // （#233 で独立レビューを経て固定した契約）。それらを park しても currentTask から外れない。
  if (task.status !== 'pending') {
    return {
      ok: false,
      code: 'TASK_NOT_PARKABLE',
      reason:
        `Task ${input.taskId} is ${task.status}; parking only takes effect for a pending task. `
        + 'Use the existing resume / fail-stuck-job path for work that is underway or blocked',
    }
  }
  if (task.roadmapActive !== true) {
    return {
      ok: false,
      code: 'TASK_NOT_ACTIVE',
      reason: `Task ${input.taskId} is not roadmap-active; there is nothing to park`,
    }
  }

  // live Job があるうちは何もしない。Worker は roadmapActive を見ずに queued Job を拾う。
  const projectTasks = storage.tasks.findByProjectId(task.projectId)
  const liveJobs = projectTasks.flatMap((candidate) =>
    storage.jobs.findByTaskId(candidate.id).filter((job) => isLiveJob(job)))
  if (liveJobs.length > 0) {
    return {
      ok: false,
      code: 'LIVE_JOB_PRESENT',
      reason:
        `the project still has ${liveJobs.length} queued or running job(s) `
        + `(${liveJobs.map((job) => `${job.id}:${job.status}`).join(', ')}); `
        + 'let the existing job stop / fail handling finish first',
    }
  }

  // ── Mandatory Gate。許可を得る経路はここだけで、判定は提案から作り直される ──
  try {
    authorizePlAction(storage, {
      proposal: { kind: 'abort_task' },
      target: { kind: 'task', taskId: task.id },
      evidence: [{ gate: 'approval_gate', approvalRequestId: input.approvalRequestId }],
    })
  } catch (error: unknown) {
    if (error instanceof PlActionBlockedError) {
      return {
        ok: false,
        code: 'NOT_AUTHORIZED',
        reason: error.message,
        details: { missingGates: error.missingGates, rejectedEvidence: error.rejectedEvidence },
      }
    }
    throw error
  }

  // ── 所有権を保持する Job を**サーバ側が**特定する。caller は Job を指定できない ──
  //
  // 対象は**この Task の Job だけ**である。他 Task の blocked Job にこの Task の承認で
  // 印を付けると、その承認で別 Task が park できてしまう（独立レビュー Finding 2）。
  const owning = storage.jobs.findByTaskId(task.id).filter((job) => holdsWorkspaceOwnership(task, job))

  // 他 Task が workspace を所有したままなら park しても workspace は解放されない。
  // 既存 `parkTask()` の前提（project に blocked Job が無いこと）と揃えて fail-closed にする。
  const foreign = projectTasks
    .filter((candidate) => candidate.id !== task.id)
    .flatMap((candidate) =>
      storage.jobs.findByTaskId(candidate.id).filter((job) => holdsWorkspaceOwnership(candidate, job)))
  if (foreign.length > 0) {
    return {
      ok: false,
      code: 'FOREIGN_BLOCKED_JOB',
      reason:
        `task ${foreign[0].taskId} still holds the workspace through blocked job ${foreign[0].id}; `
        + 'resolve that task through the existing resume / fail path first '
        + '(parking this task would not release the workspace)',
    }
  }

  const quarantined = owning.find((job) => job.failureMetadata?.quarantined === true)
  if (quarantined) {
    return {
      ok: false,
      code: 'JOB_QUARANTINED',
      reason:
        `job ${quarantined.id} is quarantined; clear it through the existing clear-quarantine path `
        + 'before parking (ownership is not released while the workspace is unproven)',
    }
  }

  if (owning.length === 0) {
    const parked = storage.jobs.parkTask({
      taskId: task.id,
      reason: input.reason,
      approvalRequestId: input.approvalRequestId,
    })
    if (!parked.ok) return { ok: false, code: 'PARK_FAILED', reason: parked.reason }
    return { ok: true, status: 'parked', taskId: task.id }
  }

  // cleanup を要求する。**実体の掃除・観測は Worker の既存経路が行う。**
  const requestedAt = new Date().toISOString()
  for (const job of owning) {
    storage.jobs.update(job.id, {
      failureMetadata: {
        ...(job.failureMetadata ?? {}),
        abortCleanupRequestedAt: requestedAt,
        abortApprovalRequestId: input.approvalRequestId,
        abortReason: input.reason.slice(0, 300),
      },
    })
  }

  return { ok: true, status: 'cleanup_requested', taskId: task.id, jobIds: owning.map((job) => job.id) }
}

export type CompleteAbortCleanupResult =
  | { ok: true; taskId: string; jobId: string }
  | { ok: false; code: 'NOT_REQUESTED' | 'NOT_FOUND' | 'VERIFICATION_FAILED' | 'PRECONDITION_FAILED'; reason: string }

/**
 * Worker が観測を報告したときの最終段。
 *
 * **観測はここで再検証する。** Worker が「安全でした」と言うだけでは所有権を解放しない
 * （`clearWorkspaceQuarantine()` と同じ形）。検証・解放・park・audit は
 * `releaseBlockedJobAndParkTask()` が単一 transaction で行う。
 */
export function completeAbortCleanup(
  storage: IStorage,
  input: {
    jobId: string
    observation: JobWorkspaceBaseline
    knownGood: {
      gitOperationMarkers: string[]
      worktreeClean: boolean
      indexClean: boolean
      headValid: boolean
      blindSpotsAbsent: boolean
    }
  },
): CompleteAbortCleanupResult {
  const job = storage.jobs.findById(input.jobId)
  if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job ${input.jobId} does not exist` }

  // **要求されていない Job の所有権は解放できない。** 任意 Job を指定して解放させないための関所。
  const metadata = job.failureMetadata
  if (!metadata?.abortCleanupRequestedAt || !metadata.abortApprovalRequestId) {
    return {
      ok: false,
      code: 'NOT_REQUESTED',
      reason: `job ${input.jobId} has no abort cleanup request; ownership is not releasable this way`,
    }
  }

  // taskId は Job から導くが、**承認がその Task に束縛されているか**は
  // `releaseBlockedJobAndParkTask()` が transaction 内で検証する。ここでは決めない。
  const released = storage.jobs.releaseBlockedJobAndParkTask({
    jobId: job.id,
    taskId: job.taskId,
    observation: input.observation,
    knownGood: input.knownGood,
    reason: metadata.abortReason ?? 'abort_task',
    approvalRequestId: metadata.abortApprovalRequestId,
  })
  if (!released.ok) {
    return {
      ok: false,
      code: released.code === 'VERIFICATION_FAILED' ? 'VERIFICATION_FAILED' : 'PRECONDITION_FAILED',
      reason: released.reason,
    }
  }

  return { ok: true, taskId: job.taskId, jobId: job.id }
}
