# Development Rules

**Importance Level: 1**
**Status: active**

---

## Safety Audit Gate（最重要 — AI開発者必須）

> **Claude Code はこのリポジトリへのコミット前に必ず Safety Audit を実行すること。**

```powershell
# PATH をセットしてから実行
$env:PATH = "C:\Program Files\nodejs\geminiCLI\node_modules\corepack\shims;" + $env:PATH
cd C:\Users\honka\softwareDevelopAIteam
pnpm --filter @ai-team/worker audit:gate
```

### 判定ルール

| 結果 | 終了コード | Claude Code の行動 |
|------|-----------|-------------------|
| `ALLOW` | 0 | そのままコミット可 |
| `DEEP_REVIEW` | 1 | ユーザーに内容を報告し、確認を取ってからコミット |
| `BLOCK_CEO_REQUIRED` | 2 | コミット禁止。ユーザー（CEO）の明示的な承認なしに進めない |

- Gemini API が一時的に失敗した場合、Alignment Check をスキップして静的解析（Policy Guard）だけで Gate 判定する
- DEEP_REVIEW / BLOCK の場合は必ずユーザーに判定理由を見せること

---

## コミットルール

- 1タスク = 1コミット
- 大きいタスクは 1サブタスク = 1コミット
- コミットメッセージ形式: `[task-xxx] 変更内容の要約`
- mainブランチへ直接pushしない
- 作業ブランチ: `ai/task-xxx`

## 実装ルール

- UIにビジネスロジックを書かない（coreレイヤーに集約）
- テストなしで完了とみなさない
- `.env.example` は更新するが `.env` は触らない
- 型定義は `packages/shared` に集約する

## Context Packルール

- Developer AIはProject Memoryを直接読まない
- Context Pack経由でのみ情報を参照する
- Context Packは `POST /api/context-pack`（`apps/api/src/routes/contextPack.ts`）のレスポンスとして
  返される（ファイルとして `docs/context/` へ保存する実装ではない）

## Document Rot防止ルール

- **Current Truth優先**: Constitution / Architecture / Current State / Roadmap / 現行Feature仕様など、
  「現在有効な仕様・計画・状態」を示すDocでは、仕様変更時に古い記述へ「ただし現在は〜」を
  追記して両方残すのではなく、該当箇所そのものを現在の結論へ更新する
- **履歴はDecision/ADR/Lessonへ分離**: なぜその判断をしたか・以前の設計・却下案・失敗からの学びなど
  過去の判断経緯は、必要な場合に限り`docs/project_memory/decisions/`等の履歴用Docへ記録する。
  既存Decision/Lessonに同内容が既にあれば重複追加しない
- **重複コピー禁止**: 同じTruthを複数Docへ独立コピーしない。別Docが正本の場合は「短い説明＋
  正本への参照」を優先する
- **新しい設計判断の記録先**: 新規ADR/Decisionは `docs/project_memory/decisions/`
  （コードから実際に参照される現行の正本）へ記録する。`docs/adr/`（0001・0002のみ）は
  過去記録であり新規追加先ではない
- **Roadmap（`tasks/roadmap.md`）固有ルール**: Roadmapは「現在有効な計画・確定事項・未解決事項」を
  保持するDoc。後続調査で結論が変わった場合、古い結論への訂正追記を積み重ねず該当箇所を
  現在の結論へ更新する。各項目冒頭へ「現在の結論サマリー」を機械的に追加する運用は、
  本文との二重Truthを生むため採用しない

## 禁止事項

- Control Repository (`apps/api/`, `apps/worker/`, `sandbox/`) の改変
- `.env` / secret filesの読み書き
- `sudo`, `rm -rf /`, `curl | sh` などの危険コマンド
- mainへの直接push

---

*Created: 2026-05-28*
