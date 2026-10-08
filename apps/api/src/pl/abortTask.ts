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
 * 4. API が観測を再検証し、一致したときだけ、pending Task の blocked Job は failed へ解放する
 *    （全 Job terminal の blocked Task では Job status を変えない）
 * 5. 同一 transaction で Task を pending / roadmapActive=false へ park し、audit を残す
 * ```
 *
 * 検証に失敗したら **park しない**。blocked Job の所有権または blocked Task の状態を
 * そのまま保持する（fail-closed）。
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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  getBaseRoadmapId,
  holdsWorkspaceWhenBlocked,
  isLiveJob,
  isStaleBlockedJobCandidate,
  occupiesProject,
} from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import type { Job, JobWorkspaceBaseline, Task } from '@ai-team/shared'
import { authorizePlAction, PlActionBlockedError } from './actionGate'
import { buildSystemState, type AttentionItem } from '../state/systemState'
import { protectedViolations, triageBlocked } from './blockedTriage'
import { readAdoptionCandidates } from './adoptionStep'
import {
  isEligibleTechnicalAbortDiagnosis,
  recordTechnicalAbortEvidence,
  recordTechnicalAbortRefusal,
  technicalAbortStateFingerprint,
  type AbortAuthorization,
  type TechnicalAbortCleanupSummary,
} from './technicalAbortEvidence'

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
      | 'OWNERSHIP_UNPROVEN'
      | 'TECHNICAL_EVIDENCE_INELIGIBLE'
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
  // （#233 で独立レビューを経て固定した契約）。blocked を受け入れるのは、全 Job terminal を
  // 観測した後に pending / roadmapActive=false へ原子的に移す専用経路だけである。
  const isTerminalBlockedTask = task.status === 'blocked'
  if (task.status !== 'pending' && !isTerminalBlockedTask) {
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
  const taskJobs = storage.jobs.findByTaskId(task.id)
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

  if (isTerminalBlockedTask) {
    if (taskJobs.length === 0) {
      return {
        ok: false,
        code: 'TASK_NOT_PARKABLE',
        reason:
          `Task ${task.id} is blocked but has no Job; use the existing /recover route before abort_task`,
      }
    }
    const nonTerminal = taskJobs.find((job) => job.status !== 'failed' && job.status !== 'success')
    if (nonTerminal) {
      return {
        ok: false,
        code: 'TASK_NOT_PARKABLE',
        reason:
          `Task ${task.id} still has non-terminal job ${nonTerminal.id} (${nonTerminal.status}); `
          + 'finish the existing blocked-job lifecycle before parking',
      }
    }
    const quarantinedJob = taskJobs.find((job) => job.failureMetadata?.quarantined === true)
    if (quarantinedJob) {
      return {
        ok: false,
        code: 'JOB_QUARANTINED',
        reason:
          `job ${quarantinedJob.id} is quarantined; clear it through the existing clear-quarantine path `
          + 'before parking (ownership is not released while the workspace is unproven)',
      }
    }
    const workingDirs = new Set(taskJobs.map((job) => job.safeCommand?.workingDir))
    const workingDir = taskJobs[0]?.safeCommand?.workingDir
    if (workingDir === undefined || workingDir === '' || workingDirs.size !== 1) {
      return {
        ok: false,
        code: 'TASK_NOT_PARKABLE',
        reason:
          `Task ${task.id}'s terminal Jobs do not share one non-empty workingDir; `
          + 'one workspace observation cannot prove them all safe',
      }
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
  const owning = taskJobs.filter((job) => holdsWorkspaceOwnership(task, job))
  // findByTaskId は created_at DESC, rowid DESC。terminal-blocked 形では最新 Job だけを
  // 観測要求の carrier にし、全 Job の証明は storage transaction が行う。
  const cleanupTargets = isTerminalBlockedTask ? [taskJobs[0]] : owning

  // 他 Task が workspace を所有したままなら park しても workspace は解放されない。
  const otherTasks = projectTasks.filter((candidate) => candidate.id !== task.id)
  const foreign = otherTasks.flatMap((candidate) =>
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

  // ── 終わった Task に取り残された blocked 行 ──
  //
  // これは「所有していない」ではなく「**workspace を観測しないと決められない**」である。
  // Worker は同じ行について worktree を観測し、次の Task を始められる状態
  // （差分なし / 進行中の git 操作なし / HEAD 解決可）になって初めて所有権を手放したと見なす。
  //
  // 対象 Task 自身に解放すべき blocked Job があるなら、この後の段階操作で Worker が観測を報告し、
  // API が `knownGood`（worktree・index が clean、git 操作なし、HEAD 有効、死角なし）を
  // 検証してからでなければ park は成立しない。その検証は上記の解放条件より強いので、
  // 通過した時点で取り残された行が所有者でないことも同時に証明されている。
  //
  // 観測の当てが無い（＝解放すべき Job が無い）場合は証明が取れないため、所有者として扱う。
  const staleCandidates = otherTasks.flatMap((candidate) =>
    storage.jobs.findByTaskId(candidate.id).filter((job) => isStaleBlockedJobCandidate(candidate, job)))

  const quarantined = cleanupTargets.find((job) => job.failureMetadata?.quarantined === true)
  if (quarantined) {
    return {
      ok: false,
      code: 'JOB_QUARANTINED',
      reason:
        `job ${quarantined.id} is quarantined; clear it through the existing clear-quarantine path `
        + 'before parking (ownership is not released while the workspace is unproven)',
    }
  }

  if (cleanupTargets.length === 0) {
    if (staleCandidates.length > 0) {
      return {
        ok: false,
        code: 'FOREIGN_BLOCKED_JOB',
        reason:
          `task ${staleCandidates[0].taskId} has a blocked job (${staleCandidates[0].id}) left over `
          + 'from a finished task, and this task has no job whose cleanup would prove the workspace '
          + 'is clean; refusing to park without that proof',
      }
    }

    const parked = storage.jobs.parkTask({
      taskId: task.id,
      reason: input.reason,
      authorization: { kind: 'manual_approval', approvalRequestId: input.approvalRequestId },
    })
    if (!parked.ok) return { ok: false, code: 'PARK_FAILED', reason: parked.reason }
    return { ok: true, status: 'parked', taskId: task.id }
  }

  // 証明が及ぶのは、これから観測する workspace だけである。別の workingDir に取り残された行は
  // その証明の外側にあるので、所有者として扱う（独立レビュー round 2）。
  // workingDir が読めない行は「同じ workspace だ」と言えないので証明の外側に置く
  // （`SafeCommand.workingDir` は型上必須だが、古い行から undefined で読めることがある）。
  const provenDirs = new Set(
    cleanupTargets.map((job) => job.safeCommand?.workingDir).filter((dir): dir is string => Boolean(dir)),
  )
  const outsideProof = staleCandidates.find((job) => {
    const dir = job.safeCommand?.workingDir
    return dir === undefined || dir === '' || !provenDirs.has(dir)
  })
  if (outsideProof) {
    return {
      ok: false,
      code: 'FOREIGN_BLOCKED_JOB',
      reason:
        `task ${outsideProof.taskId} has a blocked job (${outsideProof.id}) left over from a `
        + `finished task in ${outsideProof.safeCommand?.workingDir}, which this cleanup would not `
        + 'observe; refusing to park without proof for that workspace',
    }
  }

  // cleanup を要求する。**実体の掃除・観測は Worker の既存経路が行う。**
  const requestedAt = new Date().toISOString()
  for (const job of cleanupTargets) {
    storage.jobs.update(job.id, {
      failureMetadata: {
        ...(job.failureMetadata ?? {}),
        abortCleanupRequestedAt: requestedAt,
        abortApprovalRequestId: input.approvalRequestId,
        abortReason: input.reason.slice(0, 300),
      },
    })
  }

  return {
    ok: true,
    status: 'cleanup_requested',
    taskId: task.id,
    jobIds: cleanupTargets.map((job) => job.id),
  }
}

