import type { FastifyInstance } from 'fastify'
import type { ProjectRoadmapCompletion, Task } from '@ai-team/shared'
import { z } from 'zod'
import { initializeApprovedProject } from '../ctoAi/projectInitialization'
import { ensureTaskContinuation } from '../ctoAi/taskContinuation'
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

function getRoadmapCompletion(tasks: Task[]): ProjectRoadmapCompletion {
  const activeTasks = tasks.filter((task) => task.roadmapActive)
  const completedTaskCount = activeTasks.filter((task) => task.status === 'done').length

  return {
    completedTaskCount,
    isComplete: activeTasks.length > 0 && completedTaskCount === activeTasks.length,
    totalTaskCount: activeTasks.length,
  }
}

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

  // GET /api/projects/:id/roadmap — 現行Roadmap（roadmapActive=trueのPhaseのみ）
  // 消えたPhaseの履歴はDBにroadmapActive=falseで残るが、「現在のRoadmap」を返す本エンドポイントでは除外する
  app.get<{ Params: { id: string } }>('/:id/roadmap', async (req, reply) => {
    const project = storage.projects.findById(req.params.id)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    const activePhases = storage.projectRoadmapPhases
      .findByProjectId(req.params.id)
      .filter((phase) => phase.roadmapActive)
    const completion = getRoadmapCompletion(storage.tasks.findByProjectId(req.params.id))
    return reply.send({ phases: activePhases, completion })
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
      if (!updated) {
        return reply.status(404).send({ error: 'Project not found' })
      }

      // `running` は既存UIの「開始」承認後状態。Roadmapが未作成の場合だけ、既存の
      // Roadmap→Task→初回Implement Job処理を起動する。既に同期済みのProjectは再生成しない。
      const hasActiveRoadmap = storage.tasks
        .findByProjectId(updated.id)
        .some((task) => task.roadmapActive)
      if (updated.status === 'running' && !hasActiveRoadmap) {
        await initializeApprovedProject(storage, updated, process.env.TARGET_ROOT ?? '/workspace/target', {
          writeProjectMemory: true,
        })
      } else if (updated.status === 'running' && hasActiveRoadmap) {
        // Resuming an already-initialized Project: retry any Task continuation left
        // 'pending' while paused (see initialImplementWorkflow.ts's retryable pause skip
        // and jobs.ts's matching ack-without-503 branch). Reuses the existing
        // task_continuations row and ensureTaskContinuation() -- no new Gate/Queue/daemon.
        for (const continuation of storage.taskContinuations.findPendingByProjectId(updated.id)) {
          void ensureTaskContinuation(storage, continuation.id)
            .catch((error: unknown) => req.log.error(
              { err: error, continuationId: continuation.id },
              'task continuation retry on resume failed',
            ))
        }
      }

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
