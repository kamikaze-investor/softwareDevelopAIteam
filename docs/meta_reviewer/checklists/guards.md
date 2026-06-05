# チェックリスト: apps/worker/src/guards/

対象: `permissionGuard.ts` / `fileChangeGuard.ts` およびguards/配下の全ファイル

---

## 🔴 CRITICAL（1件でも違反 → blocked）

### permissionGuard.ts
- [ ] `ALLOWED_PREFIXES` が削減・削除されていない
- [ ] `FORBIDDEN_PATTERNS` が削減・削除されていない
- [ ] `parseCommand()` のメタ文字チェック（`;` `&&` `|` `` ` `` 等）が削除されていない
- [ ] `isInsideTargetRoot()` の呼び出しが削除されていない
- [ ] `AgentPolicy.canExecuteCommands` チェックが削除されていない
- [ ] `shell: false` が維持されている（execFileSync の呼び出しで）

### fileChangeGuard.ts
- [ ] `ALWAYS_FORBIDDEN_PATTERNS` が削減・削除されていない
- [ ] `normalizeAndValidateChangedFile()` の呼び出しが削除されていない
- [ ] target-project/ 配下のみ許可するロジックが維持されている
- [ ] `task.allowedPaths` / `task.forbiddenPaths` のチェックが削除されていない

### 共通
- [ ] ガード関数の戻り値が `{ allowed: false }` → 実行停止 の流れを破っていない
- [ ] 新しい「ガードをスキップする」条件分岐が追加されていない

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] ガード失敗時のエラーメッセージが内部パス・システム情報を漏らさない
- [ ] ガード結果（GuardResult）が呼び出し元に正しく返されている
- [ ] 新しいパスの組み合わせ・エッジケースに対するテストがある
- [ ] 既存テストが全て通る変更になっている

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] パストラバーサル（`../`）のテストケースがある
- [ ] シンボリックリンクを使った迂回に対してテストがある
- [ ] セキュリティ上の意図がコメントで説明されている
