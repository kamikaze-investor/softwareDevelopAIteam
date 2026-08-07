/**
 * Job 状態遷移マネージャー
 *
 * FSM（有限状態機械）で Job のステータス遷移を管理する。
 * 不正な遷移を防ぎ、Worker 異常終了後の復旧を担う。
 */

import type { Job, JobStatus, Project, Task } from '@ai-team/shared'
import { buildApiAuthHeaders } from './utils/apiAuth.js'

const RECONCILE_TIMEOUT_MS = 5_000

export interface ReconcileRunningFailure {
  stderr: string
  completedAt: string
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
      const jobs = await fetchJson<Pick<Job, 'id' | 'status'>[]>(
        `/api/jobs?taskId=${encodeURIComponent(task.id)}`,
        apiBaseUrl,
        headers
      )
      if (!jobs) continue

      for (const job of jobs) {
        if (job.status === 'running') {
          assertTransition(job.status, 'failed')
          const reconciliation = await reconcileRunningJob(
            job.id,
            {
              stderr: '[Worker] 前回の Worker が異常終了したため failed にリセットしました',
              completedAt: new Date().toISOString(),
            },
            { apiBaseUrl, headers },
          )
          if (reconciliation.outcome === 'reconciled' && reconciliation.updated) {
            recovered += 1
            console.log(`[Recovery] Job ${job.id} を running -> failed にリセット`)
          }
        }
      }
    }
  }

  return recovered
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
