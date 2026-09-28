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
 * - `disabled`（既定）… すべての MCP request を拒否する。**本番接続の認証方式は未決定**なので、
 *   設定しないまま公開しても何も通らない（fail closed）
 * - `local_static_bearer` … ローカル検証専用（D5 接続テスト・MCP Inspector）。固定 token の
 *   SHA-256 と照合する。**loopback に bind するときしか起動できない**
 *
 * ChatGPT の remote MCP connector が受け付ける認証は OAuth 2.1（MCP authorization spec）/
 * No Authentication / Mixed であり、固定 bearer は無い。本番用の OAuth は
 * authorization server（外部 IdP か自前か）の選定が CEO 判断のため、**まだ実装していない**。
 * No Authentication は本番では使わない。
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
