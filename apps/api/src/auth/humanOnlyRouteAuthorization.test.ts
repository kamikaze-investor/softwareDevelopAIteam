/**
 * Human-only route の authorization 境界。
 *
 * CEO 決定（2026-09-18）は Human Recovery を「認証済み CEO の明示操作」に限り、
 * AI/PL の自律呼び出しには適用しないと定める。auth mode ごとに何が保証されるかを固定する:
 *
 * | mode | credential | 期待 |
 * |---|---|---|
 * | split | ADMIN | 通す |
 * | split | WORKER | 403（allowlist の Default Deny） |
 * | legacy（`API_TOKEN` 設定） | 単一 token | **403（主体を区別できないので fail-closed）** |
 * | 認証なし（`API_TOKEN` 未設定） | — | **403（主体がそもそも分からない）** |
 * | 片側だけ設定 | — | 既存の 503 を維持 |
 *
 * つまり規則は1本である: **human-only route は split credential mode の ADMIN でのみ通る。**
 *
 * **legacy auth 全体は変えていない。** 影響を受けるのは `HUMAN_ONLY_ROUTES` の route だけで、
 * 他の legacy route の挙動が変わっていないことも併せて固定する。
 */

import cors from '@fastify/cors'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './apiToken.js'
import { HUMAN_ONLY_ROUTES, isHumanOnlyRoute } from './humanOnlyRoutes.js'
import { WORKER_ALLOWLIST } from './workerAllowlist.js'

const ADMIN_TOKEN = 'admin-plain-token-for-tests'
const WORKER_TOKEN = 'worker-plain-token-for-tests'
const LEGACY_TOKEN = 'legacy-plain-token-for-tests'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

type AuthMode =
  | { kind: 'split' }
  | { kind: 'legacy'; token?: string }
  | { kind: 'invalid_split' }

async function buildApp(mode: AuthMode): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
  delete process.env.API_TOKEN

  if (mode.kind === 'split') {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)
    process.env.WORKER_TOKEN_SHA256 = sha256Hex(WORKER_TOKEN)
  } else if (mode.kind === 'invalid_split') {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)
  } else if (mode.token !== undefined) {
    process.env.API_TOKEN = mode.token
  }

  const [{ projectRoutes }, { taskRoutes }, { resetStorage }] = await Promise.all([
    import('../routes/projects.js'),
    import('../routes/tasks.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.register(cors, { origin: true })
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  await app.ready()
  return app
}

afterEach(() => {
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
  delete process.env.API_TOKEN
})

/** recover が受理できる形（blocked / Job 0 件 / roadmapActive）の Task を1件用意する。 */
async function seedRecoverableTask(app: FastifyInstance, auth: Record<string, string>): Promise<string> {
  const project = await app.inject({
    method: 'POST', url: '/api/projects', headers: auth,
    payload: { name: 'P', goal: 'g', designPhilosophy: [], status: 'running' },
  })
  const projectId = (JSON.parse(project.body) as { id: string }).id

  const task = await app.inject({
    method: 'POST', url: '/api/tasks', headers: auth,
    payload: {
      projectId, title: 'T', description: 'd',
      status: 'pending', assignee: 'developer_ai', dependencies: [],
    },
  })
  const taskId = (JSON.parse(task.body) as { id: string }).id

  const { getStorage } = await import('../storage/index.js')
  getStorage().tasks.update(taskId, { roadmapActive: true, status: 'blocked' })
  return taskId
}

async function withApp(mode: AuthMode, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp(mode)
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

describe('split credential mode', () => {
  it('ADMIN は Human Recovery を実行できる', async () => {
    await withApp({ kind: 'split' }, async (app) => {
      const auth = { authorization: `Bearer ${ADMIN_TOKEN}` }
      const taskId = await seedRecoverableTask(app, auth)

      const res = await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/recover`, headers: auth,
        payload: { reason: 'CEO が再投入する' },
      })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ ok: true })
    })
  })

  it('WORKER は 403（allowlist の Default Deny）', async () => {
    await withApp({ kind: 'split' }, async (app) => {
      const taskId = await seedRecoverableTask(app, { authorization: `Bearer ${ADMIN_TOKEN}` })

      const res = await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/recover`,
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { reason: 'worker からの自律呼び出し' },
      })

      expect(res.statusCode).toBe(403)
      // 状態は動いていない。
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().tasks.findById(taskId)?.status).toBe('blocked')
    })
  })
})

