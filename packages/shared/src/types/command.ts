/**
 * SafeCommand — AIに自由なコマンド文字列を渡させない設計
 *
 * レビュー指摘(2026-05-28):
 * "AIに自由なcommand stringを渡させるより、
 *  アプリ側が用意した安全な操作だけ選ばせる方が圧倒的に安全"
 *
 * AIは CommandKind を選ぶだけ。
 * 実際のコマンド文字列への変換はWorker(commandResolver.ts)が行う。
 * これによりコマンドインジェクションが構造的に不可能になる。
 */

export type CommandKind =
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'git_branch_create'
  | 'git_checkout'
  | 'git_commit'
  | 'git_revert'
  | 'typecheck'
  | 'test'
  | 'build'
  | 'lint'

/**
 * コマンドごとの型付きパラメータ
 * string型を避け、各コマンドに必要な情報だけを持つ
 */
export interface SafeCommandParams {
  commitMessage?: string    // git_commit
  branchName?: string       // git_branch_create, git_checkout
  revertCommit?: string     // git_revert: 対象コミットハッシュ
  testPattern?: string      // test: 特定テストのみ実行

  /**
   * git_commit のプレフィックス（JPstock方式: git log が誰が何をしたかのタイムラインになる）
   *   '[claude_code task-xxx]' または '[codex task-xxx]'
   * Workerが自動でセットする（AI入力ではないためサニタイズ不要）
   */
  agentPrefix?: string
}

export interface SafeCommand {
  kind: CommandKind
  params?: SafeCommandParams
  /** AIが作業するディレクトリ（/workspace/target配下のみ許可） */
  workingDir: string
}

/** CommandKindごとのデフォルトのzone分類 */
export type CommandZone = 'green' | 'yellow' | 'red'

export const COMMAND_ZONES: Record<CommandKind, CommandZone> = {
  git_status: 'green',
  git_diff: 'green',
  git_log: 'green',
  git_branch_create: 'green',
  git_checkout: 'green',
  git_commit: 'green',
  git_revert: 'green',
  typecheck: 'green',
  test: 'green',
  build: 'green',
  lint: 'green',
}
