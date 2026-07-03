/**
 * 代表Health Endpoint（VPS App Runtime Standard v1）
 *
 * AIチームOS APIプロセス全体の代表稼働確認エンドポイント。
 * 診断機能ではなく、軽量な生存確認を目的とする。
 * 秘密情報・環境変数の値・内部詳細は一切返さない。
 */

import type { FastifyInstance } from 'fastify'

type RuntimeStatus = 'running' | 'degraded' | 'error' | 'stopped'

interface HealthResponse {
  ok: boolean
  appName: string
  appType: string
  version: string
  environment: string
  startedAt: string
  lastHeartbeatAt: string
  lastSuccessAt: string | null
  lastErrorAt: string | null
  status: RuntimeStatus
  message: string
}

const startedAt = new Date().toISOString()
let lastHeartbeatAt = startedAt

function isOk(status: RuntimeStatus): boolean {
  return status === 'running' || status === 'degraded'
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    lastHeartbeatAt = new Date().toISOString()

    const status: RuntimeStatus = 'running'
    const ok = isOk(status)

    const body: HealthResponse = {
      ok,
      appName: 'ai-team-os',
      appType: 'api',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: process.env.NODE_ENV ?? 'development',
      startedAt,
      lastHeartbeatAt,
      lastSuccessAt: null,
      lastErrorAt: null,
      status,
      message: status,
    }

    return reply.status(ok ? 200 : 503).send(body)
  })
}
