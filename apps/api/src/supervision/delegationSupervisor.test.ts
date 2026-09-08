/**
 * Step 3 acceptance — ai_delegation を supervised_runs へ接続する。
 *
 * 各 it は Step 3 で CEO が要求した保証に1対1で対応させてある:
 *   - launch と supervised_run 登録が不可分
 *   - PID aliveだけで healthy 扱いしない
 *   - formal verdict を completion predicate にする
 *   - exit 0 + 空出力 / verdict無しを success にしない
 *   - progress heartbeat
 *   - stale時は診断 → bounded recovery
 *   - stale owner の古い claim_token では terminal を書けない
 *   - duplicate / stale completion を二重採用しない
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { resetPredicateRegistryForTest, SUPERVISED_RUN_STALE_THRESHOLD_MS } from '@ai-team/shared'
import Database from 'better-sqlite3'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  diagnoseAndRecover,
  launchSupervisedDelegation,
  observeAndAdvance,
  setDelegationContinuation,
} from './delegationSupervisor'
import { resetAiDelegationPredicateRegistrationForTest } from './aiDelegationPredicate'

describe('supervised ai_delegation', () => {
  let storage: IStorage
  let dbPath: string
  let workspace: string
  let logPath: string
  let spawnCalls: number

  const launchInput = () => ({
    subjectId: 'pr-108',
    model: 'opencode/big-pickle',
    prompt: 'review this',
    logPath,
    repoRoot: workspace,
  })

  /** delegate.sh を実際には起動せず、起動されたことだけ記録する。 */
  const fakeSpawner = () => {
    spawnCalls += 1
  }

  /** delegate-watchdog.sh が run_dir へ書く内容を再現する。 */
  function writeRunDir(runDir: string, opts: { verdict?: string; logText?: string }): void {
    mkdirSync(runDir, { recursive: true })
    const log = path.join(runDir, 'delegation.log')
    if (opts.logText !== undefined) {
      writeFileSync(log, opts.logText)
      writeFileSync(path.join(runDir, 'current_log'), log)
    }
    if (opts.verdict !== undefined) {
      writeFileSync(path.join(runDir, 'verdict'), opts.verdict)
    }
  }

  function backdateProgress(runId: string, msAgo: number): void {
    const db = new Database(dbPath)
    try {
      db.prepare('UPDATE supervised_runs SET last_progress_at = ? WHERE id = ?')
        .run(new Date(Date.now() - msAgo).toISOString(), runId)
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    resetPredicateRegistryForTest()
    resetAiDelegationPredicateRegistrationForTest()
    spawnCalls = 0
    setDelegationContinuation(undefined)
    dbPath = path.join(os.tmpdir(), `delegation-${randomUUID()}.db`)
    storage = createSQLiteStorage(dbPath)
    workspace = mkdtempSync(path.join(os.tmpdir(), 'delegation-ws-'))
    logPath = path.join(workspace, 'delegation.log')
  })

  afterEach(() => {
    resetPredicateRegistryForTest()
    resetAiDelegationPredicateRegistrationForTest()
    rmSync(workspace, { recursive: true, force: true })
  })

  describe('launch と supervised_run 登録は不可分', () => {
    it('launch すると run 行と claimToken が同時に生まれ、runDir が evidence へ記録される', () => {
      const result = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)

      expect(result.status).toBe('launched')
      if (result.status !== 'launched') return
      expect(spawnCalls).toBe(1)
      expect(result.run.kind).toBe('ai_delegation')
      expect(result.run.supervisor).toBe('delegate_watchdog')

      const stored = storage.supervisedRuns.findById(result.run.id)!
      expect(stored.status).toBe('running')
      expect(stored.progressEvidence?.runDir).toBe(result.runDir)
    })

    it('run 行を作れなければ委任を起動しない — 同一 subject の二重起動を防ぐ', () => {
      launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      const second = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)

      expect(second.status).toBe('already_active')
      // **2回目は spawn されない。** 監視されない委任が増えないこと自体が保証である。
      expect(spawnCalls).toBe(1)
    })

    it('spawn に失敗したら run を RUNNING のまま残さず fail-closed で終端する', () => {
      const result = launchSupervisedDelegation(storage, launchInput(), () => {
        throw new Error('spawn exploded')
      })

      expect(result.status).toBe('launch_failed')
      const stored = storage.supervisedRuns.findById(result.run.id)!
      expect(stored.status).toBe('failed')
      expect(stored.terminalVerdict).toBe('fail_closed')
      expect(stored.error).toMatch(/spawn exploded/)
    })
  })

  describe('completion predicate は formal verdict（PID や exit code ではない）', () => {
    it('verdict がまだ無ければ terminal にならない — 進行中と終了を混同しない', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { logText: 'thinking...' })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome.status).toBe('progressed')
      expect(storage.supervisedRuns.findById(launched.run.id)?.status).toBe('running')
    })

    it('COMPLETED + DONE marker で初めて succeeded になる', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'work\nAI_TEAM_OS_STATUS:DONE\n' })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome).toMatchObject({ status: 'terminal', terminal: 'succeeded', formalVerdict: 'COMPLETED' })
      const stored = storage.supervisedRuns.findById(launched.run.id)!
      expect(stored.status).toBe('succeeded')
      expect(stored.completionEvidence?.formalVerdict).toBe('COMPLETED')
    })

    it('BLOCKED は formal verdict だが success ではない（failed で終端する）', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'ESCALATE:blocked', logText: 'AI_TEAM_OS_STATUS:BLOCKED\n' })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome).toMatchObject({ status: 'terminal', terminal: 'failed' })
      expect(storage.supervisedRuns.findById(launched.run.id)?.terminalVerdict).toBe('ESCALATE:blocked')
    })
  })

  describe('exit 0 + 空出力 / verdict なしを success にしない（実障害ケース1）', () => {
    it('COMPLETED を名乗っても log に DONE marker が無ければ success にならない', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      // 0 byte 出力のまま verdict だけが COMPLETED になっている状態。
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: '' })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome.status).toBe('fail_closed')
      const stored = storage.supervisedRuns.findById(launched.run.id)!
      expect(stored.status).toBe('failed')
      expect(stored.error).toMatch(/no DONE marker/)
    })

    it('未知の verdict 文字列を勝手に成功へ寄せない', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'probably fine?', logText: 'AI_TEAM_OS_STATUS:DONE' })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome.status).toBe('fail_closed')
      expect(storage.supervisedRuns.findById(launched.run.id)?.status).toBe('failed')
    })

    it('run_dir ごと消えていたら判定不能として terminal へ倒す（待ち続けない）', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      rmSync(launched.runDir, { recursive: true, force: true })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome.status).toBe('fail_closed')
      expect(storage.supervisedRuns.findById(launched.run.id)?.status).toBe('failed')
    })
  })

  describe('progress heartbeat（PID ではなく実出力を見る）', () => {
    it('log が伸びたときだけ heartbeat が進む', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')

      writeRunDir(launched.runDir, { logText: 'first output' })
      expect((await observeAndAdvance(storage, launched.run.id, launched.claimToken)).status).toBe('progressed')

      // 出力が増えていなければ heartbeat は進めない（「生きている」の偽装をしない）。
      expect((await observeAndAdvance(storage, launched.run.id, launched.claimToken)).status).toBe('waiting')

      writeRunDir(launched.runDir, { logText: 'first output + more' })
      expect((await observeAndAdvance(storage, launched.run.id, launched.claimToken)).status).toBe('progressed')
    })
  })

  describe('stale 時は診断 → bounded recovery（blind retry しない）', () => {
    it('Case C: 実処理は完了済みだが supervisor が死んだ run を、診断で success として回収する', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')

      // 委任自体は完了していた。だが supervisor が死に、誰も terminal を書かなかった。
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'done\nAI_TEAM_OS_STATUS:DONE\n' })
      backdateProgress(launched.run.id, SUPERVISED_RUN_STALE_THRESHOLD_MS.ai_delegation + 60_000)
      expect(storage.supervisedRuns.markStalledBySupervisor(launched.run.id, 'supervisor gone')).toBe(true)

      const recovered = await diagnoseAndRecover(storage, launched.run.id)

      // blind retry ではなく、まず completion predicate を再評価して回収する。
      expect(recovered).toMatchObject({ status: 'terminal', terminal: 'succeeded' })
      expect(storage.supervisedRuns.findById(launched.run.id)?.status).toBe('succeeded')
    })

    it('recovery が上限を超えたら RUNNING のまま残さず terminal で終える', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { logText: 'no verdict ever' })

      let token = launched.claimToken
      for (let i = 0; i < 3; i++) {
        expect(storage.supervisedRuns.markStalled(launched.run.id, token, 'quiet')).toBe(true)
        const claimed = storage.supervisedRuns.claimForRecovery(launched.run.id, 'delegate_watchdog')
        token = claimed.claimToken!
      }

      expect(storage.supervisedRuns.markStalled(launched.run.id, token, 'quiet')).toBe(true)
      expect(await diagnoseAndRecover(storage, launched.run.id)).toEqual({ status: 'recovery_exhausted' })

      const stored = storage.supervisedRuns.findById(launched.run.id)!
      expect(stored.status).toBe('failed')
      expect(stored.terminalVerdict).toBe('recovery_exhausted')
    })

    it('stalled でない run は recovery の対象にしない', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')

      expect(await diagnoseAndRecover(storage, launched.run.id)).toEqual({ status: 'not_stalled' })
    })
  })

  describe('completion 時の automatic continuation', () => {
    it('終端が durable に確定したら continuation が自動で走る', async () => {
      const fired: Array<{ terminal: string; verdict: string }> = []
      setDelegationContinuation(({ terminal, terminalVerdict }) => {
        fired.push({ terminal, verdict: terminalVerdict })
      })

      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'AI_TEAM_OS_STATUS:DONE' })

      await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(fired).toEqual([{ terminal: 'succeeded', verdict: 'COMPLETED' }])
    })

    it('fencing で弾かれた書き込みからは continuation を呼ばない（二重continuationしない）', async () => {
      const fired: string[] = []
      setDelegationContinuation(({ terminalVerdict }) => { fired.push(terminalVerdict) })

      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'AI_TEAM_OS_STATUS:DONE' })

      await observeAndAdvance(storage, launched.run.id, launched.claimToken)
      // 同じ verdict をもう一度観測しても、終端は既に確定しており fencing で弾かれる。
      await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(fired).toHaveLength(1)
    })

    it('continuation が throw しても終端は巻き戻らない（終端済みなのに誰も知らない状態へ戻さない）', async () => {
      setDelegationContinuation(() => { throw new Error('notification channel down') })

      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'AI_TEAM_OS_STATUS:DONE' })

      const outcome = await observeAndAdvance(storage, launched.run.id, launched.claimToken)

      expect(outcome.status).toBe('terminal')
      expect(storage.supervisedRuns.findById(launched.run.id)?.status).toBe('succeeded')
    })
  })

  describe('stale owner は terminal を書けない / 二重採用しない', () => {
    it('所有権が移った後、旧 claimToken では success を書けない', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      const oldToken = launched.claimToken

      storage.supervisedRuns.markStalled(launched.run.id, oldToken, 'quiet')
      storage.supervisedRuns.claimForRecovery(launched.run.id, 'worker_watchdog')

      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'AI_TEAM_OS_STATUS:DONE' })
      const outcome = await observeAndAdvance(storage, launched.run.id, oldToken)

      expect(outcome.status).toBe('stale_owner')
      expect(storage.supervisedRuns.findById(launched.run.id)?.status).toBe('running')
    })

    it('同じ verdict を二度観測しても二重に終端しない（duplicate completion）', async () => {
      const launched = launchSupervisedDelegation(storage, launchInput(), fakeSpawner)
      if (launched.status !== 'launched') throw new Error('launch failed')
      writeRunDir(launched.runDir, { verdict: 'COMPLETED', logText: 'AI_TEAM_OS_STATUS:DONE' })

      const first = await observeAndAdvance(storage, launched.run.id, launched.claimToken)
      expect(first.status).toBe('terminal')

      const second = await observeAndAdvance(storage, launched.run.id, launched.claimToken)
      expect(second.status).toBe('stale_owner')

      const stored = storage.supervisedRuns.findById(launched.run.id)!
      expect(stored.status).toBe('succeeded')
      expect(stored.terminalVerdict).toBe('COMPLETED')
    })
  })
})
