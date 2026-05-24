# AI Development Team OS
## MVP Scope Definition v1.0

---

# 1. Purpose

本ドキュメントは AI Development Team OS の 最初に開発する範囲（MVP）を定義する。

MVPの目的は完成したシステムを作ることではない。

目的は「**AI開発チームOSの中核仮説を検証すること**」である。

---

# 2. MVP Philosophy

## Core Principle

小さく作る。まず検証する。成功したら拡張する。

**禁止**
```text
全部入り
将来必要そうだから追加
```

---

# 3. MVP Success Question

MVPが答えるべき問い

```text
非エンジニアは
AI開発チームを
スマホから運営できるか？
```

これ以外は MVP対象外。

---

# 4. MVP Goals

| Goal | 内容 |
|---|---|
| Goal 1 | 仕様書からプロジェクト生成 |
| Goal 2 | AIがタスク生成 |
| Goal 3 | AIが実装を進める |
| Goal 4 | CEOが状況を把握できる |
| Goal 5 | Goal変更以外で開発が止まらない |

---

# 5. MVP Scope

## Project Creation

**Required**
```text
仕様書貼り付け
仕様解析
Gap Analysis
Project Readiness Review
```

## AI Organization

**Required**
```text
CTO AI
Context Manager AI
Developer AI
Summary Engine
```

**除外**: Reviewer AI / QA AI

理由: 初期は簡易レビューで十分。

## Project Memory

**Required**
```text
Goal
Design Philosophy
Decision History
Feature Knowledge
```

**除外**: Lessons Learned / Memory Governance / Drift Detection（後で追加）

## Context Engine

**Required**
```text
検索
ランキング
Context Pack生成
```

**除外**: Context Cache / 高度圧縮 / 自動改善

## Dashboard

**Required**
```text
Goal
Progress
Current Work
Next Work
Risks
```

**除外**: Health Metrics / Deep Dive / 通知管理

---

# 6. MVP Workflow

```text
仕様書貼り付け
↓
Goal抽出
↓
Design Philosophy抽出
↓
Project Memory生成
↓
Roadmap生成
↓
Task生成
↓
Context Pack生成
↓
Developer実装
↓
Summary更新
↓
CEO確認
```

---

# 7. MVP User Experience

ユーザー視点

| ステップ | 内容 |
|---|---|
| Step 1 | 仕様書を貼る |
| Step 2 | 不足項目確認 |
| Step 3 | 開発開始 |
| Step 4 | Dashboard確認 |
| Step 5 | 必要なら方向修正 |

以上。

---

# 8. MVP Approval Model

**AI自由**
```text
タスク作成 / 実装 / 修正 / リファクタリング / ドキュメント更新 / コミット
```

**人間承認**
```text
Goal変更 / Design Philosophy変更 / 外部サービス追加 / 課金 / 公開
```

---

# 9. MVP Technical Architecture

| 要素 | 選択 | 理由 |
|---|---|---|
| Storage | Markdown Files のみ | DB不要 |
| Memory | `docs/project_memory/` 管理 | シンプル |
| Repository | GitHub | |
| Execution | Claude Code 中心 | |

---

# 10. Explicitly Out of Scope

MVPでは作らない。

```text
Multi Project        複数プロジェクト管理
Team Collaboration   複数人利用
Marketing Team       AIマーケティング組織
Business Team        AI経営組織
Auto Deploy          自動本番公開
Billing              課金システム
User Management      ユーザー管理
SaaS化               一般公開向け機能
```

---

# 11. Phase 2 Candidates

MVP成功後に検討。

```text
Reviewer AI（独立）
QA AI（独立）
Memory Governance
Drift Detection
Context Feedback Loop
Notification System
Health Metrics
```

---

# 12. MVP Exit Criteria

以下を満たしたらMVP成功。

```text
仕様書からプロジェクト生成できる
AIがタスク生成できる
AIが実装できる
Dashboardで状況確認できる
Goal変更以外で開発が止まらない
```

---

# 13. Failure Criteria

以下は失敗。

```text
ユーザーがコードを書く必要がある
毎回承認が必要
Dashboardを見ても状況が分からない
Context Packが機能しない
AIが頻繁に停止する
```

---

# Most Important Principle

MVPの目的は完成品を作ることではない。

**AI開発チームOSという考え方が 実際に機能するかを検証することである。**
