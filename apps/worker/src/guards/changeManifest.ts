/**
 * Change Manifest — 変更ファイル検出契約
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 既存の `git diff --name-only HEAD` ベースの検出には次の欠陥があった
 * （2026-07-31 Codex `gpt-5.6-sol` read-only独立レビューで発見。実測確認済み）:
 *   - untracked（新規作成）ファイルを一切検出しない
 *   - SafeCommand=git_commit の実行後は working tree 差分が空になるため、
 *     正常にコミットされた変更ほど File Change Guard を素通りする
 *   - git コマンド失敗時に [] を返すため fail-open になる
 *   - `.gitignore` 対象ファイル（ignored な .env 等）を検出できない
 *
 * このモジュールは「何が変わったか」の検出のみを担う。
 * 許可/拒否の判定は fileChangeGuard.ts が行う（判定基準はこのファイルに置かない）。
 * 解析できない状態・分類できない状態は必ず ChangeDetectionError を throw し、
 * 空配列を返して素通りさせない（fail-closed）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** 変更の種類 */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

/** エントリの実体種別。regular 以外は MVP では変更を許可しない */
export type EntryType = 'regular' | 'symlink' | 'gitlink' | 'special'

export interface FileChange {
  /** 変更後のパス（deleted の場合は削除されたパス）。worktree ルートからの相対 */
  path: string
  /** renamed の場合の旧パス */
  oldPath?: string
  kind: ChangeKind
  beforeType?: EntryType
  afterType?: EntryType
  beforeMode?: string
  afterMode?: string
  /** commit tree 比較時の blob hash（内容変更の判別に使う） */
  beforeHash?: string
  afterHash?: string
}

export interface ChangeManifest {
  changes: FileChange[]
  /**
   * 検査対象パスの一覧。rename は旧パス・新パスの**両方**を含む。
   * Approval Gate / Risk Review / Risk Scan / File Change Guard へ
   * 一貫してこの配列を渡す。
   */
  paths: string[]
}

/** 検出・分類に失敗したことを示す。呼び出し元は必ず fail-closed で扱う */
export class ChangeDetectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChangeDetectionError'
  }
}

// ────────────────────────────────────────────────────────────
// git 実行
// ────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 10_000

