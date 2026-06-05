import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { reviewRoutes, qaRoutes } from './reviews'
import { projectRoutes } from './projects'
import { taskRoutes } from './tasks'
import { resetStorage } from '../storage'

process.env.DB_PATH = ':memory:'

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  app.register(reviewRoutes, { prefix: '/api/reviews' })
  app.register(qaRoutes, { prefix: '/api/qa' })
  return app
}

async function createProject(app: ReturnType<typeof buildApp>) {
  const res = await app.inject({
    method: 'POST', url: '/api/projects',
    body: { name: 'Test', goal: 'テスト', designPhilosophy: [] },
  })
  return JSON.parse(res.body)
}

async function createTask(app: ReturnType<typeof buildApp>, projectId: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/tasks',
    body: { projectId, title: 'Task', assignee: 'developer_ai' },
  })
  return JSON.parse(res.body)
}

describe('ReviewResult API', () => {
  beforeEach(() => { resetStorage() })

  it('GET /api/reviews — taskId なしは 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/reviews' })
    expect(res.statusCode).toBe(400)
  })

  it('GET /api/reviews?taskId=xxx — 存在しない Task は 404', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/reviews?taskId=not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /api/reviews — 作成できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const res = await app.inject({
      method: 'POST', url: '/api/reviews',
      body: {
        taskId: task.id,
        jobId: 'job-001',
        reviewer: 'reviewer_ai',
        status: 'approved',
        summary: 'LGTM',
        findings: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBeTruthy()
    expect(body.status).toBe('approved')
    expect(body.reviewer).toBe('reviewer_ai')
  })

  it('POST /api/reviews — findings を含めて作成できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const res = await app.inject({
      method: 'POST', url: '/api/reviews',
      body: {
        taskId: task.id,
        jobId: 'job-001',
        reviewer: 'meta_reviewer',
        status: 'changes_requested',
        summary: '修正が必要',
        findings: [{ severity: 'high', file: 'src/index.ts', message: 'UIにビジネスロジックがある', rule: 'no_business_logic_in_ui' }],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.findings).toHaveLength(1)
    expect(body.findings[0].severity).toBe('high')
  })

  it('GET /api/reviews?taskId=xxx — 作成済み結果を取得できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    await app.inject({
      method: 'POST', url: '/api/reviews',
      body: { taskId: task.id, jobId: 'job-001', reviewer: 'reviewer_ai', status: 'approved', summary: 'OK' },
    })
    const res = await app.inject({ method: 'GET', url: `/api/reviews?taskId=${task.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
  })

  it('GET /api/reviews/:id — 取得できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/reviews',
      body: { taskId: task.id, jobId: 'job-001', reviewer: 'reviewer_ai', status: 'approved', summary: 'OK' },
    })).body)
    const res = await app.inject({ method: 'GET', url: `/api/reviews/${created.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).id).toBe(created.id)
  })

  it('GET /api/reviews/:id — 存在しない場合 404', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/reviews/not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /api/reviews — バリデーションエラー (reviewer なし) は 400', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const res = await app.inject({
      method: 'POST', url: '/api/reviews',
      body: { taskId: task.id, jobId: 'job-001', status: 'approved' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('QAResult API', () => {
  beforeEach(() => { resetStorage() })

  it('GET /api/qa — taskId なしは 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/qa' })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/qa — 作成できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const res = await app.inject({
      method: 'POST', url: '/api/qa',
      body: {
        taskId: task.id,
        jobId: 'job-001',
        type: 'unit_test',
        status: 'passed',
        summary: '38 tests passed',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBeTruthy()
    expect(body.type).toBe('unit_test')
    expect(body.status).toBe('passed')
  })

  it('POST /api/qa — details を含めて作成できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const res = await app.inject({
      method: 'POST', url: '/api/qa',
      body: {
        taskId: task.id,
        jobId: 'job-001',
        type: 'typecheck',
        status: 'failed',
        summary: '型エラーあり',
        details: 'src/index.ts:10:5 - error TS2345',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).details).toContain('TS2345')
  })

  it('GET /api/qa?taskId=xxx — 作成済み結果を取得できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    await app.inject({
      method: 'POST', url: '/api/qa',
      body: { taskId: task.id, jobId: 'job-001', type: 'build', status: 'passed', summary: 'OK' },
    })
    const res = await app.inject({ method: 'GET', url: `/api/qa?taskId=${task.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
  })

  it('GET /api/qa/:id — 取得できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const task = await createTask(app, project.id)
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/qa',
      body: { taskId: task.id, jobId: 'job-001', type: 'lint', status: 'passed', summary: 'OK' },
    })).body)
    const res = await app.inject({ method: 'GET', url: `/api/qa/${created.id}` })
    expect(res.statusCode).toBe(200)
  })

  it('GET /api/qa/:id — 存在しない場合 404', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/qa/not-exist' })
    expect(res.statusCode).toBe(404)
  })
})
