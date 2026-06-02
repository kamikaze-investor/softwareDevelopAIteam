# task-006: Backend — Project CRUD API

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-018 ✅（masterマージ後に着手すること）  
**ブランチ**: `ai/task-006`  
**コミット形式**: `[codex task-006] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md` — ワークツリー境界・品質ルール
2. `CLAUDE.md` — 禁止事項
3. `docs/env-notes.md` — pnpm 実行方法
4. `packages/shared/src/types/project.ts` — Project / Approval 型
5. `apps/api/src/storage/interface.ts` — IProjectStorage / IApprovalStorage
6. `apps/api/src/storage/index.ts` — getStorage() の使い方
7. `apps/api/src/index.ts` — route を register する場所

---

## タスクスコープ

**Project の CRUD API と Approval の CRUD API を実装する。**

Task / Job は task-007 / task-008 で行う。今回は触らない。

---

## 実装する API エンドポイント

### Projects

| Method | Path | 処理 |
|---|---|---|
| `GET` | `/api/projects` | 全件取得 |
| `GET` | `/api/projects/:id` | 1件取得 |
| `POST` | `/api/projects` | 新規作成 |
| `PATCH` | `/api/projects/:id` | 更新 |

### Approvals（Project に紐づく）

| Method | Path | 処理 |
|---|---|---|
| `GET` | `/api/projects/:projectId/approvals` | pending 一覧 |
| `POST` | `/api/projects/:projectId/approvals` | 新規作成 |
| `PATCH` | `/api/approvals/:id` | 承認/却下 |

---

## ファイル構成

```
apps/api/src/
  routes/
    projects.ts    ← 新規作成
    approvals.ts   ← 新規作成
  index.ts         ← register 追加のみ
```

---

## 実装指示

### ファイル1: `apps/api/src/routes/projects.ts`（新規作成）

```typescript
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage/index.js'

// ── バリデーションスキーマ ────────────────────────────

const CreateProjectBody = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().min(1),
  designPhilosophy: z.array(z.string()).default([]),
  status: z.enum(['draft', 'running', 'paused', 'archived']).default('draft'),
})

const UpdateProjectBody = z.object({
  name:              z.string().min(1).max(100).optional(),
  goal:              z.string().min(1).optional(),
  designPhilosophy:  z.array(z.string()).optional(),
  status:            z.enum(['draft', 'running', 'paused', 'archived']).optional(),
}).strict()

// ── ルート定義 ────────────────────────────────────────

export async function projectRoutes(app: FastifyInstance) {
  const storage = getStorage()

  // GET /api/projects
  app.get('/', async (_req, reply) => {
    const projects = storage.projects.findAll()
    return reply.send(projects)
  })

  // GET /api/projects/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const project = storage.projects.findById(req.params.id)
    if (!project) return reply.status(404).send({ error: 'Project not found' })
    return reply.send(project)
  })

  // POST /api/projects
  app.post('/', async (req, reply) => {
    const result = CreateProjectBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }
    const project = storage.projects.create(result.data)
    return reply.status(201).send(project)
  })

  // PATCH /api/projects/:id
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const result = UpdateProjectBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }
    const updated = storage.projects.update(req.params.id, result.data)
    if (!updated) return reply.status(404).send({ error: 'Project not found' })
    return reply.send(updated)
  })
}
```

### ファイル2: `apps/api/src/routes/approvals.ts`（新規作成）

