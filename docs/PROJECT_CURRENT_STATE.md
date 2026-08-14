# Project Current State Map

**作成日**: 2026-06-19
**最終更新**: 2026-07-02
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

### 運用形態（要約）: VPS常駐稼働 + スマホ操作

**正本**: `specs/11_runtime_environment.md`「3b. 運用形態（正本）: VPS常駐稼働 + スマホ操作」

AI Development Team OS は最終的に VPS 上で常駐稼働し、CEO（人間）はスマホから Web UI（未実装・将来候補）または Mobile app（`apps/mobile`, 実装済み）経由で操作する。ローカルPC起動は開発・検証用の一時形態であり、本番運用形態ではない。詳細な接続関係・後続タスクは正本を参照。

### Implemented MVP Baseline（現在すでに動いているMVP機能・正本）

**位置づけ**: 本節は、現在すでに実装・動作しているMVP機能のベースラインである。

`specs/00_constitution.md` / `specs/13_future_system_architecture.md` / `specs/20_token_efficient_intelligence_policy.md`
に記載する将来思想・将来アーキテクチャは、本節に列挙する既存機能を **自動的に上書き・削除・弱体化しない**。
これらを削除・置換する場合は、明示的なCEO承認を必要とする。

| 機能 | 実装箇所 | 状態 |
|---|---|---|
| Project / Task / Job 基本管理 | `apps/api/src/routes/{projects,tasks,jobs}.ts` | 実装済み・テストあり |
| API（Fastify） | `apps/api/src` | 実装済み・テストあり |
| Worker / Job Runner | `apps/worker/src/jobRunner.ts`, `jobStateManager.ts`, `executionLogStore.ts` | 実装済み・テストあり |
| Approval Gate | `apps/api/src/routes/approvalGate.ts`, `apps/worker/src/guards/approvalGate.ts` | 実装済み・テストあり |
| Risk Control | `apps/worker/src/guards/{safetyAuditor,gatePolicy,gateProcessor}.ts` | 実装済み・テストあり |
| Policy Enforcement | `apps/worker/src/guards/permissionGuard.ts`, `gateClient.ts` | 実装済み・テストあり |
| Notification | `apps/worker/src/notifier/{notifier,lineAdapter,slackAdapter}.ts` | 実装済み・テストあり |
| health-score | `apps/api/src/routes/knowledgeGraph.ts`（`GET /kg/health-score`）、`packages/shared/src/types/project.ts`の`healthScore` | 実装済み・テストあり |
| Watchdog | `apps/worker/src/watchdog/{watchdog,stallDetector}.ts` | 実装済み・テストあり |
| stale / expired approval cleanup | `apps/api/src/routes/{approvalGate,approvals}.ts`, `apps/worker/src/guards/{gateClient,gatePolicy}.ts`, `apps/worker/src/jobStateManager.ts` | 実装済み・テストあり |
| Mobile app | `apps/mobile/app/{index,create,approvals}.tsx` | 実装済み |
| Project作成画面（`create.tsx`） | 名前・Goal・Design Philosophy入力 | 実装済み |
| Android実機Expo Go起動・API疎通・Project一覧表示 | 同上（コミット `be0a5b5`〜`9b3121c`） | 実機確認済み・E2E-4 |
| 下部フッター固定表示 | `apps/mobile/app/index.tsx`（`6b8eff3`） | 実機確認済み |
| Expo app config | `apps/mobile/app.json`（`9b3121c`） | 実機確認済み |
| 既存テスト群 | `apps/**/*.test.ts`（52ファイル） | 全パス確認済み |

**将来構想との関係**: 添付仕様（`specs/00_constitution.md`ほか）が定義するTeam Extension / Service Extension / Health Engine /
Self Diagnosis / Improvement Planner / Experiment / Evolution 等は、上記いずれの機能も置き換えるものではない。
現行のCore/Team概念との対応関係は `specs/13_future_system_architecture.md` の現状マッピングを参照。

### スマホ操作MVPの現在地（2026-07-21整理）

**スマホ操作MVPの定義:** CEOがスマホだけで「開発指示を出す→Project/Task/Jobを確認する→AI作業の進捗を見る→
危険操作は承認で止まる→Approval Gateの承認/却下を行う→完了結果・失敗理由を見る→必要に応じて再実行や
追加指示を出す」という一連の開発サイクルを完結できる状態。VPS常駐稼働前提（`specs/11_runtime_environment.md`）
と矛盾しないことも条件とする。

**注記:** 以下の「未実装の重要項目」は、Implemented MVP Baseline（上記）に列挙した既存機能が
存在しない・弱いという意味ではない。既存機能はそのまま維持対象であり、以下は**スマホ操作MVP到達のために
新たに必要な残タスク**として扱う。詳細な実装タスクは `tasks/roadmap.md`「スマホ操作MVP残タスク」を参照。

