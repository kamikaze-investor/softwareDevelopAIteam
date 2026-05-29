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
    // TODO: Codex CLI の正式フラグが確定したら実装する
    // 現状は approval_mode=suggest で変更提案のみ
    return [
      '--approval-mode', 'suggest',
      '--quiet',
      request.prompt,
    ]
  }
}
