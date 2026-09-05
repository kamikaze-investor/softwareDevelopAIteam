/**
 * クラッシュ復旧時の exact workspace 検証（PR-C Tranche 4）
 *
 * Worker 起動時に、前回（クラッシュした）プロセスから `running` のまま残っている
 * Job について、その workspace が「その Job が開始した時点と provably 同一」かどうかを
 * 判定する。同一と確認できた場合のみ、Job を terminalize して workspace 所有権を解放する。
 *
 * プロセス消失（quiescence）は systemd `KillMode=control-group` により既に保証されており、
 * このモジュールは PID マーカー・プロセス走査・liveness 検知を一切行わない。
 * 検証は完全一致（equality）のみ。曖昧な近似（"close enough" / "mostly clean"）は許容しない。
 *
 * 本モジュールは決して throw しない（検出・分類不能はすべて `verified:false` へ変換する）。
 */
import { execFileSync } from 'node:child_process'
import type { JobWorkspaceBaseline, JobWorkspaceBaselineEntry } from '@ai-team/shared'
import {
  buildWorktreeManifest,
  fingerprintWorktreeEntries,
} from './guards/changeManifest.js'
import type { ChangeManifest } from './guards/changeManifest.js'
import { detectGitOperationState } from './guards/gitOperationState.js'
import { buildBaselineEntries } from './jobRunner.js'

const GIT_TIMEOUT_MS = 10_000

export type WorkspaceVerificationResult =
  | { verified: true }
  | { verified: false; reason: string }

export interface WorkspaceVerificationInput {
  workingDir: string
  baseline?: JobWorkspaceBaseline
}

/**
 * workspace が baseline（Job 開始時点）と完全一致するかを検証する。
 *
 * 検証項目（すべて必須・一つでも満たさなければ `verified:false`）:
 *  a) 進行中の git 操作マーカーが無い（`detectGitOperationState` が空）。
 *  b) 現在の HEAD が baseline.startCommitHash と一致する。
 *  c) baseline.mode==='clean' のとき、working tree manifest の changed path が0件。
 *  d) baseline.mode==='dirty' のとき、現在の entries を admission と同じ正規化
 *     （manifest + fingerprint + buildBaselineEntries）で再構築し、
 *     baseline.entries と決定論的に（path→oldPath でソート）完全一致するよう比較する。
 *  e) baseline が存在しない（legacy row / 書き込み前クラッシュ）場合は verified:false。
 */
export function verifyWorkspaceAgainstBaseline(
  workingDir: string,
  baseline?: JobWorkspaceBaseline,
): WorkspaceVerificationResult {
  try {
    if (baseline === undefined) {
      return {
        verified: false,
        reason:
          'workspace baseline is missing (legacy row or crash before the baseline was written); ' +
          'cannot verify the workspace is unchanged - quarantining to retain ownership',
      }
    }

    const gitOperations = detectGitOperationState(workingDir)
    if (gitOperations.length > 0) {
      return {
        verified: false,
        reason: `in-progress git operation detected (${gitOperations.join(', ')}); ` +
          'workspace is not provably identical - quarantining to retain ownership',
      }
    }

    const currentHead = getCommitHash(workingDir)
    if (currentHead === undefined || currentHead === '') {
      return {
        verified: false,
        reason: 'could not resolve the current HEAD; ' +
          'workspace is not provably identical - quarantining to retain ownership',
      }
    }
    if (currentHead !== baseline.startCommitHash) {
      return {
        verified: false,
        reason: `HEAD moved since job start (expected ${baseline.startCommitHash}, now ${currentHead}); ` +
          'a child may have moved HEAD while leaving a clean tree - quarantining to retain ownership',
      }
    }

    if (baseline.mode === 'clean') {
      return verifyCleanMode(workingDir)
    }

    return verifyDirtyMode(workingDir, baseline)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      verified: false,
      reason: `workspace verification failed (${message}); ` +
        'cannot verify the workspace is unchanged - quarantining to retain ownership',
    }
  }
}

function verifyCleanMode(workingDir: string): WorkspaceVerificationResult {
  let manifest: ChangeManifest
  try {
    manifest = buildWorktreeManifest(workingDir)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      verified: false,
      reason: `failed to inspect the working tree (${message}); ` +
        'cannot verify the workspace is unchanged - quarantining to retain ownership',
    }
  }

  if (manifest.paths.length > 0) {
    return {
      verified: false,
      reason: `clean-baseline workspace has ${manifest.paths.length} changed path(s) ` +
        `(${formatChangedFiles(manifest.paths)}); ` +
        'workspace is not provably identical - quarantining to retain ownership',
    }
  }

  return { verified: true }
}

function verifyDirtyMode(
  workingDir: string,
  baseline: Extract<JobWorkspaceBaseline, { mode: 'dirty' }>,
): WorkspaceVerificationResult {
  let manifest: ChangeManifest
  try {
    manifest = buildWorktreeManifest(workingDir)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      verified: false,
      reason: `failed to inspect the working tree (${message}); ` +
        'cannot verify the workspace is unchanged - quarantining to retain ownership',
    }
  }

  let currentFingerprints: Map<string, string>
  try {
    currentFingerprints = fingerprintWorktreeEntries(workingDir, manifest)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      verified: false,
      reason: `failed to fingerprint the working tree (${message}); ` +
        'cannot verify the workspace is unchanged - quarantining to retain ownership',
    }
  }

  // admission 側（computeWorkspaceBaseline）と同一の正規化を使って現在の entries を再構築する。
  const currentEntries = buildBaselineEntries(manifest, currentFingerprints)

  return compareDirtyEntries(baseline.entries, currentEntries)
}

