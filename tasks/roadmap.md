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
- [x] **仕様と実装の差異を修正**: `aiCliProvider`/`aiCliPrompt`/`aiCliMode`はJob型・APIバリデーションには
      存在していたが、`jobs.create()`のINSERT文に含まれておらず**DBへ実際には永続化されていなかった**
      （task-022導入時からの潜在バグ。AI CLI事前実行機能を使う全Jobが対象）。resume API実装時の調査で発覚し、
      専用カラム追加（`ai_cli_provider`/`ai_cli_prompt`/`ai_cli_mode`、既存`MIGRATION_STATEMENTS`パターン）で
      修正（コミット`92fe91b`）
- [ ] contextFiles 拡張（Context Manager 連携）← 「Project自動開発フロー」将来項目
      `project-auto-context-pack-wiring` で追跡する

### 1-D: バックエンド実装

**注記（2026-07-06実態確認）:** 以下は「該当ファイル・ルート登録・単体テストの存在」を実装済みの根拠とする。
E2Eでの動作確認・実運用確認はまだ行っていない（次タスク「MVP E2E疎通確認」で検証予定）。

- [x] SQLite Storage 完全実装 (task-018)
- [x] Backend: Project CRUD API (task-006) — 実装済み・テストあり（`apps/api/src/routes/projects.ts` + `projects.test.ts`）／E2E未検証
- [x] Backend: Task CRUD API (task-007) — 実装済み・テストあり（`tasks.ts` + `tasks.test.ts`）／E2E未検証
- [x] Backend: Job Queue API (task-008) — 実装済み・テストあり（`jobs.ts` + `jobs.test.ts`）／E2E未検証
- [x] 簡易認証 API token (task-014) — 実装済み・テストあり（`auth/apiToken.ts` + `apiToken.test.ts`）／E2E未検証
- [x] Worker Job実行エンジン (task-009) — 実装済み・テストあり（`jobRunner.ts`。本セッションでR3/R4まで拡張継続中）／実運用（実際のtarget-projectでの継続稼働）未確認
- [x] Job状態遷移 + 復旧ロジック (task-016) — 実装済み・テストあり（`JobStatus`型 + `rollbackInfo`自動生成ロジック）／E2E未検証
- [x] Jobログ分離保存 (task-017) — 実装済み・テストあり（`jobLogger.ts` + `jobLogger.test.ts`）／E2E未検証

### 1-E: ダッシュボード

**注記:** 同上（実装済み・テストありの根拠は「ファイル存在＋テスト存在」まで。E2E未検証）。

- [x] Mobile Dashboard基本画面 (task-012) — 実装済み（`apps/mobile/app/index.tsx`, 476行）／実機・実運用未確認
- [x] Project作成画面 (task-013) — 実装済み（`apps/mobile/app/create.tsx`, 199行）／実機・実運用未確認
- [x] Pending Approval UI (task-019) — 実装済み（`apps/mobile/app/approvals.tsx`, 328行）／実機・実運用未確認
- [x] ReviewResult / QAResult API + 型 (task-015) — 実装済み・テストあり（`routes/reviews.ts` + `reviews.test.ts`）／E2E未検証

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
| Risk Scan | `targetProjectRiskScan.ts`（severity付き） | 実装済み・観察モードで接続済み (d16a709〜afab85c)。観察結果は`review_observation.jsonl`へ永続化済み (cc9c95f)。ログ観察期間中 |
| commitGate | `commitGate.ts`（reviewPolicy別必須成果物チェック） | 実装済み・未接続 (351840f)。接続設計完了（仕様書6-2章）。**接続は保留**（本質的な原因は`reviewPolicy`のtarget_project向け不適合。再開条件はStep R4-C参照） |
| 既存Gemini Reviewer（実行ブロック権限あり） | `preReviewer.ts` / `postReviewer.ts` / `reviewerAdapter.ts` | 実装済み・未接続 (a7d3f81)。**本セクションのGemini Flash Stepレビューとは別物** |

**Review Orchestration / Decision Routing層（新規概念が中心）:**

| 概念 | 役割 | 対応する既存実装 | 状態 |
|---|---|---|---|
| Gemini Flash Stepレビュー | Stepごとの軽量判断レビュー・重要度判定（停止権限なし） | 既存preReviewer/postReviewerとは別物として新規整理。`geminiRouter.ts`（既存基盤）を呼ぶだけの軽量ラッパーとして実装予定 | 接続設計完了（仕様書6-1章）・実装未着手 |
| Final Review Packet | 既存レビュー結果・安全確認・報告を集約する受け皿（新しい判断者ではない）。結論先出し・非エンジニア可読・Report Translationとの相性を重視した15項目形式 | フォーマット設計完了（仕様書9章）。`ApprovalLevelResult`等の既存結果型を集約する生成関数は未実装 | 設計完了・実装未着手 |
| ChatGPT最終判断レビュー | コミット前の判断整理・次工程設計・CEO承認要否判定（コードレビューではない） | `shouldEscalateToChatGpt()`（プレースホルダー） | 未実装（拡張ポイントのみ） |
| Review Transport Mode | 外部AIへの送信方法（handoff/api、初期推奨: handoff） | — | 仕様策定済み（仕様書20章） |
| Quota Policy | 無料枠切れ時の挙動（wait/handoff_fallback/paid_api_fallback） | — | 仕様策定済み（仕様書21章）。初期推奨: handoff_fallbackまたはwait、paid_api_fallbackは原則OFF |
| Low/Medium/High分類 | Review Orchestration層内の共通重要度基準。target_project向けは`targetProjectRiskScanResult.highestSeverity`にそのまま対応、control repo向けは影響範囲による例示（仕様書11章） | `targetProjectRiskScanResult.highestSeverity`（既存実装）をtarget_project向けの正とする対応関係を明記済み | 設計完了（仕様書11章・11-1章。`ApprovalLevel`とは別軸であることも明記） |

**段階実装案（このセクションの下位ステップとして今後着手）:**
- [x] Step R1: リスク分類（Low/Medium/High）と Review Level（0〜3・実行主体ルーティング）の
      重複解消・関係整理（仕様書11章・11-1章。target_projectは`targetProjectRiskScanResult.highestSeverity`
      にそのまま対応、control repoは影響範囲による例示、`ApprovalLevel`とは別軸であることも明記）
- [x] Step R2（設計のみ）: Final Review Packetの役割・15項目フォーマット・結論先出し方針を設計（仕様書9章・10-1章）
- [x] Step R2（実装）: 上記フォーマットの型・生成関数を実装（`apps/worker/src/approvalLevel/finalReviewPacket.ts`。
      コミット3600ae3。jobRunner/commitGateへの接続はまだ）
- [x] Step R3（設計のみ）: Gemini Flash Stepレビューの接続設計 — 既存`geminiRouter.ts`基盤の再利用方針、
      Transport Mode（Gemini Flashは初期から`api`、ChatGPTは引き続き`handoff`）、呼び出しタイミング
      （Level 2のStep単位フロー）、渡す情報量（プロンプト前提量最適化に従う）、Final Review Packetへの
      格納ギャップ（`GeminiReviewKind`に`step_review`追加が必要）を整理（仕様書6-1章）
- [ ] Step R3（実装）: 軽量な入力/出力型の新規定義、`geminiRouter.ts`呼び出しラッパー関数、
      `GeminiReviewKind`への`step_review`追加、jobRunnerへの接続