```typescript
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage/index.js'

const CreateApprovalBody = z.object({
  title:  z.string().min(1),
  reason: z.string().min(1),
  type:   z.enum([
    'goal_change', 'philosophy_change', 'external_service',
    'billing', 'deployment', 'security', 'dependency_add',
  ]),
})

const UpdateApprovalBody = z.object({
  status:     z.enum(['approved', 'rejected', 'expired']),
  reviewNote: z.string().optional(),
}).strict()

export async function approvalRoutes(app: FastifyInstance) {
  const storage = getStorage()

  // GET /api/projects/:projectId/approvals  (pending のみ)
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/approvals',
    async (req, reply) => {
      const project = storage.projects.findById(req.params.projectId)
      if (!project) return reply.status(404).send({ error: 'Project not found' })
      const approvals = storage.approvals.findPendingByProjectId(req.params.projectId)
      return reply.send(approvals)
    },
  )

  // POST /api/projects/:projectId/approvals
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/approvals',
    async (req, reply) => {
      const project = storage.projects.findById(req.params.projectId)
      if (!project) return reply.status(404).send({ error: 'Project not found' })
      const result = CreateApprovalBody.safeParse(req.body)
      if (!result.success) {
        return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
      }
      const approval = storage.approvals.create({
        ...(result.data as any),
        projectId: req.params.projectId,
        status: 'pending',
      })
      return reply.status(201).send(approval)
    },
  )

  // PATCH /api/approvals/:id  (承認 / 却下)
  app.patch<{ Params: { id: string } }>(
    '/approvals/:id',
    async (req, reply) => {
      const result = UpdateApprovalBody.safeParse(req.body)
      if (!result.success) {
        return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
      }
      const updated = storage.approvals.update(req.params.id, {
        ...result.data,
        reviewedAt: new Date().toISOString(),
      })
      if (!updated) return reply.status(404).send({ error: 'Approval not found' })
      return reply.send(updated)
    },
  )
}
```

### ファイル3: `apps/api/src/index.ts` の修正

以下の2行のコメントアウトを外す（`projectRoutes` と approvals のみ。他はまだ外さない）:

```typescript
import { projectRoutes } from './routes/projects.js'
import { approvalRoutes } from './routes/approvals.js'

// ...

app.register(projectRoutes, { prefix: '/api/projects' })
app.register(approvalRoutes, { prefix: '/api' })
```

**注意**: `taskRoutes` / `jobRoutes` / `dashboardRoutes` のコメントは外さない（別タスク）。

---

## テスト: `apps/api/src/routes/projects.test.ts`（新規作成）

Fastify の inject を使ったインテグレーションテスト。

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { projectRoutes } from './projects.js'
import { resetStorage } from '../storage/index.js'

// テスト用: インメモリDBを使うよう環境変数をセット
process.env.DB_PATH = ':memory:'

function buildApp() {
  const app = Fastify()
  app.register(cors, { origin: true })
  app.register(projectRoutes, { prefix: '/api/projects' })
  return app
}

describe('Project API', () => {
  beforeEach(() => {
    resetStorage()  // テストごとにDBをリセット
  })

  it('GET /api/projects — 空配列を返す', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('POST /api/projects — 作成できる', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      body: { name: 'Test', goal: 'テスト', designPhilosophy: [] },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('Test')
  })

  it('GET /api/projects/:id — 取得できる', async () => {
    const app = buildApp()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/projects',
        body: { name: 'P', goal: 'g', designPhilosophy: [] } })).body
    )
    const res = await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).name).toBe('P')
  })

  it('GET /api/projects/:id — 存在しない場合 404', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/projects/not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH /api/projects/:id — 更新できる', async () => {
    const app = buildApp()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/projects',
        body: { name: 'Old', goal: 'g', designPhilosophy: [] } })).body
    )
    const res = await app.inject({
      method: 'PATCH', url: `/api/projects/${created.id}`,
      body: { name: 'New' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).name).toBe('New')
  })

  it('POST /api/projects — バリデーションエラー (name なし) は 400', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST', url: '/api/projects',
      body: { goal: 'g' },  // name なし
    })
    expect(res.statusCode).toBe(400)
  })
})
```

---

## 注意: `resetStorage()` の挙動

`storage/index.ts` の `resetStorage()` は `_storage = null` にするだけ。  
`DB_PATH = ':memory:'` のとき、`getStorage()` が再度呼ばれると新しいインメモリDBが作られる。  
これによってテストごとにDBがリセットされる。

---

## 完了チェックリスト

```bash
# 型チェック
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'; corepack pnpm --filter @ai-team/api typecheck

# テスト（全パス必須）
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'; corepack pnpm --filter @ai-team/api test
```

変更ファイルは以下5つだけ:
- `apps/api/src/routes/projects.ts`（新規）
- `apps/api/src/routes/approvals.ts`（新規）
- `apps/api/src/routes/projects.test.ts`（新規）
- `apps/api/src/index.ts`（register 追加のみ）

---

## やってはいけないこと

- `storage/` の変更（task-018 で完了済み）
- `packages/shared/` の変更
- `taskRoutes` / `jobRoutes` のコメントアウトを外すこと
- `apps/worker/` / `apps/mobile/` の変更
