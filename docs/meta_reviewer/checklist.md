# Meta Reviewer チェックリスト

差分レビュー時に必ず確認する項目一覧。

---

## チェック1: Cage弱体化

### permissionGuard.ts
- [ ] `ALLOWED_PREFIXES` が削減されていない
- [ ] `FORBIDDEN_PATTERNS` が削減されていない
- [ ] `parseCommand()` のメタ文字チェックが削除されていない
- [ ] `isInsideTargetRoot()` の呼び出しが削除されていない
- [ ] `shell: false` が維持されている（commandResolverで）
- [ ] `AgentPolicy.canExecuteCommands` チェックが削除されていない

### fileChangeGuard.ts
- [ ] `ALWAYS_FORBIDDEN_PATTERNS` が削減されていない
- [ ] `normalizeAndValidateChangedFile()` 呼び出しが削除されていない
- [ ] target-project/配下のみ許可のロジックが維持されている
- [ ] `task.allowedPaths` のチェックが削除されていない

### commandResolver.ts
- [ ] 任意のシェル文字列を実行するパスが追加されていない
- [ ] サニタイズ関数（sanitizeBranchName等）が削除・弱体化されていない
- [ ] 新しいCommandKindが追加される場合、安全なargvのみ生成している

---

## チェック2: Sandbox

### docker-compose.yml
- [ ] Control Repository mount に `:ro` が付いている
- [ ] Target Repository mount は read-write
- [ ] `cap_drop: [ALL]` が維持されている
- [ ] `no-new-privileges: true` が維持されている
- [ ] `working_dir: /workspace/target` が維持されている
- [ ] Docker socketのmountが追加されていない

### Dockerfile
- [ ] root以外のユーザーで実行している（`USER aiworker`）
- [ ] 不要なパッケージが追加されていない（apt-get install）

---

## チェック3: 権限境界

### CLAUDE.md
- [ ] Green Zone / Yellow Zone / Red Zone の内容が変更されていない
- [ ] Repository Boundary（ai-team-backend / target-project）が維持されている
- [ ] 絶対禁止リストから項目が削除されていない

**注意**: routes/ 追加の blocked 判定は「機密情報を返すか」「Guardを迂回するか」で判断する。
通常のCRUD追加は changes_requested / approved で評価する。
「Control Repository への変更」という理由だけで blocked にしない。

### packages/shared/types/agent.ts
- [ ] `reviewer_ai.canExecuteCommands` が false のまま
- [ ] `meta_reviewer.canModifyFiles` が false のまま
- [ ] `reviewer_ai.canModifyFiles` が false のまま
- [ ] `developer_ai.canReadMemory` が false のまま（Context Pack経由のみ）

### packages/shared/types/project.ts
- [ ] `ApprovalType` から `dependency_add` が削除されていない
- [ ] `ApprovalStatus` に `expired` が含まれている

---

## チェック4: コマンド権限

以下のコマンドが新たにAllowlistに追加されていないか確認:
- [ ] `npm install` / `pnpm add` / `pnpm install` （frozen-lockfile以外）
- [ ] `curl` / `wget`
- [ ] `ssh` / `scp` / `rsync`
- [ ] `docker run` / `docker exec`
- [ ] `chmod` / `chown` / `sudo`
- [ ] `systemctl` / `service`
- [ ] `cat ~/.ssh` / `cat /etc/passwd`

---

## チェック5: 仕様思想

### Context First
- [ ] Developer AIがProject Memoryを直接読む実装になっていない
- [ ] Context Packが `docs/context/` に保存される設計が維持されている

### Rollback重視
- [ ] `RollbackInfo.rollbackArgv` がshell文字列でなくargvになっている
- [ ] Jobが失敗した場合のロールバックフローが壊れていない

### 小さく変更
- [ ] 1つのPRが複数の大きな責務を変更していない
- [ ] コミットメッセージが `[task-xxx]` 形式になっている

### MVPスコープ（specs/10_mvp_scope.md参照）
- [ ] MVP除外の機能（Reviewer AI / QA AI 本実装）が追加されていない
- [ ] 複数ユーザー・チーム管理の機能が追加されていない
- [ ] 自動デプロイ・課金機能が追加されていない

---

## 判定サマリー

| チェック項目 | 問題あり | 判定 |
|---|---|---|
| Cage弱体化 | 1件でも | `blocked` |
| Sandbox制限解除 | 1件でも | `blocked` |
| 権限境界変更 | 1件でも | `blocked` + CEO通知 |
| 禁止コマンド追加 | 1件でも | `blocked` |
| 仕様思想逸脱 | 軽微 | `changes_requested` |
| MVPスコープ外 | あり | `changes_requested` |
| 全てクリア | — | `approved` |
