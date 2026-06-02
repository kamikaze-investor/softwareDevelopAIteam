# Session Log

Worker が各 Job 完了時に自動追記する。**追記のみ。過去エントリは絶対に編集しない。**

フォーマット:
```
YYYY-MM-DD HH:MM JST [provider task-xxx] 完了内容 / 次のステップ
```

---

## Read Markers

各エージェントが「最後に読んだエントリ」を記録するテーブル。
Worker がセッション開始時に自動更新する。

| Agent | Last read entry |
|---|---|
| claude_code | (初回参加時に全エントリを読み、ここを更新) |
| codex | (初回参加時に全エントリを読み、ここを更新) |

---

## Log

<!-- Worker が以下に追記する -->
2026-05-30 JST [human] AGENTS.md 作成・Codex環境整備・session-log.md 初期化
