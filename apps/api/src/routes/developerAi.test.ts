import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { developerAiRoutes } from './developerAi.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(developerAiRoutes, { prefix: '/api/developer-ai' })
  return app
}

describe('Developer AI API', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dev-ai-api-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  it('POST /api/developer-ai/run — mockRun=true で 201 を返す', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        instruction: '型定義を実装してください',
        targetProjectRoot: tmpDir,
        taskId: 'task-001',
        mockRun: true,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('mock')
    expect(body.taskId).toBe('task-001')
    expect(body.result.stdout).toContain('[MOCK]')
  })

  it('POST /api/developer-ai/run — provider を指定できる', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        provider: 'codex',
        instruction: '型定義を実装',
        targetProjectRoot: tmpDir,
        taskId: 'task-002',
        mockRun: true,
      },
    })
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('codex')
  })

  it('POST /api/developer-ai/run — instruction がない場合 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        targetProjectRoot: tmpDir,
        taskId: 'task-001',
        mockRun: true,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/developer-ai/run — provider が不正な場合 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        provider: 'gpt4',
        instruction: 'テスト',
        targetProjectRoot: tmpDir,
        taskId: 'task-001',
        mockRun: true,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/developer-ai/run — changedFiles が配列で返る', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        instruction: '実装してください',
        targetProjectRoot: tmpDir,
        taskId: 'task-003',
        mockRun: true,
      },
    })
    const body = JSON.parse(res.body)
    expect(Array.isArray(body.changedFiles)).toBe(true)
  })

  // [codex-review P2] 手動承認ゲートのテスト
  it('POST /api/developer-ai/run — mockRun=false & approved=false は 403', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        instruction: '実装してください',
        targetProjectRoot: tmpDir,
        taskId: 'task-001',
        mockRun: false,
        approved: false,
      },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('承認が必要')
  })

  // [codex-review P1] パス境界検証のテスト
  it('POST /api/developer-ai/run — ".." を含むパスは 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/developer-ai/run',
      body: {
        instruction: '実装してください',
        targetProjectRoot: 'C:/Users/honka/../softwareDevelopAIteam',
        taskId: 'task-001',
        mockRun: true,
      },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('パス検証エラー')
  })
})
