import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apiTokenAuth } from '../../api/src/auth/apiToken'
import { operatorRequestRoutes } from '../../api/src/routes/operatorRequests'
import { approvalGateRoutes } from '../../api/src/routes/approvalGate'
import { createSQLiteStorage } from '../../api/src/storage/sqlite'
import type { IStorage } from '../../api/src/storage/interface'
import { resetStorage } from '../../api/src/storage'
import { resetPlLoopInFlightForTest, runPlTick } from '../../api/src/pl/executionLoop'
import { createAiteamosClient } from './aiteamosClient.js'
import { createGatewayServer } from './server.js'
import type { GatewayConfig } from './config.js'

/**
 * D5（ローカル接続テスト）: MCP client → gateway（実 HTTP）→ AIteamOS API（実 認証 hook・
 * 実 Operator route）→ PL tick が回答 → MCP client が結果を読む、の一周。
 *
 * ChatGPT 本体との接続は行わない（公開 HTTPS と本番用の外部認証が要り、CEO 判断待ち）。
 * ここで確かめるのは gateway と AIteamOS の間の境界である:
 * - 外部認証を通らない request は API に一切届かない
 * - API に届く credential は OPERATOR_GATEWAY だけ（外部の bearer は転送されない）
 * - 内部 credential は MCP の応答に現れない
 * - ask_pl は依頼を保存するだけで、回答は PL tick が書く
 */

const sha = (v: string): string => createHash('sha256').update(v, 'utf-8').digest('hex')
const ADMIN = 'e2e-admin'
const WORKER = 'e2e-worker'
const OPERATOR = 'e2e-operator-gateway-INTERNAL'
const EXTERNAL = 'e2e-external-local-bearer'

describe('local MCP connection (D5)', () => {
  let api: FastifyInstance
  let gateway: Server
  let storage: IStorage
  let gatewayUrl: URL
  let taskId: string
  const apiAuthorizations: string[] = []
  const savedEnv = { ...process.env }

  beforeAll(async () => {
    process.env.ADMIN_TOKEN_SHA256 = sha(ADMIN)
    process.env.WORKER_TOKEN_SHA256 = sha(WORKER)
    process.env.OPERATOR_GATEWAY_TOKEN_SHA256 = sha(OPERATOR)
    delete process.env.API_TOKEN
    delete process.env.ACTIONS_READONLY_TOKEN_SHA256
    // storageOverride を見ずに既定 DB を開く route があるため、ファイルを作らせない。
    process.env.DB_PATH = ':memory:'
    resetStorage()

    storage = createSQLiteStorage(':memory:')
    const projectId = storage.projects.create({ name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running' }).id
    taskId = storage.tasks.create({
      projectId, title: 'T', description: '', status: 'in_progress',
      assignee: 'developer_ai', dependencies: [], roadmapActive: true, phase: 1,
    } as Parameters<IStorage['tasks']['create']>[0]).id

    api = Fastify()
    ;(api as unknown as { storageOverride?: IStorage }).storageOverride = storage
    api.addHook('onRequest', async (req) => { apiAuthorizations.push(req.headers.authorization ?? '') })
    api.addHook('preHandler', apiTokenAuth)
    api.register(operatorRequestRoutes, { prefix: '/api' })
    // 境界の外にある危険 route も同じ API に載せておく（gateway から届かないことを確かめるため）
    api.register(approvalGateRoutes, { prefix: '/api' })
    await api.listen({ port: 0, host: '127.0.0.1' })
    const apiPort = (api.server.address() as AddressInfo).port

    const config: GatewayConfig = {
      host: '127.0.0.1',
      port: 0,
      apiBaseUrl: `http://127.0.0.1:${apiPort}`,
      operatorGatewayToken: OPERATOR,
      externalAuth: { mode: 'local_static_bearer', tokenSha256: sha(EXTERNAL) },
      apiTimeoutMs: 5000,
    }
    // DNS rebinding 保護の allowedHosts に実 port を入れるため、先に listen して port を確定させる。
    const probe = createGatewayServer(config, createAiteamosClient(config as never))
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const finalConfig = { ...config, port }
    gateway = createGatewayServer(finalConfig, createAiteamosClient({
      apiBaseUrl: finalConfig.apiBaseUrl, operatorGatewayToken: OPERATOR, timeoutMs: 5000,
    }))
    await new Promise<void>((resolve) => gateway.listen(port, '127.0.0.1', resolve))
    gatewayUrl = new URL(`http://127.0.0.1:${port}/mcp`)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await api.close()
    resetStorage()
    process.env = savedEnv
  })

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'e2e', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(gatewayUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    return client
  }

  it('外部認証を通らない request は API に一切届かない', async () => {
    const before = apiAuthorizations.length
    await expect(connect('wrong-token')).rejects.toThrow()
    expect(apiAuthorizations.length).toBe(before)
  })

  it('tools を列挙し、state を読み、ask_pl → PL 回答 → 結果取得まで一周できる', async () => {
    const client = await connect(EXTERNAL)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(8)

      const state = await client.callTool({ name: 'get_system_state', arguments: {} })
      expect(state.isError).toBeFalsy()
      const stateText = (state.content as Array<{ text: string }>)[0]!.text
      expect(JSON.parse(stateText)).toHaveProperty('attention')

      const asked = await client.callTool({ name: 'ask_pl', arguments: { message: 'なぜ止まっている？', taskId } })
      expect(asked.isError).toBeFalsy()
      const request = JSON.parse((asked.content as Array<{ text: string }>)[0]!.text)
      expect(request).toMatchObject({ status: 'pending', requesterClass: 'operator_gateway', taskId })

      // PL が次の tick で答える（回答生成は stub。provider を呼ばない）
      resetPlLoopInFlightForTest()
      const tick = await runPlTick(storage, {
        readLedger: () => '',
        escalate: async () => {},
        answerOperatorRequest: async () => JSON.stringify({ disposition: 'answered', response: 'Job が blocked のためです' }),
      })
      expect(tick.status).toBe('operator_request_handled')

      const answered = await client.callTool({ name: 'get_operator_request', arguments: { requestId: request.id } })
      expect(JSON.parse((answered.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        status: 'answered', disposition: 'answered', response: 'Job が blocked のためです',
      })

      // 存在しない依頼は tool のエラーとして返る（API の 404）
      const missing = await client.callTool({ name: 'get_operator_request', arguments: { requestId: 'nope' } })
      expect(missing.isError).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('API に届いた credential は OPERATOR_GATEWAY だけで、外部 bearer は転送されない', () => {
    expect(apiAuthorizations.length).toBeGreaterThan(0)
    expect(new Set(apiAuthorizations)).toEqual(new Set([`Bearer ${OPERATOR}`]))
  })

  it('MCP の応答に内部 credential が現れない（エラー時も）', async () => {
    const client = await connect(EXTERNAL)
    try {
      const outputs: string[] = []
      for (const [name, args] of [
        ['get_system_state', {}], ['get_task', { taskId: 'missing' }], ['list_operator_requests', {}],
      ] as const) {
        const result = await client.callTool({ name, arguments: args })
        outputs.push(JSON.stringify(result))
      }
      expect(outputs.join('\n')).not.toContain(OPERATOR)
    } finally {
      await client.close()
    }
  })

  it('operator credential で危険 route を直接叩いても 403（gateway を経由しなくても境界は API 側にある）', async () => {
    const address = api.server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${address.port}/api/approval-requests/x/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'APPROVED' }),
    })
    expect(res.status).toBe(403)
  })
})
