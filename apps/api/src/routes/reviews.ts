import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

const AgentRoleSchema = z.enum([
  'cto_ai', 'context_manager', 'developer_ai',
  'meta_reviewer', 'reviewer_ai', 'qa_ai',
])

const ReviewStatusSchema = z.enum(['approved', 'changes_requested', 'rejected'])
const FindingSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])

const ReviewFindingSchema = z.object({
  severity: FindingSeveritySchema,
  file: z.string().optional(),
  line: z.number().int().optional(),
  message: z.string().min(1),
  rule: z.string().optional(),
})

const CreateReviewResultBody = z.object({
  taskId: z.string().min(1),
  jobId: z.string().min(1),
  reviewer: AgentRoleSchema,
  status: ReviewStatusSchema,
  summary: z.string().default(''),
  findings: z.array(ReviewFindingSchema).default([]),
})

const QATypeSchema = z.enum(['typecheck', 'unit_test', 'build', 'lint', 'manual_check'])
const QAStatusSchema = z.enum(['passed', 'failed', 'skipped'])

const CreateQAResultBody = z.object({
  taskId: z.string().min(1),
  jobId: z.string().min(1),
  type: QATypeSchema,
  status: QAStatusSchema,
  summary: z.string().default(''),
  details: z.string().optional(),
})

const ListQuerySchema = z.object({
  taskId: z.string().min(1),
})

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  // GET /api/reviews?taskId=xxx
  app.get('/', async (req, reply) => {
    const query = ListQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'taskId is required' })
    }
    const task = storage.tasks.findById(query.data.taskId)
    if (!task) return reply.status(404).send({ error: 'Task not found' })
    return reply.send(storage.reviewResults.findByTaskId(query.data.taskId))
  })

  // GET /api/reviews/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = storage.reviewResults.findById(req.params.id)
    if (!result) return reply.status(404).send({ error: 'ReviewResult not found' })
    return reply.send(result)
  })

  // POST /api/reviews
  app.post('/', async (req, reply) => {
    const parsed = CreateReviewResultBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }
    const task = storage.tasks.findById(parsed.data.taskId)
    if (!task) return reply.status(404).send({ error: 'Task not found' })
    const result = storage.reviewResults.create(parsed.data)
    return reply.status(201).send(result)
  })
}

export async function qaRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  // GET /api/qa?taskId=xxx
  app.get('/', async (req, reply) => {
    const query = ListQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'taskId is required' })
    }
    const task = storage.tasks.findById(query.data.taskId)
    if (!task) return reply.status(404).send({ error: 'Task not found' })
    return reply.send(storage.qaResults.findByTaskId(query.data.taskId))
  })

  // GET /api/qa/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = storage.qaResults.findById(req.params.id)
    if (!result) return reply.status(404).send({ error: 'QAResult not found' })
    return reply.send(result)
  })

  // POST /api/qa
  app.post('/', async (req, reply) => {
    const parsed = CreateQAResultBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }
    const task = storage.tasks.findById(parsed.data.taskId)
    if (!task) return reply.status(404).send({ error: 'Task not found' })
    const result = storage.qaResults.create(parsed.data)
    return reply.status(201).send(result)
  })
}