export type CompleteAbortCleanupResult =
  | { ok: true; taskId: string; jobId: string }
  | { ok: false; code: 'NOT_REQUESTED' | 'NOT_FOUND' | 'VERIFICATION_FAILED' | 'PRECONDITION_FAILED'; reason: string }

/**
 * Worker が観測を報告したときの最終段。
 *
 * **観測はここで再検証する。** Worker が「安全でした」と言うだけでは所有権を解放しない
 * （`clearWorkspaceQuarantine()` と同じ形）。検証・必要な所有権解放・park・audit は、Task の
 * status に応じた storage transaction が単一 transaction で行う。
 */
export function completeAbortCleanup(
  storage: IStorage,
  input: {
    jobId: string
    observation?: JobWorkspaceBaseline
    knownGood: {
      gitOperationMarkers: string[]
      worktreeClean: boolean
      indexClean: boolean
      headValid: boolean
      blindSpotsAbsent: boolean
    }
    /** technical cleanup が deletion 前に観測した exact dirty/clean baseline。 */
    preCleanupObservation?: JobWorkspaceBaseline
    cleanupSummary?: TechnicalAbortCleanupSummary
    /** Worker が cleanup 前に拒否した場合。API は refusal audit だけを残し、状態を変えない。 */
    refusalCode?: string
  },
): CompleteAbortCleanupResult {
  const job = storage.jobs.findById(input.jobId)
  if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job ${input.jobId} does not exist` }

  // **要求されていない Job の所有権は解放できない。** 任意 Job を指定して解放させないための関所。
  const metadata = job.failureMetadata
  if (!metadata?.abortCleanupRequestedAt) {
    return {
      ok: false,
      code: 'NOT_REQUESTED',
      reason: `job ${input.jobId} has no abort cleanup request; ownership is not releasable this way`,
    }
  }

  const authorization: AbortAuthorization | undefined = metadata.abortApprovalRequestId !== undefined
    ? { kind: 'manual_approval', approvalRequestId: metadata.abortApprovalRequestId }
    : metadata.abortTechnicalEvidenceId !== undefined
      && metadata.abortTechnicalStateFingerprint !== undefined
      && metadata.abortTechnicalRootCauseClass === 'protected_path'
      && metadata.abortTechnicalAttentionKind !== undefined
      ? {
          kind: 'technical_evidence',
          evidenceId: metadata.abortTechnicalEvidenceId,
          stateFingerprint: metadata.abortTechnicalStateFingerprint,
          rootCauseClass: metadata.abortTechnicalRootCauseClass,
          attentionKind: metadata.abortTechnicalAttentionKind as AttentionItem['kind'],
        }
      : undefined
  if (authorization === undefined) {
    return {
      ok: false,
      code: 'NOT_REQUESTED',
      reason: `job ${input.jobId}'s abort cleanup request has no verifiable authorization`,
    }
  }
  if (input.refusalCode !== undefined) {
    if (authorization.kind === 'technical_evidence') {
      recordTechnicalAbortRefusal(storage, {
        taskId: job.taskId,
        evidenceId: authorization.evidenceId,
        code: input.refusalCode,
        stage: 'worker_cleanup',
      })
      retireTechnicalAbortCleanup(storage, job, input.refusalCode)
    }
    return { ok: false, code: 'VERIFICATION_FAILED', reason: 'Worker refused abort cleanup' }
  }
  if (input.observation === undefined) {
    if (authorization.kind === 'technical_evidence') {
      recordTechnicalAbortRefusal(storage, {
        taskId: job.taskId,
        evidenceId: authorization.evidenceId,
        code: 'FINAL_OBSERVATION_MISSING',
        stage: 'worker_cleanup',
      })
      retireTechnicalAbortCleanup(storage, job, 'FINAL_OBSERVATION_MISSING')
    }
    return { ok: false, code: 'VERIFICATION_FAILED', reason: 'final workspace observation is missing' }
  }

  // taskId は Job から導くが、**承認がその Task に束縛されているか**は
  // storage の status 別 release transaction が検証する。ここでは承認の正当性を決めない。
  const task = storage.tasks.findById(job.taskId)
  const releaseInput = {
    jobId: job.id,
    taskId: job.taskId,
    observation: input.observation,
    knownGood: input.knownGood,
    reason: metadata.abortReason ?? 'abort_task',
    authorization,
    ...(input.preCleanupObservation !== undefined
      ? { preCleanupObservation: input.preCleanupObservation }
      : {}),
    ...(input.cleanupSummary !== undefined ? { cleanupSummary: input.cleanupSummary } : {}),
  }
  const released = task?.status === 'blocked'
    ? storage.jobs.parkBlockedTaskWithTerminalJobs(releaseInput)
    : storage.jobs.releaseBlockedJobAndParkTask(releaseInput)
  if (!released.ok) {
    if (authorization.kind === 'technical_evidence') {
      recordTechnicalAbortRefusal(storage, {
        taskId: job.taskId,
        evidenceId: authorization.evidenceId,
        code: released.code,
        stage: 'final_transaction',
      })
      retireTechnicalAbortCleanup(storage, job, released.code)
    }
    return {
      ok: false,
      code: released.code === 'VERIFICATION_FAILED' ? 'VERIFICATION_FAILED' : 'PRECONDITION_FAILED',
      reason: released.reason,
    }
  }

  return { ok: true, taskId: job.taskId, jobId: job.id }
}

