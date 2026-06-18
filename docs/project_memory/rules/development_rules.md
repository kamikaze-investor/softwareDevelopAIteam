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
- Context Packは `docs/context/` に生成する

## 禁止事項

- Control Repository (`apps/api/`, `apps/worker/`, `sandbox/`) の改変
- `.env` / secret filesの読み書き
- `sudo`, `rm -rf /`, `curl | sh` などの危険コマンド
- mainへの直接push

---

*Created: 2026-05-28*
