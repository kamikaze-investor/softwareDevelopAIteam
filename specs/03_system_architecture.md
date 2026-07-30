# AI Development Team OS
## System Architecture v1.0

---

# 1. Purpose

本ドキュメントは、AI Development Team OS のシステム全体構造を定義する。

本システムは「AIチャットツール」ではない。

本質は AI開発チームを運営するためのOSである。

ユーザーはCEOとして振る舞い、AI組織が自律的に開発を進める。

---

# 2. Core Principle

システム全体は以下の思想に従う。

## Design Philosophy

- スマホ完結
- 全自動優先
- 承認最小
- Rollback重視
- Context重視
- 小さく変更
- 小さくコミット

## Authority Principle

AIはリポジトリ内の王様

人間はリポジトリ境界の門番

---

# 3. High Level Architecture

```text
CEO
↓
Human Dashboard
↓
CTO AI
↓
Context Manager
↓
Developer AI
↓
Reviewer AI
↓
QA AI
↓
Project Memory
↓
Context Engine
↓
Repository
```

---

# 4. Major Components

本システムは7つの主要コンポーネントで構成される。

## Human Dashboard

**役割**
CEOとの唯一の接点。

**表示**
- Goal
- Design Philosophy
- Progress
- Current Work
- Next Work
- Risks
- Open Decisions

**責任**
- 状況把握
- 方向修正
- 承認事項判断

## AI Organization

**役割**
開発組織本体。

**構成**
- CTO AI
- Context Manager AI
- Developer AI
- Reviewer AI
- QA AI

**責任**
- 設計
- 実装
- 品質保証
- ドキュメント管理

## Project Memory

**役割**
長期記憶。

**保存対象**
- Goal
- Design Philosophy
- Decision History
- Feature Knowledge
- Operational Knowledge
- Lessons Learned

**責任**
- 記憶保持
- 判断支援

## Context Engine

**役割**
必要文脈抽出。

**責任**
- 関連情報検索
- Context Pack生成
- 情報圧縮

## Task Graph

**役割**
プロジェクト全体管理。

**責任**
- Task管理
- 依存関係管理
- Progress管理

## Worker Execution Core

**役割**
AI実行結果を安全にAPIへ引き渡す（2026-07-31確定）。

**責任**
- AI実行プロセスへ本体DB・管理認証情報・Core内部状態を渡さない
- AI結果はWorker安全コアが検証・永続化し、Coreの限定インターフェースからのみ本体状態へ反映する
- 結果配送はat-least-once。受信側（API＝Core）はevent IDとpayload hashで冪等処理する
- 本体DBを書き込めるのはAPI（Core）のみ
- 状態不明のAI実行（結果を確定できないまま停止した実行）は隔離環境を破棄して1回だけ
  自動再実行し、CEOへ技術的な承認を要求しない。2回目も状態不明ならfail-closedで停止する

## Repository Layer

**役割**
成果物管理。

**対象**
- Code
- Tests
- Docs
- Configs

**責任**
- Version管理
- Rollback

## Summary Engine

**役割**
人間向け情報生成。

**責任**
- 状況要約
- リスク要約
- Progress要約

---

# 5. Information Flow

## Project Creation

```text
Specification
↓
Analysis
↓
Goal
↓
Design Philosophy
↓
Roadmap
↓
Task Graph
```

## Development Flow

```text
Task
↓
Context Manager
↓
Context Engine
↓
Context Pack
↓
Developer
↓
Reviewer
↓
QA
↓
Repository
```

## Human Flow

```text
Repository
↓
Project Memory
↓
Summary Engine
↓
Human Dashboard
↓
CEO
```

---

# 6. Context First Architecture

本システムの中核は Project Memory ではない。Context Engine でもない。

本システムの中核は **Context First Architecture** である。

**基本思想**

「保存する → 検索する → 要約する → 判断する」ではなく、

「判断に必要な情報だけ渡す」を目指す。

---

# 7. Project Memory Relationship

Project Memory は記録システムではない。

**目的**
AIが正しい判断を継続できること

**役割**

| コンポーネント | 役割 |
|---|---|
| Project Memory | Knowledge Storage |
| Context Engine | Knowledge Delivery |

---

# 8. Context Pack Architecture

Developer AI は Project Memory を直接読まない。

Developer AI は **Context Pack のみ**参照する。

**理由**
- 情報過多防止
- トークン削減
- 品質安定化

**Context Pack 例**

```text
Goal
Relevant Decisions
Relevant Features
Relevant Rules
Relevant Code
Relevant Tasks
```

---

# 9. Memory Governance

Project Memory は放置すると劣化する。そのため週次で以下を実施する。

- 重複検知
- 古い情報検知
- 矛盾検知
- 統合候補生成

**出力**: Memory Health Report

---

# 10. Human Visibility Principle

人間は内部知識を管理しない。

**表示対象**
- Goal
- Design Philosophy
- Progress
- Risks
- Open Decisions

**非表示**
- ADR
- Feature Notes
- Rules
- Context Pack
- Review Details

---

# 11. Failure Strategy

本システムは「失敗しないこと」を目指さない。

**目標**: 失敗しても戻せること

**戦略**
- Small Change
- Small Commit
- Frequent Rollback Point

**責務分離（2026-07-31確定）**: DB安全・Recovery・Audit・Telemetryの責務を混在させない。
- **Core**: DB権限・状態遷移・transaction・Job / State Control（Worker Outboxを含む）
- **Safe Mode / Recovery**: バックアップ・復元
- **Audit**: 監査記録
- **Telemetry**: 長期分析記録

AI実行結果が不明な場合、既存成果を救出せず隔離環境を破棄して1回だけ自動的にやり直す。
2回目も不明な場合は、人に判断を求めず安全に停止する。

---

# 12. Scalability

将来的に以下のチームを追加可能。

- Marketing Team
- Business Team
- Research Team

ただし v1 では **AI Development Team のみ**対象とする。

---

# 13. Success Criteria

本アーキテクチャの成功条件

- ユーザーはProject Summaryだけ見ればよい
- Goal変更以外で開発が停止しない
- AIが自律的に開発を継続できる
- Context Pack品質が開発品質を維持できる
- Project Memoryが長期間劣化しない