function retireTechnicalAbortCleanup(storage: IStorage, job: Job, refusalCode: string): void {
  const failureMetadata = { ...(job.failureMetadata ?? {}) }
  delete failureMetadata.abortCleanupRequestedAt
  delete failureMetadata.abortTechnicalEvidenceId
  delete failureMetadata.abortTechnicalStateFingerprint
  delete failureMetadata.abortTechnicalRootCauseClass
  delete failureMetadata.abortTechnicalAttentionKind
  delete failureMetadata.abortReason
  storage.jobs.update(job.id, {
    failureMetadata: {
      ...failureMetadata,
      quarantined: true,
      quarantineReason: `technical abort cleanup refused (${refusalCode})`,
    },
  })
}

export interface TechnicalAbortRequestInput {
  taskId: string
  /** executionLoop の current attention。関数内で fresh state と同一性を再照合する。 */
  attention: AttentionItem
  /** executionLoop と同じ ledger reader。省略時は target の tasks/roadmap.md を読む。 */
  readLedger?: () => string
}

/**
 * PL 専用の in-process Technical Abort entrypoint。
 * caller が root cause / evidence / approval を渡す欄は無く、すべて current records から再計算する。
 */
export function requestTechnicalAbort(
  storage: IStorage,
  input: TechnicalAbortRequestInput,
): AbortTaskResult {
  const current = buildSystemState(storage).attention.find((candidate) => (
    candidate.kind === input.attention.kind
    && candidate.taskId === input.taskId
    && candidate.jobId === input.attention.jobId
    && candidate.referenceId === input.attention.referenceId
  ))
  if (current === undefined) {
    recordTechnicalAbortRefusal(storage, {
      taskId: input.taskId,
      code: 'ATTENTION_CHANGED',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: 'the current attention no longer matches the Technical Abort subject',
    }
  }
  const task = storage.tasks.findById(input.taskId)
  if (task === undefined) {
    return { ok: false, code: 'TASK_NOT_FOUND', reason: `Task ${input.taskId} does not exist` }
  }
  const diagnosis = triageBlocked(storage, current)
  if (!isEligibleTechnicalAbortDiagnosis(diagnosis)) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: `INELIGIBLE_${diagnosis.rootCauseClass}`,
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: `root cause ${diagnosis.rootCauseClass} is not eligible for automatic Technical Abort`,
    }
  }
  if (task.status === 'done') {
    return { ok: false, code: 'TASK_ALREADY_DONE', reason: `Task ${task.id} is already done` }
  }
  if (task.roadmapActive !== true || (task.status !== 'pending' && task.status !== 'blocked')) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'TASK_NOT_ACTIVE_OR_PARKABLE',
      stage: 'ownership',
    })
    return {
      ok: false,
      code: task.roadmapActive === true ? 'TASK_NOT_PARKABLE' : 'TASK_NOT_ACTIVE',
      reason: `Task ${task.id} is not an active pending/blocked Technical Abort subject`,
    }
  }

  const taskJobs = storage.jobs.findByTaskId(task.id)
  const latestJob = taskJobs[0]
  if (latestJob === undefined || latestJob.id !== current.jobId) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'LATEST_JOB_CHANGED',
      stage: 'ownership',
    })
    return {
      ok: false,
      code: 'OWNERSHIP_UNPROVEN',
      reason: 'the current attention is not carried by the latest Task Job',
    }
  }
  const existingMetadata = latestJob.failureMetadata
  if (existingMetadata?.abortCleanupRequestedAt !== undefined) {
    const currentFingerprint = technicalAbortStateFingerprint(task, taskJobs, current)
    const requestStillCurrent = existingMetadata.abortTechnicalEvidenceId !== undefined
      && existingMetadata.abortTechnicalStateFingerprint === currentFingerprint
      && existingMetadata.abortTechnicalRootCauseClass === 'protected_path'
      && existingMetadata.abortTechnicalAttentionKind === current.kind
    if (requestStillCurrent) {
      // Worker poll がまだ有効な request を回収していないだけ。再発行も quarantine もせず、
      // 同じ request を残して handoff/escalation の retry を可能にする。
      return { ok: true, status: 'cleanup_requested', taskId: task.id, jobIds: [latestJob.id] }
    }
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      ...(existingMetadata.abortTechnicalEvidenceId !== undefined
        ? { evidenceId: existingMetadata.abortTechnicalEvidenceId }
        : {}),
      code: 'STALE_CLEANUP_REQUEST',
      stage: 'authorization',
    })
    retireTechnicalAbortCleanup(storage, latestJob, 'STALE_CLEANUP_REQUEST')
    return {
      ok: false,
      code: 'JOB_QUARANTINED',
      reason: 'the existing Technical Abort cleanup request no longer matches current state',
    }
  }
  if (!isWorkerServicedTechnicalAbortCarrier(task, latestJob)) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'UNSERVICEABLE_CARRIER',
      stage: 'ownership',
    })
    return {
      ok: false,
      code: 'OWNERSHIP_UNPROVEN',
      reason: `Worker does not service ${task.status} Task + ${latestJob.status} Job cleanup carriers`,
    }
  }
  const activeApproval = storage.approvalRequests.findActiveByTaskId(task.id)
  if (activeApproval !== undefined) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'ACTIVE_APPROVAL_PRESENT',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: `Task has an active ${activeApproval.status} approval`,
    }
  }
  const previouslyEscalated = hasTaskEscalation(storage, task.id, taskJobs)
  if (previouslyEscalated) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'PRIOR_CEO_ESCALATION',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: 'the Technical Abort subject was already escalated to the CEO',
    }
  }
  if (!hasProtectedPathCorroboration(task, taskJobs, latestJob)) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'PROTECTED_PATH_UNCORROBORATED',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: 'protected-path evidence is not corroborated by the Task Contract or a second Task Job',
    }
  }
  const ownershipFailure = technicalOwnershipFailure(storage, task, taskJobs)
  if (ownershipFailure !== undefined) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: ownershipFailure.code,
      stage: 'ownership',
    })
    return {
      ok: false,
      code: ownershipFailure.code === 'JOB_QUARANTINED' ? 'JOB_QUARANTINED' : 'OWNERSHIP_UNPROVEN',
      reason: ownershipFailure.reason,
    }
  }

  const roadmapTaskKey = task.roadmapTaskKey
  const readLedger = input.readLedger ?? (() => readFileSync(
    path.join(process.env.TARGET_ROOT ?? '/workspace/target', 'tasks', 'roadmap.md'),
    'utf8',
  ))
  let candidates: ReturnType<typeof readAdoptionCandidates>
  try {
    candidates = readAdoptionCandidates(readLedger)
  } catch {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'ROADMAP_UNREADABLE',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: 'the current Roadmap item could not be fingerprinted',
    }
  }
  const ledgerIds = new Set(candidates.map((candidate) => candidate.id))
  const roadmapId = roadmapTaskKey === undefined
    ? undefined
    : getBaseRoadmapId(roadmapTaskKey, ledgerIds)
  const roadmap = candidates.find((candidate) => candidate.id === roadmapId)
  if (roadmap === undefined) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      code: 'ROADMAP_ITEM_MISSING',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'TECHNICAL_EVIDENCE_INELIGIBLE',
      reason: 'the current Task is not bound to an open Roadmap item',
    }
  }

  const authorization = recordTechnicalAbortEvidence(storage, {
    task,
    taskJobs,
    attention: current,
    diagnosis,
    roadmap,
  })
  // Evidence writer と cleanup request の間の同期的な TOCTOU も閉じる。
  const refreshedTask = storage.tasks.findById(task.id)
  const refreshedJobs = storage.jobs.findByTaskId(task.id)
  if (
    refreshedTask === undefined
    || refreshedJobs[0]?.id !== latestJob.id
    || technicalAbortStateFingerprint(refreshedTask, refreshedJobs, current) !== authorization.stateFingerprint
  ) {
    recordTechnicalAbortRefusal(storage, {
      taskId: task.id,
      evidenceId: authorization.evidenceId,
      code: 'STATE_CHANGED_AFTER_EVIDENCE',
      stage: 'authorization',
    })
    return {
      ok: false,
      code: 'OWNERSHIP_UNPROVEN',
      reason: 'Task state changed while Technical Abort evidence was being issued',
    }
  }

  storage.jobs.update(latestJob.id, {
    failureMetadata: {
      ...(latestJob.failureMetadata ?? {}),
      abortCleanupRequestedAt: new Date().toISOString(),
      abortTechnicalEvidenceId: authorization.evidenceId,
      abortTechnicalStateFingerprint: authorization.stateFingerprint,
      abortTechnicalRootCauseClass: authorization.rootCauseClass,
      abortTechnicalAttentionKind: authorization.attentionKind,
      abortReason: 'technical_abort:protected_path',
    },
  })
  return { ok: true, status: 'cleanup_requested', taskId: task.id, jobIds: [latestJob.id] }
}

