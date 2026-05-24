# AI Development Team OS
## Project Memory Detailed Design v1.1

---

# 1. Purpose

Project Memory は AI Development Team OS の長期記憶システムである。

目的は「情報を保存すること」ではない。

本当の目的は AIが長期間にわたって 一貫した意思決定を行えること である。

---

# 2. Core Philosophy

## Memory is for Decisions

Project Memory は記録システムではない。

目的は「保存」ではなく「**判断**」である。

保存対象は将来の判断に影響する情報のみ。

**保存しないもの**
- 一時的な会話
- 実装ログ
- 使い捨ての思考
- 再利用価値のない情報

---

# 3. Memory Architecture

Project Memory は 6層構造で管理する。

## Layer 1: Goal

**役割**: プロジェクトの北極星。

例
```text
スマホだけでAI開発チームを運営する
```

**特徴**
- 最重要
- 最も変更頻度が低い
- 全判断の基準

## Layer 2: Design Philosophy

**役割**: Goalを実現するための思想。

例
```text
スマホ完結
承認最小
全自動優先
Rollback重視
Context重視
```

**特徴**
- 全AIが参照
- 全設計の判断基準

## Layer 3: Decision History

旧ADR。

**役割**: 重要な意思決定の記録。

**保存対象**
- 採用理由
- 不採用理由
- トレードオフ

例
```text
VPS方式採用
理由: スマホ完結を実現するため
```

**保存しないもの**
- 軽微な実装判断
- 一時的な修正

## Layer 4: Feature Knowledge

旧Feature Notes。

**役割**: 機能知識の蓄積。

**保存内容**
- 機能概要
- 制約
- 注意事項
- 将来予定
- 依存関係

例
```text
Authentication / 通知 / 同期 / Context Engine
```

## Layer 5: Operational Knowledge

旧Rules。

**役割**: 運用知識。

**保存内容**
- 開発ルール
- テスト方針
- コミット方針
- 命名規則

例
```text
小さくコミット
テスト必須
Context Pack経由のみ
```

## Layer 6: Lessons Learned

**役割**: 失敗から学ぶ。

**保存内容**
- 障害
- バグ
- 改善点
- 反省点

例
```text
Context Pack肥大化で品質低下
OAuth変更で認証破壊
```

---

# 4. Memory Object Structure

全Memoryは共通形式を持つ。

```json
{
  "id": "",
  "type": "",
  "title": "",
  "summary": "",
  "content": "",
  "importance": 1,
  "status": "active",
  "created_at": "",
  "updated_at": "",
  "tags": [],
  "references": []
}
```

---

# 5. Importance Levels

| Level | 対象 |
|---|---|
| 5 | Goal |
| 4 | Design Philosophy |
| 3 | Decision History |
| 2 | Feature Knowledge |
| 1 | Operational Knowledge / Lessons Learned |

---

# 6. Memory Lifecycle

## Create

- **作成者**: CTO AI
- **作成条件**: 新機能追加 / 重要判断 / 障害発生

## Update

- **更新者**: CTO AI
- **更新条件**: 設計変更 / 方針変更 / 機能変更

## Archive

- **実行者**: CTO AI
- **対象**: 古いDecision / 廃止機能 / 無効Rule

削除は禁止。**Archiveのみ許可。**

---

# 7. Memory Governance

## Purpose

Memory肥大化防止。目的は大量保存ではなく高品質維持。

## Weekly Governance

毎週実施。

**内容**
- 重複検知
- 古い情報検知
- 矛盾検知
- 統合候補生成
- 孤立情報検知

**出力**: Memory Health Report

---

# 8. Drift Detection

## Purpose

Project Drift検知。

**検知対象**

| 種別 | 内容 |
|---|---|
| Goal Drift | 現在の開発がGoalから逸脱 |
| Philosophy Drift | Design Philosophy違反 |
| Architecture Drift | 設計思想との乖離 |
| Scope Drift | 不要機能の増殖 |

**出力**: Drift Report

**重大度**: Low / Medium / High / Critical

---

# 9. Context Feedback Loop

Project Memory は一方向ではない。

```text
Project Memory
↓
Context Engine
↓
Developer
↓
Review
↓
QA
↓
Feedback
↓
Project Memory
```

## Feedback Sources

- Developer
- Reviewer
- QA
- CTO

## Feedback Example

```text
Rule不足
Feature Note不備
Decision不足
Context不足
```

---

# 10. Memory Health Metrics

| 指標 | 説明 | 目標 |
|---|---|---|
| Duplication Score | 重複率 | 5%未満 |
| Conflict Score | 矛盾率 | 0% |
| Stale Score | 古い情報率 | 10%未満 |
| Coverage Score | 機能網羅率 | 95%以上 |
| Retrieval Success Rate | 必要情報取得率 | 90%以上 |

---

# 11. Human Visibility

原則として人間はMemoryを直接管理しない。

**表示対象**: Goal / Design Philosophy のみ

その他は Project Summary経由。

---

# 12. AI Visibility

| AI | 参照範囲 |
|---|---|
| CTO AI | 全参照可能 |
| Context Manager | 全参照可能 |
| Developer | Context Packのみ |
| Reviewer | Context Pack / Operational Knowledge |
| QA | Context Pack / Lessons Learned |

---

# 13. Failure Modes

| 種別 | 内容 | 対策 |
|---|---|---|
| Memory Explosion | 情報過多 | Governance / Archive / 統合 |
| Memory Rot | 情報腐敗 | Drift Detection / 定期更新 |
| Memory Conflict | 矛盾情報 | Conflict Report |
| Memory Gaps | 情報不足 | Coverage Analysis |

---

# 14. Success Criteria

**成功ではないもの**: 大量の情報保存

**成功条件**

```text
必要な情報が
必要な時に
必要なAIへ
正しく届けられること
```

---

# Most Important Principle

Project Memoryは保存システムではない。

**AI組織の判断品質を維持するための知識基盤である。**
