// Job型定義 (Worker実行単位)

import type { AgentRole } from './agent'
import type { SafeCommand } from './command'
import type { AiCliProvider, AiCliMode } from './ai_cli'

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'blocked'

/**
 * ガード検証結果（監査ログ用）
 * レビュー指摘(2026-05-28): あとから何が起きたか追跡できることが重要
 */
export interface JobGuardResult {
  permissionAllowed: boolean
  permissionReason?: string
  fileChangeAllowed: boolean
  fileViolations?: string[]
}

export interface JobFailureMetadata {
  kind?: string
  workspaceState?: 'unchanged' | 'changed' | 'unknown'
  /**
   * PR-C: クラッシュ復旧時にこの Job が quarantine されたか。
   * uptime: 復旧処理が workspace を「クリーン」と確認できず、
   * workspace 所有権を解放せず隔離した場合に true。
   */
  quarantined?: boolean
  /** quarantine の理由（検出された変更差分・git 操作中状態など） */
  quarantineReason?: string
}

/**
 * クラッシュ前に Job の子プロセスが workspace を変更し得る**前**に
 * 記録する、workspace の durable baseline（PR-C）。
 *
 * 復旧時に「workspace が Job 開始時点と完全一致するか」をこの baseline と比較し、
 * 一致すれば Job を terminalize して所有権を解放、不一致なら quarantine する。
 *
 * 2つの admission ケースを区別して表現する:
 * - NORMAL Job: admission 時にクリーンな worktree を要求する。baseline = start HEAD のみ
 *   （mode='clean'）。
 * - REPAIR Job（その他意図的に dirty な Job）: 直前の失敗 Implement Job が残した dirty
 *   worktree を**受け継ぐ**ため、start HEAD + dirty 状態の full fingerprint を記録する
 *   （mode='dirty'、entries に各変更エントリの現内容 hash を含む）。
 */
export type JobWorkspaceBaseline =
  | {
      mode: 'clean'
      startCommitHash: string
    }
  | {
      mode: 'dirty'
      startCommitHash: string
      /** dirty 状態の正規化されたエントリ一覧（削除は明示的に表現する） */
      entries: JobWorkspaceBaselineEntry[]
    }

/** baseline エントリの変更種別（worker の ChangeKind と同じ値集合） */
export type BaselineEntryKind = 'added' | 'modified' | 'deleted' | 'renamed'

/** baseline エントリの実体種別（worker の EntryType と同じ値集合） */
export type BaselineEntryType = 'regular' | 'symlink' | 'gitlink' | 'special'

/**
 * 1つの dirty エントリの正規化表現。
 * worker の `fingerprintWorktreeEntries()` と `buildWorktreeManifest()` の出力の
 * うち、後で完全一致比較に必要な情報のみを持つ。
 * 削除・rename 元のように worktree に内容が無いパスは `worktreeHash` に
 * 明示的な不在マーカー（`:absent:`）を入れる。
 */
export interface JobWorkspaceBaselineEntry {
  path: string
  /** rename の場合の旧パス */
  oldPath?: string
  kind: BaselineEntryKind
  /** porcelain v2 の生の XY ステータス対（index / worktree 状態の区別を保持する） */
  xyStatus?: string
  beforeType?: BaselineEntryType
  afterType?: BaselineEntryType
  beforeMode?: string
  afterMode?: string
  /** HEAD object id（porcelain v2 の hH） */
  headHash?: string
  /** INDEX object id（porcelain v2 の hI） */
  indexHash?: string
  /** worktree の現内容 hash。削除・rename 元は absent マーカー */
  worktreeHash: string
}

export interface Job {
  id: string
  taskId: string
  projectId: string

  /** APIが自動workflow内の1回限りのstepへ付与する冪等キー。手動Jobは未設定。 */
  workflowStepKey?: string

  /** 実行AIエージェント（監査ログ用） */
  agentRole: AgentRole

  status: JobStatus

  /**
   * 構造化コマンド（AIに自由なcommand stringを渡させない）
   * レビュー指摘(2026-05-28): command: string は危険
   */
  safeCommand: SafeCommand

  /** dryRunモード: 実際には実行せず検証のみ */
  dryRun?: boolean

  startedAt?: string
  completedAt?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  stdoutPath?: string
  stderrPath?: string
  changedFiles?: string[]
  commitHash?: string
  rollbackInfo?: RollbackInfo
  failureMetadata?: JobFailureMetadata

  /**
   * PR-C: クラッシュ前に記録された workspace baseline。
   * 復旧処理が「Job の通り道にある workspace が未変更か」を判定するために使う。
   */
  workspaceBaseline?: JobWorkspaceBaseline

  /** ガード検証結果（監査ログ） */
  guardResult?: JobGuardResult

  /** このJobに関連するApproval ID */
  approvalId?: string

  /**
   * AI CLI 実行パラメータ（task-022）
   * 指定された場合、SafeCommand 実行前に AI CLI を先行実行する。
   * review JobのpromptはWorkerが構築するため、クライアント/APIはproviderとmodeだけを保持する。
   * その他のmodeでは3フィールドすべてを指定する。
   */
  aiCliProvider?: AiCliProvider
  aiCliPrompt?: string
  aiCliMode?: AiCliMode

  createdAt: string
}

export interface RollbackInfo {
  previousCommitHash: string
  changedFiles: string[]
  /** Worker が実行する安全なロールバックコマンド（shell文字列ではなくargv） */
  rollbackArgv: string[]
}
