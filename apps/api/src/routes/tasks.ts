import { createHash } from 'node:crypto'
import { abortTask } from '../pl/abortTask'
import {
  HUMAN_RECOVERY_REASON_MAX_LENGTH,
  recoverBlockedTask,
} from '../humanRecovery/recoverBlockedTask'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  canonicalizeJobUpdate,
  type Job,
  type PersistedTaskFailureExplanationV1,
  type Task,
  type TaskDetail,
  type TaskFailureQuestionTurn,
} from '@ai-team/shared'
import { buildResumeAiCliPrompt } from '../implementPrompt'
import { authorizePlAction, PlActionBlockedError } from '../pl/actionGate'
import {
  blockedJobsReconcileRefusalReason,
  findBlockedJobsPreventingReconcile,
  TASK_HAS_BLOCKED_JOBS,
  verifyExternalCompletion,
} from '../reconcile/externalCompletion'
import { repairFromStoredReview } from '../designReview/repairFromStoredReview'
import { strandedLifecycleRefusal } from '../state/strandedTask'
import { getStorage } from '../storage'
import {
  answerTaskFailureQuestion,
  buildTaskFailureExplanationViewModel,
  generateTaskFailureExplanation,
  type TaskFailureAiContext,
  type TaskFailureAiOptions,
  type TaskFailureJob,
} from '../taskFailureExplain/taskFailureAi'
import type { CoordinatorDeps } from '../designReview/designReviewCoordinator'
import { classifyResumeActorFromRequest, humanTaskDecisionFacts } from '../designReview/resumeActor'
import {
  RESUME_DESIGN_REVIEW_FAILED,
  RESUME_DESIGN_REVIEW_PENDING,
  resumeBlockedTaskWithDesignReview,
} from '../designReview/resumeBlockedTask'

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

// 意図的に 'copilot' を含めない。@ai-team/shared の AiCliProvider 型には
// 存在するが、Task/Job実装用のプロバイダーとしてはまだ未対応
// （CopilotCliAdapter は implement モードを明示的に拒否する。現状の用途は
// Meta Review の quota枯渇時フォールバックのみ、apps/worker/src/metaReviewer/copilotRouter.ts）。
// 対応時はこのSchemaと同時に更新すること（2026-08-26 独立レビュー指摘: 型とAPI契約の不整合）。
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

/**
 * 汎用の作成・更新経路で `done` を拒否するときの応答（lifecycle repair W5）。
 * 完了は git_commit Job の完了経路か reconcile-external-completion だけが commit / audit と一緒に書く。
 */
const TASK_DONE_REFUSAL = {
  error:
    'A task cannot be marked done through this generic route. '
    + 'Completion is recorded by the git_commit job completion path, or by '
    + 'POST /api/tasks/:id/reconcile-external-completion for work completed outside the loop '
    + '(a task that still has blocked jobs must first be parked with abort_task, which observes the '
    + 'worktree and releases them, or be resumed)',
  code: 'TASK_DONE_USE_COMPLETION_ROUTE',
} as const

/**
 * lifecycle が所有する status（lifecycle repair C3）。
 *
 * `in_progress` / `review` / `blocked` は「Job・Design Review・失敗処理がこの Task を動かしている」ことを
 * 表す状態で、書き手は採用・review・失敗・resume・recovery の各 transaction だけである。
 * 汎用 CRUD がそれを書けると、Job も Design Review も無いのに Project を占有し（currentTask）、
 * attention も出口も無い Task を作れてしまう。汎用経路から**入る**遷移は拒否する。
 * 出る方向（`in_progress` / `review` → `pending`）は従来どおり汎用 PATCH が出口である
 * （`blocked` から出るのは recover / resume の担当。下の TASK_BLOCKED_USE_RECOVERY_ROUTE）。
 */
export const LIFECYCLE_OWNED_TASK_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'review', 'blocked'])

const TASK_LIFECYCLE_STATE_OWNED_REFUSAL = {
  error:
    'in_progress / review / blocked are owned by the task lifecycle (adoption, design review, job failure, '
    + 'resume and recovery) and cannot be set through this generic route. Create tasks as pending; '
    + 'a task that is stuck in in_progress / review without a live job can be moved back to pending here.',
  code: 'TASK_LIFECYCLE_STATE_OWNED',
} as const

