/**
 * File Change Guard のテスト。
 *
 * 検出（changeManifest）と判定（このファイル）を分離しているため、
 * ここでは manifest を直接組み立てて判定ロジックだけを検証する。
 */
import { describe, expect, it } from 'vitest'
import type { ChangeManifest, FileChange } from './changeManifest.js'
import { buildRuntimeTaskPolicy, fileChangeGuard } from './fileChangeGuard.js'

const WORKTREE = '/workspace/target'

function manifest(...changes: FileChange[]): ChangeManifest {
  const paths: string[] = []
  for (const change of changes) {
    if (!paths.includes(change.path)) paths.push(change.path)
    if (change.oldPath && !paths.includes(change.oldPath)) paths.push(change.oldPath)
  }
  return { changes, paths }
}

function policy(overrides: { allowedPaths?: string[]; forbiddenPaths?: string[] } = {}) {
  return buildRuntimeTaskPolicy({
    id: 'task-1',
    projectId: 'project-1',
    allowedPaths: overrides.allowedPaths,
    forbiddenPaths: overrides.forbiddenPaths,
  })
}

const added = (path: string): FileChange => ({ path, kind: 'added', afterType: 'regular' })
const modified = (path: string): FileChange => ({ path, kind: 'modified', afterType: 'regular' })

describe('buildRuntimeTaskPolicy', () => {
  it('allowedPaths / forbiddenPaths をコピーして freeze する（実行中不変）', () => {
    const source = { id: 't', projectId: 'p', allowedPaths: ['src'], forbiddenPaths: ['secret'] }
    const built = buildRuntimeTaskPolicy(source)

    source.allowedPaths.push('mutated')

    expect(built.allowedPaths).toEqual(['src'])
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.allowedPaths)).toBe(true)
  })

  it('id / projectId が無い場合は構築に失敗する', () => {
    expect(() => buildRuntimeTaskPolicy({ id: '', projectId: 'p' } as never)).toThrow()
    expect(() => buildRuntimeTaskPolicy({ id: 't', projectId: '' } as never)).toThrow()
  })
})

