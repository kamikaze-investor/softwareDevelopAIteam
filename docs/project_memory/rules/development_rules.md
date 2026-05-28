# Development Rules

**Importance Level: 1**
**Status: active**

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
