# task-018: SQLite Storage 完全実装

**担当**: Codex  
**設計**: Claude Code  
**ブランチ**: `ai/task-018`  
**コミット形式**: `[codex task-018] fix: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md` — ワークツリー境界・品質ルール・コミット規約
2. `CLAUDE.md` — 禁止事項・Repository Boundary
3. `packages/shared/src/types/job.ts` — Job型の最新定義（後述の修正の根拠）
4. `packages/shared/src/types/task.ts` — Task型の最新定義
5. `apps/api/src/storage/interface.ts` — IStorage インターフェース
6. `apps/api/src/storage/schema.ts` — 現在のDBスキーマ（ここを修正する）
7. `apps/api/src/storage/sqlite.ts` — 現在の実装（ここを修正する）

---

## このリポジトリのルール（重要）

- **触れるのは `/workspace/target` 配下のみ**。このリポジトリ（`/workspace/control`）は読み取りのみ。
- **今回のタスクスコープは `apps/api/src/storage/` だけ**。routes・worker・mobile は触らない。
- `packages/shared/` の型定義は絶対に変更しない（読み取りのみ）。
- `apps/api/src/index.ts` は storage の初期化追加のみ（routes のコメントアウトは外さない）。

---

## 背景・問題

現在の `sqlite.ts` は **古い Job 型**で実装されている。  
Job 型は `command: string` から `safeCommand: SafeCommand` + `agentRole: AgentRole` に更新済みだが、  
storage 実装がまだ追従していない。このタスクでその不整合を修正する。

### 具体的な問題箇所

| ファイル | 問題 |
|---|---|
| `schema.ts` | `jobs.command TEXT` が残存。新フィールドが未定義 |
| `schema.ts` | `tasks` に `provider`, `allowed_paths` 等が未定義 |
| `sqlite.ts` | `jobs.create()` が `job.command` を参照（存在しない） |
| `sqlite.ts` | `deserializeJob()` が古いフィールドを返している |
| `sqlite.ts` | `deserializeTask()` が新フィールドを返していない |
| `storage/index.ts` | 存在しない（Storage singleton がない） |
| `sqlite.test.ts` | 存在しない（テストがない） |

---

## 実装指示

### ファイル1: `apps/api/src/storage/schema.ts` を修正

`CREATE_TABLES` の SQL を以下に完全置換する。

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  design_philosophy TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  assignee TEXT NOT NULL DEFAULT 'cto_ai',
  provider TEXT,
  dependencies TEXT NOT NULL DEFAULT '[]',
  allowed_paths TEXT NOT NULL DEFAULT '[]',
  forbidden_paths TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  expected_outputs TEXT NOT NULL DEFAULT '[]',
  branch_name TEXT,
  commit_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_role TEXT NOT NULL DEFAULT 'developer_ai',
  status TEXT NOT NULL DEFAULT 'queued',
  safe_command TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  changed_files TEXT NOT NULL DEFAULT '[]',
  commit_hash TEXT,
  rollback_info TEXT,
  guard_result TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

また、既存DBとの後方互換のために `MIGRATION_STATEMENTS` を追加する:

```typescript
/**
 * 既存DBへのカラム追加マイグレーション
 * CREATE TABLE IF NOT EXISTS は既存テーブルを変更しないため、
 * カラム追加は別途 ALTER TABLE で行う
 */
export const MIGRATION_STATEMENTS: Array<{ table: string; column: string; definition: string }> = [
  { table: 'tasks', column: 'provider',            definition: 'TEXT' },
  { table: 'tasks', column: 'allowed_paths',        definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'tasks', column: 'forbidden_paths',      definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'tasks', column: 'acceptance_criteria',  definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'tasks', column: 'expected_outputs',     definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'jobs',  column: 'agent_role',           definition: "TEXT NOT NULL DEFAULT 'developer_ai'" },
  { table: 'jobs',  column: 'safe_command',         definition: 'TEXT' },
  { table: 'jobs',  column: 'dry_run',              definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs',  column: 'guard_result',         definition: 'TEXT' },
  { table: 'jobs',  column: 'approval_id',          definition: 'TEXT' },
]
```

