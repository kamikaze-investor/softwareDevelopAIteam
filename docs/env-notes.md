# 環境メモ

開発環境固有の注意事項。セッション開始時に確認すること。

---

## pnpm の実行方法（VPS / Windows）

pnpm が PATH に存在しない環境では `corepack pnpm` 経由で実行する。

```powershell
# 依存チェックのエラーを回避する場合
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'; corepack pnpm --filter @ai-team/api test

# 通常実行
corepack pnpm --filter @ai-team/api typecheck
corepack pnpm --filter @ai-team/worker test
corepack pnpm -r typecheck   # 全パッケージ一括
```

**理由**: pnpm 11 の自動依存チェックが bare `pnpm install` を呼んで失敗する場合がある。

---

## gh CLI の認証設定

`gh pr checks` や `gh pr view` を使うには `gh` の認証が必要。

```powershell
# 方法1: 環境変数で渡す（.envのGITHUB_TOKENをそのまま使う）
$env:GH_TOKEN = $env:GITHUB_TOKEN
gh pr checks 1   # 動作確認

# 方法2: 一度だけログイン（ブラウザ経由）
gh auth login
```

Codex がループ内で `gh` を使う場合は `GH_TOKEN` を環境変数にセットしておく。

---

## タスク着手前のチェックリスト

1. `tasks/active/task-xxx.md` が存在することを確認する
2. 存在しない場合は Claude Code に設計を依頼してから着手する
3. `pnpm typecheck` & `pnpm test` がグリーンの状態から始める

---

## ブランチとマージの流れ

```
Codex が ai/task-xxx ブランチで実装
→ typecheck & test パス
→ PR 作成（GitHub）
→ Meta Reviewer AI (Gemini) が自動レビュー
→ approved → master にマージ
→ 次タスクの設計は master ベースで行う
```

task-018 は Codex 実装済み。master へのマージ後に task-006 に進む。
