/**
 * changeManifest の実 git 検証テスト。
 *
 * jobRunner.test.ts はオーケストレーション検証のため検出をスタブ化しているので、
 * porcelain=v2 / diff --raw の実際の解析はここで一時リポジトリを作って検証する。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeDetectionError,
  assertIndexClean,
  assertIndexMatchesApproved,
  assertNoResidualChanges,
  buildApprovedStateMap,
  buildCommitTreeManifest,
  buildIndexStateMap,
  buildWorktreeManifest,
  diffSensitiveBaseline,
  entryTypeFromMode,
  lstatEntryType,
  scanSensitiveFiles,
  stageApprovedPaths,
  type ApprovedFileState,
} from './changeManifest.js'

const SENSITIVE_PATTERNS = [/^\.env$/, /^\.env\./, /\.pem$/, /\.key$/, /^id_rsa/]

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', shell: false })
}

function write(relativePath: string, content: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

/** symlink を作れる環境かどうか（Windows では権限が無いと失敗する） */
function canCreateSymlink(): boolean {
  const probe = path.join(repo, '.__symlink_probe__')
  try {
    symlinkSync(path.join(repo, 'README.md'), probe)
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'change-manifest-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('README.md', 'base\n')
  write('src/keep.ts', 'export const keep = 1\n')
  write('src/remove.ts', 'export const remove = 1\n')
  write('src/rename-me.ts', 'export const renamed = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('git_commit approved/index state verification', () => {
  it('buildApprovedStateMap records added, modified, deleted, renamed, CRLF, spaced, and leading-hyphen paths', () => {
    git('config', 'core.autocrlf', 'true')
    write('src/keep.ts', 'export const keep = 2\n')
    unlinkSync(path.join(repo, 'src/remove.ts'))
    git('mv', 'src/rename-me.ts', 'src/renamed.ts')
    write('src/new.ts', 'export const added = 1\n')
    write('src/crlf.txt', 'first\r\nsecond\r\n')
    write('src/with space.txt', 'space\n')
    write('-leading.txt', 'hyphen\n')

    const manifest = buildWorktreeManifest(repo)
    const approved = buildApprovedStateMap(repo, manifest)

    expect(approved.get('src/remove.ts')).toEqual({ absent: true })
    expect(approved.get('src/rename-me.ts')).toEqual({ absent: true })
    for (const filePath of [
      'src/keep.ts',
      'src/renamed.ts',
      'src/new.ts',
      'src/crlf.txt',
      'src/with space.txt',
      '-leading.txt',
    ]) {
      expect(approved.get(filePath)).toEqual({
        absent: false,
        blobId: git('hash-object', '--', filePath).trim(),
        type: 'regular',
        mode: '100644',
      })
    }
  })

  it('assertIndexClean accepts a clean index and rejects an already-staged index', () => {
    expect(() => assertIndexClean(repo)).not.toThrow()

    write('src/staged.ts', 'staged\n')
    git('add', '--', 'src/staged.ts')

    expect(() => assertIndexClean(repo)).toThrow(ChangeDetectionError)
  })

  it('stageApprovedPaths stages only explicit paths and preserves unrelated changes as unstaged', () => {
    write('src/approved.ts', 'approved\n')
    write('src/unapproved.ts', 'unapproved\n')
    write('src/keep.ts', 'export const keep = 2\n')

    stageApprovedPaths(repo, ['src/approved.ts'])

    expect(git('diff', '--cached', '--name-only').trim()).toBe('src/approved.ts')
    expect(git('diff', '--name-only').trim()).toBe('src/keep.ts')
    expect(git('status', '--short')).toContain('?? src/unapproved.ts')
  })

  it('stageApprovedPaths stages a filesystem rename when old and new paths are explicit', () => {
    renameSync(path.join(repo, 'src/rename-me.ts'), path.join(repo, 'src/renamed.ts'))

    stageApprovedPaths(repo, ['src/rename-me.ts', 'src/renamed.ts'])

    expect(git('diff', '--cached', '--name-status', '-M').trim()).toMatch(/^R\d+\s+src\/rename-me\.ts\s+src\/renamed\.ts$/)
  })

  it('stageApprovedPaths rejects an empty path list', () => {
    expect(() => stageApprovedPaths(repo, [])).toThrow(ChangeDetectionError)
  })

  it('buildIndexStateMap reports added, modified, deleted, and renamed final states', () => {
    write('src/keep.ts', 'export const keep = 2\n')
    unlinkSync(path.join(repo, 'src/remove.ts'))
    renameSync(path.join(repo, 'src/rename-me.ts'), path.join(repo, 'src/renamed.ts'))
    write('src/new.ts', 'export const added = 1\n')
    stageApprovedPaths(repo, [
      'src/keep.ts',
      'src/remove.ts',
      'src/rename-me.ts',
      'src/renamed.ts',
      'src/new.ts',
    ])

    const actual = buildIndexStateMap(repo)

    expect(actual.get('src/remove.ts')).toEqual({ absent: true })
    expect(actual.get('src/rename-me.ts')).toEqual({ absent: true })
    for (const filePath of ['src/keep.ts', 'src/renamed.ts', 'src/new.ts']) {
      expect(actual.get(filePath)).toEqual({
        absent: false,
        blobId: git('rev-parse', `:${filePath}`).trim(),
        type: 'regular',
        mode: '100644',
      })
    }
  })

  it('assertIndexMatchesApproved accepts an exact match', () => {
    const approved = new Map<string, ApprovedFileState>([
      ['src/file.ts', { absent: false, blobId: 'abc', type: 'regular', mode: '100644' }],
      ['src/deleted.ts', { absent: true }],
    ])
    const actual = new Map<string, ApprovedFileState>(approved)

    expect(() => assertIndexMatchesApproved(approved, actual)).not.toThrow()
  })

  it.each([
    ['path set', new Map<string, ApprovedFileState>([['src/extra.ts', { absent: true }]])],
    ['blobId', new Map<string, ApprovedFileState>([['src/file.ts', { absent: false, blobId: 'def', type: 'regular', mode: '100644' }]])],
    ['mode', new Map<string, ApprovedFileState>([['src/file.ts', { absent: false, blobId: 'abc', type: 'regular', mode: '100755' }]])],
    ['type', new Map<string, ApprovedFileState>([['src/file.ts', { absent: false, blobId: 'abc', type: 'symlink', mode: '100644' }]])],
  ])('assertIndexMatchesApproved rejects a %s mismatch', (_label, actual) => {
    const approved = new Map<string, ApprovedFileState>([
      ['src/file.ts', { absent: false, blobId: 'abc', type: 'regular', mode: '100644' }],
    ])

    expect(() => assertIndexMatchesApproved(approved, actual)).toThrow(ChangeDetectionError)
  })

  it('assertNoResidualChanges accepts a fully staged worktree', () => {
    write('src/keep.ts', 'export const keep = 2\n')
    write('src/new.ts', 'new\n')
    stageApprovedPaths(repo, ['src/keep.ts', 'src/new.ts'])

    expect(() => assertNoResidualChanges(repo)).not.toThrow()
  })

  it('assertNoResidualChanges rejects unstaged tracked changes and untracked files', () => {
    write('src/keep.ts', 'export const keep = 2\n')
    expect(() => assertNoResidualChanges(repo)).toThrow(ChangeDetectionError)

    stageApprovedPaths(repo, ['src/keep.ts'])
    write('src/untracked.ts', 'untracked\n')
    expect(() => assertNoResidualChanges(repo)).toThrow(ChangeDetectionError)
  })

  it('uses the same filtered Git blob ID before and after staging a CRLF file with core.autocrlf=true', () => {
    git('config', 'core.autocrlf', 'true')
    write('src/crlf.txt', 'first\r\nsecond\r\n')
    const beforeStage = git('hash-object', '--', 'src/crlf.txt').trim()

    stageApprovedPaths(repo, ['src/crlf.txt'])
    const afterStage = git('rev-parse', ':src/crlf.txt').trim()

    expect(beforeStage).toBe(afterStage)
  })
})

describe('buildWorktreeManifest', () => {
  it('untracked な通常ファイルを検出する（git diff --name-only では検出できなかったケース）', () => {
    write('src/brand-new.ts', 'export const created = 1\n')

    const manifest = buildWorktreeManifest(repo)

    expect(manifest.paths).toContain('src/brand-new.ts')
    const change = manifest.changes.find((c) => c.path === 'src/brand-new.ts')
    expect(change?.kind).toBe('added')
    expect(change?.afterType).toBe('regular')
  })

  it('削除を検出する', () => {
    unlinkSync(path.join(repo, 'src/remove.ts'))

    const manifest = buildWorktreeManifest(repo)

    const change = manifest.changes.find((c) => c.path === 'src/remove.ts')
    expect(change?.kind).toBe('deleted')
  })

  it('rename の旧パスと新パスの両方を paths へ含める', () => {
    git('mv', 'src/rename-me.ts', 'src/renamed.ts')

    const manifest = buildWorktreeManifest(repo)

    const change = manifest.changes.find((c) => c.kind === 'renamed')
    expect(change).toBeDefined()
    expect(change?.path).toBe('src/renamed.ts')
    expect(change?.oldPath).toBe('src/rename-me.ts')
    expect(manifest.paths).toEqual(expect.arrayContaining(['src/renamed.ts', 'src/rename-me.ts']))
  })

  it('空白や改行を含むファイル名を -z 形式で正しく処理する', () => {
    write('src/with space.ts', 'export const spaced = 1\n')

    const manifest = buildWorktreeManifest(repo)

    // -z なしでは "..." で引用・エスケープされ壊れる
    expect(manifest.paths).toContain('src/with space.ts')
  })

  it('unmerged（コンフリクト未解決）は fail-closed になる', () => {
    git('checkout', '-qb', 'feature')
    write('src/keep.ts', 'export const keep = 2\n')
    git('commit', '-qam', 'feature')
    git('checkout', '-q', '-')
    write('src/keep.ts', 'export const keep = 3\n')
    git('commit', '-qam', 'main')
    try {
      git('merge', 'feature')
    } catch {
      // コンフリクトで非0終了するのが想定
    }

    expect(() => buildWorktreeManifest(repo)).toThrow(ChangeDetectionError)
  })

  it('git 実行に失敗した場合は空配列を返さず throw する（fail-closed）', () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'not-a-repo-'))
    try {
      expect(() => buildWorktreeManifest(notARepo)).toThrow(ChangeDetectionError)
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })

  it('untracked な symlink を lstat 結果から symlink として分類する', () => {
    if (!canCreateSymlink()) return

    symlinkSync(path.join(repo, 'README.md'), path.join(repo, 'src/link.ts'))

    const manifest = buildWorktreeManifest(repo)
    const change = manifest.changes.find((c) => c.path === 'src/link.ts')

    expect(change?.afterType).toBe('symlink')
  })

  it('nested repository（untracked ディレクトリ）を gitlink として分類する', () => {
    const nested = path.join(repo, 'nested')
    mkdirSync(nested, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: nested, shell: false })
    writeFileSync(path.join(nested, 'a.txt'), 'x', 'utf-8')

    const manifest = buildWorktreeManifest(repo)
    const change = manifest.changes.find((c) => c.path.startsWith('nested'))

    expect(change?.afterType).toBe('gitlink')
  })
})