- [x] Step R4（設計のみ）: commitGateの接続設計 — safetyVerifier/preReviewer/postReviewerが
      未接続のため今この時点で接続すると`allowed`がほぼ常にfalseになる、という重要な発見を記録。
      接続する場合はGemini Step Reviewブロック直後・isAtomic分岐直前、観察モード限定と結論
      （仕様書6-2章）。`jobRunner.ts`/`commitGate.ts`はCONTROL REPOSITORY保護対象のため今回は未編集
- [x] Step R4前提整理（設計のみ）: safetyVerifier/preReviewer/postReviewerの接続順序を整理
      （仕様書6-3章）。postReviewerは既存Risk Scan/Step Reviewと同じ入力で接続可能、
      safetyVerifierは12項目中8項目が既存情報で評価可能（残り4項目はtypecheck/test実行結果3項目・
      postReviewResultが必要な1項目でfail-closedのまま観察）、preReviewerは実装前タイミングへの接続と
      target_project向けpolicy判定という2つの未解決課題があるため別トラックに切り出し
- [x] Step R4-A（実装）: postReviewerの観察モード接続（Gemini Step Reviewブロック直後、
      既存post-diffデータを流用。blocked:trueでもJobを止めない。コミット5de0f15）
- [x] Review Observation Log（最小永続化）: Risk Scan/Gemini Step Review/postReviewの観察結果を
      `data/logs/review_observation.jsonl`へappend-only記録（`observationLog.ts`。コミットcc9c95f）。
      2-3章「効果検証可能性の原則」の是正実装 — 観察モードの結果が永続化されず後から評価できない
      問題を解消
- [x] Step R4-B（実装）: safetyVerifierの観察モード接続（R4-Aの後。typecheck/test実行結果は
      未指定のままfail-closedで観察。overallPassed:falseでもJobを止めない。コミット929efe8）。
      `review_observation.jsonl`に`safetyVerification.overallPassed`/`blockingFailures`/
      `supportedChecksCount`/`totalChecksCount`を追加記録。**注意**: `overallPassed:false`は
      TYPECHECK/RELATED_TESTS/FULL_TESTS未接続によるfail-closedを含む（危険検出とは限らない）。
      `blockingFailures`を見れば、本当の危険シグナルか未接続項目由来かを後から区別できる
- [ ] Step R4-C（実装・**保留**）: commitGateの観察モード接続（仕様書6-2章の設計に基づく）。
      **保留理由（preReviewer調査により更新）**: 単に「preReviewer未接続」ではなく、より本質的には
      `commitGate`が依存する`reviewPolicy`（`approvalLevelResult.reviewPolicy`）がcontrol repo基準の
      分類器であり、target_project向けJobのリスク・必要成果物判定として信頼できないこと
      （Step6-B0で既知）が真のボトルネック。preReviewerだけ接続しても`allowed:false`ノイズや
      必須成果物判定のズレは解消しない。MVP前の開発速度を優先し、いったん見送る（破棄ではない）。
      **再開条件**: MVP後、またはtarget_project向け`reviewPolicy`/commitGate必須成果物設計を
      見直した後
- [ ] preReviewer接続設計（別トラック・調査完了・**接続は見送り**）: 実装前タイミングへの接続、
      target_project Jobのreviewpolicy判定という2課題に加え、調査の結果
      (1) postReview/Risk Scanと責務が重複しやすい（`planText`の実質が`job.aiCliPrompt`となり
      postReviewと判断材料がほぼ同じ）、(2) AI CLI実行前はchangedFiles/diffText/Risk Scan severity
      が存在せず既存の呼び出しゲート条件が使えない、(3) 観察モードでは「実装前に止める」という
      preReviewer本来の価値が活きない、ことが判明。破棄ではなく、MVP後の設計再検討対象として扱う
- [ ] Step R5: ChatGPT最終判断レビューの実装（Review Transport Mode/Quota Policyに従う）
- [x] Step R5-A（実装）: read-only Codex Reviewer Adapterの追加 — 既存`reviewerAdapter.ts`の
      `createReviewerAdapter()`拡張ポイント（従来`claude`/`chatgpt`は未実装エラーのみ）に`codex`を追加。
      既存の`createAiCliAdapter`/`buildReviewPrompt`/`parseReviewerResponse`を再利用し、新しい
      プロンプト生成・JSONパーサーは作っていない（`mode:'review'`によりCodex CLIは
      `--sandbox read-only`で起動。CLI失敗・blocked・不正JSON・例外はすべて`blocking`へfail-closed。
      コミット`fe56b8e`）。Reviewerが使うモデルは`gpt-5.6-sol`を明示指定（`AiCliRequest.model`は任意項目で、
      実装用Codex実行には適用しない。コミット`c3ff36a`）。
      **本番Jobフロー（`jobRunner.ts`）への接続は未実施**（現状どこからも呼ばれていない）。
      Step R5がChatGPTによる最終判断レビューの実装であるのに対し、本項目はその判断レビュー枠を
      別ベンダーのReviewerで担えるようにするAdapter追加であり、Step R5を置き換えるものではない。
      **スマホ操作MVP必須ではないため、Phase 2の項目4（Task作成フロー）を優先し、接続は保留**
      （破棄ではない。再開条件: スマホ操作MVP完了後）
- [ ] Step R6: CEO承認UI・事後報告フローの設計

**ステータス:** 仕様策定完了（層分離・Review Transport Mode・Quota Policyを含む）。
Approval Gate（1-G）・AI Approval Level v2・Target Project Risk Scan v1をSafety Gate層として
土台にしつつ、独立したReview Orchestration / Decision Routing層として段階的に実装していく。

**役割分担・Review Level（Codex/Claude/Gemini/ChatGPT/Human）:** 仕様書2章・2-2章・11-1章に
Codex（通常実装）/Claude（設計・危険箇所）/Gemini（低コストなレビュー・監査レイヤー: Risk Review・
Alignment Review・Meta Review・preReview・postReview・Report Translation）/ChatGPT（重要判断・
コミット前判断）/Human・CEO（最終判断）の役割分担とReview Level 0-3（実行主体ルーティング）を
追記済み。既存のMeta Reviewer・Risk Scan・Alignment Check・preReviewer/postReviewerを流用し、
新規レビュー機構は追加していない。

---

## Phase 2: MVP実装

目的: Project Creation Flow を動かす

**注記（2026-07-06実態確認）:** 個別コンポーネントは実装済み・APIとして登録済みだが、
「仕様書入力からDashboard更新までの一連の流れが実際につながって動くか」（Project Creation Flow
全体のE2E疎通）はまだ検証していない。次タスク「MVP E2E疎通確認」で確認する。

- [x] 仕様書入力 → Project Memory生成 — 実装済み（`routes/ctoAi.ts` POST `/api/cto/analyze`、
      `specAnalyzer.ts`/`projectMemoryWriter.ts`）／E2E未検証
- [x] CTO AI: Roadmap生成 — 実装済み（`roadmapGenerator.ts`/`roadmapWriter.ts`、
      POST `/api/cto/generate-roadmap`）／E2E未検証。**注意: 生成物はtarget-project側の
      Markdown（`docs/roadmap.md`・`tasks/task_graph.md`）のみで、DB上のTaskレコードは
      作られない**（`storage.tasks.create()`を呼ぶのは`POST /api/tasks`のみ）。
      「Task自動生成」は未実装（下記「Project自動開発フロー」参照）
