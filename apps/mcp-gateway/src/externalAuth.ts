import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { GatewayConfig } from './config.js'

/** 空文字の SHA-256。空 token と一致する hash は受け付けない（AIteamOS 側と同じ規則）。 */
const EMPTY_TOKEN_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export type ExternalAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string }

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * 外部（ChatGPT 側）からの request を認証する。**AIteamOS の credential とは無関係**で、
 * ここで受け取った値を API へ転送することは無い。
 */
export function verifyExternalRequest(req: IncomingMessage, auth: GatewayConfig['externalAuth']): ExternalAuthResult {
  if (auth.mode === 'disabled') {
    return {
      ok: false,
      status: 503,
      error: 'External MCP access is disabled: no production authentication method has been configured',
    }
  }

  if (auth.tokenSha256 === EMPTY_TOKEN_SHA256) {
    return { ok: false, status: 503, error: 'External auth is misconfigured' }
  }
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Authorization header required' }
  }
  const token = header.slice('Bearer '.length).trim()
  if (token === '' || !safeEqual(sha256Hex(token), auth.tokenSha256)) {
    return { ok: false, status: 401, error: 'Invalid token' }
  }
  return { ok: true }
}
