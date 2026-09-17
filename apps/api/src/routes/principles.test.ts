import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { loadEngineeringPrinciples, normalizeAppliedPrinciples, selectPrinciples } from '@ai-team/shared/src/engineeringPrinciples.js'
import type { PrincipleStats } from '../principles/ledger'
import { PRINCIPLE_SENSOR_THRESHOLDS, recordPrincipleApplications } from '../principles/ledger'

/**
 * 集計 route。**新しい metrics backend は無い**ので、既存 SQLite の集計がそのまま出るかだけを見る。
 */

async function buildApp(): Promise<{ app: FastifyInstance; storage: Awaited<ReturnType<typeof importStorage>> }> {
  process.env.DB_PATH = ':memory:'

  const [{ principleRoutes }, storageModule] = await Promise.all([
    import('./principles.js'),
    import('../storage/index.js'),
  ])

  storageModule.resetStorage()
  const storage = storageModule.getStorage()

  const app = Fastify()
  app.register(principleRoutes, { prefix: '/api' })
  await app.ready()
  return { app, storage }
}

async function importStorage() {
  const storageModule = await import('../storage/index.js')
  return storageModule.getStorage()
}

function seedProject(storage: Awaited<ReturnType<typeof importStorage>>): string {
  return storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'draft',
  }).id
}

describe('GET /api/principles/stats', () => {
  it('適用数・CONFLICT 率・未使用原則・センサーを1リクエストで返す', async () => {
    const { app, storage } = await buildApp()
    try {
      const projectId = seedProject(storage)
      const selection = selectPrinciples(undefined, loadEngineeringPrinciples())

      recordPrincipleApplications(storage, { projectId, taskId: 'task-1', reviewRunId: 'run-1' }, {
        focusedReviewResults: [{
          appliedPrinciples: normalizeAppliedPrinciples(
            [{ principleId: 'observation-closes-loop', verdict: 'CONFLICT', reason: 'no threshold' }],
            selection,
          ),
        }],
      })

      const res = await app.inject({ method: 'GET', url: '/api/principles/stats' })
      expect(res.statusCode).toBe(200)

      const stats = JSON.parse(res.body) as PrincipleStats
      const observation = stats.aggregates.find((row) => row.principleId === 'observation-closes-loop')
      expect(observation).toMatchObject({ applications: 1, conflict: 1 })
      expect(observation?.conflictRate).toBe(1)
      expect(stats.unusedPrincipleIds).toContain('boundary-strictness')
      // 閾値未満なのでセンサーは発火していない。
      expect(stats.sensors).toEqual([])

      // **原則本文は返さない。** 正本は Git であり、API から本文を配ると第二の正本になる。
      expect(res.body).not.toContain('an unfalsifiable TODO')
    } finally {
      await app.close()
    }
  })

  it('projectId / reviewStage で絞り込める', async () => {
    const { app, storage } = await buildApp()
    try {
      const projectA = seedProject(storage)
      const projectB = seedProject(storage)
      const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
      const applied = normalizeAppliedPrinciples([], selection)

      recordPrincipleApplications(storage, { projectId: projectA, taskId: 't-a', reviewRunId: 'run-a' }, {
        focusedReviewResults: [{ appliedPrinciples: applied }],
      })
      recordPrincipleApplications(storage, { projectId: projectB, taskId: 't-b', reviewRunId: 'run-b' }, {
        independentReviewResult: { appliedPrinciples: applied },
      })

      const onlyA = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/principles/stats?projectId=${projectA}` })).body,
      ) as PrincipleStats
      expect(onlyA.aggregates.reduce((sum, row) => sum + row.applications, 0)).toBe(selection.length)

      const onlyIndependent = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/principles/stats?reviewStage=independent' })).body,
      ) as PrincipleStats
      expect(onlyIndependent.aggregates.reduce((sum, row) => sum + row.applications, 0)).toBe(selection.length)
    } finally {
      await app.close()
    }
  })

  it('不正な reviewStage は 400 で落とす', async () => {
    const { app } = await buildApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/principles/stats?reviewStage=not-a-stage' })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('センサーが発火する状態なら stats からも読める', async () => {
    const { app, storage } = await buildApp()
    try {
      const projectId = seedProject(storage)
      const selection = selectPrinciples(undefined, loadEngineeringPrinciples())

      for (let index = 0; index < PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS; index += 1) {
        recordPrincipleApplications(storage, { projectId, taskId: `t-${index}`, reviewRunId: `run-${index}` }, {
          focusedReviewResults: [{
            appliedPrinciples: normalizeAppliedPrinciples(
              selection.map((item) => ({ principleId: item.slug, verdict: 'ALIGNED', reason: 'ok' })),
              selection,
            ),
          }],
        })
      }

      const stats = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/principles/stats' })).body,
      ) as PrincipleStats

      const demotion = stats.sensors.find((finding) => finding.principleId === 'observation-closes-loop')
      expect(demotion?.sensorId).toBe('core-principle-never-conflicts')
      expect(demotion?.thresholdNote).toContain('provisional threshold')
    } finally {
      await app.close()
    }
  })
})
