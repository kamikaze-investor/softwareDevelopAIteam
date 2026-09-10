/**
 * AI Development Team OS — Worker
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 役割:
 * - API から queued Job をポーリング
 * - Permission Guard で検証
 * - commandResolver で argv に変換
 * - execFileSync で実行（shell: false）
 * - File Change Guardでdiffを検証
 * - 結果を API で更新
 */

import type { Job, Project, ReviewResult, Task } from '@ai-team/shared'
import {
  assertTransition,
  reconcileRunningJob,
  recoverStaleJobs,
} from './jobStateManager.js'
import type {
  ReconcileRunningFailure,
  ReconcileRunningJobResult,
} from './jobStateManager.js'
import { runJob, computeWorkspaceBaseline, WorkspaceReconciliationError } from './jobRunner.js'
import type { JobRunResult, StructuredReviewContext } from './jobRunner.js'
import { isContainmentInfrastructureError } from './execution/runContainedCommand.js'
import { buildRuntimeTaskPolicy } from './guards/fileChangeGuard.js'
import { buildApiAuthHeaders } from './utils/apiAuth.js'
import { startWatchdog } from './watchdog/watchdog.js'
import { sendAlert } from './notifier/notifier.js'
import * as outboxStore from './outbox/outboxStore.js'

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000'
const POLL_INTERVAL_MS = readPollInterval()
const PATCH_TIMEOUT_MS = 5_000
const PATCH_BACKOFF_MS = [500, 1_000] as const
const TECHNICAL_PERSISTENCE_FAILURE =
  'Job status persistence failed after bounded retries due to a technical communication failure.'

console.log('Worker starting...')
console.log(`API: ${API_BASE}, poll interval: ${POLL_INTERVAL_MS}ms`)

export type JobUpdate = Partial<Pick<
  Job,
  | 'status'
  | 'startedAt'
  | 'completedAt'
  | 'exitCode'
  | 'stdout'
  | 'stderr'
  | 'stdoutPath'
  | 'stderrPath'
  | 'changedFiles'
  | 'commitHash'
  | 'guardResult'
  | 'failureMetadata'
  | 'workspaceBaseline'
>> & {
  reviewResult?: Pick<ReviewResult, 'status' | 'summary' | 'findings'>
}

/** queued Job と、その Job が属する Task を一緒に返す（Task は実行時ポリシー構築に必須） */
export interface QueuedWork {
  job: Job
  task: Task
  jobs: Job[]
}

/**
 * すべての Job の safeCommand.workingDir は TARGET_WORKING_DIR（単一の共有ディレクトリ）に
 * 固定されている（MVP-A: 単一Repository固定）。あるTaskのJobが running/blocked の間は
 * そのTaskのworking treeに未commitの変更が残っている可能性があるため、
 * 別Taskのqueued Jobをclaimしない。これにより、Task境界を越えた変更混入
 * （Task Aの未commit変更をTask Bがcommitに巻き込む等）を防ぐ。
 * 既存のWorkerプロセス単位のflockはJobを1つずつ順番に実行することは保証するが、
 * 「どのTaskが現在workspaceを保有しているか」は関知しないため、この判定を追加する。
 *
 * running/blocked だけでは不十分な既知のwindowがある: approveAndResumeJob()
 * （CEOがgit_commit承認を出した直後）は、blockedだったgit_commit Jobを
 * 直接 'queued' へ戻す（apps/api/src/storage/sqlite.ts）。この瞬間、そのTaskの
 * Jobは running でも blocked でもなくなるが、まだcommitは実行されていない。
 * そこで、workflowStepKeyが最初のinitial-implementそのものではないqueued Job
 * （＝review/repair/git-commit/resumeなど、既に開始済みのchainの続き）も
 * 所有中として扱う。初めてのinitial-implement Jobがqueuedなだけの状態
 * （＝そのTaskはまだ何も実行していない）は対象外のままにする。
 */