- [x] Context Manager AI: Context Pack生成 — 実装済み（`routes/contextPack.ts`）／E2E未検証
- [x] Developer AI: 実装Job実行（Sandbox経由） — ルートは実装済み（`routes/developerAi.ts`）／E2E未検証。
      **注意: `runDeveloperAi()`は`mockRun:true`のみ動作し、`mockRun:false`（本番実行）は
      意図的に未実装でthrowする**（`developerAiOrchestrator.ts`。本番はJob Queue経由=
      `POST /api/jobs`→Workerに委譲する設計）
- [ ] Meta Reviewer AIの自動実行（全PR前に） — 1-Bで基盤は実装済み（GitHub Actions
      `meta-review.yml`）だが、ローカル開発時の自動実行は`postTestHook.ps1`が`exit 0`のみで
      停止中（R-006既知課題）。**実運用未確認のまま**
- [x] Summary Engine: Dashboard自動更新 — 実装済み（`routes/summaryEngine.ts`）／E2E未検証

### 次タスク: MVP E2E疎通確認（E2E-1〜E2E-4 実施済み）

- [x] 仕様書入力→CTO AI→Context Pack→Developer AI→Job実行→Review→Dashboard更新の一連の
      流れが実際につながって動くかを確認する（Project/Task/Job CRUD API・API token認証・
      Mobile Dashboard・Pending Approval UIを含む）。E2E-1（API/DB疎通）・E2E-2（Worker Job実行）・
      E2E-3（AI routes mock疎通）・E2E-4（Android実機Expo Go起動・API疎通・Project一覧表示・
      主要ボタン操作）まで確認済み（コミット be0a5b5〜9b3121c）。Project作成画面・Pending Approval UIの
      個別操作確認、Worker/API/Mobile同時起動での通し確認は未実施

### Project自動開発フロー（2026-07-29調査）

**目的:** Project作成後、AIがロードマップとTaskを作り、原則として完成まで自動で進む状態にする。
CEOが通常Taskを一件ずつ手作業で登録する設計にはしない。通常のチェックポイントでは開発を止めず、
Goal変更・重大仕様変更・高リスク操作など経営判断が必要な場合だけ既存Approval Gateで停止する。

**現状（実コード調査結果）:** 個別部品は存在するが、**Project作成→完成までの自動連鎖は未接続**。
`POST /api/cto/generate-roadmap`はtarget-project側Markdownを書くだけでDB上のTaskを作らず、
TaskからJobを作る処理も、Job完了後に次Taskへ進む処理も存在しない
（Workerは`updateJob()`でJobのみ更新し、Task status更新も次Job生成も行わない）。

**実装順（2026-07-30確定。Step 2設計調査で判明した安全要件を反映）:**

自動連続実行を有効化する前に、**AI実行プロセスから本体DBを隔離し、Worker結果をAPI障害時にも
失わず、本体DBを書き込めるのはAPIだけにし、DB事故から復旧できる**状態を先に作る。

1. `project-auto-worker-trust-boundary` — Worker安全境界・結果引き渡し設計
2. `project-auto-worker-outbox` — Worker永続Outbox・結果受信基盤
3. `project-auto-db-safety` — 本体DB安全・復旧基盤
4. `project-auto-task-job-chain` — Task→Job自動生成と連続実行
5. `project-auto-recovery-e2e` — 障害復旧E2E・自律実行有効化
6. 将来: `project-auto-worker-core-split` — Worker安全コアの物理分離
7. 将来: `project-auto-context-pack-wiring` — Context Pack実接続
8. 将来: `project-auto-multi-worker` — 複数Worker対応

**2と3は1の完了後に並行実装できる。4は2と3の両方が完了するまで開始しない。**
5の完了をもって自律連続実行を有効化する。

