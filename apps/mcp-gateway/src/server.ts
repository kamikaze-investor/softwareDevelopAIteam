import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isLoopbackHost, type GatewayConfig } from './config.js'
import { verifyExternalRequest } from './externalAuth.js'
import { buildMcpServer } from './tools.js'
import type { AiteamosClient } from './aiteamosClient.js'

/** MCP request body の上限。tool 引数は小さい（依頼本文でも 2000 文字）。 */
const MAX_BODY_BYTES = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

/**
 * **stateless** な Streamable HTTP MCP endpoint（`POST /mcp`）。
 *
 * session も state も持たない。request ごとに MCP server を作って捨てる。
 * 外部認証を通らなければ MCP の処理（initialize / tools/list を含む）に一切到達しない。
 */
export function createGatewayServer(config: GatewayConfig, client: AiteamosClient): Server {
  const loopback = isLoopbackHost(config.host)

  return createServer((req, res) => {
    void (async () => {
      const pathname = (req.url ?? '/').split('?')[0]

      if (pathname === '/health') {
        sendJson(res, 200, { status: 'ok', externalAuth: config.externalAuth.mode })
        return
      }
      if (pathname !== '/mcp') {
        sendJson(res, 404, { error: 'Not found' })
        return
      }

      const auth = verifyExternalRequest(req, config.externalAuth)
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error })
        return
      }

      // stateless: GET（SSE stream）と DELETE（session 終了）は扱わない。
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { error: 'Invalid or too large JSON body' })
        return
      }

      const server = buildMcpServer(client)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        // loopback で動かすときは DNS rebinding を防ぐ（ブラウザ経由の localhost 攻撃）。
        ...(loopback
          ? {
              enableDnsRebindingProtection: true,
              allowedHosts: [`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`],
            }
          : {}),
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
    })
  })
}
