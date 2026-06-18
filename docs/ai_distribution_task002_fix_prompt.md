# task-002-fix: repository.ts DB制約エラーのラップ

作業ディレクトリ: `C:/Users/honka/ai-distribution-engine`

## 修正対象

`apps/engine/src/db/repository.ts` の `insert` メソッドで、`better-sqlite3` がスローする DB制約エラー（重複 PRIMARY KEY 等）を意味のあるエラーメッセージでラップしてください。

### 修正内容

`insert` の実装に `try...catch` を追加:

```typescript
insert(source: RawSource): void {
  try {
    stmt.run({ ... })
  } catch (cause) {
    throw new Error(`Failed to insert RawSource with id "${source.id}"`, { cause })
  }
}
```

## テスト追加

`apps/engine/src/db/repository.test.ts` に以下のテストを追加（既存テストは壊さないこと）:

```typescript
it('throws a descriptive error when inserting a duplicate id', () => {
  const source: RawSource = {
    id: 'dup_test',
    sourceType: 'markdown',
    originalText: 'original',
    privacyLevel: 'draft',
    createdAt: new Date().toISOString(),
  }
  repo.insert(source)
  expect(() => repo.insert(source)).toThrow('Failed to insert RawSource')
})
```

## 制約

- 既存テスト（3件）が引き続き通ること
- TypeScript strict mode / ESM

## 完了条件

- `pnpm test` で全テストが通ること
- `pnpm typecheck` がエラーなしで通ること
