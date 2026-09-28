import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './apiToken'
import { OPERATOR_GATEWAY_ALLOWLIST, isOperatorGatewayRouteAllowed } from './operatorGatewayAllowlist'
import { resetStorage, getStorage } from '../storage'
import { buildSystemState } from '../state/systemState'
import type { IStorage } from '../storage/interface'
import { projectRoutes } from '../routes/projects'
import { systemStateRoutes } from '../routes/systemState.js'
import { approvalRoutes } from '../routes/approvals'
import { taskRoutes } from '../routes/tasks'
import { jobRoutes } from '../routes/jobs'
import { reviewRoutes, qaRoutes } from '../routes/reviews'
import { principleRoutes } from '../routes/principles'
import { ctoAiRoutes } from '../routes/ctoAi'
import { contextPackRoutes } from '../routes/contextPack'
import { developerAiRoutes } from '../routes/developerAi'
import { summaryEngineRoutes } from '../routes/summaryEngine'
import { permissionGrantRoutes } from '../routes/permissionGrants'
import { watchdogEventRoutes } from '../routes/watchdogEvents'
import { supervisedRunRoutes } from '../routes/supervisedRuns'
import { taskContinuationRoutes } from '../routes/taskContinuations'
import { operatorRequestRoutes } from '../routes/operatorRequests'
import { dashboardRoutes } from '../routes/dashboard'
import { approvalGateRoutes } from '../routes/approvalGate'
import { knowledgeGraphRoutes } from '../routes/knowledgeGraph'
import { healthRoutes } from '../routes/health'
import { plRoutes } from '../routes/pl'

/**
 * OPERATOR_GATEWAY（外部 Operator 用 credential）の権限境界。
 *
 * **production と同じ route 群を登録し、登録された全 route を列挙して**確かめる:
 * - allowlist 外の route は全部 403（handler に到達しない）
 * - allowlist 内の write は `POST /api/operator-requests` だけ
 * - safe read は Job の stdout / stderr / prompt を返さない
 * - ADMIN / WORKER / ACTIONS_READONLY への fallback が無い
 */

/** `index.ts` の登録と同じもの。下の drift test が index.ts の実物と突き合わせる。 */
const REGISTERED: Array<[string, FastifyPluginAsync, string]> = [
  ['projectRoutes', projectRoutes as FastifyPluginAsync, '/api/projects'],
  ['systemStateRoutes', systemStateRoutes as FastifyPluginAsync, '/api'],
  ['plRoutes', plRoutes as FastifyPluginAsync, '/api'],
  ['approvalRoutes', approvalRoutes as FastifyPluginAsync, '/api'],
  ['taskRoutes', taskRoutes as FastifyPluginAsync, '/api/tasks'],
  ['jobRoutes', jobRoutes as FastifyPluginAsync, '/api/jobs'],
  ['reviewRoutes', reviewRoutes as FastifyPluginAsync, '/api/reviews'],
  ['qaRoutes', qaRoutes as FastifyPluginAsync, '/api/qa'],
  ['ctoAiRoutes', ctoAiRoutes as FastifyPluginAsync, '/api/cto'],
  ['contextPackRoutes', contextPackRoutes as FastifyPluginAsync, '/api/context-pack'],
  ['developerAiRoutes', developerAiRoutes as FastifyPluginAsync, '/api/developer-ai'],
  ['summaryEngineRoutes', summaryEngineRoutes as FastifyPluginAsync, '/api/summary'],
  ['permissionGrantRoutes', permissionGrantRoutes as FastifyPluginAsync, '/api'],
  ['watchdogEventRoutes', watchdogEventRoutes as FastifyPluginAsync, '/api'],
  ['supervisedRunRoutes', supervisedRunRoutes as FastifyPluginAsync, '/api'],
  ['taskContinuationRoutes', taskContinuationRoutes as FastifyPluginAsync, '/api'],
  ['operatorRequestRoutes', operatorRequestRoutes as FastifyPluginAsync, '/api'],
  ['dashboardRoutes', dashboardRoutes as FastifyPluginAsync, '/api'],
  ['approvalGateRoutes', approvalGateRoutes as FastifyPluginAsync, '/api'],
  ['knowledgeGraphRoutes', knowledgeGraphRoutes as FastifyPluginAsync, '/api'],
  ['principleRoutes', principleRoutes as FastifyPluginAsync, '/api'],
  ['healthRoutes', healthRoutes as FastifyPluginAsync, '/api'],
]

