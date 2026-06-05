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
 *     7. H-1対策: provider=codex のとき CLAUDE.md 要点をプロンプトに自動注入
 *     8. M-4対策: provider=codex のとき CLI実行後に lint を自動実行
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type {
  AiCliRequest,
  AiCliResult,
  AiCliAdapterConfig,
  AiCliProvider,
} from '@ai-team/shared'
import { isPromptSafe } from '@ai-team/shared'
import { isInsideTargetRoot, TARGET_ROOT } from '../utils/pathUtils.js'
import { saveJobLogs } from '../jobLogger.js'

// CLAUDE.md / AGENTS.md のパス（コンテナ内 = /workspace/control、ローカル開発 = プロジェクトルート）
const CLAUDE_MD_PATHS = [
  '/workspace/control/CLAUDE.md',
  path.resolve(process.cwd(), '../../CLAUDE.md'),
  path.resolve(process.cwd(), 'CLAUDE.md'),
]

const AGENTS_MD_PATHS = [
  '/workspace/control/AGENTS.md',
  path.resolve(process.cwd(), '../../AGENTS.md'),
  path.resolve(process.cwd(), 'AGENTS.md'),
]

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

    // ── H-1対策: Codex向けCLAUDE.md注入 ──────────────────
    // Codex は CLAUDE.md を自動読込しないため、プロンプト先頭に必ず注入する。
    // injectClaudeMd が明示的に false の場合のみスキップ（テスト用）。
    const shouldInject = request.provider === 'codex' && request.injectClaudeMd !== false
    const finalPrompt = shouldInject
      ? injectClaudeMdEssentials(request.prompt)
      : request.prompt

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
    //
    // ⚠️ 設計上の注意（Meta Review 指摘: medium）:
    //   この実行経路は CommandKind / permissionGuard を通らない。
    //   AI CLI はファイル編集・git操作を自律的に行うため、
    //   CommandKind の細粒度制御とは別レイヤーで動作する。
    //
    //   代わりに以下の多層防御を適用する:
    //     1. workingDir = /workspace/target 限定（このクラスで強制）
    //     2. Docker read-only mount（Control Repo を物理的に保護）
    //     3. File Change Guard（実行後の差分を検査）
    //     4. Meta Reviewer AI（コミット前に差分を審査）
    //
    //   CommandKind Guard との統合は task-009（Worker Job実行エンジン）で設計する。
    //
    // finalPrompt = H-1注入済みプロンプト（Codexの場合のみCLAUDE.md先頭付与）
    const argv = this.buildArgv({ ...request, prompt: finalPrompt })
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

    // ── M-4対策: Codex実行後のlint自動実行 ────────────────
    // Codex はスタイルが不一致になりやすいため、デフォルトでlintを実行する。
    // postLint が明示的に false の場合のみスキップ。
    const shouldPostLint = request.provider === 'codex' && request.postLint !== false
    if (shouldPostLint && changedFiles.length > 0) {
      runPostLint(request.workingDir)
    }

    // ── サマリー抽出（JSON出力があれば） ───────────────────
    const summary = extractSummary(stdout)

    // ── task-023: JSON出力パーサー + リトライ ───────────────
    let parsedOutput: Record<string, unknown> | undefined
    let blocked = false
    let retryCount = 0
    if (request.expectJson) {
      const maxRetries = this.config.maxRetries
      let parseTarget = stdout
      parsedOutput = tryParseJson(parseTarget)

      while (parsedOutput === undefined && retryCount < maxRetries) {
        retryCount++
        // リトライ: "JSONで出力し直してください" を付け加えて再実行
        const retryArgv = this.buildArgv({
          ...request,
          prompt: `${finalPrompt}\n\n## 再試行指示（リトライ ${retryCount}/${maxRetries}）\n前回の出力がJSONとして解析できませんでした。必ず有効なJSON形式のみを出力してください。`,
        })
        let retryStdout = ''
        try {
          retryStdout = execFileSync(this.config.cliPath, retryArgv, {
            cwd: request.workingDir,
            shell: false,
            timeout,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: buildSafeEnv(request.provider),
          })
        } catch (err: any) {
          retryStdout = typeof err.stdout === 'string' ? err.stdout : ''
        }
        parsedOutput = tryParseJson(retryStdout)
        if (parsedOutput !== undefined) {
          stdout = retryStdout  // パース成功したリトライ出力で上書き
        }
      }

      if (parsedOutput === undefined) {
        blocked = true
      }
    }

    // ── ログ永続化（task-022） ──────────────────────────────
    let stdoutPath: string | undefined
    let stderrPath: string | undefined
    if (request.taskId) {
      try {
        const logPaths = saveJobLogs(`cli-${request.taskId}`, stdout, stderr)
        stdoutPath = logPaths.stdoutPath
        stderrPath = logPaths.stderrPath
      } catch {
        // ログ保存失敗は非致命的（実行結果には影響しない）
      }
    }

    return {
      taskId: request.taskId,
      provider: request.provider,
      exitCode,
      stdout,
      stderr,
      stdoutPath,
      stderrPath,
      changedFiles,
      durationMs: Date.now() - startTime,
      summary,
      parsedOutput,
      ...(request.expectJson ? { blocked, retryCount } : {}),
    }
  }
}

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// H-1対策: CLAUDE.md注入
// ────────────────────────────────────────────────────────────

