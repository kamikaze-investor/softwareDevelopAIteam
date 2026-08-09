import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import { ArchiveBlockedByRunningJobError, SingleRunningProjectError } from '../storage/sqlite'

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
  const singleRunningProjectResponse = { error: 'Another project is already running' }

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

    if (result.data.status === 'running' && storage.projects.findRunning()) {
      return reply.status(409).send(singleRunningProjectResponse)
    }

    try {
      const project = storage.projects.create(result.data)
      return reply.status(201).send(project)
    } catch (err: unknown) {
      if (err instanceof SingleRunningProjectError) {
        return reply.status(409).send(singleRunningProjectResponse)
      }
      throw err
    }
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateProjectBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const existing = storage.projects.findById(req.params.id)
    if (!existing) {
      return reply.status(404).send({ error: 'Project not found' })
    }

    if (existing.status === 'archived' && result.data.status === 'running') {
      return reply.status(409).send({ error: 'Cannot resume an archived project directly to running' })
    }

    if (result.data.status === 'running') {
      const running = storage.projects.findRunning()
      if (running && running.id !== req.params.id) {
        return reply.status(409).send(singleRunningProjectResponse)
      }
    }

    try {
      const updated = storage.projects.update(req.params.id, result.data)
      return reply.send(updated)
    } catch (err: unknown) {
      if (err instanceof SingleRunningProjectError) {
        return reply.status(409).send(singleRunningProjectResponse)
      }
      if (err instanceof ArchiveBlockedByRunningJobError) {
        return reply.status(409).send({ error: 'Cannot archive project while a Job is running' })
      }
      throw err
    }
  })
}
