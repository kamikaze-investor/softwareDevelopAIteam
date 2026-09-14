/**
 * `GET /api/state` — 横断 system state（PL の Observe の入口）。
 *
 * **read-only。副作用を一切持たない。** 既存の GET が read-only であるという契約
 * （`continuation-get-liveness-dependency` で確立）をここでも守る。
 * 権限判断もしない（必要 Gate の決定は `mandatory-gate-policy` の責務）。
 */

import type { FastifyInstance } from 'fastify'
import { getStorage } from '../storage'
import { buildSystemState } from '../state/systemState'

export async function systemStateRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.get('/state', async (_req, reply) => {
    return reply.send(buildSystemState(storage))
  })
}
