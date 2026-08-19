import { describe, expect, it, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeChangeManifestHash } from './changeManifestIdentity'
import {
  buildCommitChangeManifest,
  buildWorktreeChangeManifest,
  readHeadCommit,
  readSingleParent,
} from './changeManifestReader'

/**
 * resulting_commit binding の core invariant。
 *
 * 「Gateが実際にALLOWした変更集合（HEAD A + worktree D）」と
 * 「commit B が実際に含む変更集合（A → B）」が同一かどうかを、
 * API側がauthoritative repositoryから独立に判定できることを確認する。
 *
 * 一致しない限り resulting_commit を bind してはならない。
 */

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'probe@example.com'])
  git(dir, ['config', 'user.name', 'probe'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(dir, 'tracked.txt'), 'line1\nline2\n')
  writeFileSync(join(dir, 'removeme.txt'), 'to be deleted\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return readHeadCommit(dir)
}

describe('canonical change manifest の同一性', () => {
  let dir: string
  let commitA: string

  beforeEach(() => {
    dir = initRepo()
    commitA = readHeadCommit(dir)
  })

  it('approved A+D → commit B で worktree manifest と commit manifest が一致する', () => {
    appendFileSync(join(dir, 'tracked.txt'), 'line3\n')
    writeFileSync(join(dir, 'added.txt'), 'brand new\n')
    rmSync(join(dir, 'removeme.txt'))

    const approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))
    const commitB = commitAll(dir, 'work')

    expect(readSingleParent(dir, commitB)).toBe(commitA)
    expect(computeChangeManifestHash(buildCommitChangeManifest(dir, commitA, commitB)))
      .toBe(approvedHash)
  })

  it('approved後に内容を書き換えてcommitすると一致しない', () => {
    appendFileSync(join(dir, 'tracked.txt'), 'line3\n')
    const approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    // ALLOW後に別内容へ差し替える
    writeFileSync(join(dir, 'tracked.txt'), 'line1\nline2\nTAMPERED\n')
    const commitB = commitAll(dir, 'tampered')

    expect(computeChangeManifestHash(buildCommitChangeManifest(dir, commitA, commitB)))
      .not.toBe(approvedHash)
  })

  it('approved後に余計なfileを追加してcommitすると一致しない', () => {
    appendFileSync(join(dir, 'tracked.txt'), 'line3\n')
    const approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    writeFileSync(join(dir, 'sneaky.txt'), 'not approved\n')
    const commitB = commitAll(dir, 'with extra file')

    expect(computeChangeManifestHash(buildCommitChangeManifest(dir, commitA, commitB)))
      .not.toBe(approvedHash)
  })

  it('削除対象が違うと一致しない', () => {
    rmSync(join(dir, 'removeme.txt'))
    const approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    // 削除を取り消して別ファイルを削除する
    git(dir, ['checkout', '--', 'removeme.txt'])
    rmSync(join(dir, 'tracked.txt'))
    const commitB = commitAll(dir, 'different deletion')

    expect(computeChangeManifestHash(buildCommitChangeManifest(dir, commitA, commitB)))
      .not.toBe(approvedHash)
  })

  it('deleteは明示markerで表現され、空contentのaddと区別される', () => {
    rmSync(join(dir, 'removeme.txt'))
    const deleteHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    git(dir, ['checkout', '--', 'removeme.txt'])
    writeFileSync(join(dir, 'removeme.txt'), '')
    const emptyHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    expect(deleteHash).not.toBe(emptyHash)
  })

  it('mode変更が異なると一致しない', () => {
    // 実行bitを扱えない環境ではmodeが常に100644になるためskipする
    const probe = join(dir, 'tracked.txt')
    chmodSync(probe, 0o755)
    const canDetectMode = buildWorktreeChangeManifest(dir).some((e) => e.mode === '100755')
    chmodSync(probe, 0o644)
    if (!canDetectMode) return

    appendFileSync(join(dir, 'tracked.txt'), 'line3\n')
    const approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    chmodSync(join(dir, 'tracked.txt'), 0o755)
    const commitB = commitAll(dir, 'mode changed')

    expect(computeChangeManifestHash(buildCommitChangeManifest(dir, commitA, commitB)))
      .not.toBe(approvedHash)
  })

  it('renameはdelete+addとしてcanonicalizeされ、両側で一致する', () => {
    git(dir, ['mv', 'tracked.txt', 'renamed.txt'])
    const approvedHash = computeChangeManifestHash(buildWorktreeChangeManifest(dir))
    const commitB = commitAll(dir, 'rename')

    expect(computeChangeManifestHash(buildCommitChangeManifest(dir, commitA, commitB)))
      .toBe(approvedHash)
  })

  it('同一集合ならファイル生成順に依存しない', () => {
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const first = computeChangeManifestHash(buildWorktreeChangeManifest(dir))

    const other = initRepo()
    writeFileSync(join(other, 'a.txt'), 'a\n')
    writeFileSync(join(other, 'b.txt'), 'b\n')
    const second = computeChangeManifestHash(buildWorktreeChangeManifest(other))

    expect(first).toBe(second)
  })

  it('parentが1つでないcommitは曖昧なので拒否する', () => {
    appendFileSync(join(dir, 'tracked.txt'), 'main\n')
    const mainCommit = commitAll(dir, 'main work')

    git(dir, ['checkout', '-q', '-b', 'side', commitA])
    writeFileSync(join(dir, 'side.txt'), 'side\n')
    commitAll(dir, 'side work')
    git(dir, ['checkout', '-q', 'master'])
    git(dir, ['merge', '-q', '--no-ff', '-m', 'merge', 'side'])

    const mergeCommit = readHeadCommit(dir)
    expect(readSingleParent(dir, mainCommit)).toBeTruthy()
    expect(() => readSingleParent(dir, mergeCommit)).toThrow(/exactly one parent/)
  })
})
