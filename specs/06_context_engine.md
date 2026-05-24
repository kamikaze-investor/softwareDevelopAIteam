# AI Development Team OS
## Context Engine Detailed Design v1.0

---

# 1. Purpose

Context Engine は AI Development Team OS の中核システムである。

Project Memory が存在しても、必要な情報を適切に渡せなければ AIの判断品質は向上しない。

本システムの目的は「情報を保存すること」ではない。

本当の目的は「正しい判断に必要な情報だけを届けること」である。

---

# 2. Core Philosophy

## Context First

本システムは「大量の情報を読む」を目指さない。

目標は「必要最小限の情報だけ渡す」ことである。

## Information Diet

Developer AI は Project Memory全体を読まない。

Developer AI が受け取るのは **Context Pack** のみ。

---

# 3. High Level Flow

```text
Task
↓
Context Search
↓
Candidate Context
↓
Context Ranking
↓
Context Compression
↓
Context Pack
↓
Developer AI
```

---

# 4. Context Sources

検索対象。

## Goal
最上位。常に含める。

例
```text
スマホだけでAI開発チームを運営する
```

## Design Philosophy
常に含める。

例
```text
スマホ完結
全自動優先
Rollback重視
```

## Decision History
旧ADR。

例
```text
VPS方式採用
理由: スマホ完結実現のため
```

## Feature Knowledge
機能知識。

例
```text
認証 / 通知 / 同期 / Context Engine
```

## Operational Knowledge
運用ルール。

例
```text
小さくコミット
テスト必須
```

## Lessons Learned
過去の失敗。

例
```text
Context Pack肥大化で品質低下
```

## Related Code
関連コード。

例
```text
AuthService
TaskRepository
ContextPackBuilder
```

## Related Tasks
関連タスク。

例
```text
Task-41
Task-42
```

---

# 5. Context Search

**Input**: Task

例
```text
認証機能にGoogle Login追加
```

**Search Targets**
- Goal
- Design Philosophy
- Decision History
- Feature Knowledge
- Operational Knowledge
- Lessons Learned
- Related Code
- Related Tasks

**Search Result**: Candidate Context 生成

---

# 6. Context Ranking

検索結果をそのまま渡さない。重要度を計算する。

## Priority Formula

```text
Context Score = Relevance + Importance + Recency + Dependency
```

**Relevance**: Taskとの関連度

**Importance**: Memory Importance

| 種別 | Level |
|---|---|
| Goal | 5 |
| Design Philosophy | 4 |
| Decision | 3 |
| Feature | 2 |
| Rule | 1 |

**Recency**: 最近更新された情報

**Dependency**: 依存関係

---

# 7. Context Compression

最重要工程。

目的は「読む量を減らす」ではない。

目的は「**判断しやすくする**」である。

## Compression Rules

- **Rule 1**: 要約を先に置く
- **Rule 2**: 原文は後ろに置く
- **Rule 3**: 重複排除
- **Rule 4**: 矛盾情報は警告

---

# 8. Context Pack

Context Engineの最終成果物。

## Structure

```text
Goal
Design Philosophy
Task Summary
Relevant Decisions
Relevant Features
Relevant Rules
Lessons Learned
Related Code
Related Tasks
```

---

# 9. Context Pack Example

```text
Goal
スマホだけでAI開発チームを運営する

---

Design Philosophy
スマホ完結
全自動優先
Rollback重視

---

Task Summary
Google Login追加

---

Relevant Decisions
VPS経由で認証処理

---

Relevant Features
Authentication

---

Relevant Rules
認証処理共通化禁止

---

Lessons Learned
OAuth変更で既存認証破壊事故あり

---

Related Code
AuthService
GoogleAuthProvider
```

---

# 10. Context Budget

Context Packは無制限にしない。

**理由**: 情報量増加 → 判断品質低下 が起きるため。

**Target Size**

| フェーズ | トークン数 |
|---|---|
| MVP | 3,000〜8,000 tokens |
| 上限 | 15,000 tokens |

超過時: 低優先情報を削除。

---

# 11. Context Cache

頻繁に同じ検索を行わない。

**キャッシュ対象**
- Task
- Feature
- Decision

**更新条件**: Project Memory変更時のみ

---

# 12. Context Health

管理指標。

| 指標 | 説明 | 目標 |
|---|---|---|
| Relevance Score | Taskとの関連度 | 90%以上 |
| Noise Score | 不要情報率 | 10%未満 |
| Missing Score | 不足情報率 | 5%未満 |

---

# 13. Failure Modes

## Context Overload
情報過多。

- **症状**: Developer品質低下
- **対策**: Context Pack圧縮

## Context Starvation
情報不足。

- **症状**: 判断ミス
- **対策**: 追加検索

## Context Conflict
矛盾。

- **症状**: 判断停止
- **対策**: Conflict Report生成

---

# 14. Human Visibility

原則として人間は Context Packを見ない。

人間が見るのは **Project Summary** のみ。

例外: デバッグ時のみ。

---

# 15. Success Criteria

**成功ではないもの**: 大量の情報を渡すこと

**成功条件**: Developer AIが 最小情報で 最大品質の判断を行えること

## Most Important Principle

> Context Engineは検索システムではない
>
> 判断支援システムである
