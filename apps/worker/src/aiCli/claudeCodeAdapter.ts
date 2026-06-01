/**
 * Claude Code CLI Adapter
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * claude コマンド（Claude Code CLI）のラッパー。
 * Developer AI のメインプロバイダー。
 *
 * 使う状況:
 *   - 新機能のゼロからの実装
 *   - 複雑な設計判断が必要なタスク
 *   - CLAUDE.md のルールを自律的に守る必要があるとき（自動読込する）
 *
 * 使わない状況（Codex を使う）:
 *   - 既存コードへの局所的な修正
 *   - パターンが明確で機械的な変更
 *   - Claude Code API が制限/障害時のフォールバック
 *
 * 実行形式:
 *   claude -p "<prompt>" --output-format json
 *
 * ⚠️ CLIフラグはバージョンによって変わる場合がある。
 *    実際のCLIバージョンに合わせて buildArgv() を調整すること。
 *    確認コマンド: claude --version / claude --help
 */

import type { AiCliRequest, AiCliAdapterConfig } from '@ai-team/shared'
import { BaseCliAdapter } from './adapter.js'

// モードごとのシステムプロンプト接頭辞
const MODE_PREFIXES: Record<AiCliRequest['mode'], string> = {
  implement:
    'あなたはDeveloper AIです。以下のタスクを実装してください。' +
    '/workspace/target 配下のファイルのみ編集可能です。\n\n',
  review:
    'あなたはReviewer AIです。以下のdiffをレビューし、問題があればJSON形式で報告してください。\n\n',
  qa:
    'あなたはQA AIです。以下の変更の品質を確認し、JSON形式で報告してください。\n\n',
  summarize:
    'あなたはSummary Engineです。以下のプロジェクト状態を30秒で読めるサマリーにしてください。\n\n',
}

export class ClaudeCodeAdapter extends BaseCliAdapter {
  constructor(config: AiCliAdapterConfig) {
    super({ ...config, provider: 'claude_code' })
  }

  protected defaultCliName(): string {
    return 'claude'
  }

  protected buildArgv(request: AiCliRequest): string[] {
    const fullPrompt = MODE_PREFIXES[request.mode] + request.prompt

    // Claude Code CLI の非対話モード
    // --print / -p: 入力を受けてそのまま出力して終了
    // --output-format json: JSON形式で出力（パースしやすい）
    return [
      '--print', fullPrompt,
      '--output-format', 'json',
    ]
  }
}
