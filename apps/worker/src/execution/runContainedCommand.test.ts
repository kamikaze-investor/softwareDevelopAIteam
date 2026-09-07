/**
 * runContainedCommand の単体テスト。
 *
 * cgroup v2 を実際に作れるのは Linux かつ Worker cgroup が書き込み可能な環境のみなので、
 * 実封じ込めを伴うテストは `isContainmentAvailable()` で gate する。
 * それ以外（可用性判定・命名・結果種別の安全性判定・非対応環境での fail closed）は
 * Windows / Linux どちらでも決定的に検証する。
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildCgroupName,
  isContainmentAvailable,
  isContainmentSafe,
  resolveWorkerCgroup,
  runContainedCommand,
  runContainedOrThrow,
} from './runContainedCommand.js'

const containmentAvailable = isContainmentAvailable()
const describeLinux = containmentAvailable ? describe : describe.skip

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
  })

  it('drain_timeout は runContainedOrThrow で例外になる（呼び出し元が握り潰せない）', async () => {
    await expect(runContainedOrThrow({
      jobId: 'job-drain-throw',
      attemptId: String(Date.now()),
      argv: ['/bin/sh', '-c', 'setsid sleep 30 >/dev/null 2>&1 < /dev/null & exit 0'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30_000,
      drainMs: 0,
    })).rejects.toThrow(/drain_timeout/)
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
})
