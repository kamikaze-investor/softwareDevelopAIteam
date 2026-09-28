import type { FastifyInstance } from 'fastify'
import { getStorage } from '../storage'
import { reconcileTaskContinuations } from '../ctoAi/taskContinuation'
import { recoverReadyTasksWithoutJob } from '../ctoAi/projectInitialization'
import { recoverTerminalRepairSuccessors } from '../designReview/terminalRepairSuccessorRecovery'

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
 *
 * **sweepはawaitせず即座に202を返す。** sweepは`createInitialImplementWorkflow()`経由で
 * design reviewを起動しうる（runner timeoutは既定120s）。これをHTTP応答に縛ると、
 * 呼び出し元であるWorkerのpoll cycleがその間Outbox再送にもqueued Job取得にも到達せず、
 * liveness driverであるはずのreconcileがJob intakeを止めてしまう（独立レビュー指摘 BLOCKING 1）。
 * 既存の`routes/jobs.ts`（`void ensureTaskContinuation(...)`）・
 * `routes/projects.ts`（`void retryPendingContinuationsForProject(...)`）と同じfire-and-forget形。
 */
export async function taskContinuationRoutes(app: FastifyInstance): Promise<void> {
  const storage = (app as unknown as { storageOverride?: ReturnType<typeof getStorage> })
    .storageOverride ?? getStorage()

  // 前回のsweepがまだ走っている間に次のpoll cycleが重ねて起動しないようにする。
  // POLL_INTERVAL_MS(5s) に対しdesign reviewは最大120sかかるため、guardが無いと
  // 同一continuationに対するsweepが数十本積み上がる（実害はunique indexで防がれるが、
  // 無駄なreview起動とlog noiseになる）。新しいqueueではなく、単なる同時実行の抑止。
  let sweepInFlight = false

  // POST /api/task-continuations/reconcile
  app.post('/task-continuations/reconcile', async (_req, reply) => {
    if (sweepInFlight) {
      return reply.status(202).send({ accepted: false, reason: 'sweep already in flight' })
    }
    sweepInFlight = true

    void reconcileTaskContinuations(storage)
      .then((summary) => {
        // 効果検証は既存のdurable state（task_continuations）とこの1行で行う。
        // 新しいaudit機構は追加しない。recovered=0を毎cycle出力すると
        // POLL_INTERVAL_MS(5s)ごとにログを埋めるため、**実際に状態が動いた時だけ**残す。
        if (summary.recovered > 0 || summary.failed > 0) {
          app.log.info({ ...summary, driver: 'worker_poll' }, '[taskContinuations] reconcile settled pending continuations')
        }
      })
      // **U7**: adopt 済みなのに初回 Job だけ無い Task を、同じ poll で復旧する。
      //
      // 責務は continuation とは別物なので `reconcileTaskContinuations()` の内側へは混ぜず、
      // sweep 本体は `projectInitialization.ts` に置いて**ここで並べて**呼ぶ。
      // 新しい endpoint も timer も作らないのは、Worker の poll が既にこの route を
      // 叩いており、それが唯一必要な driver だからである。
      // 上の `sweepInFlight` guard がそのまま全部を覆う（二重起動の抑止を作り直さない）。
      // continuation を先に流してから走らせる —— continuation が作った Task にも
      // 同じ cycle 内で初回 Job が付く。
      .then(() => recoverReadyTasksWithoutJob(storage))
      .then((recovery) => {
        if (recovery.recovered > 0) {
          app.log.info(
            { ...recovery, driver: 'worker_poll' },
            '[taskContinuations] recovered adopted tasks that had no initial job',
          )
        }
      })
      // **U2**: ALIGNED evidence を残した直後に落ちた repair run の successor を、同じ poll で
      // 回収する。review は再実行しない（module が `CoordinatorDeps` を持たない）。
      //
      // U7 と同じ形で**ここに並べる**理由も同じで、Worker の poll が既にこの route を叩いており、
      // それが唯一必要な driver だからである。上の `sweepInFlight` guard が 3 つ全部を覆う。
      // **chain の最後に置く。** U2 の候補は既に DB に在る terminal run で、前段がそれを
      // 生むことはない。先に置いても得が無く、後に置けば既存 2 つの latency を変えない。
      .then(() => recoverTerminalRepairSuccessors(storage))
      .then((recovery) => {
        // **failed も必ず出す。** 全候補が例外で落ちた sweep は正常終了扱いで外側の
        // `.catch` にも入らないため、これを条件に入れないと**繰り返す欠陥が無音になる**
        // （独立レビュー指摘・2026-09-25）。`recovered=0` を毎 cycle 出さない方針は維持する。
        if (recovery.recovered > 0 || recovery.escalated > 0 || recovery.failed > 0) {
          app.log.info(
            { ...recovery, driver: 'worker_poll' },
            '[taskContinuations] recovered repair successors for terminal aligned reviews',
          )
        }
      })
      .catch((err: unknown) => {
        // sweepの失敗でWorkerのpoll cycleを壊さない。次のcycleで再試行される。
        app.log.error({ err }, '[taskContinuations] reconcile failed; the next Worker poll cycle will retry')
      })
      .finally(() => {
        sweepInFlight = false
      })

    return reply.status(202).send({ accepted: true })
  })
}
