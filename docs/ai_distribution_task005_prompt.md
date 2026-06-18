# task-005: Platform Publisher（ready → 各プラットフォームAPI投稿）

あなたは TypeScript / Node.js のシニアエンジニアです。
以下の仕様に従い、`ai-distribution-engine` の Platform Publisher を実装してください。

作業ディレクトリ: `C:/Users/honka/ai-distribution-engine`

---

## このプロジェクトについて

**絶対ルール:**
- 投稿は必ず人間確認あり（自動投稿禁止）。このモジュールは「人間が approve した後に呼ばれる」前提
- `.env` は絶対に作らない（`.env.example` のみ）
- APIキーは env 変数のみ

---

## 既存コード

- `packages/shared/src/types/platformVersion.ts` — PlatformVersion 型（Platform / PublishStatus）
- `apps/engine/src/db/schema.ts` — initializeDb / platform_versions テーブル済み
- `apps/engine/src/db/contentRepository.ts` — createContentRepository（updateStatus含む）

Platform = 'dev.to' | 'hashnode' | 'qiita' | 'mastodon' | 'astro'
PublishStatus = 'pending' | 'approved' | 'published' | 'failed'

---

## 実装対象

### 1. apps/engine/src/db/platformVersionRepository.ts

platform_versions テーブルへの CRUD。

export function createPlatformVersionRepository(db: EngineDatabase) {
  return {
    insert(version: PlatformVersion): void,
    findById(id: string): PlatformVersion | undefined,
    findByContentId(contentId: string): PlatformVersion[],
    updateStatus(id: string, status: PlatformVersion['status'], publishedUrl?: string): void,
  }
}

updateStatus は status と published_at（publishedなら new Date().toISOString()、それ以外は NULL）と published_url を更新

### 2. apps/engine/src/publisher/platformPublisher.ts

各プラットフォームへの投稿を担う Publisher。実際のHTTPリクエストは行わず、インターフェースだけ定義してモック可能にする。

export type PublishFn = (version: PlatformVersion) => Promise<{ url: string }>
export type PlatformPublishers = Partial<Record<Platform, PublishFn>>

export function createPlatformPublisher(db: EngineDatabase, publishers: PlatformPublishers) {
  return {
    async publish(version: Omit<PlatformVersion, 'id' | 'status' | 'createdAt'>): Promise<PlatformVersion>,
    listVersions(contentId: string): PlatformVersion[],
  }
}

publish の仕様:
- id: crypto.randomUUID()
- status: 初期は 'pending'、成功なら 'published'、失敗なら 'failed'
- createdAt: new Date().toISOString()
- 成功: status='published', publishedUrl を保存し、PlatformVersion を返す
- 失敗: status='failed' を保存し、Error を再スロー
- publisher 未登録の platform は Error('No publisher registered for: <platform>') をスロー

### 3. apps/engine/src/publisher/platformPublisher.test.ts

vitest でテスト（:memory: DB / PublishFn はモック）:
- 正常系: モック PublishFn を渡して投稿成功 → status='published', publishedUrl が設定されること
- 異常系: PublishFn が例外スロー → status='failed' に更新され、エラーが再スローされること
- 異常系: 未登録プラットフォーム → Error('No publisher registered for: ...') がスローされること
- listVersions で contentId に紐づくバージョン一覧が取れること

### 4. apps/engine/src/db/platformVersionRepository.test.ts

vitest でテスト（:memory: DB）:
- insert → findById で同じデータが取れること
- findByContentId でフィルタできること
- updateStatus('published', url) で status/publishedUrl/publishedAt が更新されること

---

## 制約

- TypeScript strict mode / ESM (type: module)
- import.meta.dirname を使う（__dirname は不可）
- テストは vitest / :memory: DB
- 実際のHTTPリクエストは行わない（モックのみ）

---

## 完了条件

- pnpm typecheck がエラーなしで通ること
- pnpm test で全テストが通ること（既存21件 + 新規7件以上）