<!-- roadmap:id=project-auto-data-model state=done -->
1. [x] **Step 0: データモデル整合（完了）** — Task識別子・phase・
      `roadmap_active`・固定workspace制約をCEO承認済み設計どおり実装済み
      （コミット`2a1daa2` feat(api): add roadmap task metadata、
      `beb6612` fix(orchestration): enforce single active workspace）。
      Step 1（bulk upsert・dependencies UUID変換・ロードマップからのTask生成・
      Context Pack接続）は未着手。
      設計方針（2026-07-29確定。Codex `gpt-5.6-sol` read-onlyレビュー反映済み）:
      - **Task識別子**: `Task.id`はUUIDのまま維持し、nullableな`roadmapTaskKey`列を追加する。
        `Job.taskId`・`approval_requests`・`review_results`・`qa_results`・Mobileの`/tasks/[id]`が
        すべてUUID依存のため、外部指定IDへの変更は広範囲の破壊とbackfillを伴う。対応表は作らない。
        一意性は`(project_id, roadmap_task_key)`で担保する（SQLiteはNULL同士を重複と扱わないため、
        手動Task＝NULLは何件でも共存できる）。**`roadmapTaskKey`は`POST /api/tasks`では受け付けず、
        内部のロードマップ保存処理でのみ設定する**（手動Taskによるキー占有を防ぐため）
      - **phase**: nullableな`phase INTEGER`列をtasksへ追加する。Phase完了検知をDBクエリで完結させる。
        Markdown再解析は脆く、`targetProjectRoot`を別途要するため採らない。
        **`phase=NULL`を「ロードマップから外れた」印として兼用しない**（手動Taskも`phase=NULL`で
        意味が二重になり、元のphaseも失われるため）。代わりに
        **`roadmap_active INTEGER NOT NULL DEFAULT 0`**（DEFAULTは0）を追加し、phaseは元の値を
        保持したまま`roadmap_active=0`で非アクティブ化する。
        **手動Taskと既存Taskは0**、ロードマップ同期で作成・再登場したTaskだけ明示的に1にする。
        `roadmapTaskKey`がNULLのTaskはPhase判定へ含めない。
        （「現行ロードマップへの所属」と「仕様フィールドを更新してよいか」は別軸として扱う）
      - **estimatedComplexity**: **DB列として保存しない。** `buildContextPack()`本文生成に影響せず
        （`contextManager.ts`では型定義に現れるのみ）、必要なのは`routes/contextPack.ts:23`の
        リクエスト必須要件を満たすことだけ。DB TaskからContext Packを作る際は`'medium'`固定を渡す。
        ロードマップ生成時のMarkdown出力は従来どおり`GeneratedTask`の値を使う（現状維持）
      - **Project↔workspace**: 新規列を追加しない。`Project.targetProjectRoot`は持たない。
        `POST /api/cto/generate-roadmap`のbodyに`projectId`を追加するのみ。workspaceはデプロイ設定
        （`/workspace/target`）として扱う。MVP制約として**`status='running'`のProjectを同時1件に制限**し、
        `POST /api/projects`（`status`を任意指定可能。`routes/projects.ts:11`）と
        `PATCH /api/projects/:id`の**両方**で検証する。Workerの`fetchQueuedJob()`にも
        `project.status === 'running'`フィルタを追加する
      - **再生成時のTask更新方針**: 判定基準はTask.statusではなく**Jobの実在と状態**を主とする
        （自動フローからTask.statusを同期する呼び出しが無く、実質`pending`のままのため。
        ただしAPI自体は`status`を受け付ける: `routes/tasks.ts:23,36`）。
        `queued`/`running`/`blocked`のJobが**1件でも**あれば進行中とみなす（最新Jobだけで
        判定しない。`POST /api/jobs`に重複active Job防止が無く併存し得るため）。
        更新可否: (a)Jobが1件も無く**かつ**`Task.status==='pending'` → 全フィールド更新可、
        (b)進行中 → 更新しない、(c)全Jobがterminal（success/failed）→ 仕様フィールドは更新しない、
        (d)Jobなしだが`status!=='pending'` → 異常状態としてスキップ・ログ。
        **ロードマップから消えたTaskがactive Job（queued/running/blocked）を持つ場合は、
        そのTaskだけ残す部分同期を行わず、ロードマップ同期全体をfail-closedで失敗させる。
        DBを一切変更せず、競合内容を報告する。**
        最新Job判定には`ORDER BY created_at DESC, rowid DESC`のtie-breakが必要
        （`created_at`のみでは同一ミリ秒で順序不定。`sqlite.ts:322`）。
        **これらの同期処理はStep 1の実装範囲であり、Step 0では作らない**
      - **dependencies**: 1トランザクション内の2パス（全件挿入→`roadmapTaskKey`→UUID変換）で解決する。
        変換前に重複キー・自己参照・循環・存在しない依存先を全件検証し、1件でも不正ならロールバックする。
        解決スコープは同一Project内に限定する
      - **追加するDB列（tasks・最終3列）**: `roadmap_task_key TEXT NULL`／
        `phase INTEGER NULL`／`roadmap_active INTEGER NOT NULL DEFAULT 0`。
        制約として`UNIQUE(project_id, roadmap_task_key)`と`CHECK (roadmap_active IN (0,1))`を付ける。
        公開APIの`POST /api/tasks`・`PATCH /api/tasks/:id`ではこの3フィールドを受け付けない
      - **migration**: `MIGRATION_STATEMENTS`（`ALTER TABLE ADD COLUMN`専用）で3列を追加。
        **UNIQUE INDEXはこの仕組みでは追加できず、`CREATE_TABLES`へ書いても既存DBでは失敗する**
        （`db.exec(CREATE_TABLES)`が`runMigrations()`より先に走るため。`sqlite.ts:143-144`）。
        `runMigrations()`の**後**に`CREATE UNIQUE INDEX IF NOT EXISTS`を実行する処理を別途追加する
      - **役割定義（正本の置き方）**: DBをProject計画全体の正本とは定義しない。
        (a)CTO AIが生成した構造化ロードマップ＝**計画内容の入力**、
        (b)target-projectの`tasks/task_graph.md`＝**計画のMarkdown表現**、
        (c)DB Task＝**実行状態を持つ投影**。
        Step 1では同じ検証済みロードマップからDB TaskとMarkdownの両方を生成し、
        **片方だけ成功した場合は成功扱いにしない**。SQLiteトランザクションはMarkdown書き込みを
        ロールバックできない（`roadmapWriter.ts:93`が2ファイルを直接上書き）ため、
        **再実行で安全に修復できる冪等設計**とする
      - **既知の積み残し（Step 0の範囲外・Step 1/2で解く）**: summaryEngineは`| task-001 |`形式で
        Markdownを照合するためUUIDでは一致しない（`summaryEngine.ts:148`）。初回Jobの`workingDir`調達。
        `validateTargetRoot()`は任意の絶対パスを許し固定workspaceを強制していない
        （`pathGuard.ts:47`）。`generate-roadmap`/`analyze`は他Project実行中でも同じworkspaceへ
        書けるためWorkerフィルタだけでは競合を防げない。Project activation（runningへ遷移させる）
        担当がMobileにもコードにも無い。running→paused時のdrain semantics。
        複数Worker時のatomic claim
      **完了条件**: 上記の持ち方（識別子・phase・roadmap_active・estimatedComplexity・workspace制約・
      dependencies解決・再生成ポリシー）がCEOに採択され、既存Task/Job/resume/Mobileルートを
      壊さないことが確認されていること。実装着手はCEO承認後
<!-- roadmap:id=project-auto-roadmap-sync state=done -->
2. [x] **ロードマップ→Taskレコード自動生成（完了）** — `POST /api/cto/generate-roadmap`が
      生成→事前検証（422）→`storage.tasks.syncRoadmapTasks()`によるDB同期（409）→
      Markdown出力の順で動作し、同じ生成結果からDBとMarkdownの両方を作る
      （コミット`0a80437` feat(api): sync roadmap tasks transactionally、
      `e58040c` feat(cto): persist generated roadmap tasks）。
      **独立二重レビュー（Sonnet・Codex）で発見された安全性問題を修正済み**
      （コミット`32facd2` fix(api): reject conflicting roadmap task revisions）:
      Job履歴のある・status!=='pending'の「仕様変更不可」Taskは、書き込み前のプリフライトで
      DB仕様と入力仕様（title/description/phase/assignee/allowedPaths/acceptanceCriteria/
      dependencies）を比較し、1件でも不一致があれば同期全体をfail-closedで拒否する
      （409、DB・Markdownとも無変更）。空`tasks`配列は422で拒否し既存Taskの一括非アクティブ化を防ぐ。
      Task→初回Job生成・自動連続実行・Project完了判定・CEO Alignment Checkpoint・
      Context PackのJob実行時接続は未着手（Step 2）。
      **Step 2の完了条件に含めるべき事項**（本Stepのレビューで判明・未解決のまま残す設計上の制約）:
      DB Task同期とMarkdown保存の両方が成功するまでJobを作らない／Markdown保存失敗時はJobを作らない／
      再実行時、履歴のあるTaskの仕様変更は本Stepの実装どおり409で拒否する／
      未着手Taskは冪等に再同期できる
