/**
 * runContainedCommand の単体テスト。
 *
 * cgroup v2 を実際に作れるのは Linux かつ Worker cgroup が書き込み可能な環境のみなので、
 * 実封じ込めを伴うテストは `isContainmentAvailable()` で gate する。
 * それ以外（可用性判定・命名・結果種別の安全性判定・非対応環境での fail closed）は
 * Windows / Linux どちらでも決定的に検証する。
 */

import { existsSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildCgroupName,
  isContainmentAvailable,
  isContainmentSafe,
  resolveWorkerCgroup,
  runContainedCommand,
  runContainedOrThrow,
  isContainmentInfrastructureError,
  removeCgroupWithRetry,
  CLEANUP_RETRY_DELAYS_MS,
  DEFAULT_DRAIN_MS,
  type RemoveCgroupDeps,
} from './runContainedCommand.js'

const containmentAvailable = isContainmentAvailable()
const describeLinux = containmentAvailable ? describe : describe.skip

/**
 * テストが**意図的に残した** cgroup を後片付けする。
 *
 * `drain_timeout` を再現するテストは `drainMs: 0` で生存子孫を残すため、production と同じく
 * `rmdir` へ到達せず cgroup が残る。production ではそれは Job 自身の cgroup なので無害だが、
 * **AIteamOS 自身を開発する場合（Tier A 自己開発）はテストが Job の cgroup の内側で走る**ため、
 * 残骸が子 cgroup になり、親 Job の `rmdir` が ENOTEMPTY で失敗して Job が quarantine へ落ちる。
 * 2026-09-14 に production で実際に発生した（Job `cd2e90b9`）。
 * ledger: `containment-cleanup-ebusy-quarantine`。
 *
 * 生存子孫がいる可能性があるので、まず `cgroup.kill` してから `populated 0` を待って削除する。
 * 失敗しても**テストは落とさない**（後片付けであって検証対象ではない）。
 */