function isInitialImplementStepKey(taskId: string, workflowStepKey: string | undefined): boolean {
  return workflowStepKey === `task:${taskId}:initial-implement`
}

function findWorkspaceOwningTaskId(perTask: readonly { task: Task; jobs: Job[] }[]): string | undefined {
  for (const { task, jobs } of perTask) {
    const owns = jobs.some((job) => (
      job.status === 'running' ||
      job.status === 'blocked' ||
      (job.status === 'queued' && !isInitialImplementStepKey(task.id, job.workflowStepKey))
    ))
    if (owns) return task.id
  }
  return undefined
}

export async function fetchQueuedJob(): Promise<QueuedWork | null> {
  const projects = await fetchJson<Project[]>('/api/projects')
  if (!projects) return null

  const perTask: Array<{ task: Task; jobs: Job[] }> = []
  for (const project of projects) {
    if (project.status !== 'running') continue

    const tasks = await fetchJson<Task[]>(`/api/tasks?projectId=${encodeURIComponent(project.id)}`)
    if (!tasks) continue

    for (const task of tasks) {
      const jobs = await fetchJson<Job[]>(`/api/jobs?taskId=${encodeURIComponent(task.id)}`)
      if (!jobs) continue
      perTask.push({ task, jobs })
    }
  }

  const workspaceOwnerTaskId = findWorkspaceOwningTaskId(perTask)

  for (const { task, jobs } of perTask) {
    if (workspaceOwnerTaskId !== undefined && workspaceOwnerTaskId !== task.id) continue

    const queued = jobs.find((job) => job.status === 'queued')
    if (queued) return { job: queued, task, jobs }
  }

  return null
}

export interface PatchJobWithRetryOptions {
  apiBaseUrl?: string
  headers?: Record<string, string>
  timeoutMs?: number
  backoffMs?: readonly [number, number]
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

export async function patchJobWithRetry(
  jobId: string,
  payload: JobUpdate,
  options: PatchJobWithRetryOptions = {},
): Promise<boolean> {
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE
  const headers = options.headers ?? buildApiAuthHeaders()
  const fetchImpl = options.fetchImpl ?? fetch
  const sleepImpl = options.sleepImpl ?? sleep
  const backoffMs = options.backoffMs ?? PATCH_BACKOFF_MS
  const requestBody = JSON.stringify(payload)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? PATCH_TIMEOUT_MS)
    try {
      const response = await fetchImpl(
        `${apiBaseUrl}/api/jobs/${encodeURIComponent(jobId)}`,
        {
          method: 'PATCH',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: requestBody,
          signal: controller.signal,
        },
      )
      if (response.ok) return true
    } catch {
      // A network error and an AbortController timeout are both retryable here.
    } finally {
      clearTimeout(timeout)
    }

    if (attempt < 2) {
      await sleepImpl(backoffMs[attempt])
    }
  }

  return false
}

type PatchJob = (jobId: string, payload: JobUpdate) => Promise<boolean>
type ReconcileJob = (
  jobId: string,
  failure: ReconcileRunningFailure,
) => Promise<ReconcileRunningJobResult>
type Alert = (payload: Parameters<typeof sendAlert>[0]) => Promise<unknown>

export interface JobPersistenceDependencies {
  patchJob?: PatchJob
  reconcileJob?: ReconcileJob
  alert?: Alert
  now?: () => string
}

export async function persistJobResult(
  jobId: string,
  result: Awaited<ReturnType<typeof runJob>>,
  resultStatus: Job['status'],
  dependencies: JobPersistenceDependencies = {},
): Promise<void> {
  const resultUpdate: JobUpdate = {
    status: resultStatus,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    changedFiles: result.changedFiles,
    commitHash: result.commitHash,
    completedAt: result.completedAt,
    guardResult: result.guardResult,
    failureMetadata: result.providerFailureKind || result.workspaceState
      ? {
          kind: result.providerFailureKind,
          workspaceState: result.workspaceState,
        }
      : undefined,
    reviewResult: result.reviewResult,
  }
  const persisted = await persistTerminalUpdate(jobId, resultUpdate, dependencies)
  if (persisted) {
    if (result.reviewResult && result.reviewResult.status !== 'approved') {
      try {
        await (dependencies.alert ?? sendAlert)({
          severity: result.reviewResult.status === 'rejected' ? 'critical' : 'warning',
          title: `Structured review: ${result.reviewResult.status}`,
          body: `${result.reviewResult.summary}\nJob: ${jobId}\n自動修正は行わず停止しました。`,
          sourceType: 'structured_review',
          sourceId: jobId,
        })
      } catch (err: unknown) {
        console.error(`[Worker] structured review通知エラー: ${formatUnknownError(err)}`)
      }
    }
  }
}