<!-- roadmap:id=project-auto-worker-trust-boundary state=in_progress -->
3. [ ] **Worker安全境界・結果引き渡し設計** — 自動連続実行を実装する前に、信頼境界を確定する
      設計項目（実装を伴わない）。**基本方針**: AI CLI実行プロセスには本体DBファイル・DB認証情報・
      管理APIトークンを渡さない／Workerにも本体DBファイルをマウントせず任意のDB操作を許可しない／
      **本体DBを書き込めるのはAPIだけ**とする／Task状態更新と次Job生成はAPI側の冪等な進行管理で行う／
      MVPではWorkerは1インスタンスに限定する。
      **確定すること**: Worker安全コアに残す責務（実行・Permission Guard・File Change Guard・
      Approval Gate・Risk Scan・fail-closed）と、外側へ分離する進行管理責務（Task選定・
      次Job生成・Context Pack構築）の線引き／AI実行プロセス・本体API・本体DB・Worker Outboxの
      権限境界／結果イベントとACKの契約／CONTROL REPOSITORY保護対象の再分割方針。
      **現状の実測根拠（2026-07-30 Step 2調査）**: Workerは`updateJob()`で
      `PATCH /api/jobs/:id`へ直接結果を書くだけで永続キューを持たず、**API停止中にJobが完了すると
      結果が失われる**（`apps/worker/src/index.ts:63-76,100-114`）。`recoverStaleJobs()`は起動時に
      **全Projectのrunning Jobを無条件でfailedへ落とす**ため、Workerを2つ起動すると互いの実行中Jobを
      破壊する（`apps/worker/src/jobStateManager.ts:31-66`）。`apps/worker/src/index.ts`・
      `jobRunner.ts`・`guards/permissionGuard.ts`は**CONTROL REPOSITORY（AI編集禁止）**であり、
      Worker側へ継続処理を足す案は採れない。
      **Context Pack接続と複数Worker対応はこの項目に含めず、別項目（将来項目）へ分離する。**
      **Worker OutboxとCONTROL REPOSITORY保護対象の関係**: Worker Outboxは、AI実行結果の確定直後に
      保存する必要がある。実装時にCONTROL REPOSITORY保護対象（`index.ts`/`jobRunner.ts`/
      `permissionGuard.ts`等）への接続が必要な場合は、対象ファイル・変更箇所・許可する入出力を
      **事前に確定**し、CEOが承認した限定差分だけを変更する（Worker全体の保護解除は行わない）。
      外側の進行管理からApproval Gate・Risk Scan・permissionGuard・fail-closed処理を
      迂回できないこと。**この接続口の設計承認を、`project-auto-worker-outbox`実装開始の
      完了条件に含める**（Worker安全コアの物理分離＝将来項目`project-auto-worker-core-split`とは別。
      今回必要なのはOutbox用の最小接続口であり、Worker全体の物理的な再分割は将来項目のまま）。
      **完了条件**: 信頼境界とデータフローが文書化されている／Workerが持つ権限と持たない権限が明確／
      本体DBへの直接アクセス禁止が明記されている／Outboxと結果受信APIの責務が確定している／
      Task→Job自動生成が依存するインターフェースが確定している／
      Outbox用の最小接続口（対象ファイル・変更箇所・許可する入出力）がCEOに承認されている
<!-- roadmap:id=project-auto-worker-outbox state=planned -->
4. [ ] **Worker永続Outbox・結果受信基盤** — 依存: `project-auto-worker-trust-boundary`。
      **着手条件**: Worker安全境界設計で、Outboxへ結果を書き込む接続口が承認済みであること。
      保護対象変更が必要な場合は、実装前にCEOが具体的な差分を承認すること。
      保護対象ルールを包括的に緩和しないこと。
      **Worker側**: 実行結果を専用の永続Outboxへ保存する（本体DBとは分離し、未送信結果だけを保持）／
      `completionEventId`等で結果を一意識別する／APIからACKを受け取るまでOutboxの結果を削除しない／
      通信失敗・429・5xx・タイムアウト時はバックオフして再送する／Worker再起動後も未送信結果を再送する／
      **未送信結果が残っている間は新しいJobを取得しない**。
      **API側**: 狭い内部Job結果受信口だけを提供する／同じ結果が再送されても一度だけ反映する（冪等）／
      許可されたJob状態遷移だけを実行する（既存`ALLOWED_TRANSITIONS`に従う）／
      任意のTask・Project・DB操作は受け付けない。
      **完了条件**: API停止中にWorkerが完了しても結果が失われない／Worker再起動後に未送信結果を
      再送できる／同じ結果を複数回送ってもDB反映は一度だけ／APIがACKするまで次Jobへ進まない／
      Workerから本体DBへ直接アクセスできない
<!-- roadmap:id=project-auto-db-safety state=planned -->
5. [ ] **本体DB安全・復旧基盤** — 依存: `project-auto-worker-trust-boundary`。
      `project-auto-worker-outbox`とは**並行実装可能**。
      本体DBを書き込める主体をAPIへ限定する／任意SQLを受け付けない／重要状態変更の監査ログ／
      定期バックアップ／世代管理／復元手順／**実際の復元テスト**／重要データの物理削除を
      通常フローから分離する／migration・一括削除の管理権限を分離する。
      **完了条件**: バックアップが自動作成される／世代管理が機能する／復元テストが成功している／
      重要な状態変更を追跡できる／AI・Workerが本体DBを直接削除できない
<!-- roadmap:id=project-auto-task-job-chain state=blocked -->
6. [ ] **Task→Job自動生成と連続実行** — 依存: `project-auto-worker-outbox` と
      `project-auto-db-safety` の**両方**。安全基盤が未完成のため実装項目としては着手不可。
      ただし**設計調査は継続中**（2026-07-30時点でCodex `gpt-5.6-sol` read-only独立レビュー実施済み）。
      初回Jobの自動生成と、Job完了後に次Taskへ自動で進む仕組み
      （手動の`POST /api/jobs`とblocked Jobの`resume`は既に存在する。無いのは「自動生成」と「自動継続」）。
      **設計方針**: DB Task同期とMarkdown保存の**両方**が成功するまで初回Jobを作らない／
      Worker結果がAPIへ確定反映されるまで次Jobを作らない／API側の**薄いapplication service**が
      Task状態更新と次Job生成を担当する（新しい常駐Orchestratorは作らない）／
      Task単位でqueued/running Jobの重複を**DB制約**（partial unique index）で防止する／
      paused・blocked・failed・Approval待ちでは継続しない／MVPでは単一Workerのみ／
      **Context Pack完全接続は含めない**。
      **既知の穴（実コード検証済み）**: `POST /api/jobs`に同一Taskのqueued/running重複チェックが無く、
      `projectId`とTaskのProjectの一致検証も無い（`routes/jobs.ts:122-137`）。
      `Task.status`を自動更新するコードが存在せず事実上`pending`のまま。
      `approval_requests`に`project_id`列が無く`findWaiting()`が全Project横断で返るため、
      停止条件では`tasks`とJOINしてProject限定する必要がある。
      API側`TARGET_ROOT`は環境変数で可変だがWorker側は`/workspace/target`ハードコードのため、
      不一致時は全Jobがblockedになる（Job生成時にfail-closedで検出する）。
      `canExecuteCommands: false`のassignee（`cto_ai`/`context_manager`/`reviewer_ai`）が
      最小候補になると同じTaskを選び続けて永久停止するため、ロードマップ検証側で拒否する。
      **完了条件**: 1つのProjectで複数Taskが順に自動実行され、二重生成・途中失敗時に
      安全側で停止すること（既存`resumeBlockedTask()`の原子的チェック＋作成パターンを流用）
<!-- roadmap:id=project-auto-recovery-e2e state=planned -->
7. [ ] **障害復旧E2E・自律実行有効化** — 依存: `project-auto-task-job-chain`。
      **確認シナリオ**: API停止中にWorkerが完了／API復旧後に結果再送／ACK消失による重複送信／
      Worker再起動／API再起動／Outbox書き込み後のクラッシュ／DB反映後・ACK前の通信切断／
      paused Project／blocked・failed・Approval待ち／同一Taskへの同時Job生成／
      バックアップからの復元。
      **完了条件**: 結果消失がない／二重反映がない／二重Job生成がない／復旧後に正しい位置から
      再開できる／異常時はfail-closedで停止する。
      **この項目の完了をもって自律連続実行を有効化する。**
<!-- roadmap:id=project-auto-completion-detection state=planned -->
8. [ ] Project全体の完了判定: 全Task完了をもってProject完了とみなす判定。
      **既知の穴**: `ProjectStatus`に`completed`が無い（`draft/running/paused/archived`のみ。
      `types/project.ts:3`）ため、計算値にするか状態として持つかの決定が必要。
      **完了条件**: 完了/未完了がAPIで取得でき、Mobileから確認できること
