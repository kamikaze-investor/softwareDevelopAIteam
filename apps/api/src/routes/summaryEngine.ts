/**
 * Summary Engine API Routes（task-105）
 *
 * POST /api/summary/update
 *   Developer AI の実行結果を受け取り、
 *   target-project の docs/dashboard.md と tasks/task_graph.md を更新する。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { updateDashboard } from '../ctoAi/summaryEngine.js'

const UpdateBody = z.object({
  /** Developer AI の実行結果 */
  result: z.object({
    status: z.enum(['success', 'failed', 'blocked', 'mock']),
    taskId: z.string().min(1),
    provider: z.string().min(1),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    changedFiles: z.array(z.string()).default([]),
    exitCode: z.number().optional(),
    executedAt: z.string(),
    completedAt: z.string(),
    durationMs: z.number(),
  }),
  /** target-project のルートパス */
  targetProjectRoot: z.string().min(1),
})

export async function summaryEngineRoutes(app: FastifyInstance): Promise<void> {

  // POST /api/summary/update
  app.post('/update', async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const { result, targetProjectRoot } = parsed.data

    try {
      const summary = updateDashboard(result as any, targetProjectRoot)

      return reply.status(201).send({
        status: 'dashboard_updated',
        taskId: result.taskId,
        taskStatusUpdated: summary.taskStatusUpdated,
        entriesInDashboard: summary.entriesInDashboard,
        writtenFiles: [summary.dashboardPath],
        message: `Dashboard を更新しました（合計: ${summary.entriesInDashboard} エントリ）`,
      })
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Dashboard の更新に失敗しました',
        detail: err.message,
      })
    }
  })
}
