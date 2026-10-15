import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import type { IStorage } from '../storage/interface'
import { buildSystemState } from '../state/systemState'
import { readLatestDesignReview, summarizeBlockedTriage } from '../pl/blockedTriage'
import { getRoadmapCompletion } from './projects'
import {
  projectApprovalRequest,
  projectJob,
  projectLatestDesignReview,
  projectQaResult,
  projectReviewResult,
  projectSystemState,
  projectTask,
  projectTaskSummary,
} from '../operator/projection'

/**
 * Operator 向け safe read — `/api/operator/*`。
 *
 * **新しいデータ源は作らない。** 既存の storage / `buildSystemState()` / `summarizeBlockedTriage()` を
 * そのまま読み、`operator/projection.ts` の field allowlist で削って返すだけである。
 *
 * なぜ既存 GET を使わないか: `/api/jobs` 等は stdout / stderr / aiCliPrompt / パスを
 * そのまま返し、Mobile と Worker がそれに依存している。既存 GET の応答を変えずに外部へ
 * 安全な形を出すには、projection を掛けた別の read 口が要る。
 *
 * すべて GET で、副作用を持たない（DB へ書かない・LLM を呼ばない）。
 */

const TaskListQuery = z.object({
  projectId: z.string().min(1).optional(),
  status: z.enum(['pending', 'in_progress', 'review', 'done', 'blocked']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** Task 詳細に載せる Job の件数（新しい順）。 */
const TASK_DETAIL_JOBS_MAX = 20

export async function operatorReadRoutes(app: FastifyInstance): Promise<void> {
  const storage: IStorage = (app as unknown as { storageOverride?: IStorage }).storageOverride ?? getStorage()

  app.get('/operator/state', async (_req, reply) => {
    return reply.send(projectSystemState(buildSystemState(storage)))
  })

  app.get<{ Params: { id: string } }>('/operator/projects/:id', async (req, reply) => {
    const project = storage.projects.findById(req.params.id)
    if (!project) return reply.status(404).send({ error: 'Project not found' })
    const phases = storage.projectRoadmapPhases
      .findByProjectId(project.id)
      .filter((phase) => phase.roadmapActive)
      .map((phase) => ({ phaseNumber: phase.phaseNumber, name: phase.name, goal: phase.goal }))
    return reply.send({
      id: project.id,
      name: project.name,
      status: project.status,
      goal: project.goal,
      roadmap: {
        phases,
        completion: getRoadmapCompletion(storage.tasks.findByProjectId(project.id)),
      },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })
  })

  app.get('/operator/tasks', async (req, reply) => {
    const parsed = TaskListQuery.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }
    const { projectId, status, limit } = parsed.data
    return reply.send(
      storage.tasks
        .findSummaries({ limit, ...(projectId !== undefined ? { projectId } : {}), ...(status !== undefined ? { status } : {}) })
        .map(projectTaskSummary),
    )
  })

  app.get<{ Params: { id: string } }>('/operator/tasks/:id', async (req, reply) => {
    const task = storage.tasks.findById(req.params.id)
    if (!task) return reply.status(404).send({ error: 'Task not found' })
    const jobs = storage.jobs.findByTaskId(task.id)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return reply.send({
      task: projectTask(task),
      jobs: jobs.slice(0, TASK_DETAIL_JOBS_MAX).map(projectJob),
      jobCount: jobs.length,
      approvalRequests: storage.approvalRequests.findByTaskId(task.id).map(projectApprovalRequest),
      latestDesignReview: projectLatestDesignReview(readLatestDesignReview(storage, task.id)),
      reviews: storage.reviewResults.findByTaskId(task.id).map(projectReviewResult),
      qa: storage.qaResults.findByTaskId(task.id).map(projectQaResult),
    })
  })

  app.get('/operator/pl/triage-summary', async (_req, reply) => {
    // 集計値だけ（件数・割合）。audit 行そのものは返さない。
    return reply.send(summarizeBlockedTriage(storage.auditLog.findAll()))
  })
}