<!-- AUTO-GENERATED:ROADMAP_CURRENT_STATE:START -->
**完了項目:**
- **Step 0: データモデル整合（完了）**
- **ロードマップ→Taskレコード自動生成（完了）**
- **Meta Review MVP Hardening
- Task/Job一覧・詳細画面（Mobile）
- Task/Job単位Approval GateのMobile UI連携
- 追加開発指示（追加Task作成）画面（Mobile）
- 再実行・追加指示UI（Mobile）

**未完了・保留項目:**
- **Worker安全境界・結果引き渡し設計**（state: in_progress）
- **Worker永続Outbox・結果受信基盤**（state: in_progress）
- **本体DB安全・復旧基盤**（state: in_progress）
- **Project別Roadmap可視化**（2026-08-14、Project Detail調査により新規登録。既存項目（state: planned）
- **Task→Job自動生成と連続実行**（state: blocked）
- **障害復旧E2E・自律実行有効化**（state: planned）
- Project全体の完了判定: 全Task完了をもってProject完了とみなす判定。（state: planned）
- CEO Alignment Checkpoint: Phase完了・主要機能完成時にサマリーと当初計画との差分をCEOへ通知する。（state: planned）
- **Worker安全コアの物理分離**（state: deferred）
- **Context Pack実接続**（state: deferred）
- **複数Worker対応**（state: deferred）
- **ヒヤリハット・反復非効率検知（state: planned）
- 2種類の承認の役割整理とMobile導線設計（state: deferred）

詳細は `tasks/roadmap.md`「スマホ操作MVP残タスク」を参照。
<!-- AUTO-GENERATED:ROADMAP_CURRENT_STATE:END -->

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
| 共有型定義（19種） | `packages/shared/src/types/` |
| モノレポ骨格 | `pnpm-workspace.yaml` |
| 仕様書 | `specs/00〜11, 13, 20` |

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

### task-022: AI CLI → jobRunner 接続 ✅

| 機能 | ファイル | コミット |
|---|---|---|
| Job 型に `aiCliProvider` / `aiCliPrompt` / `aiCliMode` 追加 | `packages/shared/src/types/job.ts` | 388358d |
| `CreateJobBody` に AI CLI フィールド追加・バリデーション強制 | `apps/api/src/routes/jobs.ts` | 388358d |
| jobRunner に AI CLI 先行実行ブロック追加 | `apps/worker/src/jobRunner.ts` | 388358d |
| AI CLI 実行分岐テスト（5ケース） | `apps/worker/src/jobRunner.test.ts` | 388358d |

**実装仕様:**
- `aiCliProvider` / `aiCliPrompt` / `aiCliMode` が揃っている場合のみ AI CLI を先行実行
- 成功時: 既存 SafeCommand（`git_commit` 等）フローを継続
- 失敗時（`blocked: true` / `exitCode !== 0` / `adapter.run()` throw）: `status: failed` で早期リターン
- 3フィールドが揃わない既存 Job への影響ゼロ
- `contextFiles` は初期実装では `[]` 固定（Context Manager 連携は別 task）

### 代表Health Endpoint（VPS App Runtime Standard v1準拠）✅

| 機能 | ファイル | コミット |
|---|---|---|
| Health Endpoint ルートロジック（in-memory runtime state） | `apps/api/src/routes/health.ts` | 9a425f2 |
| Health Endpoint テスト | `apps/api/src/routes/health.test.ts` | 9a425f2 |
| `/api/health` 登録・認証除外ロジック拡張 | `apps/api/src/index.ts` | 9a425f2 |
| 認証除外・health統合テスト | `apps/api/src/index.test.ts` | 9a425f2 |

**実装仕様:**
- 代表Health Endpointとして `/api/health` を追加（VPS App Runtime Standard v1準拠、仕様書: `docs/vps_app_runtime_standard.md`）
- 既存 `/health` は旧simple livenessとして維持（後方互換）
- `/health` と `/api/health` は認証除外（`isHealthCheckUrl()` ヘルパーでクエリ文字列付きURL `/health?x=1` `/api/health?x=1` にも対応）
- レスポンスは秘密情報を返さない（`process.env.npm_package_version` / `NODE_ENV` のみ参照）
- `status` は `'running'` 固定、`lastSuccessAt` / `lastErrorAt` は `null` 固定（worker success/error連携は未実装・別task）
- VPS Doctor Lite側の読み取り実装は未着手（別プロジェクト）

