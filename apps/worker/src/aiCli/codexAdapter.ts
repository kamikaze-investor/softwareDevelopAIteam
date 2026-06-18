/**
 * Codex CLI Adapter（OpenAI Codex CLI）
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * codex コマンドのラッパー。
 * Developer AI のサブプロバイダー（局所編集・フォールバック用）。
 *
 * 使う状況:
 *   - 既存コードへの局所的な修正（関数1つ・バグ修正・リネーム等）
 *   - パターンが明確で機械的な変更
 *   - Claude Code が障害/レート制限のときのフォールバック
 *
 * 重要な制約:
 *   - CLAUDE.md を自動読込しない
 *     → Context Pack に CLAUDE.md の禁止事項・コーディングルールを必ず含めること
 *   - `exec --sandbox workspace-write` を使用（v0.140.0以降）
 *     → ワークスペース内ファイル編集のみ（コマンド実行はWorkerが制御）
 *   - 1タスク1プロバイダー原則: Claude Code と同一タスクで混在させない
 *
 * Windows での注意:
 *   Windows Store 版 Codex (WindowsApps) は直接実行できないため、
 *   npm グローバルインストール版 (codex.cmd) を使用する。
 *   → resolveCodexPath() が自動判定。CODEX_CLI_PATH 環境変数で上書き可能。
 *
 * ⚠️ Codex CLIのフラグ仕様は v0.140.0 時点。変更時は `codex exec --help` で確認。
 */

import type { AiCliRequest, AiCliAdapterConfig } from '@ai-team/shared'
import { BaseCliAdapter } from './adapter.js'
import { resolveCodexPath } from './codexPathResolver.js'

export class CodexAdapter extends BaseCliAdapter {
  constructor(config: AiCliAdapterConfig) {
    // cliPath が明示指定されていない場合は resolveCodexPath() で自動解決
    const resolvedCli = config.cliPath ?? (() => {
      try {
        return resolveCodexPath().resolved
      } catch {
        // 解決失敗時は 'codex' を仮設定し、実行時に詳細エラーが出る
        return 'codex'
      }
    })()

    super({ ...config, provider: 'codex', cliPath: resolvedCli })
  }

  protected defaultCliName(): string {
    // resolveCodexPath() は constructor で解決済みなのでここは到達しない
    return 'codex'
  }

  /** codex exec はパイプされた stdin を読む。prompt は argv ではなく stdin で渡す。 */
  protected useStdinPrompt(): boolean { return true }

  protected buildArgv(request: AiCliRequest): string[] {
    // codex-cli v0.140.0 以降: 非対話実行は `exec` サブコマンドを使用。
    //
    // --sandbox オプション（-s）:
    //   read-only        : ファイル読み取りのみ（review向け）
    //   workspace-write  : ワークスペース内のファイル書き込みを許可（implement向け）
    //   danger-full-access: 制限なし（使用禁止）
    //
    // Worker からの自動実行は workspace-write を上限とする。
    // コマンド実行は引き続き Worker の CommandKind/SafeCommand で制御する。
    //
    // prompt は argv 末尾ではなく stdin 経由で渡す（'-' = stdin 読み込みを指示）。
    // BaseCliAdapter が input: finalPrompt を execFileSync に渡す。

    const sandboxMode = request.mode === 'implement' ? 'workspace-write' : 'read-only'

    return [
      'exec',
      '--sandbox', sandboxMode,
      '-C', request.workingDir,   // ワークスペースルートを明示（execFileSync の cwd と一致）
      '--ephemeral',               // Workerの自動実行ではセッションファイルを残さない
      '-',                         // stdin からプロンプトを読む（useStdinPrompt() = true）
    ]
  }
}
