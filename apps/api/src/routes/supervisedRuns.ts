import type { FastifyInstance } from 'fastify'
import { getStorage } from '../storage'
import { reconcileSupervisedDelegations } from '../supervision/reconcile'

/**
 * supervised run の reconcile 起動口（Step 3）。
 *
 * **新しい daemon / scheduler は作らない。** 実行契機は Worker の既存 poll cycle であり、
 * この route はその1回分を受けるだけである。reconcile 本体が API 側にあるのは、
 * DB（durable な正本）と runDir の両方へ触れる必要があるためで、
 * Worker からは HTTP 1本で叩ける形にしてある。
 *
 * ここは **retry しない**。retry は `delegate-watchdog.sh` の責務であり、
 * Worker 側と二重化しない（CEO確定構造）。
 */
export async function supervisedRunRoutes(app: FastifyInstance): Promise<void> {
  const storage = (app as unknown as { storageOverride?: ReturnType<typeof getStorage> })
    .storageOverride ?? getStorage()

  // POST /api/supervised-runs/reconcile
  app.post('/supervised-runs/reconcile', async (_req, reply) => {
    try {
      const summary = await reconcileSupervisedDelegations(storage)
      return reply.status(200).send(summary)
    } catch (err) {
      // reconcile の失敗で Worker の poll cycle を壊さない。次の cycle で再試行される。
      app.log.error(
        { err },
        '[supervisedRuns] reconcile failed; the next Worker poll cycle will retry',
      )
      return reply.status(500).send({ error: 'reconcile failed' })
    }
  })
}
