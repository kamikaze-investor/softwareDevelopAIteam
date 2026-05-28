/**
 * AI Development Team OS — Backend API
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 * このファイルはAIが改変してはならない。
 * 変更が必要な場合はCEO承認が必要。
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'

const app = Fastify({ logger: true })

app.register(cors, {
  origin: true,
})

// Health check
app.get('/health', async () => {
  return { status: 'ok', version: '0.1.0' }
})

// Routes (Phase 1で追加予定)
// app.register(projectRoutes, { prefix: '/api/projects' })
// app.register(taskRoutes, { prefix: '/api/tasks' })
// app.register(jobRoutes, { prefix: '/api/jobs' })
// app.register(dashboardRoutes, { prefix: '/api/dashboard' })

const PORT = Number(process.env.PORT) || 3000

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