/**
 * Codex向けにCLAUDE.mdの要点をプロンプト先頭に注入する（Rule-001 H-1）
 *
 * Codex CLI は CLAUDE.md を自動読込しないため、
 * システムの制約（禁止事項・コーディングルール）をプロンプトに含めることで
 * Codexが知らずにルール違反するリスクを排除する。
 */
function injectClaudeMdEssentials(originalPrompt: string): string {
  // CLAUDE.md を探して読み込む
  let claudeMdContent: string | undefined
  for (const claudeMdPath of CLAUDE_MD_PATHS) {
    if (existsSync(claudeMdPath)) {
      try {
        claudeMdContent = readFileSync(claudeMdPath, 'utf-8')
        break
      } catch {
        // 次のパスを試す
      }
    }
  }

  if (!claudeMdContent) {
    console.error('[AiCliAdapter] WARNING: CLAUDE.md が見つかりません。フォールバックルールを使用します。')
    claudeMdContent = CLAUDE_MD_FALLBACK_ESSENTIALS
  }

  // AGENTS.md も読み込む（共同運用ルール + TypeScript品質ルール）
  let agentsMdContent: string | undefined
  for (const p of AGENTS_MD_PATHS) {
    if (existsSync(p)) {
      try { agentsMdContent = readFileSync(p, 'utf-8'); break } catch { /* 次を試す */ }
    }
  }

  return [
    '## ⚠️ システム制約（最優先・必読）',
    '',
    '以下はAI Development Team OSの憲法です。この制約はタスクの内容よりも優先されます。',
    '',
    claudeMdContent,
    '',
    ...(agentsMdContent ? [
      '---',
      '',
      '## 共同運用ルール（AGENTS.md）',
      '',
      agentsMdContent,
    ] : []),
    '',
    '---',
    '',
    '## タスク',
    '',
    originalPrompt,
  ].join('\n')
}

/**
 * CLAUDE.md が見つからない場合のフォールバック（最重要事項のみ）
 * 実際の CLAUDE.md と同期を保つこと
 */
const CLAUDE_MD_FALLBACK_ESSENTIALS = `
絶対禁止:
  - ai-team-backend/ / apps/ / packages/ / specs/ / docs/ / sandbox/ の変更（Control Repository）
  - target-project/ 以外のファイルの編集
  - .env / secret files の読み書き
  - sudo / rm -rf / curl | sh などの危険コマンド

Repository Boundary:
  - 編集可能: /workspace/target 配下のみ
  - 編集不可: /workspace/control 配下（このOSのコード）

コミットルール:
  - コミットメッセージ: [task-xxx] 変更内容の要約
  - テストなしで完了とみなさない
`.trim()

// ────────────────────────────────────────────────────────────
// M-4対策: lint後処理
// ────────────────────────────────────────────────────────────

/**
 * Codex実行後のlint自動実行（Rule-001 M-4）
 * スタイル不一致を自動修正する。失敗しても実行は継続する（non-fatal）。
 */
function runPostLint(workingDir: string): void {
  try {
    execFileSync('pnpm', ['lint', '--fix'], {
      cwd: workingDir,
      shell: false,
      encoding: 'utf-8',
      timeout: 60_000,  // 1分
    })
  } catch {
    // lint失敗は警告のみ（ブロックしない）
    // lint結果はFile Change Guard + Meta Reviewer AIが後から確認する
    console.warn('[AiCliAdapter] post-lint failed (non-fatal). File Change Guard will check the diff.')
  }
}

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
/**
 * task-023: JSON文字列のパースを試みる
 * stdout内のコードブロックまたは生のJSONオブジェクトを探す
 */
function tryParseJson(stdout: string): Record<string, unknown> | undefined {
  // ```json ... ``` ブロックを優先
  const jsonBlockMatch = stdout.match(/```json\n([\s\S]+?)\n```/)
  if (jsonBlockMatch) {
    try { return JSON.parse(jsonBlockMatch[1]) } catch { /* fall through */ }
  }
  // 生JSONオブジェクト（最初の { ... } を探す）
  const rawMatch = stdout.match(/\{[\s\S]+\}/)
  if (rawMatch) {
    try { return JSON.parse(rawMatch[0]) } catch { /* fall through */ }
  }
  return undefined
}

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
