import type { FastifyInstance } from 'fastify'
import { getStorage } from '../storage'
import { reconcileTaskContinuations } from '../ctoAi/taskContinuation'

/**
 * Task continuation reconcileの起動口。
 *
 * **新しいdaemon/scheduler/queueは作らない。** 実行契機はWorkerの既存poll cycleであり、
 * このrouteはその1回分を受けるだけである。`/api/supervised-runs/reconcile`とは
 * **意図的に分離**している（責務が別物であり、片方の失敗でもう片方を巻き込まないため）。
 *
 * これが解決する問題: commit成功時に次Projectがpausedだと`PATCH /api/jobs/:id`は
 * 200 ACKを返し、Worker Outbox行が消える（routes/jobs.ts）。その結果continuationは
 * 'pending'のまま残るが、再試行経路がMobileの`GET /api/projects`系しか無かった。
 * client（Mobile）を閉じたままでは次Taskへ進めない、というliveness依存である。
 */
export async function taskContinuationRoutes(app: FastifyInstance): Promise<void> {
  const storage = (app as unknown as { storageOverride?: ReturnType<typeof getStorage> })
    .storageOverride ?? getStorage()

  // POST /api/task-continuations/reconcile
  app.post('/task-continuations/reconcile', async (_req, reply) => {
    try {
      const summary = await reconcileTaskContinuations(storage)
      // 効果検証は既存のdurable state（task_continuations）＋この1行で行う。
      // 新しいaudit機構は追加しない。recovered=0を毎cycle出力すると
      // POLL_INTERVAL_MS(5s)ごとにログを埋めるため、**実際に回収した時だけ**残す。
      if (summary.recovered > 0 || summary.failed > 0) {
        app.log.info({ ...summary, driver: 'worker_poll' }, '[taskContinuations] reconcile settled pending continuations')
      }
      return reply.status(200).send(summary)
    } catch (err) {
      // reconcileの失敗でWorkerのpoll cycleを壊さない。次のcycleで再試行される。
      app.log.error({ err }, '[taskContinuations] reconcile failed; the next Worker poll cycle will retry')
      return reply.status(500).send({ error: 'reconcile failed' })
    }
  })
}