<!-- roadmap:id=project-auto-ceo-alignment state=planned -->
9. [ ] CEO Alignment Checkpoint: Phase完了・主要機能完成時にサマリーと当初計画との差分をCEOへ通知する。
      **通知後も開発は継続し、通常チェックポイントでは停止しない**。既存の`notifier`
      （LINE/Slack）・`summaryEngine.ts`・Approval Gateの再利用を前提とし、新しい停止Gateは作らない。
      **完了条件**: Phase完了時にCEOへ通知が届き、開発が止まらないこと。CEOが修正指示を返す経路は
      「追加開発指示（追加Task作成）」を使う

**将来項目（Step 2系の完了後に個別判断。今回は着手しない）**

<!-- roadmap:id=project-auto-worker-core-split state=deferred -->
1. [ ] **Worker安全コアの物理分離** — CONTROL REPOSITORY保護対象を「安全コア」単位へ縮小する。
      実行・Approval・Risk Scan・fail-closedは保護対象として残し、Context Pack構築・Task選定・
      進行管理は保護対象外へ外部化する。**外側から安全機能を迂回できないインターフェース**を作ることが
      前提条件。`project-auto-worker-trust-boundary`で決めた再分割方針を実際に適用する項目。
      現在は`apps/worker/src/index.ts`・`jobRunner.ts`・`guards/permissionGuard.ts`が
      まとめて編集禁止のため、進行管理の変更が安全コアの変更と不可分になっている
<!-- roadmap:id=project-auto-context-pack-wiring state=deferred -->
2. [ ] **Context Pack実接続** — `buildContextPack()`が集めた`relevantFiles`は現在AI CLIへ届いていない。
      `jobRunner.ts:394`が`contextFiles: []`をハードコードしているため
      （コメント: 「task-023 で Context Manager 連携後に拡張」）、AIへ渡るのは`aiCliPrompt`のみ。
      **保護対象（CONTROL REPOSITORY）の変更を伴うため独立項目として扱う**。
      Step 2の自動Job生成では接続せず、プロンプトはTaskフィールドから決定論的に構築する。
      接続時は秘密情報検査とサイズ上限を必須とする（`gatherRelevantFiles()`は絶対パスの
      `allowedPaths`を検証せず読むため、`validateAllowedPaths()`相当の事前検証が要る）。
      1-F「contextFiles 拡張（Context Manager 連携）」はこの項目で追跡する
<!-- roadmap:id=project-auto-multi-worker state=deferred -->
3. [ ] **複数Worker対応** — atomic Job claim／Worker ownership・lease／stale recoveryのWorker識別／
      単一Worker制約を解除する条件の確定。現在は`recoverStaleJobs()`が起動時に全Projectの
      running Jobを無条件failedにするため、Workerの2重起動は互いの実行中Jobを破壊する
      （`jobStateManager.ts:31-66`）。またWorkerのqueued Job取得と`running`更新が別リクエストのため
      atomicにclaimできない。MVPは単一Worker前提を維持する

### スマホ操作MVP残タスク（2026-07-21整理）

**目的:** CEOがスマホだけで「開発指示を出す→Project/Task/Jobを確認する→進捗を見る→危険操作は承認で
止まる→承認/却下する→結果・失敗理由を見る→必要なら再指示する」という一連のサイクルを完結できる状態にする。
スマホ操作MVPの定義・現状・不足機能の詳細な整理は `docs/PROJECT_CURRENT_STATE.md`「スマホ操作MVPの現在地」を参照。

**MVP必須（このセクションの5項目）:**

<!-- roadmap:id=mobile-approval-role-docs state=deferred -->
1. [ ] 2種類の承認の役割整理とMobile導線設計 — **Mobile導線は実装完了・文書整理のみ未完**。
   Project単位承認（`/api/approvals/pending`）とTask/Job単位Approval Gate
   （`/api/approval-requests/waiting`）は、統合せず併存させる形で`approvals.tsx`に実装済み
   （一覧取得・承認/却下操作とも動作）。**未完了なのは両者の役割・使い分けの文書化のみ**で、
   これはMVP必須ではなく非ブロッキング（スマホ操作サイクルは現状の併存実装で完結するため、
   項目4の後またはMVP後に実施してよい）
<!-- roadmap:id=mobile-task-job-detail-ui state=done -->
2. [x] Task/Job一覧・詳細画面（Mobile） — 完了。Task一覧（`tasks.tsx`）・Task詳細（`tasks/[id].tsx`、
   Task情報・Job履歴・承認履歴を表示）を実装（コミット`0b91eac`, `a76a790`）
<!-- roadmap:id=mobile-approval-gate-ui state=done -->
3. [x] Task/Job単位Approval GateのMobile UI連携 — 完了。`approvals.tsx`が`/api/approval-requests/waiting`
   から取得し、`/api/approval-requests/:id/status`で承認/却下操作まで実装済み
<!-- roadmap:id=mobile-task-create state=planned -->
4. [ ] 追加開発指示（追加Task作成）画面（Mobile） — **スマホ操作MVPの現在の主要残タスク**。
   通常のTaskはProject作成後にAIが自動生成する想定（下記「Project自動開発フロー」参照）であり、
   この画面はCEOが**既存Projectへ後から要望を追加する入口**（追加機能・改善・不具合・調査・
   完成後アップデート）と位置づける。CEOが通常Taskを一件ずつ手作業で登録する設計にはしない。
   現状`create.tsx`はProject作成のみで、Project内にTaskを追加する導線がスマホ側にない
<!-- roadmap:id=mobile-task-resume-ui state=done -->
5. [x] 再実行・追加指示UI（Mobile） — 完了。Task詳細画面に「追加指示して再開」機能を実装
   （`POST /api/tasks/:id/resume`。コミット`c90d50e`, `d184d87`）

**セキュリティ残タスク（2026-07-29 Codexレビューで発見。MVP必須5項目とは別枠）:**

- [ ] MobileがAPI tokenの`Authorization`ヘッダーを送っていない — `apps/mobile/app/`の全fetchに
      `Authorization`ヘッダーが無く、API側で`API_TOKEN`を設定すると`apiToken.ts`のpreHandlerが
      全リクエストを401で弾く。**現在動作しているのはAPI token未設定時のみ**。
      VPS常駐（外部公開）へ進む前に必須。403行目「認証強化の要否確認」は方式の強化検討であり、
      この「そもそもヘッダーを送っていない」問題とは別。
      **完了条件**: `API_TOKEN`を設定した状態でMobileの主要操作（Project一覧・作成・承認・
      Task詳細・resume）が通ること

**MVP後または別タスク扱い（既存バックログ通り。変更なし）:** Dashboard/approvals間の画面遷移遅延調査、
Dashboardの`ScrollView`/N+1 fetch改善、Project詳細画面（`ProjectCard`タップ遷移）、開発DBテストデータ
（`Projects (559)`等）整理 — いずれも本セクション追加より前から「Phase 3: 品質・安定化」に記載済みの項目
であり、優先度・扱いは変更しない。

