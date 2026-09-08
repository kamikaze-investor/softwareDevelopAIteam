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
import { resetPredicateRegistryForTest } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
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
  function writeFakeProvider(behaviour: 'done' | 'silent'): string {
    const bin = path.join(sandbox, 'fake-opencode')
    const body = behaviour === 'done'
      ? `#!/usr/bin/env bash\necho "working on it"\nsleep 1\necho "AI_TEAM_OS_STATUS:DONE"\n`
      : `#!/usr/bin/env bash\nsleep 120\n`
    writeFileSync(bin, body)
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

  /** launcher を**別プロセス**として起動し、終了を待つ。戻り値は runId。 */
  async function launchFromSeparateProcess(subjectId: string, providerBin: string): Promise<string> {
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
})
