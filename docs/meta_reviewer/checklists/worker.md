# チェックリスト: apps/worker/src/（guards/ 以外）

対象: `apps/worker/src/` 配下（`guards/` を除く全ファイル）
例: `commandResolver.ts` / `aiCli/` / `metaReviewer/` / `utils/` 等

---

## 🔴 CRITICAL（1件でも違反 → blocked）

- [ ] `shell: true` でコマンドを実行していない（`execFileSync` / `spawnSync` の全呼び出し）
- [ ] `SafeCommand` / `CommandKind` を迂回して任意のコマンド文字列を実行していない
- [ ] `TARGET_ROOT`（`/workspace/target`）外のパスに書き込んでいない
- [ ] `.env` / APIキー / 秘密鍵をプロセス引数・ログ・標準出力に出力していない
- [ ] Control Repository（`/workspace/control`）への書き込みを試みていない

### commandResolver.ts（変更がある場合）
- [ ] `sanitizeBranchName` / `sanitizeCommitMessage` / `sanitizeCommitHash` が削除・弱体化されていない
- [ ] 新しい `CommandKind` が追加される場合、安全な固定 argv のみ生成している

### autoReview.ts / runner.ts（変更がある場合）
- [ ] `blocked` の判定結果を無視するコードが追加されていない
- [ ] Meta Review の結果を改ざんするコードが追加されていない

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] `catch` ブロックでエラーを握りつぶしていない（ログに残している）
- [ ] ハードコードされたパスがない（`TARGET_ROOT` 等の定数を使用）
- [ ] タイムアウト処理がある（長時間実行を防ぐ）
- [ ] Worker が実行する全コマンドに `workingDir` のバリデーションがある

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] 新しい関数にユニットテストがある
- [ ] エラーメッセージが原因を特定しやすい内容になっている
- [ ] 非同期処理の未処理 rejection がない
