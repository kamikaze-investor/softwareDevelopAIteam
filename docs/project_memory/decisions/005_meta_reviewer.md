# Decision-005: Meta Reviewer AI — 憲法裁判所の設置

**Importance Level: 4**
**Status: active**
**Date: 2026-05-28**

---

## Decision

AI Development Team OS に **Meta Reviewer AI** を設置する。
通常のProject Reviewer AIとは目的・対象・判定基準が異なる2階建て構造にする。

| | Meta Reviewer AI | Project Reviewer AI |
|---|---|---|
| 対象 | このOS本体（control repo） | target-project/ |
| 目的 | Cage弱体化を防ぐ | コード品質保証 |
| 実装順 | **Phase 1で先に実装** | Phase 3 |
| blockedトリガー | Guard/Sandbox/権限境界の弱体化 | 重大なバグ・セキュリティ |

## Trigger

外部AIレビューにて以下の指摘を受けた:

> "このプロジェクトには プロジェクト自身を監査するMeta Reviewer AI が必要"
>
> "AI開発チームを作る前に、AI開発チームの憲法裁判所を作る"
>
> "Developer AIが便利さ優先でガードや境界を緩めてしまうリスクがある"

## Rationale

- 通常のReviewer AIはtarget-projectのコードを見る
- しかし **このOSで一番危ないのはAIが自分のガードを弱めること**
- Meta Reviewer AIを先に作ることで、以後の全開発が安全な基盤の上で進む
- `blocked`を使うことでCEO承認なしにGardが弱まることを構造的に防ぐ

## Implementation

```
docs/meta_reviewer/
├── prompt.md       ← Meta Reviewer AIへのシステムプロンプト
└── checklist.md    ← 5カテゴリのチェック項目

apps/worker/src/metaReviewer/
└── runner.ts       ← diff取得・プロンプト構築・結果パース

packages/shared/src/types/
└── meta_review.ts  ← MetaReviewRequest / MetaReviewResult / MetaReviewFinding
```

## 実装順の変更

```
変更前:
  1. 型定義 → 2. Guard → 3. Worker → 4. API → 5. Dashboard

変更後:
  1. 型定義
  2. Meta Reviewer AI仕様（prompt.md / checklist.md）
  3. MetaReview型
  4. Meta Review Runner
  5. Permission Guard（Guardを作ったらすぐMeta Reviewerが監視開始）
  6. File Change Guard
  7. Worker Job実行
  8. Backend API
  9. Dashboard
  10. Project Reviewer AI（Phase 3）
```

---

*Created by: CTO AI — 外部AIレビューフィードバック対応*