/** blocked からの汎用経路での復帰を断る応答（code・文言は従来のまま）。 */
const TASK_BLOCKED_USE_RECOVERY_ROUTE_REFUSAL = {
  error:
    'A blocked task cannot be moved out of blocked through this generic route. '
    + 'Use POST /api/tasks/:id/recover (no job) or POST /api/tasks/:id/resume (has jobs), '
    + 'which audit the human reason and report what will drive the task next',
  code: 'TASK_BLOCKED_USE_RECOVERY_ROUTE',
} as const

const ListQuerySchema = z.object({
  projectId: z.string().min(1),
})

/**
 * 外部完了の申告。**すべて必須**で、空文字は通さない（記録が形骸化するため）。
 * `approvalRequestId` は既存 Approval 機構の承認レコード。Gate 側が APPROVED か照合する。
 */
const ReconcileExternalCompletionBody = z.object({
  approvalRequestId: z.string().min(1),
  sourceJobId: z.string().min(1),
  evidence: z.object({
    roadmapItemId: z.string().trim().min(1),
    commitSha: z.string().trim().min(7),
    pullRequestUrl: z.string().trim().min(1),
    independentReviewVerdict: z.string().trim().min(1),
    ciResult: z.string().trim().min(1),
    acceptanceEvidence: z.string().trim().min(1),
    approvedScope: z.string().trim().min(1),
  }).strict(),
}).strict()

const AbortTaskBody = z.object({
  approvalRequestId: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
}).strict()

const RepairFromStoredReviewBody = z.object({
  /** selector only. authorization ではない。 */
  reviewJobId: z.string().min(1),
})

const ResumeTaskBody = z.object({
  instruction: z.string().trim().min(1).max(2000),
}).strict()

