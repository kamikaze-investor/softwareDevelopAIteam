# Project Current State Map

**作成日**: 2026-06-19  
**作成者**: Claude Code (CTO)  
**目的**: リポジトリの現状を一枚で把握するためのスナップショット

---

## 1. プロジェクト概要

**名称**: AI Development Team OS  
**ゴール**: スマートフォンだけで AI 開発チームを運営できるシステム

### コンセプト

```
CEO（人間）
  └─ スマホアプリ（apps/mobile）で指示
        └─ Worker（apps/worker）がジョブを管理
              ├─ Claude Code（CTO / Developer AI）← 新機能・設計判断
              ├─ Codex（Developer AI サブ）← 局所修正・パターン実装
              └─ Gemini（Meta Reviewer / Alignment Checker）← 安全監査
```

- AI エージェントは **Control Repository**（本リポジトリ）を読み取り専用で参照し、**Target Repository**（開発対象）を読み書きする
- Docker によって物理的に分離（Control → `:ro` マウント、Target → `rw` マウント）
- Permission Guard / File Change Guard / Audit Gate / Meta Review の多層防御

---

## 2. ディレクトリ構成

```
softwareDevelopAIteam/            ← Control Repository（AI編集禁止）
├── apps/
│   ├── api/                      ← Hono バックエンド（SQLite）
│   │   └── src/
│   │       ├── auth/             ← API トークン認証
│   │       ├── ctoAi/            ← CTO AI（ロードマップ・仕様分析・サマリー）
│   │       ├── routes/           ← REST API エンドポイント群
│   │       ├── storage/          ← SQLite CRUD + スキーマ
│   │       └── utils/            ← pathGuard 等
│   ├── mobile/                   ← Expo React Native フロントエンド
│   │   └── app/                  ← index / create / approvals 画面
│   └── worker/                   ← ジョブ実行エンジン（Control Layer）
│       ├── src/
│       │   ├── aiCli/            ← AI CLI アダプター群
│       │   ├── guards/           ← 安全ガード群（AI編集禁止）
│       │   ├── metaReviewer/     ← Gemini Meta Review ランナー
│       │   ├── notifier/         ← LINE / Slack 通知アダプター
│       │   ├── watchdog/         ← タスク停滞検出
│       │   ├── jobRunner.ts      ← ジョブ実行コア
│       │   ├── jobStateManager.ts← ジョブ状態遷移
│       │   ├── jobLogger.ts      ← ログ保存
│       │   └── executionLogStore.ts ← 実行ログストア
│       └── scripts/              ← 補助 CLI スクリプト
├── packages/
│   └── shared/                   ← 共有型定義（TypeScript）
│       └── src/types/
│           ├── job.ts / task.ts / project.ts
│           ├── safety_guard.ts   ← RiskLevel / GateDecision / AuditReport
│           ├── watchdog.ts       ← WatchdogEvent
│           ├── notification.ts   ← NotificationEvent
│           ├── alignment_engine.ts ← (NEW・未コミット) Rule Engine 型
│           └── ...（14 型ファイル）
├── docs/
│   ├── meta_reviewer/            ← Gemini Meta Review プロンプト・チェックリスト
│   └── project_memory/           ← 設計判断・ルール・仕様
├── specs/                        ← 製品仕様書（01〜11）
├── tasks/                        ← タスク管理（roadmap / task_graph / active/）
├── sandbox/                      ← Docker Compose 定義
├── .github/
│   └── workflows/
│       ├── ci.yml                ← Typecheck + Test
│       └── meta-review.yml       ← PR前自動 Meta Review
├── AGENTS.md                     ← AI 全エージェント共通ルール
├── CLAUDE.md                     ← Claude Code 専用指示
├── ALIGNMENT_VIOLATIONS.md       ← (NEW・未コミット) Alignment Violation ログ
└── .env / .env.example
```

---

## 3. 実装済みフィーチャー一覧

### Phase 1-A: 型定義・設計基盤 ✅

| 機能 | ファイル |
|---|---|
| 共有型定義（14種） | `packages/shared/src/types/` |
| モノレポ骨格 | `pnpm-workspace.yaml` |
| 仕様書 | `specs/01〜11` |

### Phase 1-B: Meta Reviewer AI ✅

| 機能 | ファイル |
|---|---|
| Meta Reviewer プロンプト | `docs/meta_reviewer/prompt.md` |
| チェックリスト（7 種） | `docs/meta_reviewer/checklists/` |
| Meta Review Runner | `apps/worker/src/metaReviewer/runner.ts` |
| Gemini クライアント | `apps/worker/src/metaReviewer/geminiClient.ts` |
| Gemini ルーター（API/CLI フォールバック） | `apps/worker/src/metaReviewer/geminiRouter.ts` |
| Auto Review | `apps/worker/src/metaReviewer/autoReview.ts` |
| GitHub Actions | `.github/workflows/meta-review.yml` |

