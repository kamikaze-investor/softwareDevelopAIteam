/**
 * Context Manager API Routes（task-103）
 *
 * POST /api/context-pack
 *   タスク情報 + targetProjectRoot を受け取り、Context Pack を返す。
 *   Developer AI はこの Context Pack を元に実装を行う。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { buildContextPack } from '../ctoAi/contextManager.js'
import { validateTargetRoot, validateAllowedPaths } from '../utils/pathGuard.js'

const TaskSummarySchema = z.object({
  id: z.string().regex(/^task-\d+$/),
  title: z.string().min(1),
  description: z.string(),
  phase: z.number().int().min(1),
  assignee: z.enum(['cto_ai', 'context_manager', 'developer_ai', 'reviewer_ai', 'qa_ai']),
  dependencies: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(['small', 'medium', 'large']),
})

const ContextPackBody = z.object({
  task: TaskSummarySchema,
  /** target-project のルートパス（絶対パス） */
  targetProjectRoot: z.string().min(1),
})

export async function contextPackRoutes(app: FastifyInstance): Promise<void> {

  // POST /api/context-pack
  app.post('/', async (req, reply) => {
    const parsed = ContextPackBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const { task, targetProjectRoot } = parsed.data

    // [codex-review P1] パス境界検証
    const rootCheck = validateTargetRoot(targetProjectRoot)
    if (!rootCheck.ok) {
      return reply.status(400).send({ error: 'パス検証エラー', detail: rootCheck.reason })
    }
    const pathsCheck = validateAllowedPaths(task.allowedPaths, targetProjectRoot)
    if (!pathsCheck.ok) {
      return reply.status(400).send({ error: 'allowedPaths 検証エラー', detail: pathsCheck.reason })
    }

    try {
      const pack = buildContextPack(task as any, targetProjectRoot)

      return reply.status(201).send({
        status: 'context_pack_ready',
        taskId: task.id,
        relevantFileCount: pack.relevantFiles.length,
        hasProjectMemory: !!pack.projectMemory.goal,
        pack,
        message: `Context Pack 生成完了（ファイル数: ${pack.relevantFiles.length}）`,
      })
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Context Pack の生成に失敗しました',
        detail: err.message,
      })
    }
  })
}
