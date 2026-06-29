# Project Current State Map

**作成日**: 2026-06-19
**最終更新**: 2026-06-30
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
- Permission Guard / File Change Guard / Approval Gate / Meta Review の多層防御

---

## 2. ディレクトリ構成

```
softwareDevelopAIteam/            ← Control Repository（AI編集禁止）
├── apps/
│   ├── api/                      ← Fastify バックエンド（SQLite）
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
│       └── scripts/              ← 補助 CLI スクリプト（postTestHook.ps1 等）
├── packages/
│   └── shared/                   ← 共有型定義（TypeScript）
│       └── src/types/
│           ├── job.ts / task.ts / project.ts
│           ├── safety_guard.ts   ← RiskLevel / GateDecision / AuditReport
│           ├── watchdog.ts       ← WatchdogEvent
│           ├── notification.ts   ← NotificationEvent
│           └── ...（14 型ファイル）
├── docs/
│   ├── AI_TEAM_OS_DESIGN.md      ← 設計思想・将来構想（第1〜3弾）
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
├── ALIGNMENT_VIOLATIONS.md       ← Alignment Violation ログ
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
| Auto Review エントリポイント | `apps/worker/src/metaReviewer/autoReview.ts` |
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

### Approval Gate（承認ゲート）✅

承認ゲート全体の実装状況。Steps 1〜3D + P2-followup + Step A + SUPERSEDED/STALE 内部化 + Step D が完了。

| 機能 | ファイル | コミット |
|---|---|---|
| 承認ゲートロジック（純粋関数群） | `packages/shared/src/approvalGateLogic.ts` | — |
| 承認リクエスト型定義 | `packages/shared/src/types/approval_gate.ts` | — |
| API ルート（gate/check・approval-requests・consume） | `apps/api/src/routes/approvalGate.ts` | — |
| SQLite ストレージ（approval_requests テーブル） | `apps/api/src/storage/sqlite.ts` | — |
| Worker Gate クライアント | `apps/worker/src/guards/gateClient.ts` | — |
| jobRunner 通知統合（Step 3D） | `apps/worker/src/jobRunner.ts` | 7345214 |
| health-score approvalWaiting 実測化（Step A） | `apps/api/src/routes/knowledgeGraph.ts` | 31d9941 |
| SUPERSEDED / STALE 内部化 | `apps/api/src/routes/approvalGate.ts` | 35e640f |
| P2-followup: 期限切れ APPROVED 自動クリーンアップ | `apps/api/src/routes/approvalGate.ts` | 8a86845 |
| Step D: diffText シークレットスキャン | `apps/api/src/routes/approvalGate.ts` | 4169d44 |

#### Approval Gate 現在仕様サマリー

**エンドポイント構成**

| エンドポイント | 用途 |
|---|---|
| `POST /api/gate/check` | changedFiles ベースのリスク判定 + diffText スキャン → GateOutcome |
| `POST /api/approval-requests` | 承認リクエスト手動作成（同 taskId の既存は SUPERSEDED） |
| `GET /api/approval-requests?taskId=` | タスクの承認リクエスト一覧 |
| `GET /api/approval-requests/:id` | 単体取得 |
| `PATCH /api/approval-requests/:id/status` | 人間が APPROVED / REJECTED を設定（それ以外は 400） |
| `POST /api/approval-requests/:id/consume` | APPROVED → CONSUMED 遷移（一回限りの承認を保証） |
| `GET /api/approval-requests/active?taskId=` | アクティブリクエスト取得 |
| `GET /api/kg/health-score` | `approvalWaiting` が WAITING_FOR_USER の実件数を返す |

**ステータス遷移ルール**

| ステータス | 遷移経路 | 外部 PATCH 可否 |
|---|---|---|
| `WAITING_FOR_USER` | 作成時の初期状態 | — |
| `APPROVED` | 人間が PATCH /status | ✅ 可（PATCH で設定） |
| `REJECTED` | 人間が PATCH /status | ✅ 可（PATCH で設定） |
| `CONSUMED` | /consume エンドポイント経由のみ | ❌ 内部専用 |
| `EXPIRED` | /consume が expiresAt 超過時に自動設定 | ❌ 内部専用 |
| `SUPERSEDED` | /gate/check または POST /approval-requests が自動設定 | ❌ 内部専用 |
| `STALE` | /gate/check または /consume が commit/diff 不一致時に自動設定 | ❌ 内部専用 |

**Step D: diffText シークレットスキャン**

- `diffText` が渡された場合のみ、追加行（`+` 始まり）をスキャン
- 検出対象: `API_KEY`, `SECRET_KEY`, `PASSWORD`, `ACCESS_TOKEN`, `AUTH_TOKEN`, `PRIVATE_KEY`, `ACCESS_KEY_ID`, `WEBHOOK_URL`, `DATABASE_URL`, PEM 秘密鍵ブロック, `.env` 代入形式（16 文字以上の値）
- 検出時: `riskLevel` を `CRITICAL` に昇格・`triggeredRules` に `diff:secret(<種類>)` を追記
- シークレット値そのものはレスポンス・ログに出力しない（マスク処理）
- `diffText` なし時は既存挙動を完全維持

**jobRunner CEO 通知（Step 3D）**

- `block_until_approved` 時: LINE/Slack に CRITICAL 通知
- `re_check` 時: 承認無効化を通知
- `consume` 失敗時: エラーを通知
- 重複通知防止: `notifiedApprovalRequests` Set（モジュールレベル dedup、approvalRequestId で管理）

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
| **Claude Code** | claude-code CLI | CTO / メイン Developer AI。新機能・設計判断・アーキテクチャ変更 | ✅ 稼働中 |
| **Codex** | codex CLI | サブ Developer AI。局所修正・パターン的実装 | ⚠️ CLI フラグ不整合（後述） |
| **Gemini** | Gemini API + CLI | Meta Reviewer / Alignment Checker。全 PR の安全監査 | ✅ API 経由で稼働 |

### AI エージェント間の呼び出し構造

```
CEO（スマホ）
  └─ apps/api  ─→  apps/worker
                      ├─ JobRunner
                      │    ├─ PermissionGuard ──→ [block]
                      │    ├─ commandResolver
                      │    ├─ ApprovalGate ──→ [block / notify CEO]
                      │    ├─ AI CLI Adapter ──→ Claude Code / Codex / Gemini CLI  ※未接続
                      │    ├─ FileChangeGuard ──→ [block]
                      │    └─ SafetyAuditor ──→ GateProcessor
                      ├─ Watchdog ──→ Notifier ──→ LINE / Slack
                      └─ MetaReviewer ──→ GeminiRouter ──→ Gemini API / CLI
