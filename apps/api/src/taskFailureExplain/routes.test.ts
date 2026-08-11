import type {
  Job,
  Task,
  TaskFailureExplanationResponse,
  TaskFailureQuestionResponse,
} from '@ai-team/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'
import type { TaskRouteOptions } from '../routes/tasks'

const validAnalysisJson = JSON.stringify({
  aiAnalysis: {
    classification: 'environment',
    likelyCause: 'AIによる分析: 実行環境の設定不足の可能性があります。',
    impact: 'AIによる分析: Taskを完了できていません。',
    recommendedNextAction: 'AIによる分析: stderrと環境設定を確認してください。',
  },
})

async function buildApp(
  options: TaskRouteOptions = {},
): Promise<{ app: FastifyInstance; storage: IStorage }> {
  process.env.DB_PATH = ':memory:'
  const [{ taskRoutes }, { getStorage, resetStorage }] = await Promise.all([
    import('../routes/tasks.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.register(taskRoutes, {
    prefix: '/api/tasks',
    failureExplanationAiOptions: { mockResponse: validAnalysisJson },
    failureQuestionAiOptions: {
      mockResponse: 'AIによる分析: まずstderrの記録を確認してください。',
    },
    ...options,
  })
  await app.ready()
  return { app, storage: getStorage() }
}

function createTask(storage: IStorage, status: Task['status'] = 'in_progress'): Task {
  const project = storage.projects.create({
    name: 'Task Failure Explain',
    goal: '失敗と停止を理解する',
    designPhilosophy: [],
    status: 'draft',
  })
  return storage.tasks.create({
    projectId: project.id,
    title: '失敗したTask',
    description: '失敗理由を確認する',
    status,
    assignee: 'developer_ai',
    dependencies: [],
  })
}

function createFailureJob(
  storage: IStorage,
  task: Task,
  status: 'failed' | 'blocked' = 'failed',
): Job {
  const created = storage.jobs.create({
    taskId: task.id,
    projectId: task.projectId,
    agentRole: 'developer_ai',
    status: 'running',
    safeCommand: { kind: 'test', workingDir: '/workspace/target' },
    aiCliProvider: 'codex',
    aiCliPrompt: 'Original failed prompt',
    aiCliMode: 'implement',
  })
  const updated = storage.jobs.update(created.id, {
    status,
    exitCode: 1,
    stderr: 'Test suite failed',
    changedFiles: ['src/example.ts'],
    guardResult: {
      permissionAllowed: true,
      fileChangeAllowed: true,
    },
  })
  if (!updated) throw new Error('Failed to update fixture Job')
  return updated
}

describe('Task failure explanation routes', () => {
  it('returns code-built facts and structured AI analysis', async () => {
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const job = createFailureJob(storage, task)
      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/failure-explanation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<TaskFailureExplanationResponse>()
      expect(body.ok).toBe(true)
      if (!body.ok) return
      expect(body.explanation.facts).toMatchObject({
        jobId: job.id,
        jobStatus: 'failed',
        exitCode: 1,
        stderrExcerpt: 'Test suite failed',
        changedFiles: ['src/example.ts'],
      })
      expect(body.explanation.aiAnalysis.classification).toBe('environment')
    } finally {
      await app.close()
    }
  })

  it('returns ok:false with HTTP 200 when no failed or blocked Job exists', async () => {
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage, 'blocked')
      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/failure-explanation`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<TaskFailureExplanationResponse>()).toEqual({
        ok: false,
        error: '説明対象の失敗・停止Jobが見つかりませんでした',
      })
    } finally {
      await app.close()
    }
  })

  it('answers a question without persisting client-supplied history', async () => {
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage, 'blocked')
      const job = createFailureJob(storage, task, 'blocked')
      const before = storage.jobs.findById(job.id)
      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/failure-ask`,
        payload: {
          question: '次に何を確認しますか？',
          history: [
            { role: 'user', content: 'これは失敗ですか？' },
            {
              role: 'assistant',
              content: '停止中であり、失敗とは断定できません。',
            },
          ],
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<TaskFailureQuestionResponse>()).toEqual({
        ok: true,
        answer: 'AIによる分析: まずstderrの記録を確認してください。',
      })
      expect(storage.jobs.findById(job.id)).toEqual(before)
    } finally {
      await app.close()
    }
  })

  it('keeps the existing Task endpoint available when AI generation fails', async () => {
    const { app, storage } = await buildApp({
      failureExplanationAiOptions: { mockResponse: 'not-json' },
    })
    try {
      const task = createTask(storage, 'blocked')
      const blockedJob = createFailureJob(storage, task, 'blocked')
      const before = storage.tasks.findById(task.id)
      const explanationResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/failure-explanation`,
      })

      expect(explanationResponse.statusCode).toBe(200)
      expect(explanationResponse.json<TaskFailureExplanationResponse>()).toEqual({
        ok: false,
        error: 'AIによる分析を生成できませんでした',
      })

      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
      })
      expect(taskResponse.statusCode).toBe(200)
      expect(taskResponse.json<Task>()).toEqual(before)

      const resumeResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/resume`,
        payload: { instruction: 'Retry after reviewing the failure.' },
      })
      expect(resumeResponse.statusCode).toBe(201)
      expect(resumeResponse.json<Job>()).toMatchObject({
        taskId: task.id,
        status: 'queued',
        aiCliProvider: 'codex',
        aiCliMode: 'implement',
      })
      expect(storage.jobs.findById(blockedJob.id)?.status).toBe('blocked')
    } finally {
      await app.close()
    }
  })
})
