/**
 * supervised_runs storage — Background Task Supervision Contract の共通run state（C-10）。
 *
 * ここで pin する不変条件は、実障害ケース1〜3（roadmap:id=pl-review-process-supervision）が
 * 実際に踏んだ経路そのものである:
 *   - 死んだ所有者が後から成功を書けない（fencing）
 *   - 無期限RUNNINGにならない（bounded recovery / fail-closed）
 *   - 生きているのに stalled 扱いのまま放置されない（進捗観測で回復する）
 *   - process 再起動で running が孤児化しても、失敗と決めつけず診断へ回す
 */

import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createSQLiteStorage, MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS } from './sqlite'
import type { IStorage } from './interface'

const baseInput = {
  kind: 'ai_delegation' as const,
  subjectId: 'pr-108',
  predicateKey: 'ai_delegation.formal_verdict',
  predicateVersion: 1,
}

describe('supervised_runs storage', () => {
  let storage: IStorage
  let dbPath: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `supervised-runs-${randomUUID()}.db`)
    storage = createSQLiteStorage(dbPath)
  })

  describe('create — launch と supervision 登録が不可分', () => {
    it('run行と最初の claimToken を同時に発行する', () => {
      const result = storage.supervisedRuns.create(baseInput)

      expect(result.created).toBe(true)
      expect(result.claimToken).toBeTruthy()
      expect(result.run.status).toBe('running')
      expect(result.run.recoveryAttemptCount).toBe(0)
      expect(result.run.startedAt).toBe(result.run.lastProgressAt)
    })

    it('同一 (kind, subjectId) に active な run があれば作成せず既存を返し、claimToken を発行しない', () => {
      const first = storage.supervisedRuns.create(baseInput)
      const second = storage.supervisedRuns.create(baseInput)

      expect(second.created).toBe(false)
      expect(second.run.id).toBe(first.run.id)
      // 既存の所有権を奪わない。
      expect(second.claimToken).toBeUndefined()
    })

    it('終端済みの run は active ではないので、同じ subject で新しい run を作れる', () => {
      const first = storage.supervisedRuns.create(baseInput)
      storage.supervisedRuns.complete(first.run.id, first.claimToken!, 'succeeded')

      const second = storage.supervisedRuns.create(baseInput)
      expect(second.created).toBe(true)
      expect(second.run.id).not.toBe(first.run.id)
    })
  })

  describe('fencing — 死んだ所有者が後から結果を書けない', () => {
    it('claimToken が一致しない complete は拒否される', () => {
      const { run } = storage.supervisedRuns.create(baseInput)

      expect(storage.supervisedRuns.complete(run.id, 'wrong-token', 'succeeded')).toBe(false)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('running')
    })

    it('recovery で所有権が移ると、旧 claimToken の書き込みは恒久的に無効になる', () => {
      const created = storage.supervisedRuns.create(baseInput)
      const oldToken = created.claimToken!

      storage.supervisedRuns.markStalled(created.run.id, oldToken, 'no progress')
      const recovered = storage.supervisedRuns.claimForRecovery(created.run.id, 'worker_watchdog')

      expect(recovered.claimToken).toBeTruthy()
      expect(recovered.claimToken).not.toBe(oldToken)

      // 旧所有者（死んだはずの wrapper）が後から成功を書こうとしても通らない。
      expect(storage.supervisedRuns.complete(created.run.id, oldToken, 'succeeded')).toBe(false)
      expect(storage.supervisedRuns.findById(created.run.id)?.status).toBe('running')

      // 新しい所有者は書ける。
      expect(storage.supervisedRuns.complete(created.run.id, recovered.claimToken!, 'succeeded')).toBe(true)
    })

    it('所有権を奪われた旧 token は fail-closed 経由でも終端を書けない（独立レビュー指摘 2026-09-08）', () => {
      const created = storage.supervisedRuns.create(baseInput)
      const oldToken = created.claimToken!

      storage.supervisedRuns.markStalled(created.run.id, oldToken, 'no progress')
      const recovered = storage.supervisedRuns.claimForRecovery(created.run.id, 'worker_watchdog')

      // fail-closed も終端書き込みである以上、fencing を免除してはならない。
      // 免除すると claimForRecovery による無効化が骨抜きになる。
      expect(storage.supervisedRuns.failClosed(created.run.id, oldToken, 'stale actor')).toBe(false)
      expect(storage.supervisedRuns.findById(created.run.id)?.status).toBe('running')

      expect(storage.supervisedRuns.failClosed(created.run.id, recovered.claimToken!, 'legit')).toBe(true)
    })

    it('終端済みの run へは、正しい token でも二度目は書けない', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      expect(storage.supervisedRuns.complete(run.id, claimToken!, 'succeeded')).toBe(true)
      expect(storage.supervisedRuns.complete(run.id, claimToken!, 'failed')).toBe(false)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('succeeded')
    })
  })

  describe('progress — PID ではなく実進捗で状態が動く', () => {
    it('進捗を記録すると lastProgressAt が進み、stage / evidence が残る', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)

      const ok = storage.supervisedRuns.recordProgress(run.id, claimToken!, {
        currentStage: 'compiling',
        progressSource: 'log_mtime',
        progressEvidence: { bytes: 4096 },
      })

      expect(ok).toBe(true)
      const reloaded = storage.supervisedRuns.findById(run.id)!
      expect(reloaded.currentStage).toBe('compiling')
      expect(reloaded.progressSource).toBe('log_mtime')
      expect(reloaded.progressEvidence).toEqual({ bytes: 4096 })
    })

    it('stalled な run に進捗が観測できたら running へ戻る（生きているのに停止扱いのまま放置しない）', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      storage.supervisedRuns.markStalled(run.id, claimToken!, 'no output for 10m')
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('stalled')

      expect(storage.supervisedRuns.recordProgress(run.id, claimToken!, { currentStage: 'alive again' })).toBe(true)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('running')
    })

    it('終端済みの run には進捗を記録できない', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      storage.supervisedRuns.complete(run.id, claimToken!, 'succeeded')

      expect(storage.supervisedRuns.recordProgress(run.id, claimToken!, { currentStage: 'zombie' })).toBe(false)
    })
  })

  describe('bounded recovery（C-6）— 無期限RUNNINGにしない', () => {
    it('上限までは引き取れ、そのたび recoveryAttemptCount が増える', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      let token = claimToken!

      for (let attempt = 1; attempt <= MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS; attempt++) {
        expect(storage.supervisedRuns.markStalled(run.id, token, 'stalled')).toBe(true)
        const claimed = storage.supervisedRuns.claimForRecovery(run.id, 'delegate_watchdog')
        expect(claimed.claimToken).toBeTruthy()
        expect(claimed.run?.recoveryAttemptCount).toBe(attempt)
        token = claimed.claimToken!
      }

      // 上限超過 → 引き取らず terminal で終わる。RUNNING のまま残さない。
      expect(storage.supervisedRuns.markStalled(run.id, token, 'stalled again')).toBe(true)
      const exhausted = storage.supervisedRuns.claimForRecovery(run.id, 'delegate_watchdog')

      expect(exhausted.exhausted).toBe(true)
      expect(exhausted.claimToken).toBeUndefined()
      const finished = storage.supervisedRuns.findById(run.id)!
      expect(finished.status).toBe('failed')
      expect(finished.terminalVerdict).toBe('recovery_exhausted')
      expect(finished.completedAt).toBeTruthy()
    })

    it('stalled でない run は recovery の対象にならない', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      const claimed = storage.supervisedRuns.claimForRecovery(run.id, 'worker_watchdog')

      expect(claimed.run).toBeUndefined()
      expect(claimed.claimToken).toBeUndefined()
      expect(claimed.exhausted).toBeUndefined()
    })
  })

  describe('fail-closed（D-2）— predicate を解決できない run を放置しない', () => {
    it('現所有者は terminal へ倒せる', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)

      expect(storage.supervisedRuns.failClosed(run.id, claimToken!, 'unknown completion predicate "x"')).toBe(true)
      const failed = storage.supervisedRuns.findById(run.id)!
      expect(failed.status).toBe('failed')
      expect(failed.terminalVerdict).toBe('fail_closed')
      expect(failed.error).toMatch(/unknown completion predicate/)
      expect(failed.completedAt).toBeTruthy()
    })

    it('既に終端した run は fail-closed で書き換えられない', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      storage.supervisedRuns.complete(run.id, claimToken!, 'succeeded')

      expect(storage.supervisedRuns.failClosed(run.id, claimToken!, 'too late')).toBe(false)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('succeeded')
    })
  })

  describe('所有者が死んだ run も終端できる（無期限RUNNINGを塞ぐ完全な経路）', () => {
    it('sweep → recovery → 終端まで、tokenの持ち主が居なくても到達できる', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      // 所有者（wrapper）が死んだ想定。誰も現在の token を持っていない。

      // 1. 監視側が旗を立てる（終端書き込みではないので token 不要）。
      //    ただし「進捗が観測できていない」ことを示す時刻を根拠として渡す必要がある。
      const noProgressSince = new Date(Date.now() + 60_000).toISOString()
      expect(storage.supervisedRuns.markStalledBySupervisor(run.id, 'owner unreachable', noProgressSince)).toBe(true)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('stalled')

      // 2. bounded に所有権を取得する
      const claimed = storage.supervisedRuns.claimForRecovery(run.id, 'worker_watchdog')
      expect(claimed.claimToken).toBeTruthy()

      // 3. 新しい所有者が終端させられる → RUNNING のまま残らない
      expect(storage.supervisedRuns.failClosed(run.id, claimed.claimToken!, 'predicate unresolvable')).toBe(true)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('failed')
    })

    it('markStalledBySupervisor は running のときだけ効き、終端済みの run を巻き戻さない', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      storage.supervisedRuns.complete(run.id, claimToken!, 'succeeded')

      const noProgressSince = new Date(Date.now() + 60_000).toISOString()
      expect(storage.supervisedRuns.markStalledBySupervisor(run.id, 'too late', noProgressSince)).toBe(false)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('succeeded')
    })

    it('進捗が観測できている run は stalled にできない — 健全な run の所有権を奪えない（独立レビュー第2ラウンド）', () => {
      const { run } = storage.supervisedRuns.create(baseInput)

      // run は「今」進捗している。それより前の時刻を根拠にした停止主張は通らない。
      const staleClaim = new Date(Date.now() - 60_000).toISOString()
      expect(storage.supervisedRuns.markStalledBySupervisor(run.id, 'bogus stall claim', staleClaim)).toBe(false)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('running')

      // したがって所有権の横取り（stalled にしてから claimForRecovery）も成立しない。
      const claimed = storage.supervisedRuns.claimForRecovery(run.id, 'opportunistic_actor')
      expect(claimed.claimToken).toBeUndefined()
    })
  })

  describe('DB制約 — status semantics を TypeScript の union だけに頼らない', () => {
    it('未知の status を直接書き込めない', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      const db = new Database(dbPath)
      try {
        expect(() =>
          db.prepare("UPDATE supervised_runs SET status = 'bogus' WHERE id = ?").run(run.id),
        ).toThrow(/CHECK constraint/i)
      } finally {
        db.close()
      }
    })

    it('終端 status なのに completed_at が無い行は作れない', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      const db = new Database(dbPath)
      try {
        expect(() =>
          db.prepare("UPDATE supervised_runs SET status = 'succeeded' WHERE id = ?").run(run.id),
        ).toThrow(/CHECK constraint/i)
      } finally {
        db.close()
      }
    })

    it('active なのに所有者(claim_token)が居ない行は作れない', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      const db = new Database(dbPath)
      try {
        expect(() =>
          db.prepare('UPDATE supervised_runs SET claim_token = NULL WHERE id = ?').run(run.id),
        ).toThrow(/CHECK constraint/i)
      } finally {
        db.close()
      }
    })
  })

  describe('startup recovery — 孤児 run を失敗と決めつけない（C-5 / C-12）', () => {
    it('前プロセスが残した running は failed ではなく stalled になる', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      const later = new Date(Date.now() + 60_000).toISOString()

      const swept = storage.supervisedRuns.markOrphanedRunsStalledAtStartup(later)

      expect(swept.map((r) => r.id)).toEqual([run.id])
      const reloaded = storage.supervisedRuns.findById(run.id)!
      expect(reloaded.status).toBe('stalled')
      expect(reloaded.error).toMatch(/needs diagnosis/)
    })

    it('claimToken を残すので、生きている supervisor は進捗記録で復帰できる', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      const later = new Date(Date.now() + 60_000).toISOString()
      storage.supervisedRuns.markOrphanedRunsStalledAtStartup(later)

      expect(storage.supervisedRuns.recordProgress(run.id, claimToken!, { currentStage: 'still working' })).toBe(true)
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('running')
    })

    it('現プロセスが開始した run は巻き込まない', () => {
      const { run } = storage.supervisedRuns.create(baseInput)
      const earlier = new Date(Date.now() - 60_000).toISOString()

      expect(storage.supervisedRuns.markOrphanedRunsStalledAtStartup(earlier)).toEqual([])
      expect(storage.supervisedRuns.findById(run.id)?.status).toBe('running')
    })
  })

  describe('lookup', () => {
    it('findActive は未終端の run だけを返す', () => {
      const { run, claimToken } = storage.supervisedRuns.create(baseInput)
      expect(storage.supervisedRuns.findActive('ai_delegation', 'pr-108')?.id).toBe(run.id)

      storage.supervisedRuns.complete(run.id, claimToken!, 'succeeded')
      expect(storage.supervisedRuns.findActive('ai_delegation', 'pr-108')).toBeUndefined()
    })

    it('findActiveRuns は running と stalled の両方を返す（監視対象は終端まで）', () => {
      const first = storage.supervisedRuns.create(baseInput)
      const second = storage.supervisedRuns.create({ ...baseInput, kind: 'expo_restart', subjectId: 'manage-master' })
      storage.supervisedRuns.markStalled(second.run.id, second.claimToken!, 'quiet')

      const active = storage.supervisedRuns.findActiveRuns()
      expect(active.map((r) => r.id).sort()).toEqual([first.run.id, second.run.id].sort())
    })
  })
})
