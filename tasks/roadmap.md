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
- [x] Meta Review の自動実行フック（PR前に必ず実行）← GitHub Actions (.github/workflows/meta-review.yml)

### 1-C: セキュリティ基盤 ✅
- [x] Permission Guard (SafeCommand / CommandKind 方式)
- [x] File Change Guard (realpath正規化 / target-project限定)
- [x] pathUtils (isInsideTargetRoot / normalizeAndValidateChangedFile)
- [x] commandResolver (kind→argv変換 / サニタイズ)
- [x] Docker: Control(read-only) / Target(read-write) 物理分離

### 1-G: Approval Gate（承認ゲート）✅
- [x] 承認ゲート型定義・純粋関数群 (packages/shared/src/approvalGateLogic.ts)
- [x] approval_requests テーブル + SQLite CRUD
- [x] POST /api/gate/check — changedFiles ベースリスク判定・GateOutcome
- [x] POST /api/approval-requests — 承認リクエスト作成・SUPERSEDED 自動化
- [x] PATCH /api/approval-requests/:id/status — APPROVED / REJECTED のみ受付
- [x] POST /api/approval-requests/:id/consume — APPROVED → CONSUMED（一回限り保証）
- [x] SUPERSEDED / STALE / EXPIRED / CONSUMED は内部専用（外部 PATCH 不可）
- [x] P2-followup: 期限切れ APPROVED の自動 EXPIRED 化 (8a86845)
- [x] Step A: health-score approvalWaiting を WAITING_FOR_USER 実件数で計測 (31d9941)
- [x] Step 3D: jobRunner CEO 通知統合（block 時・consume 失敗時・re_check 時） (7345214)
- [x] Step D: diffText シークレットスキャン（追加行のみ・CRITICAL 昇格・マスク処理） (4169d44)

### 1-F: AI CLI Adapter基盤 ✅
- [x] AiCliProvider / AiCliRequest / AiCliResult 型定義 (packages/shared)
- [x] BaseCliAdapter（セキュリティ強制: workingDir検証・Secret Scan・shell:false）
- [x] ClaudeCodeAdapter（Developer AI）
- [x] GeminiCliAdapter（Reviewer AI）
- [x] CodexAdapter（将来用プレースホルダー）
- [x] AGENTS.md・session-log・コミットプレフィックス対応 (task-021)
- [ ] CLI出力パーサー + JSONリトライ機構 (task-023)
- [ ] CLI timeout / retry / cancel設計 (task-024)

### task-022: AI CLI → jobRunner 接続 ✅
- [x] Job型に aiCliProvider / aiCliPrompt / aiCliMode 追加 (388358d)
- [x] jobs.ts CreateJobBody 拡張・バリデーション強制（3フィールド全指定 or 全省略）(388358d)
- [x] jobRunner.ts に AI CLI 先行実行ブロック追加（SafeCommand 実行前）(388358d)
- [x] AI CLI 失敗時（blocked / exitCode !== 0 / throw）→ Job failed 早期リターン (388358d)
- [x] aiCliProvider なし既存 Job への影響ゼロを保証 (388358d)
- [x] テスト 5 ケース追加（285/285 pass）(388358d)
- [ ] contextFiles 拡張（Context Manager 連携）← 別 task

### 1-D: バックエンド実装
- [x] SQLite Storage 完全実装 (task-018)
- [ ] Backend: Project CRUD API (task-006)
- [ ] Backend: Task CRUD API (task-007)
- [ ] Backend: Job Queue API (task-008)
- [ ] 簡易認証 API token (task-014)
- [ ] Worker Job実行エンジン (task-009)
- [ ] Job状態遷移 + 復旧ロジック (task-016)
- [ ] Jobログ分離保存 (task-017)

### 1-E: ダッシュボード
- [ ] Mobile Dashboard基本画面 (task-012)
- [ ] Project作成画面 (task-013)
- [ ] Pending Approval UI (task-019)
- [ ] ReviewResult / QAResult API + 型 (task-015)

