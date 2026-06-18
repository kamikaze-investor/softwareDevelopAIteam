/**
 * ダッシュボード集計API
 *
 * スマホのブラウザで開発チームの状況をひと目で把握できる集計サマリーを返す。
 */

import type { FastifyInstance } from 'fastify'
import { getStorage } from '../storage'

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', async () => {
    const storage = getStorage()

    const projects = storage.projects.findAll()
    const projectSummaries = projects.map((project) => {
      const tasks = storage.tasks.findByProjectId(project.id)

      const taskStats = {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === 'pending').length,
        in_progress: tasks.filter((t) => t.status === 'in_progress').length,
        review: tasks.filter((t) => t.status === 'review').length,
        done: tasks.filter((t) => t.status === 'done').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
      }

      const allJobs = tasks.flatMap((t) => storage.jobs.findByTaskId(t.id))
      const jobStats = {
        total: allJobs.length,
        queued: allJobs.filter((j) => j.status === 'queued').length,
        running: allJobs.filter((j) => j.status === 'running').length,
        success: allJobs.filter((j) => j.status === 'success').length,
        failed: allJobs.filter((j) => j.status === 'failed').length,
        blocked: allJobs.filter((j) => j.status === 'blocked').length,
      }

      return {
        id: project.id,
        name: project.name,
        status: project.status,
        tasks: taskStats,
        jobs: jobStats,
      }
    })

    // Watchdog サマリー
    const watchdogEvents = storage.watchdogEvents.findAll()
    const watchdogStats = {
      total: watchdogEvents.length,
      confirmed: watchdogEvents.filter((e) => e.status === 'confirmed').length,
      false_alarm: watchdogEvents.filter((e) => e.status === 'false_alarm').length,
      analyzing: watchdogEvents.filter((e) => e.status === 'analyzing').length,
      resolved: watchdogEvents.filter((e) => e.status === 'resolved').length,
      // 直近 24h の confirmed（未解決）
      recentConfirmed: watchdogEvents.filter((e) => {
        if (e.status !== 'confirmed') return false
        const age = Date.now() - new Date(e.detectedAt).getTime()
        return age < 86_400_000
      }),
    }

    // 直近の running Job
    const allRunningJobs = projects.flatMap((p) => {
      const tasks = storage.tasks.findByProjectId(p.id)
      return tasks.flatMap((t) =>
        storage.jobs.findByTaskId(t.id).filter((j) => j.status === 'running').map((j) => ({
          jobId: j.id,
          taskId: j.taskId,
          projectId: j.projectId,
          commandKind: j.safeCommand.kind,
          startedAt: j.startedAt,
          workingDir: j.safeCommand.workingDir,
        }))
      )
    })

    return {
      generatedAt: new Date().toISOString(),
      projects: projectSummaries,
      watchdog: watchdogStats,
      runningJobs: allRunningJobs,
    }
  })
}
