import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

const AgentRoleSchema = z.enum([
  'cto_ai',
  'context_manager',
  'developer_ai',
  'meta_reviewer',
  'reviewer_ai',
  'qa_ai',
])

const GrantScopeSchema = z.enum(['once', 'task', 'permanent'])

const CommandKindSchema = z.enum([
  'git_status',
  'git_diff',
  'git_log',
  'git_branch_create',
  'git_checkout',
  'git_commit',
  'git_revert',
  'typecheck',
  'test',
  'build',
  'lint',
])

const CreateGrantBody = z.object({
  taskId: z.string().optional(),
  jobId: z.string().optional(),
  allowedCommandKinds: z.array(CommandKindSchema).optional(),
  agentRole: AgentRoleSchema,
  scope: GrantScopeSchema,
  expiresAt: z.string().optional(),
  reason: z.string().optional(),
})

export async function permissionGrantRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  // POST /api/permission-grants — グラントを作成
  app.post('/permission-grants', async (req, reply) => {
    const result = CreateGrantBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const grant = storage.permissionGrants.create({
      ...result.data,
      used: false,
    })
    return reply.status(201).send(grant)
  })

  // GET /api/permission-grants?taskId=xxx — タスクのアクティブグラント一覧
  app.get<{ Querystring: { taskId?: string } }>('/permission-grants', async (req, reply) => {
    const { taskId } = req.query
    if (!taskId) {
      return reply.status(400).send({ error: 'taskId query parameter is required' })
    }

    const grants = storage.permissionGrants.findActiveByTaskId(taskId)
    return reply.send(grants)
  })

  // DELETE /api/permission-grants/:id — グラント削除
  app.delete<{ Params: { id: string } }>('/permission-grants/:id', async (req, reply) => {
    const deleted = storage.permissionGrants.delete(req.params.id)
    if (!deleted) {
      return reply.status(404).send({ error: 'Permission grant not found' })
    }
    return reply.status(204).send()
  })

  // PATCH /api/permission-grants/:id/use — once スコープ使用済みマーク
  app.patch<{ Params: { id: string } }>('/permission-grants/:id/use', async (req, reply) => {
    const grant = storage.permissionGrants.markUsed(req.params.id)
    if (!grant) {
      return reply.status(404).send({ error: 'Permission grant not found' })
    }
    return reply.send(grant)
  })
}
