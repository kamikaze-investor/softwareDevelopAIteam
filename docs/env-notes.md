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

---

## 環境インシデント記録

### better-sqlite3 native binding missing due to pnpm build approval configuration

**発生日**: 2026-07-02

**症状**:
- Codexが `pnpm --filter` / typecheck / test 系のコマンドを実行するたびに、`better-sqlite3` の native binding が失われるように見えた
- `better_sqlite3.node` が見つからず、SQLite関連テストが大量失敗した
- API側SQLiteテスト約193件が失敗する状態になった
- `node-gyp rebuild` により一時復旧できたが、pnpm実行後に再発した

**影響**:
- コード変更とは無関係にテストが大量失敗した
- AIがコード変更由来のバグと誤認するリスクがあった
- AIチームOSの自動検証結果の信頼性に影響した
- 今後のCodex/Claudeによる実装検証で、同じ誤判定が起きる可能性があった

**原因**:
- `pnpm-workspace.yaml` の `allowBuilds` 設定内に、不正なプレースホルダーが残っていた
- 具体的には以下のような値が残っていた
  ```yaml
  node-pty: set this to true or false
  ```
- pnpm 11.8.0 では `allowBuilds` が build script 承認設定として使われる
- `node-pty` の値が true/false ではなく文字列だったため、`allowBuilds` マップ全体の解析や承認状態に悪影響を与え、`better-sqlite3: true` も正常に効いていなかった可能性が高い

**誤った初期仮説**:
- 当初は `allowBuilds` 自体が誤った設定で、`onlyBuiltDependencies` に置き換えるべきだと推測した
- しかし `pnpm install` 実行時に pnpm 自身が `allowBuilds` スキャフォールドを自動生成したため、pnpm 11.8.0 では `allowBuilds` が正しい形式だと判明した
- 最終的に、問題は `allowBuilds` そのものではなく、`node-pty` の不正なプレースホルダー値だったと判断した

**恒久対応**:
`pnpm-workspace.yaml` を以下の形に修正した。
```yaml
allowBuilds:
  better-sqlite3: true
  esbuild: true
  node-pty: false
```
意味:
- `better-sqlite3`: native buildを許可
- `esbuild`: buildを許可
- `node-pty`: 必要性未確認のため今回は許可せず false

**修正コミット**: `bbac4d2` — fix: configure pnpm native build approvals

**検証結果**:
- `pnpm install`: PASS
- `better-sqlite3` binding生成: PASS（`build/Release/better_sqlite3.node` が生成された）
- worker typecheck: PASS
- shared typecheck: PASS
- all tests: 721/721 PASS
- `pnpm-lock.yaml` 差分なし
- package.json差分なし
- AI Approval Level v2関連コード変更なし
- jobRunner.ts変更なし
- guards変更なし
- Meta Review関連変更なし
- postTestHook.ps1変更なし

**一時復旧方法**:
同様の症状が出た場合、一時的には以下で復旧できる可能性がある。
```
node-gyp rebuild --directory=node_modules/.pnpm/better-sqlite3@<version>/node_modules/better-sqlite3
```
ただし、これは恒久対応ではない。pnpmのbuild approval設定が壊れている場合、`pnpm install` / `pnpm --filter` 実行後に再発する可能性がある。

**今後同じエラーが出た場合の扱い**:
以下のエラーが出た場合:
```
Could not locate the bindings file
better_sqlite3.node
```
まずコードバグではなく、環境・native dependency・pnpm build approval問題として切り分けること。

確認項目:
- `pnpm-workspace.yaml` の `allowBuilds` が正しいか
- `better-sqlite3: true` があるか
- `node-pty` などに true/false 以外の値が混ざっていないか
- `build/Release/better_sqlite3.node` が存在するか
- `pnpm-lock.yaml` に不要な差分が出ていないか

**AIチームOSへの教訓**:
- テスト大量失敗は必ずしもコード変更が原因とは限らない
- native dependency系エラーは環境インシデントとして分類する必要がある
- AIはテスト失敗時に、コード変更由来・環境由来・依存関係由来を切り分けるべき
- 状態変更コマンドはCEO承認を得てから実行する
- package.json / pnpm-lock.yaml / workspace設定の変更は、AI Approval Level上でも注意対象にする
