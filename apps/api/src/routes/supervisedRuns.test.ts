/**
 * reconcile route — Worker の既存 poll cycle から叩かれる production 入口。
 *
 * 独立レビュー Step 3 #1 は「`observeAndAdvance()` に production caller が無い」だった。
 * 経路は Worker poll → この route → `reconcileSupervisedDelegations()` であり、
 * ここではその HTTP hop が実際に reconcile を動かすことを確認する。
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetPredicateRegistryForTest } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { supervisedRunRoutes } from './supervisedRuns'
import { launchSupervisedDelegation, setDelegationContinuation } from '../supervision/delegationSupervisor'
import { resetAiDelegationPredicateRegistrationForTest } from '../supervision/aiDelegationPredicate'
import { runDirFor } from '../supervision/runDirectory'

describe('POST /api/supervised-runs/reconcile', () => {
  let app: FastifyInstance
  let storage: IStorage
  let sandbox: string
  let previousRoot: string | undefined

  beforeEach(async () => {
    resetPredicateRegistryForTest()
    resetAiDelegationPredicateRegistrationForTest()
    setDelegationContinuation(undefined)

    sandbox = mkdtempSync(path.join(os.tmpdir(), 'reconcile-route-'))
    previousRoot = process.env.SUPERVISED_RUN_ROOT
    process.env.SUPERVISED_RUN_ROOT = path.join(sandbox, 'runs')

    storage = createSQLiteStorage(path.join(sandbox, 'db.sqlite'))

    app = Fastify()
    ;(app as unknown as { storageOverride?: IStorage }).storageOverride = storage
    app.register(supervisedRunRoutes, { prefix: '/api' })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    if (previousRoot === undefined) delete process.env.SUPERVISED_RUN_ROOT
    else process.env.SUPERVISED_RUN_ROOT = previousRoot
    resetPredicateRegistryForTest()
    resetAiDelegationPredicateRegistrationForTest()
    setDelegationContinuation(undefined)
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows holds the sqlite handle briefly */ }
  })

  it('active な run が無ければ何も起きない', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/supervised-runs/reconcile' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ observed: 0, terminal: 0 })
  })

  it('runDir に formal verdict があれば、この route 経由で terminal 化と continuation まで進む', async () => {
    const launched = launchSupervisedDelegation(
      storage,
      { subjectId: 'route-subject', model: 'm', prompt: 'p', repoRoot: sandbox },
      () => { /* 実際の delegate.sh は起動しない。runDir の内容だけを再現する */ },
    )
    if (launched.status !== 'launched') throw new Error('launch failed')

    const runDir = runDirFor(launched.run.id)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(path.join(runDir, 'delegation.log'), 'work\nAI_TEAM_OS_STATUS:DONE\n')
    writeFileSync(path.join(runDir, 'current_log'), path.join(runDir, 'delegation.log'))
    writeFileSync(path.join(runDir, 'verdict'), 'COMPLETED')

    const fired: string[] = []
    setDelegationContinuation(({ terminalVerdict }) => { fired.push(terminalVerdict) })

    const response = await app.inject({ method: 'POST', url: '/api/supervised-runs/reconcile' })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ observed: 1, terminal: 1 })

    const finished = storage.supervisedRuns.findById(launched.run.id)!
    expect(finished.status).toBe('succeeded')
    expect(finished.terminalVerdict).toBe('COMPLETED')
    expect(fired).toEqual(['COMPLETED'])
  })
})
