import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { apiTokenAuth } from './apiToken'
import { gateEvaluationRoutes } from '../routes/gateEvaluations'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'

/**
 * ACTIONS_READONLY（第3 credential class）の Authority Boundary。
 *
 * 用途は「このcommitはtrusted resulting_commitか？」のexact verificationだけで、
 * write権限もADMIN/WORKERへのfallbackも持たない。
 */

const ADMIN_TOKEN = 'admin-token-value'
const WORKER_TOKEN = 'worker-token-value'
const ACTIONS_TOKEN = 'actions-token-value'

const sha = (v: string): string => createHash('sha256').update(v, 'utf-8').digest('hex')

const ORIGINAL_ENV = { ...process.env }

function setSplitEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.ADMIN_TOKEN_SHA256 = sha(ADMIN_TOKEN)
  process.env.WORKER_TOKEN_SHA256 = sha(WORKER_TOKEN)
  process.env.ACTIONS_READONLY_TOKEN_SHA256 = sha(ACTIONS_TOKEN)
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function seedTrustedCommit(storage: IStorage, resultingCommit: string): void {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [],
  })
  const evidence = storage.gateEvaluations.create({
    taskId: task.id,
    jobId: 'job-1',
    targetBranch: 'ai/task-001',
    targetCommit: 'parent-commit',
    targetDiffHash: 'diff-hash',
    decision: 'ALLOW',
    riskLevel: 'LOW',
    triggeredRules: [],
    policyVersion: 'gate-policy-v1',
    bindingVerification: 'authoritative',
    approvedContentHash: 'manifest-hash',
  })
  storage.gateEvaluations.bindResultingCommit({
    evidenceId: evidence.id, jobId: 'job-1', resultingCommit,
  })
}