### Phase 1-C: セキュリティ基盤 ✅

| 機能 | ファイル |
|---|---|
| Permission Guard（静的ポリシー + Grant） | `apps/worker/src/guards/permissionGuard.ts` |
| File Change Guard（realpath 正規化） | `apps/worker/src/guards/fileChangeGuard.ts` |
| Safety Auditor（diff 解析・危険キーワード検出） | `apps/worker/src/guards/safetyAuditor.ts` |
| Alignment Checker（Gemini 連携） | `apps/worker/src/guards/alignmentChecker.ts` |
| Gate Processor（audit + alignment 統合判定） | `apps/worker/src/guards/gateProcessor.ts` |
| pathUtils | `apps/worker/src/utils/pathUtils.ts` |
| commandResolver | `apps/worker/src/commandResolver.ts` |

### Phase 1-F: AI CLI Adapter 基盤 ✅

| 機能 | ファイル |
|---|---|
| BaseCliAdapter（セキュリティ強制） | `apps/worker/src/aiCli/adapter.ts` |
| ClaudeCodeAdapter | `apps/worker/src/aiCli/claudeCodeAdapter.ts` |
| GeminiCliAdapter | `apps/worker/src/aiCli/geminiCliAdapter.ts` |
| CodexAdapter | `apps/worker/src/aiCli/codexAdapter.ts` |
| Codex パス解決（Windows 対応） | `apps/worker/src/aiCli/codexPathResolver.ts` |
| AI CLI ファクトリ | `apps/worker/src/aiCli/factory.ts` |

### Phase 1-D 一部: ジョブ管理基盤 ✅

| 機能 | ファイル |
|---|---|
| ジョブ実行コア | `apps/worker/src/jobRunner.ts` |
| ジョブ状態遷移 | `apps/worker/src/jobStateManager.ts` |
| ジョブログ保存 | `apps/worker/src/jobLogger.ts` |
| 実行ログストア | `apps/worker/src/executionLogStore.ts` |
| SQLite Storage（全テーブル） | `apps/api/src/storage/sqlite.ts` |
| Permission Grant System | `apps/api/src/routes/permissionGrants.ts` |

### Phase B: Task Watchdog ✅

| 機能 | ファイル |
|---|---|
| 停滞検出（CommandKind 別閾値） | `apps/worker/src/watchdog/stallDetector.ts` |
| Watchdog ループ | `apps/worker/src/watchdog/watchdog.ts` |
| WatchdogEvent API | `apps/api/src/routes/watchdogEvents.ts` |

### Phase C: 通知 + ダッシュボード ✅

| 機能 | ファイル |
|---|---|
| 通知ルーター | `apps/worker/src/notifier/notifier.ts` |
| LINE アダプター | `apps/worker/src/notifier/lineAdapter.ts` |
| Slack アダプター | `apps/worker/src/notifier/slackAdapter.ts` |
| ダッシュボード集計 API | `apps/api/src/routes/dashboard.ts` |

### CTO AI 機能（apps/api）✅

| 機能 | ファイル |
|---|---|
| ロードマップ生成 | `apps/api/src/ctoAi/roadmapGenerator.ts` |
| 仕様分析 | `apps/api/src/ctoAi/specAnalyzer.ts` |
| サマリーエンジン | `apps/api/src/ctoAi/summaryEngine.ts` |
| Context Manager | `apps/api/src/ctoAi/contextManager.ts` |
| Developer AI Orchestrator | `apps/api/src/ctoAi/developerAiOrchestrator.ts` |

---

## 4. AI エージェント役割定義

| エージェント | ツール | 役割 | 状態 |
|---|---|---|---|
| **Claude Code** | claude-code CLI | CTO / メイン Developer AI。新機能・設計判断・アーキテクチャ変更 | ✅ 稼働中（本セッション） |
| **Codex** | codex CLI | サブ Developer AI。局所修正・パターン的実装 | ⚠️ CLI フラグ不整合（後述） |
| **Gemini** | Gemini API + CLI | Meta Reviewer / Alignment Checker。全 PR の安全監査 | ✅ API 経由で稼働 |

### AI エージェント間の呼び出し構造

