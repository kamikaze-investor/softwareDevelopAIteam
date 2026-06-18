# Phase A — Permission Grant System 実装仕様

## 概要

現在の `permissionGuard.ts` は AgentRole の静的ポリシーだけで実行可否を判定している。
Phase A では「時間制限付き・タスクスコープ付きの動的許可グラント」を追加し、
CEO が特定タスクの特定操作を期限付きで事前許可できる仕組みを実装する。

---

## 実装対象

### A-1: PermissionGrant 型（packages/shared）

**ファイル**: `packages/shared/src/types/permission_grant.ts` (新規)

```typescript
export type GrantScope = 'once' | 'task' | 'permanent'

export interface PermissionGrant {
  id: string
  /** 許可対象のタスクID（task スコープ時） */
  taskId?: string
  /** 許可対象のジョブID（once スコープ時） */
  jobId?: string
  /** 許可するコマンド種別（undefined = そのスコープの全コマンド） */
  allowedCommandKinds?: import('./command').CommandKind[]
  /** 許可するエージェントロール */
  agentRole: import('./agent').AgentRole
  /** スコープ: once=1回のみ / task=タスク完了まで / permanent=無期限 */
  scope: GrantScope
  /** 有効期限（ISO 8601）。未設定 = 無期限 */
  expiresAt?: string
  /** CEOが付けたメモ */
  reason?: string
  /** 使用済みか（once スコープで使用後 true になる） */
  used: boolean
  createdAt: string
}

/** jobRunner が返す許可ブロックイベント */
export interface PermissionBlockEvent {
  type: 'grant_expired' | 'grant_not_found' | 'grant_used'
  jobId: string
  taskId: string
  agentRole: string
  commandKind: string
  message: string
  occurredAt: string
}
```

`packages/shared/src/index.ts` に export を追加する。

---

### A-2: permission_grants テーブル（apps/api）

**ファイル**: `apps/api/src/storage/schema.ts` を編集

`CREATE_TABLES` に追加:
```sql
CREATE TABLE IF NOT EXISTS permission_grants (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  job_id TEXT,
  allowed_command_kinds TEXT NOT NULL DEFAULT '[]',
  agent_role TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT,
  reason TEXT,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

`MIGRATION_STATEMENTS` に追加（既存DBへの対応）:
```typescript
// permission_grants は新テーブルなので CREATE TABLE IF NOT EXISTS で対応済み
// ただし既存 DB が起動済みの場合は別途 CREATE を実行する必要があるため
// sqlite.ts の initializeDatabase で CREATE TABLE IF NOT EXISTS を都度実行することで対応
```

---

### A-3: IPermissionGrantStorage インターフェース（apps/api）

**ファイル**: `apps/api/src/storage/interface.ts` を編集

```typescript
import type { PermissionGrant } from '@ai-team/shared'

export interface IPermissionGrantStorage {
  findActiveByTaskId(taskId: string): PermissionGrant[]
  findById(id: string): PermissionGrant | undefined
  create(grant: Omit<PermissionGrant, 'id' | 'createdAt'>): PermissionGrant
  markUsed(id: string): PermissionGrant | undefined
}

// IStorage に追加:
// permissionGrants: IPermissionGrantStorage
```

---

### A-4: SQLite 実装（apps/api）

**ファイル**: `apps/api/src/storage/sqlite.ts` を編集

- `PermissionGrant` の CRUD を実装
- `findActiveByTaskId(taskId)`: scope='task' かつ未使用かつ期限内のグラントを返す
- `markUsed(id)`: `used = 1` に更新

---

### A-5: permission_grants API ルート（apps/api）

**ファイル**: `apps/api/src/routes/permissionGrants.ts` (新規)

```
POST   /api/permission-grants           — グラントを作成（CEO操作）
GET    /api/permission-grants?taskId=   — タスクのグラント一覧
DELETE /api/permission-grants/:id       — グラント削除
```

リクエストボディ (POST):
```typescript
{
  taskId?: string
  jobId?: string
  allowedCommandKinds?: CommandKind[]
  agentRole: AgentRole
  scope: 'once' | 'task' | 'permanent'
  expiresAt?: string  // ISO 8601
  reason?: string
}
```

**ファイル**: `apps/api/src/index.ts` を編集してルートを登録:
```typescript
import { permissionGrantRoutes } from './routes/permissionGrants'
app.register(permissionGrantRoutes, { prefix: '/api' })
```

---

### A-6: permissionGuard.ts の更新（apps/worker）

**ファイル**: `apps/worker/src/guards/permissionGuard.ts` を編集

現在の静的ポリシーチェック（agentRole ベース）に加えて、動的グラントチェックを追加する。

```typescript
// 追加インターフェース
export interface GrantCheckResult {
  grantId?: string
  grantScope?: string
  expiresAt?: string
}