function technicalOwnershipFailure(
  storage: IStorage,
  task: NonNullable<ReturnType<IStorage['tasks']['findById']>>,
  taskJobs: readonly Job[],
): { code: string; reason: string } | undefined {
  if (taskJobs.length === 0) return { code: 'NO_JOB', reason: 'Technical Abort requires a latest Job' }
  const latest = taskJobs[0]
  const workingDir = latest?.safeCommand?.workingDir
  if (workingDir === undefined || workingDir === '') {
    return { code: 'WORKING_DIR_MISSING', reason: 'latest Job has no recorded workingDir' }
  }
  if (taskJobs.some((job) => job.safeCommand?.workingDir !== workingDir)) {
    return { code: 'WORKING_DIR_MISMATCH', reason: 'Task Jobs do not share one workingDir' }
  }
  if (taskJobs.some((job) => job.workspaceBaseline === undefined)) {
    return { code: 'BASELINE_MISSING', reason: 'a Task Job has no persisted workspace baseline' }
  }
  const heads = new Set(taskJobs.map((job) => job.workspaceBaseline?.startCommitHash))
  if (heads.size !== 1) {
    return { code: 'START_HEAD_MISMATCH', reason: 'Task Jobs do not share one start HEAD' }
  }
  if (!taskJobs.some((job) => job.workspaceBaseline?.mode === 'clean')) {
    return { code: 'CLEAN_BASELINE_MISSING', reason: 'Task lineage has no clean baseline at the shared HEAD' }
  }

  const cleanBaselineIndex = taskJobs.findIndex((job) => job.workspaceBaseline?.mode === 'clean')
  const cleanBaselineJob = taskJobs[cleanBaselineIndex]
  if (cleanBaselineJob === undefined || latest === undefined) {
    return { code: 'CLEAN_BASELINE_MISSING', reason: 'Task lineage has no clean baseline before its carrier' }
  }
  const historicalForeignJob = allJobs(storage).find((job) => (
    job.taskId !== task.id
    && job.safeCommand?.workingDir === workingDir
    && job.createdAt >= cleanBaselineJob.createdAt
    && job.createdAt <= latest.createdAt
  ))
  if (historicalForeignJob !== undefined) {
    return {
      code: 'FOREIGN_JOB_IN_OWNERSHIP_WINDOW',
      reason: `another Task used ${workingDir} between this Task's clean baseline and cleanup carrier`,
    }
  }
  // findByTaskId は newest-first。clean baseline から carrier までを chronological に並べ、
  // Job N の END と Job N+1 の START を一対ずつ照合する。carrier.changedFiles はもちろん、
  // どの Job の cumulative changedFiles も ownership source にしない。
  const lineage = [...taskJobs.slice(0, cleanBaselineIndex + 1)].reverse()
  const legacyJob = lineage.find((job) => job.failureMetadata?.workspaceEndFingerprint === undefined)
  if (legacyJob !== undefined) {
    return {
      code: 'END_FINGERPRINT_MISSING',
      reason:
        `Task Job ${legacyJob.id} has no persisted workspace end fingerprint (legacy row); `
        + 'technical cleanup is refused and the existing handoff remains active',
    }
  }
  for (let index = 0; index < lineage.length - 1; index += 1) {
    const previous = lineage[index]
    const next = lineage[index + 1]
    if (
      previous?.failureMetadata?.workspaceEndFingerprint === undefined
      || next?.workspaceBaseline === undefined
      || !workspaceContentFingerprintEquals(
        previous.failureMetadata.workspaceEndFingerprint,
        next.workspaceBaseline,
      )
    ) {
      return {
        code: 'JOB_CONTINUITY_BROKEN',
        reason:
          `workspace changed outside Task Jobs between ${previous?.id ?? 'unknown'} and ${next?.id ?? 'unknown'}; `
          + 'technical cleanup is refused',
      }
    }
  }
  if (taskJobs.some((job) => isLiveJob(job))) {
    return { code: 'LIVE_JOB_PRESENT', reason: 'Task still has a queued or running Job' }
  }
  if (taskJobs.some((job) => job.failureMetadata?.quarantined === true)) {
    return { code: 'JOB_QUARANTINED', reason: 'Task has a quarantined Job' }
  }

  for (const project of storage.projects.findAll()) {
    for (const otherTask of storage.tasks.findByProjectId(project.id)) {
      if (otherTask.id === task.id) continue
      for (const job of storage.jobs.findByTaskId(otherTask.id)) {
        if (job.safeCommand?.workingDir !== workingDir) continue
        if (
          isLiveJob(job)
          || holdsWorkspaceOwnership(otherTask, job)
          || occupiesProject(otherTask)
        ) {
          return {
            code: 'CROSS_PROJECT_WORKSPACE_IN_USE',
            reason: `another Task currently owns or uses ${workingDir}`,
          }
        }
      }
    }
  }
  return undefined
}