describe('fileChangeGuard — 常時禁止パターン', () => {
  it('新規作成された .env を拒否する', () => {
    const result = fileChangeGuard(manifest(added('.env')), policy(), WORKTREE)

    expect(result.allowed).toBe(false)
    expect(result.violations).toContain('.env')
    expect(result.reasons['.env']).toMatch(/Always-forbidden/)
  })

  it('新規作成された .pem を拒否する', () => {
    const result = fileChangeGuard(manifest(added('certs/server.pem')), policy(), WORKTREE)

    expect(result.allowed).toBe(false)
    expect(result.violations).toContain('certs/server.pem')
  })

  it('.env.local など .env. 系も拒否する', () => {
    const result = fileChangeGuard(manifest(added('.env.production')), policy(), WORKTREE)

    expect(result.allowed).toBe(false)
  })

  it('通常の変更は誤って拒否しない', () => {
    const result = fileChangeGuard(
      manifest(modified('src/index.ts'), added('src/new.ts')),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(true)
    expect(result.violations).toEqual([])
  })
})

describe('fileChangeGuard — 実体種別', () => {
  it('新規 symlink を拒否する', () => {
    const result = fileChangeGuard(
      manifest({ path: 'src/link.ts', kind: 'added', afterType: 'symlink' }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['src/link.ts']).toMatch(/symlink/i)
  })

  it('通常ファイルから symlink への type change を拒否する', () => {
    const result = fileChangeGuard(
      manifest({
        path: 'src/config.ts',
        kind: 'modified',
        beforeType: 'regular',
        afterType: 'symlink',
      }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['src/config.ts']).toMatch(/Type change to symlink/)
  })

  it('nested repository（gitlink）を拒否する', () => {
    const result = fileChangeGuard(
      manifest({ path: 'vendor/lib', kind: 'added', afterType: 'gitlink' }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['vendor/lib']).toMatch(/gitlink/)
  })

  it('分類不能な特殊 file type を拒否する', () => {
    const result = fileChangeGuard(
      manifest({ path: 'src/weird.sock', kind: 'added', afterType: 'special' }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['src/weird.sock']).toMatch(/Unclassifiable/)
  })

  it('symlink の削除は拒否しない（削除は afterType を持たない）', () => {
    const result = fileChangeGuard(
      manifest({ path: 'src/link.ts', kind: 'deleted', beforeType: 'symlink' }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(true)
  })
})

describe('fileChangeGuard — rename は旧・新の両パスを検査する', () => {
  it('rename の新パスだけが禁止対象でも拒否する', () => {
    const result = fileChangeGuard(
      manifest({ path: '.env', oldPath: 'src/config.ts', kind: 'renamed', afterType: 'regular' }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.violations).toContain('.env')
  })

  it('rename の旧パスだけが禁止対象でも拒否する', () => {
    const result = fileChangeGuard(
      manifest({ path: 'src/config.ts', oldPath: '.env', kind: 'renamed', afterType: 'regular' }),
      policy(),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.violations).toContain('.env')
  })

  it('旧パスが allowedPaths 外なら拒否する', () => {
    const result = fileChangeGuard(
      manifest({
        path: 'src/moved.ts',
        oldPath: 'other/original.ts',
        kind: 'renamed',
        afterType: 'regular',
      }),
      policy({ allowedPaths: ['src'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.violations).toContain('other/original.ts')
  })

  it('旧パス・新パスともに許可範囲なら通す', () => {
    const result = fileChangeGuard(
      manifest({
        path: 'src/moved.ts',
        oldPath: 'src/original.ts',
        kind: 'renamed',
        afterType: 'regular',
      }),
      policy({ allowedPaths: ['src'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(true)
  })
})

describe('fileChangeGuard — Task ポリシー', () => {
  it('allowedPaths 外の新規ファイルを拒否する', () => {
    const result = fileChangeGuard(
      manifest(added('apps/api/src/leak.ts')),
      policy({ allowedPaths: ['apps/worker'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['apps/api/src/leak.ts']).toMatch(/allowedPaths/)
  })

  it('forbiddenPaths 内の新規ファイルを拒否する', () => {
    const result = fileChangeGuard(
      manifest(added('infra/deploy.yaml')),
      policy({ forbiddenPaths: ['infra'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['infra/deploy.yaml']).toMatch(/forbiddenPaths/)
  })

  it('allowedPaths が空なら制限しない（既存挙動を維持）', () => {
    const result = fileChangeGuard(manifest(added('anywhere/file.ts')), policy(), WORKTREE)

    expect(result.allowed).toBe(true)
  })

  it('allowedPaths の前方一致は境界を尊重する（src が srcfoo を許可しない）', () => {
    const result = fileChangeGuard(
      manifest(added('srcfoo/file.ts')),
      policy({ allowedPaths: ['src'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
  })

  it('末尾スラッシュなしの allowedPaths は従来どおり配下の変更を許可する', () => {
    const result = fileChangeGuard(
      manifest(modified('src/runner/workflow-runner.js')),
      policy({ allowedPaths: ['src/runner'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(true)
  })
})

describe('fileChangeGuard — allowedPaths の末尾スラッシュ正規化（2026-08-24 誤拒否修正）', () => {
  // roadmapGenerator のプロンプト規約上、allowedPaths は「src/runner/」のように
  // 末尾スラッシュ付きで生成される。正規化せずに ap + '/' と連結すると
  // 「src/runner//」という二重スラッシュ一致になり、配下の正当なファイルまで
  // 拒否されていた（task 73c75496 の実測による誤拒否）。
  it('末尾スラッシュ付きの allowedPaths も配下の変更を許可する', () => {
    const result = fileChangeGuard(
      manifest(modified('src/runner/workflow-runner.js')),
      policy({ allowedPaths: ['src/workflow/', 'src/runner/'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('末尾スラッシュ付きでも範囲外のファイルは拒否する（過剰許可にしない）', () => {
    const result = fileChangeGuard(
      manifest(added('src/other/x.ts')),
      policy({ allowedPaths: ['src/runner/'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(false)
    expect(result.reasons['src/other/x.ts']).toMatch(/allowedPaths/)
  })

  it('末尾スラッシュ付きエントリそのものと一致する path も許可する', () => {
    const result = fileChangeGuard(
      manifest(modified('src/runner')),
      policy({ allowedPaths: ['src/runner/'] }),
      WORKTREE,
    )

    expect(result.allowed).toBe(true)
  })
})

describe('fileChangeGuard — パス境界', () => {
  it('worktree の外へ出るパスを拒否する', () => {
    const result = fileChangeGuard(manifest(added('../escape.ts')), policy(), WORKTREE)

    expect(result.allowed).toBe(false)
    expect(result.reasons['../escape.ts']).toMatch(/traversal|outside/i)
  })

  it('worktreeRoot 引数を基準に正規化する（ハードコードしない）', () => {
    const result = fileChangeGuard(
      manifest(added('src/index.ts')),
      policy({ allowedPaths: ['src'] }),
      '/workspace/job-worktrees/project-1/job-1',
    )

    expect(result.allowed).toBe(true)
  })
})

describe('CONTROL REPOSITORY 保護対象の回帰確認', () => {
  // 2026-07-31: 禁止側 case-fold 対応（Codex指摘）の実装ミスにより、判定対象文字列だけを
  // toLowerCase() してから大文字小文字区別ありのパターンでテストしていたため、
  // jobRunner・changeManifest 等キャメルケースを含む保護パターン自体が機能しなくなる
  // 重大な回帰が発生していた（実測で発見・即修正）。ALWAYS_FORBIDDEN_PATTERNS 全件を
  // 大文字小文字を変えても確実に検出できることを回帰テストとして固定する。
  const protectedPaths = [
    'src/jobRunner.ts',
    'src/guards/changeManifest.ts',
    'src/guards/fileChangeGuard.ts',
    'src/guards/permissionGuard.ts',
    'src/guards/safetyAuditor.ts',
    'src/guards/alignmentChecker.ts',
    'src/guards/gateProcessor.ts',
    'src/utils/pathUtils.ts',
    'src/types/safety_guard.ts',
    'src/metaReviewer/geminiClient.ts',
  ]

  it.each(protectedPaths)('%s への変更を元の大文字小文字のまま検出する', (rel) => {
    const result = fileChangeGuard(manifest(modified(rel)), policy(), WORKTREE)
    expect(result.allowed).toBe(false)
  })

  it.each(protectedPaths)('%s を全て小文字にしても検出する', (rel) => {
    const result = fileChangeGuard(manifest(modified(rel.toLowerCase())), policy(), WORKTREE)
    expect(result.allowed).toBe(false)
  })

  it.each(protectedPaths)('%s を全て大文字にしても検出する', (rel) => {
    const result = fileChangeGuard(manifest(modified(rel.toUpperCase())), policy(), WORKTREE)
    expect(result.allowed).toBe(false)
  })
})

describe('CONTROL REPOSITORY保護対象 — adapter.ts / index.ts の完全パス一致（2026-07-31追加）', () => {
  // adapter.ts・index.ts は一般的なファイル名のため、単語一致ではなく
  // Repository相対の完全パス一致で保護する。target-project側の一般的な
  // index.ts / adapter.ts を誤拒否しないことも合わせて確認する。

  it('apps/worker/src/aiCli/adapter.ts を拒否する', () => {
    const result = fileChangeGuard(
      manifest(modified('apps/worker/src/aiCli/adapter.ts')),
      policy(),
      WORKTREE,
    )
    expect(result.allowed).toBe(false)
  })

  it('apps/worker/src/aiCli/adapter.ts は大文字小文字違いでも拒否する', () => {
    const result = fileChangeGuard(
      manifest(modified('APPS/WORKER/SRC/AICLI/ADAPTER.TS')),
      policy(),
      WORKTREE,
    )
    expect(result.allowed).toBe(false)
  })

  it('apps/worker/src/index.ts を拒否する', () => {
    const result = fileChangeGuard(manifest(modified('apps/worker/src/index.ts')), policy(), WORKTREE)
    expect(result.allowed).toBe(false)
  })

  it('apps/worker/src/index.ts は大文字小文字違いでも拒否する', () => {
    const result = fileChangeGuard(manifest(modified('APPS/Worker/Src/Index.TS')), policy(), WORKTREE)
    expect(result.allowed).toBe(false)
  })

  it('apps/mobile/src/index.ts 等、別パスの index.ts は誤拒否しない', () => {
    const result = fileChangeGuard(manifest(modified('apps/mobile/src/index.ts')), policy(), WORKTREE)
    expect(result.allowed).toBe(true)
  })

  it('target-project側の一般的な src/index.ts は誤拒否しない', () => {
    const result = fileChangeGuard(manifest(modified('src/index.ts')), policy(), WORKTREE)
    expect(result.allowed).toBe(true)
  })

  it('target-project側の一般的な src/aiCli/adapter.ts（apps/worker配下ではない）は誤拒否しない', () => {
    const result = fileChangeGuard(manifest(modified('src/aiCli/adapter.ts')), policy(), WORKTREE)
    expect(result.allowed).toBe(true)
  })

  it('apps/worker/src/index.ts の部分一致（別ディレクトリ配下）は誤拒否しない', () => {
    const result = fileChangeGuard(
      manifest(modified('libs/apps/worker/src/index.ts')),
      policy(),
      WORKTREE,
    )
    expect(result.allowed).toBe(true)
  })
})
