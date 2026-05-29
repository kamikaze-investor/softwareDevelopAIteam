# Roadmap

**Project**: AI Development Team OS
**Goal**: スマホだけでAI開発チームを運営できるシステム

---

## Phase 1: 基盤構築（現在）

目的: **安全に自律開発できる基盤を作る**

### 1-A: 型定義・設計基盤 ✅
- [x] 仕様書 (specs/) 作成
- [x] CLAUDE.md 作成
- [x] Project Memory 初期化
- [x] モノレポ骨格 (pnpm workspaces)
- [x] 共有型定義 (packages/shared)
  - [x] Project / Task / Job / Memory / ContextPack
  - [x] AgentRole / AgentPolicy
  - [x] SafeCommand / CommandKind
  - [x] ReviewResult / QAResult
  - [x] **MetaReviewRequest / MetaReviewResult** ← 新規

### 1-B: Meta Reviewer AI（憲法裁判所）✅
- [x] Meta Reviewer AI システムプロンプト (docs/meta_reviewer/prompt.md)
- [x] Meta Reviewer チェックリスト (docs/meta_reviewer/checklist.md)
- [x] Meta Review Runner (apps/worker/src/metaReviewer/runner.ts)
- [ ] Meta Review の自動実行フック（PR前に必ず実行）

### 1-C: セキュリティ基盤 ✅
- [x] Permission Guard (SafeCommand / CommandKind 方式)
- [x] File Change Guard (realpath正規化 / target-project限定)
- [x] pathUtils (isInsideTargetRoot / normalizeAndValidateChangedFile)
- [x] commandResolver (kind→argv変換 / サニタイズ)
- [x] Docker: Control(read-only) / Target(read-write) 物理分離

### 1-D: バックエンド実装（次）
- [ ] SQLite Storage 完全実装 (task-018)
- [ ] Backend API 骨格 → Project / Task / Job CRUD (task-006〜008)
- [ ] 簡易認証 API token (task-014)
- [ ] Worker Job実行エンジン (task-009)
- [ ] Job状態遷移 + 復旧ロジック (task-016)
- [ ] Jobログ分離保存 (task-017)

### 1-E: ダッシュボード
- [ ] Mobile Dashboard基本画面 (task-012)
- [ ] Project作成画面 (task-013)
- [ ] Pending Approval UI (task-019)
- [ ] ReviewResult / QAResult API + 型 (task-015)

---

## Phase 2: MVP実装

目的: Project Creation Flow を動かす

- [ ] 仕様書入力 → Project Memory生成
- [ ] CTO AI: Roadmap・Task自動生成
- [ ] Context Manager AI: Context Pack生成
- [ ] Developer AI: 実装Job実行（Sandbox経由）
- [ ] Meta Reviewer AIの自動実行（全PR前に）
- [ ] Summary Engine: Dashboard自動更新

---

## Phase 3: 品質・安定化

目的: 継続的に開発できる状態にする

- [ ] Project Reviewer AI（target-project/のコードレビュー）
- [ ] QA AI（テスト自動実行・品質判定）
- [ ] Memory Governance
- [ ] Drift Detection
- [ ] Health Metrics
- [ ] Notification System

---

*Updated: 2026-05-28*