**未着手の関連タスク:**
- VPS Doctor Lite側から `/api/health` を読む実装（別プロジェクト）
- worker success/error連携（`lastSuccessAt`/`lastErrorAt`の実データ反映）
- app manifest
- IPアクセス制限・認証機構の追加検討
- target-project向けリスクスキャン（Target Project Risk Scan v1、コミット d16a709〜afab85c）の観察期間継続、target-project用preflight判定の別途設計

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

**注記（2026-07-06実態確認）:** 上記はいずれも実装済み・単体テストありだが、「仕様書入力→CTO AI→
Context Pack→Developer AI→Job実行→Review→Dashboard更新」という一連の流れがE2Eで実際につながって
動くことはまだ確認していない（Project/Task/Job CRUD API・API token認証・Mobile Dashboard・
Pending Approval UIも同様）。次タスク「MVP E2E疎通確認」（`tasks/roadmap.md`参照）で検証する。

---

## 4. AI エージェント役割定義

| エージェント | ツール | 役割 | 状態 |
|---|---|---|---|
| **Claude Code** | claude-code CLI | CTO / メイン Developer AI。新機能・設計判断・アーキテクチャ変更 | ✅ 稼働中 |
| **Codex** | codex CLI | サブ Developer AI。局所修正・パターン的実装 | ✅ CLI フラグ解決済み（v0.140.0 対応） |
| **Gemini** | Gemini API + CLI | Meta Reviewer / Alignment Checker。全 PR の安全監査 | ✅ API 経由で稼働 |

### AI エージェント間の呼び出し構造

```
CEO（スマホ）
  └─ apps/api  ─→  apps/worker
                      ├─ JobRunner
                      │    ├─ PermissionGuard ──→ [block]
                      │    ├─ ApprovalGate ──→ [block / notify CEO]
                      │    ├─ AI CLI Adapter ──→ Claude Code / Codex / Gemini CLI  ✅ 接続済み (task-022)
                      │    ├─ commandResolver
                      │    ├─ execFileSync (SafeCommand)
                      │    └─ FileChangeGuard ──→ [block]
                      ├─ Watchdog ──→ Notifier ──→ LINE / Slack
                      └─ MetaReviewer ──→ GeminiRouter ──→ Gemini API / CLI
```

AI CLI Adapter は task-022 (388358d) で jobRunner に接続済み。
`aiCliProvider` / `aiCliPrompt` / `aiCliMode` が Job に指定された場合、SafeCommand 実行前に先行実行される。

---

## 5. Codex CLI 統合状況

### 現状（解決済み）

| 項目 | 状態 |
|---|---|
| Codex CLI インストール | ✅ npm グローバル（`codex.cmd` 解決済み） |
| `codexPathResolver.ts` | ✅ Windows 対応・WindowsApps 回避 |
| `codexAdapter.ts` の CLI フラグ | ✅ **`exec --sandbox workspace-write/read-only`**（v0.140.0 対応済み）(bf00bae) |
| jobRunner との接続 | ✅ task-022 (388358d) で接続済み |

`--approval-mode` フラグは bf00bae（2026-06-19）で `exec --sandbox` に修正済み。
jobRunner への接続は 388358d（2026-07-01）で完了。

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

### 現在値（2026-08-13、`pnpm --filter @ai-team/{api,worker,shared} test` を実行して確認）

**リポジトリ全体（test スクリプトを持つ全パッケージ）: 1473 件パス** ✅
- api: 540 件・35 ファイル
- worker: 886 件・45 ファイル
- shared: 47 件・2 ファイル

（`apps/mobile` は test スクリプトを持たず typecheck のみのため、この件数に含めない。過去の実行結果スナップショット（847件・798件・566件など。いずれもapi+workerのみの集計だった）は現在値と乖離するため削除し、テスト件数の推移が必要な場合は各コミットのCI実行履歴を参照する）

**テストがないファイル（未カバー領域）:**
- `apps/mobile/` 全体（UI）
- `src/watchdog/watchdog.ts`（統合動作）
- `src/aiCli/claudeCodeAdapter.ts`, `geminiCliAdapter.ts`, `codexAdapter.ts`（実 CLI 呼び出し）

---

## 8. リスク領域

### 🟡 MEDIUM RISK

| # | リスク | 詳細 |
|---|---|---|
| R-005 | **Context Manager 未接続** | AI CLI の `contextFiles` は初期実装で `[]` 固定。Context Manager AI による ContextPack 生成・連携は未実装（別 task）。 |
| R-006 | **ローカル Meta Review 自動実行停止中** | `postTestHook.ps1` が `exit 0` のみ。GitHub Actions 経由は有効だが、ローカル開発時の自動チェックが機能していない。 |

### 🟢 LOW RISK（把握済み・管理下）