**後続Phase扱い（既存バックログ通り。変更なし）:** VPS常駐運用化（Docker化・HTTPS化・認証強化・
ヘルスチェック・ログ保存・再起動耐性）、将来アーキテクチャ移行（Health/Diagnosis/Research/Experiment/
Evolution等）— いずれも本セクション追加より前から記載済みの後続Phase項目であり、優先度・扱いは変更しない。

---

## Phase 3: 品質・安定化

目的: 継続的に開発できる状態にする

- [x] Roadmap Progress Automation（`tasks/roadmap.md`の進捗状態管理と`docs/PROJECT_CURRENT_STATE.md`
      「スマホ操作MVPの現在地」の要約同期を、LLMではなく決定論的なコードで行う運用基盤。
      実装は`apps/worker/scripts/roadmap/`。`pnpm roadmap:update|sync|check`で操作）
  - [x] 第1段階: update / sync / check CLIとCurrent State生成ブロック（roadmap項目への
        `<!-- roadmap:id=... state=... -->`メタデータ付与はまず「スマホ操作MVP残タスク」の
        5項目のみに段階導入。全項目への一括展開はしていない）
  - [x] 第2段階: 既存の開発完了・検証フローへの最小接続（A+B構成、完了）
        - [x] B: `pnpm verify`（`pnpm -r typecheck && pnpm -r test && pnpm roadmap:check`）を
              package.jsonへ追加。既存の`typecheck`/`test`/`roadmap:*`スクリプトは無変更
        - [x] A: AGENTS.md Q12へルール追記（開発タスク開始時のroadmap影響確認・
              進捗変化時のroadmap更新・`pnpm roadmap:update/sync`の使用・完了報告前の
              `pnpm verify`実行・完了報告への対象ロードマップ項目/最終state記載）。
              CEOの具体的diff明示承認を得てClaudeが直接適用（Worker経由の自動適用経路が
              存在しないことを確認済みのため）。あわせて`tasks/task_graph.md`
              （target-project向け）と`tasks/roadmap.md`（Control Repository自身）の
              責務をQ12内で明記し、二重記録を避ける設計にした
        - **`roadmap:check`だけでは「更新自体を忘れたこと」は検出できない**ため、
          A（タスク開始・完了報告フロー側の確認）と組み合わせて運用する
- [ ] Project Reviewer AI（target-project/のコードレビュー）
- [ ] QA AI（テスト自動実行・品質判定）
- [ ] Memory Governance
- [ ] Drift Detection
- [ ] Health Metrics
- [ ] Notification System
- [ ] 効果検証可能性の原則の本格検討（MVP後の改善課題）: 改善・監視・レビュー・自動判定・最適化・
      安全化など、何かを良くする目的で仕組みを追加する場合は、後から客観データで効果を判断できる
      状態にする。ただしMVP段階では過剰な設計負荷を避け、まずは`review_observation.jsonl`による
      観察データ蓄積を優先する（詳細は`docs/multi_ai_step_review_flow.md` 2-3章）
- [ ] Mobile: Dashboard/approvals間の画面遷移遅延の原因調査（E2E-4で発見。主要操作は
      ブロックしていないためMVP後のUX改善候補として保留）
- [ ] Mobile: Dashboardの`ScrollView`＋大量ProjectCard＋N+1 fetch（Project毎にTask/Job取得）の
      改善検討（`FlatList`化、表示中カードのみfetch、集約API利用等）。Project数が多い場合
      （`Projects (559)`等）の描画・fetch負荷増大に備える
- [ ] API: 承認待ち一覧専用エンドポイントの必要性確認（現状mobile側で全Project/Task/Jobを
      巡回して承認待ちを探している可能性があり、専用APIが必要になるかもしれない）
- [ ] Mobile: Project詳細画面の新規実装（`ProjectCard`タップ時の遷移。タップ無反応はバグではなく
      未実装のため。`onPress`追加・詳細画面作成は別タスクとして着手）
- [ ] 開発DBのテストデータ整理（`Projects (559)`等、蓄積されたテストデータの扱い方針決定。
      表示件数・UXへの影響はあるが、誤って必要データを消さないよう方針を決めてから対応する）
- [ ] 【採用未定・アイデア段階】Local Mobile Test Runner / ADB実機確認自動化（2026-07-21調査）:
      将来的に、AIがAndroid実機でアプリ起動・スクショ取得・logcat取得・低リスク操作確認を
      できるようにする構想。**現時点では採用未定・MVP必須ではない。当面はCEOによる手動実機確認で進める**
      （判断理由: VPS上のAIチーム単体ではUSB接続されたAndroid実機を直接操作できず、ADB実機確認には
      スマホが接続されたローカルPC/小型PCの常時起動が必要だが、CEOはローカルPCを常時起動する予定が
      ないため。また実機の使用感・操作感は最終的にCEOが手で触って確認する価値がある）。
      想定構成（アイデア段階）: AIチーム本体はVPS上で常駐し、Android実機確認だけADB接続された
      ローカルPC/小型PC上の「Local Mobile Test Runner」で実行、VPS側は必要に応じて確認を依頼し
      スクショ・ログ・結果を受け取る。AIに任せてもよい候補: 起動確認・クラッシュ確認・スクショ取得・
      logcat取得・低リスクな画面遷移/Refresh確認。AIに任せない操作: 高リスクApproval Gate承認・課金・
      外部サービス追加・本番変更・データ削除・CEO判断が必要な承認。詳細調査結果は本コミットの
      調査ログ（該当セッション）を参照。VPS運用設計（`specs/11_runtime_environment.md`）・Mobile UI
      実装には組み込まない

### VPS常駐運用化（本番運用形態への移行）

**前提（正本）:** `docs/PROJECT_CURRENT_STATE.md`「運用形態（正本）: VPS常駐稼働 + スマホ操作」
および `specs/11_runtime_environment.md` 3章に記載の通り、API/Workerは最終的にVPS上で常駐稼働し、
ローカルPC起動は開発・検証用の一時形態である。以下は本番運用形態へ移行するための後続実装タスク（未着手）。

- [ ] API / Worker の Docker化（本番常駐用コンテナ定義。既存`sandbox/`はAI実行サンドボックス用であり別物）
- [ ] HTTPS化（証明書・リバースプロキシ）
- [ ] 認証強化の要否確認（現状API Token方式。スマホからの外部アクセスを前提にした強化要否を検討）
- [ ] ヘルスチェック（`docs/vps_app_runtime_standard.md`準拠の`/api/health`。API側実装済み・Worker側未確認）
- [ ] ログ保存（VPS上での永続化・ローテーション方針）
- [ ] 再起動耐性（プロセスマネージャ導入・クラッシュ時自動再起動・OS再起動後の自動起動）

### 将来アーキテクチャ移行（Constitution / Team・Service Extension構想。MVP後・未着手）

**前提（正本）:** `specs/00_constitution.md`（最上位思想）、`specs/13_future_system_architecture.md`
（将来のCore/Service Extension/Team Extension構造・現状マッピング）、
`specs/20_token_efficient_intelligence_policy.md`（AI利用量抑制方針）。

