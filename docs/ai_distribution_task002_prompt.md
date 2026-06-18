# task-002: Raw Input Layer（Markdown → raw_sources DB）

あなたは TypeScript / Node.js のシニアエンジニアです。
以下の仕様に従い、`ai-distribution-engine` の Raw Input Layer を実装してください。

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

## 実装対象

### 1. `apps/engine/src/db/repository.ts`

`better-sqlite3` を使い、`raw_sources` テーブルへの CRUD を提供するリポジトリ。

```typescript
import { RawSource } from '@ai-distribution-engine/shared'
import { EngineDatabase } from './schema.js'

export function createRawSourceRepository(db: EngineDatabase) {
  return {
    insert(source: RawSource): void,
    findById(id: string): RawSource | undefined,
    findAll(): RawSource[],
    deleteById(id: string): void,
  }
}
```

`tags` は JSON 文字列で保存・読み出し時にパース（RawSource には tags がないので不要だが、将来の拡張を考慮してコメント残す）。

### 2. `apps/engine/src/input/markdownReader.ts`

Markdown ファイルを読み込み、`RawSource` を生成する関数。

```typescript
import { RawSource } from '@ai-distribution-engine/shared'

export async function readMarkdownFile(filePath: string): Promise<RawSource>
```

- `id`: `crypto.randomUUID()`
- `sourceType`: `'markdown'`
- `originalText`: ファイルの全文（UTF-8）
- `privacyLevel`: デフォルト `'draft'`
- `createdAt`: `new Date().toISOString()`
- ファイルが存在しない場合は `Error('File not found: ...')` をスローする

### 3. `apps/engine/src/input/markdownReader.test.ts`

vitest でテスト:
- 存在するMarkdownファイルを読み込めること
- `sourceType` が `'markdown'` であること
- `privacyLevel` が `'draft'` であること
- 存在しないファイルは Error をスローすること
- テスト用Markdownは `import.meta.dirname` を使って同ディレクトリの `fixtures/test.md` を参照する

テスト用ファイル `apps/engine/src/input/fixtures/test.md` も作成すること:
```markdown
# テスト思考

これはテスト用のMarkdownファイルです。
```

### 4. `apps/engine/src/db/repository.test.ts`

vitest でテスト（`:memory:` DB 使用）:
- `insert` → `findById` で同じデータが取れること
- `findAll` でリスト取得できること
- `deleteById` で削除されること

---

## 制約

- TypeScript strict mode / ESM (`"type": "module"`)
- `import.meta.dirname` を使う（ESM なので `__dirname` は不可）
- `node:fs/promises` の `readFile` を使う
- テストは vitest

---

## 完了条件

- `pnpm typecheck` がエラーなしで通ること
- `pnpm test` で全テストが通ること（既存の schema.test.ts も含む）
