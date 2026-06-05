import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

const TaskStatusSchema = z.enum(['pending', 'in_progress', 'review', 'done', 'blocked'])

const AgentRoleSchema = z.enum([
  'cto_ai',
  'context_manager',
  'developer_ai',
  'meta_reviewer',
  'reviewer_ai',
  'qa_ai',
])

const AiCliProviderSchema = z.enum(['claude_code', 'codex', 'gemini'])

const CreateTaskBody = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  status: TaskStatusSchema.default('pending'),
  assignee: AgentRoleSchema,
  provider: AiCliProviderSchema.optional(),
  dependencies: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).optional(),
  forbiddenPaths: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  expectedOutputs: z.array(z.string()).optional(),
})

const UpdateTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  status: TaskStatusSchema.optional(),
  assignee: AgentRoleSchema.optional(),
  provider: AiCliProviderSchema.optional(),
  dependencies: z.array(z.string()).optional(),
  allowedPaths: z.array(z.string()).optional(),
  forbiddenPaths: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  expectedOutputs: z.array(z.string()).optional(),
  branchName: z.string().optional(),
  commitHash: z.string().optional(),
}).strict()

const ListQuerySchema = z.object({
  projectId: z.string().min(1),
})

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.get('/', async (req, reply) => {
    const query = ListQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'projectId is required' })
    }

    const project = storage.projects.findById(query.data.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }

    return reply.send(storage.tasks.findByProjectId(query.data.projectId))
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const task = storage.tasks.findById(req.params.id)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }
    return reply.send(task)
  })

  app.post('/', async (req, reply) => {
    const result = CreateTaskBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const project = storage.projects.findById(result.data.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }

    const task = storage.tasks.create(result.data)
    return reply.status(201).send(task)
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateTaskBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const updated = storage.tasks.update(req.params.id, result.data)
    if (!updated) {
      return reply.status(404).send({ error: 'Task not found' })
    }
    return reply.send(updated)
  })
}
