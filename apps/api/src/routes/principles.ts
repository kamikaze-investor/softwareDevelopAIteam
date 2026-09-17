import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PRINCIPLE_REVIEW_STAGES } from '@ai-team/shared'
import { getStorage } from '../storage'
import { buildPrincipleStats } from '../principles/ledger'

/**
 * 原則の適用・判定の集計を読む read-only route。
 *
 * **新しい metrics backend は無い**（CEO 指示 2026-09-17）。既存 SQLite への集計 SQL を
 * そのまま返すだけである。Dashboard も今回は作らない。
 *
 * 原則の**本文**はここから返さない。正本は Git（`specs/21_...md`）であり、
 * API 経由で本文を配ると第二の正本になる。返すのは id・版 hash・数値だけ。
 */

const StatsQuery = z.object({
  projectId: z.string().min(1).optional(),
  reviewStage: z.enum(PRINCIPLE_REVIEW_STAGES as unknown as [string, ...string[]]).optional(),
})

export async function principleRoutes(app: FastifyInstance): Promise<void> {
  const storage = (app as unknown as { storageOverride?: ReturnType<typeof getStorage> })
    .storageOverride ?? getStorage()

  // GET /api/principles/stats?projectId=&reviewStage=
  app.get('/principles/stats', async (req, reply) => {
    const parsed = StatsQuery.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid query', detail: parsed.error.flatten() })
    }

    const stats = buildPrincipleStats(storage, {
      projectId: parsed.data.projectId,
      reviewStage: parsed.data.reviewStage as never,
    })

    return reply.send(stats)
  })
}
