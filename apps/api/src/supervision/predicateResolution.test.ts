/**
 * 独立レビュー指摘(2026-09-08)への回帰:
 * registry が解決失敗を報告することと、run が terminal になることが別APIだと、
 * 呼び出し側が「解決できなかったが待ち続ける」を選べてしまう。それは C-1 違反そのもの。
 * ここでは **解決失敗が必ず run を terminal にする** ことを pin する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { registerPredicate, resetPredicateRegistryForTest } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { resolvePredicateForRun } from './predicateResolution'

const baseInput = {
  kind: 'ai_delegation' as const,
  subjectId: 'pr-108',
  predicateKey: 'ai_delegation.formal_verdict',
  predicateVersion: 1,
}

describe('resolvePredicateForRun', () => {
  let storage: IStorage

  beforeEach(() => {
    resetPredicateRegistryForTest()
    storage = createSQLiteStorage(path.join(os.tmpdir(), `predicate-resolution-${randomUUID()}.db`))
  })

  afterEach(() => {
    resetPredicateRegistryForTest()
  })

  it('解決できれば評価器を返し、run は running のまま', () => {
    registerPredicate({
      key: baseInput.predicateKey,
      version: 1,
      kind: 'ai_delegation',
      description: 'formal verdict',
      evaluate: async () => ({ outcome: 'satisfied', evidence: {} }),
    })

    const { run, claimToken } = storage.supervisedRuns.create(baseInput)
    const result = resolvePredicateForRun(storage, run, claimToken!)

    expect(result.ok).toBe(true)
    expect(storage.supervisedRuns.findById(run.id)?.status).toBe('running')
  })

  it.each([
    ['未登録の key', () => {/* 何も登録しない */}, 'unknown_key'],
    [
      'version 不一致',
      () => registerPredicate({
        key: baseInput.predicateKey, version: 9, kind: 'ai_delegation',
        description: 'newer', evaluate: async () => ({ outcome: 'satisfied', evidence: {} }),
      }),
      'version_mismatch',
    ],
    [
      '評価器が未登録',
      () => registerPredicate({
        key: baseInput.predicateKey, version: 1, kind: 'ai_delegation', description: 'no evaluator',
      }),
      'no_evaluator',
    ],
  ])('%s → run は fail-closed で terminal になる（待ち続けない・成功にもしない）', (_label, setup, reason) => {
    setup()

    const { run, claimToken } = storage.supervisedRuns.create(baseInput)
    const result = resolvePredicateForRun(storage, run, claimToken!)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.reason).toBe(reason)
      expect(result.terminated).toBe(true)
    }

    const reloaded = storage.supervisedRuns.findById(run.id)!
    expect(reloaded.status).toBe('failed')
    expect(reloaded.terminalVerdict).toBe('fail_closed')
    expect(reloaded.completedAt).toBeTruthy()
  })

  it('stale な token では終端できず、terminated=false で返る（fencing は免除されない）', () => {
    const created = storage.supervisedRuns.create(baseInput)
    const oldToken = created.claimToken!
    storage.supervisedRuns.markStalled(created.run.id, oldToken, 'stalled')
    storage.supervisedRuns.claimForRecovery(created.run.id, 3, 'worker_watchdog')

    const result = resolvePredicateForRun(storage, created.run, oldToken)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.terminated).toBe(false)
    // 旧所有者は終端を書けない。現所有者が改めて終端させる責任を負う。
    expect(storage.supervisedRuns.findById(created.run.id)?.status).toBe('running')
  })
})
