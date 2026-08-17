import type {
  Job,
  Task,
  TaskFailureExplanationResponse,
  TaskFailureQuestionResponse,
} from '@ai-team/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IStorage } from '../storage/interface'
import { buildResumeAiCliPrompt, type TaskRouteOptions } from '../routes/tasks'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import * as cheapAiClient from '../aiExplain/cheapAiClient'

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
  const [{ taskRoutes }, { jobRoutes }, { getStorage, resetStorage }] = await Promise.all([
    import('../routes/tasks.js'),
    import('../routes/jobs.js'),
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
  app.register(jobRoutes, { prefix: '/api/jobs' })
  await app.ready()
  return { app, storage: getStorage() }
}

async function postFailureExplanation(
  app: FastifyInstance,
  taskId: string,
): Promise<TaskFailureExplanationResponse> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/failure-explanation`,
  })
  expect(response.statusCode).toBe(200)
  return response.json<TaskFailureExplanationResponse>()
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

function analysisJson(likelyCause: string): string {
  return JSON.stringify({
    aiAnalysis: {
      classification: 'environment',
      likelyCause,
      impact: 'AIによる分析: Taskを完了できていません。',
      recommendedNextAction: 'AIによる分析: stderrと環境設定を確認してください。',
    },
  })
}

interface HashedFailureMutationCase {
  field: string
  taskStatus?: Task['status']
  jobStatus?: 'failed' | 'blocked'
  prepare?: (storage: IStorage, task: Task, job: Job) => void
  mutate: (storage: IStorage, task: Task, job: Job) => void
}

const hashedFailureMutationCases: HashedFailureMutationCase[] = [
  {
    field: 'stdout',
    prepare: (storage, _task, job) => {
      storage.jobs.update(job.id, { stdout: `${'x'.repeat(8_100)}a` })
    },
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { stdout: `${'x'.repeat(8_100)}b` })
    },
  },
  {
    field: 'stderr',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { stderr: 'A different stderr' })
    },
  },
  {
    field: 'exitCode',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { exitCode: 2 })
    },
  },
  {
    field: 'guardResult',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, {
        guardResult: {
          permissionAllowed: false,
          permissionReason: 'Denied',
          fileChangeAllowed: true,
        },
      })
    },
  },
  {
    field: 'startedAt',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { startedAt: '2026-08-17T01:00:00.000Z' })
    },
  },
  {
    field: 'completedAt',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { completedAt: '2026-08-17T01:01:00.000Z' })
    },
  },
  {
    field: 'changedFiles',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { changedFiles: ['src/changed.ts'] })
    },
  },
  {
    field: 'status',
    taskStatus: 'blocked',
    jobStatus: 'blocked',
    mutate: (storage, _task, job) => {
      storage.jobs.update(job.id, { status: 'failed' })
    },
  },
  {
    field: 'Task title',
    mutate: (storage, task) => {
      storage.tasks.update(task.id, { title: 'Changed Task title' })
    },
  },
  {
    field: 'Task description',
    mutate: (storage, task) => {
      storage.tasks.update(task.id, { description: 'Changed Task description' })
    },
  },
]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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
      expect(Object.keys(body)).toEqual(['ok', 'explanation'])
      expect(Object.keys(body.explanation)).toEqual(['generatedAt', 'facts', 'aiAnalysis'])
      expect(body).not.toHaveProperty('cached')
      expect(body).not.toHaveProperty('contentHash')
    } finally {
      await app.close()
    }
  })

  it('reuses one generated analysis and preserves generatedAt for the same failure', async () => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockResolvedValue(validAnalysisJson)
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      createFailureJob(storage, task)

      const first = await postFailureExplanation(app, task.id)
      const second = await postFailureExplanation(app, task.id)

      expect(aiRequest).toHaveBeenCalledTimes(1)
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(second.explanation.generatedAt).toBe(first.explanation.generatedAt)
      expect(second).toEqual(first)
    } finally {
      await app.close()
    }
  })

  it('does not regenerate when a queued Job is added without changing the target failure', async () => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockResolvedValue(validAnalysisJson)
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage, 'blocked')
      const failedJob = createFailureJob(storage, task)
      const first = await postFailureExplanation(app, task.id)
      storage.jobs.create({
        taskId: task.id,
        projectId: task.projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      })

      const second = await postFailureExplanation(app, task.id)

      expect(aiRequest).toHaveBeenCalledTimes(1)
      expect(first.ok && first.explanation.facts.jobId).toBe(failedJob.id)
      expect(second.ok && second.explanation.facts.jobId).toBe(failedJob.id)
    } finally {
      await app.close()
    }
  })

  it('reuses the analysis but rebuilds facts after only Task status changes', async () => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockResolvedValue(validAnalysisJson)
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      createFailureJob(storage, task)
      const first = await postFailureExplanation(app, task.id)
      storage.tasks.update(task.id, { status: 'blocked' })

      const second = await postFailureExplanation(app, task.id)

      expect(aiRequest).toHaveBeenCalledTimes(1)
      expect(first.ok && first.explanation.facts.taskStatus).toBe('in_progress')
      expect(second.ok && second.explanation.facts.taskStatus).toBe('blocked')
      expect(second.ok && second.explanation.facts.whatHappened).toContain('停止中／要対応')
    } finally {
      await app.close()
    }
  })

  it.each(hashedFailureMutationCases)('regenerates when only hashed $field changes', async ({
    taskStatus,
    jobStatus,
    prepare,
    mutate,
  }) => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockResolvedValue(validAnalysisJson)
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage, taskStatus)
      const job = createFailureJob(storage, task, jobStatus)
      prepare?.(storage, task, job)
      await postFailureExplanation(app, task.id)

      mutate(storage, task, job)
      const response = await postFailureExplanation(app, task.id)

      expect(response.ok).toBe(true)
      expect(aiRequest).toHaveBeenCalledTimes(2)
    } finally {
      await app.close()
    }
  })

  it('selects a newer failed Job by rowid when createdAt ties and never returns the old analysis', async () => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText')
      .mockResolvedValueOnce(analysisJson('old failure analysis'))
      .mockResolvedValueOnce(analysisJson('new failure analysis'))
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const oldJob = createFailureJob(storage, task)
      const first = await postFailureExplanation(app, task.id)
      expect(first.ok && first.explanation.aiAnalysis.likelyCause).toBe('old failure analysis')

      vi.useFakeTimers()
      vi.setSystemTime(new Date(oldJob.createdAt))
      const newJob = createFailureJob(storage, task)
      vi.useRealTimers()
      expect(newJob.createdAt).toBe(oldJob.createdAt)
      expect(storage.jobs.findByTaskId(task.id)[0]?.id).toBe(newJob.id)

      const second = await postFailureExplanation(app, task.id)

      expect(aiRequest).toHaveBeenCalledTimes(2)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.explanation.facts.jobId).toBe(newJob.id)
      expect(second.explanation.aiAnalysis.likelyCause).toBe('new failure analysis')
      expect(second.explanation.aiAnalysis.likelyCause).not.toBe('old failure analysis')
    } finally {
      await app.close()
    }
  })

  it('regenerates once when a saved envelope has an older inputVersion', async () => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockResolvedValue(validAnalysisJson)
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const job = createFailureJob(storage, task)
      await postFailureExplanation(app, task.id)
      const stored = storage.jobs.findFailureExplanation(job.id)
      if (!stored) throw new Error('Expected a saved failure explanation')
      storage.jobs.saveFailureExplanation(job.id, {
        ...stored,
        inputVersion: 0 as 1,
      })

      await postFailureExplanation(app, task.id)
      await postFailureExplanation(app, task.id)

      expect(aiRequest).toHaveBeenCalledTimes(2)
      expect(storage.jobs.findFailureExplanation(job.id)?.inputVersion).toBe(1)
    } finally {
      await app.close()
    }
  })

  it('single-flights concurrent requests for the same job and content hash', async () => {
    let releaseGeneration: (() => void) | undefined
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockImplementation(async () => {
      await generationGate
      return validAnalysisJson
    })
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      createFailureJob(storage, task)
      const pendingResponses = Array.from({ length: 4 }, () => (
        postFailureExplanation(app, task.id)
      ))
      await vi.waitFor(() => expect(aiRequest).toHaveBeenCalledTimes(1))
      releaseGeneration?.()

      const responses = await Promise.all(pendingResponses)

      expect(aiRequest).toHaveBeenCalledTimes(1)
      expect(responses.every((response) => response.ok)).toBe(true)
      expect(new Set(responses.map((response) => (
        response.ok ? response.explanation.generatedAt : ''
      ))).size).toBe(1)
    } finally {
      releaseGeneration?.()
      await app.close()
    }
  })

  it('does not block concurrent generation for different single-flight keys', async () => {
    let releaseFirstGeneration: (() => void) | undefined
    const firstGenerationGate = new Promise<void>((resolve) => {
      releaseFirstGeneration = resolve
    })
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText')
      .mockImplementationOnce(async () => {
        await firstGenerationGate
        return analysisJson('first failure analysis')
      })
      .mockResolvedValueOnce(analysisJson('second failure analysis'))
    const { app, storage } = await buildApp()
    try {
      const firstTask = createTask(storage)
      const secondTask = createTask(storage)
      createFailureJob(storage, firstTask)
      createFailureJob(storage, secondTask)

      const firstPendingResponse = postFailureExplanation(app, firstTask.id)
      await vi.waitFor(() => expect(aiRequest).toHaveBeenCalledTimes(1))

      const secondResponse = await postFailureExplanation(app, secondTask.id)
      expect(secondResponse.ok).toBe(true)
      expect(secondResponse.ok && secondResponse.explanation.aiAnalysis.likelyCause)
        .toBe('second failure analysis')

      releaseFirstGeneration?.()
      const firstResponse = await firstPendingResponse

      expect(firstResponse.ok).toBe(true)
      expect(firstResponse.ok && firstResponse.explanation.aiAnalysis.likelyCause)
        .toBe('first failure analysis')
      expect(aiRequest).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirstGeneration?.()
      await app.close()
    }
  })

  it('discards a generated explanation when the target Job changes during generation', async () => {
    let releaseFirstGeneration: (() => void) | undefined
    const firstGenerationGate = new Promise<void>((resolve) => {
      releaseFirstGeneration = resolve
    })
    let requestCount = 0
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText').mockImplementation(async () => {
      requestCount += 1
      if (requestCount === 1) {
        await firstGenerationGate
        return analysisJson('stale failure analysis')
      }
      return analysisJson('current failure analysis')
    })
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const job = createFailureJob(storage, task)
      const pendingResponse = postFailureExplanation(app, task.id)
      await vi.waitFor(() => expect(aiRequest).toHaveBeenCalledTimes(1))
      storage.jobs.update(job.id, { stderr: 'Failure changed while AI was running' })
      releaseFirstGeneration?.()

      const response = await pendingResponse

      expect(aiRequest).toHaveBeenCalledTimes(2)
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.explanation.facts.stderrExcerpt).toBe('Failure changed while AI was running')
      expect(response.explanation.aiAnalysis.likelyCause).toBe('current failure analysis')
      expect(response.explanation.aiAnalysis.likelyCause).not.toBe('stale failure analysis')
      await postFailureExplanation(app, task.id)
      expect(aiRequest).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirstGeneration?.()
      await app.close()
    }
  })

  it('returns ok:false without a stale explanation when the failure changes during both attempts', async () => {
    let releaseFirstGeneration: (() => void) | undefined
    const firstGenerationGate = new Promise<void>((resolve) => {
      releaseFirstGeneration = resolve
    })
    let releaseSecondGeneration: (() => void) | undefined
    const secondGenerationGate = new Promise<void>((resolve) => {
      releaseSecondGeneration = resolve
    })
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText')
      .mockImplementationOnce(async () => {
        await firstGenerationGate
        return analysisJson('first stale failure analysis')
      })
      .mockImplementationOnce(async () => {
        await secondGenerationGate
        return analysisJson('second stale failure analysis')
      })
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const job = createFailureJob(storage, task)
      const pendingResponse = postFailureExplanation(app, task.id)

      await vi.waitFor(() => expect(aiRequest).toHaveBeenCalledTimes(1))
      storage.jobs.update(job.id, { stderr: 'Failure changed during the first attempt' })
      releaseFirstGeneration?.()

      await vi.waitFor(() => expect(aiRequest).toHaveBeenCalledTimes(2))
      storage.jobs.update(job.id, { stderr: 'Failure changed during the second attempt' })
      releaseSecondGeneration?.()

      const response = await pendingResponse

      expect(response).toEqual({
        ok: false,
        error: 'AIによる分析を生成できませんでした',
      })
      expect(response).not.toHaveProperty('explanation')
      expect(storage.jobs.findFailureExplanation(job.id)).toBeUndefined()
      expect(aiRequest).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirstGeneration?.()
      releaseSecondGeneration?.()
      await app.close()
    }
  })

  it('does not persist AI failures and retries on the next request', async () => {
    const aiRequest = vi.spyOn(cheapAiClient, 'requestText')
      .mockRejectedValueOnce(new Error('temporary AI failure'))
      .mockResolvedValueOnce(validAnalysisJson)
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const job = createFailureJob(storage, task)

      const failed = await postFailureExplanation(app, task.id)
      expect(failed).toEqual({ ok: false, error: 'AIによる分析を生成できませんでした' })
      expect(storage.jobs.findFailureExplanation(job.id)).toBeUndefined()

      const retried = await postFailureExplanation(app, task.id)
      expect(retried.ok).toBe(true)
      expect(aiRequest).toHaveBeenCalledTimes(2)
      expect(storage.jobs.findFailureExplanation(job.id)).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('does not expose persisted failure data in normal Job GET or PATCH responses', async () => {
    const { app, storage } = await buildApp()
    try {
      const task = createTask(storage)
      const job = createFailureJob(storage, task)
      await postFailureExplanation(app, task.id)

      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}`,
      })
      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${job.id}`,
        payload: { stderr: 'Updated failure output' },
      })

      expect(getResponse.statusCode).toBe(200)
      expect(patchResponse.statusCode).toBe(200)
      for (const body of [getResponse.json<Record<string, unknown>>(), patchResponse.json<Record<string, unknown>>()]) {
        expect(body).not.toHaveProperty('failure_explanation_json')
        expect(body).not.toHaveProperty('failureExplanationJson')
        expect(body).not.toHaveProperty('contentHash')
      }
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

      const instruction = 'Retry after reviewing the failure.'
      storage.designReviewEvidence.create({
        taskId: task.id,
        designTextHash: computeDesignTextHash(buildResumeAiCliPrompt(task, instruction)),
        reviewLoad: 'medium',
        decision: 'ALIGNED',
        independentReviewRequired: false,
      })
      const resumeResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/resume`,
        payload: { instruction },
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
