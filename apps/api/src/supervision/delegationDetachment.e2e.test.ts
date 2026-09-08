/**
 * Step 3 E2E — 「session / SSH が終了しても委任と supervision が継続する」ことの実測。
 *
 * 実障害ケース1では、`ssh <host> "codex exec ..."` を Bash tool の timeout で background へ
 * 回した時点で**子processごと死亡**し、出力0 byteのまま残った。ここではその形を実際に再現し、
 * 現在の launch 経路では**親が死んでも委任が生き続ける**ことを、モックではなく実プロセスで確認する。
 *
 * モック不使用: 本物の子プロセスを spawn し、親を殺し、その後にファイルが書かれ続けるかを見る。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** ファイルが条件を満たすまで待つ（固定 sleep ではなく条件待ち）。 */
async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

describe('delegation detachment (E2E, real processes)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'detach-e2e-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('detached で起動した委任は、起動元プロセスが死んだ後も動き続ける', async () => {
    const markerPath = path.join(workspace, 'worker-output.txt')
    const donePath = path.join(workspace, 'worker-done.txt')

    // 「委任される長時間処理」の代役。親が死んだ後に書き込む点が肝である。
    const workerScript = path.join(workspace, 'worker.cjs')
    writeFileSync(workerScript, `
      const fs = require('fs')
      fs.writeFileSync(${JSON.stringify(markerPath)}, 'started\\n')
      // 親が死ぬのに十分な時間を空けてから、生存の証拠を書く。
      setTimeout(() => {
        fs.appendFileSync(${JSON.stringify(markerPath)}, 'still alive after parent exit\\n')
        fs.writeFileSync(${JSON.stringify(donePath)}, 'AI_TEAM_OS_STATUS:DONE\\n')
      }, 3000)
    `)

    // 「起動元 session」の代役。delegationSupervisor の spawnDelegateScript と同じ
    // detached + stdio ignore + unref で子を起動し、すぐ自分は終了する。
    const launcherScript = path.join(workspace, 'launcher.cjs')
    writeFileSync(launcherScript, `
      const { spawn } = require('child_process')
      const child = spawn(process.execPath, [${JSON.stringify(workerScript)}], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      process.exit(0)
    `)

    const launcher = spawn(process.execPath, [launcherScript], { stdio: 'ignore' })
    const launcherExit = await new Promise<number | null>((resolve) => {
      launcher.on('exit', (code) => resolve(code))
    })
    expect(launcherExit).toBe(0)

    // ここで起動元は確実に死んでいる。以降の書き込みはすべて「親なしで進んだ」証拠になる。
    expect(await waitFor(() => existsSync(markerPath))).toBe(true)

    const survived = await waitFor(() => existsSync(donePath))
    expect(survived).toBe(true)
    expect(readFileSync(markerPath, 'utf-8')).toContain('still alive after parent exit')
    expect(readFileSync(donePath, 'utf-8')).toContain('AI_TEAM_OS_STATUS:DONE')
  }, 30_000)

  it('対照: 親の stdio を握ったまま kill すると子は生き残れない（旧経路の失敗モード）', async () => {
    const markerPath = path.join(workspace, 'attached-output.txt')

    const workerScript = path.join(workspace, 'attached-worker.cjs')
    writeFileSync(workerScript, `
      const fs = require('fs')
      fs.writeFileSync(${JSON.stringify(markerPath)}, 'started\\n')
      setTimeout(() => {
        fs.appendFileSync(${JSON.stringify(markerPath)}, 'should not reach here\\n')
      }, 3000)
    `)

    // detached を付けず、親のプロセスグループに属させる。
    const launcherScript = path.join(workspace, 'attached-launcher.cjs')
    writeFileSync(launcherScript, `
      const { spawn } = require('child_process')
      spawn(process.execPath, [${JSON.stringify(workerScript)}], { detached: false, stdio: 'inherit' })
      setTimeout(() => {}, 60000)
    `)

    const launcher = spawn(process.execPath, [launcherScript], { stdio: 'ignore' })
    expect(await waitFor(() => existsSync(markerPath))).toBe(true)

    // 親ごと殺す。Windows では taskkill /T が、POSIX では process group が子を巻き込む。
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      launcher.kill('SIGKILL')
    }

    // 子が道連れになったことを、書かれないことで確認する。
    const reachedLater = await waitFor(
      () => readFileSync(markerPath, 'utf-8').includes('should not reach here'),
      5_000,
    )
    expect(reachedLater).toBe(false)
  }, 30_000)
})
