import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCurrentWorktreeDiff, readExactApprovalDiff } from './diffReader'

const temporaryDirectories: string[] = []

function runGit(workingDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createFixtureRepository(): string {
  const workingDir = mkdtempSync(path.join(tmpdir(), 'approval-diff-reader-'))
  temporaryDirectories.push(workingDir)

  runGit(workingDir, ['init', '--object-format=sha1'])
  runGit(workingDir, ['config', 'user.email', 'diff-reader@example.test'])
  runGit(workingDir, ['config', 'user.name', 'Diff Reader Test'])
  runGit(workingDir, ['config', 'core.autocrlf', 'false'])
  runGit(workingDir, ['config', 'core.abbrev', '7'])

  writeFileSync(path.join(workingDir, 'tracked.txt'), 'before\n', 'utf-8')
  runGit(workingDir, ['add', 'tracked.txt'])
  runGit(workingDir, ['commit', '-m', 'fixture base'])

  writeFileSync(path.join(workingDir, 'tracked.txt'), 'after\n', 'utf-8')
  writeFileSync(path.join(workingDir, 'new file.txt'), 'first\r\nsecond\n', 'utf-8')

  return workingDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('readExactApprovalDiff', () => {
  it('matches the Worker diff-text algorithm for tracked and untracked changes', () => {
    const workingDir = createFixtureRepository()
    const current = readCurrentWorktreeDiff(workingDir)

    expect(current.diffText).toBe(
      [
        'diff --git a/tracked.txt b/tracked.txt',
        'index 90be1f3..294186e 100644',
        '--- a/tracked.txt',
        '+++ b/tracked.txt',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        '',
        'diff --git a/new file.txt b/new file.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new file.txt',
        '+first',
        '+second',
        '+',
      ].join('\n'),
    )
    expect(current.diffHash).toBe('a130a0a80b6ba486bbebcf1838e1f5e739d5a68f235b296d18a7e6e69c82025f')

    expect(readExactApprovalDiff(workingDir, current.headCommit, current.diffHash)).toEqual({
      stale: false,
      ...current,
    })
  })

  it('does not return diff text when HEAD does not match', () => {
    const workingDir = createFixtureRepository()
    const current = readCurrentWorktreeDiff(workingDir)
    const result = readExactApprovalDiff(workingDir, '0'.repeat(40), current.diffHash)

    expect(result.stale).toBe(true)
    expect(result).not.toHaveProperty('diffText')
  })

  it('does not return diff text when the diff hash does not match', () => {
    const workingDir = createFixtureRepository()
    const current = readCurrentWorktreeDiff(workingDir)
    const result = readExactApprovalDiff(workingDir, current.headCommit, '0'.repeat(64))

    expect(result.stale).toBe(true)
    expect(result).not.toHaveProperty('diffText')
  })
})
