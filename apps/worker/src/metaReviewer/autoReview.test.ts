/**
 * buildDiffRangeArgs() の実 git 回帰テスト（Meta Review 事象2: phantom deletion による false BLOCKED）
 *
 * 再現する状況（PR #99 実例）:
 *   base から branch を切った後に別 PR が base へマージされ、head がその commit を含まない。
 *   このとき二点間 diff（`git diff baseTip headSha`）では、base 側にだけ存在する変更が
 *   head 側の「削除」として現れ、Meta Review が実在しない削除を critical と判定する。
 *
 * ここでは「二点間なら phantom deletion が起きる」ことを fixture で先に確認したうえで、
 * buildDiffRangeArgs() が返す引数（三点間）ではそれが起きないことを実 git で検証する。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDiffRangeArgs } from './autoReview.js'

let repo: string
/** head が branch を切った時点の base（merge-base） */
let forkPointSha: string
/** PR head。docs を1ファイル追加しただけ */
let headSha: string
/** 現在の base tip。head が含まない commit を1つ持つ */
let baseTipSha: string

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', shell: false })
}

function writeRepoFile(relativePath: string, content: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf-8')
}

function commitAll(message: string): string {
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', message)
  return gitIn(repo, 'rev-parse', 'HEAD').trim()
}

function changedFiles(nameOnlyArgs: string[]): string[] {
  return gitIn(repo, ...nameOnlyArgs).trim().split('\n').filter(Boolean)
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'auto-review-diff-'))
  gitIn(repo, 'init', '-q')
  // Windows でも決定的な diff にするため行末変換を無効化する。
  gitIn(repo, 'config', 'core.autocrlf', 'false')
  gitIn(repo, 'config', 'user.email', 'test@example.com')
  gitIn(repo, 'config', 'user.name', 'test')

  // 1. 分岐点（PR が branch を切った時点の base）
  writeRepoFile('docs/workflow.md', 'project start workflow\n')
  forkPointSha = commitAll('init')
  const baseBranch = gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()

  // 2. head 側: docs を1ファイル追加するだけの PR
  gitIn(repo, 'checkout', '-q', '-b', 'pr-branch')
  writeRepoFile('tasks/roadmap.md', 'roadmap entry\n')
  headSha = commitAll('docs: add roadmap entry')

  // 3. base 側: 分岐後に別 PR がマージされ、base tip が head の知らない commit を持つ
  gitIn(repo, 'checkout', '-q', baseBranch)
  writeRepoFile('docs/project_start_workflow.md', 'merged by another PR\n')
  writeRepoFile('docs/workflow.md', 'project start workflow\nupdated by another PR\n')
  baseTipSha = commitAll('feat: merge another PR')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('buildDiffRangeArgs — GitHub Actions（BASE_SHA / HEAD_SHA あり）', () => {
  it('fixture 前提: 二点間 diff では base 側 commit が phantom deletion として現れる', () => {
    // この確認が落ちる場合、fixture が事象を再現できておらず後続テストは無意味になる。
    expect(changedFiles(['diff', '--name-only', baseTipSha, headSha]))
      .toContain('docs/project_start_workflow.md')
    expect(gitIn(repo, 'diff', baseTipSha, headSha)).toContain('deleted file mode')
  })

  it('三点間 diff は head の実変更だけを返し、phantom deletion を含まない', () => {
    const { diffArgs, nameOnlyArgs } = buildDiffRangeArgs(baseTipSha, headSha)

    expect(changedFiles(nameOnlyArgs)).toEqual(['tasks/roadmap.md'])

    const diff = gitIn(repo, ...diffArgs)
    expect(diff).toContain('+++ b/tasks/roadmap.md')
    expect(diff).not.toContain('deleted file mode')
    expect(diff).not.toContain('project_start_workflow')
  })

  it('merge-base 起点（baseSha...headSha）の形で git を呼ぶ', () => {
    expect(buildDiffRangeArgs(baseTipSha, headSha)).toEqual({
      diffArgs: ['diff', `${baseTipSha}...${headSha}`],
      nameOnlyArgs: ['diff', '--name-only', `${baseTipSha}...${headSha}`],
    })
  })

  it('base 側の削除は head 側の追加として現れない（phantom addition も起きない）', () => {
    // 事象2の逆向き。base が分岐後にファイルを削除すると、二点間では
    // 「head がそのファイルを復活させた」ように見え、削除済みファイルの再追加として
    // false BLOCKED になりうる。三点間ではどちらも起きない。
    rmSync(path.join(repo, 'docs/workflow.md'))
    const baseTipWithDeletion = commitAll('chore: base removes workflow doc')

    expect(changedFiles(['diff', '--name-only', baseTipWithDeletion, headSha]))
      .toContain('docs/workflow.md')

    const { diffArgs, nameOnlyArgs } = buildDiffRangeArgs(baseTipWithDeletion, headSha)

    expect(changedFiles(nameOnlyArgs)).toEqual(['tasks/roadmap.md'])
    expect(gitIn(repo, ...diffArgs)).not.toContain('docs/workflow.md')
  })

  it('head 自身が行った削除は三点間でも削除として報告する（レビュー対象を取りこぼさない）', () => {
    // 三点間化で phantom deletion が消えることと引き換えに、**実在する削除**まで
    // 見えなくなっていないことを確認する。ここが落ちると Meta Review が本物の
    // ファイル削除を審査できなくなる（fail-open）。
    gitIn(repo, 'checkout', '-q', 'pr-branch')
    rmSync(path.join(repo, 'docs/workflow.md'))
    const headWithDeletion = commitAll('chore: remove workflow doc in PR')

    const { diffArgs, nameOnlyArgs } = buildDiffRangeArgs(baseTipSha, headWithDeletion)

    expect(changedFiles(nameOnlyArgs)).toContain('docs/workflow.md')
    expect(gitIn(repo, ...diffArgs)).toContain('deleted file mode')
  })

  it('head が base tip の祖先（完全に遅れている）でも削除を報告しない', () => {
    const { nameOnlyArgs } = buildDiffRangeArgs(baseTipSha, forkPointSha)

    expect(changedFiles(nameOnlyArgs)).toEqual([])
  })

  it('base と head が同一なら差分なし', () => {
    const { nameOnlyArgs } = buildDiffRangeArgs(headSha, headSha)

    expect(changedFiles(nameOnlyArgs)).toEqual([])
  })
})

describe('buildDiffRangeArgs — ローカル実行（BASE_SHA / HEAD_SHA なし）', () => {
  it('直前コミットとの差分のまま変更しない', () => {
    const { diffArgs, nameOnlyArgs } = buildDiffRangeArgs(undefined, undefined)

    expect(diffArgs).toEqual(['diff', 'HEAD~1', 'HEAD'])
    // HEAD = base tip、HEAD~1 = 分岐点。base 側 commit の変更がそのまま出る。
    expect(changedFiles(nameOnlyArgs)).toEqual([
      'docs/project_start_workflow.md',
      'docs/workflow.md',
    ])
  })

  it('base / head の片方しか無い場合もローカル扱いにフォールバックする', () => {
    expect(buildDiffRangeArgs(baseTipSha, undefined).diffArgs).toEqual(['diff', 'HEAD~1', 'HEAD'])
    expect(buildDiffRangeArgs(undefined, headSha).diffArgs).toEqual(['diff', 'HEAD~1', 'HEAD'])
  })
})