async function removeLeftoverCgroup(cgroupPath: string | undefined): Promise<void> {
  if (cgroupPath === undefined || !existsSync(cgroupPath)) return
  try {
    writeFileSync(path.join(cgroupPath, 'cgroup.kill'), '1')
  } catch {
    // kill できなくても drain 待ちへ進む
  }
  for (let i = 0; i < 100; i += 1) {
    if (!existsSync(cgroupPath)) return
    try {
      if (readFileSync(path.join(cgroupPath, 'cgroup.events'), 'utf-8').includes('populated 0')) {
        rmdirSync(cgroupPath)
        return
      }
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 念のための保険: このファイルが作った残骸を最後にまとめて掃除する。 */
const createdCgroupPaths = new Set<string>()
afterAll(async () => {
  for (const cgroupPath of createdCgroupPaths) await removeLeftoverCgroup(cgroupPath)
})

describe('isContainmentSafe', () => {
  it('clean と killed のみを安全と判定する', () => {
    expect(isContainmentSafe('clean')).toBe(true)
    expect(isContainmentSafe('killed')).toBe(true)
  })

  it('containment インフラ失敗はすべて安全でないと判定する', () => {
    for (const outcome of [
      'drain_timeout',
      'cleanup_failed',
      'spawn_failed',
      'placement_failed',
      'kill_failed',
      'events_failed',
      'output_overflow',
      'unavailable',
    ] as const) {
      expect(isContainmentSafe(outcome)).toBe(false)
    }
  })
})

/**
 * D / E: 真の placement 失敗を安全側へ格上げしないことの不変条件。
 *
 * `containment-placement-ack-race` の修正は **kill の順序だけ**を変え、分類は一切変えていない。
 * ところが「ACK が本当に無い実行」を実機で作るには placement program か cgroup 権限への
 * 注入口が要り、それは `PLACEMENT_PROGRAM` を組み立てないという既存の安全方針
 * （インジェクション防止）を壊す。そこで、実行時に再現する代わりに
 * **分類が ACK protocol だけを正本にしている**ことをソース不変条件として固定する。
 *
 * ここが崩れるのは「deadline や SIGKILL を placement 成功の証拠に使い始めた」ときであり、
 * それこそがこの修正で最も避けたい退行である。
 */
describe('placement 判定は ACK protocol だけを正本にする（fail-closed 不変条件）', () => {
  // vitest の cwd は package root（apps/worker）。リポジトリ root から実行された場合も拾う。
  const candidates = [
    path.join(process.cwd(), 'src/execution/runContainedCommand.ts'),
    path.join(process.cwd(), 'apps/worker/src/execution/runContainedCommand.ts'),
  ]
  const sourcePath = candidates.find((candidate) => existsSync(candidate))
  const source = sourcePath === undefined ? '' : readFileSync(sourcePath, 'utf-8')

  it('実装ソースを読めている（この describe の前提）', () => {
    expect(sourcePath).toBeDefined()
    expect(source.length).toBeGreaterThan(1_000)
  })

  it('D. placement_failed は ACK の不在からのみ導かれる', () => {
    // 分類の唯一の導出元。ここに別の条件が OR で足されたら落ちる。
    expect(source).toContain('const placementFailed = !placementAcked')
    expect(source.match(/const placementFailed = /g)).toHaveLength(1)

    // `placementAcked` を true にする箇所は 1 つだけで、fd 3 の ACK バイト観測に限る。
    const ackAssignments = source.match(/placementAcked = true/g) ?? []
    expect(ackAssignments).toHaveLength(1)
    const guard = source.slice(
      source.indexOf("ackStream.on('data'"),
      source.indexOf('placementAcked = true'),
    )
    expect(guard).toContain('PLACEMENT_ACK')

    // placement_failed を立てる箇所も 1 つだけ。
    expect(source.match(/outcome: 'placement_failed'/g)).toHaveLength(1)
  })

  it('E. handshake deadline も SIGKILL も placement 成功の証拠にしない', () => {
    // `placed` へ遷移させるのは ACK 観測の 1 箇所だけ。
    const placedTransitions = source.match(/settlePlacement\('placed'\)/g) ?? []
    expect(placedTransitions).toHaveLength(1)
    const beforePlaced = source.slice(0, source.indexOf("settlePlacement('placed')"))
    expect(beforePlaced.lastIndexOf("ackStream.on('data'")).toBeGreaterThan(
      beforePlaced.lastIndexOf("ackStream.on('end'"),
    )

    // deadline は kill を解放するだけで、placement の状態には触れない。
    expect(source).toContain('placementTimer = setTimeout(proceed, PLACEMENT_HANDSHAKE_DEADLINE_MS)')
    const deadlineUses = source.match(/PLACEMENT_HANDSHAKE_DEADLINE_MS/g) ?? []
    // 定義・コメント内の言及・setTimeout の 3 箇所以内。placed への昇格には使われない。
    expect(source).not.toMatch(/PLACEMENT_HANDSHAKE_DEADLINE_MS[\s\S]{0,200}?placementAcked = true/)
    expect(deadlineUses.length).toBeGreaterThanOrEqual(2)

    // signal / SIGKILL を placement の証拠に使っていない。
    expect(source).not.toMatch(/SIGKILL[\s\S]{0,120}?placementAcked/)
    expect(source).not.toMatch(/placementAcked[\s\S]{0,120}?SIGKILL/)

    // 安全判定そのものは不変。
    expect(source).toContain(
      "const SAFE_OUTCOMES: ReadonlySet<ContainmentOutcome> = new Set<ContainmentOutcome>(['clean', 'killed'])",
    )
    // 直接の子全体の close 待ちへは戻していない（生存子孫に引きずられないため）。
    expect(source).not.toContain("child.on('close'")
  })
})

describe('buildCgroupName', () => {
  it('jobId と attemptId の両方を含める（同一 Job の再実行で再利用しない）', () => {
    const first = buildCgroupName('11111111-2222-3333-4444-555555555555', 'a1')
    const second = buildCgroupName('11111111-2222-3333-4444-555555555555', 'a2')
    expect(first).not.toBe(second)
    expect(first).toContain('a1')
  })

  it('cgroup ディレクトリ名に使えない文字を除去する', () => {
    // `.` も許可集合に含めないため、`..` は `__` になる（名前に `..` が残らない）
    expect(buildCgroupName('../escape', 'x/y')).toBe('job-___escape-x_y')
    expect(buildCgroupName('a b', 'c\nd')).toBe('job-a_b-c_d')
  })

  it('パス区切りも相対参照も残さない（親 cgroup へ逃げられない）', () => {
    const name = buildCgroupName('../../root', '..')
    expect(name.includes('/')).toBe(false)
    expect(name.includes('\\')).toBe(false)
    expect(name.includes('..')).toBe(false)
  })
})

describe('resolveWorkerCgroup', () => {
  it('非 Linux では error を返し、path を返さない', () => {
    const resolved = resolveWorkerCgroup()
    if (process.platform === 'linux') {
      // Linux では環境依存（cgroup v1 のこともある）。どちらでも形が正しいことだけ確認する。
      expect('path' in resolved || 'error' in resolved).toBe(true)
    } else {
      expect(resolved).toEqual({ error: expect.stringContaining('linux') })
    }
  })
})

describe('runContainedCommand — containment 非対応環境', () => {
  it('containment を提供できない場合は unavailable を返し、コマンドを実行しない', async () => {
    if (containmentAvailable) return

    const result = await runContainedCommand({
      jobId: 'job-unavailable',
      attemptId: '1',
      // 実行されてしまえば exit 0 になるコマンド。unavailable なら起動されない。
      argv: ['node', '-e', 'process.exit(0)'],
      cwd: process.cwd(),
      env: process.env,
    })

    expect(result.outcome).toBe('unavailable')
    expect(isContainmentSafe(result.outcome)).toBe(false)
    // 起動していないので終了コードは無い（= 封じ込め無しで走っていない証拠）
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toBe('')
  })
})

describeLinux('runContainedCommand — 実 cgroup（Linux のみ）', () => {
  it('正常終了時は clean を返し、cgroup を削除する', async () => {
    const result = await runContainedCommand({
      jobId: 'job-clean',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'echo hello'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
    })

    expect(result.outcome).toBe('clean')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.killedDescendants).toBe(false)
  })

  it('stdin へ input を渡せる', async () => {
    const result = await runContainedCommand({
      jobId: 'job-stdin',
      attemptId: String(Date.now()),
      argv: ['/bin/cat'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      input: 'from-stdin',
    })

    expect(result.outcome).toBe('clean')
    expect(result.stdout).toBe('from-stdin')
  })

  it('子が入力を読まずに終了しても EPIPE で失敗しない', async () => {
    const result = await runContainedCommand({
      jobId: 'job-epipe',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'exit 0'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      input: 'x'.repeat(200_000),
    })

    expect(isContainmentSafe(result.outcome)).toBe(true)
  })

  it('timeout 時は containment kill され、killed を返す', async () => {
    const result = await runContainedCommand({
      jobId: 'job-timeout',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'sleep 60'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 500,
    })

    expect(result.timedOut).toBe(true)
    expect(result.outcome).toBe('killed')
    expect(result.killedDescendants).toBe(true)
  })

  it('直接の子が exit 0 でも、setsid した孫が残っていれば kill してから完了する', async () => {
    // setsid はプロセスグループからは抜けるが cgroup からは抜けない。
    // 直接の子の exit だけを見て完了扱いにする実装は、ここで孫を取り逃がす。
    const result = await runContainedCommand({
      jobId: 'job-daemon',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'setsid sleep 60 >/dev/null 2>&1 < /dev/null & exit 0'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
    })

    expect(result.exitCode).toBe(0)
    expect(result.killedDescendants).toBe(true)
    expect(result.outcome).toBe('killed')
  })

  it('出力が上限を超えた場合は output_overflow で fail closed になる', async () => {
    const result = await runContainedCommand({
      jobId: 'job-overflow',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'head -c 200000 /dev/zero | tr "\\0" "a"'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
    })

    expect(result.outcome).toBe('output_overflow')
    expect(isContainmentSafe(result.outcome)).toBe(false)
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(1024)
  })

  it('abort されたら containment kill される', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)

    const result = await runContainedCommand({
      jobId: 'job-abort',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'sleep 60'],
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
    })

    expect(result.killedDescendants).toBe(true)
    expect(result.outcome).toBe('killed')
  })

  it('存在しないコマンドは spawn_failed ではなく通常のワークロード失敗として現れる', async () => {
    // /bin/sh の exec 失敗は 127。placement 自体は成功しているので containment は安全。
    const result = await runContainedCommand({
      jobId: 'job-missing',
      attemptId: String(Date.now()),
      argv: ['definitely-not-a-real-binary-xyz'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
    })

    expect(isContainmentSafe(result.outcome)).toBe(true)
    expect(result.exitCode).toBe(127)
  })

  it('ワークロード自身の exit 126 を placement 失敗と誤認しない', async () => {
    const result = await runContainedCommand({
      jobId: 'job-126',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'exit 126'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
    })

    expect(result.exitCode).toBe(126)
    expect(result.outcome).not.toBe('placement_failed')
    expect(isContainmentSafe(result.outcome)).toBe(true)
  })

  it('cgroup は削除される（populated 0 確認後の cleanup）', async () => {
    const result = await runContainedCommand({
      jobId: 'job-cleanup',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'echo done'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
    })

    expect(result.outcome).toBe('clean')
    expect(result.cgroupPath).toBeDefined()
    expect(existsSync(result.cgroupPath!)).toBe(false)
  })

  it('drain が期限内に終わらなければ drain_timeout で fail closed になる', async () => {
    // 直接の子は exit 0 だが setsid した孫が残る。drain 期限を 0 にすることで
    // 「kill は出したが populated 0 を確認できなかった」状態を実際に発生させる。
    const result = await runContainedCommand({
      jobId: 'job-drain',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'setsid sleep 30 >/dev/null 2>&1 < /dev/null & exit 0'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      drainMs: 0,
    })

    expect(result.outcome).toBe('drain_timeout')
    expect(isContainmentSafe(result.outcome)).toBe(false)
    expect(result.detail).toContain('still populated')

    // drain_timeout は意図的に cgroup を残すので、テスト側で後片付けする（上記 helper 参照）。
    if (result.cgroupPath !== undefined) createdCgroupPaths.add(result.cgroupPath)
    await removeLeftoverCgroup(result.cgroupPath)
    expect(existsSync(result.cgroupPath!)).toBe(false)
  })

  it('drain_timeout は runContainedOrThrow で例外になる（呼び出し元が握り潰せない）', async () => {
    let thrown: unknown
    await expect(runContainedOrThrow({
      jobId: 'job-drain-throw',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'setsid sleep 30 >/dev/null 2>&1 < /dev/null & exit 0'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      drainMs: 0,
    }).catch((err: unknown) => { thrown = err; throw err })).rejects.toThrow(/drain_timeout/)

    // 例外経路でも cgroup は残るので同様に後片付けする。
    const cgroupPath = isContainmentInfrastructureError(thrown) ? thrown.result.cgroupPath : undefined
    if (cgroupPath !== undefined) createdCgroupPaths.add(cgroupPath)
    await removeLeftoverCgroup(cgroupPath)
    expect(cgroupPath === undefined || !existsSync(cgroupPath)).toBe(true)
  })

  it("既に abort 済みの signal でも bounded に settle する（listener が発火しないケース）", async () => {
    // addEventListener は既に abort 済みの signal を再生しない。timeoutMs 無しの
    // 終了しないコマンドと組み合わせると、kill も drain も走らず永久待機になり得た。
    const controller = new AbortController()
    controller.abort()

    const result = await runContainedCommand({
      jobId: "job-pre-abort",
      attemptId: String(Date.now()),
      argv: ["/bin/sh", "-c", "sleep 60"],
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
      // timeoutMs は敢えて渡さない: abort だけが唯一の停止契機になる
    })

    expect(result.killedDescendants).toBe(true)
    expect(isContainmentSafe(result.outcome)).toBe(true)
  }, 30_000)

  /**
   * A. `containment-placement-ack-race` の回帰。
   *
   * pre-aborted signal では `cgroup.kill` が `spawn()` 直後に撃たれる。修正前は、ラッパが
   * `cgroup.procs` へ参加した直後・`echo ok >&3` の**前**に、その参加によって届いた SIGKILL で
   * 死ぬ経路があり、**placement は成功しているのに ACK が 1 バイトも出ない**まま
   * `placement_failed` へ誤分類された（本番 VPS の delegated cgroup 環境で 38 回中 10 回 = 26%。
   * 10 件すべて「fd3 は end まで到達・raw bytes 0・child は SIGKILL」で、late ACK は 0 件）。
   *
   * 1 回では見えないので連続実行する。ここで守るのは
   * 「placement が成功した実行を `placement_failed` にしない」であって、
   * 真の placement 失敗を安全扱いすることではない。
   */
  it('pre-aborted signal を連続で受けても placement_failed の false positive が出ない', async () => {
    const ITERATIONS = 30
    const outcomes: string[] = []
    for (let i = 0; i < ITERATIONS; i += 1) {
      const controller = new AbortController()
      controller.abort()

      const startedAt = Date.now()
      const result = await runContainedCommand({
        jobId: 'job-pre-abort-loop',
        attemptId: `${Date.now()}-${i}`,
        argv: ['/bin/sh', '-c', 'sleep 60'],
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        // timeoutMs は敢えて渡さない: abort だけが唯一の停止契機になる
      })
      const elapsedMs = Date.now() - startedAt
      outcomes.push(result.outcome)

      // 封じ込めが成立していること（safety assertion は緩めない）
      expect(isContainmentSafe(result.outcome)).toBe(true)
      expect(result.killedDescendants).toBe(true)
      // 子孫が回収され cgroup も消えていること
      expect(result.cgroupPath).toBeDefined()
      if (result.cgroupPath !== undefined) createdCgroupPaths.add(result.cgroupPath)
      expect(existsSync(result.cgroupPath!)).toBe(false)
      // bounded settle: placement 待ちは有限で、drain 上限（10s）より十分小さい
      expect(elapsedMs).toBeLessThan(5_000)
    }
    expect(outcomes).toHaveLength(ITERATIONS)
    expect(outcomes.filter((outcome) => outcome === 'placement_failed')).toEqual([])
  }, 180_000)

  /**
   * B. placement 完了後に来る通常の abort。
   * placement 待ちを入れたことで、こちらが遅くなったり分類が変わったりしていないこと。
   */
  it('placement 完了後の abort は従来どおり即座に kill され placement_failed にならない', async () => {
    const controller = new AbortController()
    // 300ms 後 = handshake は確実に決着済み（実測 0〜17ms）
    setTimeout(() => controller.abort(), 300)

    const startedAt = Date.now()
    const result = await runContainedCommand({
      jobId: 'job-abort-after-placement',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'sleep 60'],
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
    })
    const elapsedMs = Date.now() - startedAt

    expect(result.outcome).toBe('killed')
    expect(result.outcome).not.toBe('placement_failed')
    expect(result.killedDescendants).toBe(true)
    // placement は既に決着しているので、deadline 分の待ちは一切入らない
    expect(elapsedMs).toBeLessThan(3_000)
    if (result.cgroupPath !== undefined) createdCgroupPaths.add(result.cgroupPath)
    expect(existsSync(result.cgroupPath!)).toBe(false)
  }, 30_000)

  /**
   * C. timeout 経路にも同じ ordering race が無いこと。
   * `timeoutMs: 1` は abort と同じく handshake 進行中に kill 要求を出す。
   */
  it('handshake 中に発火する極小 timeout でも placement_failed にならない', async () => {
    const ITERATIONS = 15
    const outcomes: string[] = []
    for (let i = 0; i < ITERATIONS; i += 1) {
      const result = await runContainedCommand({
        jobId: 'job-tiny-timeout',
        attemptId: `${Date.now()}-${i}`,
        argv: ['/bin/sh', '-c', 'sleep 60'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1,
      })
      outcomes.push(result.outcome)

      expect(result.timedOut).toBe(true)
      expect(isContainmentSafe(result.outcome)).toBe(true)
      expect(result.killedDescendants).toBe(true)
      if (result.cgroupPath !== undefined) createdCgroupPaths.add(result.cgroupPath)
      expect(existsSync(result.cgroupPath!)).toBe(false)
    }
    expect(outcomes.filter((outcome) => outcome === 'placement_failed')).toEqual([])
  }, 120_000)
})

describe('removeCgroupWithRetry — 一過性 EBUSY を短い再試行で解消する', () => {
  function deps(overrides: Partial<RemoveCgroupDeps> = {}): RemoveCgroupDeps & { slept: number[] } {
    const slept: number[] = []
    return {
      rmdir: () => undefined,
      readPopulated: () => false,
      listChildCgroups: () => [],
      sleep: async (ms: number) => { slept.push(ms) },
      slept,
      ...overrides,
    } as RemoveCgroupDeps & { slept: number[] }
  }

  function ebusy(): NodeJS.ErrnoException {
    const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException
    err.code = 'EBUSY'
    return err
  }

  it('1回目で成功するときは待機も再試行もしない', async () => {
    const d = deps()
    const result = await removeCgroupWithRetry('/cg', d)

    expect(result.ok).toBe(true)
    expect(d.slept).toEqual([])
  })

  it('EBUSY が続いた後に成功すれば ok を返す（production で起きた一過性の解体遅延）', async () => {
    let calls = 0
    const d = deps({
      rmdir: () => {
        calls += 1
        if (calls <= 2) throw ebusy()
      },
    })

    const result = await removeCgroupWithRetry('/cg', d)

    expect(result.ok).toBe(true)
    expect(calls).toBe(3)
    expect(d.slept).toEqual([10, 50])
  })

  it('ENOENT は冪等な成功として扱う', async () => {
    const d = deps({
      rmdir: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      },
    })

    expect((await removeCgroupWithRetry('/cg', d)).ok).toBe(true)
    expect(d.slept).toEqual([])
  })

  it('再試行中に populated へ戻ったら即座に失敗させる（本物の封じ込め問題を握り潰さない）', async () => {
    const d = deps({
      rmdir: () => { throw ebusy() },
      readPopulated: () => true,
    })

    const result = await removeCgroupWithRetry('/cg', d)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('became populated again')
    // 1回だけ待って再確認し、そこで打ち切る
    expect(d.slept).toEqual([10])
  })

  it('EBUSY / ENOTEMPTY 以外は一過性でないので再試行しない', async () => {
    const d = deps({
      rmdir: () => {
        const err = new Error('EPERM') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      },
    })

    const result = await removeCgroupWithRetry('/cg', d)

    expect(result.ok).toBe(false)
    expect(d.slept).toEqual([])
  })

  it('再試行を使い切ったら従来どおり失敗し、診断情報を残す（無限 retry にしない）', async () => {
    const d = deps({
      rmdir: () => { throw ebusy() },
      listChildCgroups: () => ['leftover-child'],
    })

    const result = await removeCgroupWithRetry('/cg', d)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toContain(`after ${CLEANUP_RETRY_DELAYS_MS.length} retries`)
      expect(result.detail).toContain('child cgroups remain: leftover-child')
    }
    expect(d.slept).toEqual([...CLEANUP_RETRY_DELAYS_MS])
  })

  it('待機列は有限かつ短い（drain 上限より十分小さい）', () => {
    const total = CLEANUP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(CLEANUP_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5)
    expect(total).toBeLessThan(DEFAULT_DRAIN_MS)
  })
})
