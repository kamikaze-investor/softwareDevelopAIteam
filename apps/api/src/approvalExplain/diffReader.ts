import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024
const UNTRACKED_DIFF_MAX_BYTES = 256 * 1024
const MODE_ABSENT = '000000'

export class ApprovalDiffReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalDiffReadError'
  }
}

export type ApprovalDiffReadResult =
  | {
      stale: false
      headCommit: string
      diffHash: string
      diffText: string
    }
  | {
      stale: true
      headCommit: string
      diffHash: string
    }

function runGit(workingDir: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: workingDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApprovalDiffReadError(`git ${args.join(' ')} failed: ${message}`)
  }
}

function assertWorktreeRoot(workingDir: string): void {
  const topLevel = runGit(workingDir, ['rev-parse', '--show-toplevel']).trim()
  if (topLevel.length === 0) {
    throw new ApprovalDiffReadError(`Not a git worktree: "${workingDir}"`)
  }

  let realTopLevel: string
  let realWorkingDir: string
  try {
    realTopLevel = realpathSync(topLevel)
    realWorkingDir = realpathSync(workingDir)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApprovalDiffReadError(`Failed to resolve worktree root: ${message}`)
  }

  if (path.relative(realTopLevel, realWorkingDir) !== '') {
    throw new ApprovalDiffReadError(
      `workingDir is not the git worktree root: workingDir="${realWorkingDir}" topLevel="${realTopLevel}"`,
    )
  }
}

function resolveInsideWorktree(workingDir: string, relativePath: string): string {
  const root = path.resolve(workingDir)
  const absolute = path.resolve(root, relativePath)

  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ApprovalDiffReadError(`Path escapes worktree: "${relativePath}"`)
  }

  return absolute
}

function splitNulSegments(raw: string): string[] {
  const segments = raw.split('\0')
  if (segments.at(-1) === '') {
    segments.pop()
  }
  return segments
}

function splitFields(record: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = []
  let index = 0

  for (let fieldIndex = 0; fieldIndex < count; fieldIndex += 1) {
    const separator = record.indexOf(' ', index)
    if (separator < 0) {
      throw new ApprovalDiffReadError(`Malformed git status record: "${record}"`)
    }
    fields.push(record.slice(index, separator))
    index = separator + 1
  }

  return { fields, rest: record.slice(index) }
}

function isRegularAddedEntry(
  workingDir: string,
  relativePath: string,
  modeWorktree?: string,
  modeIndex?: string,
): boolean {
  const mode = modeWorktree !== undefined && modeWorktree !== MODE_ABSENT
    ? modeWorktree
    : modeIndex !== undefined && modeIndex !== MODE_ABSENT
      ? modeIndex
      : undefined

  if (mode !== undefined) {
    if (mode === '100644' || mode === '100755') return true
    if (mode === '120000' || mode === '160000') return false
    throw new ApprovalDiffReadError(`Unknown git file mode: "${mode}"`)
  }

  const absolute = resolveInsideWorktree(workingDir, relativePath)
  let stat
  try {
    stat = lstatSync(absolute)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApprovalDiffReadError(`lstat failed for "${relativePath}": ${message}`)
  }

  if (stat.isFile()) return true
  if (stat.isSymbolicLink() || stat.isDirectory()) return false
  throw new ApprovalDiffReadError(`Unclassifiable file type for "${relativePath}"`)
}

/**
 * WorkerのbuildWorktreeManifest()と同じporcelain v2順で、synthetic diff対象を列挙する。
 * ordinaryのindex追加もWorkerと同様に扱うため、将来呼び出し順が変わっても文字列契約を維持する。
 */
