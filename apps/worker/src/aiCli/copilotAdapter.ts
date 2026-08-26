/**
 * GitHub Copilot CLI Adapter
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * copilot コマンド（GitHub Copilot CLI, npm: @github/copilot）のラッパー。
 *
 * 現状の用途:
 *   Meta Review の Gemini API/CLI 両方 quota 枯渇時の最終フォールバック。
 *   実際の呼び出しは BaseCliAdapter 経由ではなく metaReviewer/copilotRouter.ts の
 *   直接呼び出しを使う（Meta Review は Control Repository 自体を審査するため、
 *   BaseCliAdapter が強制する workingDir === /workspace/target 制約に合わない。
 *   Gemini も同じ理由で Meta Reviewer は geminiRouter.ts の直接呼び出しを使っている）。
 *
 * このクラス自体は将来の Independent Review / implementation 用の
 * 共通アダプター（review/qa/summarize モードの target-project 作業）として用意する。
 *
 * 認証:
 *   GITHUB_TOKEN（Actions の組み込みトークン）のみで認証可能。
 *   実測確認済み（2026-08-26, org-owned repo ではない個人アカウントリポジトリで実行）。
 *   ワークフロー側で permissions.copilot-requests: write が必要。
 *
 * 安全性:
 *   --yolo / --allow-all / --allow-all-tools は使用しない。
 *   `--available-tools`（値なし）でツール自体をモデルから見えなくする。--allow-tool を
 *   渡さないだけでは不十分（実測確認済み 2026-08-26: --allow-tool なしでも非対話モードで
 *   cwd 配下のファイル一覧・読み取りが確認なしで実行される。`--available-tools` で空の
 *   allowlistを渡すと同条件で NO_FILE_ACCESS 応答になることを GitHub Actions 上で実証済み）。
 *   implement モードのツール権限設計は未着手のため、明示的に未対応としてエラーにする。
 */

import type { AiCliRequest, AiCliAdapterConfig } from '@ai-team/shared'
import { BaseCliAdapter } from './adapter.js'

/** 実測確認済みの既定モデル（2026-08-26, GitHub Actions runner上）。Microsoft系を優先。 */
export const DEFAULT_COPILOT_MODEL = 'mai-code-1.1-flash'

const MODE_PREFIXES: Partial<Record<AiCliRequest['mode'], string>> = {
  review:
    'あなたはProject Reviewer AIです。以下のdiffをレビューし、問題をJSON形式で報告してください。\n\n',
  qa:
    'あなたはQA AIです。以下の変更の品質を確認し、JSON形式で報告してください。\n\n',
  summarize:
    'あなたはSummary Engineです。以下のプロジェクト状態を簡潔にまとめてください。\n\n',
}

export class CopilotCliAdapter extends BaseCliAdapter {
  constructor(config: AiCliAdapterConfig) {
    super({ ...config, provider: 'copilot' })
  }

  protected defaultCliName(): string {
    return 'copilot'
  }

  protected buildArgv(request: AiCliRequest): string[] {
    const prefix = MODE_PREFIXES[request.mode]
    if (!prefix) {
      // implement モードはツール権限（--allow-tool の設計）が未確定のため、
      // 安全側に倒して明示的にエラーとする。黙って --allow-all-tools 相当を渡さない。
      throw new Error(
        `[CopilotCliAdapter] mode "${request.mode}" は未対応です。` +
        `implement モードのツール権限設計が完了するまでサポートしません。`
      )
    }

    const fullPrompt = prefix + request.prompt

    return [
      '-p', fullPrompt,
      '-s',                                          // 統計を出さず応答のみ出力
      '--no-color',
      '--model', request.model ?? DEFAULT_COPILOT_MODEL,
      // ツールをモデルから完全に見えなくする（値なし = 空allowlist。実測確認済み）。
      // repository を自由探索させず、プロンプトに埋め込んだ情報のみで回答させる。
      '--available-tools',
    ]
  }
}
