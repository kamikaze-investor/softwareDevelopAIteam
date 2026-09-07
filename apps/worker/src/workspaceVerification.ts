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
 * PR-C final blocker (BLOCKER B): quarantine 解除の申請時に Worker が送る
 * 「今この瞬間に観測した workspace」の構造的事実（known-good）。
 */
export interface KnownGoodFacts {
  gitOperationMarkers: string[]
  worktreeClean: boolean
  indexClean: boolean
  headValid: boolean
  blindSpotsAbsent: boolean
}

/** `observeWorkspace()` の結果。observation は workspace の baseline 形式記録。 */
export interface ObserveWorkspaceResult {
  observation?: JobWorkspaceBaseline
  knownGood: KnownGoodFacts
}

/**
 * PR-C final blocker (BLOCKER B): workspace を**観測**し、baseline 形式の observation と
 * known-good 事実を返す。
 *
 * 既存の検証ヘルパー（detectGitOperationState / buildWorktreeManifest /
 * fingerprintWorktreeEntries / buildBaselineEntries）を再利用し、porcelain-v2 の parse を
 * 重複実装しない。この関数自体は決して throw しない（観測不能は knownGood の
 * 各フラグを false に倒す）。
 *
 * 注意: observation は「以前の状態への復元」ではなく**新しい安全な参照点**であり、
 * サーバー側で再検証される（assert ではない）。
 */
export function observeWorkspace(workingDir: string): ObserveWorkspaceResult {
  const failClosed: KnownGoodFacts = {
    gitOperationMarkers: [],
    worktreeClean: false,
    indexClean: false,
    headValid: false,
    blindSpotsAbsent: false,
  }

  try {
    const gitOperationMarkers = detectGitOperationState(workingDir)
    const manifest = buildWorktreeManifest(workingDir)
    const head = getCommitHash(workingDir)
    const headValid = head !== undefined && head !== ''
    const blindSpotsAbsent = detectUnreportableWorkspaceState(workingDir) === undefined
    const worktreeClean = manifest.paths.length === 0
    // index がクリーンか = staged 変更が無いか。porcelain **v2** の XY は「変更なし」を
    // 空白ではなく `.` で表す（v1 との差。本PRで既に同種の取り違えを1件修正している）。
    // したがって index 列が `.` 以外なら staged 変更がある。untracked（XY無し）は非staged。
    const indexClean = !manifest.changes.some(
      (change) => change.xyStatus !== undefined && change.xyStatus[0] !== '.',
    )
    const knownGood = { gitOperationMarkers, worktreeClean, indexClean, headValid, blindSpotsAbsent }

    if (!headValid) {
      return { knownGood }
    }
    if (worktreeClean) {
      return { observation: { mode: 'clean', startCommitHash: head as string }, knownGood }
    }

    const fingerprints = fingerprintWorktreeEntries(workingDir, manifest)
    return {
      observation: {
        mode: 'dirty',
        startCommitHash: head as string,
        entries: buildBaselineEntries(manifest, fingerprints),
      },
      knownGood,
    }
  } catch {
    // 観測不能は fail-closed（knownGood 全 false）。
    return { knownGood: failClosed }
  }
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

    const modeResult = baseline.mode === 'clean'
      ? verifyCleanMode(workingDir)
      : verifyDirtyMode(workingDir, baseline)
    if (!modeResult.verified) return modeResult

    // 独立レビュー指摘（PR-C）: ここまでの比較は `git status` が報告する範囲でしか
    // equality を主張できない。status に出ない状態変化（core.filemode=false による
    // exec-bit、assume-unchanged / skip-worktree の path）が有り得る場合、
    // 「一致」と断定してはならない。verified を返す直前だけで判定するのは、
    // 具体的な不一致理由（HEAD moved 等）を潰さないため。
    const unreportable = detectUnreportableWorkspaceState(workingDir)
    if (unreportable !== undefined) {
      return {
        verified: false,
        reason: `${unreportable}; git status cannot prove the workspace is unchanged ` +
          '- quarantining to retain ownership',
      }
    }

    return modeResult
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


/** verification 用の git 実行。失敗時は throw し、呼び出し元が fail-closed に扱う。 */
function runGitForVerification(workingDir: string, argv: readonly string[]): string {
  return execFileSync('git', argv, {
    cwd: workingDir,
    encoding: 'utf-8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  })
}

/**
 * `git status` では表に出ない状態変化の前提崩れを検出する。
 *
 * - `core.filemode=false`: exec-bit の変化が status に出ないため、mode 比較が無意味になる。
 * - `assume-unchanged` / `skip-worktree`: 当該 path の変更が status に出ない。
 *   `git ls-files -v` は通常の tracked file を大文字（H 等）、これらを小文字
 *   （h/s/m 等）で報告するため、小文字タグの存在で検出する。
 *
 * ignored file（.gitignore 対象）は PR-C の workspace 同一性の対象外とする。
 * これは意図的な境界であり、見落としではない。
 *
 * 検出できない/コマンドが失敗した場合も fail-closed 側（理由を返す）に倒す。
 */
function detectUnreportableWorkspaceState(workingDir: string): string | undefined {
  let filemode: string
  try {
    filemode = runGitForVerification(workingDir, ['config', '--type=bool', '--default', 'true', '--get', 'core.filemode'])
  } catch (err: unknown) {
    return `could not read core.filemode (${err instanceof Error ? err.message : String(err)})`
  }
  if (filemode.trim() !== 'true') {
    return 'core.filemode is not true, so executable-bit changes are invisible to git status'
  }

  let lsFiles: string
  try {
    lsFiles = runGitForVerification(workingDir, ['ls-files', '-v'])
  } catch (err: unknown) {
    return `could not enumerate index flags (${err instanceof Error ? err.message : String(err)})`
  }
  const flagged: string[] = []
  for (const line of lsFiles.split(/\r?\n/)) {
    if (line === '') continue
    const tag = line[0]
    // `git ls-files -v` のタグ:
    //   小文字（h 等） = assume-unchanged
    //   大文字 S       = skip-worktree（独立レビュー指摘: 小文字だけ見ると見落とす）
    // どちらも当該 path の変更が git status に出ないため、equality を主張できない。
    if ((tag >= 'a' && tag <= 'z') || tag === 'S') {
      flagged.push(line.slice(2))
      if (flagged.length >= 5) break
    }
  }
  if (flagged.length > 0) {
    return `paths marked assume-unchanged/skip-worktree are invisible to git status (${flagged.join(', ')})`
  }

  return undefined
}