async function persistTerminalUpdate(
  jobId: string,
  payload: JobUpdate,
  dependencies: JobPersistenceDependencies,
): Promise<boolean> {
  const outboxEvent = outboxStore.recordPending(jobId, payload)
  const deliveryPayload = {
    ...payload,
    eventId: outboxEvent.eventId,
    payloadHash: outboxEvent.payloadHash,
  }
  const persisted = await (dependencies.patchJob ?? patchJobWithRetry)(jobId, deliveryPayload)
  if (persisted) {
    outboxStore.deletePending(jobId)
    return true
  }

  console.warn(
    `[Worker] Job ${jobId} terminal update PATCH failed after retries, but the result is persisted in the local Outbox. ` +
    'It will be resent before startup recovery on the next Worker start.',
  )
  return false
}

async function reconcileAfterPatchFailure(
  jobId: string,
  failure: ReconcileRunningFailure,
  dependencies: JobPersistenceDependencies,
): Promise<void> {
  const reconciliation = await (dependencies.reconcileJob ?? reconcileRunningJob)(jobId, failure)
  if (reconciliation.outcome === 'reconciled') {
    console.log(
      `[Worker] Job ${jobId} のstatus保存失敗をreconciliationで収束しました ` +
      `(currentStatus=${reconciliation.currentStatus})`,
    )
    return
  }

  try {
    await (dependencies.alert ?? sendAlert)({
      severity: 'critical',
      title: 'Job status persistence technical failure（技術的障害）',
      body: `Job ${jobId} could not be reconciled after a technical failure（技術的障害）. ` +
        'Manual investigation is required.',
      sourceType: 'job_persistence',
      sourceId: jobId,
    })
  } catch (err: unknown) {
    console.error(`[Worker] CRITICAL通知エラー: ${formatUnknownError(err)}`)
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: buildApiAuthHeaders(),
  })

  if (!res.ok) return null
  return await res.json() as T
}

export interface ProcessQueuedWorkDependencies extends JobPersistenceDependencies {
  executeJob?: typeof runJob
  buildPolicy?: typeof buildRuntimeTaskPolicy
}

export async function processQueuedWork(
  work: QueuedWork,
  dependencies: ProcessQueuedWorkDependencies = {},
): Promise<Job['status'] | null> {
  const { job, task, jobs } = work
  let policy: ReturnType<typeof buildRuntimeTaskPolicy>
  try {
    if (task.projectId !== job.projectId) {
      throw new Error(
        `Task と Job の Project が一致しません: task.projectId=${task.projectId} job.projectId=${job.projectId}`,
      )
    }
    policy = (dependencies.buildPolicy ?? buildRuntimeTaskPolicy)(task)
  } catch (err: unknown) {
    const message = `実行時Taskポリシーを構築できないため実行しません: ${formatUnknownError(err)}`
    console.error(`[Worker] ${message}`)
    const runningConfirmed = await confirmRunningTransition(job, dependencies)
    if (!runningConfirmed) return null

    assertTransition('running', 'failed')
    const failedPayload: JobUpdate = {
      status: 'failed',
      stderr: message,
      completedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    }
    await persistTerminalUpdate(job.id, failedPayload, dependencies)
    return 'failed'
  }

  const runningConfirmed = await confirmRunningTransition(job, dependencies)
  if (!runningConfirmed) return null

  // ── P1 Phase 2: containment / reconciliation の失敗を Job 所有権protocolへ接続する ──
  // これらの例外を poll loop の logger まで素通りさせると、Job は `running` のまま
  // 残り、workspace の所有権を保持したまま誰も面倒を見ない状態になる。
  // 「安全と証明できない限り所有権を解放しない」ため、`failed` ではなく
  // quarantine 付き `blocked` へ落とす。
  let result: JobRunResult
  try {
    result = await (dependencies.executeJob ?? runJob)(
      job,
      policy,
      buildStructuredReviewContext(job, task, jobs),
    )
  } catch (err: unknown) {
    if (!isUnsafeWorkspaceError(err)) throw err
    await quarantineRunningJob(job, err, dependencies)
    return 'blocked'
  }
  const resultStatus = resolveResultStatus(result)

  assertTransition('running', resultStatus)
  await persistJobResult(job.id, result, resultStatus, dependencies)
  return resultStatus
}

