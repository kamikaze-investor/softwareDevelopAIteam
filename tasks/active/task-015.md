# task-015: ReviewResult / QAResult 型 + API

**担当**: Developer AI (Claude Code)
**設計**: Claude Code
**依存**: task-007 ✅ task-008 ✅
**ブランチ**: `ai/task-015`
**コミット形式**: `[claude_code task-015] feat: ...`

---

## タスクスコープ

**ReviewResult と QAResult の CRUD API を実装する。**

型定義は `packages/shared/src/types/review.ts` に既存。
SQLiteストレージ + FastifyルートのみPhase 1スコープ。

---

## ファイル構成

```
apps/api/src/
  storage/
    interface.ts      ← IReviewResultStorage / IQAResultStorage を追加
    schema.ts         ← review_results / qa_results テーブル追加
    sqlite.ts         ← 上記2ストレージの実装追加
  routes/
    reviews.ts        ← 新規作成
    reviews.test.ts   ← 新規作成
  index.ts            ← reviewRoutes 登録1行追加
```

---

## 実装済み型（参照のみ）

`packages/shared/src/types/review.ts` より:

```typescript
interface ReviewResult {
  id, taskId, jobId, reviewer: AgentRole,
  status: 'approved'|'changes_requested'|'rejected',
  summary, findings: ReviewFinding[], createdAt
}
interface QAResult {
  id, taskId, jobId,
  type: 'typecheck'|'unit_test'|'build'|'lint'|'manual_check',
  status: 'passed'|'failed'|'skipped',
  summary, details?, createdAt
}
```
