# AI Development Team OS
## Human Dashboard Detailed Design v1.0

---

# 1. Purpose

Human Dashboard は CEO専用画面である。

本システムは AI開発チームを管理するシステムである。そのためユーザーは開発者ではなく CEOとして振る舞う。

ユーザーは Project Summaryのみ見ればよい。

---

# 2. Dashboard Philosophy

## Core Principle

ユーザーは AI組織の内部を管理しない。

**管理対象**
- Goal
- Design Philosophy
- Direction
- Approvals

のみ。

**原則非表示**
- ADR
- Feature Notes
- Rules
- Context Pack
- Review Reports
- QA Reports
- Commit History

## 30 Second Rule

Dashboardは 30秒以内に プロジェクトの現在地を把握できること。

---

# 3. Dashboard Layout

表示順序

```text
Goal
Design Philosophy
Project Health
Progress
Current Work
Next Work
Risks
Open Decisions
Pending Approvals
AI Commands
```

---

# 4. Goal Section

**Purpose**: プロジェクトの最終目的を確認する。

表示例
```text
Goal
スマホだけでAI開発チームを運営する
```

**特徴**
- 常時表示
- 最上部固定

**変更権限**: CEOのみ

**変更時**: 承認フロー起動

---

# 5. Design Philosophy Section

**Purpose**: プロジェクト思想を確認する。

表示例
```text
スマホ完結
全自動優先
承認最小
Rollback重視
Context重視
```

**特徴**
- 常時表示
- Goal直下

**変更権限**: CEOのみ

---

# 6. Project Health Section

**Purpose**: プロジェクトの健康状態を把握する。

表示例
```text
Overall Health: 91%
```

Health構成

| 指標 | スコア |
|---|---|
| Goal Alignment | 95% |
| Architecture Health | 92% |
| Memory Health | 89% |
| Task Health | 90% |
| Context Health | 88% |

状態分類: `Healthy` / `Warning` / `Critical`

---

# 7. Progress Section

**Purpose**: 進捗確認。

表示例
```text
Progress: 43%
```

内訳

| フェーズ | 進捗 |
|---|---|
| Phase 1 | 100% |
| Phase 2 | 70% |
| Phase 3 | 15% |

Progress算出: Task Graphから自動生成。

---

# 8. Current Work Section

**Purpose**: 現在AIが何をしているか確認する。

表示例
```text
Current Work: Context Engine改善
担当: Developer AI
```

表示数: 1〜3件

---

# 9. Next Work Section

**Purpose**: 次の予定を確認する。

表示例
```text
Next Work
- Dashboard実装
- 認証機能追加
- Memory Health改善
```

生成元: CTO AI

---

# 10. Risks Section

**Purpose**: 重要なリスクを確認する。

**表示条件**: 重大度 Medium以上

表示例
```text
Google OAuth依存          High
Context Pack肥大化        Medium
```

最大表示数: 5件

---

# 11. Open Decisions Section

**Purpose**: 未確定事項確認。

例
```text
認証方式: 未決定
```

状態

| 状態 | 説明 |
|---|---|
| AI検討中 | AIが調査・検討中 |
| AI仮決定 | AIが仮判断済み |
| 要CEO判断 | 人間の判断が必要 |

表示数: 最大10件

---

# 12. Pending Approvals Section

**Purpose**: CEO承認待ち確認。

承認対象
```text
Goal変更
Design Philosophy変更
予算超過
外部サービス追加
課金発生
本番公開
個人情報機能追加
セキュリティモデル変更
リポジトリ外操作
```

表示例
```text
Google OAuth追加
理由: 外部サービス利用
```

---

# 13. AI Commands Section

**Purpose**: CEOがAI組織へ指示する。

例
```text
MVP優先
通知機能後回し
認証を簡略化
スマホUX優先
```

**特徴**: 自然言語入力

**処理**: CTO AIが解釈

**反映先**
- Roadmap
- Task Graph
- Priority

---

# 14. Notifications

## Philosophy

通知を最小化する。

**通知対象**
```text
承認待ち
Critical Risk
Goal Drift
Design Philosophy Drift
```

**通知対象外**
```text
コミット
レビュー完了
軽微な失敗
テスト成功
```

---

# 15. Dashboard Refresh Strategy

リアルタイム更新不要。

更新タイミング

```text
Task完了
Review完了
QA完了
承認発生
重大リスク発生
```

---

# 16. Mobile First Rules

Dashboardは スマホ専用設計。

原則
```text
片手操作
3タップ以内
重要情報優先
詳細は折りたたみ
```

---

# 17. CEO Mode

通常モード。

**表示**
- Goal
- Progress
- Current Work
- Risks

のみ。詳細は隠す。

---

# 18. Deep Dive Mode

必要時のみ展開。

**表示**
- 詳細Task
- 詳細Risk
- 詳細Decision

通常は非表示。

---

# 19. Success Criteria

成功条件

```text
ユーザーが
Project Summaryだけで
現在地 / 問題 / 次の行動
を理解できること
```

---

# Most Important Principle

Human Dashboardは管理画面ではない。

**CEOが AI開発チームを経営するための 経営ダッシュボードである。**
