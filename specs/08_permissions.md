# AI Development Team OS
## Permissions & Governance Detailed Design v1.0

---

# 1. Purpose

本ドキュメントは AI Development Team OS の権限管理を定義する。

目的は AIの自由度を最大化しながら 重大事故を防ぐことである。

---

# 2. Core Philosophy

## Fundamental Principle

```text
AIはリポジトリ内の王様
人間はリポジトリ境界の門番
```

## Decision Rule

判断基準

```text
Gitで戻せる  →  AI自由
Gitで戻せない  →  人間承認
```

---

# 3. Permission Zones

システムは 3つの権限ゾーンに分かれる。

| ゾーン | 説明 |
|---|---|
| Green Zone | 完全自動実行可能。AI自由。 |
| Yellow Zone | AI提案。人間承認後実行。 |
| Red Zone | 自動禁止。CEOのみ実行可能。 |

---

# 4. Green Zone

AI自由実行領域。

## Task Management
```text
Task作成 / Task更新 / Task削除 / Priority変更 / Roadmap更新
```

## Development
```text
実装 / 修正 / リファクタリング / コード削除 / コード移動
```

## Documentation
```text
ADR生成 / Feature Knowledge生成 / Rule生成 / Lessons Learned生成 / ドキュメント更新
```

## Quality
```text
レビュー / テスト / QA / 静的解析
```

## Repository
```text
ブランチ作成 / コミット / マージ / ロールバック
```

## Memory
```text
Memory更新 / Memory整理 / Memory統合 / Memory Archive
```

---

# 5. Yellow Zone

AI提案領域。実行前にCEO承認が必要。

## Goal Changes
```text
Goal変更
```

## Design Philosophy Changes
```text
Design Philosophy変更
```

## Cost Impact
```text
予算超過 / 有料プラン追加 / 月額費用増加
```

## External Dependencies
```text
外部サービス追加 / 外部API追加 / 新規SaaS導入
```

## Security Impact
```text
認証方式変更 / 権限モデル変更 / セキュリティ方針変更
```

## Deployment
```text
本番公開 / ストア公開 / 外部ユーザー利用開始
```

---

# 6. Red Zone

CEOのみ可能。

## Business Decisions
```text
事業方針変更 / プロダクト変更 / 収益モデル変更
```

## Financial Decisions
```text
契約締結 / 支払い / 決済
```

## Legal Decisions
```text
利用規約 / プライバシーポリシー / 法的判断
```

---

# 7. Repository Boundary

本システムの最重要境界。

## Inside Repository — AI自由

```text
Code / Tests / Docs / Configs / Project Memory
```

## Outside Repository — 承認必須

```text
外部API / 外部サービス / 課金 / 本番環境 / SNS / メール / 顧客データ
```

---

# 8. Approval Workflow

## Standard Flow

```text
AI
↓
Approval Request
↓
CEO
↓
Approve / Reject
↓
Execution
```

## Approval Object

承認要求には必ず含める。

```text
理由
期待効果
リスク
コスト
Rollback可否
```

---

# 9. Auto-Rejection Rules

以下は承認なし実行禁止。

```text
課金 / 契約 / 個人情報取得 / 本番公開 / 外部データ送信
```

AIは提案のみ可能。

---

# 10. Rollback Authority

AIはロールバック可能。

**条件**: Repository内変更のみ

**対象**
```text
コード / 設定 / ドキュメント / Memory
```

**対象外**
```text
決済 / 公開 / 外部送信 / メール配信
```

---

# 11. Emergency Stop

## Purpose

AI暴走対策。CEOはいつでも `Pause Project` を実行できる。

状態

| 状態 | 説明 |
|---|---|
| Running | 通常稼働 |
| Paused | 一時停止 |
| Maintenance | メンテナンス中 |
| Archived | アーカイブ済み |

**Paused時**
```text
新規Task停止 / 実装停止 / レビュー停止
```

---

# 12. Drift Escalation

以下を検知した場合 CEOへ通知。

| 種別 | 内容 |
|---|---|
| Goal Drift | Goalから逸脱 |
| Philosophy Drift | 思想違反 |
| Scope Explosion | 不要機能増殖 |
| Budget Drift | 予算超過 |

---

# 13. AI Role Permissions

| AI | 可能 | 不可 |
|---|---|---|
| CTO AI | Task管理 / Roadmap管理 / Decision作成 / Memory管理 | Goal変更確定 / 予算確定 |
| Context Manager | 検索 / 要約 / Context Pack生成 | Task変更 / Goal変更 |
| Developer | 実装 / 修正 / リファクタリング | Goal変更 / Design Philosophy変更 |
| Reviewer | レビュー / 違反検出 | コード変更 |
| QA | 品質判定 / リスク判定 | 実装 |

---

# 14. Permission Audit Log

全権限イベントを記録。

**対象**
```text
承認要求 / 承認 / 却下 / ロールバック / 公開操作
```

**保存先**: Project Memory

---

# 15. Governance Metrics

| 指標 | 目標 |
|---|---|
| Unauthorized Action Rate | 0% |
| Approval Accuracy | 95%以上 |
| Rollback Success Rate | 95%以上 |

---

# 16. Success Criteria

成功条件

```text
AIは最大限自由
人間は最小限介入
重大事故は防止
```

---

# Most Important Principle

AIの仕事は **開発を止めないこと**。

人間の仕事は **取り返しのつかない判断だけを行うこと**。