---

### ファイル2: `apps/api/src/storage/sqlite.ts` を修正

以下の点を変更する。変更箇所以外は触らない。

#### 2-1. import に `MIGRATION_STATEMENTS` を追加

```typescript
import { CREATE_TABLES, MIGRATION_STATEMENTS } from './schema.js'
```

#### 2-2. DB初期化後にマイグレーションを実行

`createSQLiteStorage` の先頭、`db.exec(CREATE_TABLES)` の直後に追加:

```typescript
db.exec(CREATE_TABLES)
runMigrations(db)  // ← 追加
```

関数を末尾に追加:

```typescript
function runMigrations(db: Database.Database): void {
  for (const { table, column, definition } of MIGRATION_STATEMENTS) {
    const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .map(c => c.name)
    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }
}
```

#### 2-3. `jobs.create()` を修正

`INSERT` 文と `.run()` 呼び出しを以下に置換する:

```typescript
create(data) {
  const job: Job = { ...data, id: randomUUID(), createdAt: now() }
  db.prepare(`
    INSERT INTO jobs
      (id, task_id, project_id, agent_role, status, safe_command, dry_run, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.taskId,
    job.projectId,
    job.agentRole,
    job.status,
    JSON.stringify(job.safeCommand),
    job.dryRun ? 1 : 0,
    job.createdAt,
  )
  return job
},
```

#### 2-4. `jobs.update()` を修正

UPDATE 文と `.run()` を以下に置換する:

```typescript
update(id, data) {
  const existing = jobs.findById(id)
  if (!existing) return undefined
  const updated = { ...existing, ...data }
  db.prepare(`
    UPDATE jobs SET
      status=?, started_at=?, completed_at=?, exit_code=?,
      stdout=?, stderr=?, changed_files=?, commit_hash=?,
      rollback_info=?, guard_result=?, approval_id=?
    WHERE id=?
  `).run(
    updated.status,
    updated.startedAt ?? null,
    updated.completedAt ?? null,
    updated.exitCode ?? null,
    updated.stdout ?? null,
    updated.stderr ?? null,
    JSON.stringify(updated.changedFiles ?? []),
    updated.commitHash ?? null,
    updated.rollbackInfo ? JSON.stringify(updated.rollbackInfo) : null,
    updated.guardResult ? JSON.stringify(updated.guardResult) : null,
    updated.approvalId ?? null,
    id,
  )
  return updated
},
```

#### 2-5. `deserializeTask()` を修正

```typescript
function deserializeTask(row: any): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    provider: row.provider ?? undefined,
    dependencies: JSON.parse(row.dependencies),
    allowedPaths: JSON.parse(row.allowed_paths ?? '[]'),
    forbiddenPaths: JSON.parse(row.forbidden_paths ?? '[]'),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria ?? '[]'),
    expectedOutputs: JSON.parse(row.expected_outputs ?? '[]'),
    branchName: row.branch_name ?? undefined,
    commitHash: row.commit_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