/**
 * P1 Phase 2: workspace が静止していると証明できなかったことを表す例外か。
 * containment インフラの失敗（drain 未完了・cleanup 失敗・placement 失敗など）と、
 * 実行後 reconciliation の失敗（git 操作マーカー残存など）の両方を含む。
 */
function isUnsafeWorkspaceError(err: unknown): boolean {
  return isContainmentInfrastructureError(err) || err instanceof WorkspaceReconciliationError
}

/**
 * running 中の Job を quarantine 付き `blocked` へ落とし、所有権を保持する。
 * `failed` にしてはならない: `failed` は workspace を所有しないため、
 * 生存プロセスや壊れた git 状態が残ったまま次の Job へ引き渡してしまう。
 */
async function quarantineRunningJob(
  job: Job,
  err: unknown,
  dependencies: JobPersistenceDependencies,
): Promise<void> {
  const reason = formatUnknownError(err)
  const message = `workspace could not be proven quiescent: ${reason}`
  console.error(`[Worker] Job ${job.id} を quarantine します: ${message}`)

  assertTransition('running', 'blocked')
  await (dependencies.alert ?? sendAlert)({
    severity: 'critical',
    title: 'Workspace quarantined after Job execution',
    body: [
      `Job ID: ${job.id}`,
      `Task ID: ${job.taskId}`,
      `理由: ${reason}`,
      'containment または実行後 reconciliation が完了を証明できませんでした。',
      'Job を blocked にし、workspace 所有権を保持しています。',
      'reconciliation が成功するまで resume / repair / 新規 claim は拒否されます。',
    ].join('\n'),
    sourceType: 'job_persistence',
    sourceId: job.id,
  }).catch((alertErr: unknown) => {
    console.error(`[Worker] CRITICAL通知エラー: ${formatUnknownError(alertErr)}`)
  })

  // reconciliation に失敗しても、この Job が作った commit は取り消せない。
  // quarantine しても commit hash は必ず記録する（証跡を失わないため）。
  const createdCommitHash = err instanceof WorkspaceReconciliationError ? err.commitHash : undefined

  await persistTerminalUpdate(job.id, {
    status: 'blocked',
    stderr: `${message} (workspace quarantined; ownership retained)`,
    completedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    ...(createdCommitHash !== undefined ? { commitHash: createdCommitHash } : {}),
    failureMetadata: {
      kind: 'workspace_containment_failure',
      workspaceState: 'unknown',
      quarantined: true,
      quarantineReason: message,
    },
  }, dependencies)
}

