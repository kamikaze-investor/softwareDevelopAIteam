import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalizeJobUpdate, type Job } from '@ai-team/shared'
import { getStorage } from '../storage'
import { TARGET_WORKING_DIR } from '../config/targetWorkingDir'
import type { OutboxEventInput } from '../storage/interface'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'

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

/**
 * クライアント入力用の SafeCommand schema。
 *
 * `workingDir` はクライアントから受け取らない（MVP-Aでは単一Repository固定のため
 * サーバー側で `TARGET_WORKING_DIR` を設定する）。`.strict()` により、
 * クライアントが `workingDir` を含めて送信した場合は不明なキーとして 400 で拒否する。
 */
const SafeCommandInputSchema = z.object({
  kind: CommandKindSchema,
  params: SafeCommandParamsSchema.optional(),
}).strict()

const AiCliProviderSchema = z.enum(['claude_code', 'codex', 'gemini'])
const AiCliModeSchema = z.enum(['implement', 'review', 'qa', 'summarize'])
const ReviewStatusSchema = z.enum(['approved', 'changes_requested', 'rejected'])
const FindingSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
const StructuredReviewResultSchema = z.object({
  status: ReviewStatusSchema,
  summary: z.string(),
  findings: z.array(z.object({
    severity: FindingSeveritySchema,
    file: z.string().optional(),
    line: z.number().optional(),
    message: z.string().min(1),
    rule: z.string().optional(),
  }).strict()),
}).strict()

const CreateJobBody = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  agentRole: AgentRoleSchema,
  safeCommand: SafeCommandInputSchema,
  dryRun: z.boolean().optional(),
  aiCliProvider: AiCliProviderSchema.optional(),
  aiCliPrompt: z.string().max(50_000).optional(),
  aiCliMode: AiCliModeSchema.optional(),
}).strict().refine(
  (d) => {
    const hasProvider = d.aiCliProvider !== undefined
    const hasPrompt = d.aiCliPrompt !== undefined
    const hasMode = d.aiCliMode !== undefined
    if (!hasProvider && !hasPrompt && !hasMode) return true
    if (d.aiCliMode === 'review') return hasProvider && !hasPrompt
    return hasProvider && hasPrompt && hasMode
  },
  { message: 'review JobはaiCliPromptを受け取らず、その他のAI CLI Jobはprovider/prompt/modeをすべて指定してください' },
)

const UpdateJobBody = z.object({
  eventId: z.string().min(1).optional(),
  payloadHash: z.string().min(1).optional(),
  status: JobStatusSchema.optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  stdoutPath: z.string().optional(),
  stderrPath: z.string().optional(),
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
  failureMetadata: z.object({
    kind: z.string().optional(),
    workspaceState: z.enum(['unchanged', 'changed', 'unknown']).optional(),
  }).strict().optional(),
  reviewResult: StructuredReviewResultSchema.optional(),
}).strict()

const FailIfRunningJobBody = z.object({
  stderr: z.string(),
  completedAt: z.string(),
}).strict()

const ListQuerySchema = z.object({
  taskId: z.string().min(1),
})

function calculatePayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalizeJobUpdate(payload))
    .digest('hex')
}

function buildOutboxEvent(
  eventId: string | undefined,
  requestPayloadHash: string | undefined,
  payload: Record<string, unknown>,
): { ok: true; outboxEvent?: OutboxEventInput } | { ok: false; statusCode: 400 | 409; error: string } {
  const hasEventId = eventId !== undefined
  const hasPayloadHash = requestPayloadHash !== undefined
  if (hasEventId !== hasPayloadHash) {
    return {
      ok: false,
      statusCode: 400,
      error: 'eventId and payloadHash must either both be specified or both be omitted',
    }
  }
  if (!eventId || !requestPayloadHash) {
    return { ok: true }
  }

  const computedPayloadHash = calculatePayloadHash(payload)
  if (computedPayloadHash !== requestPayloadHash) {
    return {
      ok: false,
      statusCode: 409,
      error: 'Outbox payload hash mismatch',
    }
  }

  return { ok: true, outboxEvent: { eventId, payloadHash: computedPayloadHash } }
}

