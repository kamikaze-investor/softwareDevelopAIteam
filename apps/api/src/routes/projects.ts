import type { FastifyInstance } from 'fastify'
import type { ProjectRoadmapCompletion, Task } from '@ai-team/shared'
import { z } from 'zod'
import { analyzeProjectDefinition } from '../ctoAi/projectDefinitionAnalysis'
import { initializeApprovedProject } from '../ctoAi/projectInitialization'
import { retryPendingContinuationsForProject } from '../ctoAi/taskContinuation'
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
  /**
   * 前回のPATCHが返した重要Gap（`gaps[].description`）への回答。key: description、
   * value: 回答本文。次回のGap Analysisへ追加文脈として渡すだけで、Gap自体の照合には
   * 使わない（LLMの言い回しが毎回同じとは限らないため、"回答を渡して再解析し、
   * 重要Gapが残っていないか"を都度確認する設計にしている）。
   */
  gapAnswers: z.record(z.string(), z.string()).optional(),
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

  // Retries any Task continuation still 'pending' for a running Project. Fire-and-forget:
  // never blocks or fails the GET it rides on. This -- not this specific PATCH transition --
  // is what guarantees a continuation left 'pending' by a failed resume-time attempt is not
  // stranded forever: Mobile already polls both routes below continuously (usePolling), so
  // each poll tick is another retry opportunity, matching the same "piggyback on an existing
  // poll cycle instead of adding a new one" pattern the Worker's pollJobs() already uses for
  // its own Outbox resend.
  function retryRunningProjectContinuations(project: { id: string; status: string } | undefined): void {
    if (project?.status !== 'running') return
    void retryPendingContinuationsForProject(storage, project.id)
      .catch((error: unknown) => app.log.error({ err: error, projectId: project.id }, 'continuation retry sweep failed'))
  }

  app.get('/', async (_req, reply) => {
    const projects = storage.projects.findAll()
    for (const project of projects) retryRunningProjectContinuations(project)
    return reply.send(projects)
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const project = storage.projects.findById(req.params.id)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    retryRunningProjectContinuations(project)
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

    const { gapAnswers, ...projectFields } = result.data

    // Interactive Project Definition / Readiness: このPATCHが「初回のrunning遷移」（＝
    // これからRoadmapを新規生成する）場合だけ、既存Gap Analysis（specAnalyzer）を通す。
    // 通常のProject作成体験（名前・Goal・Design Philosophyを書いてすぐ開始）は変えず、
    // 重要なGap（severity: 'must_resolve'）がある場合だけここで止めてCEOへ提示する。
    // 曖昧でない・軽微なGapは自動確定してそのまま進む。resume（既にRoadmapがあるProjectを
    // 再度runningにする）はこの対象外 -- 生成し直さないため確認の必要がない。
    const isFreshStart = projectFields.status === 'running'
      && !storage.tasks.findByProjectId(existing.id).some((task) => task.roadmapActive)

    let freshStartAnalysis: Awaited<ReturnType<typeof analyzeProjectDefinition>>['analysis'] | undefined
    if (isFreshStart) {
      const { importantGaps, analysis } = await analyzeProjectDefinition({
        goal: projectFields.goal ?? existing.goal,
        designPhilosophy: projectFields.designPhilosophy ?? existing.designPhilosophy,
        gapAnswers,
      })

      if (importantGaps.length > 0) {
        const { status: _status, ...nonStatusFields } = projectFields
        const saved = Object.keys(nonStatusFields).length > 0
          ? storage.projects.update(existing.id, nonStatusFields)
          : existing
        return reply.status(409).send({
          error: 'Project Definition has unresolved gaps',
          project: saved,
          gaps: importantGaps,
        })
      }

      freshStartAnalysis = analysis
    }

    try {
      const updated = storage.projects.update(req.params.id, projectFields)
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
          analysis: freshStartAnalysis,
        })
      } else if (updated.status === 'running' && hasActiveRoadmap) {
        // Resuming an already-initialized Project: retry any Task continuation left
        // 'pending' while paused (see initialImplementWorkflow.ts's retryable pause skip
        // and jobs.ts's matching ack-without-503 branch). This first attempt is a
        // convenience, not the guarantee -- if it fails, retryRunningProjectContinuations()
        // above (wired into GET / and GET /:id, which Mobile already polls) keeps retrying
        // on every subsequent poll tick, so a transient failure here never stalls a
        // continuation forever.
        void retryPendingContinuationsForProject(storage, updated.id)
          .catch((error: unknown) => req.log.error({ err: error, projectId: updated.id }, 'continuation retry sweep failed'))
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
