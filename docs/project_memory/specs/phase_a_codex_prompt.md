# Codex 実装指示 — Phase A: Permission Grant System

## リポジトリ

`C:\Users\honka\softwareDevelopAIteam`（pnpm workspaces monorepo）

```
apps/api/      — Fastify REST API（better-sqlite3）
apps/worker/   — Job Runner（Node.js、AI CLI 呼び出し）
packages/shared/ — 共有型定義（TypeScript）
```

## やること

詳細仕様は `docs/project_memory/specs/phase_a_permission_grant_system.md` を読んで。

要約:
1. **`packages/shared/src/types/permission_grant.ts`** を新規作成し `PermissionGrant` / `PermissionBlockEvent` 型を定義、`index.ts` に export 追加
2. **`apps/api/src/storage/schema.ts`** に `permission_grants` テーブルを追加
3. **`apps/api/src/storage/interface.ts`** に `IPermissionGrantStorage` を追加、`IStorage` に `permissionGrants` フィールドを追加
4. **`apps/api/src/storage/sqlite.ts`** に PermissionGrant の CRUD 実装を追加
5. **`apps/api/src/routes/permissionGrants.ts`** を新規作成（POST/GET/DELETE）
6. **`apps/api/src/index.ts`** にルートを登録
7. **`apps/worker/src/guards/permissionGuard.ts`** に `permissionGuardWithGrants`（async）を追加
8. **`apps/worker/src/jobRunner.ts`** を更新:
   - `permissionGuardWithGrants` に切り替え
   - アトミックジョブ（git_commit/git_revert）のタイムアウト除去
   - アトミックジョブで before/after commit hash と RollbackInfo を自動生成
9. テストを書く（仕様書の「テスト要件」セクション参照）

## 絶対に変えてはいけないファイル

ファイル先頭に `⚠️ CONTROL REPOSITORY — AI編集禁止` と書いてあるファイルは変更禁止。
ただし仕様に「編集する」と明示されているファイルは例外（permissionGuard.ts, jobRunner.ts は編集してよい）。

## 完了条件

```
pnpm --filter @ai-team/shared typecheck  # エラーなし
pnpm --filter @ai-team/api typecheck     # エラーなし
pnpm --filter @ai-team/worker typecheck  # エラーなし
pnpm --filter @ai-team/api test          # 全パス
pnpm --filter @ai-team/worker test       # 全パス
```