describe('legacy mode では Human Recovery を fail-closed にする', () => {
  it('正しい API_TOKEN でも 403 になる（人と自動を区別できないため）', async () => {
    await withApp({ kind: 'legacy', token: LEGACY_TOKEN }, async (app) => {
      const auth = { authorization: `Bearer ${LEGACY_TOKEN}` }
      const taskId = await seedRecoverableTask(app, auth)

      const res = await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/recover`, headers: auth,
        payload: { reason: 'r' },
      })

      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toMatchObject({
        code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS',
      })
      const { getStorage } = await import('../storage/index.js')
      expect(getStorage().tasks.findById(taskId)?.status).toBe('blocked')
    })
  })

  it('**無効な token には 401 のまま**（403 で route の存在を教えない）', async () => {
    await withApp({ kind: 'legacy', token: LEGACY_TOKEN }, async (app) => {
      const taskId = await seedRecoverableTask(app, { authorization: `Bearer ${LEGACY_TOKEN}` })

      const res = await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/recover`,
        headers: { authorization: 'Bearer wrong-token' },
        payload: { reason: 'r' },
      })

      expect(res.statusCode).toBe(401)
    })
  })

  it('**Human Recovery 以外の legacy route の挙動は変えていない**', async () => {
    await withApp({ kind: 'legacy', token: LEGACY_TOKEN }, async (app) => {
      const auth = { authorization: `Bearer ${LEGACY_TOKEN}` }
      const taskId = await seedRecoverableTask(app, auth)

      // 読み取りも、他の書き込みも従来どおり通る。
      expect((await app.inject({ method: 'GET', url: '/api/tasks/summary', headers: auth })).statusCode)
        .toBe(200)
      expect((await app.inject({
        method: 'PATCH', url: `/api/tasks/${taskId}`, headers: auth, payload: { title: 'renamed' },
      })).statusCode).toBe(200)
    })
  })

  it('**認証なしのローカル開発（API_TOKEN 未設定）でも 403**', async () => {
    // 一度はここを素通しにした。だが legacy mode を塞ぐ理由が「人か自動かを区別できない」
    // ことなら、認証が無い構成は**主体がそもそも分からない**のでより強く塞がる側である。
    // しかもローカルは AI agent が localhost の API を叩ける場所そのもので、
    // CEO 決定が除外した相手が実際に居る（独立レビュー round 4・blocking 指摘）。
    await withApp({ kind: 'legacy' }, async (app) => {
      const taskId = await seedRecoverableTask(app, {})

      const res = await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/recover`, payload: { reason: 'r' },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS' })
      // 状態は動いていない。
      const after = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })
      expect(after.json().status).toBe('blocked')
    })
  })

  it('**認証なしでも human-only 以外の route は素通しのまま**（ローカル開発を壊さない）', async () => {
    await withApp({ kind: 'legacy' }, async (app) => {
      const taskId = await seedRecoverableTask(app, {})

      expect((await app.inject({ method: 'GET', url: '/api/tasks/summary' })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'PATCH', url: `/api/tasks/${taskId}`, payload: { title: 'renamed' },
      })).statusCode).toBe(200)
    })
  })
})

describe('設定ミスの扱いは変えていない', () => {
  it('片側だけ設定された split config は既存どおり 503', async () => {
    await withApp({ kind: 'invalid_split' }, async (app) => {
      const res = await app.inject({
        method: 'POST', url: '/api/tasks/any-id/recover',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { reason: 'r' },
      })

      expect(res.statusCode).toBe(503)
    })
  })
})

describe('表の整合', () => {
  it('human-only route は WORKER allowlist に載っていない', () => {
    for (const entry of HUMAN_ONLY_ROUTES) {
      expect(WORKER_ALLOWLIST.some((w) => w.method === entry.method && w.url === entry.url)).toBe(false)
    }
  })

  it('照合は route pattern と完全一致で行う（実 URL では判定しない）', () => {
    expect(isHumanOnlyRoute('POST', '/api/tasks/:id/recover')).toBe(true)
    expect(isHumanOnlyRoute('POST', '/api/tasks/abc-123/recover')).toBe(false)
    expect(isHumanOnlyRoute('GET', '/api/tasks/:id/recover')).toBe(false)
    expect(isHumanOnlyRoute(undefined, undefined)).toBe(false)
  })
})
