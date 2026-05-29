/**
 * Gemini CLI Adapter
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * gemini コマンド（Gemini CLI）のラッパー。
 *
 * ⚠️ Gemini CLI の正式フラグはバージョンによって変わる。
 *    確認コマンド: gemini --help
 *
 * 用途:
 *   - Reviewer AI（Project Reviewer）
 *   - Meta Reviewer AI は API経由（geminiClient.ts）を使用
 *     → autoReview.ts で直接 callGeminiForReview() を呼ぶ
 */

import type { AiCliRequest, AiCliAdapterConfig } from '@ai-team/shared'
import { BaseCliAdapter } from './adapter.js'

const MODE_PREFIXES: Record<AiCliRequest['mode'], string> = {
  implement:
    'あなたはDeveloper AIです。以下のタスクを実装してください。\n\n',
  review:
    'あなたはProject Reviewer AIです。以下のdiffをレビューし、問題をJSON形式で報告してください。\n\n',
  qa:
    'あなたはQA AIです。以下の変更の品質を確認し、JSON形式で報告してください。\n\n',
  summarize:
    'あなたはSummary Engineです。以下のプロジェクト状態を簡潔にまとめてください。\n\n',
}

export class GeminiCliAdapter extends BaseCliAdapter {
  constructor(config: AiCliAdapterConfig) {
    super({ ...config, provider: 'gemini' })
  }

  protected defaultCliName(): string {
    return 'gemini'
  }

  protected buildArgv(request: AiCliRequest): string[] {
    const fullPrompt = MODE_PREFIXES[request.mode] + request.prompt

    // Gemini CLI の非対話モード
    // ⚠️ 実際のフラグはインストールされたバージョンで要確認
    return [
      '--prompt', fullPrompt,
    ]
  }
}
