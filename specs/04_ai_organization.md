# AI Development Team OS
## AI Organization Detailed Design v1.0

---

# 1. Purpose

本ドキュメントは、AI Development Team OS における AI組織構造を定義する。

本システムは AIを単なるコード生成ツールとして扱わない。

本システムでは AIを組織として運用する。

人間はCEOとして振る舞い、AI組織が開発を遂行する。

---

# 2. Organization Structure

```text
CEO（Human）
↓
CTO AI
↓
Context Manager AI
↓
Developer AI
↓
Reviewer AI
↓
QA AI
↓
Summary Engine
```

---

# 3. Organization Philosophy

## Human Role

人間は経営者。

**責任**
- Goal設定
- Design Philosophy設定
- 方向修正
- 承認事項判断

人間は以下を行わない。
- 実装しない
- レビューしない
- タスク管理しない
- Context管理しない

## AI Role

AIは開発チーム。

**責任**
- 設計
- 実装
- レビュー
- テスト
- ドキュメント
- 知識管理

---

# 4. CTO AI

**Mission**: プロジェクト全体の責任者。

**Role**
- 技術責任者
- プロダクト責任者
- プロジェクト責任者

## Responsibilities

**Goal Management**
- Goal維持
- Goal整合性確認

**Design Management**
- Design Philosophy維持
- Architecture維持

**Project Management**
- Roadmap生成
- Task生成
- Priority管理

**Knowledge Management**
- Decision作成
- Feature Knowledge作成
- Rule作成

**Governance**
- Memory Health管理
- Architecture整合性管理

**Input**
- Goal
- Design Philosophy
- Project Memory
- Dashboard State

**Output**
- Roadmap
- Task Graph
- Decisions
- Feature Knowledge
- Rules

**Authority** — 自由実行可能
- Task作成
- Task更新
- ADR作成
- Feature作成
- Rule作成

---

# 5. Context Manager AI

**Mission**: 必要情報を必要な人へ届ける。

**Role**: 組織の司書

## Responsibilities

**Context Search** — 検索対象
- Decision History
- Feature Knowledge
- Rules
- Lessons Learned
- Related Code

**Context Selection**: 不要情報除外

**Context Compression**: 要約・圧縮・整理

**Context Pack Creation**: Context Pack生成

**Input**
- Task
- Project Memory

**Output**: Context Pack

**Success Metric**

Developerが Project Memoryを読まなくても実装できること

---

# 6. Developer AI

**Mission**: 機能を実装する。

## Responsibilities

**Implementation**
- 新機能
- 修正
- リファクタリング

**Documentation**
- コードコメント
- 技術文書更新

**Testing**
- テスト追加

**Input**
- Task
- Context Pack

**Output**
- Code Changes
- Test Changes
- Documentation Changes

**Rule**: Project Memory直接参照禁止 — Context Packのみ参照

## モデル選定（Developer AI）

| プロバイダー | 役割 | 使う状況 |
|---|---|---|
| **Claude Code CLI** | メイン実装者 | 新機能・ゼロからの実装・複雑な設計判断が必要なとき |
| **Codex CLI** | 局所編集・フォールバック | 既存コードへの小変更・パターン踏襲・Claude Code障害時 |

**原則**:
- 1タスク = 1プロバイダー（同一タスク内で両CLIを混在させない）
- Claude Code が設計・実装した部分は Codex で上書きしない
- Codex に渡すタスクは「ファイル編集のみ」に限定（コマンド実行はWorkerが制御）
- Context Pack に CLAUDE.md の要点を**必ず含める**（Codexは自動読込しないため）

---

# 7. Meta Reviewer AI（憲法裁判所）

**Mission**: AI Development Team OS 自身を監査する。

**Model**: **Gemini（Google）**
— Developer AI（Claude）と別プロバイダにすることで相関バイアスを排除する。

## Responsibilities

**Cage Integrity Check**（最優先）
- permissionGuard / fileChangeGuard の弱体化を検出
- Docker Sandbox制限の解除を検出
- CLAUDE.md の権限境界変更を検出

**Security Regression Check**
- AgentPolicy 権限の拡張を検出
- 禁止コマンドのAllowlist追加を検出
- 秘密情報アクセス経路の追加を検出

**Architecture Check**
- MVPスコープ外機能の混入を検出
- 仕様思想との不整合を検出

**Input**
- Git Diff（control repository）
- Changed Files リスト
- 関連仕様書

**Output**: MetaReviewResult（approved / changes_requested / blocked）

**Trigger**: Developer AIのPRマージ前に必ず実行

**Rule**: `blocked` が返った場合、CEO承認なしにマージ不可

---

# 8. Reviewer AI（Project Reviewer）

**Mission**: 品質監査。

## Responsibilities

**Rule Review**
- Rule違反

**Architecture Review**
- Design Philosophy違反
- Decision違反

**Scope Review**
- 過剰実装
- Scope逸脱

**Quality Review**
- 保守性
- 可読性

**Input**
- Context Pack
- Diff

**Output**: Review Report

**Model**: Gemini（メイン）/ Claude（サブ）

---

# 9. QA AI

**Mission**: 品質保証。

## Responsibilities

**Test Validation**
- テスト結果確認

**Regression Analysis**
- 既存機能影響確認

**Risk Analysis**
- 障害リスク
- Rollbackリスク

**Release Readiness**
- デプロイ可能判定

**Input**
- Diff
- Review Report

**Output**: QA Report

---

# 10. Summary Engine

**Mission**: 人間が30秒で現在地を理解できる状態を作る。

## Responsibilities

**Progress Summary**
- 進捗率

**Work Summary**
- 現在作業
- 次作業

**Risk Summary**
- リスク
- 未確定事項

**Decision Summary**
- 承認待ち事項

**Input**
- Roadmap
- Task Graph
- Project Memory
- Review Results
- QA Results

**Output**: Project Summary

---

# 11. Project Summary Format

**表示項目**

```text
Goal
Design Philosophy
Progress
Current Work
Next Work
Risks
Open Decisions
Pending Approvals
```

**表示対象外**

```text
ADR
Feature Knowledge
Rules
Context Pack
Review Report
QA Report
```

---

# 12. Inter-Agent Workflow

## Standard Flow

```text
CTO AI
↓
Context Manager
↓
Developer AI（Claude Code または Codex）
↓  ← 1タスク1プロバイダー原則
Meta Reviewer AI（Gemini API）← PRマージ前・必須
↓ approved のみ通過
Reviewer AI（Gemini）
↓
QA AI
↓
Repository（merge）
↓
Summary Engine
```

## Escalation Flow

以下の場合のみCEOへ通知

- Goal変更
- Design Philosophy変更
- 予算超過
- 外部サービス追加
- 課金発生
- 本番公開
- 個人情報機能追加
- セキュリティモデル変更
- リポジトリ外操作

---

# 13. Authority Principle

## AI Freedom Zone

AIは以下を自由に実行できる

- 実装
- 修正
- リファクタリング
- レビュー
- テスト
- ドキュメント更新
- コミット
- ロールバック

## Human Approval Zone

人間承認必須

- Goal変更
- Design Philosophy変更
- 予算超過
- 外部サービス追加
- 課金発生
- 本番公開
- 個人情報追加
- セキュリティモデル変更
- リポジトリ外操作

---

# 14. Organization Success Criteria

AI組織の成功条件

- CEOはProject Summaryのみ見ればよい
- Goal変更以外で開発が停止しない
- AIが自律的に開発を継続できる
- Context Pack経由で全開発が成立する
- Project Memoryを人間が管理しなくてよい
