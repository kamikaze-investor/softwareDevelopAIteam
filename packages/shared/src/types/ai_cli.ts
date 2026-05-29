/**
 * AI CLI Adapter — 共有型定義
 *
 * AI CLIをAPIの代わりに使う場合の共通インターフェース。
 *
 * 設計原則:
 *   AI CLI = 意思決定・実装案を出すエンジン（頭脳）
 *   Worker = 権限管理・実行管理・差分管理をする本体（手足の制御）
 *   Guard  = 絶対ルールを機械的に守る安全装置
 *
 * AI CLIを直接自由実行させない。
 * WorkerがAI CLIをラップし、許可ディレクトリのみで実行する。
 */

// ────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────

/** 対応AI CLIプロバイダー */
export type AiCliProvider =
  | 'claude_code'  // Claude Code CLI (claude コマンド)
  | 'codex'        // OpenAI Codex CLI (codex コマンド)
  | 'gemini'       // Gemini CLI (gemini コマンド)

// ────────────────────────────────────────────────────────────
// Mode
// ────────────────────────────────────────────────────────────

/**
 * AI CLIへの依頼モード
 * 同じCLIでも役割を分けることで独立した判断を保つ
 */
export type AiCliMode =
  | 'implement'   // 実装（Developer AI）
  | 'review'      // コードレビュー（Reviewer AI）
  | 'qa'          // 品質確認（QA AI）
  | 'summarize'   // 進捗サマリー（Summary Engine）

// ────────────────────────────────────────────────────────────
// Request
// ────────────────────────────────────────────────────────────

export interface AiCliRequest {
  /** ジョブを識別するタスクID */
  taskId: string

  /** 使用するCLIプロバイダー */
  provider: AiCliProvider

  /** 実行ディレクトリ（/workspace/target 配下のみ許可） */
  workingDir: string

  /**
   * AIへの指示プロンプト（ContextPack含む）
   *
   * ⚠️ 禁止事項:
   *   - .env / APIキー / 秘密鍵 の内容を含めてはいけない
   *   - Control Repository (/workspace/control) のパスを含めてはいけない
   */
  prompt: string

  /**
   * 参照ファイルパスリスト（相対パス）
   * Context Manager AIが選択したファイルのみ
   * Secret Scanを通過したファイルのみ
   */
  contextFiles: string[]

  /** 実行モード */
  mode: AiCliMode

  /** タイムアウト（ms）。デフォルト: 300000 = 5分 */
  timeoutMs?: number

  /** ドライラン（実際に実行しない） */
  dryRun?: boolean
}

// ────────────────────────────────────────────────────────────
// Result
// ────────────────────────────────────────────────────────────

export interface AiCliResult {
  /** リクエストと紐づくタスクID */
  taskId: string

  /** 使用したCLIプロバイダー */
  provider: AiCliProvider

  /** CLIの終了コード（0 = 成功） */
  exitCode: number

  /** 標準出力 */
  stdout: string

  /** 標準エラー出力 */
  stderr: string

  /**
   * 変更されたファイルリスト（相対パス）
   * Worker が実行後に git diff --name-only HEAD で検出する
   */
  changedFiles: string[]

  /** 実行時間（ms） */
  durationMs: number

  /**
   * CLIが出力したサマリー（あれば）
   * JSON出力の summary フィールドから抽出
   */
  summary?: string

  /** JSONパース失敗などで再試行した回数 */
  retryCount?: number
}

// ────────────────────────────────────────────────────────────
// Adapter Config
// ────────────────────────────────────────────────────────────

export interface AiCliAdapterConfig {
  /** 使用するプロバイダー */
  provider: AiCliProvider

  /** CLIバイナリのパス（省略時はPATH依存） */
  cliPath?: string

  /**
   * JSON出力パース失敗時の最大リトライ回数
   * デフォルト: 2
   * 全リトライ失敗時は blocked 扱い
   */
  maxRetries?: number
}

// ────────────────────────────────────────────────────────────
// Secret Scan
// ────────────────────────────────────────────────────────────

/**
 * ContextPackにsecretが含まれていないか確認するためのパターン
 * Context Manager AIはこれらのパターンに一致する内容を除外すること
 */
export const CONTEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /ANTHROPIC_API_KEY\s*=\s*\S+/i,
  /CLAUDE_API_KEY\s*=\s*\S+/i,
  /GEMINI_API_KEY\s*=\s*\S+/i,
  /GITHUB_TOKEN\s*=\s*\S+/i,
  /-----BEGIN.*PRIVATE KEY-----/,
  /-----BEGIN.*RSA PRIVATE KEY-----/,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
]

/**
 * プロンプト文字列にsecretが含まれていないか確認する
 * true = 安全, false = secret検出（送信禁止）
 */
export function isPromptSafe(prompt: string): boolean {
  return !CONTEXT_SECRET_PATTERNS.some(pattern => pattern.test(prompt))
}
