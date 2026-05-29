/**
 * AI CLI Adapter ファクトリー
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * adapter.ts（BaseCliAdapter）から分離した理由:
 *   ClaudeCodeAdapter 等が adapter.ts の BaseCliAdapter を import する。
 *   adapter.ts が直接それらを import すると循環依存になる。
 *   ファクトリーを別ファイルに置くことで解消する。
 *
 *   adapter.ts ← claudeCodeAdapter.ts ← factory.ts（循環なし）
 */

import type { AiCliAdapterConfig } from '@ai-team/shared'
import type { IAiCliAdapter } from './adapter.js'
import { ClaudeCodeAdapter } from './claudeCodeAdapter.js'
import { GeminiCliAdapter } from './geminiCliAdapter.js'
import { CodexAdapter } from './codexAdapter.js'

export function createAiCliAdapter(config: AiCliAdapterConfig): IAiCliAdapter {
  switch (config.provider) {
    case 'claude_code':
      return new ClaudeCodeAdapter(config)

    case 'gemini':
      return new GeminiCliAdapter(config)

    case 'codex':
      return new CodexAdapter(config)

    default:
      // TypeScript exhaustiveness check
      throw new Error(`未対応のAI CLIプロバイダー: ${(config.provider as string)}`)
  }
}
