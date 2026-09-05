/**
 * verifyWorkspaceAgainstBaseline の実 git 検証テスト（PR-C Tranche 4）
 *
 * 実リポジトリを使い、Windows 上でも決定的に再現できるよう
 * `core.autocrlf=false` を設定した隔離リポジトリで検証する。
 * admission 側と同じヘルパー（buildWorktreeManifest / fingerprintWorktreeEntries /
 * buildBaselineEntries）で baseline を構築し、完全一致 / 不一致の各ケースを確認する。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobWorkspaceBaselineEntry } from '@ai-team/shared'
import {
  buildWorktreeManifest,
  fingerprintWorktreeEntries,
} from './guards/changeManifest.js'
import { buildBaselineEntries } from './jobRunner.js'
import { verifyWorkspaceAgainstBaseline } from './workspaceVerification.js'

let repo: string

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', shell: false })
}

function getHead(cwd: string): string {
  return gitIn(cwd, 'rev-parse', 'HEAD').trim()
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workspace-verification-'))
  gitIn(dir, 'init', '-q')
  // Windows での決定的な内容 hash のために行末変換を無効化する。
  gitIn(dir, 'config', 'core.autocrlf', 'false')
  gitIn(dir, 'config', 'user.email', 'test@example.com')
  gitIn(dir, 'config', 'user.name', 'test')
  writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf-8')
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-qm', 'init')
  return dir
}

function writeFile2(relativePath: string, content: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

/** repo の現在の dirty 状態から、admission と同じ正規化で dirty baseline を構築する。 */
function buildDirtyBaseline(): {
  mode: 'dirty'
  startCommitHash: string
  entries: JobWorkspaceBaselineEntry[]
} {
  const manifest = buildWorktreeManifest(repo)
  const fingerprints = fingerprintWorktreeEntries(repo, manifest)
  return {
    mode: 'dirty',
    startCommitHash: getHead(repo),
    entries: buildBaselineEntries(manifest, fingerprints),
  }
}

beforeEach(() => {
  repo = initRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('verifyWorkspaceAgainstBaseline', () => {
  it('clean baseline + clean tree + matching HEAD => verified', () => {
    const baseline = { mode: 'clean' as const, startCommitHash: getHead(repo) }
    expect(verifyWorkspaceAgainstBaseline(repo, baseline)).toEqual({ verified: true })
  })

  it('clean baseline + clean tree + HEAD moved => NOT verified（looks clean では不十分）', () => {
    const baselineHead = getHead(repo)
    // 2つ目のコミットを作る。working tree はクリーンなまま HEAD だけが進む。
    writeFile2('feature.txt', 'feature\n')
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-qm', 'feature')
    expect(buildWorktreeManifest(repo).paths).toEqual([])

    const result = verifyWorkspaceAgainstBaseline(repo, {
      mode: 'clean',
      startCommitHash: baselineHead,
    })
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('HEAD moved')
    }
  })

  it('git operation marker present => NOT verified', () => {
    writeFileSync(path.join(repo, '.git', 'index.lock'), 'lock\n', 'utf-8')
    const baseline = { mode: 'clean' as const, startCommitHash: getHead(repo) }
    const result = verifyWorkspaceAgainstBaseline(repo, baseline)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('in-progress git operation')
    }
  })

  it('missing baseline => NOT verified', () => {
    const result = verifyWorkspaceAgainstBaseline(repo, undefined)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('baseline is missing')
    }
  })

  it('clean baseline + dirty tree => NOT verified', () => {
    writeFile2('dirty.txt', 'dirty\n')
    const baseline = { mode: 'clean' as const, startCommitHash: getHead(repo) }
    const result = verifyWorkspaceAgainstBaseline(repo, baseline)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('changed path')
    }
  })

  it('dirty baseline matching exactly => verified', () => {
    writeFile2('README.md', 'modified base\n')
    writeFile2('untracked.txt', 'new\n')
    const baseline = buildDirtyBaseline()
    expect(verifyWorkspaceAgainstBaseline(repo, baseline)).toEqual({ verified: true })
  })

  it('dirty baseline with one changed content hash => NOT verified', () => {
    writeFile2('README.md', 'version-one\n')
    const baseline = buildDirtyBaseline()
    writeFile2('README.md', 'version-two\n')
    const result = verifyWorkspaceAgainstBaseline(repo, baseline)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('worktreeHash')
    }
  })

  it('dirty baseline with one extra path => NOT verified', () => {
    writeFile2('README.md', 'modified\n')
    const baseline = buildDirtyBaseline()
    writeFile2('extra.txt', 'extra\n')
    const result = verifyWorkspaceAgainstBaseline(repo, baseline)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('count differs')
    }
  })

  it('dirty baseline with one missing path => NOT verified', () => {
    writeFile2('added.txt', 'new\n')
    const baseline = buildDirtyBaseline()
    expect(baseline.entries.some((e) => e.path === 'added.txt')).toBe(true)
    rmSync(path.join(repo, 'added.txt'), { force: true })
    const result = verifyWorkspaceAgainstBaseline(repo, baseline)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('count differs')
    }
  })

  it('dirty baseline with changed xyStatus => NOT verified', () => {
    writeFile2('README.md', 'modified\n')
    const baseline = buildDirtyBaseline()
    const baselineXy = baseline.entries.find((e) => e.path === 'README.md')?.xyStatus
    expect(baselineXy).toBeDefined()
    gitIn(repo, 'add', 'README.md')
    const result = verifyWorkspaceAgainstBaseline(repo, baseline)
    expect(result.verified).toBe(false)
    if (!result.verified) {
      expect(result.reason).toContain('xyStatus')
    }
  })

  it('empty repo (no HEAD) => NOT verified', () => {
    const emptyRepo = mkdtempSync(path.join(tmpdir(), 'workspace-verification-empty-'))
    try {
      gitIn(emptyRepo, 'init', '-q')
      const result = verifyWorkspaceAgainstBaseline(emptyRepo, {
        mode: 'clean',
        startCommitHash: 'abc123',
      })
      expect(result.verified).toBe(false)
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true })
    }
  })
})