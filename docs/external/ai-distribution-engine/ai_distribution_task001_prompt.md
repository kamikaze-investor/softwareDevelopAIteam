# task-001: ai-distribution-engine プロジェクト骨格セットアップ

あなたは TypeScript / Node.js のシニアエンジニアです。
以下の仕様に従い、`ai-distribution-engine` のプロジェクト骨格を実装してください。

---

## このプロジェクトについて（CLAUDE.md より）

**Mission**: 1 Thought = N Assets
個人の思考・経験・開発ログを、AIによって複数形式・複数媒体へ展開する。

**Tech Stack:**
- Runtime: Node.js / TypeScript
- DB: SQLite（better-sqlite3）
- AI: Claude API（@anthropic-ai/sdk）
- 投稿API: DEV.to / Hashnode / Qiita / Mastodon（Phase 2以降）

**絶対ルール:**
- 投稿は必ず人間確認あり（自動投稿禁止）
- .env にAPIキー。Gitにpushしない。ハードコード禁止。
- 個人情報は公開前にRisk Scoreチェック必須

---

## 実装対象

### ディレクトリ構成

```
ai-distribution-engine/
├── package.json              ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── .gitignore                ← 既存を更新（node_modules, dist, .env, *.db を追加）
├── apps/
│   └── engine/               ← コンテンツ生成・投稿エンジン
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts       ← エントリポイント（起動確認用のみ）
│           ├── db/
│           │   ├── schema.ts  ← SQLiteスキーマ定義・初期化
│           │   └── schema.test.ts
│           └── types.ts       ← ローカル型（必要最小限）
└── packages/
    └── shared/               ← 共有型定義
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts
            └── types/
                ├── rawSource.ts
                ├── contentItem.ts
                └── platformVersion.ts
```

### packages/shared/src/types/rawSource.ts

```typescript
export interface RawSource {
  id: string
  sourceType: 'markdown' | 'chatgpt' | 'voice' | 'github' | 'diary'
  originalText: string
  privacyLevel: 'public' | 'private' | 'draft'
  createdAt: string  // ISO 8601
}
```

### packages/shared/src/types/contentItem.ts

```typescript
export type ContentStatus = 'draft' | 'ready' | 'published' | 'rejected'

export interface ContentItem {
  id: string
  rawSourceId: string
  title: string
  summary: string
  body: string               // Markdown本文
  category: string
  tags: string[]
  status: ContentStatus
  publishValue: {
    growth: number           // 0-100
    trust: number
    memory: number
    product: number
  }
  riskScore: number          // 0-100（高いほどリスク大）
  createdAt: string
  updatedAt: string
}
```

### packages/shared/src/types/platformVersion.ts

```typescript
export type Platform = 'dev.to' | 'hashnode' | 'qiita' | 'mastodon' | 'astro'
export type PublishStatus = 'pending' | 'approved' | 'published' | 'failed'

export interface PlatformVersion {
  id: string
  contentId: string
  platform: Platform
  title: string
  body: string               // 媒体向けに調整済み本文
  language: 'ja' | 'en'
  status: PublishStatus
  publishedUrl?: string
  publishedAt?: string
  createdAt: string
}
```

### apps/engine/src/db/schema.ts

SQLiteテーブルを初期化する関数を実装する。
`better-sqlite3` を使う。DBファイルパスは環境変数 `DB_PATH`（デフォルト: `./data/engine.db`）。

テーブル:
1. `raw_sources` — RawSource の永続化
2. `content_items` — ContentItem の永続化（tags はJSON文字列で保存）
3. `platform_versions` — PlatformVersion の永続化

```typescript
// 使い方
import { initializeDb } from './db/schema.js'
const db = initializeDb()
```

### package.json（root）

```json
{
  "name": "ai-distribution-engine",
  "private": true,
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
```

### .env.example

```
# Claude API
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# DB
DB_PATH=./data/engine.db

# DEV.to（Phase 2）
DEVTO_API_KEY=

# Hashnode（Phase 2）
HASHNODE_API_KEY=

# Qiita（Phase 2）
QIITA_ACCESS_TOKEN=

# Mastodon（Phase 2）
MASTODON_ACCESS_TOKEN=
MASTODON_INSTANCE_URL=
```

---

## テスト要件

`apps/engine/src/db/schema.test.ts` に以下のテストを書く（vitest）:
- `initializeDb()` を呼んでエラーが出ないこと
- 3テーブルが存在すること（sqlite_master で確認）
- 各テーブルに INSERT / SELECT できること（スモークテスト）
- テストDB はメモリDB（`:memory:`）を使うこと

---

## 制約

- TypeScript strict mode
- ESM (`"type": "module"`)
- `pnpm` workspaces
- テストは vitest
- DBファイルは `data/` ディレクトリに作成（.gitignore 済み）
- `src/index.ts` は起動確認ログ（`console.log('ai-distribution-engine started')`）だけでよい
- `.env` は絶対に作らない（`.env.example` のみ）
- `node_modules/`, `dist/`, `.env`, `data/*.db` は .gitignore に追加する

---

## 完了条件

- `pnpm install` が通ること
- `pnpm typecheck` がエラーなしで通ること
- `pnpm test` で schema.test.ts が全テスト通ること
