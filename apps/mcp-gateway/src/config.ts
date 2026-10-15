/**
 * MCP Gateway の設定。
 *
 * ## 2つの認証を分離する（CEO 方針・2026-09-28）
 *
 * - **外部認証（ChatGPT → この gateway）**: `MCP_EXTERNAL_AUTH_MODE` で決まる
 * - **内部 credential（この gateway → AIteamOS API）**: `AITEAMOS_OPERATOR_GATEWAY_TOKEN`。
 *   AIteamOS の `OPERATOR_GATEWAY` credential の平文で、**この process の外へは出さない**
 *   （MCP の応答にもログにも載せない。外部から受け取った Authorization も API へ転送しない）
 *
 * ## 外部認証のモード
 *
 * - `disabled`（既定）… すべての MCP request を拒否する。設定しないまま起動しても何も通らない
 *   （fail closed）
 * - `local_static_bearer` … 固定 token の SHA-256 と照合する。**loopback に bind するときしか
 *   起動できない**。D5 接続テスト・MCP Inspector に加え、**OpenAI Secure MCP Tunnel 経由の本番接続**に使う
 *   （CEO 判断・2026-09-30）: 同じ host の tunnel-client が `127.0.0.1` へ転送するときに付ける固定 header
 *   （`MCP_EXTRA_HEADERS`）を照合し、他のローカルプロセスを loopback gateway から締め出す。
 *
 * ## 誰が ChatGPT から届けるか（外部の認証境界）
 *
 * Tunnel 経路では、ChatGPT から gateway へ届く主体を決めるのは **OpenAI 側の Tunnel ACL**
 * （tunnel を紐づけた organization / ChatGPT workspace と Tunnels **Use** 権限）であり、この bearer ではない。
 * そのため公開 MCP endpoint・inbound port・独自 OAuth server は作らない。ChatGPT の remote MCP connector を
 * 公開 endpoint へ直接つなぐ構成（OAuth 2.1 / No Authentication / Mixed。固定 bearer は無い）は採らない。
 * 運用手順・rollback は `ops/systemd/README.md` を参照。
 */

export type ExternalAuthMode = 'disabled' | 'local_static_bearer'

export interface GatewayConfig {
  host: string
  port: number
  apiBaseUrl: string
  /** AIteamOS OPERATOR_GATEWAY credential の平文。外へ出さない。 */
  operatorGatewayToken: string
  externalAuth:
    | { mode: 'disabled' }
    | { mode: 'local_static_bearer'; tokenSha256: string }
  /** AIteamOS API 呼び出しの timeout。 */
  apiTimeoutMs: number
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

export class GatewayConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = env.MCP_GATEWAY_HOST || '127.0.0.1'
  const port = Number.parseInt(env.MCP_GATEWAY_PORT ?? '3100', 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new GatewayConfigError('MCP_GATEWAY_PORT is invalid')
  }

  const apiBaseUrl = env.AITEAMOS_API_BASE_URL || 'http://127.0.0.1:3000'
  const operatorGatewayToken = env.AITEAMOS_OPERATOR_GATEWAY_TOKEN ?? ''
  if (operatorGatewayToken.trim() === '') {
    throw new GatewayConfigError('AITEAMOS_OPERATOR_GATEWAY_TOKEN must be set (the OPERATOR_GATEWAY credential)')
  }

  const mode = (env.MCP_EXTERNAL_AUTH_MODE || 'disabled') as string
  let externalAuth: GatewayConfig['externalAuth']
  if (mode === 'disabled') {
    externalAuth = { mode: 'disabled' }
  } else if (mode === 'local_static_bearer') {
    if (!isLoopbackHost(host)) {
      throw new GatewayConfigError('local_static_bearer is for local verification only; bind MCP_GATEWAY_HOST to loopback')
    }
    const tokenSha256 = (env.MCP_LOCAL_BEARER_TOKEN_SHA256 ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(tokenSha256)) {
      throw new GatewayConfigError('MCP_LOCAL_BEARER_TOKEN_SHA256 must be a SHA-256 hex digest')
    }
    externalAuth = { mode: 'local_static_bearer', tokenSha256 }
  } else {
    // 未知のモード（例: 未実装の oauth）で起動させない。
    throw new GatewayConfigError(`MCP_EXTERNAL_AUTH_MODE "${mode}" is not supported`)
  }

  return {
    host,
    port,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    operatorGatewayToken,
    externalAuth,
    apiTimeoutMs: 15_000,
  }
}