function isWorkerServicedTechnicalAbortCarrier(task: Task, carrier: Job): boolean {
  return task.status === 'pending'
    ? carrier.status === 'blocked'
    : task.status === 'blocked'
      && (carrier.status === 'failed' || carrier.status === 'success')
}

function hasProtectedPathCorroboration(task: Task, taskJobs: readonly Job[], carrier: Job): boolean {
  const carrierViolations = protectedViolations(carrier.guardResult?.fileViolations).map(normalizeProofPath)
  if (carrierViolations.length === 0) return false
  const contractPaths = new Set(
    [...(task.allowedPaths ?? []), ...(task.expectedOutputs ?? [])].map(normalizeProofPath),
  )
  if (carrierViolations.some((violation) => contractPaths.has(violation))) return true
  return carrierViolations.some((violation) => taskJobs.filter((job) => (
    protectedViolations(job.guardResult?.fileViolations)
      .map(normalizeProofPath)
      .includes(violation)
  )).length >= 2)
}

function allJobs(storage: IStorage): Job[] {
  return storage.projects.findAll().flatMap((project) => (
    storage.tasks.findByProjectId(project.id).flatMap((task) => storage.jobs.findByTaskId(task.id))
  ))
}

function normalizeProofPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function workspaceContentFingerprintEquals(
  left: JobWorkspaceBaseline,
  right: JobWorkspaceBaseline,
): boolean {
  if (left.startCommitHash !== right.startCommitHash) return false
  const contentEntries = (baseline: JobWorkspaceBaseline): string[] => (
    baseline.mode === 'clean'
      ? []
      : baseline.entries.map((entry) => `${normalizeProofPath(entry.path)}\u0000${entry.worktreeHash}`).sort()
  )
  const leftEntries = contentEntries(left)
  const rightEntries = contentEntries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every((entry, index) => entry === rightEntries[index])
}