```
CEO（スマホ）
  └─ apps/api  ─→  apps/worker
                      ├─ JobRunner
                      │    ├─ PermissionGuard ──→ [block]
                      │    ├─ commandResolver
                      │    ├─ AI CLI Adapter ──→ Claude Code / Codex / Gemini CLI
                      │    ├─ FileChangeGuard ──→ [block]
                      │    └─ SafetyAuditor ──→ GateProcessor
                      ├─ Watchdog ──→ Notifier ──→ LINE / Slack
                      └─ MetaReviewer ──→ GeminiRouter ──→ Gemini API / CLI
```

---

## 5. Codex CLI 統合状況

### 現状（問題あり）

| 項目 | 状態 |
|---|---|
| Codex CLI インストール | ✅ npm グローバル（`codex.cmd` 解決済み） |
| `codexPathResolver.ts` | ✅ Windows 対応・WindowsApps 回避 |
| `codexAdapter.ts` の CLI フラグ | ❌ **`--approval-mode`** を使用中（codex-cli v0.140.0 で廃止） |
| 正しいフラグ | `--ask-for-approval never / on-request` |
| Claude Code からの自律呼び出し | ❌ Claude Code auto mode が `--ask-for-approval never` をブロック |

### 問題の詳細

`codexAdapter.ts`（AI 編集禁止・Control Layer）の `buildArgv()` が:
```typescript
return ['--approval-mode', approvalMode, request.prompt]
// → codex-cli v0.140.0 では "unexpected argument '--approval-mode'" エラー
```

**修正が必要だが Control Layer 変更のため CEO 承認待ち。**

### Codex 呼び出し代替手段

現時点で CEO が直接ターミナルから実行する場合:
```bash
cat prompt.txt | codex --ask-for-approval never exec -
```

---

## 6. Gemini Meta Review 状態

### 動作状況

| 項目 | 状態 |
|---|---|
| `runner.ts` CONTROL_ROOT 対応 | ✅ `process.env.CONTROL_ROOT ?? '/workspace/control'` に修正済み（CEO 承認・実装済み） |
| `.env` への CONTROL_ROOT 設定 | ✅ 追加済み（未コミット） |
| `geminiRouter.ts` | ✅ API / CLI 自動フォールバック実装済み |
| GitHub Actions `meta-review.yml` | ✅ PR 前自動実行 |
| Windows ローカルでの実行 | ✅ CONTROL_ROOT 修正により可能になった |

### Meta Review 実行方法（正式経路）

```bash
# Windows ローカル（CONTROL_ROOT を .env で設定後）
pnpm exec tsx scripts/alignmentCheck.ts
```

`scripts/alignmentCheck.ts` は `runner.ts` の `runAlignmentCheck()` を直接呼ぶ形式（未コミット）。

---

## 7. テストカバレッジ

### 実行結果（2026-06-19）: **全 137 件パス** ✅

| テストファイル | テスト数 | 内容 |
|---|---|---|
| `src/metaReviewer/runner.test.ts` | 3 | Meta Review JSON パース |
| `src/metaReviewer/geminiRouter.test.ts` | 9 | API/CLI フォールバック |
| `src/watchdog/stallDetector.test.ts` | 6 | 停滞検出・CommandKind 別閾値 |
| `src/jobStateManager.test.ts` | 11 | ジョブ状態遷移ルール |
| `src/guards/gateProcessor.test.ts` | 11 | audit + alignment 統合判定 |
| `src/guards/alignmentChecker.test.ts` | 7 | Gemini 連携・JSON パース |
| `src/guards/safetyAuditor.test.ts` | 15 | diff 解析・危険キーワード |
| `src/guards/permissionGuard.test.ts` | 13 | 静的ポリシー + Grant 検証 |
| `src/jobRunner.test.ts` | 7 | ジョブ実行・ブロック・ロールバック |
| `src/jobLogger.test.ts` | 3 | ログ書き込み・プレビュー切り詰め |
| `src/executionLogStore.test.ts` | 7 | 実行ログ CRUD |
| `src/notifier/notifier.test.ts` | 5 | LINE/Slack 通知 |
| `src/aiCli/adapter.test.ts` | 14 | セキュリティチェック・フォールバック |
| `src/aiCli/codexPathResolver.test.ts` | 12 | パス解決・Windows 対応 |

**テストがないファイル（未カバー領域）:**
- `apps/api/` 配下のルートハンドラ群（手動テストのみ）
- `apps/mobile/` 全体（UI）
- `src/watchdog/watchdog.ts`（統合動作）
- `src/aiCli/claudeCodeAdapter.ts`, `geminiCliAdapter.ts`, `codexAdapter.ts`（実 CLI 呼び出し）

---

## 8. リスク領域

### 🔴 HIGH RISK