const ADMIN_TOKEN = 'admin-token-value'
const WORKER_TOKEN = 'worker-token-value'
const ACTIONS_TOKEN = 'actions-token-value'
const OPERATOR_TOKEN = 'operator-gateway-token-value'
const sha = (v: string): string => createHash('sha256').update(v, 'utf-8').digest('hex')

const SECRETS = [
  'STDOUT-SECRET-111', 'STDERR-SECRET-222', 'PROMPT-SECRET-333', '/home/ceo/.ssh', 'QA-DETAILS-SECRET',
  // 1行目が構造化行でない stderr は、`/api/state` の attention.detail に末尾がそのまま入る
  'UNSTRUCTURED-STDERR-SECRET-444',
  // Design Review runner の stderr は run.error に入り、state / attention / task 詳細へ流れる
  'RUNNER-STDERR-SECRET-555',
]

const ENV_KEYS = [
  'API_TOKEN', 'ADMIN_TOKEN_SHA256', 'WORKER_TOKEN_SHA256', 'ACTIONS_READONLY_TOKEN_SHA256',
  'OPERATOR_GATEWAY_TOKEN_SHA256', 'DB_PATH',
] as const
const savedEnv: Record<string, string | undefined> = {}

function setSplitEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.ADMIN_TOKEN_SHA256 = sha(ADMIN_TOKEN)
  process.env.WORKER_TOKEN_SHA256 = sha(WORKER_TOKEN)
  process.env.ACTIONS_READONLY_TOKEN_SHA256 = sha(ACTIONS_TOKEN)
  process.env.OPERATOR_GATEWAY_TOKEN_SHA256 = sha(OPERATOR_TOKEN)
  delete process.env.API_TOKEN
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** 登録 pattern を実 URL にする（`:id` 等を埋める）。 */
function concreteUrl(pattern: string, id = 'x'): string {
  return pattern.replace(/:[A-Za-z]+/g, id).replace(/\*$/, 'x')
}

function tableHash(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[]).map((row) => row.name)
    const hash = createHash('sha256')
    for (const table of tables) {
      hash.update(table)
      hash.update(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()))
    }
    return hash.digest('hex')
  } finally {
    db.close()
  }
}