function runGit(workingDir: string, argv: string[]): string {
  try {
    return execFileSync('git', argv, {
      cwd: workingDir,
      shell: false,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // stdin を閉じる（git が入力待ちでハングするのを防ぐ。AI CLI Adapter と同じ原則）
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ChangeDetectionError(`git ${argv.join(' ')} failed in ${workingDir}: ${message}`)
  }
}

/**
 * workingDir が「それ自身の git 作業ツリーのルート」であることを検証する。
 *
 * git は作業ディレクトリに .git が無いと**上位ディレクトリへ遡って**リポジトリを探す。
 * そのため workingDir がリポジトリでない場合、意図しない上位リポジトリ
 * （例: ホームディレクトリ全体）の変更を、この Job の変更として報告してしまう。
 * 実測でホーム配下の一時ディレクトリからホームのリポジトリが検出されたため、
 * 上位への遡りは明示的に拒否する。
 */
function assertWorktreeRoot(workingDir: string): void {
  const toplevel = runGit(workingDir, ['rev-parse', '--show-toplevel']).trim()
  if (toplevel === '') {
    throw new ChangeDetectionError(`Not a git worktree: "${workingDir}"`)
  }

  let realToplevel: string
  let realWorkingDir: string
  try {
    realToplevel = realpathSync(toplevel)
    realWorkingDir = realpathSync(workingDir)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ChangeDetectionError(`Failed to resolve worktree root for "${workingDir}": ${message}`)
  }

  if (path.relative(realToplevel, realWorkingDir) !== '') {
    throw new ChangeDetectionError(
      `workingDir is not the git worktree root (上位リポジトリへの遡りを拒否します): ` +
        `workingDir="${realWorkingDir}" toplevel="${realToplevel}"`,
    )
  }
}

/** NUL 区切り出力をセグメントへ分解する（末尾の空要素は落とす） */
function splitNulSegments(raw: string): string[] {
  const segments = raw.split('\0')
  if (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop()
  }
  return segments
}

/**
 * 先頭 count 個のスペース区切りフィールドを取り出し、残りを rest として返す。
 * パス自体にスペースが含まれても壊れないよう split(' ') は使わない。
 */
function splitFields(record: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = []
  let index = 0

  for (let n = 0; n < count; n += 1) {
    const space = record.indexOf(' ', index)
    if (space < 0) {
      throw new ChangeDetectionError(`Malformed git record (expected ${count} fields): "${record}"`)
    }
    fields.push(record.slice(index, space))
    index = space + 1
  }

  return { fields, rest: record.slice(index) }
}

// ────────────────────────────────────────────────────────────
// mode / 実体種別
// ────────────────────────────────────────────────────────────

const MODE_ABSENT = '000000'

/** git の mode 値から実体種別を決める。未知の mode は fail-closed */
export function entryTypeFromMode(mode: string): EntryType | undefined {
  if (mode === MODE_ABSENT) return undefined
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'gitlink'
  if (mode === '100644' || mode === '100755') return 'regular'
  throw new ChangeDetectionError(`Unknown git file mode: "${mode}"`)
}

function resolveInsideWorktree(workingDir: string, relativePath: string): string {
  const root = path.resolve(workingDir)
  const absolute = path.resolve(root, relativePath)

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new ChangeDetectionError(`Path escapes worktree: "${relativePath}"`)
  }

  return absolute
}

/**
 * porcelain の `?` レコードには mode が無いため lstat で実体種別を確定する。
 * 分類できない種別（socket / device / fifo 等）と stat 失敗は fail-closed。
 */
export function lstatEntryType(workingDir: string, relativePath: string): EntryType {
  const absolute = resolveInsideWorktree(workingDir, relativePath)

  let stat
  try {
    stat = lstatSync(absolute)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ChangeDetectionError(`lstat failed for "${relativePath}": ${message}`)
  }

  if (stat.isSymbolicLink()) return 'symlink'
  // untracked のディレクトリエントリは git が降りられない nested repository を意味する
  if (stat.isDirectory()) return 'gitlink'
  if (stat.isFile()) return 'regular'

  throw new ChangeDetectionError(
    `Unclassifiable file type for "${relativePath}" (socket / device / fifo 等は許可しない)`,
  )
}

// ────────────────────────────────────────────────────────────
// working tree manifest（git status --porcelain=v2 -z）
// ────────────────────────────────────────────────────────────

function kindFromXY(x: string, y: string): ChangeKind {
  // 削除は最優先で判定する（A→D のように途中で追加されていても最終状態は不在）
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

/**
 * `git status --porcelain=v2 -z --untracked-files=all` から working tree の manifest を作る。
 *
 * レコード種別の扱い（MVPで安全に処理できないものは throw して fail-closed）:
 *   1 : ordinary        → added / modified / deleted
 *   2 : rename          → renamed（旧・新の両パスを paths へ）／ copy(C) は throw
 *   u : unmerged        → throw
 *   ? : untracked       → added（実体種別は lstat で確定）
 *   ! : ignored         → throw（--untracked-files=all 下での出現は想定外）
 *   上記以外            → throw
 *   submodule (sub!=N)  → throw
 */
export function buildWorktreeManifest(workingDir: string): ChangeManifest {
  assertWorktreeRoot(workingDir)
  const raw = runGit(workingDir, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  const segments = splitNulSegments(raw)
  const changes: FileChange[] = []

  for (let i = 0; i < segments.length; i += 1) {
    const record = segments[i]
    if (record === '') continue

    const recordType = record[0]

    if (recordType === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const { fields, rest: filePath } = splitFields(record, 8)
      assertNotSubmodule(fields[2], filePath)
      const [xy, , modeHead, modeIndex, modeWorktree] = [fields[1], fields[2], fields[3], fields[4], fields[5]]
      const kind = kindFromXY(xy[0], xy[1])
      changes.push({
        path: filePath,
        kind,
        beforeType: entryTypeFromMode(modeHead),
        afterType: resolveAfterType(workingDir, filePath, kind, modeWorktree, modeIndex),
        beforeMode: modeHead === MODE_ABSENT ? undefined : modeHead,
        afterMode: afterModeOf(modeWorktree, modeIndex),
      })
      continue
    }

    if (recordType === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const { fields, rest: newPath } = splitFields(record, 9)
      assertNotSubmodule(fields[2], newPath)
      const score = fields[8]
      if (!score.startsWith('R')) {
        throw new ChangeDetectionError(
          `Copy detection is not supported (record "${score}" for "${newPath}")`,
        )
      }
      const oldPath = segments[i + 1]
      if (oldPath === undefined) {
        throw new ChangeDetectionError(`Rename record missing original path: "${record}"`)
      }
      i += 1
      const modeHead = fields[3]
      const modeIndex = fields[4]
      const modeWorktree = fields[5]
      changes.push({
        path: newPath,
        oldPath,
        kind: 'renamed',
        beforeType: entryTypeFromMode(modeHead),
        afterType: resolveAfterType(workingDir, newPath, 'renamed', modeWorktree, modeIndex),
        beforeMode: modeHead === MODE_ABSENT ? undefined : modeHead,
        afterMode: afterModeOf(modeWorktree, modeIndex),
      })
      continue
    }

    if (recordType === '?') {
      const { rest: filePath } = splitFields(record, 1)
      changes.push({
        path: filePath,
        kind: 'added',
        afterType: lstatEntryType(workingDir, filePath),
      })
      continue
    }

    if (recordType === 'u') {
      throw new ChangeDetectionError(
        `Unmerged path is not supported in MVP: "${record}"（コンフリクト未解決のまま実行しない）`,
      )
    }

    if (recordType === '!') {
      throw new ChangeDetectionError(`Unexpected ignored record with --untracked-files=all: "${record}"`)
    }

    throw new ChangeDetectionError(`Unknown git status porcelain=v2 record: "${record}"`)
  }

  return toManifest(changes)
}

function assertNotSubmodule(sub: string, filePath: string): void {
  if (!sub.startsWith('N')) {
    throw new ChangeDetectionError(`Submodule change is not supported in MVP: "${filePath}" (sub=${sub})`)
  }
}

function afterModeOf(modeWorktree: string, modeIndex: string): string | undefined {
  if (modeWorktree !== MODE_ABSENT) return modeWorktree
  if (modeIndex !== MODE_ABSENT) return modeIndex
  return undefined
}

/**
 * 変更後の実体種別を決める。
 * mode が取得できる場合は mode を正とし、取得できない場合（新規追加等）は lstat で確定する。
 */
function resolveAfterType(
  workingDir: string,
  filePath: string,
  kind: ChangeKind,
  modeWorktree: string,
  modeIndex: string,
): EntryType | undefined {
  if (kind === 'deleted') return undefined

  const mode = afterModeOf(modeWorktree, modeIndex)
  if (mode !== undefined) return entryTypeFromMode(mode)

  return lstatEntryType(workingDir, filePath)
}

// ────────────────────────────────────────────────────────────
// commit tree manifest（git diff --raw -M -z）
// ────────────────────────────────────────────────────────────

/**
 * base commit から after commit までの **確定した成果** を manifest 化する。
 * `--name-status` では mode / type change を取得できないため `--raw` を使う。
 *
 * 形式: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>[\0<newPath>]`
 * rename のパス順序は porcelain=v2 と **逆**（--raw は 旧→新、porcelain は 新→旧）。
 */
export function buildCommitTreeManifest(workingDir: string, base: string, after: string): ChangeManifest {
  assertWorktreeRoot(workingDir)
  const raw = runGit(workingDir, ['diff', '--raw', '-M', '-z', '--abbrev=40', base, after])
  const segments = splitNulSegments(raw)
  const changes: FileChange[] = []

  for (let i = 0; i < segments.length; i += 1) {
    const record = segments[i]
    if (record === '') continue

    if (!record.startsWith(':')) {
      throw new ChangeDetectionError(`Unknown git diff --raw record: "${record}"`)
    }

    // :<srcmode> <dstmode> <srcsha> <dstsha> <status>
    const { fields, rest: status } = splitFields(record.slice(1), 4)
    const [srcMode, dstMode, srcHash, dstHash] = fields

    const firstPath = segments[i + 1]
    if (firstPath === undefined) {
      throw new ChangeDetectionError(`git diff --raw record missing path: "${record}"`)
    }
    i += 1

    const statusCode = status[0]

    if (statusCode === 'R') {
      const newPath = segments[i + 1]
      if (newPath === undefined) {
        throw new ChangeDetectionError(`Rename record missing destination path: "${record}"`)
      }
      i += 1
      changes.push({
        path: newPath,
        oldPath: firstPath,
        kind: 'renamed',
        beforeType: entryTypeFromMode(srcMode),
        afterType: entryTypeFromMode(dstMode),
        beforeMode: srcMode === MODE_ABSENT ? undefined : srcMode,
        afterMode: dstMode === MODE_ABSENT ? undefined : dstMode,
        beforeHash: srcHash,
        afterHash: dstHash,
      })
      continue
    }

    if (statusCode === 'C') {
      throw new ChangeDetectionError(`Copy detection is not supported (record "${status}")`)
    }
    if (statusCode === 'U') {
      throw new ChangeDetectionError(`Unmerged entry in commit range is not supported: "${firstPath}"`)
    }
    if (statusCode !== 'A' && statusCode !== 'M' && statusCode !== 'D' && statusCode !== 'T') {
      throw new ChangeDetectionError(`Unknown git diff --raw status "${status}" for "${firstPath}"`)
    }

    const kind: ChangeKind = statusCode === 'A' ? 'added' : statusCode === 'D' ? 'deleted' : 'modified'

    changes.push({
      path: firstPath,
      kind,
      beforeType: entryTypeFromMode(srcMode),
      afterType: entryTypeFromMode(dstMode),
      beforeMode: srcMode === MODE_ABSENT ? undefined : srcMode,
      afterMode: dstMode === MODE_ABSENT ? undefined : dstMode,
      beforeHash: srcHash,
      afterHash: dstHash,
    })
  }

  return toManifest(changes)
}

/**
 * base..after の間に merge commit が無く、base が after の祖先であることを検証する。
 *
 * 満たさない場合（履歴の書き換え・merge・fast-forwardでない変化）は
 * 個々のコミット単位で安全に検査できないため throw して fail-closed にする。
 */
function assertLinearHistory(workingDir: string, base: string, after: string): void {
  runGit(workingDir, ['merge-base', '--is-ancestor', base, after])

  const merges = runGit(workingDir, ['rev-list', '--merges', `${base}..${after}`]).trim()
  if (merges !== '') {
    throw new ChangeDetectionError(
      `Merge commits between "${base}" and "${after}" are not supported in MVP`,
    )
  }
}

/**
 * HEAD reflog のスナップショット。
 *
 * `base..after` の祖先関係だけを見る検査は、`git reset --hard` で一度作った
 * コミットを履歴から外し、その後に別の内容で新しいコミットを作るケースを見逃す
 * （`.env` を追加してcommit → reset --hard で破棄 → 通常変更をcommit、という手順で
 * 最終的な `base..after` の祖先関係は完全に線形になり、破棄された `.env` コミットは
 * `rev-list` に一切現れない。2026-07-31 Codex 最終レビューで発見・実測確認済み）。
 *
 * 【設計変更の経緯】当初は reflog の action 文字列（`%gs`）を許可リスト判定に使っていたが、
 * `GIT_REFLOG_ACTION` 環境変数で任意の文字列に偽装できるため、`.git` への直接書き込みなしに
 * 通常の `git` コマンドだけで許可リストを回避できた（2026-07-31 Codex 5回目レビューで発見・
 * 実測確認済み）。**reflog の subject / action 文字列は安全判定に一切使用しない。**
 * 代わりに、reflog に記録された **hash の遷移**だけを見る。隣接する `oldHash → newHash` が
 * `oldHash === newHash` または `oldHash` が `newHash` の祖先（fast-forward前進）である
 * 場合のみ許可し、巻き戻し・unrelated commitへの移動・hash解析不能・reflog欠落は
 * 全て fail-closed にする。文字列を偽装しても hash の親子関係そのものは偽装できない。
 *
 * 【脅威モデルの境界（2026-07-31確定）】これは通常の reset・checkout・巻き戻し等の
 * 履歴変更を検出する**追加防御**であり、AI/Workerが `.git` への同一書き込み権限を持つ
 * 現在、`git reflog delete` 等による reflog エントリの**完全削除**（証拠の完全な消去）は
 * 検出できない。削除されたエントリが指すcommitが最終HEADの祖先チェーンから見て
 * 到達不可能になるため、`git rev-list` 等どんな到達可能性ベースの検証でも原理的に
 * 検出しようがない（実測確認済み）。これは reflog という痕跡ベースの検証手法そのものの
 * 限界であり、Job単位のOS隔離とGit管理領域の分離（project-auto-worker-trust-boundary の
 * 将来項目）でのみ解決できる。OS隔離が完成するまで、状態不明Jobの自動retryは
 * 有効化しない。
 */
export interface ReflogBaseline {
  /** 開始時に HEAD が指していた symbolic ref（例: 'refs/heads/main'）。detached HEAD なら undefined */
  branchRef?: string
  /** HEAD reflog の hash 列（新しい順） */
  headHashes: string[]
  /** branchRef のreflog の hash 列（新しい順）。branchRef が存在する場合のみ */
  branchHashes?: string[]
}

const HASH_PATTERN = /^[0-9a-f]{4,40}$/i

export function captureReflogBaseline(workingDir: string): ReflogBaseline {
  assertWorktreeRoot(workingDir)

  const branchRef = readSymbolicRef(workingDir)
  const headHashes = readReflogHashes(workingDir, 'HEAD')

  if (branchRef === undefined) {
    return { headHashes }
  }

  return { branchRef, headHashes, branchHashes: readReflogHashes(workingDir, branchRef) }
}

/** HEAD が symbolic ref（ブランチ上）なら ref 名を返す。detached HEAD なら undefined */
function readSymbolicRef(workingDir: string): string | undefined {
  try {
    const ref = runGit(workingDir, ['symbolic-ref', '-q', 'HEAD']).trim()
    return ref === '' ? undefined : ref
  } catch {
    // 非0終了（detached HEAD）は正常系。ChangeDetectionError にはしない
    return undefined
  }
}

/** 指定 ref の reflog を hash 列（新しい順）として取得する。reflog が無ければ空配列 */
function readReflogHashes(workingDir: string, ref: string): string[] {
  let raw: string
  try {
    raw = runGit(workingDir, ['log', '-g', '--pretty=format:%H', ref])
  } catch {
    return []
  }
  return raw.split(/\r?\n/).filter((line) => line !== '')
}

/**
 * Job 開始時に記録した reflog スナップショットと現在の reflog を比較する。
 *
 * - baseline より新しい reflog エントリの hash 列を、baseline 記録時点の最新 hash から
 *   時系列順に辿り、隣接する各遷移が fast-forward 前進（または無変化）であることを
 *   `git merge-base --is-ancestor` で検証する。巻き戻し・unrelated commit・hash解析不能は
 *   全て fail-closed にする。
 * - baseline が現在の reflog の**末尾（＝より古い部分）と完全一致しない場合**
 *   （reflog の期限切れ・短縮・消去の疑いを含む）は fail-closed にする。
 * - 開始時に symbolic ref（ブランチ）上だった場合、実行中に別の ref・detached HEAD へ
 *   切り替わっていないかを確認し、切り替わっていれば拒否する（MVPでは実行中の
 *   branch切り替えを許可しない）。ブランチ自体の reflog（他worktree等からの更新を含む）も
 *   同じ規則で検証する。
 *
 * 【脅威モデルの境界】これは通常の reset・rebase・checkout 等の履歴変更を検出する追加防御であり、
 * `.git/logs/HEAD` 等への直接改ざんを完全に防げる安全境界ではない（OS隔離前提のMVP-B課題）。
 */
export function assertNoHistoryRewrite(workingDir: string, baseline: ReflogBaseline): void {
  const current = captureReflogBaseline(workingDir)

  // 開始時にブランチ上だった場合、実行中に別のref・detached HEADへ切り替わっていれば拒否する
  // （MVPでは実行中のbranch切り替えを許可しない）。
  if (baseline.branchRef !== undefined && current.branchRef !== baseline.branchRef) {
    throw new ChangeDetectionError(
      `HEAD switched branches during job execution (started on "${baseline.branchRef}", ` +
        `now "${current.branchRef ?? 'detached'}"); not allowed in MVP (fail-closed)`,
    )
  }
  // 開始時に detached HEAD だった場合、実行中にブランチへ切り替わっていれば同様に拒否する。
  if (baseline.branchRef === undefined && current.branchRef !== undefined) {
    throw new ChangeDetectionError(
      `HEAD switched from detached to branch "${current.branchRef}" during job execution; ` +
        `not allowed in MVP (fail-closed)`,
    )
  }

  verifyReflogProgression(workingDir, baseline.headHashes, current.headHashes, 'HEAD')

  if (baseline.branchRef !== undefined) {
    verifyReflogProgression(
      workingDir,
      baseline.branchHashes ?? [],
      current.branchHashes ?? [],
      baseline.branchRef,
    )
  }
}

/**
 * baseline と current の reflog hash 列（いずれも新しい順）を比較し、
 * baseline以降に追加されたエントリが常に fast-forward 前進であることを検証する。
 */
function verifyReflogProgression(
  workingDir: string,
  baselineHashes: string[],
  currentHashes: string[],
  label: string,
): void {
  // reflog が空（core.logAllRefUpdates=false 等で無効化されている環境を含む）の場合、
  // このモジュールは commit range を安全に検証できない。無条件で fail-closed にする
  // （2026-07-31 Codex 4回目レビューで発見: 空baselineが無条件で成立してしまっていた）。
  //
  // baselineHashes（Job開始時点の記録）が空の場合も同様に fail-closed にする。
  // baselineHashes.length===0 だと後段の `previousHash` 初期値が undefined になり、
  // 最初の新規エントリへの遷移だけ fast-forward 検証がスキップされてしまう
  // （＝reflogが後から有効化された環境で、有効化前の状態から最初のcommitへの
  // 遷移だけ無検査で通過する）。currentHashes だけでなく baselineHashes も
  // 空なら即座に拒否する（2026-07-31 Codex closureレビューで発見・実測確認済み）。
  if (currentHashes.length === 0 || baselineHashes.length === 0) {
    throw new ChangeDetectionError(
      `${label} reflog is empty (baseline or current); history verification requires ` +
        `an active reflog since job start (fail-closed)`,
    )
  }

  const isBaselineSuffix =
    currentHashes.length >= baselineHashes.length &&
    baselineHashes.every(
      (hash, i) => currentHashes[currentHashes.length - baselineHashes.length + i] === hash,
    )

  if (!isBaselineSuffix) {
    throw new ChangeDetectionError(
      `${label} reflog was rewritten, shortened, or expired since job start; ` +
        `cannot safely verify commit history (fail-closed)`,
    )
  }

  // baseline より新しいエントリ（新しい順）を古い順へ並べ替え、隣接遷移を時系列順に検証する
  const newEntriesChronological = currentHashes
    .slice(0, currentHashes.length - baselineHashes.length)
    .reverse()

  // 【設計判断（2026-07-31）】reflogエントリ数と実際のcommit数（`git rev-list --count`）を
  // 突き合わせる検証は撤去した。理由:
  //   - `git reflog delete` でreflogエントリを完全に削除された場合、削除されたcommitは
  //     最終HEADの祖先チェーンから見て「最初から存在しなかったこと」になり、
  //     `rev-list --count` でも数えられない。検出力が無いまま複雑さだけが残っていた
  //     （実測確認済み）。
  //   - `git merge --ff-only` のように1回のreflog更新で複数commitが一気に進む
  //     正当な操作を誤って拒否する回帰があった（実測確認済み）。
  // reflogエントリの完全削除（`git reflog delete`等）は、Worker/AIプロセスが`.git`への
  // 書き込み権限を持つ限りreflogベースの検証だけでは原理的に防げない
  // （project-auto-worker-trust-boundary へ記録済み。MVP-BのOS隔離・Git管理領域分離課題）。
  // ここで維持するのは、通常の reset・checkout・巻き戻し・unrelated履歴移動を検出する
  // 実効性のある検査（baseline suffix一致・隣接hashのfast-forward判定）のみに限定する。

  let previousHash = baselineHashes.length > 0 ? baselineHashes[0] : undefined

  for (const hash of newEntriesChronological) {
    if (!HASH_PATTERN.test(hash)) {
      throw new ChangeDetectionError(`${label} reflog contains an unparseable hash: "${hash}"`)
    }
    if (previousHash !== undefined && previousHash !== hash) {
      assertFastForward(workingDir, previousHash, hash, label)
    }
    previousHash = hash
  }
}

/** oldHash が newHash の祖先（fast-forward前進）であることを検証する。それ以外は fail-closed */
function assertFastForward(workingDir: string, oldHash: string, newHash: string, label: string): void {
  try {
    runGit(workingDir, ['merge-base', '--is-ancestor', oldHash, newHash])
  } catch {
    throw new ChangeDetectionError(
      `${label} moved from "${oldHash}" to "${newHash}" which is not a fast-forward ` +
        `(backward move, unrelated commit, or unresolvable hash); rejected (fail-closed)`,
    )
  }
}

/** base(排他)..after(含む) の間のコミットを、古い順に列挙する */
function listCommitsBetween(workingDir: string, base: string, after: string): string[] {
  const raw = runGit(workingDir, ['rev-list', '--reverse', `${base}..${after}`]).trim()
  return raw === '' ? [] : raw.split(/\r?\n/)
}

/**
 * base..after 間の **各コミットを個別に** 検査して union した manifest を作る。
 *
 * `git diff base after`（開始tree→終了tree の単純比較）だけでは、
 * 途中のコミットで追加され後続のコミットで削除された変更が完全に相殺されて
 * manifest から消えてしまう（例: `.env` を追加してcommitし、直後に削除してcommitすると
 * 開始treeと終了treeが同一になり検出漏れになる。実測確認済み）。
 * 1コミットずつの差分を union することで、最終状態では見えない中間の変更も検査対象にする。
 *
 * merge commit・非線形履歴は個々のコミット単位で安全に扱えないため throw して fail-closed。
 */
export function buildCommitRangeManifest(workingDir: string, base: string, after: string): ChangeManifest {
  if (base === after) return { changes: [], paths: [] }

  assertWorktreeRoot(workingDir)
  assertLinearHistory(workingDir, base, after)

  const commits = listCommitsBetween(workingDir, base, after)
  let parent = base
  const manifests: ChangeManifest[] = []

  for (const commit of commits) {
    manifests.push(buildCommitTreeManifest(workingDir, parent, commit))
    parent = commit
  }

  return mergeManifests(...manifests)
}

/**
 * base..after の完全な diff テキスト（secret / diff 検査へ渡す）。
 *
 * `buildCommitRangeManifest()` と同じ理由で、tree-to-tree の単純比較ではなく
 * コミット単位で diff を連結する（中間コミットで追加・削除された内容も検査対象にする）。
 */
export function getCommitRangeDiffText(workingDir: string, base: string, after: string): string {
  if (base === after) return ''

  assertWorktreeRoot(workingDir)
  assertLinearHistory(workingDir, base, after)

  const commits = listCommitsBetween(workingDir, base, after)
  let parent = base
  const parts: string[] = []

  for (const commit of commits) {
    parts.push(runGit(workingDir, ['diff', parent, commit]))
    parent = commit
  }

  return parts.join('\n')
}

/** untracked ファイル1件あたり、synthetic diff へ含める上限バイト数 */
const UNTRACKED_DIFF_MAX_BYTES = 256 * 1024

/**
 * working tree の diff テキスト（secret / diff 検査へ渡す）。
 *
 * `git diff HEAD` は **untracked ファイルの内容を含まない**ため、
 * それだけでは新規作成ファイルへ書かれた秘密情報を diff 検査
 * （HARDCODED_SECRET_ADDED 等）に掛けられない。
 * そこで untracked な regular file の内容を追加行 `+` 形式の synthetic diff として補う。
 * symlink / gitlink / 分類不能なものは内容を読まない（Guard 側で拒否される）。
 */
export function getWorktreeDiffText(workingDir: string, manifest?: ChangeManifest): string {
  const tracked = runGit(workingDir, ['diff', 'HEAD'])
  if (manifest === undefined) return tracked

  const untrackedParts: string[] = []

  for (const change of manifest.changes) {
    if (change.kind !== 'added') continue
    if (change.afterType !== 'regular') continue

    untrackedParts.push(buildSyntheticAddedDiff(workingDir, change.path))
  }

  return untrackedParts.length === 0 ? tracked : `${tracked}\n${untrackedParts.join('\n')}`
}

/**
 * untracked な新規ファイルの内容を synthetic diff（追加行）へ変換する。
 *
 * サイズ上限超過・読み取り失敗を黙って除外すると、その内容が secret/diff 検査
 * （HARDCODED_SECRET_ADDED 等）を一度も通らないまま許可されてしまう
 * （2026-07-31 Codex 最終レビューで発見）。**内容を検査できない場合は throw して
 * fail-closed にする**（サイレントスキップしない）。
 */
function buildSyntheticAddedDiff(workingDir: string, relativePath: string): string {
  const absolute = resolveInsideWorktree(workingDir, relativePath)

  let content: string
  try {
    const size = lstatSync(absolute).size
    if (size > UNTRACKED_DIFF_MAX_BYTES) {
      throw new ChangeDetectionError(
        `Untracked file "${relativePath}" exceeds ${UNTRACKED_DIFF_MAX_BYTES} bytes; ` +
          `content cannot be inspected for secrets (fail-closed)`,
      )
    }
    content = readFileSync(absolute, 'utf-8')
  } catch (err: unknown) {
    if (err instanceof ChangeDetectionError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ChangeDetectionError(
      `Failed to read untracked file "${relativePath}" for content inspection: ${message}`,
    )
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

// ────────────────────────────────────────────────────────────
// ignored ファイルを含む機密ファイルのベースライン
// ────────────────────────────────────────────────────────────

export interface SensitiveEntry {
  path: string
  type: EntryType
  /** 内容識別子。regular はファイル内容、symlink はリンク先の sha256 */
  hash: string
}

export type SensitiveBaseline = Map<string, SensitiveEntry>

/**
 * 走査から除外するディレクトリ。
 *
 * `dist` / `build` / `vendor` / `node_modules` 等は当初除外していたが、
 * ignored な `dist/server.pem` や `node_modules/pkg/.env` のような機密ファイルが
 * manifest に入らない穴になるため除外をやめた（2026-07-31 Codex 独立レビューで発見。
 * `node_modules` 配下は git がディレクトリ単位で ignore するため
 * `git status --ignored` でも個々のファイルを列挙できず、実走査が必要と判明）。
 * 除外するのは git の内部管理領域である `.git` のみ。
 * `SCAN_MAX_ENTRIES` が暴走時の fail-closed backstop になる。
 */
const SCAN_SKIP_DIRS = new Set(['.git'])

const SCAN_MAX_ENTRIES = 200_000

/** 1ファイルあたりの hash 読み込み上限（巨大な ignored ファイルでの OOM 防止） */
const SENSITIVE_HASH_MAX_BYTES = 8 * 1024 * 1024

/**
 * `.gitignore` 対象を含めて機密ファイルを走査し、path / type / content hash を記録する。
 *
 * `git status` は ignored ファイルを報告しないため、ignored な `.env` 等の
 * 新規作成・内容変更・symlink 化を検出するにはファイルシステム側の走査が要る。
 * Job 開始時と AI 実行後 / SafeCommand 実行後で比較し、差分だけを違反とする
 * （既存の ignored `.env` が存在するだけでは違反にしない）。
 */
export function scanSensitiveFiles(workingDir: string, patterns: RegExp[]): SensitiveBaseline {
  const baseline: SensitiveBaseline = new Map()
  const root = path.resolve(workingDir)
  const counter = { visited: 0 }

  walkSensitive(root, root, patterns, baseline, counter)

  return baseline
}

function walkSensitive(
  dir: string,
  root: string,
  patterns: RegExp[],
  baseline: SensitiveBaseline,
  counter: { visited: number },
): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err: unknown) {
    // ルート自体が読めない場合のみ致命。配下の権限エラーも安全側で fail-closed にする
    const message = err instanceof Error ? err.message : String(err)
    throw new ChangeDetectionError(`Failed to scan directory "${dir}": ${message}`)
  }

  for (const entry of entries) {
    counter.visited += 1
    if (counter.visited > SCAN_MAX_ENTRIES) {
      throw new ChangeDetectionError(
        `Sensitive file scan exceeded ${SCAN_MAX_ENTRIES} entries (走査打ち切りは fail-closed とする)`,
      )
    }

    const absolute = path.join(dir, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')

    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue
      // symlink 経由のディレクトリは辿らない（ループ・境界越え防止）
      walkSensitive(absolute, root, patterns, baseline, counter)
      continue
    }

    // Windows/macOS はファイルシステムが大文字小文字を区別しないため、ignored な
    // `.ENV` も `.env` と同一ファイルを指す。fileChangeGuard 側の禁止判定は
    // case-fold して判定するのに対し、ここが元の大文字小文字のまま比較すると
    // ignored+大文字ファイルだけがベースラインに入らず検出漏れになる
    // （2026-07-31 Codex 最終レビューで発見）。判定基準を統一するため小文字化する。
    if (!patterns.some((pattern) => pattern.test(relative.toLowerCase()))) continue

    const isSymlink = entry.isSymbolicLink()
    const type: EntryType = isSymlink ? 'symlink' : entry.isFile() ? 'regular' : 'special'

    // socket / device / FIFO 等の special file を readFileSync すると、
    // 相手側が現れるまで無期限にブロックしうる（FIFOの典型的な挙動）。
    // ハッシュ計算を試みず、この時点で fail-closed にする
    // （2026-07-31 Codex 4回目レビューで発見）。
    if (type === 'special') {
      throw new ChangeDetectionError(
        `Sensitive-pattern path "${relative}" is a special file (socket/device/fifo); ` +
          `refusing to read it (fail-closed)`,
      )
    }

    baseline.set(relative, {
      path: relative,
      type,
      hash: hashSensitiveEntry(absolute, isSymlink),
    })
  }
}

function hashSensitiveEntry(absolute: string, isSymlink: boolean): string {
  try {
    if (isSymlink) {
      return `symlink:${createHash('sha256').update(readlinkSync(absolute), 'utf-8').digest('hex')}`
    }

    const size = lstatSync(absolute).size
    if (size > SENSITIVE_HASH_MAX_BYTES) {
      throw new ChangeDetectionError(
        `Sensitive file "${absolute}" exceeds ${SENSITIVE_HASH_MAX_BYTES} bytes ` +
          `(全内容の読み込みは行わず fail-closed とする)`,
      )
    }

    return createHash('sha256').update(readFileSync(absolute)).digest('hex')
  } catch (err: unknown) {
    if (err instanceof ChangeDetectionError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ChangeDetectionError(`Failed to hash sensitive file "${absolute}": ${message}`)
  }
}

/**
 * Job 開始時ベースラインと現在状態を比較し、機密ファイルの変化を FileChange として返す。
 * 存在するだけの既存 ignored ファイルは（hash / type が一致する限り）差分にならない。
 */
export function diffSensitiveBaseline(
  before: SensitiveBaseline,
  after: SensitiveBaseline,
): FileChange[] {
  const changes: FileChange[] = []

  for (const [filePath, current] of after) {
    const previous = before.get(filePath)

    if (previous === undefined) {
      changes.push({ path: filePath, kind: 'added', afterType: current.type })
      continue
    }

    if (previous.hash !== current.hash || previous.type !== current.type) {
      changes.push({
        path: filePath,
        kind: 'modified',
        beforeType: previous.type,
        afterType: current.type,
      })
    }
  }

  for (const [filePath, previous] of before) {
    if (!after.has(filePath)) {
      changes.push({ path: filePath, kind: 'deleted', beforeType: previous.type })
    }
  }

  return changes
}

// ────────────────────────────────────────────────────────────
// manifest ユーティリティ
// ────────────────────────────────────────────────────────────

function toManifest(changes: FileChange[]): ChangeManifest {
  const paths: string[] = []

  for (const change of changes) {
    if (!paths.includes(change.path)) paths.push(change.path)
    // rename は旧パスも検査対象に含める
    if (change.oldPath !== undefined && !paths.includes(change.oldPath)) {
      paths.push(change.oldPath)
    }
  }

  return { changes, paths }
}

/** 複数 manifest を統合する（同一 path+oldPath+kind は1件に畳む） */
export function mergeManifests(...manifests: ChangeManifest[]): ChangeManifest {
  const merged: FileChange[] = []
  const seen = new Set<string>()

  for (const manifest of manifests) {
    for (const change of manifest.changes) {
      const key = `${change.kind} ${change.path} ${change.oldPath ?? ''} ${change.afterType ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(change)
    }
  }

  return toManifest(merged)
}

/** FileChange の一覧から ChangeManifest を作る（機密ベースライン差分の合流用） */
export function manifestFromChanges(changes: FileChange[]): ChangeManifest {
  return toManifest(changes)
}
