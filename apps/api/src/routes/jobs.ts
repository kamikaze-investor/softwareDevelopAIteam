import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Job, SafeCommand } from '@ai-team/shared'
import { getStorage } from '../storage'

const AgentRoleSchema = z.enum([
  'cto_ai',
  'context_manager',
  'developer_ai',
  'meta_reviewer',
  'reviewer_ai',
  'qa_ai',
])

const JobStatusSchema = z.enum(['queued', 'running', 'success', 'failed', 'blocked'])

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

const SafeCommandParamsSchema = z.object({
  commitMessage: z.string().optional(),
  branchName: z.string().optional(),
  revertCommit: z.string().optional(),
  testPattern: z.string().optional(),
  agentPrefix: z.string().optional(),
}).strict()

const SafeCommandSchema: z.ZodType<SafeCommand> = z.object({
  kind: CommandKindSchema,
  params: SafeCommandParamsSchema.optional(),
  workingDir: z.string().min(1),
})

const CreateJobBody = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  agentRole: AgentRoleSchema,
  safeCommand: SafeCommandSchema,
  dryRun: z.boolean().optional(),
})

const UpdateJobBody = z.object({
  status: JobStatusSchema.optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  commitHash: z.string().optional(),
  rollbackInfo: z.object({
    previousCommitHash: z.string(),
    changedFiles: z.array(z.string()),
    rollbackArgv: z.array(z.string()),
  }).optional(),
  guardResult: z.object({
    permissionAllowed: z.boolean(),
    permissionReason: z.string().optional(),
    fileChangeAllowed: z.boolean(),
    fileViolations: z.array(z.string()).optional(),
  }).optional(),
  approvalId: z.string().optional(),
}).strict()

const ListQuerySchema = z.object({
  taskId: z.string().min(1),
})

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.get('/', async (req, reply) => {
    const query = ListQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'taskId is required' })
    }

    const task = storage.tasks.findById(query.data.taskId)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    return reply.send(storage.jobs.findByTaskId(query.data.taskId))
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const job = storage.jobs.findById(req.params.id)
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' })
    }
    return reply.send(job)
  })

  app.post('/', async (req, reply) => {
    const result = CreateJobBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const task = storage.tasks.findById(result.data.taskId)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    const jobInput: Omit<Job, 'id' | 'createdAt'> = {
      ...result.data,
      status: 'queued',
    }
    const job = storage.jobs.create(jobInput)
    return reply.status(201).send(job)
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateJobBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const updated = storage.jobs.update(req.params.id, result.data)
    if (!updated) {
      return reply.status(404).send({ error: 'Job not found' })
    }
    return reply.send(updated)
  })
}
