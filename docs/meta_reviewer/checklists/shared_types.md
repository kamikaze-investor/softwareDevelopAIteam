# チェックリスト: packages/shared/src/types/

対象: `packages/shared/src/types/` 配下の全ファイル、`packages/shared/src/index.ts`

---

## 🔴 CRITICAL（1件でも違反 → blocked）

### agent.ts
- [ ] `reviewer_ai.canExecuteCommands` が `false` のまま
- [ ] `reviewer_ai.canModifyFiles` が `false` のまま
- [ ] `meta_reviewer.canExecuteCommands` が `false` のまま
- [ ] `meta_reviewer.canModifyFiles` が `false` のまま
- [ ] `developer_ai.canReadMemory` が `false` のまま（Context Pack 経由のみ）

### project.ts
- [ ] `ApprovalType` から `dependency_add` が削除されていない
- [ ] `ApprovalStatus` に `expired` が含まれている

### command.ts
- [ ] `CommandKind` から既存の安全なコマンドが削除されていない
- [ ] 危険なコマンド（`curl` / `chmod` / `sudo` 等）が `CommandKind` に追加されていない

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] 既存コードとの後方互換性がある（既存フィールドを削除・型変更していない）
- [ ] 省略可能なフィールドは `?` を使っている（`| undefined` との混在を避ける）
- [ ] 新しい型が `packages/shared/src/index.ts` からエクスポートされている
- [ ] 型の変更が `apps/api/src/storage/sqlite.ts` のシリアライズ・デシリアライズと整合している

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] 新しい型に JSDoc コメントがある（用途・制約を説明）
- [ ] 命名規則が既存と一致している（PascalCase for types, camelCase for fields）
- [ ] `any` 型の使用がなく、使う場合は理由がコメントされている