**重要:** 以下はいずれもMVP完成後の将来構想であり、今すぐ実装するものではない。MVP開発中に先回りして
実装しない。現行のAPI / Worker / Approval Gate / Risk Control / Watchdog / Mobile app等は
`docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」に明示された維持対象であり、
本セクションの将来構想によって削除・置換されることはない。

- [ ] Extension Registry正式化・Service Extension Interface定義（Telemetry/Notification/Knowledge等の抽象化）
- [ ] Development TeamのTeam Extension化（現状はClaude Code/Codex/Geminiが`apps/worker`に直接組み込まれた
      単一構成。将来的にTeam概念として抽象化するかは要検討）
- [ ] Team Health（Team単位の状態可視化。現状のProject単位health-scoreとは別軸）
- [ ] Self Diagnosis Framework（観測のみ・変更なし。Token-Efficient Intelligence Policy準拠必須）
- [ ] Improvement Planner（改善提案作成のみ・本番反映なし）
- [ ] Problem-Driven Research（外部調査。具体的課題がある場合のみ開始）
- [ ] Experiment（Replay/Shadow/Canary。本番反映前の段階的検証）
- [ ] Personal Evolution / Profile Evolution / Core Evolution（CEO承認付き昇格フロー）
- [ ] `docs/AI_TEAM_OS_DESIGN.md`「第3弾」（AI Reliability/KPI/Conflict Management/Learning Control/Rollback/
      AI Runtime State）との重複整理（要整理・将来統合検討。今回は削除・置換しない）

### 外部Agent Loop設計思想の吸収（Rubric / Workflow Lifecycle / Knowledge Consult / Investigate / Distill / Loop Metrics。2026-07-21反映・MVP後）

**前提（正本）:** `specs/00_constitution.md` 3.10〜3.13（Goal Driven / Rubric Driven / Evidence over Opinion /
Risk-based Review）、`specs/13_future_system_architecture.md` 5b章（Planner責務・Workflow Lifecycle・
Knowledge Consult・Investigate・Distill・Loop Metrics）、`specs/20_token_efficient_intelligence_policy.md`
12b章。今回は仕様反映のみで実装は行っていない。新規`Rubric.md`/`Loop.md`/`Memory.md`は作らない方針。

**MVP後の実装候補（未着手）:**
- [ ] Knowledge Consult（Execution前に関連Ruleだけを検索・添付する仕組み）
- [ ] Retry複数回後のInvestigate（Self Diagnosisの一部として。原因・Evidence・再発防止案を出すのみ）
- [ ] DistillによるRule化（Evolutionの一部として。Knowledge登録・CEO承認対象）
- [ ] Loop Metrics（Retry回数・Feedback回数・Rubric達成率・Rule利用率・Knowledge命中率。Team Healthの一部として）
- [ ] Rubric達成率のHealth反映
- [ ] RubricをProject/Task/Workflow/Review/Approval/Healthで共通利用する正式実装

**スマホ操作MVP中に検討してよい最小実装（実装は今回行わない）:**
Task作成画面・開発指示UI（本セクション上部「スマホ操作MVP残タスク」4番目）を実装する際、以下を
最小実装として検討してよい:
- CEOがGoal/優先順位/制約を入力する
- PlannerがProject/Task Rubricを自動生成する
- Development Team向け最小Rubric例: typecheck成功・test成功・Android bundle成功・危険変更はApproval Gateで
  停止・CEOがスマホで確認できる

### モデル選択・モデル評価・将来の動的Model Routing（2026-07-23反映・段階実装予定）

**前提（正本）:** `specs/13_future_system_architecture.md` 5b-7章（Static Model Routing・Model Usage
Telemetry・Model Registry Lite・Selective Model Evaluation・Dynamic Model Routing）、`specs/00_constitution.md`
3.7 Vendor Independence、`specs/20_token_efficient_intelligence_policy.md`（Model Selection・比較実験の
トークン効率原則）。特定ベンダー・特定モデル名には依存せず、モデルは能力・コスト・用途で抽象化して扱う。
今回は仕様反映のみで実装は行っていない。

**現在・MVP開発中（新規実装ではなく既存の運用方針整理）:** 「1タスク＝1プロバイダー」原則
（`packages/shared/src/types/task.ts`の`Task.provider`）と`apps/worker/src/aiCli/*`が、Static Model
Routing（タスク種別ごとの固定モデル割当）に相当する仕組みとして既に実装済み。以下は同項目の将来拡張候補
（MVP後）:
- [ ] リスク/重要度に応じたモデルクラスの自動選択（現状は固定割当のみ）
- [ ] 推論工数の少数段階設定（低・標準・高等）
- [ ] 失敗時の上位モデル/高工数への自動昇格
- [ ] CEO予算上限の遵守・無料枠優先・無料枠枯渇時の待機/CEO承認後の有料切り替え
      （既存の`docs/multi_ai_step_review_flow.md` 20〜21章「Quota Policy」はGemini Review限定。
      Developer AI実行全体への拡張として整理し、後日既存Quota Policyと統合する）
- [ ] モデル選択判断用の実行ログ整理（使用モデル・推論工数・成功/失敗・Retry回数・トークン量）

**MVP完成後・Phase 1:**
- [ ] Model Usage Telemetry — タスク種別・使用モデル・推論工数・入出力トークン・推定/実コスト・実行時間・
      成功/失敗・Retry回数・Rubric達成状況・Reviewで発見された重大問題・**修正/再試行を含む完了までの
      総コスト**を記録する。既存Telemetry（`executionLogStore.ts`等）へ統合し、独立コンポーネントにしない

**MVP完成後・Phase 2:**
- [ ] Model Registry Lite — Plannerが参照する、モデルの能力・制約・コスト・状態のレジストリ
      （provider・model identifier・状態・コスト・コンテキスト上限・対応機能・推奨用途・既知の制約・
      最終確認日時・情報源・実運用実績）。**公式情報と内部実績（Model Usage Telemetry集計）は分離保存**。
      Model Registryの自動インターネット更新は行わない

**MVP完成後・Phase 2またはPhase 3:**
- [ ] Selective Model Evaluation — モデル選択が微妙で繰り返し発生する価値の高いタスクのみ限定比較
      （方針比較→部分比較→完全Shadow実験の順にコストが低い方法から選ぶ）。全タスク並列実行はしない。
      比較実験のトークン消費が改善効果を上回らないようにする。実行機構はExperiment Service Extension
      （`specs/13_future_system_architecture.md`）の一部として位置づけ、独立仕様は新設しない

**将来・低優先度:**
- [ ] Dynamic Model Routing — 十分な実運用データ蓄積後、タスク分類・要求品質・リスク・重要度・予算・
      レイテンシ・過去の成功率・完了総コスト・モデル利用可能状態・失敗時エスカレーションから自動選択する。
      **固定ルールで実際に問題が発生した場合のみ実装を検討する低優先度機能。自動最適化の導入自体を
      目的にしない**

**優先順位:** 1. MVPの完成 → 2. 単純な固定ルールによる安定運用 → 3. 実行ログの収集 →
4. 実際に問題が出た部分だけモデル選択を改善 → 5. 必要性が確認された場合のみ限定比較 →
6. 十分なデータと費用対効果がある場合のみ動的ルーティング

**今回実装しないもの（明記）:** 全モデルの常時比較／タスクごとの複数モデル完全実行／自動ベンチマーク
基盤／複雑な選択確信度計算／機械学習によるモデルルーティング／モデル選択ルールの自動変更／本番成果物への
Shadow結果の自動反映／CEO承認なしの予算上限超過／Model Registryの自動インターネット更新／
プロダクションコードの変更。

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
