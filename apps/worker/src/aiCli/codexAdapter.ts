/**
 * Codex CLI Adapter（OpenAI Codex CLI）
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * codex コマンドのラッパー。
 *
 * ⚠️ Codex CLIの正式フラグはバージョンによって変わる。
 *    確認コマンド: codex --help
 *
 * 現状: プレースホルダー実装
 * 実際に使用する場合は buildArgv() を実装すること。
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
