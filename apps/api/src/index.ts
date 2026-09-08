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
import { supervisedRunRoutes } from './routes/supervisedRuns'
import { registerDelegationContinuation } from './supervision/continuation'
import { dashboardRoutes } from './routes/dashboard'
import { approvalGateRoutes } from './routes/approvalGate'
import { knowledgeGraphRoutes } from './routes/knowledgeGraph'
import { healthRoutes } from './routes/health'
import { apiTokenAuth } from './auth/apiToken'
import { recoverAndRekickAtStartup } from './designReview/designReviewCoordinator'
import { recoverInterruptedProjectStarts } from './ctoAi/projectStartWorkflow.js'

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
app.register(supervisedRunRoutes, { prefix: '/api' })
app.register(dashboardRoutes, { prefix: '/api' })
app.register(approvalGateRoutes, { prefix: '/api' })
app.register(knowledgeGraphRoutes, { prefix: '/api' })
app.register(healthRoutes, { prefix: '/api' })

const PORT = Number(process.env.PORT) || 3000

app.listen({ port: PORT, host: process.env.HOST ?? '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }

  // API起動時に1回だけ、前プロセスが残したstale runningのDesign Reviewを回収し再kickする。
  // scheduler/cron/watchdogは追加しない。recoveryが失敗してもAPI起動は継続させる。
  // 2つのrecoveryは**順番に**実行する。並行させると、`focused_review`で中断したProjectの
  // 再開が、まだ回収されていないDesign Review runに対して`not_claimable`を繰り返し、
  // bounded retryを使い切って`blocked`（終端）にしてしまう。Design Review側の回収が
  // 先に終わっていれば、その評価を再利用して正常に続行できる（独立レビュー指摘、2026-09-07）。
  // 委任の終端時に continuation が実際に走るよう、起動時に一度だけ登録する（#110 Step 3）。
  registerDelegationContinuation()
  void recoverAndRekickAtStartup(getStorage())
    .catch((recoveryError) => {
      app.log.error({ err: recoveryError }, 'design review startup recovery failed')
    })
    .then(() => recoverInterruptedProjectStarts(getStorage()))
    .then((result) => {
      if (result.rekicked.length > 0 || result.resumed.length > 0) {
        app.log.info(
          { rekicked: result.rekicked, resumed: result.resumed },
          'project start startup recovery',
        )
      }
    })
    .catch((recoveryError) => app.log.error({ err: recoveryError }, 'project start startup recovery failed'))
})
