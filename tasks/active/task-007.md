# task-007: Backend — Task CRUD API

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-006（PR #1 が master にマージ済みであること）  
**ブランチ**: `ai/task-007`（master から作成すること）  
**コミット形式**: `[codex task-007] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md` — 自律修正ループ・トリアージ戦略・品質ルール
2. `CLAUDE.md` — 禁止事項
3. `docs/env-notes.md` — pnpm 実行方法・gh CLI 認証
4. `apps/api/src/storage/interface.ts` — ITaskStorage の確認
5. `apps/api/src/routes/projects.ts` — 実装パターンの参考
6. `packages/shared/src/types/task.ts` — Task 型の確認
7. `packages/shared/src/types/agent.ts` — AgentRole の確認
8. `packages/shared/src/types/ai_cli.ts` — AiCliProvider の確認

---

## フェーズ 1: PR #1 の完了確認

```bash
# 現在の PR #1 のチェック状況を確認
gh pr checks 1
```

- **両方 ✅** → CEO にマージを依頼し、マージされるまで待つ
- **CI または Meta Review が ❌** → AGENTS.md §4 の自律修正ループを実行して修正する
- **PR #1 がマージされたら** → `git checkout master && git pull` してフェーズ 2 へ

---

## フェーズ 2: task-007 実装

### ブランチ作成

```bash
git checkout master
git pull origin master
git checkout -b ai/task-007
```

---

## タスクスコープ

**Task の CRUD API のみ実装する。**

Job（task-008）・Dashboard（task-012/013）は触らない。  
`packages/shared/` は触らない。

---

## 実装する API エンドポイント

| Method | Path | 処理 |
|---|---|---|
| `GET` | `/api/tasks?projectId=xxx` | Project に紐づく Task 一覧 |
| `GET` | `/api/tasks/:id` | 1件取得 |
| `POST` | `/api/tasks` | 新規作成 |
| `PATCH` | `/api/tasks/:id` | 更新（status 変更・assignee 変更等） |

---

## ファイル構成

```
apps/api/src/
  routes/
    tasks.ts        ← 新規作成
    tasks.test.ts   ← 新規作成
  index.ts          ← taskRoutes の register 1行追加のみ
```

---

## 実装指示

### ファイル1: `apps/api/src/routes/tasks.ts`（新規作成）

```typescript
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

// ── バリデーションスキーマ ────────────────────────────

const TaskStatusSchema = z.enum(['pending', 'in_progress', 'review', 'done', 'blocked'])

const AgentRoleSchema = z.enum([
  'cto_ai', 'context_manager', 'developer_ai',
  'meta_reviewer', 'reviewer_ai', 'qa_ai',
])

const AiCliProviderSchema = z.enum(['claude_code', 'codex', 'gemini'])

const CreateTaskBody = z.object({
  projectId:          z.string().min(1),
  title:              z.string().min(1).max(200),
  description:        z.string().default(''),
  status:             TaskStatusSchema.default('pending'),
  assignee:           AgentRoleSchema,
  provider:           AiCliProviderSchema.optional(),
  dependencies:       z.array(z.string()).default([]),
  allowedPaths:       z.array(z.string()).optional(),
  forbiddenPaths:     z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  expectedOutputs:    z.array(z.string()).optional(),
})

const UpdateTaskBody = z.object({
  title:              z.string().min(1).max(200).optional(),
  description:        z.string().optional(),
  status:             TaskStatusSchema.optional(),
  assignee:           AgentRoleSchema.optional(),
  provider:           AiCliProviderSchema.optional(),
  dependencies:       z.array(z.string()).optional(),
  allowedPaths:       z.array(z.string()).optional(),
  forbiddenPaths:     z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  expectedOutputs:    z.array(z.string()).optional(),
  branchName:         z.string().optional(),
  commitHash:         z.string().optional(),
}).strict()

const ListQuerySchema = z.object({
  projectId: z.string().min(1),
})

// ── ルート定義 ────────────────────────────────────────

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  // GET /api/tasks?projectId=xxx
  app.get('/', async (req, reply) => {
    const query = ListQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ error: 'projectId is required' })
    }
    const project = storage.projects.findById(query.data.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    return reply.send(storage.tasks.findByProjectId(query.data.projectId))
  })

  // GET /api/tasks/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const task = storage.tasks.findById(req.params.id)
    if (!task) return reply.status(404).send({ error: 'Task not found' })
    return reply.send(task)
  })

  // POST /api/tasks
  app.post('/', async (req, reply) => {
    const result = CreateTaskBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }
    const project = storage.projects.findById(result.data.projectId)
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' })
    }
    const task = storage.tasks.create(result.data)
    return reply.status(201).send(task)
  })

  // PATCH /api/tasks/:id
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateTaskBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }
    const updated = storage.tasks.update(req.params.id, result.data)
    if (!updated) return reply.status(404).send({ error: 'Task not found' })
    return reply.send(updated)
  })
}
```

