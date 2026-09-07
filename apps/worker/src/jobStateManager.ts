/**
 * Job 状態遷移マネージャー
 *
 * FSM（有限状態機械）で Job のステータス遷移を管理する。
 * 不正な遷移を防ぎ、Worker 異常終了後の復旧を担う。
 */

import type { Job, JobStatus, Project, Task } from '@ai-team/shared'
import { buildApiAuthHeaders } from './utils/apiAuth.js'
import { verifyWorkspaceAgainstBaseline } from './workspaceVerification.js'
import { sendAlert } from './notifier/notifier.js'

const RECONCILE_TIMEOUT_MS = 5_000

export interface ReconcileRunningFailure {
  stderr: string
  completedAt: string
  /**
   * PR-C Tranche 4: caller が workspace を baseline と完全一致検証できたか。
   * true のときのみ API は Job を failed（所有権解放）にする。
   * 省略時は API 側で fail-closed（quarantine / blocked）。
   */
  workspaceVerified?: boolean
  /** workspace を検証できなかった場合の quarantine 理由。 */
  quarantineReason?: string
}

export type ReconcileRunningJobResult =
  | {
      outcome: 'reconciled'
      updated: boolean
      currentStatus: JobStatus
    }
  | {
      outcome: 'unrecoverable'
      updated: false
      currentStatus?: JobStatus
    }

/**
 * 復旧処理が Job 一覧から取得するために必要な最小フィールド（PR-C Tranche 4）。
 * workspace baseline と safeCommand.workingDir を検証に使う。
 * `failureMetadata` は quarantine 状態（startup 再検証の対象）を判定するために含める
 * （PR-C finding 14 修復）。
 */
export type RecoverableJob = Pick<Job, 'id' | 'status' | 'taskId' | 'projectId' | 'workspaceBaseline' | 'safeCommand' | 'failureMetadata'>

export interface ReconcileRunningJobOptions {
  apiBaseUrl?: string
  headers?: Record<string, string>
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['running'],
  running: ['success', 'failed', 'blocked'],
  success: [],
  failed: ['queued'],
  blocked: ['queued'],
}

export function isTransitionAllowed(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!isTransitionAllowed(from, to)) {
    throw new Error(
      `不正な状態遷移: ${from} -> ${to}。` +
        `許可: ${ALLOWED_TRANSITIONS[from]?.join(', ') || 'なし'}`
    )
  }
}

export async function reconcileRunningJob(
  jobId: string,
  failure: ReconcileRunningFailure,
  options: ReconcileRunningJobOptions = {},
): Promise<ReconcileRunningJobResult> {
  const apiBaseUrl = options.apiBaseUrl ?? process.env.API_BASE_URL ?? 'http://localhost:3000'
  const headers = options.headers ?? buildApiAuthHeaders()
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? RECONCILE_TIMEOUT_MS)

  try {
    const response = await fetchImpl(
      `${apiBaseUrl}/api/jobs/${encodeURIComponent(jobId)}/fail-if-running`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(failure),
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      return { outcome: 'unrecoverable', updated: false }
    }

    const body = await response.json() as unknown
    if (!isFailIfRunningResponse(body)) {
      return { outcome: 'unrecoverable', updated: false }
    }

    if (body.updated) {
      return {
        outcome: 'reconciled',
        updated: true,
        currentStatus: body.currentStatus,
      }
    }

    if (body.currentStatus !== 'running') {
      return {
        outcome: 'reconciled',
        updated: false,
        currentStatus: body.currentStatus,
      }
    }

    return {
      outcome: 'unrecoverable',
      updated: false,
      currentStatus: body.currentStatus,
    }
  } catch {
    return { outcome: 'unrecoverable', updated: false }
  } finally {
    clearTimeout(timeout)
  }
}

