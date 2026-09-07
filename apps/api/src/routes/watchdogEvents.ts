import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

const WatchdogStatusSchema = z.enum([
  'detected',
  'analyzing',
  'confirmed',
  'false_alarm',
  'resolved',
])

const CreateEventBody = z.object({
  jobId: z.string(),
  taskId: z.string(),
  commandKind: z.string(),
  workingDir: z.string(),
  startedAt: z.string(),
  detectedAt: z.string(),
  stallDurationMs: z.number(),
  status: WatchdogStatusSchema.optional(),
})

const UpdateEventBody = z.object({
  status: WatchdogStatusSchema.optional(),
  aiAnalysis: z.string().optional(),
  isStuck: z.boolean().optional(),
  resolvedAt: z.string().optional(),
})

export async function watchdogEventRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/watchdog-events — 全件取得（jobId クエリで任意フィルタ）
  app.get<{ Querystring: { jobId?: string } }>('/watchdog-events', async (req) => {
    const storage = getStorage()
    const { jobId } = req.query
    if (jobId) return storage.watchdogEvents.findByJobId(jobId)
    return storage.watchdogEvents.findAll()
  })

  // POST /api/watchdog-events — イベント作成（Worker → API）
  app.post('/watchdog-events', async (req, reply) => {
    const body = CreateEventBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message })
    }
    const storage = getStorage()
    // DB-007: 同じ stall episode `(jobId, startedAt)` の再 POST は新しい行を作らない。
    // Worker が restart しても、event 作成を retry しても、記録は1件に保たれる。
    // 既存があれば 200（作成していない）、新規なら 201 を返し、呼び出し元が区別できるようにする。
    const existing = storage.watchdogEvents.findByEpisode(body.data.jobId, body.data.startedAt)
    if (existing) return reply.status(200).send(existing)

    const event = storage.watchdogEvents.create({
      ...body.data,
      commandKind: body.data.commandKind as any,
      status: body.data.status ?? 'detected',
    })
    return reply.status(201).send(event)
  })

  // GET /api/watchdog-events/:id — 単件取得
  app.get<{ Params: { id: string } }>('/watchdog-events/:id', async (req, reply) => {
    const storage = getStorage()
    const event = storage.watchdogEvents.findById(req.params.id)
    if (!event) return reply.status(404).send({ error: 'Not found' })
    return event
  })

  // PATCH /api/watchdog-events/:id — status/AI分析結果を更新
  app.patch<{ Params: { id: string } }>('/watchdog-events/:id', async (req, reply) => {
    const body = UpdateEventBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message })
    }
    const storage = getStorage()
    const updated = storage.watchdogEvents.update(req.params.id, body.data)
    if (!updated) return reply.status(404).send({ error: 'Not found' })
    return updated
  })
}
