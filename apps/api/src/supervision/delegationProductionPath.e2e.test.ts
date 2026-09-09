/**
 * Step 3 E2E — **実 production 経路**を端から端まで通す。
 *
 * ```
 * launchSupervisedDelegation
 *   → supervised_runs
 *   → delegate.sh                （実スクリプト）
 *   → delegate-watchdog.sh       （実スクリプト。marker検出 → formal verdict生成）
 *   → trusted runDir
 *   → Worker poll の reconcileSupervisedRuns()
 *   → HTTP POST /api/supervised-runs/reconcile   （実 listen した Fastify。app.inject は使わない）
 *   → reconcileSupervisedDelegations
 *   → formal verdict
 *   → supervised_runs terminal
 *   → continuation
 * ```
 *
 * 前回の「Node child を detached したら生き残った」だけの E2E は Acceptance に数えない、
 * という CEO 指示を受けた作り直しである。ここでは実スクリプトと実 DB 行を通す。
 *
 * session-independence は、**launcher を別プロセスとして起動し、それを終了させてから**
 * 別 observer（このテストプロセス）で継続・終端・continuation を確認することで示す。
 */

import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { resetPredicateRegistryForTest, SUPERVISED_RUN_STALE_THRESHOLD_MS } from '@ai-team/shared'
import { createSQLiteStorage, MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { reconcileSupervisedDelegations } from './reconcile'
import { supervisedRunRoutes } from '../routes/supervisedRuns'
import { setDelegationContinuation } from './delegationSupervisor'
import { resetAiDelegationPredicateRegistrationForTest } from './aiDelegationPredicate'
import { runDirFor } from './runDirectory'

// CommonJS 出力へビルドされるため import.meta は使えない。vitest の cwd（apps/api）から遡る。
const REPO_ROOT = path.resolve(process.cwd(), '../..')

/**
 * この E2E は実スクリプト（delegate.sh / delegate-watchdog.sh）を通すため、POSIX 環境が要る。
 *
 * Windows では `delegate-watchdog.sh` の `is_opencode_pid()` が
 * `ps -p <pid> -o args=` で provider process を同定するが、MSYS 上では期待した
 * command line が得られず `pid_mismatch` で即 retry に倒れる（実測）。
 * 既知の DELEG-001（`scripts/delegate-watchdog.test.sh` が Windows で失敗するのと同じ根）である。
 *
 * したがってローカル Windows では skip し、**Linux CI を実測の場とする**。
 */
const BASH_AVAILABLE = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf-8' }).stdout?.trim() === 'ok'
const CAN_RUN_E2E = BASH_AVAILABLE && process.platform !== 'win32'

async function waitFor(check: () => boolean, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

describe.skipIf(!CAN_RUN_E2E)('supervised delegation — production path E2E', () => {
  let sandbox: string
  let dbPath: string
  let runRoot: string
  let storage: IStorage
  let previousRunRoot: string | undefined

  beforeEach(() => {
    resetPredicateRegistryForTest()
    resetAiDelegationPredicateRegistrationForTest()
    setDelegationContinuation(undefined)

    sandbox = mkdtempSync(path.join(os.tmpdir(), 'deleg-e2e-'))
    dbPath = path.join(sandbox, 'ai-team.db')
    runRoot = path.join(sandbox, 'runs')
    previousRunRoot = process.env.SUPERVISED_RUN_ROOT
    process.env.SUPERVISED_RUN_ROOT = runRoot

    storage = createSQLiteStorage(dbPath)
  })

  afterEach(() => {
    if (previousRunRoot === undefined) delete process.env.SUPERVISED_RUN_ROOT
    else process.env.SUPERVISED_RUN_ROOT = previousRunRoot
    resetPredicateRegistryForTest()
    resetAiDelegationPredicateRegistrationForTest()
    setDelegationContinuation(undefined)
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* windows keeps the sqlite handle briefly */ }
  })

  /**
   * 委任先 CLI の代役。`delegate.sh` は `$DELEGATION_OPENCODE_BIN run ...` として起動するので、
   * ファイル名に "opencode" を含めて `delegate-watchdog.sh` の PID 判定にも合わせる。
   */
  type ProviderBehaviour = 'done' | 'silent' | 'vanish' | 'done-then-linger' | 'late-done'

  function writeFakeProvider(behaviour: ProviderBehaviour): string {
    // 振る舞いごとに別ファイルにする（同一 sandbox で複数 provider を使い分けるため）。
    const bin = path.join(sandbox, `fake-opencode-${behaviour}`)
    const bodies: Record<ProviderBehaviour, string> = {
      // 出力し DONE marker を出して終了する。
      done: '#!/usr/bin/env bash\necho "working on it"\nsleep 1\necho "AI_TEAM_OS_STATUS:DONE"\n',
      // 何も出さずに生き続ける。PID は alive だが進捗はゼロ（Case A / E）。
      silent: '#!/usr/bin/env bash\nsleep 300\n',
      // marker を出さず即消える。delegate-watchdog.sh の bounded retry を実際に踏ませる（Case B）。
      vanish: '#!/usr/bin/env bash\nexit 0\n',
      // 実処理は完了しているのに wrapper が残り続ける（Case C / D）。
      'done-then-linger': '#!/usr/bin/env bash\necho "AI_TEAM_OS_STATUS:DONE"\nsleep 300\n',
      // しばらく無出力のあとで DONE を出し、その後も残り続ける。
      // 「先に stalled と判定され、あとから完了が判明する」という Case C / D の順序を
      // 実際の stall 判定経路で作るために使う（inactivity timeout 15s より短く出す）。
      'late-done': '#!/usr/bin/env bash\nsleep 8\necho "AI_TEAM_OS_STATUS:DONE"\nsleep 300\n',
    }
    writeFileSync(bin, bodies[behaviour])
    chmodSync(bin, 0o755)
    return bin
  }

  /**
   * Worker が実際に使う経路で reconcile を1回起こす:
   *   Worker の `reconcileSupervisedRuns()` → HTTP POST /api/supervised-runs/reconcile → route → reconcile
   *
   * 本物の Fastify を listen させ、Worker 側の関数を `API_BASE_URL` 付きで動的 import する。
   * `app.inject()` は HTTP hop を飛ばすので使わない。
   */
  async function reconcileViaWorkerHttpPath(): Promise<{ terminal: number; observed: number }> {
    const app = Fastify()
    ;(app as unknown as { storageOverride?: IStorage }).storageOverride = storage
    app.register(supervisedRunRoutes, { prefix: '/api' })
    await app.listen({ port: 0, host: '127.0.0.1' })

    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind the test API')
    const baseUrl = `http://127.0.0.1:${address.port}`

    // route が実際に何を返したかを取れるよう、同じ HTTP 呼び出しを観測用にも1本通す。
    const observed: { terminal: number; observed: number } = { terminal: 0, observed: 0 }
    try {
      process.env.API_BASE_URL = baseUrl
      // Worker 側の実装を、その module が読む API_BASE_URL 込みで読み込む。
      const workerModule = await import(
        pathToFileURL(path.join(REPO_ROOT, 'apps/worker/src/index.ts')).href
      ) as { reconcileSupervisedRuns: () => Promise<void> }

      await workerModule.reconcileSupervisedRuns()

      // Worker 側は結果を返さない（fire-and-forget）ため、同じ route をもう一度叩いて
      // 「もう active な run が無い」ことを確認する。1回目で terminal 化されていれば observed=0 になる。
      const confirm = await fetch(`${baseUrl}/api/supervised-runs/reconcile`, { method: 'POST' })
      const body = await confirm.json() as { observed: number }
      observed.observed = body.observed
      // 1回目（Worker 経由）で終端していれば、2回目には見えるものが無い。
      observed.terminal = body.observed === 0 ? 1 : 0
    } finally {
      delete process.env.API_BASE_URL
      await app.close()
    }
    return observed
  }

  /**
   * fixture 側で「無出力時間が経過した」状況を作る。
   *
   * **production の stall policy は弱めない**（`SUPERVISED_RUN_STALE_THRESHOLD_MS` は本番値のまま）。
   * 閾値を下げる代わりに `last_progress_at` を十分過去へ戻し、
   * 実際の reconcile / stall 判定経路をそのまま駆動する。
   */
  function backdateProgress(runId: string, msAgo: number): void {
    const db = new Database(dbPath)
    try {
      db.prepare('UPDATE supervised_runs SET last_progress_at = ? WHERE id = ?')
        .run(new Date(Date.now() - msAgo).toISOString(), runId)
    } finally {
      db.close()
    }
  }

  /** 閾値を確実に超える経過時間。 */
  const BEYOND_STALE = SUPERVISED_RUN_STALE_THRESHOLD_MS.ai_delegation + 60_000

  /** launcher を**別プロセス**として起動し、終了を待つ。戻り値は runId。 */
  async function launchFromSeparateProcess(
    subjectId: string,
    providerBin: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const launcherScript = path.join(sandbox, 'launcher.mts')
    const outFile = path.join(sandbox, 'launcher-out.json')

    writeFileSync(launcherScript, `
import { createSQLiteStorage } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'apps/api/src/storage/sqlite.ts')).href)}
import { launchSupervisedDelegation } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'apps/api/src/supervision/delegationSupervisor.ts')).href)}
import { writeFileSync } from 'node:fs'

const storage = createSQLiteStorage(${JSON.stringify(dbPath)})
const result = launchSupervisedDelegation(storage, {
  subjectId: ${JSON.stringify(subjectId)},
  model: 'fake/model',
  prompt: 'do the thing',
  repoRoot: ${JSON.stringify(REPO_ROOT)},
})
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ status: result.status, runId: result.run.id }))
process.exit(0)
`)

    const launcher = spawn('node', ['--import', 'tsx', launcherScript], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SUPERVISED_RUN_ROOT: runRoot,
        DELEGATION_OPENCODE_BIN: providerBin,
        // watchdog を短周期にして E2E を現実的な時間に収める。
        DELEGATION_POLL_INTERVAL_SECONDS: '1',
        DELEGATION_INACTIVITY_TIMEOUT_SECONDS: '15',
        ...extraEnv,
      },
    })

    let launcherOutput = ''
    launcher.stdout?.on('data', (d) => { launcherOutput += String(d) })
    launcher.stderr?.on('data', (d) => { launcherOutput += String(d) })
    const exitCode = await new Promise<number | null>((resolve) => launcher.on('exit', resolve))
    if (exitCode !== 0) {
      throw new Error(`launcher failed (${exitCode}):\n${launcherOutput.slice(0, 3000)}`)
    }

    const parsed = JSON.parse(readFileSync(outFile, 'utf-8')) as { status: string; runId: string }
    expect(parsed.status).toBe('launched')
    return parsed.runId
  }

  it('launcher プロセス終了後も委任が継続し、formal verdict → DB terminal → continuation まで到達する', async () => {
    const providerBin = writeFakeProvider('done')

    // 1. launcher/session から実委任を開始し、2. launcher/session を終了させる。
    const runId = await launchFromSeparateProcess('e2e-subject', providerBin)

    // 3. 別 observer（このプロセス）から継続を確認する。
    //    launcher は既に死んでいるので、以降に起きることはすべて detached 側の仕事である。
    const runDir = runDirFor(runId)
    expect(await waitFor(() => existsSync(path.join(runDir, 'current_log')))).toBe(true)

    // DB 上の row は launcher が作ったもの。launcher が死んでも残っている（durable）。
    expect(storage.supervisedRuns.findById(runId)?.status).toBe('running')

    // 4. delegate-watchdog.sh が marker を検出し formal verdict を生成する。
    const verdictPath = path.join(runDir, 'verdict')
    expect(await waitFor(() => existsSync(verdictPath))).toBe(true)
    expect(readFileSync(verdictPath, 'utf-8').trim()).toBe('COMPLETED')

    // 5-6. **Worker の poll cycle が叩く経路そのもの**で reconcile させる。
    //      reconcileSupervisedDelegations() を直接呼ぶと Worker → HTTP → route の hop を
    //      飛ばしてしまい、production 経路の証明にならない（独立レビュー Step 3 第2ラウンド #3）。
    const continuations: Array<{ terminal: string; verdict: string }> = []
    setDelegationContinuation(({ terminal, terminalVerdict }) => {
      continuations.push({ terminal, verdict: terminalVerdict })
    })

    const summary = await reconcileViaWorkerHttpPath()
    expect(summary.terminal).toBe(1)

    const finished = storage.supervisedRuns.findById(runId)!
    expect(finished.status).toBe('succeeded')
    expect(finished.terminalVerdict).toBe('COMPLETED')
    expect(finished.completionEvidence?.hasDoneMarker).toBe(true)
    expect(finished.completedAt).toBeTruthy()

    expect(continuations).toEqual([{ terminal: 'succeeded', verdict: 'COMPLETED' }])

    // reconcile を再度回しても二重終端・二重continuationにならない。
    const second = await reconcileSupervisedDelegations(storage)
    expect(second.observed).toBe(0)
    expect(continuations).toHaveLength(1)
  }, 90_000)

  it('reconcile は verdict が無い間 run を終端させない（進行中と完了を混同しない）', async () => {
    const providerBin = writeFakeProvider('silent')
    const runId = await launchFromSeparateProcess('e2e-silent', providerBin)

    const runDir = runDirFor(runId)
    expect(await waitFor(() => existsSync(path.join(runDir, 'current_log')))).toBe(true)
    expect(existsSync(path.join(runDir, 'verdict'))).toBe(false)

    await reconcileSupervisedDelegations(storage)

    const run = storage.supervisedRuns.findById(runId)!
    // 終端していないこと。stalled になるのは kind の閾値を超えてからである。
    expect(['running', 'stalled']).toContain(run.status)
    expect(run.completedAt).toBeUndefined()
  }, 90_000)

  /**
   * Acceptance Case A〜E を**実 production 経路**で確認する。
   *
   * 経路はすべて launchSupervisedDelegation → delegate.sh → delegate-watchdog.sh →
   * trusted runDir → Worker poll の reconcileSupervisedRuns() → HTTP → route → reconcile。
   * Worker 側に retry actor は足していない（retry は delegate-watchdog.sh のみ）。
   */
  describe('Acceptance A〜E（実 production 経路）', () => {
    it('Case A: process は生きているが進捗が無い → stalled を検知する', async () => {
      // 無出力のまま生き続ける provider。PID は生きているので「PID alive = healthy」なら見逃す。
      const runId = await launchFromSeparateProcess('e2e-case-a', writeFakeProvider('silent'))
      const runDir = runDirFor(runId)
      expect(await waitFor(() => existsSync(path.join(runDir, 'current_log')))).toBe(true)
      expect(existsSync(path.join(runDir, 'verdict'))).toBe(false)

      // 閾値未満では stalled にしない（健全な run を奪わない）。
      await reconcileViaWorkerHttpPath()
      expect(storage.supervisedRuns.findById(runId)?.status).toBe('running')

      // 閾値を超えた無出力を作ってから、同じ経路で reconcile する。
      backdateProgress(runId, BEYOND_STALE)
      await reconcileViaWorkerHttpPath()

      const run = storage.supervisedRuns.findById(runId)!
      expect(run.status).toBe('stalled')
      expect(run.error).toMatch(/no progress and no verdict/)
    }, 120_000)

    it('Case B: provider が消滅 → delegate-watchdog の bounded retry を経て failed で終端する', async () => {
      // 即座に消える provider。retry は **delegate-watchdog.sh が行う**（Worker 側では retry しない）。
      const runId = await launchFromSeparateProcess(
        'e2e-case-b',
        writeFakeProvider('vanish'),
        { DELEGATION_MAX_RECOVERY_RETRIES: '1' },
      )
      const runDir = runDirFor(runId)

      // watchdog が bounded retry を使い切り、formal verdict を書くところまで実際に走らせる。
      const verdictPath = path.join(runDir, 'verdict')
      expect(await waitFor(() => existsSync(verdictPath))).toBe(true)
      expect(readFileSync(verdictPath, 'utf-8').trim()).toBe('ESCALATE:recovery_exhausted')

      // watchdog が実際に retry したことを確認する（retry actor は watchdog 側だけ）。
      const attempts = Number(readFileSync(path.join(runDir, 'recovery_attempt_count'), 'utf-8').trim())
      expect(attempts).toBeGreaterThanOrEqual(1)

      const continuations: string[] = []
      setDelegationContinuation(({ terminalVerdict }) => { continuations.push(terminalVerdict) })

      await reconcileViaWorkerHttpPath()

      const run = storage.supervisedRuns.findById(runId)!
      expect(run.status).toBe('failed')
      expect(run.terminalVerdict).toBe('ESCALATE:recovery_exhausted')
      expect(run.completedAt).toBeTruthy()
      expect(continuations).toEqual(['ESCALATE:recovery_exhausted'])
    }, 120_000)

    /**
     * 「まだ verdict が無い段階で stalled と判定させ、その後に完了が判明する」順序を
     * **実際の stall 判定経路で**作る。status を直接書き換えるとその経路を迂回してしまうため、
     * backdate → reconcile で reconcile 自身に stalled を立てさせる。
     */
    async function driveToStalledBeforeCompletion(subjectId: string): Promise<string> {
      const runId = await launchFromSeparateProcess(subjectId, writeFakeProvider('late-done'))
      const runDir = runDirFor(runId)
      expect(await waitFor(() => existsSync(path.join(runDir, 'current_log')))).toBe(true)
      // まだ DONE は出ていない（provider は 8 秒待つ）。
      expect(existsSync(path.join(runDir, 'verdict'))).toBe(false)

      backdateProgress(runId, BEYOND_STALE)
      await reconcileViaWorkerHttpPath()
      expect(storage.supervisedRuns.findById(runId)?.status).toBe('stalled')
      return runId
    }

    it('Case C: stalled 判定後に完了が判明 → blind retry せず success として回収する', async () => {
      const runId = await driveToStalledBeforeCompletion('e2e-case-c')
      const runDir = runDirFor(runId)

      // 実処理はこの後で完了する。wrapper（provider）は DONE の後も生き続ける。
      expect(await waitFor(() => existsSync(path.join(runDir, 'verdict')))).toBe(true)
      expect(readFileSync(path.join(runDir, 'verdict'), 'utf-8').trim()).toBe('COMPLETED')

      const continuations: string[] = []
      setDelegationContinuation(({ terminalVerdict }) => { continuations.push(terminalVerdict) })

      // reconcile は stalled を blind retry せず、まず completion predicate を再評価する。
      await reconcileViaWorkerHttpPath()

      const run = storage.supervisedRuns.findById(runId)!
      expect(run.status).toBe('succeeded')
      expect(run.terminalVerdict).toBe('COMPLETED')
      expect(run.completionEvidence?.hasDoneMarker).toBe(true)
      expect(continuations).toEqual(['COMPLETED'])
    }, 150_000)

    it('Case D: stalled → bounded recovery が成功し terminal success + continuation まで進む', async () => {
      const runId = await driveToStalledBeforeCompletion('e2e-case-d')
      const runDir = runDirFor(runId)
      expect(await waitFor(() => existsSync(path.join(runDir, 'verdict')))).toBe(true)

      const continuations: string[] = []
      setDelegationContinuation(({ terminalVerdict }) => { continuations.push(terminalVerdict) })

      await reconcileViaWorkerHttpPath()

      const run = storage.supervisedRuns.findById(runId)!
      // recovery が bounded に所有権を取り直したことが記録に残る（C-9: recovery actor が実在する）。
      expect(run.recoveryAttemptCount).toBeGreaterThanOrEqual(1)
      expect(run.recoveryAttemptCount).toBeLessThanOrEqual(MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS)
      expect(run.supervisor).toBe('delegate_watchdog')
      expect(run.status).toBe('succeeded')
      expect(run.completedAt).toBeTruthy()
      expect(continuations).toEqual(['COMPLETED'])
    }, 150_000)

    it('Case E: recovery 不能 → 無限 RUNNING にせず terminal（recovery_exhausted）で終わる', async () => {
      // verdict を出さないまま生き続ける provider。何度引き取っても完了判定は得られない。
      const runId = await launchFromSeparateProcess('e2e-case-e', writeFakeProvider('silent'))
      const runDir = runDirFor(runId)
      expect(await waitFor(() => existsSync(path.join(runDir, 'current_log')))).toBe(true)

      const continuations: string[] = []
      setDelegationContinuation(({ terminalVerdict }) => { continuations.push(terminalVerdict) })

      // 「無出力 → stalled → 引き取り → やはり無出力」を上限まで繰り返す。
      // 引き取りのたびに lastProgressAt が更新されるので、そのつど fixture 側で過去へ戻す。
      for (let cycle = 0; cycle < MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS + 2; cycle++) {
        if (storage.supervisedRuns.findById(runId)?.status === 'failed') break
        backdateProgress(runId, BEYOND_STALE)
        await reconcileViaWorkerHttpPath()
      }

      const run = storage.supervisedRuns.findById(runId)!
      // RUNNING のまま残らないことが要点である。
      expect(run.status).toBe('failed')
      expect(run.terminalVerdict).toBe('recovery_exhausted')
      expect(run.completedAt).toBeTruthy()
      expect(run.recoveryAttemptCount).toBe(MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS)
    }, 180_000)
  })
})
