# task-001-fix: schema.ts エラーハンドリング追加

作業ディレクトリ: `C:/Users/honka/ai-distribution-engine`

## 修正対象

`apps/engine/src/db/schema.ts` の `initializeDb` 関数に、以下のエラーハンドリングを追加してください。

### 現在の実装（問題あり）

```typescript
export function initializeDb(dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH): EngineDatabase {
  ensureDbDirectory(dbPath)
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}

function ensureDbDirectory(dbPath: string): void {
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return
  mkdirSync(dirname(resolve(dbPath)), { recursive: true })
}
```

### 修正内容

1. `ensureDbDirectory` が失敗した場合に、原因を示すエラーメッセージを付けてスロー
2. `new Database(dbPath)` が失敗した場合も同様

修正後のイメージ:

```typescript
export function initializeDb(dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH): EngineDatabase {
  ensureDbDirectory(dbPath)

  let db: EngineDatabase
  try {
    db = new Database(dbPath)
  } catch (cause) {
    throw new Error(`Failed to open database at "${dbPath}"`, { cause })
  }

  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}

function ensureDbDirectory(dbPath: string): void {
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return
  try {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  } catch (cause) {
    throw new Error(`Failed to create database directory for "${dbPath}"`, { cause })
  }
}
```

## テスト追加

`apps/engine/src/db/schema.test.ts` に以下のテストを追加してください（既存テストは壊さないこと）:

```typescript
it('throws a descriptive error when given an invalid path', () => {
  // 書き込み不可能なパスを渡す（例: NULバイトを含むパス）
  expect(() => initializeDb('\0invalid')).toThrow('Failed to')
})
```

## 制約

- 既存テスト（3件）が引き続き通ること
- TypeScript strict mode / ESM

## 完了条件

- `pnpm test` で全テストが通ること
- `pnpm typecheck` がエラーなしで通ること