### Phase B: Task Watchdog ✅
- [x] 停滞検出（CommandKind 別閾値） — stallDetector.ts
- [x] Watchdog ループ — watchdog.ts
- [x] WatchdogEvent API — routes/watchdogEvents.ts

### Phase C: 通知 + ダッシュボード ✅
- [x] 通知ルーター（LINE / Slack） — notifier.ts
- [x] LINE アダプター — lineAdapter.ts
- [x] Slack アダプター — slackAdapter.ts
- [x] ダッシュボード集計 API — routes/dashboard.ts

---

## Review Orchestration / Decision Routing（判断レビュー層・仕様策定済み・段階実装予定）

**位置づけ:** Approval Gate（1-G）・AI Approval Level v2・Target Project Risk Scan v1などの
**Safety Gate / Risk Control層**（危険変更を検出・停止する安全チェック層）とは別の、独立した層。
本セクションが扱うのは、実装報告を読み、重要度・次工程・ChatGPTレビュー要否・CEO承認要否を
整理する**判断レビュー層**である。Safety Gate層のコンポーネント自体はこのセクションの対象外。

**仕様書:** [docs/multi_ai_step_review_flow.md](../docs/multi_ai_step_review_flow.md)

**目的:** Claude Sonnetの実装報告とSafety Gate層のfactsを読み、Gemini Flashが軽量な
Step単位の判断レビュー・重要度判定を行い、コミット前にFinal Review Packet（圧縮レビュー資料）を
ChatGPTが読んでコミット可否・次工程・CEO承認要否を整理する、という判断レビューフローを標準化する。

**Safety Gate / Risk Control層（既存・本セクションの対象外）:**

| 役割 | 対応する既存実装 | 状態 |
|---|---|---|
| Mechanical Safety Checks | `safetyVerifier.ts`（12項目チェック）・`approvalLevelClassifier.ts`（Mechanical Gate） | 実装済み (b159d73, 3b3d1fb) |
| Risk Scan | `targetProjectRiskScan.ts`（severity付き） | 実装済み・観察モードで接続済み (d16a709〜afab85c)。ログ観察期間中 |
| commitGate | `commitGate.ts`（reviewPolicy別必須成果物チェック） | 実装済み・未接続 (351840f) |
| 既存Gemini Reviewer（実行ブロック権限あり） | `preReviewer.ts` / `postReviewer.ts` / `reviewerAdapter.ts` | 実装済み・未接続 (a7d3f81)。**本セクションのGemini Flash Stepレビューとは別物** |

**Review Orchestration / Decision Routing層（新規概念が中心）:**

| 概念 | 役割 | 対応する既存実装 | 状態 |
|---|---|---|---|
| Gemini Flash Stepレビュー | Stepごとの軽量判断レビュー・重要度判定（停止権限なし） | 既存preReviewer/postReviewerとは別物として新規整理 | 未実装（新規概念） |
| Final Review Packet | ChatGPTに全ログを渡さず低コストに最終判断させる圧縮レビュー資料 | `ApprovalLevelResult`等の既存結果型を集約する生成関数が必要 | 未実装（新規概念） |
| ChatGPT最終判断レビュー | コミット前の判断整理・次工程設計・CEO承認要否判定（コードレビューではない） | `shouldEscalateToChatGpt()`（プレースホルダー） | 未実装（拡張ポイントのみ） |
| Review Transport Mode | 外部AIへの送信方法（handoff/api、初期推奨: handoff） | — | 仕様策定済み（仕様書20章） |
| Quota Policy | 無料枠切れ時の挙動（wait/handoff_fallback/paid_api_fallback） | — | 仕様策定済み（仕様書21章）。初期推奨: handoff_fallbackまたはwait、paid_api_fallbackは原則OFF |
| Low/Medium/High分類 | Review Orchestration層内の共通重要度基準 | `targetProjectRiskScanResult.highestSeverity`ベースで再設計予定 | 概念近似。再設計が必要（詳細は仕様書19-2章） |

**段階実装案（このセクションの下位ステップとして今後着手）:**
- [ ] Step R1: リスク分類を`targetProjectRiskScanResult.highestSeverity`ベースで再設計
- [ ] Step R2: Final Review Packet の型・生成関数を新規設計（既存の`ApprovalLevelResult` /
      `PreReviewResult` / `PostReviewResult` / `SafetyVerificationResult` /
      `TargetProjectRiskScanResult`を集約）
