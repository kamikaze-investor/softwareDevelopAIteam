# Approval Rules — いつCEOに承認を求めるか

**Importance Level: 1**
**Status: active**

---

## CEOの承認が必要（Yellow Zone）

以下の場合のみCEOに通知・承認を求める。

- Goal変更
- Design Philosophy変更
- 外部サービス追加（GitHub以外）
- 有料API / 課金発生
- 本番公開 / ストア公開
- セキュリティモデル変更
- 個人情報機能追加
- リポジトリ外への操作

## 承認不要（Green Zone）

以下はAIが自由に実行してよい。

- 実装 / 修正 / リファクタリング
- テスト / レビュー
- ドキュメント更新
- コミット / ブランチ作成 / ロールバック
- Task作成・更新
- Memory更新

## 承認要求フォーマット

承認を求める場合は必ず以下を含める。

```
理由:
期待効果:
リスク:
コスト:
Rollback可否:
```

---

*Created: 2026-05-28*