async function buildApp(storage: IStorage): Promise<FastifyInstance> {
  const app = Fastify()
  ;(app as unknown as { storageOverride: IStorage }).storageOverride = storage
  app.addHook('preHandler', apiTokenAuth)
  await app.register(gateEvaluationRoutes, { prefix: '/api' })
  // write routeが拒否されることを確認するためのダミー
  app.post('/api/jobs', async () => ({ ok: true }))
  await app.ready()
  return app
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('ACTIONS_READONLY authority boundary', () => {
  let storage: IStorage
  let app: FastifyInstance

  beforeEach(async () => {
    setSplitEnv()
    storage = createSQLiteStorage(':memory:')
    seedTrustedCommit(storage, 'trusted-commit')
    app = await buildApp(storage)
  })

  afterEach(async () => {
    await app.close()
    process.env = { ...ORIGINAL_ENV }
  })

  it('valid trusted commit → 200 / trusted:true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=trusted-commit',
      headers: bearer(ACTIONS_TOKEN),
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.trusted).toBe(true)
    expect(body.resultingCommit).toBe('trusted-commit')
    // 内部情報を返さない
    expect(body.targetDiffHash).toBeUndefined()
    expect(body.triggeredRules).toBeUndefined()
    expect(body.taskId).toBeUndefined()
    expect(body.approvedContentHash).toBeUndefined()
  })

  it('unknown commit → trusted:false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=never-seen',
      headers: bearer(ACTIONS_TOKEN),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).trusted).toBe(false)
  })

  it('resultingCommit未指定 → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit',
      headers: bearer(ACTIONS_TOKEN),
    })
    expect(res.statusCode).toBe(400)
  })

  it('unverified evidence にbindされたcommitはtrustedにならない', async () => {
    const other = createSQLiteStorage(':memory:')
    const project = other.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = other.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    // CASはeligibilityを強制するのでbindできない＝trustedにもならない
    const evidence = other.gateEvaluations.create({
      taskId: task.id, jobId: 'job-x', targetBranch: 'b', targetCommit: 'p',
      targetDiffHash: 'd', decision: 'ALLOW', riskLevel: 'LOW', triggeredRules: [],
      policyVersion: 'v1', bindingVerification: 'unverified', approvedContentHash: 'h',
    })
    expect(other.gateEvaluations.bindResultingCommit({
      evidenceId: evidence.id, jobId: 'job-x', resultingCommit: 'unverified-commit',
    })).toBe(false)

    const otherApp = await buildApp(other)
    const res = await otherApp.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=unverified-commit',
      headers: bearer(ACTIONS_TOKEN),
    })
    expect(JSON.parse(res.body).trusted).toBe(false)
    await otherApp.close()
  })

  it('BLOCKED evidence はtrustedにならない', async () => {
    const other = createSQLiteStorage(':memory:')
    const project = other.projects.create({
      name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = other.tasks.create({
      projectId: project.id, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [],
    })
    const evidence = other.gateEvaluations.create({
      taskId: task.id, jobId: 'job-y', targetBranch: 'b', targetCommit: 'p',
      targetDiffHash: 'd', decision: 'BLOCKED', riskLevel: 'HIGH', triggeredRules: [],
      policyVersion: 'v1', bindingVerification: 'authoritative', approvedContentHash: 'h',
    })
    expect(other.gateEvaluations.bindResultingCommit({
      evidenceId: evidence.id, jobId: 'job-y', resultingCommit: 'blocked-commit',
    })).toBe(false)

    const otherApp = await buildApp(other)
    const res = await otherApp.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=blocked-commit',
      headers: bearer(ACTIONS_TOKEN),
    })
    expect(JSON.parse(res.body).trusted).toBe(false)
    await otherApp.close()
  })

  it('token無しは401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=trusted-commit',
    })
    expect(res.statusCode).toBe(401)
  })

  it('WORKER tokenではverification routeを使えない（403）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=trusted-commit',
      headers: bearer(WORKER_TOKEN),
    })
    expect(res.statusCode).toBe(403)
  })

  it('ACTIONS_READONLY tokenでwrite routeを使えない（403）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: bearer(ACTIONS_TOKEN),
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('ADMIN tokenは既存どおり全route許可（semantics不変）', async () => {
    const verify = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=trusted-commit',
      headers: bearer(ADMIN_TOKEN),
    })
    const write = await app.inject({
      method: 'POST', url: '/api/jobs', headers: bearer(ADMIN_TOKEN), payload: {},
    })
    expect(verify.statusCode).toBe(200)
    expect(write.statusCode).toBe(200)
  })

  it('ACTIONS_READONLY未設定でも既存ADMIN/WORKERは動く', async () => {
    setSplitEnv({ ACTIONS_READONLY_TOKEN_SHA256: undefined })
    const fresh = await buildApp(storage)

    const admin = await fresh.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=trusted-commit',
      headers: bearer(ADMIN_TOKEN),
    })
    const actions = await fresh.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=trusted-commit',
      headers: bearer(ACTIONS_TOKEN),
    })

    expect(admin.statusCode).toBe(200)
    // 未設定なら ACTIONS_READONLY は存在しない扱い＝ただの不正token
    expect(actions.statusCode).toBe(401)
    await fresh.close()
  })
})

describe('credential hash 衝突は fail-closed', () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app.close()
    process.env = { ...ORIGINAL_ENV }
  })

  it('ACTIONS hash が ADMIN と同値なら503', async () => {
    setSplitEnv({ ACTIONS_READONLY_TOKEN_SHA256: sha(ADMIN_TOKEN) })
    app = await buildApp(createSQLiteStorage(':memory:'))

    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=x',
      headers: bearer(ADMIN_TOKEN),
    })
    expect(res.statusCode).toBe(503)
  })

  it('ACTIONS hash が WORKER と同値なら503', async () => {
    setSplitEnv({ ACTIONS_READONLY_TOKEN_SHA256: sha(WORKER_TOKEN) })
    app = await buildApp(createSQLiteStorage(':memory:'))

    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=x',
      headers: bearer(ACTIONS_TOKEN),
    })
    expect(res.statusCode).toBe(503)
  })

  it('ADMIN と WORKER が同値なら既存どおり503（semantics不変）', async () => {
    setSplitEnv({ WORKER_TOKEN_SHA256: sha(ADMIN_TOKEN) })
    app = await buildApp(createSQLiteStorage(':memory:'))

    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-evaluations/verify-commit?resultingCommit=x',
      headers: bearer(ADMIN_TOKEN),
    })
    expect(res.statusCode).toBe(503)
  })
})
