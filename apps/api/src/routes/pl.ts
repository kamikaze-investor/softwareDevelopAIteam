/**
 * `POST /api/pl/tick` — PL 判断ループを 1 tick だけ進める。
 *
 * **新しい常駐 Agent を作らないための形**である。tick は「呼ばれたときに 1 回動く」だけで、
 * 起動元は VPS 上の API 自身（`PL_LOOP_ENABLED` の interval）でも、運用者の手動実行でもよい。
 * どちらの経路でも通るのは同じ 1 本の関数（`runPlTick()`）であり、実行権限の判断は
 * すべて `authorizePlAction()`（Mandatory Gate Policy）が行う。
 *
 * **GET にしない。** tick は状態を変えうる操作であり、既存の「GET は read-only」契約
 * （`continuation-get-liveness-dependency`）を壊さないために POST に置く。
 *
 * worker allowlist には載せない。Worker credential からは呼べず、admin token が要る。
 *
 * ---
 *
 * `GET /api/pl/triage-summary` — Blocked Resolution Triage の実績を既存 `audit_log` から集計する。
 *
 * **新しい metrics backend も新しい表も作らない。** 読むのは PL ループが既に書いている
 * `pl_loop` の audit 行だけで、副作用は無い（GET は read-only のままである）。
 * これが無いと「CEO へ上げた Blocked のうち、実は AI だけで解決できたものが何％か」を
 * VPS 上で確かめる手段が無く、効果検証可能性（Design Philosophy 8）を満たせない。
 */

import type { FastifyInstance } from 'fastify'
import { getStorage } from '../storage'
import { runPlTick } from '../pl/executionLoop'
import { summarizeBlockedTriage } from '../pl/blockedTriage'

export async function plRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.post('/pl/tick', async (_req, reply) => {
    const result = await runPlTick(storage)
    return reply.send(result)
  })

  app.get('/pl/triage-summary', async (_req, reply) => {
    return reply.send(summarizeBlockedTriage(storage.auditLog.findAll()))
  })
}
