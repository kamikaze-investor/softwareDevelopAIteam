/**
 * AI Development Team OS — Backend API
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 * このファイルはAIが改変してはならない。
 * 変更が必要な場合はCEO承認が必要。
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { getStorage } from './storage'
import { projectRoutes } from './routes/projects'
import { approvalRoutes } from './routes/approvals'
import { taskRoutes } from './routes/tasks'
import { jobRoutes } from './routes/jobs'
import { reviewRoutes, qaRoutes } from './routes/reviews'
import { ctoAiRoutes } from './routes/ctoAi'
import { contextPackRoutes } from './routes/contextPack'
import { developerAiRoutes } from './routes/developerAi'
import { summaryEngineRoutes } from './routes/summaryEngine'
import { permissionGrantRoutes } from './routes/permissionGrants'
import { watchdogEventRoutes } from './routes/watchdogEvents'
import { dashboardRoutes } from './routes/dashboard'
import { approvalGateRoutes } from './routes/approvalGate'
import { knowledgeGraphRoutes } from './routes/knowledgeGraph'
import { healthRoutes } from './routes/health'
import { apiTokenAuth } from './auth/apiToken'

const app = Fastify({ logger: true })

app.register(cors, {
  origin: true,
})

function isHealthCheckUrl(url: string): boolean {
  const pathname = url.split('?')[0]
  return pathname === '/health' || pathname === '/api/health'
}

app.addHook('preHandler', async (req, reply): Promise<void> => {
  if (isHealthCheckUrl(req.url)) return
  await apiTokenAuth(req, reply)
})

getStorage()

// Health check
app.get('/health', async () => {
  return { status: 'ok', version: '0.1.0' }
})

// Routes (Phase 1で追加予定)
app.register(projectRoutes, { prefix: '/api/projects' })
app.register(approvalRoutes, { prefix: '/api' })
app.register(taskRoutes, { prefix: '/api/tasks' })
app.register(jobRoutes, { prefix: '/api/jobs' })
app.register(reviewRoutes, { prefix: '/api/reviews' })
app.register(qaRoutes, { prefix: '/api/qa' })
app.register(ctoAiRoutes, { prefix: '/api/cto' })
app.register(contextPackRoutes, { prefix: '/api/context-pack' })
app.register(developerAiRoutes, { prefix: '/api/developer-ai' })
app.register(summaryEngineRoutes, { prefix: '/api/summary' })
app.register(permissionGrantRoutes, { prefix: '/api' })
app.register(watchdogEventRoutes, { prefix: '/api' })
app.register(dashboardRoutes, { prefix: '/api' })
app.register(approvalGateRoutes, { prefix: '/api' })
app.register(knowledgeGraphRoutes, { prefix: '/api' })
app.register(healthRoutes, { prefix: '/api' })

const PORT = Number(process.env.PORT) || 3000

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
