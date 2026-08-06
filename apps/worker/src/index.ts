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
import { assertTransition, recoverStaleJobs } from './jobStateManager.js'
import { runJob } from './jobRunner.js'
import { buildRuntimeTaskPolicy } from './guards/fileChangeGuard.js'
import { buildApiAuthHeaders } from './utils/apiAuth.js'
import { startWatchdog } from './watchdog/watchdog.js'

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000'
const POLL_INTERVAL_MS = readPollInterval()

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
  | 'stdoutPath'
  | 'stderrPath'
  | 'changedFiles'
  | 'commitHash'
  | 'guardResult'
>>

/** queued Job と、その Job が属する Task を一緒に返す（Task は実行時ポリシー構築に必須） */
interface QueuedWork {
  job: Job
  task: Task
}

async function fetchQueuedJob(): Promise<QueuedWork | null> {
  const projects = await fetchJson<Project[]>('/api/projects')
  if (!projects) return null

  for (const project of projects) {
    if (project.status !== 'running') continue

    const tasks = await fetchJson<Task[]>(`/api/tasks?projectId=${encodeURIComponent(project.id)}`)
    if (!tasks) continue

    for (const task of tasks) {
      const jobs = await fetchJson<Job[]>(`/api/jobs?taskId=${encodeURIComponent(task.id)}`)
      if (!jobs) continue

      const queued = jobs.find((job) => job.status === 'queued')
      if (queued) return { job: queued, task }
    }
  }

  return null
}

async function updateJob(jobId: string, data: JobUpdate): Promise<void> {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: {
      ...buildApiAuthHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })

  if (!res.ok) {
    throw new Error(`Failed to update job ${jobId}: ${res.status} ${res.statusText}`)
  }
}

export async function persistJobResult(
  jobId: string,
  result: Awaited<ReturnType<typeof runJob>>,
  resultStatus: Job['status'],
  writeJob: (id: string, data: JobUpdate) => Promise<void> = updateJob,
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
  }
  try {
    await writeJob(jobId, resultUpdate)
  } catch (err: unknown) {
    if (!result.commitHash) throw err

    // commit自体は再実行しない。最終結果保存だけが失敗した場合は、commitHashを伴う
    // technical failureとして最小更新を試み、手動照合が必要な状態をAPIへ残す。
    const reconciliationMessage =
      `Commit ${result.commitHash} was created, but the complete Job result could not be saved. ` +
      'Manual reconciliation is required; do not retry git_commit automatically.'
    await writeJob(jobId, {
      status: 'failed',
      exitCode: result.exitCode,
      stderr: reconciliationMessage,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
      commitHash: result.commitHash,
      completedAt: new Date().toISOString(),
      guardResult: result.guardResult,
    })
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: buildApiAuthHeaders(),
  })

  if (!res.ok) return null
  return await res.json() as T
}

async function pollJobs(): Promise<never> {
  while (true) {
    try {
      const work = await fetchQueuedJob()
      if (work) {
        const { job, task } = work
        console.log(`[Worker] Job ${job.id} (${job.safeCommand.kind}) を実行します`)

        // 実行時 Task ポリシーは AI 実行より前に構築する。
        // Task 取得失敗・Project 不一致・構築失敗のいずれでも runJob() を呼ばず failed にする
        // （allowedPaths / forbiddenPaths を適用できないまま AI を動かさない）。
        let policy
        try {
          if (task.projectId !== job.projectId) {
            throw new Error(
              `Task と Job の Project が一致しません: task.projectId=${task.projectId} job.projectId=${job.projectId}`,
            )
          }
          policy = buildRuntimeTaskPolicy(task)
        } catch (err: unknown) {
          const message = `実行時Taskポリシーを構築できないため実行しません: ${formatUnknownError(err)}`
          console.error(`[Worker] ${message}`)
          assertTransition(job.status, 'running')
          await updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })
          assertTransition('running', 'failed')
          await updateJob(job.id, {
            status: 'failed',
            stderr: message,
            completedAt: new Date().toISOString(),
          })
          await sleep(POLL_INTERVAL_MS)
          continue
        }

        assertTransition(job.status, 'running')
        await updateJob(job.id, {
          status: 'running',
          startedAt: new Date().toISOString(),
        })

        const result = await runJob(job, policy)
        const resultStatus = resolveResultStatus(result)

        assertTransition('running', resultStatus)
        await persistJobResult(job.id, result, resultStatus)

        console.log(`[Worker] Job ${job.id}: ${resultStatus}`)
      }
    } catch (err: unknown) {
      console.error(`[Worker] ポーリングエラー: ${formatUnknownError(err)}`)
    }

    await sleep(POLL_INTERVAL_MS)
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

async function start(): Promise<void> {
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
