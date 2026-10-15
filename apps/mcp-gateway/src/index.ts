/**
 * AIteamOS Operator MCP Gateway — ChatGPT 等の MCP client から AIteamOS を安全に読む／PL へ依頼する
 * ための薄い adapter。state も独自 Gate も持たない（`./tools.ts` を参照）。
 *
 * **本番の外部接続はまだ有効化しない**（CEO 判断待ち）。既定の外部認証は `disabled` で、
 * すべての MCP request を拒否する。
 */

import { loadConfig } from './config.js'
import { createAiteamosClient } from './aiteamosClient.js'
import { createGatewayServer } from './server.js'

const config = loadConfig()
const client = createAiteamosClient({
  apiBaseUrl: config.apiBaseUrl,
  operatorGatewayToken: config.operatorGatewayToken,
  timeoutMs: config.apiTimeoutMs,
})

createGatewayServer(config, client).listen(config.port, config.host, () => {
  // token は出さない。
  console.info(`[mcp-gateway] listening on ${config.host}:${config.port} (external auth: ${config.externalAuth.mode})`)
})
