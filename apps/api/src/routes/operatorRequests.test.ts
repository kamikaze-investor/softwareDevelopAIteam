import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OPERATOR_REQUEST_MAX_PENDING, OPERATOR_REQUEST_MESSAGE_MAX_LENGTH } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { operatorRequestRoutes } from './operatorRequests'
import { setCredentialClass, type CredentialClass } from '../auth/credentialClass.js'

/**
 * 共通 Operator Interface（D1）。
 *
 * 固定すること:
 * - 依頼の作成は operator_requests への保存**だけ**で、他のテーブルは1行も変わらない
 * - 依頼者の種別は認証結果から決まり、body から自己申告できない
 * - WORKER / ACTIONS_READONLY の credential では作れない（fail-closed）
 * - pending の上限・本文長の上限
 */

/** operator_requests 以外の全テーブルの内容 hash。依頼作成の前後で一致しなければならない。 */
function operationalStateHash(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'operator_requests' ORDER BY name"
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

describe('/api/operator-requests', () => {
  let app: FastifyInstance
  let storage: IStorage
  let sandbox: string
  let dbPath: string
  let credentialClass: CredentialClass | undefined
  let projectId: string
  let taskId: string

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'operator-requests-'))
    dbPath = path.join(sandbox, 'db.sqlite')
    storage = createSQLiteStorage(dbPath)
    projectId = storage.projects.create({ name: 'P', goal: 'g', designPhilosophy: [], status: 'running' }).id
    taskId = storage.tasks.create({
      projectId,
      title: 'T',
      description: '',
      status: 'blocked',
      assignee: 'developer_ai',
      dependencies: [],
      roadmapActive: true,
      phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0]).id

    credentialClass = 'admin'
    app = Fastify()
    ;(app as unknown as { storageOverride?: IStorage }).storageOverride = storage
    // 本番の認証 hook の代わりに、認証結果（credential class）だけを載せる。
    app.addHook('preHandler', async (req) => {
      if (credentialClass !== undefined) setCredentialClass(req, credentialClass)
    })
    app.register(operatorRequestRoutes, { prefix: '/api' })
    await app.ready()
    process.env.API_TOKEN = 'configured'
  })

  afterEach(async () => {
    await app.close()
    delete process.env.API_TOKEN
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* sqlite handle */ }
  })

  function post(body: unknown) {
    return app.inject({ method: 'POST', url: '/api/operator-requests', payload: body as object })
  }

  it('依頼を pending として保存し、operator_requests 以外の state は一切変えない', async () => {
    const before = operationalStateHash(dbPath)

    const res = await post({ kind: 'question', message: '  なぜ止まっている？  ', projectId, taskId })

    expect(res.statusCode).toBe(201)
    const created = JSON.parse(res.body)
    expect(created).toMatchObject({
      requesterClass: 'admin',
      message: 'なぜ止まっている？',
      projectId,
      taskId,
      status: 'pending',
    })
    expect(created.response).toBeUndefined()
    expect(operationalStateHash(dbPath)).toBe(before)
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
  })

  it('依頼者の種別は body から自己申告できない（strict schema で拒否）', async () => {
    const res = await post({ kind: 'question', message: 'hi', requesterClass: 'admin', status: 'answered' })
    expect(res.statusCode).toBe(400)
    expect(storage.operatorRequests.countPending()).toBe(0)
  })

  it('kind は必須で、caller が明示した値がそのまま保存される（question / request 以外は 400）', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/operator-requests', payload: { message: 'hi' } })).statusCode).toBe(400)
    expect((await app.inject({
      method: 'POST', url: '/api/operator-requests', payload: { kind: 'action', message: 'hi' },
    })).statusCode).toBe(400)
    const created = JSON.parse((await post({ kind: 'request', message: 'resume if safe', taskId })).body)
    expect(created).toMatchObject({ kind: 'request', status: 'pending' })
  })

  it('caller は action の種類を指定できない（actionKind 等の field は 400）', async () => {
    for (const extra of [{ actionKind: 'resume_task' }, { action: 'approve' }, { plAction: { status: 'acted' } }]) {
      const res = await post({ kind: 'request', message: 'do it', ...extra })
      expect(res.statusCode).toBe(400)
    }
    expect(storage.operatorRequests.countPending()).toBe(0)
  })

  it('targetKey は形式だけ検査して保存する（実在の確認は PL が処理時に行う）', async () => {
    const ok = await post({ kind: 'request', message: 'resume', targetKey: 'job_blocked:abc-123' })
    expect(JSON.parse(ok.body)).toMatchObject({ targetKey: 'job_blocked:abc-123' })
    for (const bad of ['no-colon', 'job_blocked:../../x', 'JOB:1', 'job_blocked: space']) {
      expect((await post({ kind: 'request', message: 'resume', targetKey: bad })).statusCode).toBe(400)
    }
  })

  it('依頼者の種別は認証結果（legacy）から記録される', async () => {
    credentialClass = 'legacy'
    const res = await post({ kind: 'question', message: 'hi' })
    expect(JSON.parse(res.body).requesterClass).toBe('legacy')
  })

  it.each(['worker', 'actions_readonly'] as const)('%s credential では作れない（403）', async (cls) => {
    credentialClass = cls
    const res = await post({ kind: 'question', message: 'hi' })
    expect(res.statusCode).toBe(403)
    expect(storage.operatorRequests.countPending()).toBe(0)
  })

  it('認証構成があるのに credential class が無い request は fail-closed で 403', async () => {
    credentialClass = undefined
    const res = await post({ kind: 'question', message: 'hi' })
    expect(res.statusCode).toBe(403)
  })

  it('存在しない project / task、他 Project の task は 400', async () => {
    expect((await post({ kind: 'question', message: 'hi', projectId: 'nope' })).statusCode).toBe(400)
    expect((await post({ kind: 'question', message: 'hi', taskId: 'nope' })).statusCode).toBe(400)
    const other = storage.projects.create({ name: 'Q', goal: 'g', designPhilosophy: [], status: 'paused' })
    expect((await post({ kind: 'question', message: 'hi', projectId: other.id, taskId })).statusCode).toBe(400)
  })

  it('空・長すぎる本文は 400', async () => {
    expect((await post({ kind: 'question', message: '   ' })).statusCode).toBe(400)
    expect((await post({ kind: 'question', message: 'x'.repeat(OPERATOR_REQUEST_MESSAGE_MAX_LENGTH + 1) })).statusCode).toBe(400)
  })

  it(`pending が ${OPERATOR_REQUEST_MAX_PENDING} 件に達したら 429`, async () => {
    for (let i = 0; i < OPERATOR_REQUEST_MAX_PENDING; i++) {
      expect((await post({ kind: 'question', message: `q${i}` })).statusCode).toBe(201)
    }
    expect((await post({ kind: 'question', message: 'overflow' })).statusCode).toBe(429)

    // 1件回答されれば再び作れる
    const oldest = storage.operatorRequests.findOldestPending()!
    storage.operatorRequests.complete(oldest.id, { status: 'answered', disposition: 'answered', response: 'ok' })
    expect((await post({ kind: 'question', message: 'after' })).statusCode).toBe(201)
  })

  it('pending の上限は依頼元ごと（外部 Operator が埋めても Mobile の依頼は締め出されない）', async () => {
    credentialClass = 'operator_gateway'
    for (let i = 0; i < OPERATOR_REQUEST_MAX_PENDING; i++) {
      expect((await post({ kind: 'request', message: `q${i}` })).statusCode).toBe(201)
    }
    expect((await post({ kind: 'request', message: 'overflow' })).statusCode).toBe(429)
    credentialClass = 'admin'
    expect((await post({ kind: 'question', message: 'from mobile' })).statusCode).toBe(201)
  })

  it('operator_gateway は自分の依頼だけを読める（Mobile / CEO の依頼は見えない）', async () => {
    credentialClass = 'admin'
    const mobile = JSON.parse((await post({ kind: 'question', message: 'CEO の私的な質問' })).body)
    credentialClass = 'operator_gateway'
    const own = JSON.parse((await post({ kind: 'question', message: 'chatgpt' })).body)

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/operator-requests' })).body)
    expect(list.map((r: { id: string }) => r.id)).toEqual([own.id])
    expect((await app.inject({ method: 'GET', url: `/api/operator-requests/${mobile.id}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/operator-requests/${own.id}` })).statusCode).toBe(200)

    credentialClass = 'admin'
    const all = JSON.parse((await app.inject({ method: 'GET', url: '/api/operator-requests' })).body)
    expect(all).toHaveLength(2)
  })

  it('GET で依頼と回答を読める。一覧は新しい順・status で絞れる', async () => {
    const first = JSON.parse((await post({ kind: 'question', message: 'first' })).body)
    const second = JSON.parse((await post({ kind: 'question', message: 'second' })).body)
    storage.operatorRequests.complete(first.id, { status: 'answered', disposition: 'declined', response: 'できません' })

    const one = await app.inject({ method: 'GET', url: `/api/operator-requests/${first.id}` })
    expect(JSON.parse(one.body)).toMatchObject({ status: 'answered', disposition: 'declined', response: 'できません' })

    const all = JSON.parse((await app.inject({ method: 'GET', url: '/api/operator-requests' })).body)
    expect(all.map((r: { id: string }) => r.id)).toEqual([second.id, first.id])

    const pending = JSON.parse((await app.inject({ method: 'GET', url: '/api/operator-requests?status=pending' })).body)
    expect(pending.map((r: { id: string }) => r.id)).toEqual([second.id])

    expect((await app.inject({ method: 'GET', url: '/api/operator-requests/nope' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/operator-requests?limit=500' })).statusCode).toBe(400)
  })

  it('complete は pending の依頼にしか効かない（二重回答しない）', async () => {
    const created = JSON.parse((await post({ kind: 'question', message: 'q' })).body)
    expect(storage.operatorRequests.complete(created.id, { status: 'failed', error: 'x' })?.status).toBe('failed')
    expect(storage.operatorRequests.complete(created.id, {
      status: 'answered', disposition: 'answered', response: 'late',
    })).toBeUndefined()
    expect(storage.operatorRequests.findById(created.id)?.status).toBe('failed')
  })
})