```

#### 2-6. `deserializeJob()` を修正

```typescript
function deserializeJob(row: any): Job {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    agentRole: row.agent_role,
    status: row.status,
    safeCommand: JSON.parse(row.safe_command),
    dryRun: row.dry_run === 1 ? true : undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    stdout: row.stdout ?? undefined,
    stderr: row.stderr ?? undefined,
    changedFiles: JSON.parse(row.changed_files ?? '[]'),
    commitHash: row.commit_hash ?? undefined,
    rollbackInfo: row.rollback_info ? JSON.parse(row.rollback_info) : undefined,
    guardResult: row.guard_result ? JSON.parse(row.guard_result) : undefined,
    approvalId: row.approval_id ?? undefined,
    createdAt: row.created_at,
  }
}
```

---

### ファイル3: `apps/api/src/storage/index.ts` を新規作成

```typescript
/**
 * Storage Singleton
 * アプリ全体で同一のDB接続を使う
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { createSQLiteStorage } from './sqlite.js'
import type { IStorage } from './interface.js'

const DB_PATH = process.env.DB_PATH
  ?? path.resolve(process.cwd(), 'data', 'ai-team.db')

let _storage: IStorage | null = null

export function getStorage(): IStorage {
  if (!_storage) {
    // DB ディレクトリが存在しない場合は作成する
    mkdirSync(path.dirname(DB_PATH), { recursive: true })
    _storage = createSQLiteStorage(DB_PATH)
  }
  return _storage
}

/** テスト用: インスタンスをリセットする */
export function resetStorage(): void {
  _storage = null
}
```

---

### ファイル4: `apps/api/src/index.ts` を修正（最小限）

既存コードに1行だけ追加する。  
`app.register(cors, ...)` の直後に追加:

```typescript
// Storage を起動時に初期化する（DBファイルの作成・マイグレーション実行）
import { getStorage } from './storage/index.js'
getStorage()
```

**それ以外は変更しない。** コメントアウトされているroutesのコメントは外さない。

---

### ファイル5: `apps/api/src/storage/sqlite.test.ts` を新規作成

```typescript
/**
 * SQLite Storage テスト
 * インメモリDBを使用（ファイルI/O不要）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createSQLiteStorage } from './sqlite.js'
import type { IStorage } from './interface.js'

describe('SQLiteStorage', () => {
  let storage: IStorage

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
  })

  // ── Project ────────────────────────────────────────────

  describe('projects', () => {
    it('create して findById できる', () => {
      const p = storage.projects.create({
        name: 'Test Project',
        goal: 'テスト用',
        designPhilosophy: [],
        status: 'draft',
      })
      expect(p.id).toBeTruthy()
      const found = storage.projects.findById(p.id)
      expect(found?.name).toBe('Test Project')
    })

    it('findAll が全件返す', () => {
      storage.projects.create({ name: 'A', goal: 'a', designPhilosophy: [], status: 'draft' })
      storage.projects.create({ name: 'B', goal: 'b', designPhilosophy: [], status: 'draft' })
      expect(storage.projects.findAll().length).toBe(2)
    })

    it('update が反映される', () => {
      const p = storage.projects.create({ name: 'Old', goal: 'x', designPhilosophy: [], status: 'draft' })
      const updated = storage.projects.update(p.id, { name: 'New' })
      expect(updated?.name).toBe('New')
      expect(storage.projects.findById(p.id)?.name).toBe('New')
    })

    it('存在しない id の update は undefined を返す', () => {
      expect(storage.projects.update('not-exist', { name: 'x' })).toBeUndefined()
    })
  })

  // ── Task ──────────────────────────────────────────────

  describe('tasks', () => {
    let projectId: string

    beforeEach(() => {
      projectId = storage.projects.create({
        name: 'P', goal: 'g', designPhilosophy: [], status: 'draft',
      }).id
    })

    it('create して findByProjectId できる', () => {
      storage.tasks.create({
        projectId,
        title: 'Task 1',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        dependencies: [],
      })
      const tasks = storage.tasks.findByProjectId(projectId)
      expect(tasks.length).toBe(1)
      expect(tasks[0].title).toBe('Task 1')
    })

    it('provider / allowedPaths がシリアライズ・デシリアライズできる', () => {
      const t = storage.tasks.create({
        projectId,
        title: 'T',
        description: '',
        status: 'pending',
        assignee: 'developer_ai',
        provider: 'codex',
        allowedPaths: ['src/'],
        dependencies: [],
      })
      const found = storage.tasks.findById(t.id)
      expect(found?.provider).toBe('codex')
      expect(found?.allowedPaths).toEqual(['src/'])
    })
  })

  // ── Job ───────────────────────────────────────────────

  describe('jobs', () => {
    let projectId: string
    let taskId: string

    beforeEach(() => {
      projectId = storage.projects.create({
        name: 'P', goal: 'g', designPhilosophy: [], status: 'draft',
      }).id
      taskId = storage.tasks.create({
        projectId, title: 'T', description: '', status: 'pending',
        assignee: 'developer_ai', dependencies: [],
      }).id
    })

    it('create して findByTaskId できる', () => {
      storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })
      const jobs = storage.jobs.findByTaskId(taskId)
      expect(jobs.length).toBe(1)
      expect(jobs[0].safeCommand.kind).toBe('git_status')
    })

    it('safeCommand が JSON シリアライズ・デシリアライズできる', () => {
      const j = storage.jobs.create({
        taskId,
        projectId,
        agentRole: 'developer_ai',
        status: 'queued',
        safeCommand: {
          kind: 'git_commit',
          params: { commitMessage: 'test commit', agentPrefix: '[codex task-018]' },
          workingDir: '/workspace/target',
        },
      })
      const found = storage.jobs.findById(j.id)
      expect(found?.safeCommand.kind).toBe('git_commit')
      expect(found?.safeCommand.params?.commitMessage).toBe('test commit')
    })

    it('update で status・exitCode が更新される', () => {
      const j = storage.jobs.create({
        taskId, projectId, agentRole: 'developer_ai', status: 'queued',
        safeCommand: { kind: 'git_status', workingDir: '/workspace/target' },
      })
      storage.jobs.update(j.id, { status: 'success', exitCode: 0 })
      expect(storage.jobs.findById(j.id)?.status).toBe('success')
      expect(storage.jobs.findById(j.id)?.exitCode).toBe(0)
    })
  })

  // ── Approval ──────────────────────────────────────────

  describe('approvals', () => {
    let projectId: string

    beforeEach(() => {
      projectId = storage.projects.create({
        name: 'P', goal: 'g', designPhilosophy: [], status: 'draft',
      }).id
    })

    it('create して findPendingByProjectId できる', () => {
      storage.approvals.create({
        projectId,
        title: '外部サービス追加',
        reason: 'Stripe を追加したい',
        type: 'external_service_add',
        status: 'pending',
      } as any)
      const pending = storage.approvals.findPendingByProjectId(projectId)
      expect(pending.length).toBe(1)
    })

    it('approve 後は pending に含まれない', () => {
      const a = storage.approvals.create({
        projectId,
        title: 'test',
        reason: 'r',
        type: 'external_service_add',
        status: 'pending',
      } as any)
      storage.approvals.update(a.id, { status: 'approved' })
      expect(storage.approvals.findPendingByProjectId(projectId).length).toBe(0)
    })
  })
})
```

---

## 完了チェックリスト

実装が終わったら以下を順番に確認する:

```bash
# 1. 型チェック（エラーゼロが必須）
pnpm --filter @ai-team/api typecheck

# 2. テスト（全パスが必須）
pnpm --filter @ai-team/api test

# 3. 変更ファイルの確認
git diff --name-only HEAD
```

以下の5ファイルだけが変更されていること:
- `apps/api/src/storage/schema.ts`
- `apps/api/src/storage/sqlite.ts`
- `apps/api/src/storage/index.ts`（新規）
- `apps/api/src/storage/sqlite.test.ts`（新規）
- `apps/api/src/index.ts`（1行追加のみ）

---

## 完了後のコミット

```bash
git checkout -b ai/task-018
git add apps/api/src/storage/schema.ts \
        apps/api/src/storage/sqlite.ts \
        apps/api/src/storage/index.ts \
        apps/api/src/storage/sqlite.test.ts \
        apps/api/src/index.ts
git commit -m "[codex task-018] fix: SQLite storage を最新 Job/Task 型に合わせて修正"
git push origin ai/task-018
```

コミット後、コミットハッシュとブランチ名を報告すること。

---

## やってはいけないこと

- `packages/shared/` の変更（型定義は読み取りのみ）
- `apps/api/src/index.ts` の routes コメントアウトを外すこと（別タスク）
- `apps/worker/` の変更（別タスク）
- `apps/mobile/` の変更（別タスク）
- `AGENTS.md` / `CLAUDE.md` の変更
- `.env` の変更