describe('buildCommitTreeManifest', () => {
  it('commit 後に working tree 差分が空でも commit tree から変更を検出する', () => {
    const base = git('rev-parse', 'HEAD').trim()
    write('.env', 'SECRET=leaked\n')
    write('src/new.ts', 'export const added = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'ai: auto commit')
    const after = git('rev-parse', 'HEAD').trim()

    // working tree はクリーン＝旧実装ではここで検出漏れが起きていた
    expect(buildWorktreeManifest(repo).paths).toEqual([])

    const manifest = buildCommitTreeManifest(repo, base, after)

    expect(manifest.paths).toEqual(expect.arrayContaining(['.env', 'src/new.ts']))
    expect(manifest.changes.find((c) => c.path === '.env')?.kind).toBe('added')
  })

  it('mode 変化（type change 相当）を検出する。--name-status では取得できない情報', () => {
    const base = git('rev-parse', 'HEAD').trim()
    git('update-index', '--chmod=+x', 'src/keep.ts')
    git('commit', '-qm', 'chmod')
    const after = git('rev-parse', 'HEAD').trim()

    const manifest = buildCommitTreeManifest(repo, base, after)
    const change = manifest.changes.find((c) => c.path === 'src/keep.ts')

    expect(change?.beforeMode).toBe('100644')
    expect(change?.afterMode).toBe('100755')
  })

  it('rename の旧パス・新パスを取得する（--raw は porcelain と順序が逆）', () => {
    const base = git('rev-parse', 'HEAD').trim()
    git('mv', 'src/rename-me.ts', 'src/renamed.ts')
    git('commit', '-qm', 'rename')
    const after = git('rev-parse', 'HEAD').trim()

    const manifest = buildCommitTreeManifest(repo, base, after)
    const change = manifest.changes.find((c) => c.kind === 'renamed')

    expect(change?.oldPath).toBe('src/rename-me.ts')
    expect(change?.path).toBe('src/renamed.ts')
  })

  it('内容変更を blob hash の差で判別できる', () => {
    const base = git('rev-parse', 'HEAD').trim()
    write('src/keep.ts', 'export const keep = 999\n')
    git('commit', '-qam', 'modify')
    const after = git('rev-parse', 'HEAD').trim()

    const change = buildCommitTreeManifest(repo, base, after).changes.find(
      (c) => c.path === 'src/keep.ts',
    )

    expect(change?.beforeHash).toBeDefined()
    expect(change?.afterHash).toBeDefined()
    expect(change?.beforeHash).not.toBe(change?.afterHash)
  })
})

describe('entryTypeFromMode', () => {
  it('mode から実体種別を決める', () => {
    expect(entryTypeFromMode('100644')).toBe('regular')
    expect(entryTypeFromMode('100755')).toBe('regular')
    expect(entryTypeFromMode('120000')).toBe('symlink')
    expect(entryTypeFromMode('160000')).toBe('gitlink')
    expect(entryTypeFromMode('000000')).toBeUndefined()
  })

  it('未知の mode は fail-closed', () => {
    expect(() => entryTypeFromMode('123456')).toThrow(ChangeDetectionError)
  })
})

describe('lstatEntryType', () => {
  it('存在しないパスは fail-closed', () => {
    expect(() => lstatEntryType(repo, 'does/not/exist.ts')).toThrow(ChangeDetectionError)
  })

  it('worktree の外へ出るパスは fail-closed', () => {
    expect(() => lstatEntryType(repo, '../escape.ts')).toThrow(ChangeDetectionError)
  })
})

describe('scanSensitiveFiles / diffSensitiveBaseline（.gitignore 対象を含む）', () => {
  beforeEach(() => {
    write('.gitignore', '.env\n*.pem\n')
    git('add', '-A')
    git('commit', '-qm', 'add gitignore')
  })

  it('.gitignore に .env がある状態でも新規 .env 作成を検出する', () => {
    const before = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)
    write('.env', 'SECRET=1\n')
    const after = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)

    // git は ignored ファイルを報告しない
    expect(buildWorktreeManifest(repo).paths).not.toContain('.env')

    const changes = diffSensitiveBaseline(before, after)
    expect(changes.find((c) => c.path === '.env')?.kind).toBe('added')
  })

  it('既存 ignored .env の内容変更を検出する', () => {
    write('.env', 'SECRET=1\n')
    const before = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)
    write('.env', 'SECRET=2\n')
    const after = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)

    const changes = diffSensitiveBaseline(before, after)
    expect(changes.find((c) => c.path === '.env')?.kind).toBe('modified')
  })

  it('既存 ignored .env が無変更なら誤検出しない', () => {
    write('.env', 'SECRET=1\n')
    const before = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)
    const after = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)

    expect(diffSensitiveBaseline(before, after)).toEqual([])
  })

  it('.pem など他の機密パターンも ignored のまま検出する', () => {
    const before = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)
    write('certs/server.pem', 'KEY\n')
    const after = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)

    const changes = diffSensitiveBaseline(before, after)
    expect(changes.find((c) => c.path === 'certs/server.pem')?.kind).toBe('added')
  })

  it('機密パターンに一致しないファイルはベースラインへ入れない', () => {
    write('src/normal.ts', 'export const normal = 1\n')
    const baseline = scanSensitiveFiles(repo, SENSITIVE_PATTERNS)

    expect(baseline.has('src/normal.ts')).toBe(false)
  })
})
