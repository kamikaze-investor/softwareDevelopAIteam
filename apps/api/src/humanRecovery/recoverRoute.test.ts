/**
 * `POST /api/tasks/:id/recover` の HTTP 契約と、汎用 PATCH 経路を閉じたことの検証。
 *
 * 固定する invariant:
 *   1. recover は Job 0 件の blocked Task を pending へ戻し、結果を機械可読に返す
 *      （Mobile が状態で分岐せず、サーバの判断をそのまま描けること）
 *   2. **`PATCH /api/tasks/:id` では blocked から出られない。** ここを開けたままにすると
 *      無 audit・無上限の復旧経路が並立する（`tasks.update()` は audit_log を書かない）
 */

import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Task } from '@ai-team/shared'

async function buildApp(): Promise<FastifyInstance> {
  const [{ projectRoutes }, { taskRoutes }, { resetStorage }] = await Promise.all([
    import('../routes/projects.js'),
    import('../routes/tasks.js'),
    import('../storage/index.js'),
  ])
  // `resetStorage()` は singleton を捨てるだけで、DB_PATH が実ファイルのままだと
  // 前のテストのデータを読み直す（running Project が残り 409 になる）。
  process.env.DB_PATH = ':memory:'
  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  await app.ready()
  return app
}

async function seedBlockedTaskWithoutJob(app: FastifyInstance): Promise<string> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' },
  })
  const projectId = (JSON.parse(project.body) as { id: string }).id

  const task = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: {
      projectId,
      title: '止まった Task',
      description: 'body',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
    },
  })
  const taskId = (JSON.parse(task.body) as { id: string }).id

  // pending -> blocked は従来どおり通る（閉じたのは blocked から**出る**方向だけ）。
  const blocked = await app.inject({
    method: 'PATCH',
    url: `/api/tasks/${taskId}`,
    payload: { status: 'blocked' },
  })
  expect(blocked.statusCode).toBe(200)
  return taskId
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp()
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

describe('POST /api/tasks/:id/recover', () => {
  it('Job 0 件の blocked Task を pending へ戻し、次に何が動くかを返す', async () => {
    await withApp(async (app) => {
      const taskId = await seedBlockedTaskWithoutJob(app)

      const res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/recover`,
        payload: { reason: 'Design Review CONFLICT を確認したので再投入する' },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { ok: boolean; attempt: number; nextDriver: string; task: Task }
      expect(body).toMatchObject({ ok: true, attempt: 1, nextDriver: 'attention_only' })
      expect(body.task.status).toBe('pending')
    })
  })

  it('reason が無ければ 400', async () => {
    await withApp(async (app) => {
      const taskId = await seedBlockedTaskWithoutJob(app)

      const res = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/recover`, payload: {} })

      expect(res.statusCode).toBe(400)
    })
  })

  it('存在しない Task は 404、受理できない状態は 409 + code を返す', async () => {
    await withApp(async (app) => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/tasks/nope/recover',
        payload: { reason: 'r' },
      })
      expect(missing.statusCode).toBe(404)

      const taskId = await seedBlockedTaskWithoutJob(app)
      await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/recover`, payload: { reason: 'r' } })
      // もう blocked ではないので二度目は断られる。
      const again = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/recover`,
        payload: { reason: 'r' },
      })

      expect(again.statusCode).toBe(409)
      expect(JSON.parse(again.body)).toMatchObject({ code: 'TASK_NOT_BLOCKED' })
    })
  })
})

describe('PATCH /api/tasks/:id は blocked からの復帰に使えない', () => {
  it('blocked -> pending を 409 で断り、復旧経路を案内する', async () => {
    await withApp(async (app) => {
      const taskId = await seedBlockedTaskWithoutJob(app)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${taskId}`,
        payload: { status: 'pending' },
      })

      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'TASK_BLOCKED_USE_RECOVERY_ROUTE' })
    })
  })

  it('blocked 以外の Task の status 更新は従来どおり通る', async () => {
    await withApp(async (app) => {
      const project = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'P', goal: 'g', designPhilosophy: [], status: 'running' },
      })
      const projectId = (JSON.parse(project.body) as { id: string }).id
      const task = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          projectId, title: 'T', description: 'd',
          status: 'pending', assignee: 'developer_ai', dependencies: [],
        },
      })
      const taskId = (JSON.parse(task.body) as { id: string }).id

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${taskId}`,
        payload: { status: 'in_progress' },
      })

      expect(res.statusCode).toBe(200)
      expect((JSON.parse(res.body) as Task).status).toBe('in_progress')
    })
  })

  it('status を含まない更新は blocked な Task でも通る（title 等は復旧操作ではない）', async () => {
    await withApp(async (app) => {
      const taskId = await seedBlockedTaskWithoutJob(app)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${taskId}`,
        payload: { title: '名前だけ直す' },
      })

      expect(res.statusCode).toBe(200)
      expect((JSON.parse(res.body) as Task).status).toBe('blocked')
    })
  })
})