| # | リスク | 詳細 |
|---|---|---|
| R-007 | **未追跡スクリプトの扱い** | `apps/worker/scripts/alignmentCheck.ts` / `postTestHook.ps1` が未追跡。意図的な未追跡（CONTROL REPOSITORY保護対象）のため現状維持。代表Health Endpoint追加コミット（9a425f2）でもこの2ファイルおよび `apps/worker/data/` は含めていない。既存の意図的未追跡として引き続き現状維持。 |
| R-008 | **代表Health Endpointの`/api/health`無認証公開** | `/api/health`・`/health`は認証除外。レスポンスに秘密情報を含まないことをテストで担保済み（`health.test.ts`）だが、外部公開範囲を広げた判断であることを継続的に把握しておく。IPアクセス制限は未実装（roadmap未決定事項）。 |
| R-009 | **safetyVerification観察結果の`overallPassed:false`は危険検出とは限らない** | Step R4-B（コミット929efe8）で`safetyVerifier`を観察モード接続。`TYPECHECK`/`RELATED_TESTS`/`FULL_TESTS`の3項目は実行結果を渡していないため常にfail-closedになり、`overallPassed:false`の主要因になり得る。`review_observation.jsonl`の`blockingFailures`を見れば、本当の危険シグナルか未接続項目由来かを区別できる。 |

---

## 9. 次タスク（優先順）

### P1: 早期対応が望ましい

| タスク | 理由 | 担当 |
|---|---|---|
| **スマホからの開発指示（Task作成）フローの調査・設計・実装** | スマホ操作MVPの現在の主要実装残タスク。Task/Job一覧・詳細UI・Approval Gate連携・再実行/追加指示UIは完了済みで、Project内にTaskを追加する導線のみ未実装。Task作成後の初回Job起動方法を既存経路（CTO AI/Developer AI Orchestrator等）から調査したうえで実装方針を決める | Claude Code |
| **Context Manager 連携（contextFiles 拡張）** | AI CLI の `contextFiles` が現在 `[]` 固定。Context Manager AI が ContextPack を生成して渡すことで AI の実装精度が向上する | Claude Code |
| **postTestHook.ps1 正式設計** | ローカル開発時の Meta Review 自動実行を正式経路で再設計。現状は `exit 0` のみで機能停止中 | Claude Code |

### P2: 中期対応

| タスク | 理由 | 担当 |
|---|---|---|
| **apps/api テスト補完** | 一部ルートの未テスト領域を埋める | Codex |
| **CLI 出力パーサー + JSON リトライ（task-023）** | AI CLI が JSON 出力を期待する場合のリトライ機構 | Codex |
| **VPS Doctor Lite側から `/api/health` を読む** | 代表Health Endpoint追加（9a425f2）を実際に外部監視に接続する | 別プロジェクト |
| **worker success/error連携** | `/api/health` の `lastSuccessAt`/`lastErrorAt` を実データで反映 | Claude Code |
| **app manifest** | VPS App Runtime Standard v1の未決定事項 | 別途設計 |
| **target-project用リスクスキャン preflight判定** | Target Project Risk Scan v1（観察モード、コミットd16a709〜afab85c）の次段階設計 | Claude Code |
| **commitGate観察モード接続（Step R4-C）** | **保留中。** Step R4-A（postReviewer, 5de0f15）・R4-B（safetyVerifier, 929efe8）は完了し、`review_observation.jsonl`にRisk Scan/Gemini Step Review/postReview/safetyVerificationの観察結果が蓄積される状態になった。preReviewer接続を調査した結果、本質的なボトルネックは「preReviewer未接続」ではなく`commitGate`が依存する`reviewPolicy`がcontrol repo基準でtarget_project向けJobには信頼できないこと（Step6-B0で既知）と判明。preReviewer接続自体は責務重複・入力不足・観察モードでの価値低下により見送り。再開条件: MVP後、またはtarget_project向けreviewPolicy/commitGate必須成果物設計を見直した後 | Claude Code |
| **Codex Reviewer本番接続** | read-only Codex Reviewer Adapter（`fe56b8e`）・モデル明示指定（`c3ff36a`）は実装済みだが、`jobRunner.ts`への接続は未実施。スマホ操作MVP必須ではないため保留中 | Claude Code |

---

## 補足: Alignment Violation 履歴

| ID | 内容 | ステータス |
|---|---|---|
| AV-001 | `scripts/metaReview.ts`（Control Layer 迂回） | ✅ 解決済み（ファイル削除・CONTROL_ROOT 修正） |

詳細: [`ALIGNMENT_VIOLATIONS.md`](../ALIGNMENT_VIOLATIONS.md)
