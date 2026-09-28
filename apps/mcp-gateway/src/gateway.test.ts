import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { GatewayConfigError, loadConfig } from './config.js'
import { verifyExternalRequest } from './externalAuth.js'
import { createAiteamosClient, type AiteamosClient } from './aiteamosClient.js'
import { buildMcpServer, TOOL_NAMES } from './tools.js'

const sha = (v: string): string => createHash('sha256').update(v, 'utf-8').digest('hex')
const req = (authorization?: string): IncomingMessage =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage

describe('loadConfig', () => {
  const base = { AITEAMOS_OPERATOR_GATEWAY_TOKEN: 'internal' }

  it('既定の外部認証は disabled（何も通さない）', () => {
    expect(loadConfig(base).externalAuth).toEqual({ mode: 'disabled' })
  })

  it('内部 credential が無ければ起動しない', () => {
    expect(() => loadConfig({})).toThrow(GatewayConfigError)
  })

  it('local_static_bearer は loopback 以外では起動しない', () => {
    expect(() => loadConfig({
      ...base, MCP_EXTERNAL_AUTH_MODE: 'local_static_bearer', MCP_GATEWAY_HOST: '0.0.0.0',
      MCP_LOCAL_BEARER_TOKEN_SHA256: sha('x'),
    })).toThrow(/loopback/)
  })

  it('未実装・未知のモード（oauth / none 等）では起動しない', () => {
    for (const mode of ['oauth', 'none', 'no_auth']) {
      expect(() => loadConfig({ ...base, MCP_EXTERNAL_AUTH_MODE: mode })).toThrow(GatewayConfigError)
    }
  })
})

describe('verifyExternalRequest', () => {
  it('disabled ならすべて 503', () => {
    expect(verifyExternalRequest(req('Bearer anything'), { mode: 'disabled' })).toMatchObject({ ok: false, status: 503 })
  })

  it('local_static_bearer: 一致する token だけ通す', () => {
    const auth = { mode: 'local_static_bearer' as const, tokenSha256: sha('local-token') }
    expect(verifyExternalRequest(req('Bearer local-token'), auth)).toEqual({ ok: true })
    expect(verifyExternalRequest(req('Bearer wrong'), auth)).toMatchObject({ ok: false, status: 401 })
    expect(verifyExternalRequest(req(undefined), auth)).toMatchObject({ ok: false, status: 401 })
    expect(verifyExternalRequest(req('Bearer '), auth)).toMatchObject({ ok: false, status: 401 })
  })

  it('空 token 由来の hash は設定ミスとして 503', () => {
    const auth = { mode: 'local_static_bearer' as const, tokenSha256: sha('') }
    expect(verifyExternalRequest(req('Bearer '), auth)).toMatchObject({ ok: false, status: 503 })
  })
})

describe('createAiteamosClient', () => {
  function recordingClient(status = 200, body: unknown = {}) {
    const calls: Array<{ url: string; method: string; authorization: string | undefined; body?: string }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      calls.push({ url, method: init.method ?? 'GET', authorization: headers.authorization, body: init.body as string | undefined })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    const client = createAiteamosClient({
      apiBaseUrl: 'http://api.local', operatorGatewayToken: 'INTERNAL-SECRET', timeoutMs: 1000, fetchImpl,
    })
    return { client, calls }
  }

  it('固定 path だけを呼び、id は encode して path を乗っ取らせない', async () => {
    const { client, calls } = recordingClient()
    await client.getTask('../../approval-requests/x/status')
    await client.getOperatorRequest('a/b?c')
    expect(calls.map((c) => c.url)).toEqual([
      'http://api.local/api/operator/tasks/..%2F..%2Fapproval-requests%2Fx%2Fstatus',
      'http://api.local/api/operator-requests/a%2Fb%3Fc',
    ])
    expect(calls.every((c) => c.authorization === 'Bearer INTERNAL-SECRET')).toBe(true)
  })

  it('ask_pl は POST /api/operator-requests だけ', async () => {
    const { client, calls } = recordingClient(201)
    await client.createOperatorRequest({ message: 'hi', taskId: 't' })
    expect(calls).toEqual([expect.objectContaining({
      url: 'http://api.local/api/operator-requests', method: 'POST', body: JSON.stringify({ message: 'hi', taskId: 't' }),
    })])
  })

  it('エラーに内部 credential を含めない', async () => {
    const { client } = recordingClient(403, { error: 'Forbidden: route not allowed for OPERATOR_GATEWAY credential' })
    await expect(client.getSystemState()).rejects.toThrow('Forbidden')
    await client.getSystemState().catch((error: Error) => {
      expect(error.message).not.toContain('INTERNAL-SECRET')
    })
  })
})

describe('MCP tools', () => {
  it('公開する tool は決めた 8 個だけで、write 系は ask_pl のみ', async () => {
    const fake = new Proxy({}, { get: () => async () => ({}) }) as AiteamosClient
    const server = buildMcpServer(fake)
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    const writable = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)
    expect(writable).toEqual(['ask_pl'])
    expect(tools.every((t) => t.annotations?.destructiveHint === false)).toBe(true)
    await client.close()
  })
})
