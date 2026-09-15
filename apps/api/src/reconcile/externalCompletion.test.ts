import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { verifyExternalCompletion, type ExternalCompletionEvidence } from './externalCompletion'

/**
 * 外部完了の根拠検証。**呼び出し側の自己申告では通らない**ことを固定する。
 *
 * 実 git リポジトリを作って「Stable の HEAD の祖先か」を本当に判定させる
 * （ここをモックにすると、検証していることの証明にならない）。
 */

const temporaryDirectories: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', shell: false }).trim()
}

function createStableRepo(): { repo: string; mergedSha: string; unmergedSha: string } {
  const repo = mkdtempSync(path.join(tmpdir(), 'reconcile-stable-'))
  temporaryDirectories.push(repo)
  git(repo, ['init', '--object-format=sha1'])
  git(repo, ['config', 'user.email', 'reconcile@example.test'])
  git(repo, ['config', 'user.name', 'Reconcile Test'])

  writeFileSync(path.join(repo, 'base.txt'), 'base\n', 'utf-8')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])

  writeFileSync(path.join(repo, 'apps/worker-src-jobRunner.ts'.replace(/\//g, '-')), 'impl\n', 'utf-8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'tier b implementation'])
  const mergedSha = git(repo, ['rev-parse', 'HEAD'])

  // deploy されていない（Stable の HEAD の子孫）commit を作ってから HEAD を戻す
  writeFileSync(path.join(repo, 'later.txt'), 'later\n', 'utf-8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'not deployed yet'])
  const unmergedSha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['reset', '--hard', mergedSha])

  return { repo, mergedSha, unmergedSha }
}

function seedTask(): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapTaskKey: 'guard-block-message-omits-allowed-paths',
  } as Parameters<IStorage['tasks']['create']>[0])
  return { storage, taskId: task.id }
}

function evidenceFor(commitSha: string, over: Partial<ExternalCompletionEvidence> = {}): ExternalCompletionEvidence {
  return {
    roadmapItemId: 'guard-block-message-omits-allowed-paths',
    commitSha,
    pullRequestUrl: 'https://github.com/o/r/pull/216',
    independentReviewVerdict: 'approved',
    ciResult: 'Typecheck & Test pass / Meta Reviewer pass',
    acceptanceEvidence: 'block message now lists allowedPaths',
    approvedScope: 'Tier B: minimal protected-file change for this task only',
    ...over,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('verifyExternalCompletion — 自己申告では通らない', () => {
  it('merge 済みかつ deploy 済みの commit なら通る', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(storage, taskId, evidenceFor(mergedSha), repo)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.verified.changedFiles.length).toBeGreaterThan(0)
  })

  it('Stable へ deploy されていない commit は通らない（merge 済みと deploy 済みを同時に見る）', () => {
    const { repo, unmergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(storage, taskId, evidenceFor(unmergedSha), repo)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not merged to canonical master, or not deployed yet')
  })

  it('Roadmap item が Task のものと違えば通らない（別成果で別 Task を閉じさせない）', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(
      storage, taskId, evidenceFor(mergedSha, { roadmapItemId: 'some-other-item' }), repo,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('does not match')
  })

  it('Independent Review が approved でなければ通らない', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(
      storage, taskId, evidenceFor(mergedSha, { independentReviewVerdict: 'changes_requested' }), repo,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('must be "approved"')
  })

  it('根拠が1つでも空なら通らない（記録を形骸化させない）', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(
      storage, taskId, evidenceFor(mergedSha, { approvedScope: '   ' }), repo,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('approvedScope')
  })

  it('commitSha が hex でなければ git へ渡さない', () => {
    const { repo } = createStableRepo()
    const { storage, taskId } = seedTask()

    const result = verifyExternalCompletion(storage, taskId, evidenceFor('HEAD; rm -rf /'), repo)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('hex git object name')
  })

  it('既に done な Task は通らない（二重反映しない）', () => {
    const { repo, mergedSha } = createStableRepo()
    const { storage, taskId } = seedTask()
    storage.tasks.update(taskId, { status: 'done' })

    const result = verifyExternalCompletion(storage, taskId, evidenceFor(mergedSha), repo)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already done')
  })
})