/**
 * baseline と現在の dirty entries を決定論的に比較する。
 *
 * 比較の前に path → oldPath でソートし、次のすべてのフィールドを完全一致で比較する:
 * path / oldPath / kind / xyStatus / beforeType / afterType / beforeMode / afterMode /
 * headHash / indexHash / worktreeHash。
 * 件数差・pathの欠落/余分・いずれかのフィールド差異はすべて `verified:false` で、
 * 理由には最初に発見した差分を載せる。
 */
function compareDirtyEntries(
  baselineEntries: JobWorkspaceBaselineEntry[],
  currentEntries: JobWorkspaceBaselineEntry[],
): WorkspaceVerificationResult {
  if (baselineEntries.length !== currentEntries.length) {
    return {
      verified: false,
      reason: `dirty entry count differs (baseline ${baselineEntries.length}, current ${currentEntries.length}); ` +
        'workspace is not provably identical - quarantining to retain ownership',
    }
  }

  const baselineSorted = [...baselineEntries].sort(sortEntries)
  const currentSorted = [...currentEntries].sort(sortEntries)

  for (let i = 0; i < baselineSorted.length; i += 1) {
    const expected = baselineSorted[i]
    const actual = currentSorted[i]
    const diff = diffEntry(expected, actual)
    if (diff !== undefined) {
      return {
        verified: false,
        reason:
          `dirty entry differs at "${expected.path}": ${diff}; ` +
          'workspace is not provably identical - quarantining to retain ownership',
      }
    }
  }

  return { verified: true }
}

/** 決定論的ソート: path で昇順、同値なら oldPath（undefined は空文字として扱う）で昇順。 */
function sortEntries(a: JobWorkspaceBaselineEntry, b: JobWorkspaceBaselineEntry): number {
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  const aOld = a.oldPath ?? ''
  const bOld = b.oldPath ?? ''
  if (aOld < bOld) return -1
  if (aOld > bOld) return 1
  return 0
}

/** 2つの entry を全フィールド比較し、最初の差異の説明を返す。一致なら undefined。 */
function diffEntry(
  expected: JobWorkspaceBaselineEntry,
  actual: JobWorkspaceBaselineEntry,
): string | undefined {
  if (actual.path !== expected.path) return `path is "${actual.path}" (expected "${expected.path}")`
  if (normalizeUndefined(actual.oldPath) !== normalizeUndefined(expected.oldPath)) {
    return `oldPath is "${actual.oldPath ?? ''}" (expected "${expected.oldPath ?? ''}")`
  }
  if (actual.kind !== expected.kind) return `kind is "${actual.kind}" (expected "${expected.kind}")`
  if (normalizeUndefined(actual.xyStatus) !== normalizeUndefined(expected.xyStatus)) {
    return `xyStatus is "${actual.xyStatus ?? ''}" (expected "${expected.xyStatus ?? ''}")`
  }
  if (normalizeUndefined(actual.beforeType) !== normalizeUndefined(expected.beforeType)) {
    return `beforeType is "${actual.beforeType ?? ''}" (expected "${expected.beforeType ?? ''}")`
  }
  if (normalizeUndefined(actual.afterType) !== normalizeUndefined(expected.afterType)) {
    return `afterType is "${actual.afterType ?? ''}" (expected "${expected.afterType ?? ''}")`
  }
  if (normalizeUndefined(actual.beforeMode) !== normalizeUndefined(expected.beforeMode)) {
    return `beforeMode is "${actual.beforeMode ?? ''}" (expected "${expected.beforeMode ?? ''}")`
  }
  if (normalizeUndefined(actual.afterMode) !== normalizeUndefined(expected.afterMode)) {
    return `afterMode is "${actual.afterMode ?? ''}" (expected "${expected.afterMode ?? ''}")`
  }
  if (normalizeUndefined(actual.headHash) !== normalizeUndefined(expected.headHash)) {
    return `headHash is "${actual.headHash ?? ''}" (expected "${expected.headHash ?? ''}")`
  }
  if (normalizeUndefined(actual.indexHash) !== normalizeUndefined(expected.indexHash)) {
    return `indexHash is "${actual.indexHash ?? ''}" (expected "${expected.indexHash ?? ''}")`
  }
  if (actual.worktreeHash !== expected.worktreeHash) {
    return `worktreeHash is "${actual.worktreeHash}" (expected "${expected.worktreeHash}")`
  }
  return undefined
}

function normalizeUndefined(value: string | undefined): string {
  return value ?? ''
}

/** HEAD commit を取得する。失敗したら undefined（verify は fail-closed で処理する）。 */
function getCommitHash(workingDir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim()
  } catch {
    return undefined
  }
}

function formatChangedFiles(files: string[]): string {
  if (files.length === 0) return 'なし'
  const head = files.slice(0, 3).join(', ')
  return files.length > 3 ? `${head} …他${files.length - 3}件` : head
}
