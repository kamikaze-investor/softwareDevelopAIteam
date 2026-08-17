import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  canonicalizeJobUpdate,
  type Job,
  type PersistedTaskFailureExplanationV1,
  type Task,
  type TaskFailureQuestionTurn,
} from '@ai-team/shared'
import { getStorage } from '../storage'
import {
  answerTaskFailureQuestion,
  buildTaskFailureExplanationViewModel,
  generateTaskFailureExplanation,
  type TaskFailureAiContext,
  type TaskFailureAiOptions,
  type TaskFailureJob,
} from '../taskFailureExplain/taskFailureAi'

export const TASK_FAILURE_EXPLANATION_INPUT_VERSION = 1 as const

type FailureExplanationPersistenceResult =
  | { ok: true; envelope: PersistedTaskFailureExplanationV1 }
  | { ok: false; error: string }
  | { retryWithCurrentFailure: true }

const inFlight = new Map<string, Promise<FailureExplanationPersistenceResult>>()

function runFailureExplanationSingleFlight(
  key: string,
  operation: () => Promise<FailureExplanationPersistenceResult>,
): Promise<FailureExplanationPersistenceResult> {
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key)
      }
    })
  inFlight.set(key, promise)
  return promise
}

export function computeFailureContentHash(context: TaskFailureAiContext): string {
  const canonicalInput = canonicalizeJobUpdate({
    inputVersion: TASK_FAILURE_EXPLANATION_INPUT_VERSION,
    task: {
      title: context.task.title,
      description: context.task.description,
    },
    job: {
      id: context.latestJob.id,
      status: context.latestJob.status,
      safeCommandKind: context.latestJob.safeCommand.kind,
      startedAt: context.latestJob.startedAt ?? null,
      completedAt: context.latestJob.completedAt ?? null,
      exitCode: context.latestJob.exitCode ?? null,
      stdout: context.latestJob.stdout ?? null,
      stderr: context.latestJob.stderr ?? null,
      changedFiles: context.latestJob.changedFiles ?? [],
      guardResult: context.latestJob.guardResult ?? null,
    },
  })
  return createHash('sha256').update(canonicalInput, 'utf8').digest('hex')
}

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
  description: z.string().max(50_000).default(''),
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

const ResumeTaskBody = z.object({
  instruction: z.string().trim().min(1).max(2000),
}).strict()

const TaskFailureQuestionBody = z.object({
  question: z.string().trim().min(1).max(2_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4_000),
  })).max(20).default([]),
})

export interface TaskRouteOptions {
  failureExplanationAiOptions?: TaskFailureAiOptions
  failureQuestionAiOptions?: TaskFailureAiOptions
}

function isTaskFailureJob(job: Job): job is TaskFailureJob {
  return job.status === 'failed' || job.status === 'blocked'
}

export function buildResumeAiCliPrompt(task: Pick<Task, 'title' | 'description'>, instruction: string): string {
  return `[Task] ${task.title}
${task.description}

[CEOからの追加指示]
${instruction}

[重要な注意]
却下された操作を変更せず繰り返さないこと。CEOの追加指示を反映した、異なる内容の変更を作成してください。`
}

// limit はここで厳密なnumber検証をせず、storage層のnormalizeSummaryLimit()に正規化を委ねる
// （0/負数/NaN/非数値文字列/100超過はいずれもそこで安全な値へfallback・clampされる）
const SummaryQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
  limit: z.string().optional(),
})