function hasTaskEscalation(storage: IStorage, taskId: string, taskJobs: readonly Job[]): boolean {
  const taskTargetKinds = [
    'design_review_failed',
    'design_review_idle',
    'task_ready_without_job',
  ] as const
  const jobTargetKinds = [
    'job_blocked',
    'job_failed',
    'job_running_long',
    'workspace_quarantined',
  ] as const
  const targetKeys = new Set<string>(taskTargetKinds.map((kind) => `${kind}:${taskId}`))
  for (const job of taskJobs) {
    for (const kind of jobTargetKinds) targetKeys.add(`${kind}:${job.id}`)
  }
  for (const approval of storage.approvalRequests.findByTaskId(taskId)) {
    targetKeys.add(`approval_waiting:${approval.id}`)
  }

  const recoveryIds = storage.auditLog
    .findByEntity('task', taskId)
    .filter((entry) => entry.operation === 'task_human_recovered' && entry.result === 'success')
    .map((entry) => entry.id)
  targetKeys.add(`task_blocked_without_job:${taskId}:first`)
  for (const recoveryId of recoveryIds) {
    targetKeys.add(`task_blocked_without_job:${taskId}:${recoveryId}`)
  }

  return [...targetKeys].some((targetKey) => storage.auditLog
    .findByEntity('pl_loop_target', targetKey)
    .some((entry) => entry.operation === 'pl_loop' && entry.result === 'escalated'))
}
