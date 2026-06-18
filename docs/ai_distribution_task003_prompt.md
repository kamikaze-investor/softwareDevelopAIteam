# task-003: AI Editor Pipeline（raw_sources → Claude API → content_items）

あなたは TypeScript / Node.js のシニアエンジニアです。
以下の仕様に従い、`ai-distribution-engine` の AI Editor Pipeline を実装してください。

作業ディレクトリ: `C:/Users/honka/ai-distribution-engine`

---

## このプロジェクトについて

**Mission**: 1 Thought = N Assets
個人の思考・経験・開発ログを、AIによって複数形式・複数媒体へ展開する。

**絶対ルール:**
- `.env` は絶対に作らない（`.env.example` のみ）
- APIキーは env 変数のみ。コードにハードコード禁止。
- 投稿は必ず人間確認あり（自動投稿禁止）

---

## 既存コードの確認

以下はすでに実装済み:
- `packages/shared/src/types/rawSource.ts` — RawSource 型
- `packages/shared/src/types/contentItem.ts` — ContentItem 型（ContentStatus含む）
- `apps/engine/src/db/schema.ts` — initializeDb（better-sqlite3）
- `apps/engine/src/db/repository.ts` — createRawSourceRepository

---

## 実装対象

### 1. `apps/engine/src/db/contentRepository.ts`

`content_items` テーブルへの CRUD リポジトリ。

```typescript
import { ContentItem } from '@ai-distribution-engine/shared'
import { EngineDatabase } from './schema.js'

export function createContentRepository(db: EngineDatabase) {
  return {
    insert(item: ContentItem): void,
    findById(id: string): ContentItem | undefined,
    findByStatus(status: ContentItem['status']): ContentItem[],
    updateStatus(id: string, status: ContentItem['status']): void,
  }
}
```

- `tags` は JSON 文字列でDBに保存・取得時に `JSON.parse`
- `publishValue` も JSON 文字列でDBに保存・取得時に `JSON.parse`

### 2. `apps/engine/src/editor/aiEditor.ts`

Claude API（`@anthropic-ai/sdk`）を使い、`RawSource` から `ContentItem` を生成する関数。

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { RawSource, ContentItem } from '@ai-distribution-engine/shared'

export async function generateContentFromRawSource(
  rawSource: RawSource,
  client?: Anthropic,  // テスト時に差し替え可能
): Promise<ContentItem>
```

- `client` が undefined の場合は `new Anthropic()` を使う（`ANTHROPIC_API_KEY` env から自動読み込み）
- Claude に送るプロンプト（system + user）:
  - system: 「あなたはコンテンツエディタです。ユーザーの思考・経験を、ブログ記事として整形してください。必ず以下のJSON形式で返してください。」
  - user: rawSource.originalText を渡す
  - 返却 JSON 形式:
    ```json
    {
      "title": "記事タイトル",
      "summary": "記事の要約（1〜2文）",
      "body": "Markdown形式の本文",
      "category": "カテゴリ（例: AI, 開発, 日記）",
      "tags": ["タグ1", "タグ2"],
      "publishValue": { "growth": 70, "trust": 60, "memory": 80, "product": 50 },
      "riskScore": 10
    }
    ```
- Claude からの応答テキストを JSON.parse して ContentItem を組み立てる
- `id`: `crypto.randomUUID()`
- `rawSourceId`: `rawSource.id`
- `status`: `'draft'`
- `createdAt` / `updatedAt`: `new Date().toISOString()`
- JSON パース失敗時は `Error('Failed to parse AI response as JSON: ...')` をスロー
- **モデル**: `claude-haiku-4-5-20251001`（コスト削減のため）
- **max_tokens**: `2048`

### 3. `apps/engine/src/editor/aiEditor.test.ts`

vitest でテスト（Claude API は **モック**する）:

```typescript
import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { generateContentFromRawSource } from './aiEditor.js'
```

モック方法:
```typescript
const mockClient = {
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({...}) }]
    })
  }
} as unknown as Anthropic
```

テスト:
- 正常系: モックClientを渡して ContentItem が正しく生成されること
  - `status` が `'draft'` であること
  - `rawSourceId` が rawSource.id と一致すること
  - `title`, `summary`, `body`, `tags`, `publishValue`, `riskScore` が含まれること
- 異常系: Claude が不正な JSON を返した場合に Error がスローされること

### 4. `apps/engine/src/db/contentRepository.test.ts`

vitest でテスト（`:memory:` DB 使用）:
- `insert` → `findById` で同じデータが取れること（tags/publishValue の JSON 往復含む）
- `findByStatus('draft')` でフィルタできること
- `updateStatus` でステータスが変わること

---

## 依存パッケージ

`apps/engine/package.json` に追加:
```json
"@anthropic-ai/sdk": "^0.52.0"
```

`pnpm install` を実行すること。

---

## 制約

- TypeScript strict mode / ESM (`"type": "module"`)
- `import.meta.dirname` を使う（`__dirname` は ESM 不可）
- テストは vitest
- 実際の Claude API は呼ばない（テストはモック必須）

---

## 完了条件

- `pnpm install` が通ること
- `pnpm typecheck` がエラーなしで通ること
- `pnpm test` で全テストが通ること（既存テスト含む）