export async function taskRoutes(
  app: FastifyInstance,
  options: TaskRouteOptions = {},
): Promise<void> {
  const storage = getStorage()

  function resolveTaskFailureAiContext(task: Task): TaskFailureAiContext | null {
    const jobs = storage.jobs.findByTaskId(task.id)
    const latestJob = jobs[0]
    const shouldExplain = latestJob?.status === 'failed' || task.status === 'blocked'
    if (!shouldExplain) return null

    const targetJob = jobs.find(isTaskFailureJob)
    if (!targetJob) return null

    return { task, latestJob: targetJob, recentJobs: jobs }
  }

  app.get('/summary', async (req, reply) => {
    const query = SummaryQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'Validation failed', details: query.error.format() })
    }

    return reply.send(storage.tasks.findSummaries({
      projectId: query.data.projectId,
      status: query.data.status,
      // 不正値（NaN/0/負数/100超過）は normalizeSummaryLimit() 側で安全な値へfallback・clampされる
      limit: query.data.limit !== undefined ? Number(query.data.limit) : undefined,
    }))
  })

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

  app.post<{ Params: { id: string } }>('/:id/failure-explanation', async (req, reply) => {
    const task = storage.tasks.findById(req.params.id)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const currentTask = attempt === 0 ? task : storage.tasks.findById(task.id)
      const context = currentTask
        ? resolveTaskFailureAiContext(currentTask)
        : null
      if (!context) {
        return reply.send({
          ok: false,
          error: '説明対象の失敗・停止Jobが見つかりませんでした',
        })
      }

      const contentHash = computeFailureContentHash(context)
      const key = `${context.latestJob.id}:${contentHash}`
      const stored = storage.jobs.findFailureExplanation(context.latestJob.id)
      if (
        stored?.schemaVersion === 1 &&
        stored.inputVersion === TASK_FAILURE_EXPLANATION_INPUT_VERSION &&
        stored.contentHash === contentHash
      ) {
        return reply.send({
          ok: true,
          explanation: buildTaskFailureExplanationViewModel(
            stored.aiAnalysis,
            context,
            stored.generatedAt,
          ),
        })
      }

      const persisted = await runFailureExplanationSingleFlight(key, async () => {
        const generated = await generateTaskFailureExplanation(
          context,
          options.failureExplanationAiOptions,
        )
        if (!generated.ok) return generated

        const currentTaskAfterGeneration = storage.tasks.findById(task.id)
        const currentContext = currentTaskAfterGeneration
          ? resolveTaskFailureAiContext(currentTaskAfterGeneration)
          : null
        if (
          !currentContext ||
          currentContext.latestJob.id !== context.latestJob.id ||
          computeFailureContentHash(currentContext) !== contentHash
        ) {
          return { retryWithCurrentFailure: true }
        }

        const envelope: PersistedTaskFailureExplanationV1 = {
          schemaVersion: 1,
          inputVersion: TASK_FAILURE_EXPLANATION_INPUT_VERSION,
          contentHash,
          generatedAt: generated.explanation.generatedAt,
          aiAnalysis: generated.explanation.aiAnalysis,
        }
        storage.jobs.saveFailureExplanation(context.latestJob.id, envelope)
        return { ok: true, envelope }
      })

      if ('retryWithCurrentFailure' in persisted) continue
      if (!persisted.ok) {
        req.log.warn(
          { taskId: task.id, error: persisted.error },
          'Task failure explanation generation failed',
        )
        return reply.send({
          ok: false,
          error: 'AIによる分析を生成できませんでした',
        })
      }

      const latestTask = storage.tasks.findById(task.id)
      const latestContext = latestTask
        ? resolveTaskFailureAiContext(latestTask)
        : null
      if (
        !latestContext ||
        latestContext.latestJob.id !== context.latestJob.id ||
        computeFailureContentHash(latestContext) !== contentHash
      ) {
        continue
      }

      return reply.send({
        ok: true,
        explanation: buildTaskFailureExplanationViewModel(
          persisted.envelope.aiAnalysis,
          latestContext,
          persisted.envelope.generatedAt,
        ),
      })
    }

    return reply.send({
      ok: false,
      error: 'AIによる分析を生成できませんでした',
    })
  })

  app.post<{ Params: { id: string } }>('/:id/failure-ask', async (req, reply) => {
    const bodyResult = TaskFailureQuestionBody.safeParse(req.body)
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: bodyResult.error.format(),
      })
    }

    const task = storage.tasks.findById(req.params.id)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    const context = resolveTaskFailureAiContext(task)
    if (!context) {
      return reply.send({
        ok: false,
        error: '質問対象の失敗・停止Jobが見つかりませんでした',
      })
    }

    const generated = await answerTaskFailureQuestion(
      context,
      bodyResult.data.question,
      bodyResult.data.history as TaskFailureQuestionTurn[],
      options.failureQuestionAiOptions,
    )
    if (!generated.ok) {
      req.log.warn(
        { taskId: task.id, error: generated.error },
        'Task failure question generation failed',
      )
      return reply.send({
        ok: false,
        error: 'AIから回答を取得できませんでした',
      })
    }

    return reply.send(generated)
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
    if (project.status === 'archived') {
      return reply.status(409).send({ error: 'Project is archived' })
    }

    const task = storage.tasks.create(result.data)
    return reply.status(201).send(task)
  })

  app.post<{ Params: { id: string } }>('/:id/resume', async (req, reply) => {
    const result = ResumeTaskBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const task = storage.tasks.findById(req.params.id)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    const resumed = storage.jobs.resumeBlockedTask({
      taskId: task.id,
      instructionPrompt: buildResumeAiCliPrompt(task, result.data.instruction),
    })

    if (!resumed.ok) {
      if (resumed.code === 'DESIGN_REVIEW_PRECONDITION_FAILED') {
        return reply.status(409).send({
          error: 'Implement Job requires an aligned pre-implementation Design Review',
          reason: resumed.reason,
        })
      }
      return reply.status(400).send({ error: resumed.reason })
    }

    return reply.status(201).send(resumed.job)
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