export interface GuardResult {
  allowed: boolean
  reason?: string
  grant?: GrantCheckResult  // 許可されたグラントの情報
  blockEvent?: PermissionBlockEvent  // ブロック時のイベント
}

// 追加関数シグネチャ
export async function permissionGuardWithGrants(
  safeCommand: SafeCommand,
  agentRole: AgentRole,
  taskId: string,
  jobId: string,
  apiBaseUrl: string,  // API から grants を取得
): Promise<GuardResult>
```

判定フロー:
1. 既存の静的ポリシーチェック（agentRole）→ blocked なら即返す
2. API に `GET /api/permission-grants?taskId=taskId` でアクティブグラントを取得
3. commandKind と agentRole が一致するグラントを探す
4. グラントがない → 静的ポリシーのデフォルト判定（現状維持）
5. グラントあり → 有効期限チェック
   - 期限切れ → `PermissionBlockEvent { type: 'grant_expired' }` を返す
   - scope='once' かつ used=true → `{ type: 'grant_used' }` を返す
   - OK → `allowed: true, grant: { grantId, grantScope, expiresAt }`
6. scope='once' で使用後 → `PATCH /api/permission-grants/:id/use` を呼んで markUsed

---

### A-7: jobRunner.ts の更新（apps/worker）

**ファイル**: `apps/worker/src/jobRunner.ts` を編集

1. `runJob` の `permissionGuard` 呼び出しを `permissionGuardWithGrants` に切り替え
2. `JobRunResult` に `permissionBlockEvent?: PermissionBlockEvent` フィールドを追加
3. グラントによるブロック時、`permissionBlockEvent` を結果に含めて返す（ログにも記録）
4. **アトミックジョブ対応**:
   - `safeCommand.kind === 'git_commit' || 'git_revert'` の場合、`JOB_TIMEOUT_MS` を適用しない（`timeout: undefined`）
   - 実行前に `beforeCommitHash = git rev-parse HEAD` を記録
   - 実行後に `afterCommitHash = git rev-parse HEAD` を記録
   - `RollbackInfo` を自動生成して `JobRunResult` に含める

アトミックジョブの判定と実行:
```typescript
const isAtomic = ['git_commit', 'git_revert'].includes(job.safeCommand.kind)

stdout = execFileSync(resolved.argv[0], resolved.argv.slice(1), {
  cwd: job.safeCommand.workingDir,
  shell: false,
  timeout: isAtomic ? undefined : JOB_TIMEOUT_MS,
  encoding: 'utf-8',
})
```

---

## テスト要件

各モジュールに対してユニットテストを書くこと。

### `apps/api/src/routes/permissionGrants.test.ts` (新規)
- POST でグラントが作成される
- GET でタスクのアクティブグラントが返される
- 期限切れグラントは GET で返されない
- DELETE で削除できる

### `apps/worker/src/guards/permissionGuard.test.ts` を更新
- グラントなし → 静的ポリシーに従う
- 有効グラントあり → allowed: true
- 期限切れグラント → blockEvent.type === 'grant_expired'
- once グラントで used=true → blockEvent.type === 'grant_used'

### `apps/worker/src/jobRunner.test.ts` を更新
- git_commit ジョブでタイムアウトなし（timeout=undefined）で実行される
- アトミックジョブで RollbackInfo が生成される
- permissionBlockEvent がブロック時に結果に含まれる

---

## 実装上の注意

- `⚠️ CONTROL REPOSITORY — AI編集禁止` コメントのあるファイルは編集しない
  - ただし本仕様で明示的に「編集する」と指定したファイルは例外
- Worker から API を呼ぶ際の `apiBaseUrl` は環境変数 `API_BASE_URL`（デフォルト: `http://localhost:3000`）から取得する
- `fetch` は Node.js 18+ built-in を使う（追加ライブラリ不要）
- SQLite は better-sqlite3（同期API）を使用しているので非同期にしない
- Worker 側の grant 取得は非同期（fetch）なので `permissionGuardWithGrants` は async
- 既存の `permissionGuard`（同期版）はそのまま残す（後方互換）
- TypeScript strict モード、型エラーゼロで完成させること
- テストは vitest を使用（既存の `*.test.ts` と同じパターン）

---

## 完了条件

- [ ] `pnpm --filter @ai-team/shared typecheck` がエラーなし
- [ ] `pnpm --filter @ai-team/api typecheck` がエラーなし
- [ ] `pnpm --filter @ai-team/worker typecheck` がエラーなし
- [ ] `pnpm --filter @ai-team/api test` が全パス
- [ ] `pnpm --filter @ai-team/worker test` が全パス
- [ ] `pnpm --filter @ai-team/api dev` で API 起動し `POST /api/permission-grants` が 201 を返す