async function confirmRunningTransition(
  job: Job,
  dependencies: JobPersistenceDependencies,
): Promise<boolean> {
  assertTransition(job.status, 'running')

  // ── PR-C: claim（queued -> running）と workspace baseline を同一 PATCH で原子化する ──
  // baseline は Job の子プロセスが workspace を変更し得る**前**に durable に保存しなければ
  // ならない。ここで Job はまだ queued であり、initial-implement 以外の queued Job は
  // findWorkspaceOwningTaskId() により該当 Task が workspace を保有している扱いになる。
  // Worker は systemd の flock で単一インスタンス化され、poll loop も単一スレッドのため、
  // baseline 計算と claim の間に他 Task が workspace を奪うことは無い。
  // baseline 取得に失敗したら claim せず fail-closed で failed へ落とす（子プロセスを起動しない）。
  const baseline = computeWorkspaceBaseline(job, job.safeCommand.workingDir)
  if (!baseline.ok) {
    const message = `workspace baseline failure: ${baseline.reason}`
    console.error(`[Worker] Job ${job.id} の開始を停止します: ${message}`)
    // 独立レビュー指摘（PR-C）: baseline を作れなかったということは workspace の状態を
    // 特定できないということ。ここで `failed` にすると、既に workspace を所有している
    // Job（repair/resume/retry のような initial-implement 以外の queued Job）の所有権を
    // 「検証できていない workspace」に対して解放してしまう。これは PR-C の hard invariant
    // （安全と証明できない限り所有権を解放しない）に反するため、所有している場合は
    // quarantine 付きの `blocked` へ fail closed し、所有権を保持する。
    // initial-implement Job はまだ workspace を所有していないので従来どおり `failed`。
    const ownsWorkspaceBeforeClaim = !isInitialImplementStepKey(job.taskId, job.workflowStepKey)
    const now = (dependencies.now ?? (() => new Date().toISOString()))()
    const failedPayload: JobUpdate = ownsWorkspaceBeforeClaim
      ? {
          status: 'blocked',
          stderr: `${message} (workspace quarantined; ownership retained)`,
          completedAt: now,
          failureMetadata: {
            kind: 'workspace_baseline_failure',
            workspaceState: 'unknown',
            quarantined: true,
            quarantineReason: message,
          },
        }
      : {
          status: 'failed',
          stderr: message,
          completedAt: now,
        }
    if (ownsWorkspaceBeforeClaim) {
      await (dependencies.alert ?? sendAlert)({
        severity: 'critical',
        title: 'Workspace quarantined before Job start',
        body: [
          `Job ID: ${job.id}`,
          `Task ID: ${job.taskId}`,
          `理由: ${baseline.reason}`,
          "workspace の状態を特定できないため Job を blocked にし、workspace 所有権を保持しました。",
          "reconciliation が成功するまで resume / repair / 新規 claim は拒否されます。",
        ].join('\n'),
        sourceType: 'job_persistence',
        sourceId: job.id,
      }).catch((err: unknown) => {
        console.error(`[Worker] CRITICAL通知エラー: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    await persistTerminalUpdate(job.id, failedPayload, dependencies)
    return false
  }

  const runningPayload: JobUpdate = {
    status: 'running',
    startedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    workspaceBaseline: baseline.baseline,
  }
  const confirmed = await (dependencies.patchJob ?? patchJobWithRetry)(job.id, runningPayload)
  if (confirmed) return true

  await reconcileAfterPatchFailure(
    job.id,
    {
      stderr: 'Failed to confirm running transition',
      completedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    },
    dependencies,
  )
  return false
}

/**
 * supervised run の reconcile を1回起動する（#110 Step 3）。
 *
 * 失敗しても poll cycle を壊さない。次の cycle で再試行されるだけであり、
 * ここで throw すると Job intake ごと止まってしまう。
 */
/**
 * Task continuation の reconcile を既存 poll cycle に相乗りさせる。
 *
 * 新しい queue / daemon / scheduler は追加しない（reconcileSupervisedRuns() と同じ形）。
 * これが無いと、commit 成功時に次 Project が paused だった continuation は
 * 'pending' のまま残り、Mobile の GET /api/projects 系でしか回収されない
 * （= client を閉じたままでは次 Task へ進めない）。
 *
 * ここでは retry も gate 判定もしない。判定は API 側 createInitialImplementWorkflow() が持つ。
 */
export async function reconcileTaskContinuations(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/task-continuations/reconcile`, {
      method: 'POST',
      headers: buildApiAuthHeaders(),
    })
    if (!response.ok) {
      console.warn(`[Worker] task continuation reconcile failed: HTTP ${response.status}`)
      return
    }
    // recovered=0 を毎 cycle 出力すると POLL_INTERVAL_MS ごとにログを埋めるため、
    // 実際に状態が動いたときだけ残す（効果検証は task_continuations の durable state が正本）。
    const summary = (await response.json()) as { recovered?: number, failed?: number, stillPending?: number }
    const recovered = summary.recovered ?? 0
    const failed = summary.failed ?? 0
    if (recovered > 0 || failed > 0) {
      console.log(
        `[Worker] task continuation reconcile: recovered=${recovered} failed=${failed} ` +
        `stillPending=${summary.stillPending ?? 0}`,
      )
    }
  } catch (err: unknown) {
    console.warn(`[Worker] task continuation reconcile error: ${formatUnknownError(err)}`)
  }
}

export async function reconcileSupervisedRuns(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/supervised-runs/reconcile`, {
      method: 'POST',
      headers: buildApiAuthHeaders(),
    })
    if (!response.ok) {
      console.warn(`[Worker] supervised run reconcile failed: HTTP ${response.status}`)
    }
  } catch (err: unknown) {
    console.warn(`[Worker] supervised run reconcile error: ${formatUnknownError(err)}`)
  }
}

export async function pollJobs(): Promise<never> {
  // pendingが連続して残ったpoll cycle数。起動直後もこの1ループに合流するため、
  // startup専用の別ループは持たない（start()は本関数を即座に呼ぶだけ）。
  let pendingOutboxStreak = 0
  let pendingOutboxAlertSent = false

  while (true) {
    try {
      // supervised run の reconcile を既存 poll cycle に相乗りさせる（#110 Step 3）。
      // 新しい daemon / scheduler は追加しない（Outbox 再送を同じ cycle に載せているのと同じ形）。
      //
      // **Outbox の分岐より前に置く**（独立レビュー指摘 Step 3 第2ラウンド #2）。
      // else 側に置くと、Outbox に配送できない event が1件でも残っている間
      // supervision が完全に止まり、完了済みの委任が RUNNING のまま放置される。
      // Job intake を止める理由（workspace 競合）は supervision には当てはまらない。
      //
      // Worker はここで **retry しない**。retry は delegate-watchdog.sh の責務であり、
      // 二重の retry actor を作らない（CEO確定構造）。ここが担うのは
      // 「runDir の事実を durable state へ反映」「supervisor 自身が死んだ run の検出」
      // 「terminal 後の continuation 起動」だけである。
      await reconcileSupervisedRuns()
      // Task continuation の回収も同じ位置（**Outbox 分岐より前**）に置く。
      // else 側に置くと、Outbox に配送できない event が1件でも残っている間 continuation が
      // 一切進まなくなる。Job intake を止める理由（workspace 競合）は continuation 回収には
      // 当てはまらない（実際に次 Job を作るかどうかは API 側の既存 gate が決める）。
      await reconcileTaskContinuations()

      if (outboxStore.hasPending()) {
        console.warn('[Worker] Pending Outbox events remain; skipping queued Job fetch for this poll cycle.')
        // 稼働中も未送信結果を再送する。新しいscheduler/watchdog/retry frameworkは追加せず、
        // 既存のpoll cycleに相乗りする。
        // 1 pollにつき1 resend batch。失敗時はpendingを保持し、tight loopせず次pollで再試行する。
        try {
          await outboxStore.resendPending((jobId, payload) => patchJobWithRetry(jobId, payload))
        } catch (err: unknown) {
          console.error(`[Worker] Outbox再送エラー: ${formatUnknownError(err)}。次のpollで再試行します`)
        }

        if (outboxStore.hasPending()) {
          pendingOutboxStreak += 1
          if (pendingOutboxStreak >= 3 && !pendingOutboxAlertSent) {
            pendingOutboxAlertSent = true
            await notifyOutboxDeliveryBlocked()
          }
        } else {
          pendingOutboxStreak = 0
          pendingOutboxAlertSent = false
        }
      } else {
        pendingOutboxStreak = 0
        pendingOutboxAlertSent = false
        const work = await fetchQueuedJob()
        if (work) {
          const { job } = work
          console.log(`[Worker] Job ${job.id} (${job.safeCommand.kind}) を実行します`)
          const resultStatus = await processQueuedWork(work)
          if (resultStatus) console.log(`[Worker] Job ${job.id}: ${resultStatus}`)
        }
      }
    } catch (err: unknown) {
      console.error(`[Worker] ポーリングエラー: ${formatUnknownError(err)}`)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * pendingなOutboxイベントが複数pollにわたって配送できない場合の通知。
 * Job intakeは止めない（新しいJob fetchをスキップするだけ）ため、これは
 * 「配送できていない」ことをCEOへ知らせるためだけの通知である。
 */
async function notifyOutboxDeliveryBlocked(): Promise<void> {
  try {
    await sendAlert({
      severity: 'critical',
      title: 'Worker Outbox resend is blocked',
      body: 'Pending Worker Outbox events could not be delivered after repeated retry cycles. New Job intake is paused until delivery succeeds; Worker startup and the watchdog are unaffected.',
      sourceType: 'job_persistence',
      sourceId: 'worker_outbox',
    })
  } catch (err: unknown) {
    console.error(`[Worker] CRITICAL通知エラー: ${formatUnknownError(err)}`)
  }
}

function readPollInterval(): number {
  const parsed = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function resolveResultStatus(result: Awaited<ReturnType<typeof runJob>>): Job['status'] {
  // 技術的失敗は blocked（承認・手動resume待ち）へ変換しない。
  // blocked は resumeBlockedTask() の入口であり、人手の再開待ちを意味するため。
  // - detectionFailure: 変更検出・ポリシー構築の失敗
  // - technicalFailure: Permission API / Gate API の疎通不可・認証失敗・不正レスポンス
  if (result.detectionFailure || result.technicalFailure) {
    return 'failed'
  }

  if (!result.guardResult.permissionAllowed || !result.guardResult.fileChangeAllowed) {
    return 'blocked'
  }

  return result.status
}

async function recoverJobsAtStartup(): Promise<void> {
  try {
    const recovered = await recoverStaleJobs(API_BASE, buildApiAuthHeaders())
    if (recovered > 0) {
      console.log(`[Worker] ${recovered} 件の stale Job を復旧しました`)
    }
  } catch (err: unknown) {
    console.error(`[Worker] 起動時復旧エラー: ${formatUnknownError(err)}。通常ポーリングを継続します`)
  }
}

export async function start(): Promise<void> {
  // pending Outboxがあっても待たない。pollJobs()自身がpoll cycleごとに
  // pendingの再送とnew Job fetchのskipを行うため、起動直後からwatchdog/pollingを
  // 開始してよい（起動専用の別blockingループは持たない）。
  await recoverJobsAtStartup()
  // ウォッチドッグを pollJobs と並行して起動
  void startWatchdog(API_BASE, buildApiAuthHeaders())
  await pollJobs()
}

if (process.env.VITEST !== 'true') {
  start().catch((err: unknown) => {
    console.error(`[Worker] 起動エラー: ${formatUnknownError(err)}`)
    process.exitCode = 1
  })
}

function buildStructuredReviewContext(
  job: Job,
  task: Task,
  jobs: Job[],
): StructuredReviewContext | undefined {
  if (job.aiCliMode !== 'review') return undefined

  const match = job.workflowStepKey
    ? /^implement:(.+):review$/.exec(job.workflowStepKey)
    : null
  const implementJob = match
    ? jobs.find((candidate) => candidate.id === match[1])
    : jobs.find((candidate) => candidate.aiCliMode === 'implement' && candidate.status === 'success')
  return implementJob ? { task, implementJob } : undefined
}
