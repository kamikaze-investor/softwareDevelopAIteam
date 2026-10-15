import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './apiToken.js'
import { getCredentialClass } from './credentialClass.js'

/**
 * `auth-empty-token-hash-accepted` の regression test。
 *
 * 未設定の変数を `printf %s "$X" | sha256sum` すると空文字の SHA-256 になり、64桁の正しい形なので
 * 「設定済み」として split credential mode が成立してしまう。その状態で `Authorization: Bearer `
 * （空 token）を送ると同じ hash に一致し、その credential class が取れていた。
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

const EMPTY_HASH = sha256Hex('')

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.get('/protected', async (req) => ({ credentialClass: getCredentialClass(req) ?? null }))
  await app.ready()
  return app
}

async function call(authorization: string | undefined): Promise<{ statusCode: number; body: string }> {
  const app = await buildApp()
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: authorization === undefined ? {} : { authorization },
    })
    return { statusCode: res.statusCode, body: res.body }
  } finally {
    await app.close()
  }
}

afterEach(() => {
  delete process.env.API_TOKEN
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
  delete process.env.ACTIONS_READONLY_TOKEN_SHA256
})

describe('空 token 由来の credential hash は設定ミスとして 503（fail closed）', () => {
  it('ADMIN_TOKEN_SHA256 が空 token 由来なら、空 token でも正しい WORKER token でも 503', async () => {
    process.env.ADMIN_TOKEN_SHA256 = EMPTY_HASH
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('worker-token')

    const empty = await call('Bearer ')
    expect(empty.statusCode).toBe(503)
    expect(empty.body).not.toContain('admin')

    expect((await call('Bearer worker-token')).statusCode).toBe(503)
  })

  it('WORKER_TOKEN_SHA256 が空 token 由来なら 503', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('admin-token')
    process.env.WORKER_TOKEN_SHA256 = EMPTY_HASH
    expect((await call('Bearer ')).statusCode).toBe(503)
    expect((await call('Bearer admin-token')).statusCode).toBe(503)
  })

  it('ACTIONS_READONLY_TOKEN_SHA256 が空 token 由来でも 503', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('admin-token')
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('worker-token')
    process.env.ACTIONS_READONLY_TOKEN_SHA256 = EMPTY_HASH
    expect((await call('Bearer ')).statusCode).toBe(503)
  })

  it('大文字・前後空白付きの空 token 由来 hash も同じく 503', async () => {
    process.env.ADMIN_TOKEN_SHA256 = ` ${EMPTY_HASH.toUpperCase()} `
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('worker-token')
    expect((await call('Bearer ')).statusCode).toBe(503)
  })
})

describe('正常な split credential mode でも空 token は認証されない', () => {
  it('Bearer の後が空・空白だけなら 401', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('admin-token')
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('worker-token')

    expect((await call('Bearer ')).statusCode).toBe(401)
    expect((await call('Bearer    ')).statusCode).toBe(401)
  })

  it('正しい ADMIN token は従来どおり admin として通る', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('admin-token')
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('worker-token')

    const res = await call('Bearer admin-token')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ credentialClass: 'admin' })
  })
})