| # | リスク | 詳細 |
|---|---|---|
| R-001 | **Codex CLI フラグ不整合** | `codexAdapter.ts` の `--approval-mode` は v0.140.0 で廃止。Codex を使う全ジョブが実行時エラーになる。Control Layer 変更のため CEO 承認必要。 |
| R-002 | **未コミット変更の散逸** | `ALIGNMENT_VIOLATIONS.md`, `alignment_engine.ts`, `alignmentCheck.ts`, `postTestHook.ps1`, `runner.ts` 修正, `.env.example` 等が未コミット。意図せずリセットされるリスク。 |
| R-003 | **postTestHook.ps1 の Meta Review 無効化** | Meta Review 自動実行が無効（`exit 0` のみ）。正式経路での再設計が未完了。 |

### 🟡 MEDIUM RISK

| # | リスク | 詳細 |
|---|---|---|
| R-004 | **Alignment Engine 未実装** | `packages/shared/src/types/alignment_engine.ts` で型定義済みだが、`apps/worker/src/alignmentEngine/` モジュールが存在しない。型だけあって実体がない状態。 |
| R-005 | **Claude Code auto mode からの Codex 呼び出し不可** | `--ask-for-approval never` フラグが Claude Code auto mode にブロックされる。Codex の自律実行は CEO が直接ターミナルから行う必要がある。 |
| R-006 | **API ルートのテスト欠如** | `apps/api/src/routes/` の多くはテストがあるが、一部（`approvals.ts`, `summaryEngine.ts` 等）は未テスト。 |

### 🟢 LOW RISK（把握済み・管理下）

| # | リスク | 詳細 |
|---|---|---|
| R-007 | **AV-001 対処チェックリスト** | `scripts/metaReview.ts` 削除済み。`postTestHook.ps1` クリーンアップが残作業。 |
| R-008 | **roadmap.md の日付が古い** | `Updated: 2026-05-28` だが実装は進んでいる。ドキュメントと実装が乖離。 |

---

## 9. 次タスク（優先順）

### P0: 即座に対応すべき

| タスク | 理由 | 担当 |
|---|---|---|
| **未コミット変更を整理してコミット** | R-002 回避。`ALIGNMENT_VIOLATIONS.md` / `alignment_engine.ts` / `runner.ts` 修正 / `.env.example` / `alignmentCheck.ts` / `postTestHook.ps1` を適切な単位でコミット | CEO + Claude Code |
| **Codex CLI フラグ修正（CEO 承認待ち）** | R-001 解消。`codexAdapter.ts` の `--approval-mode` → `--ask-for-approval`。Control Layer 変更のため CEO 承認が必要 | CEO 承認後 Claude Code |

### P1: 早期対応が望ましい

| タスク | 理由 | 担当 |
|---|---|---|
| **低コスト Alignment Engine 実装** | `alignmentEngine/` モジュール（rules.ts / ruleEngine.ts / riskClassifier.ts / planChecker.ts / diffChecker.ts / reportStore.ts）を実装。型は `alignment_engine.ts` で定義済み。仕様書は `/tmp/codex-alignment-prompt.txt` に存在。 | Claude Code または Codex（CEO 承認後） |
| **postTestHook.ps1 正式設計** | Meta Review 自動実行を正式経路（Runner 経由）で再設計。現状は `exit 0` のみで機能停止中 | Claude Code |
| **roadmap.md 更新** | Phase B / C / Permission Grant System 等を ✅ に更新。実装と乖離しているため混乱の原因になる | Claude Code |

### P2: 中期対応

| タスク | 理由 | 担当 |
|---|---|---|
| **Backend API 実装（task-006〜009）** | Project CRUD / Task CRUD / Job Queue / Worker 実行エンジン。現在 SQLite スキーマのみ存在 | Codex（局所実装向き） |
| **Mobile Dashboard 実装（task-012〜013）** | Expo 画面が `approvals.tsx / create.tsx / index.tsx` の骨格のみ | Codex or Claude Code |
| **apps/api テスト補完** | `routes/approvals.ts` 等の未テストルートにテスト追加 | Codex |
| **CLI 実行ログ保存（task-022）** | Codex 呼び出しログを `docs/codex_invocation_log/` に保存する機能 | Codex |

---

## 補足: Alignment Violation 履歴

| ID | 内容 | ステータス |
|---|---|---|
| AV-001 | `scripts/metaReview.ts`（Control Layer 迂回） | ✅ 解決済み（ファイル削除・CONTROL_ROOT 修正） |

詳細: [`ALIGNMENT_VIOLATIONS.md`](../ALIGNMENT_VIOLATIONS.md)
