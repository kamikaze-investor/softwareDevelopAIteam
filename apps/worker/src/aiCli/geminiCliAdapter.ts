/**
 * Gemini / Antigravity CLI Adapter
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * agy コマンド（Antigravity CLI）のラッパー。
 * Gemini CLI の後継ツール（Google I/O 2026 で発表）。
 *
 * 移行経緯:
 *   Gemini CLI（gemini コマンド）→ 2026-06-18 に停止
 *   Antigravity CLI（agy コマンド）→ 後継。Skills/Hooks は引き継ぎ可能。
 *
 * ⚠️ 非対話モードのフラグは `agy --help` で要確認。
 *    buildArgv() のフラグが旧 Gemini CLI のままになっている場合は修正すること。
 *
 * 用途:
 *   - Reviewer AI（Project Reviewer）
 *   - Meta Reviewer AI は API 経由（geminiClient.ts）を使用
 *     → autoReview.ts で直接 callGeminiForReview() を呼ぶ（こちらは影響なし）
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
    // Gemini CLI（gemini）→ Antigravity CLI（agy）に変更
    // 2026-06-18 以降は gemini コマンドが使えなくなる
    return 'agy'
  }

  protected buildArgv(request: AiCliRequest): string[] {
    const fullPrompt = MODE_PREFIXES[request.mode] + request.prompt

    // TODO: Antigravity CLI（agy）の非対話モードのフラグを確認すること
    //   確認コマンド: agy --help
    //   旧 Gemini CLI は --prompt フラグを使っていたが、agy では変わっている可能性がある
    //   公式ドキュメント: https://www.ai-souken.com/article/what-is-antigravity-cli
    return [
      '--prompt', fullPrompt,
    ]
  }
}