const RecoverTaskBody = z.object({
  // **数字をここへ書かない。** 上限は Human Recovery 側の正本を参照する
  // （`HUMAN_RECOVERY_REASON_MAX_LENGTH`）。reason は短い監査理由であって
  // 実装指示ではないので、長い本文は 400 で**受理せず断る**（後から切らない）。
  reason: z.string().trim().min(1).max(HUMAN_RECOVERY_REASON_MAX_LENGTH),
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
  resumeDesignReviewDeps?: CoordinatorDeps
}

function isTaskFailureJob(job: Job): job is TaskFailureJob {
  return job.status === 'failed' || job.status === 'blocked'
}

export { buildResumeAiCliPrompt } from '../implementPrompt'

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
    // Mobile 側の表示条件（[id].tsx の shouldShow）と同一の述語であること。
    // 以前ここだけ `failed` のままで Mobile が `blocked` も表示するよう広がったため、
    // 「説明が表示されるのに API が対象なしを返す」乖離が起きた。既存の
    // isTaskFailureJob() を共有して二度と別々に書かないようにする。
    const shouldExplain = (latestJob !== undefined && isTaskFailureJob(latestJob))
      || task.status === 'blocked'
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

    // **各 Task に `parked` を載せる**（additive）。Worker は workspace 所有権の判定で shared の
    // `isStaleBlockedJobCandidate()` にこれを渡し、API の claim guard と同じ意味で
    // park された Task の stale blocked 行を扱う（lifecycle repair C2）。park 判定はここで再定義しない。
    return reply.send(storage.tasks.findByProjectId(query.data.projectId)
      .map((task) => ({ ...task, parked: storage.tasks.isParked(task.id) })))
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const task = storage.tasks.findById(req.params.id)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }
    // **Resume / Recover の前提判定に要る保存済みの事実を足す**（`TaskDetail`）。
    // Mobile はこれを共有の `evaluateResumeAdmission()` / `evaluateRecoverAdmission()` へ渡し、
    // API と同じ入力でボタンの表示を決める。park 判定・Project 状態をここで再定義しない。
    const detail: TaskDetail = {
      ...task,
      parked: storage.tasks.isParked(task.id),
      projectStatus: storage.projects.findById(task.projectId)?.status ?? null,
      // 生きた Task 単位の人の判断（approval_actor を付けて shared `liveTaskDecisionState()` が決める）。
      // Mobile は ApprovalRequest の生の status から authority を組み立て直さない（lifecycle repair C3）。
      humanTaskDecisions: humanTaskDecisionFacts(storage, task.id),
      repairDesignReviewInFlight: storage.tasks.hasRepairDesignReviewInFlight(task.id),
    }
    return reply.send(detail)
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

    // PATCH と同じ理由で、完了済みとして**作る**ことも許さない（根拠の無い done を作れる裏口になる）。
    if (result.data.status === 'done') {
      return reply.status(409).send(TASK_DONE_REFUSAL)
    }
    // 作成は `pending` だけ。lifecycle が所有する status で**作る**と、Job も Design Review も無い占有 Task になる。
    if (LIFECYCLE_OWNED_TASK_STATUSES.has(result.data.status)) {
      return reply.status(409).send(TASK_LIFECYCLE_STATE_OWNED_REFUSAL)
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

  /**
   * POST /:id/abort
   *
   * 未完了 Task を **done にせず** park する。Roadmap 項目の残作業は消えない
   * （再開は follow-up 採用の責務であり、ここでは Task を作らない）。
   * 必要 Gate は既存 `ACTION_GATE_TABLE` が決めており、`approval_gate` =
   * 対象 Task に紐づく APPROVED な ApprovalRequest、すなわち CEO の承認操作である。
   */
  app.post<{ Params: { id: string } }>('/:id/abort', async (req, reply) => {
    const parsed = AbortTaskBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const result = abortTask(storage, {
      taskId: req.params.id,
      approvalRequestId: parsed.data.approvalRequestId,
      reason: parsed.data.reason,
    })

    if (!result.ok) {
      const status = result.code === 'TASK_NOT_FOUND'
        ? 404
        : result.code === 'NOT_AUTHORIZED' ? 403 : 409
      return reply.status(status).send({ error: result.reason, code: result.code, details: result.details })
    }

    return reply.status(200).send(result)
  })

  /**
   * POST /:id/recover
   *
   * **Human Recovery** — Job を1件も持たないまま `blocked` で止まった Task を、
   * 人の明示操作で既存の実行ループへ戻す。`blocked` → `pending` の遷移と audit 記録だけを行い、
   * **Job も Review も Approval も作らない**。
   *
   * up-front の Approval Gate は課さない（CEO 決定・2026-09-18）。認証済み CEO の明示操作
   * そのものが human authorization であり、その先の fresh Design Review と既存下流 Gate は
   * すべて維持される。**AI/PL はこの経路を使えない**（`PL_ACTION_KINDS` に語彙が無く、
   * `WORKER_ALLOWLIST` にも載せておらず、`HUMAN_ONLY_ROUTES` により
   * **split credential mode の ADMIN でしか通らない**）。
   * 詳細は `humanRecovery/recoverBlockedTask.ts`。
   *
   * Job を持つ Task は対象外で、既存 `POST /:id/resume` が担当する。
   */
  app.post<{ Params: { id: string } }>('/:id/recover', async (req, reply) => {
    const parsed = RecoverTaskBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const result = recoverBlockedTask(storage, {
      taskId: req.params.id,
      reason: parsed.data.reason,
    })

    if (!result.ok) {
      const status = result.code === 'TASK_NOT_FOUND' ? 404 : 409
      return reply.status(status).send({ error: result.reason, code: result.code })
    }

    return reply.status(200).send(result)
  })

  /**
   * **保存済みレビューを canonical repair 経路へ戻す。**
   *
   * body は `reviewJobId` だけで、これは **selector** である。verdict / findings /
   * provider / status / allowedPaths / attempt 数 / actor class は受け取らない ——
   * すべて server 側で保存済み行から組み直す。authorization は consume 済み
   * ApprovalRequest であって、この route を呼べたことではない。
   *
   * `WORKER_ALLOWLIST` には載せない（split credential mode では Default Deny）。
   * `HUMAN_ONLY_ROUTES` にも載せない —— この操作の authorization は承認の consume であり、
   * route に到達できること自体ではない。`POST /:id/resume` と同じ扱いになる。
   */
  app.post<{ Params: { id: string } }>('/:id/repair-from-stored-review', async (req, reply) => {
    const body = RepairFromStoredReviewBody.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Validation failed', details: body.error.format() })
    }

    const outcome = repairFromStoredReview(storage, {
      taskId: req.params.id,
      reviewJobId: body.data.reviewJobId,
    })

    if (outcome.status === 'rejected') {
      const status = outcome.code === 'TASK_NOT_FOUND' ? 404 : 409
      return reply.status(status).send({ error: outcome.reason, code: outcome.code })
    }
    if (outcome.status === 'awaiting_approval') {
      return reply.status(202).send(outcome)
    }
    return reply.send(outcome)
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

    const instructionPrompt = buildResumeAiCliPrompt(task, result.data.instruction)
    // **誰が再開したかを、この request の credential だけから決める。**
    //
    // body は見ない。`{"human": true}` や `{"resetRepairBudget": true}` を送られても
    // `ResumeTaskBody` が落とすうえ、ここは request の認証結果しか読まない。
    // repair budget の generation 境界はこの記録だけを根拠にする（`../designReview/resumeActor`）。
    // 記録は storage が resume Job の作成と同じ transaction で書く（G-01）。
    const actor = classifyResumeActorFromRequest(req)
    const resumed = await resumeBlockedTaskWithDesignReview(storage, {
      task,
      instructionPrompt,
      resumedBy: { actorClass: actor.actorClass, evidence: actor.evidence },
      ...(options.resumeDesignReviewDeps !== undefined
        ? { coordinatorDeps: options.resumeDesignReviewDeps }
        : {}),
    })

    // 判定がまだ出ていないだけ。否定ではないので 409 にせず、同じ instruction の再送で
    // 同じ queued run が再開されることを示す（503 + retryable）。
    if (!resumed.ok && resumed.code === RESUME_DESIGN_REVIEW_PENDING) {
      return reply.status(503).send({ error: resumed.reason, code: resumed.code, retryable: true })
    }

    // authority evidence が書けず resume ごと rollback された（何も変わっていない）。再送してよい。
    if (!resumed.ok && resumed.code === 'RESUME_COMMIT_FAILED') {
      return reply.status(503).send({ error: resumed.reason, code: resumed.code, retryable: true })
    }

    if (!resumed.ok && resumed.code === RESUME_DESIGN_REVIEW_FAILED) {
      return reply.status(409).send({
        error: 'Resume instruction did not pass the pre-implementation Design Review',
        code: resumed.code,
        reason: resumed.reviewError,
      })
    }

    if (!resumed.ok) {
      // **409 は必ず stable な code を添える。** Mobile と PL が reason 文字列で分岐しないため。
      // done の Task と running でない Project は request の不備ではなく状態の衝突なので 409
      // （b8d0fc5d 監査）。他の既存の拒否は status を変えず、code だけを足す。
      if (
        resumed.code === 'WORKSPACE_QUARANTINED'
        || resumed.code === 'TASK_DONE'
        || resumed.code === 'PROJECT_NOT_RUNNING'
        || resumed.code === 'HUMAN_DECISION_PENDING'
        || resumed.code === 'REPAIR_REVIEW_IN_FLIGHT'
        || resumed.code === 'RESUME_TARGET_CHANGED'
      ) {
        return reply.status(409).send({ error: resumed.reason, code: resumed.code })
      }
      // **却下済み commit の出所を特定できなかったのは request の不備ではなく状態の問題**なので
      // 400 ではなく 409 を返す。code を添えるのは、呼び出し側が
      // 「retry すれば直る」と誤解しないようにするためである（fail-closed であり、
      // 探索を広げて自動復旧させることは意図的にしていない）。
      if (
        resumed.code === 'REJECTED_COMMIT_SOURCE_UNRESOLVED'
        || resumed.code === 'GIT_COMMIT_RESUME_LINEAGE_INVALID'
      ) {
        return reply.status(409).send({ error: resumed.reason, code: resumed.code })
      }
      return reply.status(400).send({
        error: resumed.reason,
        ...(resumed.code === undefined ? {} : { code: resumed.code }),
      })
    }

    return reply.status(201).send(resumed.job)
  })

  /**
   * POST /:id/reconcile-external-completion
   *
   * Candidate 以外（Tier B 外部実装）で正式に完了した成果を Task completion へ戻す。
   *
   * **この操作は実装をしない。** protected file を書く権限も Safety Boundary を動かす権限も
   * 与えない。既に canonical master へ入り production へ出ている成果を、既存の completion
   * transition で Task state へ反映するだけである（CEO 指示・2026-09-15）。
   *
   * 順序は **根拠の機械検証 → Mandatory Gate → 既存 completion transition**。
   * 呼び出し側の自己申告だけでは done にならない。
   */
  app.post<{ Params: { id: string } }>('/:id/reconcile-external-completion', async (req, reply) => {
    const parsed = ReconcileExternalCompletionBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const task = storage.tasks.findById(req.params.id)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    // 1) 根拠。repository と DB で確かめられるものはここで確かめる（fail-closed）。
    const verification = verifyExternalCompletion(storage, task.id, parsed.data.evidence)
    if (!verification.ok) {
      return reply.status(422).send({ error: verification.reason })
    }

    // blocked Job が残る Task は取り込まない（storage の transaction でも同じ関数で再確認する）。
    // Gate より前に断るのは、断られる操作のために承認を評価・消費させないため。
    const blockedJobs = findBlockedJobsPreventingReconcile(storage, task.id)
    if (blockedJobs.length > 0) {
      return reply.status(409).send({
        code: TASK_HAS_BLOCKED_JOBS,
        error: blockedJobsReconcileRefusalReason(blockedJobs),
      })
    }

    // 2) Mandatory Gate。**Task completion を起こす正式操作なので必ず通す。**
    //    充足の根拠は seam が DB の実レコードで検証する（Gate 名の文字列では通らない）。
    try {
      authorizePlAction(storage, {
        proposal: { kind: 'reconcile_external_completion' },
        target: { kind: 'task', taskId: task.id },
        evidence: [{ gate: 'approval_gate', approvalRequestId: parsed.data.approvalRequestId }],
      })
    } catch (error: unknown) {
      if (error instanceof PlActionBlockedError) {
        return reply.status(403).send({ error: error.message })
      }
      throw error
    }

    // 3) 既存 completion transition。新しい完了経路は作っていない。
    const reconciled = storage.jobs.reconcileExternalCompletion({
      taskId: task.id,
      sourceJobId: parsed.data.sourceJobId,
    })
    if (!reconciled.ok) {
      if (reconciled.code === 'TASK_HAS_BLOCKED_JOBS') {
        return reply.status(409).send({ code: reconciled.code, error: reconciled.reason })
      }
      return reply.status(reconciled.code === 'ALREADY_DONE' ? 409 : 400).send({ error: reconciled.reason })
    }

    // 4) 根拠を残す。機械照合できなかった項目も含めてそのまま監査へ載せる。
    storage.auditLog.record({
      actor: 'api',
      operation: 'reconcile_external_completion',
      entityType: 'task',
      entityId: task.id,
      result: 'done',
      detail: JSON.stringify({
        ...parsed.data.evidence,
        sourceJobId: parsed.data.sourceJobId,
        approvalRequestId: parsed.data.approvalRequestId,
        verifiedChangedFiles: verification.verified.changedFiles,
        verifiedAgainstStableHead: verification.verified.stableHead,
      }).slice(0, 4000),
    })

    return reply.send({ task: reconciled.task, continuation: reconciled.continuation })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateTaskBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    // **完了をこの汎用経路で付けさせない。**
    //
    // `tasks.update()` は commit も continuation も audit も伴わずに `done` を書けてしまい、
    // done は blocked Job の attention 抑止や workspace 所有の判断にも使われるため、
    // 根拠の無い完了が後続の停止を見えなくする（lifecycle repair W5）。完了は
    // git_commit Job の完了経路か `POST /api/tasks/:id/reconcile-external-completion` に限る。
    if (result.data.status === 'done') {
      return reply.status(409).send(TASK_DONE_REFUSAL)
    }

    // **park された Task を、この汎用経路から占有状態へ戻さない。**
    //
    // `in_progress` と `blocked` は `occupiesProject()` が `roadmapActive` に関係なく
    // 占有と数える status である。park した Task をここで動かすと park は事実上取り消され、
    // しかも `resumeBlockedTask()` は park を理由に拒否するので誰も解消できなくなる。
    // park の解除は CEO の判断であり、汎用 PATCH の副作用として起きてよいものではない。
    if (
      (result.data.status === 'in_progress' || result.data.status === 'blocked')
      && storage.tasks.isParked(req.params.id)
    ) {
      return reply.status(409).send({
        error: 'Task was parked by abort_task; it cannot be moved back into an occupying status',
        code: 'TASK_PARKED',
      })
    }

    // **lifecycle が所有する status へ、この汎用経路から入らせない**（lifecycle repair C3）。
    // 同じ status のままの PATCH（title 等の編集に status を添えたもの）は遷移ではないので通す。
    if (result.data.status !== undefined && LIFECYCLE_OWNED_TASK_STATUSES.has(result.data.status)) {
      const current = storage.tasks.findById(req.params.id)
      if (!current) {
        return reply.status(404).send({ error: 'Task not found' })
      }
      if (current.status !== result.data.status) {
        return reply.status(409).send(TASK_LIFECYCLE_STATE_OWNED_REFUSAL)
      }
    }

    // **blocked からの復帰をこの汎用経路で行わせない。**
    //
    // `blocked` → `pending` は「止まった Task を自律ループへ戻す」意味を持つ遷移である。
    // ここを素通しにすると、同じ遷移が **audit を1行も残さずに**できてしまう
    // （`tasks.update()` は audit_log を書かない）。だから復旧は
    // `POST /api/tasks/:id/recover` に集約する。あちらは
    //
    //   - 人が書いた理由を audit へ残す
    //   - 自動側の既存 bounded budget（`PL_MAX_REMEDIATION_ATTEMPTS` 等）を reset しない
    //   - 戻した後に何が動くかを `nextDriver` で返す
    //
    // **Human Recovery 自体の試行回数を bound するからではない。** そのような lifetime
    // 上限・ordinal・counter は存在しない（CEO 決定・2026-09-18。エピソードの識別には
    // 既存 audit 行の id を使う）。Job を持つ Task は従来どおり `/resume` の担当である。
    //
    // 制限するのは blocked から**出る**方向だけで、他の status 遷移は従来どおりである。
    // `pending` への PATCH はこの事前読みを使わず、下の transaction が最新の status で同じ code を返す
    // （/recover が直前に pending へ戻した Task に古い 409 を返して編集を落とさない。Codex review 348c22a）。
    if (result.data.status !== undefined && result.data.status !== 'blocked' && result.data.status !== 'pending') {
      const current = storage.tasks.findById(req.params.id)
      if (current?.status === 'blocked') {
        return reply.status(409).send(TASK_BLOCKED_USE_RECOVERY_ROUTE_REFUSAL)
      }
    }

    // **lifecycle が所有する status（in_progress / review）から出る遷移は、stranded のときだけ通す**
    // （lifecycle repair C3）。Job / Design Review / 人の判断がまだ Task を動かしているのに pending へ戻すと、
    // driver が走っている間に Project の占有が外れる。判定は stranded attention と同じ唯一の述語
    // （`strandedLifecycleRefusal`）を、書き込みと同じ storage transaction の中で呼び直す。
    //
    // **明示的な `status: 'pending'` はすべてこの 1 transaction を通す**（Codex review 2d8f060）。transaction の外で
    // 読んだ status で経路を選ぶと、その後に driver 付きの in_progress になった Task や done になった Task へ
    // pending を直接書けてしまう。判定は transaction 内で読み直した最新の status だけで行う:
    //   - pending → 遷移ではないので通す（他の欄の編集は従来どおり）
    //   - blocked → 409 TASK_BLOCKED_USE_RECOVERY_ROUTE（/recover・/resume の担当。上の事前読みと同じ code）
    //   - in_progress / review → stranded のときだけ通す。**park 済みでも通す**: park 状態は task_aborted
    //     audit から推定され status に DB 制約は無いので、park された in_progress / review の legacy 行があり得る。
    //     abort / resume / recover はどれも park された Task を断るので、ここも断ると Project を占有したまま
    //     出口が無い。park の audit と roadmapActive=false はそのまま残す（Codex review 348c22a）。
    //   - それ以外（done 等）→ 断る（完了の取り消しはこの経路の担当ではない）
    if (result.data.status === 'pending') {
      let latestWasBlocked = false
      const released = storage.tasks.updateIfAdmitted(req.params.id, result.data, (latest) => {
        if (latest.status === 'pending') return undefined
        if (latest.status === 'blocked') {
          latestWasBlocked = true
          return 'task is blocked'
        }
        if (latest.status === 'in_progress' || latest.status === 'review') {
          return strandedLifecycleRefusal(storage, latest)
        }
        return `task is ${latest.status}; only a stranded in_progress / review task can be moved back to pending here`
      })
      if (!released.ok) {
        if (released.code === 'TASK_NOT_FOUND') return reply.status(404).send({ error: 'Task not found' })
        if (latestWasBlocked) return reply.status(409).send(TASK_BLOCKED_USE_RECOVERY_ROUTE_REFUSAL)
        return reply.status(409).send({
          ...TASK_LIFECYCLE_STATE_OWNED_REFUSAL,
          error: `The task cannot be moved back to pending through this generic route: ${released.reason}`,
          reason: released.reason,
        })
      }
      return reply.send(released.task)
    }

    const updated = storage.tasks.update(req.params.id, result.data)
    if (!updated) {
      return reply.status(404).send({ error: 'Task not found' })
    }
    return reply.send(updated)
  })
}
