/**
 * Task Watchdog — 実行中 Job のスタル監視
 *
 * 定期的に API から running Job を取得し、スタル閾値超過を検出する。
 * スタル検出時は Gemini に分析を依頼し、結果を WatchdogEvent として API に記録する。
 */

import type { Job, Project, Task } from '@ai-team/shared'
import { checkStall } from './stallDetector.js'
import { callGeminiWithFallback } from '../metaReviewer/geminiRouter.js'

const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? 30_000)

/** 既にアラート済みの jobId を保持（重複通知防止） */
const alertedJobs = new Set<string>()

export async function startWatchdog(apiBaseUrl: string, headers: Record<string, string> = {}): Promise<void> {
  console.log(`[Watchdog] 起動: チェック間隔 ${WATCHDOG_INTERVAL_MS}ms`)
  while (true) {
    await sleep(WATCHDOG_INTERVAL_MS)
    try {
      await checkRunningJobs(apiBaseUrl, headers)
    } catch (err) {
      console.error(`[Watchdog] エラー: ${formatError(err)}`)
    }
  }
}

async function checkRunningJobs(apiBaseUrl: string, headers: Record<string, string>): Promise<void> {
  const projects = await fetchJson<Project[]>('/api/projects', apiBaseUrl, headers)
  if (!projects) return

  for (const project of projects) {
    const tasks = await fetchJson<Task[]>(
      `/api/tasks?projectId=${encodeURIComponent(project.id)}`,
      apiBaseUrl, headers,
    )
    if (!tasks) continue

    for (const task of tasks) {
      const jobs = await fetchJson<Job[]>(
        `/api/jobs?taskId=${encodeURIComponent(task.id)}`,
        apiBaseUrl, headers,
      )
      if (!jobs) continue

      for (const job of jobs) {
        if (job.status !== 'running' || !job.startedAt) continue
        if (alertedJobs.has(job.id)) continue

        const stall = checkStall(job.safeCommand.kind, job.startedAt)
        if (!stall.isStalled) continue

        alertedJobs.add(job.id)
        console.warn(
          `[Watchdog] スタル検出: Job ${job.id} (${job.safeCommand.kind}) ` +
          `${Math.round(stall.stallDurationMs / 1000)}s 経過 ` +
          `(閾値: ${Math.round(stall.thresholdMs / 1000)}s)`
        )

        // 非同期で AI 分析を開始（ウォッチドッグループをブロックしない）
        void analyzeAndReport(job, stall.stallDurationMs, apiBaseUrl, headers)
      }
    }
  }

  // 完了済み Job のアラート記録をクリア（メモリリーク防止）
  cleanupAlertedJobs(projects, apiBaseUrl, headers)
}

async function analyzeAndReport(
  job: Job,
  stallDurationMs: number,
  apiBaseUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  const detectedAt = new Date().toISOString()

  // WatchdogEvent を 'analyzing' 状態で作成
  const event = await postJson('/api/watchdog-events', {
    jobId: job.id,
    taskId: job.taskId,
    commandKind: job.safeCommand.kind,
    workingDir: job.safeCommand.workingDir,
    startedAt: job.startedAt,
    detectedAt,
    stallDurationMs,
    status: 'analyzing',
  }, apiBaseUrl, headers)

  if (!event) {
    console.error(`[Watchdog] WatchdogEvent の作成に失敗: Job ${job.id}`)
    return
  }

  // Gemini でスタル分析
  let aiAnalysis = ''
  let isStuck = true
  try {
    const prompt = buildStallAnalysisPrompt(job, stallDurationMs)
    const raw = await callGeminiWithFallback(prompt, {
      preferCli: false,
      apiModel: 'gemini-3.1-flash-lite',
      cliModel: 'gemini-3.1-flash-lite',
      featureName: 'watchdog_analysis',
    })
    const parsed = parseStallAnalysis(raw)
    aiAnalysis = parsed.reason
    isStuck = parsed.isStuck
  } catch (err) {
    aiAnalysis = `AI分析エラー: ${formatError(err)}`
    isStuck = true
  }

  const newStatus = isStuck ? 'confirmed' : 'false_alarm'
  await patchJson(`/api/watchdog-events/${event.id}`, {
    status: newStatus,
    aiAnalysis,
    isStuck,
  }, apiBaseUrl, headers)

  if (isStuck) {
    console.warn(
      `[Watchdog] ⚠️ スタル確認: Job ${job.id} (${job.safeCommand.kind})\n` +
      `  分析: ${aiAnalysis}`
    )
  } else {
    console.log(
      `[Watchdog] 誤検知: Job ${job.id} は低速なだけ\n` +
      `  分析: ${aiAnalysis}`
    )
  }
}

function buildStallAnalysisPrompt(job: Job, stallDurationMs: number): string {
  const minutes = Math.round(stallDurationMs / 60_000 * 10) / 10
  return `あなたは開発システムの監視 AI です。
以下の Job が応答なしで実行中です。本当にスタック（無限ループ・デッドロック・I/O待ちなど）しているか、それとも単に時間がかかっているだけか分析してください。

Job 情報:
- コマンド種別: ${job.safeCommand.kind}
- 作業ディレクトリ: ${job.safeCommand.workingDir}
- 実行開始: ${job.startedAt}
- 経過時間: ${minutes} 分

次の JSON だけを返してください（説明文不要）:
{"isStuck": true/false, "reason": "50文字以内の理由"}`
}

function parseStallAnalysis(raw: string): { isStuck: boolean; reason: string } {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('JSON not found')
    const parsed = JSON.parse(match[0])
    return {
      isStuck: Boolean(parsed.isStuck),
      reason: String(parsed.reason ?? ''),
    }
  } catch {
    return { isStuck: true, reason: raw.trim().slice(0, 100) || '解析失敗' }
  }
}

async function cleanupAlertedJobs(
  projects: Project[],
  apiBaseUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  if (alertedJobs.size === 0) return

  for (const project of projects) {
    const tasks = await fetchJson<Task[]>(
      `/api/tasks?projectId=${encodeURIComponent(project.id)}`,
      apiBaseUrl, headers,
    )
    if (!tasks) continue

    for (const task of tasks) {
      const jobs = await fetchJson<Job[]>(
        `/api/jobs?taskId=${encodeURIComponent(task.id)}`,
        apiBaseUrl, headers,
      )
      if (!jobs) continue

      for (const job of jobs) {
        if (alertedJobs.has(job.id) && job.status !== 'running') {
          alertedJobs.delete(job.id)
        }
      }
    }
  }
}

async function fetchJson<T>(path: string, apiBaseUrl: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(`${apiBaseUrl}${path}`, { headers })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

async function postJson(path: string, body: unknown, apiBaseUrl: string, headers: Record<string, string>): Promise<any> {
  try {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function patchJson(path: string, body: unknown, apiBaseUrl: string, headers: Record<string, string>): Promise<void> {
  try {
    await fetch(`${apiBaseUrl}${path}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // ベストエフォート
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
