# task-014: 簡易認証 — API Token

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-008 がマージ済みであること  
**ブランチ**: `ai/task-014`（master から作成）  
**コミット形式**: `[codex task-014] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/env-notes.md`
4. `apps/api/src/index.ts` — 現在の構成確認

---

## フェーズ 1: task-008 の完了確認

```bash
gh pr list --repo kamikaze-investor/softwareDevelopAIteam
gh pr checks <PR番号>
```

両方 ✅ → マージ済みを確認して `git pull origin master` → フェーズ 2 へ

---

## タスクスコープ

**Fastify の preHandler フック として API Token 認証を追加する。**

- `Authorization: Bearer <token>` ヘッダーで認証
- token は環境変数 `API_TOKEN` で設定
- 未設定時は認証スキップ（開発環境用）
- `/health` エンドポイントは認証不要

---

## 実装指示

### ファイル構成

```
apps/api/src/
  auth/
    apiToken.ts      ← 新規作成
    apiToken.test.ts ← 新規作成
  index.ts           ← preHandler フック登録
```

### `apps/api/src/auth/apiToken.ts`

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify'

/**
 * API Token 認証ミドルウェア
 * Authorization: Bearer <token> ヘッダーを検証する
 *
 * API_TOKEN 環境変数が未設定の場合は認証スキップ（開発環境）
 */
export async function apiTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const expectedToken = process.env.API_TOKEN

  // 未設定なら認証スキップ（開発用）
  if (!expectedToken) return

  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Authorization header required' })
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (token !== expectedToken) {
    return reply.status(401).send({ error: 'Invalid token' })
  }
}
```

### `apps/api/src/index.ts` の修正

```typescript
import { apiTokenAuth } from './auth/apiToken'

// app.register(cors, ...) の後、routes の前に追加:
app.addHook('preHandler', async (req, reply) => {
  // /health は認証不要
  if (req.url === '/health') return
  return apiTokenAuth(req, reply)
})
```

### `apps/api/src/auth/apiToken.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { apiTokenAuth } from './apiToken'

function buildApp(token?: string) {
  if (token) process.env.API_TOKEN = token
  const app = Fastify()
  app.register(cors, { origin: true })
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return
    return apiTokenAuth(req, reply)
  })
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/protected', async () => ({ data: 'secret' }))
  return app
}

describe('API Token Auth', () => {
  afterEach(() => { delete process.env.API_TOKEN })

  it('/health は認証なしでアクセスできる', async () => {
    const app = buildApp('secret-token')
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('API_TOKEN 未設定なら全エンドポイントがアクセス可能', async () => {
    const app = buildApp()  // token なし
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(200)
  })

  it('正しい token でアクセスできる', async () => {
    const app = buildApp('my-token')
    const res = await app.inject({
      method: 'GET', url: '/protected',
      headers: { authorization: 'Bearer my-token' }
    })
    expect(res.statusCode).toBe(200)
  })

  it('Authorization ヘッダーなしは 401', async () => {
    const app = buildApp('my-token')
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('間違った token は 401', async () => {
    const app = buildApp('my-token')
    const res = await app.inject({
      method: 'GET', url: '/protected',
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(res.statusCode).toBe(401)
  })
})
```

---

## .env.example への追記

```
# API 認証トークン（未設定 = 認証スキップ、開発用）
API_TOKEN=your_api_token_here
```

---

## 完了チェックリスト

```bash
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/api typecheck
corepack pnpm --filter @ai-team/api test
```

変更ファイル:
- `apps/api/src/auth/apiToken.ts`（新規）
- `apps/api/src/auth/apiToken.test.ts`（新規）
- `apps/api/src/index.ts`（preHandler フック追加）
- `.env.example`（API_TOKEN 追記）

---

## 完了後

```bash
git add apps/api/src/auth/ apps/api/src/index.ts .env.example
git commit -m "[codex task-014] feat: API Token 認証を追加"
git push origin ai/task-014
# PR は Claude Code が作成する（または手動で作成）
```