export async function recoverStaleJobs(
  apiBaseUrl: string,
  headers: Record<string, string> = {}
): Promise<number> {
  let recovered = 0
  const projects = await fetchJson<Pick<Project, 'id'>[]>('/api/projects', apiBaseUrl, headers)
  if (!projects) return recovered

  for (const project of projects) {
    const tasks = await fetchJson<Pick<Task, 'id'>[]>(
      `/api/tasks?projectId=${encodeURIComponent(project.id)}`,
      apiBaseUrl,
      headers
    )
    if (!tasks) continue

    for (const task of tasks) {
      const jobs = await fetchJson<RecoverableJob[]>(
        `/api/jobs?taskId=${encodeURIComponent(task.id)}`,
        apiBaseUrl,
        headers
      )
      if (!jobs) continue

      for (const job of jobs) {
        if (job.status === 'running') {
          const didRecover = await reconcileRunningJobAtStartup(job, apiBaseUrl, headers)
          if (didRecover) recovered += 1
          continue
        }

        // PR-C finding 14 修復: blocked + quarantine の Job は、startup の度に workspace を
        // 再検証し、クリーンと確認できた場合のみ quarantine 解除を申請する。それによって
        // この Task は resumeBlockedTask が再開可能になる（「解除は検証の成功をもってのみ」）。
        // 依然として検証できない場合は quarantine を維持する（所有権を保持）。
        // ここでクリアンスアラートを再送信しない（最初の quarantine 時のCRITICALのみ）ため、
        // 起動のたびに同じ通知が重複する懸念は無い。
        if (job.status === 'blocked' && job.failureMetadata?.quarantined === true) {
          await reconcileQuarantinedJobAtStartup(job, apiBaseUrl, headers)
        }
      }
    }
  }

  return recovered
}

async function reconcileRunningJobAtStartup(
  job: RecoverableJob,
  apiBaseUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  // PR-C Tranche 4: workspace が baseline（Job 開始時点）と完全一致する場合のみ
  // 所有権を解放（failed 化）できる。不一致・検証不能なら quarantine（blocked）し、
  // 所有権を保持する。検証は決して throw せず、必ず verified:true / false を返す。
  const workingDir = job.safeCommand?.workingDir
  const verification = workingDir
    ? verifyWorkspaceAgainstBaseline(workingDir, job.workspaceBaseline)
    : { verified: false as const, reason: 'job has no safeCommand.workingDir; cannot verify workspace' }
  const workspaceVerified = verification.verified
  const quarantineReason = workspaceVerified
    ? undefined
    : `workspace not verified safe after crash: ${verification.reason}`

  if (!workspaceVerified) {
    emitWorkspaceQuarantineAlert(job, workingDir ?? '(unknown)', verification.reason)
  }

  assertTransition(job.status, workspaceVerified ? 'failed' : 'blocked')
  const reconciliation = await reconcileRunningJob(
    job.id,
    {
      stderr: workspaceVerified
        ? '[Worker] 前回の Worker が異常終了したため failed にリセットしました'
        : `[Worker] workspace を検証できなかったため quarantine（blocked）にしました: ${verification.reason}`,
      completedAt: new Date().toISOString(),
      workspaceVerified,
      ...(quarantineReason ? { quarantineReason } : {}),
    },
    { apiBaseUrl, headers },
  )
  if (reconciliation.outcome === 'reconciled' && reconciliation.updated) {
    if (workspaceVerified) {
      console.log(`[Recovery] Job ${job.id} を running -> failed にリセット（workspace verified）`)
      return true
    }
    console.log(`[Recovery] Job ${job.id} を running -> blocked に quarantine（workspace not verified）`)
  }
  return false
}

/**
 * PR-C finding 14 修復: blocked + quarantine の Job を startup で再検証し、
 * workspace が baseline と完全一致する場合のみ quarantine 解除を申請する。
 *
 * 解除は**ここで検証に成功した場合のみ**申請する。失敗したら何もしない（quarantine 維持）。
 * 申請自体は workspaceVerified:true を提示する clear-quarantine API が受理し、
 * 機械的にここで検証した成立結果を主張する（bypass ではない）。
 */
