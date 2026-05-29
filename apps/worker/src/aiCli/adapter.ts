/**
 * AI CLI Adapter — 基底クラス + ファクトリー
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 設計原則:
 *   AI CLIを直接自由実行させない。
 *   このアダプターがCLIをラップし、以下を強制する:
 *     1. workingDir の /workspace/target 限定チェック
 *     2. shell: false（シェルインジェクション防止）
 *     3. stdin を閉じる（対話入力を防ぐ）
 *     4. timeout 強制（暴走防止）
 *     5. Secret Scan（プロンプトに秘密情報が混入していないか確認）
 *     6. changedFiles の自動検出（git diff）
 */

import { execFileSync } from 'node:child_process'
import type {
  AiCliRequest,
  AiCliResult,
  AiCliAdapterConfig,
  AiCliProvider,
} from '@ai-team/shared'
import { isPromptSafe } from '@ai-team/shared'
import { isInsideTargetRoot } from '../utils/pathUtils.js'

// ────────────────────────────────────────────────────────────
// インターフェース
// ────────────────────────────────────────────────────────────

export interface IAiCliAdapter {
  run(request: AiCliRequest): Promise<AiCliResult>
}

// ────────────────────────────────────────────────────────────
// 基底クラス（全アダプター共通のセキュリティ制御）
// ────────────────────────────────────────────────────────────

export abstract class BaseCliAdapter implements IAiCliAdapter {
  protected readonly config: Required<AiCliAdapterConfig>

  constructor(config: AiCliAdapterConfig) {
    this.config = {
      cliPath: this.defaultCliName(),
      maxRetries: 2,
      ...config,
    }
  }

  /** サブクラスがCLI名（パス）を返す */
  protected abstract defaultCliName(): string

  /** サブクラスがプロンプト+モードをargvに変換する */
  protected abstract buildArgv(request: AiCliRequest): string[]

  async run(request: AiCliRequest): Promise<AiCliResult> {
    const startTime = Date.now()

    // ── セキュリティチェック1: workingDir ──────────────────
    if (!isInsideTargetRoot(request.workingDir)) {
      throw new Error(
        `[AiCliAdapter] workingDir が TARGET_ROOT 外です: ${request.workingDir}\n` +
        `AI CLI は /workspace/target 配下のみ実行できます。`
      )
    }

    // ── セキュリティチェック2: Secret Scan ─────────────────
    if (!isPromptSafe(request.prompt)) {
      throw new Error(
        `[AiCliAdapter] プロンプトに secret が検出されました（taskId: ${request.taskId}）\n` +
        `ContextPackにAPIキー・秘密鍵・パスワードを含めてはいけません。`
      )
    }

    if (request.dryRun) {
      return {
        taskId: request.taskId,
        provider: request.provider,
        exitCode: 0,
        stdout: '[DRY RUN] 実行をスキップしました',
        stderr: '',
        changedFiles: [],
        durationMs: 0,
      }
    }

    // ── CLI 実行 ───────────────────────────────────────────
    const argv = this.buildArgv(request)
    const timeout = request.timeoutMs ?? 300_000  // 5分

    let stdout = ''
    let stderr = ''
    let exitCode = 0

    try {
      stdout = execFileSync(this.config.cliPath, argv, {
        cwd: request.workingDir,
        shell: false,           // ⚠️ シェルを経由しない（インジェクション防止）
        timeout,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeEnv(request.provider),
      })
    } catch (err: any) {
      exitCode = typeof err.status === 'number' ? err.status : 1
      stdout   = typeof err.stdout === 'string' ? err.stdout : ''
      stderr   = typeof err.stderr === 'string' ? err.stderr : String(err)
    }

    // ── 変更ファイル検出（実行後の git diff） ──────────────
    const changedFiles = getChangedFiles(request.workingDir)

    // ── サマリー抽出（JSON出力があれば） ───────────────────
    const summary = extractSummary(stdout)

    return {
      taskId: request.taskId,
      provider: request.provider,
      exitCode,
      stdout,
      stderr,
      changedFiles,
      durationMs: Date.now() - startTime,
      summary,
    }
  }
}

// ────────────────────────────────────────────────────────────
// ファクトリー
// ────────────────────────────────────────────────────────────

export function createAiCliAdapter(config: AiCliAdapterConfig): IAiCliAdapter {
  switch (config.provider) {
    case 'claude_code':
      // import は動的に避ける（circular dependency防止）
      const { ClaudeCodeAdapter } = require('./claudeCodeAdapter.js')
      return new ClaudeCodeAdapter(config)

    case 'gemini':
      const { GeminiCliAdapter } = require('./geminiCliAdapter.js')
      return new GeminiCliAdapter(config)

    case 'codex':
      const { CodexAdapter } = require('./codexAdapter.js')
      return new CodexAdapter(config)

    default:
      throw new Error(`未対応のAI CLIプロバイダー: ${config.provider satisfies never}`)
  }
}

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

/**
 * プロバイダーごとに必要な環境変数だけを渡す
 * 不要な秘密情報をCLIプロセスに渡さない
 */
function buildSafeEnv(provider: AiCliProvider): NodeJS.ProcessEnv {
  // PATH・HOME・LANG等の基本変数は全プロバイダーで必要
  const base: NodeJS.ProcessEnv = {
    PATH:     process.env.PATH,
    HOME:     process.env.HOME,
    LANG:     process.env.LANG,
    TERM:     process.env.TERM,
    NODE_ENV: process.env.NODE_ENV,
  }

  // プロバイダー固有の認証情報のみ追加
  switch (provider) {
    case 'claude_code':
      return { ...base, ANTHROPIC_API_KEY: process.env.CLAUDE_API_KEY }
    case 'gemini':
      return { ...base, GEMINI_API_KEY: process.env.GEMINI_API_KEY }
    case 'codex':
      return { ...base, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
  }
}

/**
 * 実行後の変更ファイルを git diff で検出する
 * （未コミット変更 = CLIが書いたファイル）
 */
function getChangedFiles(workingDir: string): string[] {
  try {
    const result = execFileSync(
      'git',
      ['diff', '--name-only', 'HEAD'],
      { cwd: workingDir, encoding: 'utf-8', shell: false }
    )
    return result.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * stdout から summary を抽出する
 * CLIがJSON形式で出力している場合に対応
 */
function extractSummary(stdout: string): string | undefined {
  try {
    const jsonMatch = stdout.match(/```json\n([\s\S]+?)\n```/) ||
                      stdout.match(/\{[\s\S]+\}/)
    if (!jsonMatch) return undefined
    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
    return typeof parsed.summary === 'string' ? parsed.summary : undefined
  } catch {
    return undefined
  }
}
