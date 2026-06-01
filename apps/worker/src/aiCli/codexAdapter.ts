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
 *   - --approval-mode auto-edit を使用
 *     → ファイル編集のみ実行（コマンド実行はWorkerが制御）
 *   - 1タスク1プロバイダー原則: Claude Code と同一タスクで混在させない
 *
 * ⚠️ Codex CLIの正式フラグはバージョンによって変わる。
 *    確認コマンド: codex --help
 */

import type { AiCliRequest, AiCliAdapterConfig } from '@ai-team/shared'
import { BaseCliAdapter } from './adapter.js'

export class CodexAdapter extends BaseCliAdapter {
  constructor(config: AiCliAdapterConfig) {
    super({ ...config, provider: 'codex' })
  }

  protected defaultCliName(): string {
    return 'codex'
  }

  protected buildArgv(request: AiCliRequest): string[] {
    // Codex CLI フラグ:
    //   --approval-mode full-auto  : ファイル編集もコマンド実行も全自動（implement向け）
    //   --approval-mode auto-edit  : ファイル編集のみ自動（コマンド実行は不可・より安全）
    //   --approval-mode suggest    : 提案のみ・実際には変更しない（review向け）
    //
    // Worker からの自動実行は auto-edit を使う（コマンド実行を Codex に委ねない）
    // コマンド実行は引き続き Worker の CommandKind/SafeCommand で制御する

    const approvalMode = request.mode === 'implement' ? 'auto-edit' : 'suggest'

    return [
      '--approval-mode', approvalMode,
      request.prompt,
    ]
  }
}
