import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { contextPackRoutes } from './contextPack.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(contextPackRoutes, { prefix: '/api/context-pack' })
  return app
}

const VALID_TASK = {
  id: 'task-001',
  title: '共有型定義',
  description: 'packages/shared に型を追加する',
  phase: 1,
  assignee: 'developer_ai',
  dependencies: [],
  acceptanceCriteria: ['型エラーがない'],
  allowedPaths: ['packages/shared/src/'],
  estimatedComplexity: 'small',
}

describe('Context Pack API', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ctx-api-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  it('POST /api/context-pack — Context Pack を生成できる', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/context-pack',
      body: {
        task: VALID_TASK,
        targetProjectRoot: tmpDir,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('context_pack_ready')
    expect(body.taskId).toBe('task-001')
    expect(body.pack.instruction).toContain('task-001')
    expect(body.pack.instruction).toContain('packages/shared/src/')
  })

  it('POST /api/context-pack — Project Memory があれば読み込む', async () => {
    const memDir = path.join(tmpDir, 'docs', 'project_memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(path.join(memDir, 'goal.md'), '# Goal\n\nコンテンツ配信システム')

    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/context-pack',
      body: { task: VALID_TASK, targetProjectRoot: tmpDir },
    })
    const body = JSON.parse(res.body)
    expect(body.hasProjectMemory).toBe(true)
    expect(body.pack.projectMemory.goal).toContain('コンテンツ配信システム')
  })

  it('POST /api/context-pack — task がない場合 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/context-pack',
      body: { targetProjectRoot: tmpDir },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/context-pack — task.id が不正形式で 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/context-pack',
      body: {
        task: { ...VALID_TASK, id: 'TASK001' },
        targetProjectRoot: tmpDir,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/context-pack — 既存ファイルの内容を relevantFiles に含める', async () => {
    const srcDir = path.join(tmpDir, 'packages', 'shared', 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'types.ts'), 'export type Foo = string')

    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/context-pack',
      body: { task: VALID_TASK, targetProjectRoot: tmpDir },
    })
    const body = JSON.parse(res.body)
    const found = body.pack.relevantFiles.find((f: any) => f.relativePath.includes('types.ts'))
    expect(found).toBeTruthy()
    expect(found.content).toContain('export type Foo = string')
  })
})
