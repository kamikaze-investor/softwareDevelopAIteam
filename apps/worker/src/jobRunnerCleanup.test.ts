/**
 * revertBlockedJobChanges の実 git 検証テスト。
 *
 * jobRunner.test.ts はオーケストレーション検証のため execFileSync / fileChangeGuard を
 * スタブ化しているため、「blocked Job の変更が実際に作業ツリーから取り消され、
 * 次の Job を汚染しない」という実効性はここで一時リポジトリを作って直接検証する
 * （2026-08-24 実測: blocked Job 由来の残置ファイルが次 Job の File Change Guard を
 * 誤って汚染する問題の regression test）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWorktreeManifest } from './guards/changeManifest.js'
import { revertBlockedJobChanges } from './jobRunner.js'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', shell: false })
}

function write(relativePath: string, content: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

function headHash(): string {
  return git('rev-parse', 'HEAD').trim()
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'job-runner-cleanup-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('base.txt', 'baseline\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('revertBlockedJobChanges', () => {
  it('blocked Job が作った変更を取り消し、working tree を Job 開始時点まで戻す', () => {
    const startCommitHash = headHash()

    // "Job A": 既存ファイルを変更し、新規ファイルを作成する（範囲外の変更を想定）。
    write('base.txt', 'modified by job A\n')
    write('out-of-scope.txt', 'created by job A\n')

    const manifest = buildWorktreeManifest(repo)
    expect(manifest.paths.sort()).toEqual(['base.txt', 'out-of-scope.txt'])

    const note = revertBlockedJobChanges(repo, startCommitHash, manifest, [])

    expect(note).toBeUndefined()
    expect(git('status', '--porcelain').trim()).toBe('')
    expect(readFileSync(path.join(repo, 'base.txt'), 'utf-8')).toBe('baseline\n')
    expect(existsSync(path.join(repo, 'out-of-scope.txt'))).toBe(false)
  })

  it('Job A の残置が無いため、直後の Job B は自分の変更だけを見る（汚染しない）', () => {
    const startCommitHash = headHash()

    write('base.txt', 'modified by job A\n')
    write('out-of-scope.txt', 'created by job A\n')
    const jobAManifest = buildWorktreeManifest(repo)
    revertBlockedJobChanges(repo, startCommitHash, jobAManifest, [])

    // "Job B": Job A とは無関係な別ファイルだけを変更する。
    write('job-b.txt', 'created by job B\n')
    const jobBManifest = buildWorktreeManifest(repo)

    expect(jobBManifest.paths).toEqual(['job-b.txt'])
  })

  it('Job開始前から存在した無関係な未commit変更には一切触れない', () => {
    // Job 開始前から既に dirty な状態（他の作業や以前のセッションの残置を想定）。
    write('pre-existing.txt', 'pre-existing dirty content\n')
    const preExistingManifest = buildWorktreeManifest(repo)
    expect(preExistingManifest.paths).toEqual(['pre-existing.txt'])

    const startCommitHash = headHash()

    // "Job A": 別ファイルを変更する。
    write('base.txt', 'modified by job A\n')

    const manifest = buildWorktreeManifest(repo)
    expect(manifest.paths.sort()).toEqual(['base.txt', 'pre-existing.txt'])

    const note = revertBlockedJobChanges(repo, startCommitHash, manifest, preExistingManifest.paths)

    expect(note).toBeUndefined()
    // pre-existing.txt はそのまま残る（Job Aの成果ではないため取り消し対象外）。
    expect(existsSync(path.join(repo, 'pre-existing.txt'))).toBe(true)
    expect(readFileSync(path.join(repo, 'pre-existing.txt'), 'utf-8')).toBe('pre-existing dirty content\n')
    // base.txt は Job A 自身の変更なので取り消される。
    expect(readFileSync(path.join(repo, 'base.txt'), 'utf-8')).toBe('baseline\n')
  })

  it('Job中にHEADが動いていた場合（AIやSafeCommandがcommitした場合）は取り消しをスキップし、理由を返す', () => {
    const startCommitHash = headHash()

    write('base.txt', 'modified by job A\n')
    const manifest = buildWorktreeManifest(repo)

    // HEAD を進める（AI CLI や SafeCommand が commit した状況を模す）。
    write('unrelated.txt', 'unrelated commit content\n')
    git('add', '-A')
    git('commit', '-qm', 'HEAD moved during job')

    const note = revertBlockedJobChanges(repo, startCommitHash, manifest, [])

    expect(note).toBeDefined()
    expect(note).toContain('HEAD changed during job')
    // 履歴を書き換えるような取り消しは行わない（作業ツリーはそのまま）。
    expect(readFileSync(path.join(repo, 'base.txt'), 'utf-8')).toBe('modified by job A\n')
  })

  it('manifestが空なら何もしない', () => {
    const startCommitHash = headHash()
    const note = revertBlockedJobChanges(repo, startCommitHash, { changes: [], paths: [] }, [])
    expect(note).toBeUndefined()
  })
})