function outboxResponse(job: Job, outboxEvent: OutboxEventInput | undefined, deduplicated: boolean): Job | (Job & { outbox: { eventId: string; deduplicated: boolean } }) {
  if (!outboxEvent) return job
  return {
    ...job,
    outbox: {
      eventId: outboxEvent.eventId,
      deduplicated,
    },
  }
}

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

    const project = storage.projects.findById(task.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    if (project.status === 'archived') {
      return reply.status(409).send({ error: 'Project is archived' })
    }

    const designReviewCheck = checkImplementJobDesignReviewEvidence(result.data, storage.designReviewEvidence)
    if (!designReviewCheck.ok) {
      return reply.status(409).send({
        error: 'Implement Job requires an aligned pre-implementation Design Review',
        code: designReviewCheck.code,
        reason: designReviewCheck.reason,
      })
    }

    const jobInput: Omit<Job, 'id' | 'createdAt'> = {
      ...result.data,
      // workingDir はクライアントから受け取らない。MVP-Aの正規workingDirをここで設定する。
      safeCommand: { ...result.data.safeCommand, workingDir: TARGET_WORKING_DIR },
      status: 'queued',
    }
    const job = storage.jobs.create(jobInput)
    return reply.status(201).send(job)
  })

  app.patch<{ Params: { id: string } }>('/:id/fail-if-running', async (req, reply) => {
    const result = FailIfRunningJobBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const transition = storage.jobs.failIfRunning(req.params.id, result.data)
    if (!transition.ok) {
      return reply.status(404).send({ error: 'Job not found' })
    }

    return reply.send({
      updated: transition.updated,
      currentStatus: transition.currentStatus,
      job: transition.job,
    })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateJobBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const { eventId, payloadHash, reviewResult, ...jobUpdate } = result.data
    const outboxPayload = reviewResult === undefined
      ? jobUpdate
      : { ...jobUpdate, reviewResult }
    const outboxCheck = buildOutboxEvent(eventId, payloadHash, outboxPayload)
    if (!outboxCheck.ok) {
      return reply.status(outboxCheck.statusCode).send({ error: outboxCheck.error })
    }
    const { outboxEvent } = outboxCheck

    const existing = storage.jobs.findById(req.params.id)
    if (!existing) {
      return reply.status(404).send({ error: 'Job not found' })
    }

    const isReviewJob = existing.aiCliMode === 'review'
    if (reviewResult && !isReviewJob) {
      return reply.status(400).send({ error: 'Structured review results are only accepted for review Jobs' })
    }

    const isImplementRequeue =
      existing.aiCliMode === 'implement' &&
      existing.status !== 'queued' &&
      jobUpdate.status === 'queued'
    if (isImplementRequeue) {
      const designReviewCheck = checkImplementJobDesignReviewEvidence(existing, storage.designReviewEvidence)
      if (!designReviewCheck.ok) {
        return reply.status(409).send({
          error: 'Implement Job requires an aligned pre-implementation Design Review',
          code: designReviewCheck.code,
          reason: designReviewCheck.reason,
        })
      }
    }

    const isProviderTimeoutFailure =
      jobUpdate.status === 'failed' &&
      jobUpdate.failureMetadata?.kind === 'provider_timeout' &&
      jobUpdate.failureMetadata.workspaceState === 'unchanged' &&
      existing.aiCliMode === 'implement' &&
      existing.workflowStepKey?.startsWith('retry:') !== true
    const isProviderTimeoutRetryCandidate =
      existing.status === 'running' &&
      isProviderTimeoutFailure
    if (isProviderTimeoutRetryCandidate) {
      const persisted = storage.jobs.persistProviderTimeoutFailure({
        jobId: existing.id,
        update: jobUpdate,
        outboxEvent,
      })
      if (!persisted.ok) {
        if (persisted.code === 'OUTBOX_HASH_MISMATCH') {
          return reply.status(409).send({ error: persisted.reason })
        }
        return reply.status(persisted.code === 'JOB_NOT_FOUND' ? 404 : 500).send({ error: persisted.reason })
      }
      return reply.send(outboxResponse(persisted.job, outboxEvent, persisted.deduplicated))
    }
    const isAutomaticReviewJob =
      existing.workflowStepKey?.startsWith('implement:') === true &&
      existing.workflowStepKey.endsWith(':review') &&
      isReviewJob

    if (reviewResult) {
      const approved = reviewResult.status === 'approved' && jobUpdate.status === 'success'
      const normalizedUpdate: Partial<Job> = {
        ...jobUpdate,
        status: approved ? 'success' : 'failed',
      }
      const task = storage.tasks.findById(existing.taskId)
      if (!task) {
        return reply.status(500).send({ error: 'Review Job Task not found' })
      }
      const persisted = storage.jobs.persistReviewWorkflowResult({
        jobId: existing.id,
        update: normalizedUpdate,
        reviewResult,
        nextJob: approved && isAutomaticReviewJob ? {
          taskId: existing.taskId,
          projectId: existing.projectId,
          workflowStepKey: `review:${existing.id}:git-commit`,
          agentRole: 'developer_ai',
          status: 'queued',
          safeCommand: {
            kind: 'git_commit',
            params: { commitMessage: task.title },
            workingDir: TARGET_WORKING_DIR,
          },
        } : undefined,
        outboxEvent,
      })
      if (!persisted.ok) {
        if (persisted.code === 'OUTBOX_HASH_MISMATCH') {
          return reply.status(409).send({ error: persisted.reason })
        }
        req.log.error({ code: persisted.code, reason: persisted.reason }, 'Failed to persist structured review')
        return reply.status(500).send({ error: 'Failed to persist structured review' })
      }
      return reply.send(outboxResponse(persisted.job, outboxEvent, persisted.deduplicated === true))
    }

    if (isReviewJob && jobUpdate.status === 'success') {
      const failedUpdate: Partial<Job> = {
        ...jobUpdate,
        status: 'failed',
        stderr: jobUpdate.stderr ?? 'Structured review result is missing (fail-closed)',
      }
      if (outboxEvent) {
        const failed = storage.jobs.updateWithOutboxEvent(existing.id, failedUpdate, outboxEvent)
        if (!failed.ok) {
          if (failed.code === 'OUTBOX_HASH_MISMATCH') {
            return reply.status(409).send({ error: failed.reason })
          }
          return reply.status(failed.code === 'JOB_NOT_FOUND' ? 404 : 500).send({ error: failed.reason })
        }
        return reply.send(outboxResponse(failed.job, outboxEvent, failed.deduplicated))
      }

      const failed = storage.jobs.update(existing.id, failedUpdate)
      return reply.send(failed)
    }

    const isInitialImplementWorkflowJob =
      existing.workflowStepKey === `task:${existing.taskId}:initial-implement` &&
      existing.aiCliMode === 'implement'
    const shouldCreateReview =
      isInitialImplementWorkflowJob &&
      existing.safeCommand.kind === 'test' &&
      jobUpdate.status === 'success' &&
      jobUpdate.exitCode === 0 &&
      (jobUpdate.changedFiles?.length ?? 0) > 0 &&
      jobUpdate.guardResult?.permissionAllowed === true &&
      jobUpdate.guardResult.fileChangeAllowed === true

    if (shouldCreateReview) {
      const transition = storage.jobs.updateAndCreateNextWorkflowJob({
        jobId: existing.id,
        update: jobUpdate,
        nextJob: {
          taskId: existing.taskId,
          projectId: existing.projectId,
          workflowStepKey: `implement:${existing.id}:review`,
          agentRole: 'qa_ai',
          status: 'queued',
          safeCommand: { kind: 'git_status', workingDir: TARGET_WORKING_DIR },
          aiCliProvider: existing.aiCliProvider ?? 'claude_code',
          aiCliMode: 'review',
        },
        outboxEvent,
      })
      if (!transition.ok) {
        if (transition.code === 'OUTBOX_HASH_MISMATCH') {
          return reply.status(409).send({ error: transition.reason })
        }
        req.log.error({ code: transition.code, reason: transition.reason }, 'Failed to advance Job workflow')
        return reply.status(500).send({ error: 'Failed to advance Job workflow' })
      }
      return reply.send(outboxResponse(transition.job, outboxEvent, transition.deduplicated === true))
    }

    if (outboxEvent) {
      const updated = storage.jobs.updateWithOutboxEvent(req.params.id, jobUpdate, outboxEvent)
      if (!updated.ok) {
        if (updated.code === 'OUTBOX_HASH_MISMATCH') {
          return reply.status(409).send({ error: updated.reason })
        }
        return reply.status(updated.code === 'JOB_NOT_FOUND' ? 404 : 500).send({ error: updated.reason })
      }
      return reply.send(outboxResponse(updated.job, outboxEvent, updated.deduplicated))
    }

    const updated = storage.jobs.update(req.params.id, jobUpdate)
    if (!updated) {
      return reply.status(404).send({ error: 'Job not found' })
    }
    return reply.send(updated)
  })
}
