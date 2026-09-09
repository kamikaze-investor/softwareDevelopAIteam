/**
 * trusted run directory（独立レビュー Step 3 #3 への回帰）
 *
 * 以前は runDir を呼び出し元の logPath と生の subjectId から組み立てており、
 * completion predicate が「呼び出し元が指したディレクトリ」を読んでいた。
 * DONE marker 検査がそのまま偽装できる状態だった。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSafeRunId, resolveInsideRunDir, resolveSupervisedRunRoot, runDirFor } from './runDirectory'

describe('runDirFor — runDir は server 生成の runId のみから決まる', () => {
  let previousRoot: string | undefined
  let root: string

  beforeEach(() => {
    previousRoot = process.env.SUPERVISED_RUN_ROOT
    root = mkdtempSync(path.join(os.tmpdir(), 'rundir-'))
    process.env.SUPERVISED_RUN_ROOT = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.SUPERVISED_RUN_ROOT
    else process.env.SUPERVISED_RUN_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('trusted root 配下に runId で作られる', () => {
    const runId = '11111111-2222-3333-4444-555555555555'
    expect(runDirFor(runId)).toBe(path.join(resolveSupervisedRunRoot(), runId))
  })

  it.each([
    '../escape',
    'a/../../b',
    'not-a-uuid',
    '',
    '../../../../etc',
    '11111111-2222-3333-4444-555555555555/../..',
  ])('path segment として危険な runId "%s" は拒否する', (runId) => {
    expect(isSafeRunId(runId)).toBe(false)
    expect(() => runDirFor(runId)).toThrow(/unsafe supervised run id/)
  })
})

describe('resolveInsideRunDir — runDir の外は読まない', () => {
  let sandbox: string
  let runDir: string
  let outside: string

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'inside-'))
    runDir = path.join(sandbox, 'run')
    outside = path.join(sandbox, 'outside')
    mkdirSync(runDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(runDir, 'delegation.log'), 'AI_TEAM_OS_STATUS:DONE')
    writeFileSync(path.join(outside, 'forged.log'), 'AI_TEAM_OS_STATUS:DONE')
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('runDir 配下の相対 path は許可する', () => {
    expect(resolveInsideRunDir(runDir, 'delegation.log')).toBeDefined()
  })

  it('runDir 配下へ解決される絶対 path も許可する（delegate.sh は絶対 path で書く）', () => {
    expect(resolveInsideRunDir(runDir, path.join(runDir, 'delegation.log'))).toBeDefined()
  })

  it('traversal で外へ出る相対 path は拒否する', () => {
    expect(resolveInsideRunDir(runDir, path.join('..', 'outside', 'forged.log'))).toBeUndefined()
  })

  it('runDir 外を指す絶対 path は拒否する', () => {
    expect(resolveInsideRunDir(runDir, path.join(outside, 'forged.log'))).toBeUndefined()
  })

  it('runDir 内から外を指す symlink は拒否する（realpath 解決後に判定する）', () => {
    const link = path.join(runDir, 'sneaky.log')
    try {
      symlinkSync(path.join(outside, 'forged.log'), link)
    } catch {
      // Windows で symlink 権限が無い環境ではこのケースを検証できない。
      return
    }
    expect(resolveInsideRunDir(runDir, 'sneaky.log')).toBeUndefined()
  })

  it('UNC path は解決前に拒否する', () => {
    expect(resolveInsideRunDir(runDir, '\\\\server\\share\\forged.log')).toBeUndefined()
    expect(resolveInsideRunDir(runDir, '//server/share/forged.log')).toBeUndefined()
  })

  it('存在しない path は読まない（fail-closed）', () => {
    expect(resolveInsideRunDir(runDir, 'never-created.log')).toBeUndefined()
  })
})
