import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import type { Approval } from '@ai-team/shared'

type ApprovalWithProjectId = Approval & { projectId: string }

const ApprovalTypeSchema = z.enum([
  'goal_change',
  'philosophy_change',
  'external_service',
  'billing',
  'deployment',
  'security',
  'dependency_add',
])

const CreateApprovalBody = z.object({
  title: z.string().min(1),
  reason: z.string().min(1),
  type: ApprovalTypeSchema,
})

const UpdateApprovalBody = z.object({
  status: z.enum(['approved', 'rejected', 'expired']),
  reviewNote: z.string().optional(),
}).strict()

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.get('/approvals/pending', async (_req, reply) => {
    const pendingApprovals = storage.approvals.findAllPending() as ApprovalWithProjectId[]
    const projectNamesById = new Map(
      storage.projects.findAll().map((project) => [project.id, project.name]),
    )

    return reply.send(
      pendingApprovals.map((approval) => ({
        ...approval,
        projectName: projectNamesById.get(approval.projectId) ?? approval.projectId,
      })),
    )
  })

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/approvals', async (req, reply) => {
    const project = storage.projects.findById(req.params.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }

    return reply.send(storage.approvals.findPendingByProjectId(req.params.projectId))
  })

  app.post<{ Params: { projectId: string } }>('/projects/:projectId/approvals', async (req, reply) => {
    const project = storage.projects.findById(req.params.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }

    const result = CreateApprovalBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const approvalInput = {
      ...result.data,
      projectId: req.params.projectId,
      status: 'pending' as const,
    }
    const approval = storage.approvals.create(approvalInput)
    return reply.status(201).send(approval)
  })

  app.patch<{ Params: { id: string } }>('/approvals/:id', async (req, reply) => {
    const result = UpdateApprovalBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const updated = storage.approvals.update(req.params.id, {
      ...result.data,
      reviewedAt: new Date().toISOString(),
    })
    if (!updated) {
      return reply.status(404).send({ error: 'Approval not found' })
    }
    return reply.send(updated)
  })
}
