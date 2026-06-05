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

import type { Job, Project, Task } from '@ai-team/shared'
import { runJob } from './jobRunner.js'

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000'
const POLL_INTERVAL_MS = readPollInterval()
const API_TOKEN = process.env.API_TOKEN

console.log('Worker starting...')
console.log(`API: ${API_BASE}, poll interval: ${POLL_INTERVAL_MS}ms`)

type JobUpdate = Partial<Pick<
  Job,
  | 'status'
  | 'startedAt'
  | 'completedAt'
  | 'exitCode'
  | 'stdout'
  | 'stderr'
  | 'changedFiles'
  | 'guardResult'
>>

async function fetchQueuedJob(): Promise<Job | null> {
  const projects = await fetchJson<Project[]>('/api/projects')
  if (!projects) return null

  for (const project of projects) {
    const tasks = await fetchJson<Task[]>(`/api/tasks?projectId=${encodeURIComponent(project.id)}`)
    if (!tasks) continue

    for (const task of tasks) {
      const jobs = await fetchJson<Job[]>(`/api/jobs?taskId=${encodeURIComponent(task.id)}`)
      if (!jobs) continue

      const queued = jobs.find((job) => job.status === 'queued')
      if (queued) return queued
    }
  }

  return null
}

async function updateJob(jobId: string, data: JobUpdate): Promise<void> {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })

  if (!res.ok) {
    throw new Error(`Failed to update job ${jobId}: ${res.status} ${res.statusText}`)
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders(),
  })

  if (!res.ok) return null
  return await res.json() as T
}

async function pollJobs(): Promise<never> {
  while (true) {
    try {
      const job = await fetchQueuedJob()
      if (job) {
        console.log(`[Worker] Job ${job.id} (${job.safeCommand.kind}) を実行します`)

        await updateJob(job.id, {
          status: 'running',
          startedAt: new Date().toISOString(),
        })

        const result = await runJob(job)

        await updateJob(job.id, {
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          changedFiles: result.changedFiles,
          completedAt: result.completedAt,
          guardResult: result.guardResult,
        })

        console.log(`[Worker] Job ${job.id}: ${result.status}`)
      }
    } catch (err: unknown) {
      console.error(`[Worker] ポーリングエラー: ${formatUnknownError(err)}`)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}
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

pollJobs()
