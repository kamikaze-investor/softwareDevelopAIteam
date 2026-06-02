import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

const ProjectStatusSchema = z.enum(['draft', 'running', 'paused', 'archived'])

const CreateProjectBody = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().min(1),
  designPhilosophy: z.array(z.string()).default([]),
  status: ProjectStatusSchema.default('draft'),
})

const UpdateProjectBody = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).optional(),
  designPhilosophy: z.array(z.string()).optional(),
  status: ProjectStatusSchema.optional(),
}).strict()

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.get('/', async (_req, reply) => {
    return reply.send(storage.projects.findAll())
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const project = storage.projects.findById(req.params.id)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    return reply.send(project)
  })

  app.post('/', async (req, reply) => {
    const result = CreateProjectBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const project = storage.projects.create(result.data)
    return reply.status(201).send(project)
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateProjectBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const updated = storage.projects.update(req.params.id, result.data)
    if (!updated) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    return reply.send(updated)
  })
}
