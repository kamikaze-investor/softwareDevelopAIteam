import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiTokenAuth } from './apiToken.js'

/**
 * legacy API_TOKEN方式 と ADMIN/WORKER split credential方式 の切り替え条件（precedence）を
 * 固定するテスト。`apiTokenAuth()`は「ADMIN_TOKEN_SHA256 か WORKER_TOKEN_SHA256 のいずれかが
 * 設定された時点で」split modeへ切り替わり、legacy API_TOKENは（値がenvに残っていても）以後
 * 一切認証に使えなくなる。「新hash設定後も旧API_TOKENと共存できる」という理解は誤りであることを
 * ここで明示的に固定する。
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.get('/protected', async (): Promise<{ data: string }> => ({ data: 'secret' }))
  await app.ready()
  return app
}

afterEach(() => {
  delete process.env.API_TOKEN
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
})

describe('auth mode precedence', () => {
  it('A: ADMIN_TOKEN_SHA256 / WORKER_TOKEN_SHA256 が両方未設定なら legacy API_TOKEN が有効', async () => {
    process.env.API_TOKEN = 'legacy-token'
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer legacy-token' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('B: split credential mode有効時、ADMIN tokenはADMINとして通り、WORKER tokenはWORKERとして通る', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('new-admin-token')
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('new-worker-token')
    const app = await buildApp()
    try {
      const adminRes = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer new-admin-token' },
      })
      expect(adminRes.statusCode).toBe(200)

      // '/protected' はWORKER allowlist（/api/配下の11経路）に含まれないため、
      // WORKER tokenとしては認識されるがrouteがDenyされる（403≠401であることが「credential自体は
      // 有効と判定された」証拠）
      const workerRes = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer new-worker-token' },
      })
      expect(workerRes.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('C: split credential mode有効時、旧legacy API_TOKENの値はenvに残っていても認証に使えない（401）', async () => {
    process.env.API_TOKEN = 'legacy-token'
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('new-admin-token')
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('new-worker-token')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer legacy-token' },
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

/**
 * both-or-neither invariant: 片方のhashだけ設定された状態は「設定ミス」として扱い、
 * 全requestを503で拒否する。片側credentialだけが有効な中途半端な状態でProductionが
 * 動き続けないようにするため（fail closed）。
 */
describe('auth mode precedence — partial configuration は invalid configuration として全拒否', () => {
  it('ADMIN_TOKEN_SHA256のみ設定: 正規ADMIN tokenであっても503（片側だけでは起動状態として認めない）', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('new-admin-token')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer new-admin-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('ADMIN_TOKEN_SHA256のみ設定: legacy API_TOKENへsilent fallbackしない（503）', async () => {
    process.env.API_TOKEN = 'legacy-token'
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('new-admin-token')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer legacy-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('WORKER_TOKEN_SHA256のみ設定: 正規WORKER tokenでallowlist内routeであっても503', async () => {
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('new-worker-token')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer new-worker-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('WORKER_TOKEN_SHA256のみ設定: legacy API_TOKENへsilent fallbackしない（503）', async () => {
    process.env.API_TOKEN = 'legacy-token'
    process.env.WORKER_TOKEN_SHA256 = sha256Hex('new-worker-token')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer legacy-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('片方が空文字の場合も「未設定」として扱い、両方未設定ならlegacy modeになる', async () => {
    process.env.API_TOKEN = 'legacy-token'
    process.env.ADMIN_TOKEN_SHA256 = ''
    process.env.WORKER_TOKEN_SHA256 = ''
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer legacy-token' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('片方だけ空文字（もう片方は設定済み）はpartial configurationとして503', async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex('new-admin-token')
    process.env.WORKER_TOKEN_SHA256 = ''
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer new-admin-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })
})

/**
 * ADMIN_TOKEN_SHA256とWORKER_TOKEN_SHA256に同一値が設定された場合、コード上ADMIN判定が
 * 先に評価されるため、WORKER tokenを送ってもADMINとして通過してしまいauthority separation
 * が丸ごと無効化される。これは今回の安全装置の核心を破る設定ミスのため、invalid
 * configurationとしてfail closed（503）にする。
 */
describe('auth mode precedence — ADMIN/WORKER hashが同一値の場合はinvalid configuration', () => {
  it('両hash同値: ADMIN tokenを送っても503', async () => {
    const sameHash = sha256Hex('shared-token')
    process.env.ADMIN_TOKEN_SHA256 = sameHash
    process.env.WORKER_TOKEN_SHA256 = sameHash
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer shared-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('両hash同値: WORKER想定tokenを送っても503（ADMINへ昇格しない）', async () => {
    const sameHash = sha256Hex('shared-token')
    process.env.ADMIN_TOKEN_SHA256 = sameHash
    process.env.WORKER_TOKEN_SHA256 = sameHash
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer shared-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('両hash同値: legacy API_TOKENを送っても503（silent fallbackしない）', async () => {
    const sameHash = sha256Hex('shared-token')
    process.env.API_TOKEN = 'legacy-token'
    process.env.ADMIN_TOKEN_SHA256 = sameHash
    process.env.WORKER_TOKEN_SHA256 = sameHash
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer legacy-token' },
      })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })
})