### ファイル2: `apps/api/src/routes/tasks.test.ts`（新規作成）

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { taskRoutes } from './tasks'
import { projectRoutes } from './projects'
import { resetStorage } from '../storage'

process.env.DB_PATH = ':memory:'

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  return app
}

async function createProject(app: ReturnType<typeof buildApp>) {
  const res = await app.inject({
    method: 'POST', url: '/api/projects',
    body: { name: 'Test', goal: 'テスト', designPhilosophy: [] },
  })
  return JSON.parse(res.body)
}

describe('Task API', () => {
  beforeEach(() => { resetStorage() })

  it('GET /api/tasks — projectId なしは 400', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/tasks' })
    expect(res.statusCode).toBe(400)
  })

  it('GET /api/tasks?projectId=xxx — 存在しない Project は 404', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/tasks?projectId=not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /api/tasks — 作成できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      body: {
        projectId: project.id,
        title: 'Task 1',
        assignee: 'developer_ai',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBeTruthy()
    expect(body.title).toBe('Task 1')
    expect(body.status).toBe('pending')
  })

  it('GET /api/tasks?projectId=xxx — 作成済みタスクを取得できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: project.id, title: 'T1', assignee: 'developer_ai' },
    })
    await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: project.id, title: 'T2', assignee: 'cto_ai' },
    })
    const res = await app.inject({ method: 'GET', url: `/api/tasks?projectId=${project.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(2)
  })

  it('GET /api/tasks/:id — 取得できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: project.id, title: 'T', assignee: 'developer_ai' },
    })).body)
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${created.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('T')
  })

  it('GET /api/tasks/:id — 存在しない場合 404', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/tasks/not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH /api/tasks/:id — status を更新できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: project.id, title: 'T', assignee: 'developer_ai' },
    })).body)
    const res = await app.inject({
      method: 'PATCH', url: `/api/tasks/${created.id}`,
      body: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('in_progress')
  })

  it('PATCH /api/tasks/:id — provider と allowedPaths を更新できる', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: project.id, title: 'T', assignee: 'developer_ai' },
    })).body)
    const res = await app.inject({
      method: 'PATCH', url: `/api/tasks/${created.id}`,
      body: { provider: 'codex', allowedPaths: ['apps/api/src/'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('codex')
    expect(body.allowedPaths).toEqual(['apps/api/src/'])
  })

  it('POST /api/tasks — バリデーションエラー (assignee なし) は 400', async () => {
    const app = buildApp()
    const project = await createProject(app)
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: project.id, title: 'T' },  // assignee なし
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/tasks — 存在しない projectId は 404', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST', url: '/api/tasks',
      body: { projectId: 'not-exist', title: 'T', assignee: 'developer_ai' },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

### ファイル3: `apps/api/src/index.ts` の修正

`taskRoutes` の import と register を追加する。**他の行は変更しない。**

```typescript
// 追加する import（approvalRoutes の下）
import { taskRoutes } from './routes/tasks'

// 追加する register（approvalRoutes の下のコメントアウトを外す）
app.register(taskRoutes, { prefix: '/api/tasks' })
```

---

## 完了チェックリスト

```bash
# 型チェック
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/api typecheck

# テスト（全 Pass 必須）
corepack pnpm --filter @ai-team/api test
```

変更ファイルは以下3つのみ：
- `apps/api/src/routes/tasks.ts`（新規）
- `apps/api/src/routes/tasks.test.ts`（新規）
- `apps/api/src/index.ts`（2行追加のみ）

---

## 完了後の操作

```bash
git add apps/api/src/routes/tasks.ts \
        apps/api/src/routes/tasks.test.ts \
        apps/api/src/index.ts
git commit -m "[codex task-007] feat: Task CRUD API を実装"
git push origin ai/task-007

# PR 作成
gh pr create --base master \
  --title "[codex task-007] feat: Task CRUD API" \
  --body "task-007: Task の CRUD エンドポイントを実装。GET/POST/PATCH。"

# 自律修正ループ開始
gh pr checks <PR番号> --watch
```

---

## やってはいけないこと

- `packages/shared/` の変更
- Job・Dashboard 関連ファイルの変更
- `storage/` の変更（task-018 で完了済み）
- `apps/worker/` / `apps/mobile/` の変更
- `AGENTS.md` / `CLAUDE.md` の変更
