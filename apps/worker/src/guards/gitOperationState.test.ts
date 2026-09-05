/**
 * gitOperationState の実 git 検証テスト。
 *
 * マーカーは shell コマンドではなく writeFileSync / mkdirSync で直接作成し、
 * detectGitOperationState の path 解決（git rev-parse --git-path）とは別系統で
 * 検出すべき状態を作る。linked worktree（.git が file）でも実 git ディレクトリ配下の
 * マーカーを検出できることを確認する。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitOperationStateError, detectGitOperationState } from './gitOperationState.js'

let repo: string

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', shell: false })
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-operation-state-'))
  gitIn(dir, 'init', '-q')
  gitIn(dir, 'config', 'user.email', 'test@example.com')
  gitIn(dir, 'config', 'user.name', 'test')
  writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf-8')
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-qm', 'init')
  return dir
}

function writeMarker(relativePath: string, content = 'ref: refs/heads/some\n'): void {
  const absolute = path.join(repo, '.git', relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

beforeEach(() => {
  repo = initRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('detectGitOperationState', () => {
  it('クリーンな repo では空配列を返す', () => {
    expect(detectGitOperationState(repo)).toEqual([])
  })

  it.each([
    ['index.lock', 'index.lock', 'index.lock'],
    ['MERGE_HEAD', 'MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'REVERT_HEAD', 'revert'],
    ['rebase-merge/', 'rebase-merge/dummy', 'rebase-merge'],
    ['rebase-apply/', 'rebase-apply/dummy', 'rebase-apply'],
    ['sequencer/', 'sequencer/dummy', 'sequencer'],
  ])('マーカー %s を検出する', (_label, markerPath, operation) => {
    writeMarker(markerPath)

    expect(detectGitOperationState(repo)).toContain(operation)
  })

  it('refs 配下の *.lock を検出する', () => {
    writeMarker('refs/heads/main.lock')

    expect(detectGitOperationState(repo)).toContain('refs.lock')
  })

  it('複数マーカーを全部検出する', () => {
    writeMarker('index.lock')
    writeMarker('MERGE_HEAD')
    writeMarker('rebase-merge/dummy')
    writeMarker('refs/heads/feature.lock')

    const detected = detectGitOperationState(repo)
    expect(detected).toContain('index.lock')
    expect(detected).toContain('merge')
    expect(detected).toContain('rebase-merge')
    expect(detected).toContain('refs.lock')
  })

  it('linked worktree（.git が file）でも実 git ディレクトリのマーカーを検出する', () => {
    const linkPath = path.join(repo, '..', `related-${path.basename(repo)}`)
    rmSync(linkPath, { recursive: true, force: true })
    gitIn(repo, 'worktree', 'add', '-q', '-b', 'related', linkPath)

    try {
      // .git が file（gitdir: <common>）であることを確認
      const gitFile = path.join(linkPath, '.git')
      expect(existsSync(gitFile)).toBe(true)

      // 共通 git ディレクトリ配下（linkPath からは .git でない場所）へ MERGE_HEAD を作る
      const commonGitDir = gitIn(linkPath, 'rev-parse', '--git-dir').trim()
      const commonMergeHead = path.join(commonGitDir, 'MERGE_HEAD')
      mkdirSync(path.dirname(commonMergeHead), { recursive: true })
      writeFileSync(commonMergeHead, 'ref: refs/heads/related\n', 'utf-8')

      // linkPath からでも共通 git dir のマーカーを検出できる（git-path 解決の証明）
      expect(detectGitOperationState(linkPath)).toContain('merge')
      // MERGE_HEAD は worktree 固有（.git/worktrees/<name>/ 配下）であり共有されない。
      // 元の worktree 側は未検出のままであることを確認する。
      expect(detectGitOperationState(repo)).not.toContain('merge')
    } finally {
      rmSync(linkPath, { recursive: true, force: true })
    }
  })

  it('git repo でないディレクトリは fail-closed（throw）', () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'not-a-repo-'))
    try {
      // worktree root でないディレクトリは既存の assertWorktreeRoot が弾く
      // （ChangeDetectionError）。呼び出し元はいずれの throw も quarantine 扱いにする。
      expect(() => detectGitOperationState(notARepo)).toThrow()
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})