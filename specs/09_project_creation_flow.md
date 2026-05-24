# AI Development Team OS
## Project Creation Flow Detailed Design v1.0

---

# 1. Purpose

本ドキュメントは 新規プロジェクト作成フローを定義する。

本システムでは ユーザーは アプリ内で要件定義を行わない。

要件定義は ChatGPT / Claude / Gemini などで行う。

本システムは 完成した仕様書を受け取り AI開発チームを起動する。

---

# 2. Core Philosophy

## Specification First

本システムはアイデア管理ツールではない。

**対象**: ある程度仕様が固まったプロジェクト

**対象外**: 思いつき / 雑談 / アイデア出し

---

# 3. Project Creation Flow

```text
Specification Input
↓
Specification Analysis
↓
Gap Analysis
↓
Project Readiness Review
↓
Project Approval
↓
AI Team Initialization
↓
Development Start
```

---

# 4. Step 1: Specification Input

**Purpose**: プロジェクト概要を取得する。

**Input Method**: 自由入力のみ。

**許可**
```text
Markdown / 箇条書き / 要件定義書 / ChatGPT出力 / Claude出力 / Gemini出力
```

**禁止**
```text
固定フォーマット必須
```

**Example**
```text
スマホだけでAI開発できるシステム
CEOはGoalだけ管理
AIが実装を進める
承認は最小
```

---

# 5. Step 2: Specification Analysis

**Purpose**: 仕様書を構造化する。

## Extracted Fields

| フィールド | 内容 |
|---|---|
| Goal | 最終目的 |
| Design Philosophy | 思想 |
| User | 対象ユーザー |
| MVP | 最小完成形 |
| Constraints | 制約 |
| Risks | リスク |
| Required Services | 必要サービス |
| Cost Assumptions | 想定コスト |

---

# 6. Step 3: Gap Analysis

**Purpose**: 不足情報検出

AIは仕様不足を探す。

## Categories

| カテゴリ | 例 |
|---|---|
| Business | 収益化不明 |
| Technical | 認証方式未定 |
| Data | データ取得元不明 |
| Cost | 予算未定 |
| Legal | 利用規約未定 |

---

# 7. Gap Resolution

不足項目ごとに 3つの選択肢を提示。

| オプション | 内容 |
|---|---|
| Option A | 回答する |
| Option B | スキップする |
| Option C | AIに任せる |

AIに任せた場合 → 仮決定として登録。

---

# 8. Step 4: Project Readiness Review

**Purpose**: 開発開始前診断。

## Readiness Categories

| 項目 | 内容 |
|---|---|
| Requirement Clarity | 要件明確度 |
| Technical Feasibility | 技術実現性 |
| Cost Feasibility | 費用実現性 |
| Operational Complexity | 運用難易度 |
| Risk Level | リスク水準 |

---

# 9. Readiness Report

例
```text
Requirement Clarity      88%
Technical Feasibility    95%
Cost Feasibility         90%
Operational Complexity   70%
Overall Readiness        86%
```

---

# 10. Risk Report

表示内容
```text
最大リスク
主要依存関係
未確定事項
```

例
```text
最大リスク: Google OAuth依存
未確定事項: 認証方式
```

---

# 11. Required Services Report

AIは必要サービスを提示する。

例
```text
GitHub / Claude Code / VPS / Google OAuth
```

---

# 12. Cost Report

想定コスト表示。

例

| サービス | コスト |
|---|---|
| Claude | 20ドル/月 |
| VPS | 10ドル/月 |
| 合計 | 30ドル/月 |

---

# 13. Project Approval

CEO確認。

**表示**
```text
Goal / Design Philosophy / MVP / Risks / Cost / Required Services
```

**選択**
```text
開始 / 修正 / 保留
```

---

# 14. AI Team Initialization

承認後実行。

**生成対象**
```text
Project Memory
Roadmap
Task Graph
Initial Decisions
Initial Rules
Initial Feature Knowledge
```

---

# 15. Initial Roadmap Generation

CTO AIが生成。

例
```text
Phase 1: 基盤構築
Phase 2: MVP実装
Phase 3: 改善
```

---

# 16. Initial Task Generation

Task Graph生成。

例
```text
Task-001: Project Setup
Task-002: Dashboard Design
Task-003: Context Engine
```

---

# 17. Initial Memory Generation

Project Memoryへ登録。

**生成対象**
```text
Goal / Design Philosophy / Decision History / Feature Knowledge / Rules
```

---

# 18. Project State

**作成直後の状態**: `Running`

| 状態 | 説明 |
|---|---|
| Draft | 作成中 |
| Running | 稼働中 |
| Paused | 一時停止 |
| Archived | アーカイブ済み |

---

# 19. Failure Modes

| 種別 | 内容 | 対応 |
|---|---|---|
| Under-Specified Project | 仕様不足 | Gap Analysis |
| Over-Specified Project | 細かすぎる仕様 | AI要約 |
| Contradictory Requirements | 矛盾要件 | Conflict Report |

---

# 20. Success Criteria

成功条件

```text
自由入力の仕様書から
AI開発チームを
自動起動できること
```

---

# Most Important Principle

ユーザーは**仕様書を提出する**。

AIは**不足を補い、構造化し、開発可能な状態へ変換する**。
