import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { summaryEngineRoutes } from './summaryEngine.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(summaryEngineRoutes, { prefix: '/api/summary' })
  return app
}

const VALID_RESULT = {
  status: 'mock' as const,
  taskId: 'task-001',
  provider: 'claude',
  stdout: '[MOCK] claude が task-001 を処理しました。',
  changedFiles: ['src/types.ts'],
  executedAt: '2026-06-16T10:00:00.000Z',
  completedAt: '2026-06-16T10:00:05.000Z',
  durationMs: 5000,
}

describe('Summary Engine API', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `summary-api-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  it('POST /api/summary/update — Dashboard を生成して 201 を返す', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/summary/update',
      body: {
        result: VALID_RESULT,
        targetProjectRoot: tmpDir,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('dashboard_updated')
    expect(body.taskId).toBe('task-001')
    expect(body.entriesInDashboard).toBe(1)
    expect(existsSync(path.join(tmpDir, 'docs', 'dashboard.md'))).toBe(true)
  })

  it('POST /api/summary/update — result がない場合 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/summary/update',
      body: { targetProjectRoot: tmpDir },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/summary/update — status が不正な場合 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/summary/update',
      body: {
        result: { ...VALID_RESULT, status: 'UNKNOWN' },
        targetProjectRoot: tmpDir,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/summary/update — 2回呼ぶと entriesInDashboard が 2', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/api/summary/update',
      body: { result: VALID_RESULT, targetProjectRoot: tmpDir },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/summary/update',
      body: {
        result: { ...VALID_RESULT, taskId: 'task-002' },
        targetProjectRoot: tmpDir,
      },
    })
    const body = JSON.parse(res2.body)
    expect(body.entriesInDashboard).toBe(2)
  })
})