```

※ AI CLI Adapter の jobRunner への接続は task-022 以降で実装予定。現在は未接続。

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

| 項目 | 状態 | 備考 |
|---|---|---|
| `runner.ts` CONTROL_ROOT 対応 | ✅ 実装済み | `process.env.CONTROL_ROOT ?? '/workspace/control'` |
| `geminiRouter.ts` | ✅ API / CLI 自動フォールバック実装済み | — |
| `autoReview.ts` | ✅ 実装済み | GitHub Actions から直接呼び出し |
| GitHub Actions `meta-review.yml` | ✅ PR 前自動実行・動作可能 | `autoReview.ts` 経由 |
| `scripts/metaReview.ts` | ❌ **削除済み** | AV-001 対応で削除（`scripts/` ディレクトリごと存在しない） |
| ローカル `postTestHook.ps1` 経由の自動実行 | ❌ **停止中** | `exit 0` のみ・Meta Review は実行されない |

### Meta Review 実行経路（現状）

**GitHub Actions 経由（有効）**
```
PR 作成 → meta-review.yml → autoReview.ts → Gemini API → PR コメント投稿
```
PR がマージされる前に自動実行される。GEMINI_API_KEY シークレットが設定されていれば動作する。

**ローカル手動実行（可能）**
```bash
pnpm --filter @ai-team/worker exec tsx src/metaReviewer/autoReview.ts
```
環境変数 `BASE_SHA` / `HEAD_SHA` / `PR_TITLE` / `TASK_ID` / `META_REVIEW_RESULT_PATH` / `GEMINI_API_KEY` が必要。

**ローカル自動実行（停止中）**
`postTestHook.ps1` は `exit 0` のみ。vitest 実行後の Meta Review 自動トリガーは機能していない。

---

## 7. テストカバレッジ

### 実行結果（2026-06-30）: **全 560 件パス** ✅

**API（apps/api）: 281 件・22 ファイル**

主なテストファイル（抜粋）:

| テストファイル | 内容 |
|---|---|
| `src/routes/approvalGate.test.ts` | Approval Gate フロー全体（281件中の主要部分） |
| `src/routes/knowledgeGraph.test.ts` | KG・health-score |
| `src/storage/sqlite.test.ts` | SQLite CRUD |
| `src/ctoAi/*.test.ts` | CTO AI 各機能 |
| `src/auth/apiToken.test.ts` | API 認証 |

**Worker（apps/worker）: 279 件・18 ファイル**

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
| `src/jobRunner.test.ts` | — | ジョブ実行・ブロック・CEO 通知（Step 3D） |
| `src/aiCli/adapter.test.ts` | 14 | セキュリティチェック・フォールバック |
| `src/aiCli/codexPathResolver.test.ts` | 12 | パス解決・Windows 対応 |

**テストがないファイル（未カバー領域）:**
- `apps/mobile/` 全体（UI）
- `src/watchdog/watchdog.ts`（統合動作）
- `src/aiCli/claudeCodeAdapter.ts`, `geminiCliAdapter.ts`, `codexAdapter.ts`（実 CLI 呼び出し）

---

## 8. リスク領域

### 🔴 HIGH RISK

| # | リスク | 詳細 |
|---|---|---|
| R-001 | **Codex CLI フラグ不整合** | `codexAdapter.ts` の `--approval-mode` は v0.140.0 で廃止。Codex を使う全ジョブが実行時エラーになる。Control Layer 変更のため CEO 承認必要。 |

### 🟡 MEDIUM RISK

| # | リスク | 詳細 |
|---|---|---|
| R-004 | **AI CLI と jobRunner の未接続** | AI CLI Adapter 基盤は実装済みだが、jobRunner への接続が未実装（task-022 以降）。現在 AI が自律実行できない。 |
| R-005 | **Claude Code auto mode からの Codex 呼び出し不可** | `--ask-for-approval never` フラグが Claude Code auto mode にブロックされる。Codex の自律実行は CEO が直接ターミナルから行う必要がある。 |
| R-006 | **ローカル Meta Review 自動実行停止中** | `postTestHook.ps1` が `exit 0` のみ。GitHub Actions 経由は有効だが、ローカル開発時の自動チェックが機能していない。 |

### 🟢 LOW RISK（把握済み・管理下）

| # | リスク | 詳細 |
|---|---|---|
| R-007 | **未コミット変更の要確認** | `ALIGNMENT_VIOLATIONS.md` / `alignment_engine.ts` 等の未コミット変更が以前指摘されていたが、現在のコミット状況は要確認。`git status` で確認推奨。 |
| R-008 | **roadmap.md の日付・内容が古い** | Approval Gate・Watchdog・ダッシュボード等が反映されていない（2026-06-30 に別途更新）。 |

---

## 9. 次タスク（優先順）

### P0: 即座に対応すべき

| タスク | 理由 | 担当 |
|---|---|---|
| **Codex CLI フラグ修正（CEO 承認待ち）** | R-001 解消。`codexAdapter.ts` の `--approval-mode` → `--ask-for-approval`。Control Layer 変更のため CEO 承認が必要 | CEO 承認後 Claude Code |

### P1: 早期対応が望ましい

| タスク | 理由 | 担当 |
|---|---|---|
| **AI CLI と jobRunner 接続（task-022）** | これが完成して初めて AI が実際に開発を行うシステムになる。Codex CLI フラグ修正後に着手推奨 | Claude Code |
| **postTestHook.ps1 正式設計** | ローカル開発時の Meta Review 自動実行を正式経路で再設計。現状は `exit 0` のみで機能停止中 | Claude Code |

### P2: 中期対応

| タスク | 理由 | 担当 |
|---|---|---|
| **Mobile Dashboard 実装（task-012〜013）** | Expo 画面が骨格のみ。スマホからの状況確認に直結 | Codex or Claude Code |
| **apps/api テスト補完** | 一部ルートの未テスト領域を埋める | Codex |
| **CLI 実行ログ保存（task-022）** | Codex 呼び出しログ保存機能 | Codex |

---

## 補足: Alignment Violation 履歴

| ID | 内容 | ステータス |
|---|---|---|
| AV-001 | `scripts/metaReview.ts`（Control Layer 迂回） | ✅ 解決済み（ファイル削除・CONTROL_ROOT 修正） |

詳細: [`ALIGNMENT_VIOLATIONS.md`](../ALIGNMENT_VIOLATIONS.md)