- [ ] Step R3: Gemini Flash Stepレビュー（新規・停止権限なし）の設計・実装、Review Transport Mode（初期: handoff）選択
- [ ] Step R4: commitGateのjobRunner接続（Safety Gate層・既存Step5は実装済みだが未接続）
- [ ] Step R5: ChatGPT最終判断レビューの実装（Review Transport Mode/Quota Policyに従う）
- [ ] Step R6: CEO承認UI・事後報告フローの設計

**ステータス:** 仕様策定完了（層分離・Review Transport Mode・Quota Policyを含む）。
Approval Gate（1-G）・AI Approval Level v2・Target Project Risk Scan v1をSafety Gate層として
土台にしつつ、独立したReview Orchestration / Decision Routing層として段階的に実装していく。

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

### VPS App Runtime Standard v1: /health and last-run reporting（VPS自作アプリ標準稼働仕様 v1）

**背景:**
VPS Doctor Lite の実reboot検証により、SSH再接続・hostname一致・uptime reset・Docker Up復帰・
failed service増加なし・reboot-required解消は確認できた。ただし最終ユーザー目線ではこれだけでは不十分。
本当に重要なのは「再起動前に稼働していた自作アプリが、再起動後も実際に稼働しているか」を確認できること。
Docker Up / systemd active / URL 200 だけでは、アプリ内部の主要処理が動いているか分からない。

**目的:**
- 自作アプリが再起動後も稼働しているか、VPS Doctor Liteから高確度で確認できるようにする
- 単なるHTTP 200ではなく、アプリ内部の状態・最終実行時刻・最終成功時刻を返す
- bot / worker / 定期処理 / 自動投稿 / 監視アプリなど、自動稼働アプリの復旧確認を標準化する
- 今後の自作アプリすべてに共通で実装できる運用標準にする

**標準仕様（今後AIチームOSで作る自作アプリに必須化）:**
- `/health` または `/api/health` エンドポイント（Next.js / APIアプリの場合は `/api/health` を優先）
- アプリ識別情報・起動時刻・最終heartbeat時刻・最終成功時刻・最終エラー時刻・現在ステータス
- VPS Doctor Liteが判定しやすいJSON形式

**最低限のレスポンス形式:**
```json
{
  "ok": true,
  "appName": "example-app",
  "appType": "web-worker",
  "version": "0.1.0",
  "environment": "production",
  "startedAt": "2026-07-02T16:00:00+09:00",
  "lastHeartbeatAt": "2026-07-02T16:58:00+09:00",
  "lastSuccessAt": "2026-07-02T16:57:30+09:00",
  "lastErrorAt": null,
  "status": "running",
  "message": "running"
}
```

**仕様書:** [docs/vps_app_runtime_standard.md](../docs/vps_app_runtime_standard.md)（Step V1/V2完了。標準エンドポイント・レスポンスJSON・フィールド定義・status/ok/HTTPステータスの関係・Next.js/Node worker実装案・VPS Doctor Lite連携イメージを記載）

**ステータス:** 仕様策定完了（Step V1/V2）。target-project側への実装・VPS Doctor Lite側の実装は別タスクとして着手予定

- [x] `/api/health` エンドポイントのレスポンス形式確定（仕様書参照）
- [x] status（running/degraded/error/stopped）と ok / HTTPステータスの関係確定（仕様書参照）
- [ ] app manifest のファイル形式決定
- [ ] app manifest の保存場所決定
- [ ] heartbeat送信先決定
- [ ] success/error event送信先決定
- [ ] systemd と Docker Compose のどちらを標準にするか決定
- [ ] logs の標準ディレクトリ決定
- [ ] 既存VPS Doctor / VPS Keeper 系アプリとの接続方法設計
- [ ] target-project側への実際の実装（別タスク・別プロジェクト）
- [ ] VPS Doctor Lite側の実装（別タスク・別プロジェクト）

---

*Updated: 2026-07-02*
