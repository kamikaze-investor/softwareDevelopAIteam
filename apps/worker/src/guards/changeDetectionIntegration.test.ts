/**
 * 変更検出と File Change Guard を **スタブなしで接続した** 統合テスト。
 *
 * jobRunner.test.ts は changeManifest / fileChangeGuard の両方を mock しているため、
 * 「実際に .env をコミットしたら拒否されるか」を検証できない。
 * ここでは一時 Git リポジトリ上で実 manifest ＋ 実 Guard を通し、
 * Codex 独立レビューで指摘された回避経路が塞がっていることを確認する。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALWAYS_FORBIDDEN_PATTERNS,
  buildRuntimeTaskPolicy,
  fileChangeGuard,
} from './fileChangeGuard.js'
import {
  ChangeDetectionError,
  assertNoHistoryRewrite,
  buildCommitRangeManifest,
  buildCommitTreeManifest,
  buildWorktreeManifest,
  captureReflogBaseline,
  diffSensitiveBaseline,
  getCommitRangeDiffText,
  getWorktreeDiffText,
  manifestFromChanges,
  mergeManifests,
  scanSensitiveFiles,
} from './changeManifest.js'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', shell: false })
}

function write(relativePath: string, content: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

const policy = buildRuntimeTaskPolicy({ id: 'task-1', projectId: 'project-1' })

/** jobRunner の最終検査（Stage B/C）と同じ組み立てを行う */
function finalInspection(
  startCommit: string,
  baseline: Map<string, never> | ReturnType<typeof scanSensitiveFiles>,
  reflogBaseline: ReturnType<typeof captureReflogBaseline> = { headHashes: [] },
) {
  assertNoHistoryRewrite(repo, reflogBaseline)
  const worktree = buildWorktreeManifest(repo)
  const sensitive = diffSensitiveBaseline(
    baseline as ReturnType<typeof scanSensitiveFiles>,
    scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS),
  )
  const withSensitive =
    sensitive.length === 0 ? worktree : mergeManifests(worktree, manifestFromChanges(sensitive))

  const head = git('rev-parse', 'HEAD').trim()
  const manifest =
    head === startCommit
      ? withSensitive
      : mergeManifests(buildCommitRangeManifest(repo, startCommit, head), withSensitive)

  return { manifest, guard: fileChangeGuard(manifest, policy, repo) }
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'change-detection-integ-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('README.md', 'base\n')
  write('src/app.ts', 'export const app = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('変更検出 × File Change Guard 統合', () => {
  it('ルート直下の .env をコミットしても最終検査で拒否される', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('.env', 'SECRET=leaked\n')
    git('add', '-A')
    git('commit', '-qm', 'ai: auto commit')

    // working tree はクリーン（旧実装ではここで検出漏れしていた）
    expect(buildWorktreeManifest(repo).paths).toEqual([])

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('.env')
  })

  it('nested な apps/api/.env をコミットしても拒否される', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('apps/api/.env', 'SECRET=nested\n')
    git('add', '-A')
    git('commit', '-qm', 'ai: nested env')

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('apps/api/.env')
  })

  it('AI が自分で commit して working tree を clean にしても検出する（非 atomic 経路）', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    // AI CLI や target 側スクリプトが勝手にコミットしたケース
    write('secrets/private.pem', 'KEY\n')
    git('add', '-A')
    git('commit', '-qm', 'committed by AI itself')

    const { manifest, guard } = finalInspection(start, baseline, reflogBaseline)

    expect(manifest.paths).toContain('secrets/private.pem')
    expect(guard.allowed).toBe(false)
  })

  it('ignored な .env の新規作成を検出して拒否する（git は報告しない）', () => {
    write('.gitignore', '.env\n')
    git('add', '-A')
    git('commit', '-qm', 'gitignore')

    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('.env', 'SECRET=ignored\n')

    // git status は ignored ファイルを報告しない
    expect(buildWorktreeManifest(repo).paths).not.toContain('.env')

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('.env')
  })

  it('ignored な dist/server.pem も走査対象に含める', () => {
    write('.gitignore', 'dist/\n')
    git('add', '-A')
    git('commit', '-qm', 'gitignore dist')

    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('dist/server.pem', 'KEY\n')

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('dist/server.pem')
  })

  it('untracked ファイルの内容が secret/diff 検査へ渡る synthetic diff に含まれる', () => {
    write('src/config.ts', 'export const KEY = "AKIAIOSFODNN7EXAMPLE"\n')

    const manifest = buildWorktreeManifest(repo)
    const diffText = getWorktreeDiffText(repo, manifest)

    // git diff HEAD 単体では untracked の内容は出ない
    expect(git('diff', 'HEAD')).not.toContain('AKIAIOSFODNN7EXAMPLE')
    // synthetic diff で追加行として補われる
    expect(diffText).toContain('+export const KEY = "AKIAIOSFODNN7EXAMPLE"')
  })

  it('通常の実装変更は誤って拒否しない', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('src/app.ts', 'export const app = 2\n')
    write('src/feature.ts', 'export const feature = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal work')

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(true)
    expect(guard.violations).toEqual([])
  })

  it('allowedPaths 外へコミットした場合も拒否する', () => {
    const scoped = buildRuntimeTaskPolicy({
      id: 'task-1',
      projectId: 'project-1',
      allowedPaths: ['src'],
    })
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('infra/deploy.yaml', 'replicas: 99\n')
    git('add', '-A')
    git('commit', '-qm', 'out of scope')

    const head = git('rev-parse', 'HEAD').trim()
    const manifest = buildCommitTreeManifest(repo, start, head)
    const guard = fileChangeGuard(manifest, scoped, repo)

    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('infra/deploy.yaml')
  })

  it('.env を追加commit→削除commitして最終treeが相殺されても検出する（複数commit）', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('.env', 'SECRET=leaked\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    write('src/feature.ts', 'export const feature = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'unrelated work')
    git('rm', '-q', '.env')
    git('commit', '-qm', 'remove secret')

    const after = git('rev-parse', 'HEAD').trim()

    // tree-to-tree の単純比較では開始treeと終了treeが同一で検出漏れになる
    expect(git('diff', '--raw', start, after)).not.toContain('.env')

    const manifest = buildCommitRangeManifest(repo, start, after)
    const guard = fileChangeGuard(manifest, policy, repo)

    expect(manifest.paths).toContain('.env')
    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('.env')
  })

  it('複数commit間の diff テキストも連結して secret 検査へ渡せる', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('.env', 'SECRET=AKIAIOSFODNN7EXAMPLE\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    git('rm', '-q', '.env')
    git('commit', '-qm', 'remove secret')

    const after = git('rev-parse', 'HEAD').trim()
    const diffText = getCommitRangeDiffText(repo, start, after)

    expect(diffText).toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('merge commit を含む範囲は fail-closed で拒否する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    git('checkout', '-qb', 'feature')
    write('src/feature.ts', 'export const feature = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'feature work')
    git('checkout', '-q', 'master')
    write('src/main-work.ts', 'export const mainWork = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'main work')
    git('merge', '--no-ff', '-q', '-m', 'merge feature', 'feature')

    const after = git('rev-parse', 'HEAD').trim()

    expect(() => buildCommitRangeManifest(repo, start, after)).toThrow()
  })

  it('ignored な node_modules 配下の .env も走査対象に含める', () => {
    write('.gitignore', 'node_modules/\n')
    git('add', '-A')
    git('commit', '-qm', 'gitignore node_modules')

    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('node_modules/pkg/.env', 'SECRET=nested-in-node-modules\n')

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(false)
    expect(guard.violations).toContain('node_modules/pkg/.env')
  })

  it('256KB を超える untracked ファイルは内容を検査できず fail-closed になる', () => {
    write('src/huge.ts', 'x'.repeat(300 * 1024))

    const manifest = buildWorktreeManifest(repo)

    expect(() => getWorktreeDiffText(repo, manifest)).toThrow()
  })

  it('Windows のファイルシステム大文字小文字非区別を想定し、大文字化した禁止ファイルも拒否する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('.ENV', 'SECRET=uppercase\n')
    git('add', '-A')
    git('commit', '-qm', 'uppercase env')

    const after = git('rev-parse', 'HEAD').trim()
    const manifest = buildCommitRangeManifest(repo, start, after)
    const guard = fileChangeGuard(manifest, policy, repo)

    expect(guard.allowed).toBe(false)
  })

  it('forbiddenPaths も大文字小文字を区別せず判定する', () => {
    const scoped = buildRuntimeTaskPolicy({
      id: 'task-1',
      projectId: 'project-1',
      forbiddenPaths: ['infra'],
    })
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('INFRA/deploy.yaml', 'replicas: 99\n')
    git('add', '-A')
    git('commit', '-qm', 'uppercase infra')

    const after = git('rev-parse', 'HEAD').trim()
    const manifest = buildCommitRangeManifest(repo, start, after)
    const guard = fileChangeGuard(manifest, scoped, repo)

    expect(guard.allowed).toBe(false)
  })

  it('reset --hard で破棄したcommitの秘密情報が最終検査を素通りしない（reflog検証）', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('.env', 'SECRET=discarded-by-reset\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    git('reset', '--hard', start)
    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal work')

    const after = git('rev-parse', 'HEAD').trim()

    // 祖先関係だけを見る検査（buildCommitRangeManifest単体）は
    // reset された commit を一切検出できない（実測確認済み）
    expect(git('merge-base', '--is-ancestor', start, after)).toBe('')
    const rangeManifest = buildCommitRangeManifest(repo, start, after)
    expect(rangeManifest.paths).not.toContain('.env')

    // reflog検証を挟むと、reset操作自体を検出して fail-closed になる
    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
  })

  it('reset で元のhashへ正確に戻された場合も reflog 検証で検出する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('.env', 'SECRET=temporarily-committed\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    git('reset', '--hard', start)

    const after = git('rev-parse', 'HEAD').trim()
    // HEADが完全に元のhashへ戻っているため、単純な hash 比較では異常を検出できない
    expect(after).toBe(start)

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
  })

  it('通常のcommit操作のみでは reflog 検証を通過する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal work')

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).not.toThrow()
    void start
  })

  it('ignored な大文字 .ENV（node_modules配下含む）も検出する', () => {
    write('.gitignore', '.ENV\nnode_modules/\n')
    git('add', '-A')
    git('commit', '-qm', 'gitignore uppercase')

    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const baseline = scanSensitiveFiles(repo, ALWAYS_FORBIDDEN_PATTERNS)

    write('.ENV', 'SECRET=uppercase-ignored\n')
    write('node_modules/pkg/.ENV', 'SECRET=nested-uppercase\n')

    const { guard } = finalInspection(start, baseline, reflogBaseline)

    expect(guard.allowed).toBe(false)
  })

  it('POSIX上の実ファイル名に含まれるバックスラッシュを区切り文字として誤変換しない', () => {
    if (process.platform === 'win32') return // Windowsではバックスラッシュを含むファイル名を作れない

    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    const scoped = buildRuntimeTaskPolicy({ id: 'task-1', projectId: 'project-1', allowedPaths: ['src'] })

    // 実ファイル名 "escape.ts" だがパスの先頭に文字通りのバックスラッシュを含む
    writeFileSync(path.join(repo, 'src\\evil.ts'), 'export const evil = 1\n', 'utf-8')
    git('add', '-A')
    git('commit', '-qm', 'literal backslash filename')

    const after = git('rev-parse', 'HEAD').trim()
    const manifest = buildCommitRangeManifest(repo, start, after)

    // "src\\evil.ts" というリテラルなファイル名のまま manifest に入っており、
    // "src/evil.ts" へ誤変換されて allowedPaths=['src'] を通過してはいけない
    const guard = fileChangeGuard(manifest, scoped, repo)
    expect(guard.allowed).toBe(false)
  })

  it('POSIX上のforbiddenPathsに含まれるバックスラッシュを区切り文字として誤変換しない', () => {
    if (process.platform === 'win32') return

    const scoped = buildRuntimeTaskPolicy({
      id: 'task-1',
      projectId: 'project-1',
      forbiddenPaths: ['src\\evil.ts'],
    })
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    // forbiddenPaths の "src\\evil.ts" が "src/evil.ts" へ誤変換されると、
    // 実ファイル名 "src\\evil.ts" 自体は禁止対象から外れて通過してしまう
    writeFileSync(path.join(repo, 'src\\evil.ts'), 'export const evil = 1\n', 'utf-8')
    git('add', '-A')
    git('commit', '-qm', 'literal backslash filename matches forbiddenPaths')

    const after = git('rev-parse', 'HEAD').trim()
    const manifest = buildCommitRangeManifest(repo, start, after)
    const guard = fileChangeGuard(manifest, scoped, repo)

    expect(guard.allowed).toBe(false)
  })

  it('checkout --detach で開始commitへ戻ると reflog検証がHEAD一致の早期returnより前に検出する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('.env', 'SECRET=hidden-by-checkout\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    git('checkout', '-q', '--detach', start)

    const after = git('rev-parse', 'HEAD').trim()
    // HEADは開始時と完全に一致する（単純なhash比較では異常を検出できない）
    expect(after).toBe(start)

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
  })

  it('reflogが無効化された環境（空reflog）は無条件でfail-closedになる', () => {
    // 別の一時repo（emptyRepo）で検証するため、共有の repo 自体は変更しない
    const emptyRepo = mkdtempSync(path.join(tmpdir(), 'no-reflog-'))
    execFileSync('git', ['init', '-q'], { cwd: emptyRepo, shell: false })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: emptyRepo, shell: false })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: emptyRepo, shell: false })
    execFileSync('git', ['config', 'core.logAllRefUpdates', 'false'], { cwd: emptyRepo, shell: false })
    writeFileSync(path.join(emptyRepo, 'a.txt'), 'x', 'utf-8')
    execFileSync('git', ['add', '-A'], { cwd: emptyRepo, shell: false })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: emptyRepo, shell: false })

    try {
      expect(() => captureReflogBaseline(emptyRepo)).not.toThrow()
      const baseline = captureReflogBaseline(emptyRepo)
      expect(baseline.headHashes).toEqual([])
      expect(() => assertNoHistoryRewrite(emptyRepo, baseline)).toThrow(ChangeDetectionError)
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true })
    }
  })

  it('baselineが空（reflog無効化状態で記録）だと、その後reflogが有効化されても即座にfail-closedになる', () => {
    // 2026-07-31 Codex closureレビューで発見・実測確認済み: baselineHashes=[] だと
    // previousHash の初期値が undefined になり、最初の新規エントリへの遷移だけ
    // fast-forward 検証がスキップされていた（fail-open）。
    const noReflogRepo = mkdtempSync(path.join(tmpdir(), 'baseline-empty-'))
    const runIn = (...args: string[]) =>
      execFileSync('git', args, { cwd: noReflogRepo, encoding: 'utf-8', shell: false })

    try {
      runIn('init', '-q')
      runIn('config', 'user.email', 't@t')
      runIn('config', 'user.name', 't')
      runIn('config', 'core.logAllRefUpdates', 'false')
      writeFileSync(path.join(noReflogRepo, 'a.txt'), 'x', 'utf-8')
      runIn('add', '-A')
      runIn('commit', '-qm', 'init')

      // Job開始時点：reflogが無効化されているため baseline は空
      const baseline = captureReflogBaseline(noReflogRepo)
      expect(baseline.headHashes).toEqual([])

      // AI CLI が通常の git config コマンドで reflog を有効化してから
      // 禁止commitを作る、という経路も通常のgit操作だけで成立する
      runIn('config', 'core.logAllRefUpdates', 'true')
      writeFileSync(path.join(noReflogRepo, '.env'), 'SECRET=1', 'utf-8')
      runIn('add', '-A')
      runIn('commit', '-qm', 'add secret after enabling reflog')

      // baseline が空のままなら、この最初の遷移も無条件で fail-closed になるべき
      expect(() => assertNoHistoryRewrite(noReflogRepo, baseline)).toThrow(ChangeDetectionError)
    } finally {
      rmSync(noReflogRepo, { recursive: true, force: true })
    }
  })

  it('baselineが存在し、正しい前進だけなら成功する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    expect(reflogBaseline.headHashes.length).toBeGreaterThan(0)

    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal forward commit')

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).not.toThrow()
    void start
  })

  it('baselineが存在し、巻き戻しがあれば失敗する', () => {
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)

    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'forward')
    git('reset', '--hard', start)

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
  })

  it('正常なfast-forwardで複数commitが一度に進んでも許可する（merge --ff-only）', () => {
    // 2026-07-31 選択肢B採用: reflogエントリ数とcommit数を突き合わせる検査
    // （countCommitsBetween）は撤去した。この検査は `git merge --ff-only` のように
    // 1回のreflog更新で複数commitが一気に進む正当な操作を誤って拒否する回帰があり
    // （実測確認済み）、かつ reflog完全削除は元々検出できていなかったため、
    // 実効性のない複雑さだけが残っていた。
    // ここでは、複数commitが一度のreflog更新で前進しても、
    // baseline suffix一致 + fast-forward判定（本検査が実際に維持する2本柱）
    // だけで正しく許可されることを固定する。
    git('checkout', '-qb', 'future')
    write('src/f1.ts', 'export const f1 = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'f1')
    write('src/f2.ts', 'export const f2 = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'f2')
    write('src/f3.ts', 'export const f3 = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'f3')

    git('checkout', '-q', 'master')
    const reflogBaseline = captureReflogBaseline(repo)

    // reflogは1行しか増えないが、実際には3commit分前進する
    git('merge', '--ff-only', 'future', '-q')

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).not.toThrow()
  })

  it('baseline自体のreflogエントリが消えている場合はsuffix不一致としてfail-closedになる', () => {
    // baseline記録時点のエントリそのものが `git reflog delete` 等で消えた場合、
    // isBaselineSuffix 判定だけで（countCommitsBetween無しでも）正しく検出できることを
    // 固定する（実測確認済み）。
    const reflogBaseline = captureReflogBaseline(repo)

    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal')

    // baseline記録時点のreflogエントリ（HEAD@{1}、＝baseline自体）を削除する
    git('reflog', 'delete', '--updateref', 'HEAD@{1}')

    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
  })

  it('branch上ではHEAD reflogだけの完全削除は防御される（branch reflogとの二重検証）', () => {
    // 実測で判明した重要な事実: `git reflog delete --updateref HEAD@{1}` は
    // HEAD reflog（.git/logs/HEAD）だけを操作し、branch自体のreflog
    // （.git/logs/refs/heads/<branch>）には影響しない。CEO指示により
    // HEAD reflogとbranch reflogの両方を検証する設計にしていたため、
    // branch reflog側は削除されずに残り、そちらの fast-forward 判定
    // （secret→start への巻き戻し）で正しく拒否される。
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    expect(reflogBaseline.branchRef).toBe('refs/heads/master')

    write('.env', 'SECRET=will-be-hidden\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    git('reset', '--hard', start)
    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal work')

    // HEAD reflogのエントリだけを完全に削除する（branch reflogには影響しない）
    git('reflog', 'delete', '--updateref', 'HEAD@{1}')
    git('reflog', 'delete', '--updateref', 'HEAD@{1}')

    // branch reflog側が生き残っているため拒否される
    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
  })

  it('detached HEADでのreflog完全削除まで防げるとは主張しない（既知の限界の明示）', () => {
    // 2026-07-31 確定: detached HEAD状態（branchRefが存在しない）では、
    // HEAD reflogしか検証対象が無く、branch reflogという第二の防御線が無い。
    // AI/Workerが.gitへの同一書き込み権限を持つ現在、detached HEAD状態での
    // reflogエントリの完全削除は、reflogベースの検証だけでは原理的に検出できない
    // （project-auto-worker-trust-boundary へ記録済み。MVP-BのOS隔離・
    // Git管理領域分離課題）。本テストはこの限界を「回帰していないことの確認」では
    // なく「既知の未解決事項」として明示的に記録する。
    git('checkout', '-q', '--detach', 'HEAD')
    const start = git('rev-parse', 'HEAD').trim()
    const reflogBaseline = captureReflogBaseline(repo)
    expect(reflogBaseline.branchRef).toBeUndefined()

    write('.env', 'SECRET=will-be-hidden\n')
    git('add', '-A')
    git('commit', '-qm', 'add secret')
    git('reset', '--hard', start)
    write('src/normal.ts', 'export const normal = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'normal work')

    // reset操作と秘密commitの両方のreflog行を完全に削除する
    git('reflog', 'delete', '--updateref', 'HEAD@{1}')
    git('reflog', 'delete', '--updateref', 'HEAD@{1}')

    // この検査は通過してしまう（防げないことの記録。将来この assertion が
    // failするようになったら、それは検出力が向上したことを意味する）
    expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).not.toThrow()
  })

  it('special file（socket等）は機密パターン走査でハッシュ計算せずfail-closedになる', () => {
    if (process.platform === 'win32') return

    const net = require('node:net') as typeof import('node:net')
    write('.gitignore', 'node_modules/\n*.sock\n')
    git('add', '-A')
    git('commit', '-qm', 'gitignore sock')

    const socketPath = path.join(repo, 'pkg.sock')
    const server = net.createServer()
    server.listen(socketPath)

    try {
      expect(() => scanSensitiveFiles(repo, [/\.sock$/])).toThrow(ChangeDetectionError)
    } finally {
      server.close()
    }
  })

  // ────────────────────────────────────────────────────────────
  // reflog: hash遷移ベースの検証（2026-07-31 5回目レビュー対応）
  //
  // reflog の subject / action 文字列（%gs）は GIT_REFLOG_ACTION 環境変数で
  // 任意に偽装できるため安全判定には使わない。隣接する reflog hash の遷移が
  // fast-forward 前進（または無変化）であることだけを検証する。
  // ────────────────────────────────────────────────────────────
  describe('reflog: hash遷移ベースの検証', () => {
    it('GIT_REFLOG_ACTION でsubjectを偽装したresetも拒否する', () => {
      const start = git('rev-parse', 'HEAD').trim()
      const reflogBaseline = captureReflogBaseline(repo)

      write('.env', 'SECRET=leaked\n')
      git('add', '-A')
      git('commit', '-qm', 'add secret')

      // GIT_REFLOG_ACTION でreset操作のreflog subjectを "commit: ..." に偽装する。
      // これは .git への直接書き込みではなく、通常の git コマンドのオプション機能。
      execFileSync('git', ['reset', '--hard', start], {
        cwd: repo,
        shell: false,
        env: { ...process.env, GIT_REFLOG_ACTION: 'commit: restore' },
      })

      const after = git('rev-parse', 'HEAD').trim()
      expect(after).toBe(start)

      // subjectが "commit: restore: ..." という許可リスト風の偽装文字列でも、
      // hash自体が start へ後退しているため拒否されなければならない
      expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
    })

    it('reflog subjectが任意の文字列でもhash遷移だけで前進を判定する', () => {
      const start = git('rev-parse', 'HEAD').trim()
      const reflogBaseline = captureReflogBaseline(repo)

      // 偽装した subject でも、hashが正しく前進していれば許可されるべき
      execFileSync('git', ['commit', '--allow-empty', '-qm', 'first'], {
        cwd: repo,
        shell: false,
        env: { ...process.env, GIT_REFLOG_ACTION: 'reset: totally not a commit' },
      })

      expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).not.toThrow()
      void start
    })

    it('start→commit1→commit2 という前進だけなら許可する', () => {
      const start = git('rev-parse', 'HEAD').trim()
      const reflogBaseline = captureReflogBaseline(repo)

      write('src/a.ts', 'export const a = 1\n')
      git('add', '-A')
      git('commit', '-qm', 'commit1')
      write('src/b.ts', 'export const b = 1\n')
      git('add', '-A')
      git('commit', '-qm', 'commit2')

      expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).not.toThrow()
      void start
    })

    it('start→commit→start→別commit という経路も拒否する', () => {
      const start = git('rev-parse', 'HEAD').trim()
      const reflogBaseline = captureReflogBaseline(repo)

      write('.env', 'SECRET=first-attempt\n')
      git('add', '-A')
      git('commit', '-qm', 'add secret')
      git('reset', '--hard', start)
      write('src/normal.ts', 'export const normal = 1\n')
      git('add', '-A')
      git('commit', '-qm', 'second attempt')

      expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
    })

    it('unrelated commit（共通祖先を持たない別履歴のcommit）への移動を拒否する', () => {
      const start = git('rev-parse', 'HEAD').trim()

      // git checkout -b は現在のcommitから分岐するため、生まれるcommitは
      // startの子孫になってしまい「unrelated」を検証できない
      // （2026-07-31 Codex closureレビューで発見・実測確認済み）。
      // --orphan で共通祖先を一切持たない別履歴を作る。
      git('checkout', '-q', '--orphan', 'unrelated-history')
      git('rm', '-rf', '-q', '.')
      write('unrelated.txt', 'no shared history with start\n')
      git('add', '-A')
      git('commit', '-qm', 'orphan root commit')
      const unrelatedCommit = git('rev-parse', 'HEAD').trim()

      // 作成したcommitが本当にstartの子孫でも祖先でもないことを明示的に確認する
      expect(() => execFileSync('git', ['merge-base', '--is-ancestor', start, unrelatedCommit], {
        cwd: repo,
        shell: false,
      })).toThrow()
      expect(() => execFileSync('git', ['merge-base', '--is-ancestor', unrelatedCommit, start], {
        cwd: repo,
        shell: false,
      })).toThrow()

      // 元のbranch（master）へ戻り、branchRefを変えないまま reset --hard で
      // unrelated commit へ強制移動する。branchRef不一致チェックをすり抜けさせ、
      // hash遷移の fast-forward 判定（merge-base --is-ancestor）だけで
      // 拒否されることを直接確認する。
      git('checkout', '-q', 'master')
      const reflogBaseline = captureReflogBaseline(repo)
      expect(reflogBaseline.branchRef).toBe('refs/heads/master')

      git('reset', '--hard', unrelatedCommit)
      const afterBaseline = captureReflogBaseline(repo)
      expect(afterBaseline.branchRef).toBe('refs/heads/master') // branch自体は変わっていない

      expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
    })

    it('branchの切り替えを拒否する（MVPでは実行中のbranch切替を許可しない）', () => {
      git('checkout', '-qb', 'feature')
      write('src/feature.ts', 'export const feature = 1\n')
      git('add', '-A')
      git('commit', '-qm', 'feature work')
      const featureHead = git('rev-parse', 'HEAD').trim()

      const reflogBaseline = captureReflogBaseline(repo)
      expect(reflogBaseline.branchRef).toBe('refs/heads/feature')

      // feature の子孫ブランチを作って切り替える（hashとしては前進でも、branch自体が変わる）
      git('checkout', '-qb', 'feature-2')
      write('src/feature2.ts', 'export const feature2 = 1\n')
      git('add', '-A')
      git('commit', '-qm', 'feature2 work')

      expect(() => assertNoHistoryRewrite(repo, reflogBaseline)).toThrow(ChangeDetectionError)
      void featureHead
    })
  })
})
