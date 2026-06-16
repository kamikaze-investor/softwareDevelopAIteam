import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { ctoAiRoutes } from './ctoAi.js'
import { resetStorage } from '../storage/index.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'

process.env.DB_PATH = ':memory:'

const MOCK_ANALYSIS = JSON.stringify({
  goal: 'テスト用プロジェクトの目的',
  designPhilosophy: ['シンプルに作る', 'テストを書く'],
  mvpScope: {
    description: 'MVP説明',
    includedFeatures: ['機能A'],
    excludedFeatures: ['機能B'],
  },
  targetUsers: ['開発者'],
  techStack: ['Node.js', 'TypeScript'],
  gaps: [],
  requiredExternalServices: [],
  readinessScore: 85,
  readinessReason: 'テスト用スコア',
})

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(ctoAiRoutes, { prefix: '/api/cto' })
  return app
}

describe('CTO AI API', () => {
  let tmpDir: string

  beforeEach(() => {
    resetStorage()
    tmpDir = path.join(os.tmpdir(), `cto-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  it('POST /api/cto/analyze — mockResponse で Project Memory を生成できる', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      body: {
        specText: 'テスト仕様書です。これは50文字以上のテキストが必要なのでここに追加テキストを入れます。十分な長さにするために更に文字を追加します。',
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ready')
    expect(body.readinessScore).toBe(85)
    expect(body.writtenFiles).toHaveLength(5)
    // ファイルが実際に作成されているか
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'goal.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'gap_analysis.md'))).toBe(true)
  })

  it('POST /api/cto/analyze — specText が短すぎると 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      body: {
        specText: '短い',
        targetProjectRoot: tmpDir,
        mockResponse: MOCK_ANALYSIS,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/cto/analyze — readinessScore < 70 は gaps_found を返す', async () => {
    const lowScoreMock = JSON.stringify({
      ...JSON.parse(MOCK_ANALYSIS),
      readinessScore: 50,
      gaps: [{
        category: 'technical',
        description: '重要な未決定事項',
        severity: 'must_resolve',
        suggestion: '決定が必要',
      }],
    })
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      body: {
        specText: 'テスト仕様書です。これは50文字以上のテキストが必要なのでここに追加テキストを入れます。十分な長さにするために更に文字を追加します。',
        targetProjectRoot: tmpDir,
        mockResponse: lowScoreMock,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('gaps_found')
    expect(body.mustResolveGaps).toHaveLength(1)
  })

  it('POST /api/cto/analyze — targetProjectRoot がない場合 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/cto/analyze',
      body: {
        specText: 'テスト仕様書です。これは50文字以上のテキストが必要なのでここに追加テキストを入れます。十分な長さにするために更に文字を追加します。',
        mockResponse: MOCK_ANALYSIS,
        // targetProjectRoot なし
      },
    })
    expect(res.statusCode).toBe(400)
  })
})
