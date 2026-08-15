import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isWorkerRouteAllowed } from './workerAllowlist'

const BEARER_PREFIX = 'Bearer '

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

/** 長さが異なる場合はtimingSafeEqualが例外を投げるため、事前に長さを揃えてから比較する。 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Authorization: Bearer <token> を検証する。
 *
 * auth modeは`ADMIN_TOKEN_SHA256`/`WORKER_TOKEN_SHA256`の設定状態だけで決まる
 * （both-or-neither invariant）:
 *
 * - **両方とも未設定** → legacy mode。既存の`API_TOKEN`単一credential方式（全route許可）。
 *   `API_TOKEN`自体も未設定なら認証を行わない（ローカル開発）
 * - **両方とも設定** → split credential mode。ADMINは全route許可、WORKERはmethod +
 *   route pattern（`req.routeOptions.url`）のallowlist（`./workerAllowlist`）のみ許可し
 *   allowlist外はDefault Deny（403）。平文tokenはVPS上に保存しない設計を前提とし、API側は
 *   SHA-256ハッシュのみを保持する
 * - **片方だけ設定** → invalid configuration。設定ミスとして全requestを503で拒否する
 *   （fail closed。片側credentialだけ有効な中途半端な状態でProductionを動かさない）
 *
 * split credential modeでは旧`API_TOKEN`は（値がenvに残っていても）認証に使えない。
 * legacyとsplitの共存・段階的移行は成立しないため、Production cutoverは計画停止を伴う。
 */
export async function apiTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // 空文字は「未設定」として扱う（`ADMIN_TOKEN_SHA256=`のような設定漏れで、
  // どのtokenとも一致しないcredentialが有効扱いになるのを防ぐ）。
  const adminTokenHash = process.env.ADMIN_TOKEN_SHA256 || undefined
  const workerTokenHash = process.env.WORKER_TOKEN_SHA256 || undefined

  if (adminTokenHash === undefined && workerTokenHash === undefined) {
    await legacySingleTokenAuth(req, reply)
    return
  }

  // both-or-neither invariant: 片方だけ設定された状態は設定ミスとして扱い、
  // 全requestをfail closedで拒否する（片側credentialだけ有効な中途半端な状態で
  // Productionを動かさない）。
  if (adminTokenHash === undefined || workerTokenHash === undefined) {
    reply.status(503).send({
      error: 'Server auth configuration is invalid: ADMIN_TOKEN_SHA256 and WORKER_TOKEN_SHA256 must both be set, or both be unset',
    })
    return
  }

  // 同一hashが設定された場合、WORKER tokenがADMIN判定にも一致してしまいauthority
  // separationが無効化される。設定ミスとしてfail closedで拒否する。
  if (timingSafeStringEqual(adminTokenHash, workerTokenHash)) {
    reply.status(503).send({
      error: 'Server auth configuration is invalid: ADMIN_TOKEN_SHA256 and WORKER_TOKEN_SHA256 must not be the same value',
    })
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: 'Authorization header required' })
    return
  }

  const tokenHash = sha256Hex(authHeader.slice(BEARER_PREFIX.length).trim())

  if (timingSafeStringEqual(tokenHash, adminTokenHash)) {
    return
  }

  if (timingSafeStringEqual(tokenHash, workerTokenHash)) {
    if (isWorkerRouteAllowed(req.routeOptions.method, req.routeOptions.url)) {
      return
    }
    reply.status(403).send({ error: 'Forbidden: route not allowed for WORKER credential' })
    return
  }

  reply.status(401).send({ error: 'Invalid token' })
}

/** ADMIN/WORKERいずれも未設定のときの既存挙動（変更なし）。 */
async function legacySingleTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expectedToken = process.env.API_TOKEN
  if (!expectedToken) return

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: 'Authorization header required' })
    return
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim()
  if (token !== expectedToken) {
    reply.status(401).send({ error: 'Invalid token' })
  }
}