function listRegularAddedPaths(workingDir: string): string[] {
  const raw = runGit(workingDir, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  const segments = splitNulSegments(raw)
  const paths: string[] = []

  for (let index = 0; index < segments.length; index += 1) {
    const record = segments[index]
    if (record === '') continue

    if (record[0] === '?') {
      const { rest: relativePath } = splitFields(record, 1)
      if (isRegularAddedEntry(workingDir, relativePath)) {
        paths.push(relativePath)
      }
      continue
    }

    if (record[0] === '1') {
      const { fields, rest: relativePath } = splitFields(record, 8)
      const xy = fields[1]
      const submoduleState = fields[2]
      if (!submoduleState.startsWith('N')) {
        throw new ApprovalDiffReadError(`Submodule change is not supported: "${relativePath}"`)
      }
      const isDeleted = xy[0] === 'D' || xy[1] === 'D'
      const isAdded = !isDeleted && xy[0] === 'A'
      if (
        isAdded &&
        isRegularAddedEntry(workingDir, relativePath, fields[5], fields[4])
      ) {
        paths.push(relativePath)
      }
      continue
    }

    if (record[0] === '2') {
      const { fields, rest: relativePath } = splitFields(record, 9)
      if (!fields[2].startsWith('N')) {
        throw new ApprovalDiffReadError(`Submodule change is not supported: "${relativePath}"`)
      }
      if (!fields[8].startsWith('R')) {
        throw new ApprovalDiffReadError(`Copy detection is not supported: "${relativePath}"`)
      }
      if (segments[index + 1] === undefined) {
        throw new ApprovalDiffReadError(`Rename record is missing its original path: "${relativePath}"`)
      }
      index += 1
      continue
    }

    if (record[0] === 'u') {
      throw new ApprovalDiffReadError('Unmerged paths are not supported')
    }

    throw new ApprovalDiffReadError(`Unknown git status record: "${record}"`)
  }

  return paths
}

function buildSyntheticAddedDiff(workingDir: string, relativePath: string): string {
  const absolute = resolveInsideWorktree(workingDir, relativePath)

  let content: string
  try {
    const size = lstatSync(absolute).size
    if (size > UNTRACKED_DIFF_MAX_BYTES) {
      throw new ApprovalDiffReadError(
        `Untracked file "${relativePath}" exceeds ${UNTRACKED_DIFF_MAX_BYTES} bytes`,
      )
    }
    content = readFileSync(absolute, 'utf-8')
  } catch (error: unknown) {
    if (error instanceof ApprovalDiffReadError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ApprovalDiffReadError(`Failed to read "${relativePath}": ${message}`)
  }

  const addedLines = content
    .split(/\r?\n/)
    .map((line) => `+${line}`)
    .join('\n')

  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    addedLines,
  ].join('\n')
}

export function readCurrentWorktreeDiff(workingDir: string): {
  headCommit: string
  diffHash: string
  diffText: string
} {
  assertWorktreeRoot(workingDir)

  const headCommit = runGit(workingDir, ['rev-parse', 'HEAD']).trim()
  const trackedDiff = runGit(workingDir, ['diff', 'HEAD'])
  const untrackedParts = listRegularAddedPaths(workingDir).map((relativePath) =>
    buildSyntheticAddedDiff(workingDir, relativePath),
  )
  const diffText = untrackedParts.length === 0
    ? trackedDiff
    : `${trackedDiff}\n${untrackedParts.join('\n')}`
  const diffHash = createHash('sha256').update(diffText, 'utf-8').digest('hex')

  return { headCommit, diffHash, diffText }
}

/** diff本文は、現在値がApprovalRequestに固定されたcommit/hashと完全一致する場合だけ返す。 */
export function readExactApprovalDiff(
  workingDir: string,
  targetCommit: string,
  targetDiffHash: string,
): ApprovalDiffReadResult {
  const current = readCurrentWorktreeDiff(workingDir)

  if (current.headCommit !== targetCommit || current.diffHash !== targetDiffHash) {
    return {
      stale: true,
      headCommit: current.headCommit,
      diffHash: current.diffHash,
    }
  }

  return { stale: false, ...current }
}