describe('OPERATOR_GATEWAY authority boundary', () => {
  let app: FastifyInstance
  let storage: IStorage
  let sandbox: string
  let dbPath: string
  const routes: Array<{ method: string; url: string }> = []
  let projectId: string
  let taskId: string

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'operator-gateway-'))
    dbPath = path.join(sandbox, 'db.sqlite')
    process.env.DB_PATH = dbPath
    resetStorage()
    storage = getStorage()

    projectId = storage.projects.create({ name: 'P', goal: 'goal text', designPhilosophy: [], status: 'running' }).id
    taskId = storage.tasks.create({
      projectId, title: 'T', description: 'd', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0]).id
    storage.jobs.create({
      taskId, projectId, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/home/ceo/.ssh' },
      dryRun: false, aiCliPrompt: SECRETS[2],
    } as never)
    const job = storage.jobs.findByTaskId(taskId)[0]!
    // create は実行結果の列を持たないので、Worker が報告した後の状態を update で作る。
    storage.jobs.update(job.id, {
      stdout: SECRETS[0], stderr: `[jobRunner] blocked\n${SECRETS[1]}`, stdoutPath: '/home/ceo/.ssh/out',
    })
    // 前提: 生値が本当に保存されていること（ここが空だと下の「返さない」検査が空振りする）
    expect(storage.jobs.findById(job.id)).toMatchObject({ stdout: SECRETS[0], aiCliPrompt: SECRETS[2] })
    // 別 Task: 1行目が `[jobRunner]` でない stderr で失敗した Job（attention.detail に生の末尾が入る）
    const otherTaskId = storage.tasks.create({
      projectId, title: 'T2', description: 'd', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0]).id
    const failed = storage.jobs.create({
      taskId: otherTaskId, projectId, agentRole: 'developer_ai', status: 'failed',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as never)
    storage.jobs.update(failed.id, { stderr: `npm ERR! auth token=${SECRETS[5]}` })
    // 前提: 既存の /api/state 実体では生の末尾が detail に入っている（ここが崩れたら検査が空振りする）
    expect(JSON.stringify(buildSystemState(storage).attention)).toContain(SECRETS[5])
    // 現在 Task の Design Review が runner の stderr 付きで failed になった状態
    const run = storage.designReviewRuns.create({
      taskId, taskTitle: 'design', designText: 'd', designTextHash: 'h', changedFiles: ['docs/a.md'],
    })
    const claim = storage.designReviewRuns.claim(run.id, 3)
    expect(claim.claimToken).toBeDefined()
    storage.designReviewRuns.complete(
      run.id, claim.claimToken!, 'failed', undefined,
      `runner exited with code 1: proxy https://user:${SECRETS[6]}@proxy.local | runner stderr: ${SECRETS[6]}`,
    )
    expect(JSON.stringify(buildSystemState(storage))).toContain(SECRETS[6])
    storage.qaResults.create({
      taskId, jobId: job.id, type: 'unit_test', status: 'failed', summary: 's', details: SECRETS[4],
    } as never)

    app = Fastify()
    ;(app as unknown as { storageOverride?: IStorage }).storageOverride = storage
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) routes.push({ method, url: route.url })
    })
    app.addHook('preHandler', apiTokenAuth)
    for (const [, plugin, prefix] of REGISTERED) app.register(plugin, { prefix })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    resetStorage()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* sqlite handle */ }
  })

  it('test の登録一覧は index.ts の app.register と一致する（drift 検出）', () => {
    const source = readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8')
    const registered = [...source.matchAll(/app\.register\((\w+),\s*\{\s*prefix:\s*'([^']+)'\s*\}\)/g)]
      .map((m) => `${m[1]} ${m[2]}`)
      .sort()
    expect(REGISTERED.map(([name, , prefix]) => `${name} ${prefix}`).sort()).toEqual(registered)
  })

  it('allowlist の write は POST /api/operator-requests だけ（他は全部 GET）', () => {
    const writes = OPERATOR_GATEWAY_ALLOWLIST.filter((entry) => entry.method !== 'GET')
    expect(writes).toEqual([{ method: 'POST', url: '/api/operator-requests' }])
  })

  it('allowlist の全 entry が実在する route である（死んだ entry が無い）', () => {
    for (const entry of OPERATOR_GATEWAY_ALLOWLIST) {
      expect(routes).toContainEqual(entry)
    }
  })

  it('登録された全 route のうち allowlist 外は、operator token で全部 403', async () => {
    setSplitEnv()
    const outside = routes.filter((r) => !isOperatorGatewayRouteAllowed(r.method, r.url))
    // 代表的な危険 route が本当に列挙に含まれていること（列挙が空振りしていない証拠）
    for (const dangerous of [
      'PATCH /api/approval-requests/:id/status', 'POST /api/tasks/:id/resume', 'PATCH /api/jobs/:id/clear-quarantine',
      'POST /api/design-review-evidence', 'POST /api/pl/tick', 'POST /api/context-pack',
      'PATCH /api/approvals/:id', 'POST /api/projects/:projectId/approvals', 'PATCH /api/tasks/:id',
      'POST /api/jobs', 'GET /api/jobs/:id', 'GET /api/state',
    ]) {
      expect(outside.map((r) => `${r.method} ${r.url}`)).toContain(dangerous)
    }

    const before = tableHash(dbPath)
    for (const route of outside) {
      const res = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        headers: bearer(OPERATOR_TOKEN),
        ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { payload: {} }),
      })
      expect({ route: `${route.method} ${route.url}`, status: res.statusCode })
        .toEqual({ route: `${route.method} ${route.url}`, status: 403 })
    }
    expect(tableHash(dbPath)).toBe(before)
  })

  it('allowlist 内の read は operator token で通り、副作用が無い', async () => {
    setSplitEnv()
    const before = tableHash(dbPath)
    for (const url of [
      '/api/operator/state', `/api/operator/projects/${projectId}`, '/api/operator/tasks',
      `/api/operator/tasks/${taskId}`, '/api/operator/pl/triage-summary', '/api/operator-requests',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(OPERATOR_TOKEN) })
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 })
    }
    expect(tableHash(dbPath)).toBe(before)
  })

  it('safe read は Job の stdout / stderr / prompt / パス / QA details を返さない', async () => {
    setSplitEnv()
    const bodies: string[] = []
    for (const url of ['/api/operator/state', `/api/operator/tasks/${taskId}`, '/api/operator/tasks']) {
      bodies.push((await app.inject({ method: 'GET', url, headers: bearer(OPERATOR_TOKEN) })).body)
    }
    const all = bodies.join('\n')
    for (const secret of SECRETS) expect(all).not.toContain(secret)

    const detail = JSON.parse(bodies[1]!)
    expect(detail.jobs[0]).toMatchObject({ status: 'blocked', commandKind: 'test' })
    // 比較対象: ADMIN 用の既存 GET は従来どおり生値を返す（既存の応答は変えていない）
    setSplitEnv()
    const adminJob = await app.inject({ method: 'GET', url: `/api/jobs?taskId=${taskId}`, headers: bearer(ADMIN_TOKEN) })
    expect(adminJob.body).toContain(SECRETS[1])
  })

  it('operator token で作った Operator Request は requesterClass=operator_gateway になる', async () => {
    setSplitEnv()
    const res = await app.inject({
      method: 'POST', url: '/api/operator-requests', headers: bearer(OPERATOR_TOKEN),
      payload: { kind: 'question', message: 'なぜ止まっている？', taskId },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ requesterClass: 'operator_gateway', status: 'pending' })
  })

  it('他の credential は operator 用 route へ fallback で入れない（WORKER / ACTIONS_READONLY は 403）', async () => {
    setSplitEnv()
    for (const token of [WORKER_TOKEN, ACTIONS_TOKEN]) {
      const res = await app.inject({ method: 'GET', url: '/api/operator/state', headers: bearer(token) })
      expect(res.statusCode).toBe(403)
    }
  })

  it('OPERATOR_GATEWAY_TOKEN_SHA256 が他 class と同値なら 503（権限の混入を防ぐ）', async () => {
    for (const other of [ADMIN_TOKEN, WORKER_TOKEN, ACTIONS_TOKEN]) {
      setSplitEnv({ OPERATOR_GATEWAY_TOKEN_SHA256: sha(other) })
      const res = await app.inject({ method: 'GET', url: '/api/operator/state', headers: bearer(OPERATOR_TOKEN) })
      expect(res.statusCode).toBe(503)
    }
  })

  it('OPERATOR_GATEWAY_TOKEN_SHA256 が空 token 由来なら 503', async () => {
    setSplitEnv({ OPERATOR_GATEWAY_TOKEN_SHA256: sha('') })
    const res = await app.inject({ method: 'GET', url: '/api/operator/state', headers: bearer('') })
    expect(res.statusCode).toBe(503)
  })

  it('legacy mode では operator token は存在しない扱い（401）', async () => {
    setSplitEnv({
      ADMIN_TOKEN_SHA256: undefined, WORKER_TOKEN_SHA256: undefined, API_TOKEN: 'legacy-token',
    })
    const res = await app.inject({ method: 'GET', url: '/api/operator/state', headers: bearer(OPERATOR_TOKEN) })
    expect(res.statusCode).toBe(401)
  })

  it('未設定なら operator token は 401（ADMIN 等の挙動は変わらない）', async () => {
    setSplitEnv({ OPERATOR_GATEWAY_TOKEN_SHA256: undefined })
    const res = await app.inject({ method: 'GET', url: '/api/operator/state', headers: bearer(OPERATOR_TOKEN) })
    expect(res.statusCode).toBe(401)
    const admin = await app.inject({ method: 'GET', url: '/api/operator/state', headers: bearer(ADMIN_TOKEN) })
    expect(admin.statusCode).toBe(200)
  })
})
