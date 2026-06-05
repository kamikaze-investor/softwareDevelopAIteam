/**
 * Job 状態遷移マネージャー
 *
 * FSM（有限状態機械）で Job のステータス遷移を管理する。
 * 不正な遷移を防ぎ、Worker 異常終了後の復旧を担う。
 */

import type { Job, JobStatus, Project, Task } from '@ai-team/shared'

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
          await updateStaleJob(apiBaseUrl, headers, job.id)
          recovered += 1
          console.log(`[Recovery] Job ${job.id} を running -> failed にリセット`)
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

async function updateStaleJob(
  apiBaseUrl: string,
  headers: Record<string, string>,
  jobId: string
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'failed',
      stderr: '[Worker] 前回の Worker が異常終了したため failed にリセットしました',
      completedAt: new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    throw new Error(`Failed to recover stale job ${jobId}: ${res.status} ${res.statusText}`)
  }
}
