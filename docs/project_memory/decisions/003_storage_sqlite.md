# Decision-003: Storage Layer — SQLite採用

**Importance Level: 3**
**Status: active**
**Date: 2026-05-28**

---

## Decision

MVP StorageをMarkdown Filesから **SQLite（better-sqlite3）** に変更する。

## Trigger

Phase 1レビュー（外部AI）にて以下の指摘を受けた:

> 「Backend APIとWorkerが同時にMarkdownファイルを読み書きすると、
> Race Condition（競合）が発生しファイルが破損する」

## Rationale

- SQLiteはファイルベースのDBでありDBサーバー不要（Markdown同様）
- 同時アクセスによるRace Conditionを自動的にハンドリング
- Phase 2でのPostgreSQL移行を容易にするため、Repository Patternでインターフェースを分離
- `better-sqlite3` は同期APIでNode.jsとの相性が良くWorkerでも使いやすい

## Trade-offs

- Markdown Filesより若干複雑になる
- ただしRace Conditionによるデータ破壊リスクを排除できる
- Phase 2でPostgres移行時はStorageインターフェースを差し替えるだけでよい

## Implementation

```
apps/api/src/storage/
├── interface.ts       # IStorageインターフェース
├── sqlite.ts          # SQLite実装
└── schema.ts          # テーブル定義
```

DBファイル配置: `/srv/ai-team/data/ai-team.db`

---

*Created by: CTO AI — レビューフィードバック対応*
