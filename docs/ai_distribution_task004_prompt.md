# task-004: 手動承認フロー（draft → approve/reject）

あなたは TypeScript / Node.js のシニアエンジニアです。
以下の仕様に従い、`ai-distribution-engine` の手動承認フローを実装してください。

作業ディレクトリ: `C:/Users/honka/ai-distribution-engine`

---

## このプロジェクトについて

**絶対ルール:**
- `.env` は絶対に作らない（`.env.example` のみ）
- 投稿は必ず人間確認あり（自動投稿禁止）
- APIキーは env 変数のみ

---

## 既存コードの確認

すでに実装済み:
- `apps/engine/src/db/schema.ts` — initializeDb
- `apps/engine/src/db/repository.ts` — createRawSourceRepository
- `apps/engine/src/db/contentRepository.ts` — createContentRepository（insert/findById/findByStatus/updateStatus）
- `apps/engine/src/editor/aiEditor.ts` — generateContentFromRawSource
- `apps/engine/src/input/markdownReader.ts` — readMarkdownFile

`ContentStatus` は `'draft' | 'ready' | 'published' | 'rejected'` です。

---

## 実装対象

### 1. `apps/engine/src/approval/approvalService.ts`

承認・却下ロジックを提供するサービス。

```typescript
import { ContentItem } from '@ai-distribution-engine/shared'
import { createContentRepository } from '../db/contentRepository.js'
import { EngineDatabase } from '../db/schema.js'

export function createApprovalService(db: EngineDatabase) {
  return {
    // draft/ready な ContentItem 一覧を返す
    listPendingItems(): ContentItem[],

    // id のアイテムを 'ready' にする（draft→ready のみ許可）
    // draft でなければ Error('Item is not in draft status') をスロー
    approveItem(id: string): ContentItem,

    // id のアイテムを 'rejected' にする（draft→rejected のみ許可）
    // draft でなければ Error('Item is not in draft status') をスロー
    rejectItem(id: string): ContentItem,
  }
}
```

- `approveItem`/`rejectItem` は `findById` でアイテムを取得 → ステータス確認 → `updateStatus` → 更新後の `findById` で返す
- 存在しない id の場合は `Error('Content item not found: <id>')` をスロー

### 2. `apps/engine/src/approval/approvalService.test.ts`

vitest でテスト（`:memory:` DB 使用）:

セットアップ: `initializeDb(':memory:')` → `createContentRepository` → `createApprovalService`

テスト準備として、draft な ContentItem を DB に insert するヘルパーを用意:
```typescript
function insertDraftItem(repo: ReturnType<typeof createContentRepository>, overrides?: Partial<ContentItem>): ContentItem
```

テスト:
- `listPendingItems`: draft アイテムが含まれること
- `approveItem`: draft → ready に変わること
- `approveItem`: ready なアイテムを承認しようとすると Error
- `rejectItem`: draft → rejected に変わること
- `rejectItem`: 存在しない id は Error

### 3. `apps/engine/src/index.ts` の更新（動作確認ログのみ）

既存の `console.log('ai-distribution-engine started')` に加えて、以下のコメントを追加するだけでよい:

```typescript
// Phase 1 modules: markdownReader, rawSourceRepository, contentRepository, aiEditor, approvalService
```

---

## 制約

- TypeScript strict mode / ESM (`"type": "module"`)
- `import.meta.dirname` を使う（`__dirname` は不可）
- テストは vitest / `:memory:` DB

---

## 完了条件

- `pnpm typecheck` がエラーなしで通ること
- `pnpm test` で全テストが通ること（既存14件 + 新規5件以上）
