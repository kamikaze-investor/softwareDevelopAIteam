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

/**
 * 対応AI CLIプロバイダー
 *
 * 使い分けの原則:
 *   claude_code — 新機能・ゼロからの実装・複雑な設計判断が必要なとき
 *                 CLAUDE.md を自動読込する唯一のCLI
 *   codex       — 既存コードへの局所編集・パターン踏襲・claude_code 障害時フォールバック
 *                 CLAUDE.md を自動読込しない → Context Pack に必ず要点を含めること
 *   gemini      — Project Reviewer AI（コード品質レビュー）
 *                 Meta Reviewer は CLI ではなく API (geminiClient.ts) を使うこと
 *
 * 重要: 1タスク = 1プロバイダー原則
 *   同一タスク内で claude_code と codex を混在させない。
 */
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

  // ────────────────────────────────────────────────────────
  // Rule-001 対策フィールド
  // ────────────────────────────────────────────────────────

  /**
   * H-1対策: Codex向けCLAUDE.md注入の制御
   * デフォルト: provider === 'codex' のとき自動的に true
   * false にすると注入をスキップする（テスト時等）
   */
  injectClaudeMd?: boolean

  /**
   * H-2対策: このリクエスト実行前にContextPackの再生成が必要か
   * 前のJobがコミットを作成した場合、Workerはこれをtrueにセットする
   * true のとき Worker は Context Manager AI に再生成を依頼してから実行する
   */
  requiresFreshContextPack?: boolean

  /**
   * H-2対策: ContextPackが生成された時刻（ISO 8601）
   * Worker がstalenessを判定するために使う
   * 前Jobのコミット時刻よりも古ければ再生成が必要
   */
  contextPackGeneratedAt?: string

  /**
   * M-2対策: フォールバックポリシー
   * 指定した条件を満たしたとき、別プロバイダーで再実行する
   */
  fallbackPolicy?: FallbackPolicy

  /**
   * M-4対策: CLI実行後にlintを実行するか
   * デフォルト: provider === 'codex' のとき true（スタイル不一致を自動修正）
   *            provider === 'claude_code' のとき false（Claude自身が整形する）
   */
  postLint?: boolean
}

// ────────────────────────────────────────────────────────────
// M-2対策: フォールバックポリシー
// ────────────────────────────────────────────────────────────

/**
 * CLI実行失敗時のフォールバックルール（Rule-001 M-2）
 *
 * 重要: 品質問題（Meta Review: blocked/changes_requested）ではフォールバックしない。
 * APIエラー・タイムアウト等の技術的失敗のみフォールバック可。
 */
export interface FallbackPolicy {
  /** フォールバック先のプロバイダー */
  fallbackProvider: AiCliProvider

  /**
   * フォールバックを発動する条件
   *   'api_error'  — APIエラー（5xx・接続失敗）のみ（推奨）
   *   'timeout'    — タイムアウト時のみ
   *   'any_error'  — 任意のエラー（品質問題には使わないこと）
   */
  condition: 'api_error' | 'timeout' | 'any_error'
}

/**
 * フォールバック条件に一致するかを判定するヘルパー
 */
export function shouldFallback(
  policy: FallbackPolicy,
  exitCode: number,
  isTimeout: boolean,
  isApiError: boolean,
): boolean {
  switch (policy.condition) {
    case 'api_error': return isApiError
    case 'timeout':   return isTimeout
    case 'any_error': return exitCode !== 0
  }
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
