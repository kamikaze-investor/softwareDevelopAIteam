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