async function reconcileQuarantinedJobAtStartup(
  job: RecoverableJob,
  apiBaseUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  const workingDir = job.safeCommand?.workingDir
  const verification = workingDir
    ? verifyWorkspaceAgainstBaseline(workingDir, job.workspaceBaseline)
    : { verified: false as const, reason: 'job has no safeCommand.workingDir; cannot verify workspace' }

  if (!verification.verified) {
    console.log(
      `[Recovery] Job ${job.id} は quarantine のまま維持（workspace still not verified: ${verification.reason}）`,
    )
    return
  }

  const clearedAt = new Date().toISOString()
  const cleared = await requestQuarantineClearance(job.id, apiBaseUrl, headers, {
    quarantineClearedReason: `startup recovery: workspace verified clean against its baseline (${clearedAt})`,
  })
  if (cleared) {
    console.log(`[Recovery] Job ${job.id} workspace がクリーンと検証されたため quarantine を解除しました（resume 可能）`)
  } else {
    console.log(`[Recovery] Job ${job.id} はクリーンと検証できたが quarantine 解除申請に失敗（別の起動で再試行）`)
  }
}

/** clear-quarantine API へ解除申請する。workspace 検証に成功した場合にのみ呼ばれる。 */
async function requestQuarantineClearance(
  jobId: string,
  apiBaseUrl: string,
  headers: Record<string, string>,
  extras: { quarantineClearedReason?: string },
): Promise<boolean> {
  try {
    const res = await fetch(
      `${apiBaseUrl}/api/jobs/${encodeURIComponent(jobId)}/clear-quarantine`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceVerified: true,
          ...(extras.quarantineClearedReason ? { quarantineClearedReason: extras.quarantineClearedReason } : {}),
        }),
      },
    )
    return res.ok
  } catch {
    // API 到達不能・失敗は fail-closed: quarantine を維持する（次回 startup で再試行）。
    return false
  }
}

/**
 * workspace を検証できず quarantine された Job を CEO へ通報する（CRITICAL）。
 * 既存の notifier（sendAlert）を使い、新しい通知機構は作らない。
 */
function emitWorkspaceQuarantineAlert(
  job: { id: string; taskId: string; projectId: string },
  workingDir: string,
  reason: string,
): void {
  const payload = {
    severity: 'critical' as const,
    title: 'Worker 再起動後に workspace を検証できず quarantine（所有権保持）',
    body: [
      '前回の Worker 異常終了後、この Job の workspace がクラッシュ時の baseline と',
      '完全一致することを検証できませんでした。未検証 workspace へ新しい作業を割り当てないよう、',
      'Job は blocked に quarantine され、所有権は保持されています。CEO の確認が必要です。',
      '',
      `Job: ${job.id}`,
      `Task: ${job.taskId}`,
      `Project: ${job.projectId}`,
      `WorkingDir: ${workingDir}`,
      `理由: ${reason}`,
      `検出時刻: ${new Date().toISOString()}`,
      '',
      '次のアクション:',
      'workspace を確認し、必要な場合は修復後に Job を手動で resume してください。',
    ].join('\n'),
    sourceType: 'workspace_quarantine',
    sourceId: job.id,
  }
  try {
    void sendAlert(payload)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Recovery] workspace quarantine CRITICAL通知エラー: ${message}`)
  }
}

async function fetchJson<T>(
  path: string,
  apiBaseUrl: string,
  headers: Record<string, string>
): Promise<T | null> {
  const res = await fetch(`${apiBaseUrl}${path}`, { headers })
  if (!res.ok) return null
  return await res.json() as T
}

function isFailIfRunningResponse(
  value: unknown,
): value is { updated: boolean; currentStatus: JobStatus } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { updated?: unknown; currentStatus?: unknown }
  return typeof candidate.updated === 'boolean' && isJobStatus(candidate.currentStatus)
}

function isJobStatus(value: unknown): value is JobStatus {
  return value === 'queued' ||
    value === 'running' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'blocked'
}
