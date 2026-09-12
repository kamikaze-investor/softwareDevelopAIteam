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
<!-- roadmap:id=project-auto-worker-trust-boundary state=done -->
3. [x] **Worker安全境界・結果引き渡し設計** — 自動連続実行を実装する前に、信頼境界を確定する
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

      **CEO確定方針（2026-07-31。上位仕様`specs/03_system_architecture.md`へも反映）**:
      AI CLIとWorkerは本体DBを直接操作しない／本体DBを書き込めるのはAPIのみ／
      Worker結果は本体DBとは別の永続SQLite Outboxへ保存する／結果送信はat-least-onceとし、
      API側はevent IDとpayload hashで冪等処理する／APIが本体DBへの反映をcommitした場合だけ
      ACKを返す／**OutboxはTelemetryではなくCoreのJob / State Controlに属する**（DB権限・
      状態遷移・transactionはCore、バックアップ・復元はSafe Mode / Recovery、監査記録はAudit、
      長期分析記録はTelemetryとし、この4責務を混在させない）／AI実行プロセスには本体DB・
      管理認証情報・Core内部状態を渡さない。

      **信頼境界の対象はAI CLI本体だけでなく「target-project内で実行される全コマンド」**
      （実コード確認済み: `test`/`build`/`lint`のSafeCommand実行（`jobRunner.ts:565`）と
      AI実行後の自動lint（`adapter.ts:403`）はいずれも`env`未指定でWorkerプロセスの全環境
      （`API_TOKEN`含む）を継承する。AIが書き換えたtarget側`package.json`スクリプト経由で
      漏出しうる。AI CLI本体は`buildSafeEnv()`により既に`DB_PATH`/`API_TOKEN`を渡していない）。

      **状態不明attemptの復旧方針（replay-safe隔離実行）**: AI実行完了後からOutbox保存前に
      Workerが停止し結果を確定できない場合、**MVPでは既存成果を救出しない**。
      - 隔離方式は**git worktree**（新しい実行エンティティは作らない。1 Job行＝1 attempt＝
        1 worktree＋1専用ブランチとし、既存の`resumeBlockedTask()`が「新Job行を作る」形で
        retryを表現している既存パターンをそのまま踏襲する）
      - 作成場所は`/workspace/target/.worktrees/<jobId>/`（既存の`isInsideTargetRoot()`が
        `/workspace/target`のサブディレクトリを許可する実装のため、**この判定関数自体は無変更**
        で通る。`normalizeAndValidateChangedFile()`が相対パスで比較するため`fileChangeGuard`も
        無変更で機能する）
      - 基準commitはJobへ新設する`base_commit_hash`列（nullable）に記録する。新設する
        `retry_of_job_id`列（nullable、jobsへの自己参照）で「このJobは既にretryか」を判定する
      - 専用ブランチは基準commitから作成し、Job（attempt）ごとに固有名にする
        （同じブランチを複数attemptで共有すると、破棄したはずの前attemptのcommitを
        次attemptが引き継いでしまいreplay-safeにならないため）
      - 破棄は`git worktree remove --force <path>` + 専用ブランチの削除。他Jobのworktree・
        メインツリーのHEAD・他Taskには影響しない（パス・ブランチ名がJobごとに一意のため）
      - 状態不明の判定条件: Worker起動時、DB上`running`のJobについてOutboxに送信済み/未送信の
        該当eventが**存在しない**場合（Outboxに未送信eventがあるだけなら「状態不明」ではなく
        通常のOutbox再送で処理する）
      - 自動再実行は`retry_of_job_id`が`NULL`のJobに対してのみ1回行う。retry対象Job自身が
        既に`retry_of_job_id`を持つ（＝それ自体がretryである）場合は再実行せずfail-closedで
        停止する（`failed`のまま。新しいApproval Gate等は作らずCEOへ技術的な承認を要求しない。
        既存のTask/Job失敗可視化と同じ経路で表面化させる）
      - replay-safeの担保: 既存`CommandKindSchema`（git系／typecheck／test／build／lint）には
        deploy・publish・課金・通知送信等の外部作用コマンドがそもそも存在しない。破棄した
        worktreeはどこにもmergeされないため副作用は伝播しない。「targetスクリプトが
        Worker全環境を継承する」残存リスク（秘密情報の外部送信）は、`project-auto-worker-outbox`
        側ではなく本項目（`project-auto-worker-trust-boundary`）側で
        `apps/worker/src/utils/safeEnv.ts`の`buildTargetCommandEnv()`（allowlist方式）として
        **既に対処済み**（`jobRunner.ts`のSafeCommand実行・`adapter.ts`のpostLintの両方に
        配線済み、2026-08-01。再実行によってこのリスクが増幅されることはない）
      - **保護対象への最小接続口（確定版。当初「`jobRunner.ts`は無変更のまま成立する」と
        見積もったが、下記「変更ファイル検出契約」の欠陥発見によりこの見積もりは誤りと判明した
        ため訂正）**: worktreeの作成・破棄・`base_commit_hash`決定に伴うprotected diffは
        `index.ts`（起動順序・claim・Outbox・worktree準備呼び出し）だけでなく、`jobRunner.ts`
        （変更ファイル検出契約の適用箇所）にも及ぶ。具体的な対象箇所は下記「変更ファイル検出契約」
        を正とする
      - Worker再起動時の順序: ①Outbox整合性確認（破損・容量確認含む） → ②未送信event再送 →
        ③状態不明attemptの検出・worktree破棄・1回までの自動retry → ④通常pollJobsループ開始。
        現行の`recoverStaleJobs()`（起動時に全Projectのrunning Jobを無条件failed化）はこの
        ③相当を代替する新しいロジックに置き換える（無条件failed化は廃止）
      - 古いattemptのログは既存`jobLogger.ts`（`apps/worker/data/logs/<jobId>/`）がJob単位で
        永続化する仕組みをそのまま使う（worktree破棄とは独立した保存先のため影響しない。
        ただしクラッシュが早すぎてログ書き込み自体に未到達だった場合はログも残らない＝
        「救出しない」方針と整合）

      **変更ファイル検出契約（2026-07-31確定。Codex `gpt-5.6-sol`独立レビューで発見された
      既存critical欠陥への対処）**:
      `getChangedFiles()`が使う`git diff --name-only HEAD`は**untrackedファイルを検出せず**、
      さらに**SafeCommand=`git_commit`の場合は実行後に差分が空になる**ため、正常にコミットされた
      変更ほどGuardを素通りする（実測確認済み: `.env`をcommitさせても
      `fileChangeGuard([])`→`fileChangeAllowed:true`となる）。この関数はApproval Gate
      （`jobRunner.ts:156`）・`runRiskReview()`（同:669）・Target Project Risk Scan（同:441）・
      File Change Guard（同:584）の**4機構すべてに供給されている**ため、影響は全安全機構に及ぶ。
      加えて`fileChangeGuard()`は`task`引数を受け取る設計なのに`jobRunner.ts:584`が渡しておらず、
      **allowedPaths/forbiddenPathsが実行時に一切適用されていない**。
      よって次を必須要件とする:
      - **commit前**に`git status --porcelain=v2 -z --untracked-files=all`相当から
        変更manifestを作る（`git diff --name-only HEAD`だけを変更判定に使わない）
      - 新規・変更・削除・renameを検出する。renameは**旧パスと新パスの両方**を検査する
      - 新規または変更されたsymlinkはMVPでは拒否する
      - TaskのallowedPaths/forbiddenPathsを必ず適用する（Job作成時のimmutable snapshotとして束縛）
      - `.env`・秘密鍵等の常時禁止パターンを**新規ファイルにも**適用する
      - **Git/status解析失敗時は空配列を返さずfail-closed**にする
        （現状`adapter.ts:453`・`jobRunner.ts:640`はcatchで`[]`を返しfail-openになっている）
      - Approval Gate・Risk Review・Risk Scan・File Change Guardが**同じ検査済みmanifest**を使う
      - **commit後にbase treeとcommit treeを比較**し、検査済みmanifestと一致しなければ失敗する
      - **`jobRunner.ts`への変更が必要**（上記「保護対象への最小接続口」参照）
      - **OS隔離（Job単位mount namespace）が完成するまで、状態不明Jobの自動retryは有効化しない**
        （replay-safeは`CommandKind`にdeployが無いことでは保証されない。`test`/`build`/`lint`は
        target管理の`pnpm`スクリプトを実行し、webhook・publish・課金APIを自由に呼べるため。
        既存`sandbox/docker-compose.yml`はcanonical target全体をRW mountし、networkも
        遮断していない上、現行Jobはコンテナを経由せずホスト上で直接`execFileSync`している）
      - **Critical設計および保護対象（CONTROL REPOSITORY / AV-001）の変更は、
        Codex `gpt-5.6-sol`によるread-only独立レビューを必須とする**
        （Claude自身によるレビュー省略は不可。`docs/multi_ai_step_review_flow.md`の
        「AV-001対象ファイルは編集前に具体的な変更計画を提示し明確な承認を得てから着手する」
        という既存Risk Control工程に統合し、新しいレビュー工程は作らない）
      - **reflog検証（`assertNoHistoryRewrite`）は、通常のresetや履歴変更を検出する
        追加防御として位置づける。OS隔離前のため、敵対的プロセスによる`.git`管理領域
        （`.git/logs/HEAD`等）の直接改ざんを防げる安全境界ではない**
        （2026-07-31 Codex 4回目レビューで指摘。「reflog行を削除してbaselineだけ残す改ざん」は
        Worker実行プロセスが`.git`ディレクトリへの書き込み権限を持つ限り原理的に検出できない。
        完全なGit・filesystem境界は将来項目`project-auto-worker-core-split`（Worker安全コアの
        物理分離）のOS隔離で解決する）
      - **reflog検証の実装方針確定（2026-07-31、Codex closureレビュー2回・実測に基づく最終確定。
        上記の位置づけを補強する）**: 当初、reflogエントリ数と`git rev-list --count`による
        実commit数を突き合わせる`countCommitsBetween()`を追加したが、(a)
        `git reflog delete`でエントリを完全削除された場合は削除されたcommitが最終HEADの
        祖先チェーンから到達不能になり、到達可能性ベースの`rev-list`では原理的に検出しようが
        なく検出力が無いまま複雑さだけが残ること、(b) `git merge --ff-only`のように1回の
        reflog更新で複数commitが一気に前進する正当な操作を誤って拒否する回帰があること
        （いずれも実測確認済み）から、CEO判断により**`countCommitsBetween()`は完全撤去**した。
        維持するのはbaseline空判定・current reflog空判定・baseline suffix一致判定・
        隣接hash遷移のfast-forward判定（`git merge-base --is-ancestor`）のみであり、
        これらは通常のreset・checkout・巻き戻し・unrelated履歴移動を検出する実効性のある
        追加防御として機能する。**HEAD reflogとbranch reflogの物理的独立性を実測で確認**した
        （`git reflog delete --updateref HEAD@{1}`は`.git/logs/HEAD`のみを操作し、
        `.git/logs/refs/heads/<branch>`には影響しない）ため、branch上で実行している限りは
        branch reflogという第二の防御線が働き、HEAD reflog単独の完全削除では回避できない。
        ただし**detached HEAD状態（branchRefが存在しない場合）はこの第二防御が働かず、
        reflogの完全削除を防げない**（テストで既知の限界として明示済み）。
        いずれにせよreflog検証は「敵対的プロセスによる`.git`管理領域の直接改ざん」に対する
        安全境界ではなく、Worker/AIプロセスが`.git`への同一書き込み権限を持つ限り
        reflogという痕跡ベースの検証手法そのものの限界であり、根本解決は将来項目
        `project-auto-worker-core-split`のJob単位OS隔離とGit管理領域の分離でのみ可能。
        **OS隔離が完成するまで、状態不明Jobの自動retryおよび完全自律運転（人間承認なしの
        連続Job実行）は有効化しない。**
      - **既知の残存課題（MVP-Bへ送る。今回は対応しない）**: `buildCommitRangeManifest()`/
        `getCommitRangeDiffText()`はJob内のcommit数・diff累積サイズに上限が無く、
        個々の`git`呼び出しには`GIT_TIMEOUT_MS`（10秒）の上限があるものの、1 Jobで極端に
        多数のcommitが作られた場合は長時間停止やメモリ消費が起こりうる
        （2026-07-31 Codex 4回目レビューで指摘）。監督付きMVP（CEO承認済みTask範囲内で
        AIが動作する前提）では通常発生しない異常系であり、対応には新しい上限値の設計判断
        （commit数上限・累積バイト数上限の具体値決定）を要するため、変更検出契約の
        バグ修正の範囲を超えると判断し今回は見送る
      - **機密ファイル走査（`scanSensitiveFiles`）の実測（2026-07-31、対象Repository実測）**:
        リポジトリルート全体（`node_modules`含む）走査で総entry数85,544件・
        `SCAN_MAX_ENTRIES`(200,000件)の42.8%使用・所要0.79秒。機密パターン一致判定込みの
        走査（`hashSensitiveEntry`含む）で2.08秒・メモリ増分4.5MB。Job1回あたり
        （開始時ベースライン＋Stage A＋Stage B/C）で3回相当の走査が発生するため
        合計6秒程度。現状のRepository規模では実用上問題ないが、依存が大きいtarget-project
        では`SCAN_MAX_ENTRIES`到達に近づく可能性があり、キャッシュ化・差分走査等の
        性能改善は将来項目として扱う（新設計のため今回は実装しない）

      **Task→Job→Worker pickupインターフェース確定（2026-08-12、現HEAD実装から確認。
      Acceptance Criteria「Task→Job自動生成が依存するインターフェースが確定している」に対応）**:
      - **TaskからJob生成に必要な入力**: `POST /api/jobs`（`apps/api/src/routes/jobs.ts`）が
        受け取るのは`taskId`・`projectId`・`agentRole`・`safeCommand`（`workingDir`除く）・
        任意で`dryRun`/`aiCliProvider`/`aiCliPrompt`/`aiCliMode`のみ（`.strict()`スキーマにより
        不明フィールドは400で拒否）。`workingDir`はクライアントから受け取らずAPI側で
        `TARGET_WORKING_DIR`（`apps/api/src/config/targetWorkingDir.ts`）を強制設定する。
        存在しない`taskId`/`projectId`、archived Projectは拒否する。
      - **Jobへ固定される実行時情報**: 生成時に`status:'queued'`で確定し、`id`/`createdAt`は
        ストレージ側が付与する。`safeCommand.workingDir`はサーバー側固定値のみで、
        クライアント/AIから上書き不可。
      - **WorkerがJobを取得する境界**: Worker（`apps/worker/src/index.ts`の`fetchQueuedJob()`）は
        `GET /api/projects`→`GET /api/tasks?projectId=`→`GET /api/jobs?taskId=`をポーリングし、
        `status==='queued'`の先頭Jobを取得する。対応するTaskから`buildRuntimeTaskPolicy(task)`
        （`guards/fileChangeGuard.ts`）を**Job実行開始時点**に構築・freezeする。これは
        「Job作成時にAPI/DBへ保存されたimmutable snapshot」ではなく、Workerが実行を開始する
        瞬間にTaskを読み直して構築する実行時ポリシーである（`fileChangeGuard.ts`のコメントに
        明記済み。上記「変更ファイル検出契約」の記述を精緻化するもので、要件自体は変わらない）。
      - **WorkerがTask/Project DBを直接操作せず既存API/interfaceを通す責務**: Workerは
        DBファイルを直接開かない。Job結果の書き戻しは常に`PATCH /api/jobs/:id`
        （`patchJobWithRetry()`、`apps/worker/src/index.ts`）を通す。Task/Project読み取りも
        常に`GET /api/tasks`・`GET /api/projects`のfetch経由であり、DBファイルパス・DB認証情報は
        Workerプロセスへ一切渡さない（`utils/apiAuth.ts`の`buildApiAuthHeaders()`が
        認証ヘッダーの唯一の生成点）。
      - **将来Outboxが入っても崩さない責務境界**: Outbox導入後も、Job結果の確定的な永続化先が
        「即時PATCH」から「Outbox→再送」に変わるだけで、(a) WorkerがDBファイルへ直接
        アクセスしない、(b) Task/Project/Jobの読み書きは常にAPIの定義済みinterfaceを通す、
        (c) `buildRuntimeTaskPolicy()`によるallowedPaths/forbiddenPaths適用はJob実行開始時点で
        行う、という3点の責務境界は変更しない。Outbox自体は「WorkerからAPIへの結果引き渡し経路の
        信頼性強化」であり、Task→Job生成・Worker pickupのインターフェース自体を変更するものではない。

      **Outbox最小接続口 — CEO承認済み（2026-08-12。Acceptance Criteria
      「Outbox用の最小接続口がCEOに承認されている」に対応。まだOutbox自体は未実装。
      `project-auto-worker-outbox`着手時の設計拘束として扱う）**:
      新しいSecurity Gate/Workflow層は作らず、既存のJob結果PATCH経路上に永続キューを
      1枚差し込む方式のみを承認する。
      - **対象ファイル**: Worker側ローカル永続キュー（新規、非保護ファイル）＋
        `apps/worker/src/index.ts`（既存呼び出し箇所の差し替えのみ。保護対象＝AV-001）＋
        既存`PATCH /api/jobs/:id`への冪等キー追加（既存ファイル拡張、新規route/Gate追加ではない）。
      - **Worker→API payloadは既存`JobUpdate`を正本とする**: Outbox用に新しい結果payload
        schemaを広げない。現在`PATCH /api/jobs/:id`へ送っているJobUpdate（`status`/
        `startedAt`/`completedAt`/`exitCode`/`stdout`/`stderr`/`stdoutPath`/`stderrPath`/
        `changedFiles`/`commitHash`/`guardResult`/`reviewResult`）をそのままOutbox配送対象の
        正本とする。Outbox追加分として許可する新規metadataは、冪等性確保に必要な
        `eventId`・`payloadHash`の最小2項目のみとし、`taskId`等の重複追加は行わない。
      - **stdout/stderr等のsecret取扱い（2026-08-12現HEAD確認）**: 現HEADには
        stdout/stderrに対する中央redaction/sanitization処理は**存在しない**
        （`jobRunner.ts`・`jobLogger.ts`を確認。存在するのはコマンド引数構築時の
        `commandResolver.ts`の`sanitizeBranchName`/`sanitizeCommitMessage`等であり、
        これはinjection対策でありsecret redactionではない）。今回この事実を報告するに
        留め、新しいredaction実装は追加しない。よって**#6の承認条件を
        「Outboxは既存経路より機密情報露出範囲を拡大しない」までとして確定する**。
        具体的に以下を明記する:
        - Outbox導入により新たにraw secretを永続化しない
        - `API_TOKEN`/provider key等をOutbox payloadへ追加しない
        - env全体を保存しない
        - command argumentやcredentialを結果metadataとして追加しない
        - stdout/stderrは既存JobUpdate経路で現在許可されている内容のみを対象とし、
          将来中央redactionが必要と判断された場合も、既存Trust Boundaryの
          sanitization方針を迂回せず、別途CEO承認のもと本項目または関連項目で扱う
      - **Control/API→Workerへ許可する入力**: `{received, eventId, deduplicated}`の
        ACKのみ。Job/Task本体は既存`GET /api/jobs`・`GET /api/tasks`から取得済みのため
        Outbox応答に重複させない。
      - **明確に禁止**: 本体DBへの直接接続情報／不要なsecret／Provider credential／
        Cloudflare・GitHub等のcredential／任意SQL／任意のControl Repository
        filesystem write／Trust Boundaryを迂回する別経路。
      - **今回混ぜない**: worktree/状態不明Jobの自動retry/OS隔離。roadmap確定方針
        （L487, 525-526）によりOS隔離完成まで有効化しない。

      **状態（2026-08-14更新）**: Task→Job→Workerインターフェースの文書化とOutbox最小接続口の
      CEO承認（いずれも2026-08-12）は完了済み。**ただし新たに以下3点の未完了が確認されたため、
      本項目は`done`から`in_progress`へ差し戻す**（Outbox関連の完了自体は取り消さない）:
      (1) AI/CEO GitHub credential未分離、(2) trusted ALLOW evidence不足（Gap A）、
      (3) GitHub Actions用read-only API credential不足（Gap B）。詳細は以下。

      **観測事実の追記（2026-08-16）**: Design Review Gate hardening（`aef0722`）のpush時、
      GitHubから`Bypassed rule violations for refs/heads/master: Changes must be made
      through a pull request. / Required status check "Typecheck & Test" is expected.`
      という通知を実際に受け取った。これは上記(3)(4)の未完了（master用Rulesetが
      `enforcement: disabled`のまま、AI/CEO GitHub credential未分離のため通常push権限で
      required check・PR必須を強制できる状態）を実運用で裏づける観測事実であり、
      新しい問題ではなく既存の未解決事項の再確認。新規roadmap item・追加Gateは作らない。
      引き続き`project-auto-task-job-chain`のFull Automation解放前の必須条件として維持する。
      **3点の解決状況（2026-08-20実測。上記(1)(2)(3)はすべて解決済み）**:
      - **(1) AI/CEO GitHub credential分離 = 完了**。GitHub Appは**作らなかった**。同一principalのまま
        AI側credentialをrestricted Fine-grained PAT（Administration無し）へ統一し、`gh auth setup-git`で
        git pushも同一credentialへ集約、旧classic OAuthとGit Credential Managerの旧entryは削除。
        実測: Ruleset create/update/delete = **HTTP 403 Resource not accessible**（実在Rulesetに触れない
        safe probeで確認）。master Rulesetは**enforcement=active / bypass_actors=[] /
        required checks = `Typecheck & Test`・`Meta Reviewer AI (Gemini)`**。
        AI credentialからのmaster direct pushは**GH013「Changes must be made through a pull request」で
        実際に拒否**され、`origin/master`は不変であることを非破壊probeで確認済み。
        Ruleset Active化はCEOがWeb UIから人間操作で実施（AIからは行わない）。
      - **(2) Gap A（trusted ALLOW evidence）= 完了**。`gate_evaluations`テーブルへGate評価を永続化し、
        `approved_content_hash`（Canonical Change Manifest）と`resulting_commit`のauthoritative bindingを
        実装済み。詳細は下記Gap A節を参照。
      - **(3) Gap B（Actions用read-only credential）= 完了**。第3 credential class `ACTIONS_READONLY`
        （`ACTIONS_READONLY_TOKEN_SHA256`）と`GET /api/gate-evaluations/verify-commit`を実装しProductionへdeploy済み。
        GitHub Secret `AI_TEAM_ACTIONS_READONLY_TOKEN` と Repository Variable `AI_TEAM_API_BASE` も設定済み。
        ただしGate Evidence Check自体は**Control Repositoryには適用対象外**のためrequiredにしない（下記参照）。

      **本項目の残作業**: 上記3点が解決したため、GitHub外部強制境界は成立している。
      Gate Evidence CheckのTarget Repo側への適用のみ保留（Target RepoのGitHub remote/push/PR対応待ち）。

      **GitHub外部強制境界の設計（2026-08-14追記。上記610-611行の「Cloudflare・GitHub等の
      credential」禁止方針を、Task→Job Full Automation解放条件として具体化するもの。read-only
      調査に基づく設計確定であり実装はまだ行っていない）**:
      - **現状のTruth**: AI（Claude Code/Worker）とCEO本人は現在**同一のGitHub admin
        credential**（CEO個人のgh CLI OAuth token）を使用しており、AI/人間間のGitHub権限境界は
        存在しない。`master`用Ruleset（既存、force push禁止・branch削除禁止・PR必須・
        required status checks）は作成済みだが**`enforcement: disabled`**で現在無効
      - **Approval Check構造（2026-08-14修正。Commit statuses:write方式は第一候補から撤回）**:
        AI/Worker → branch push → PR → **GitHub Actionsが自動実行** → AIteamOS APIへ
        read-only問い合わせ → PR HEADのcommit/diffがAIteamOS Approval Gate上で有効に
        承認済みかを**機械的に判定** → GitHub Actions job success/failure → GitHub Ruleset
        required check → merge可否、を第一候補とする。**AI判断はGitHub Actions側で行わない**。
        既存Approval Gateの確定済み状態を機械的に確認するだけの構造とし、Commit Status APIへの
        書き込み（＝新しいstatus publisher責務）は追加しない。GitHub Actions方式が既存Gate
        schemaで合理的に成立しないと判明した場合のみ、Commit statuses:write＋trusted
        publisher方式をfallback候補として再評価する
      - **判定ロジック（deterministic、新enumは作らない。既存`ApprovalGateStatus`をそのまま使う）**:
        `packages/shared/src/types/approval_gate.ts`の既存`ApprovalRequest`／
        `ApprovalGateStatus`（`WAITING_FOR_USER`/`APPROVED`/`REJECTED`/`EXPIRED`/`SUPERSEDED`/
        `STALE`/`CONSUMED`）をそのまま使う。`APPROVED`・`CONSUMED`（かつcommit/diffHash一致）→
        PASS。`WAITING_FOR_USER`・`REJECTED`・`EXPIRED`・`SUPERSEDED`・`STALE`・
        該当レコードなし→FAIL側で扱う。**判定は`taskId`のみでは行わず、target commit SHA
        （PR HEAD）／target diff hashの一致を必須とする**（caller供給のmutable metadataだけを
        信頼してPASSしない。該当レコードなしの扱いは下記「確定したGap A」「Gate evaluation
        bindingの要件」参照）
      - **Approval bindingの現状確認（read-only調査。2026-08-14実施）**: 既存`ApprovalRequest`
        （`apps/api/src/routes/approvalGate.ts`）は`taskId`・`targetBranch`・
        `targetCommit`（`git rev-parse HEAD`）・`targetDiffHash`（diffのSHA-256）へ既に
        紐づいている。**「CEO承認後にAIが変更内容を変えても古いApprovalを再利用できない」構造は
        既に実装済みで確認できた**: `targetCommit`/`targetDiffHash`が承認時と一致しない場合、
        `/gate/check`・`/consume`が自動的に`STALE`へ遷移させる（同ファイル106・483・795行、
        `updateStatus(..., 'STALE', ...)`）。さらに`diffText`から計算したhashと申告された
        `targetDiffHash`の不一致も別途拒否される（393行）。**新しいApproval schema・新Systemは
        不要**、既存の`targetCommit`/`targetDiffHash`をPR HEAD SHAとの一致判定にそのまま
        再利用できる
      - **required statusのsource固定（Acceptance Criteria候補）**: Approval Check用の
        required statusは、同名statusを誰でも発行できる状態にしない。GitHub Rulesetの
        required_status_checksは発行元App（app_id）を指定して固定できるため、この
        Actions workflow由来のみを要求する設定を完了条件に含める
      - **Workflow自体の保護**: Approval Check用GitHub Actions workflow（`.github/workflows/`
        配下）を通常Workerが書き換えて常時PASSにできてはならない。通常Worker用GitHub Appへ
        **`Workflows: write`を付与しない**方針を維持する。既存CODEOWNERS（`.github/workflows/`を
        `@kamikaze-investor`指定済み）・fileChangeGuard等のprotected-file guardと責務が重複するが、
        タイミング（実行前 vs マージ前）が異なるため両方Keepとし、**新しい専用Guardは追加しない**
      - **通常Worker用GitHub App 最小権限（第一候補、原則1個）**: Metadata:read・
        Contents:read/write・Pull requests:read/writeの**3権限のみ**。`Commit statuses:write`・
        `Checks:write`・`Workflows:write`・`Administration`・`Secrets`・`Actions:write`は
        いずれも付与しない（Worker自身がApproval結果を書き込む構造にしない）
      - **Task→Job Full Automation（`project-auto-task-job-chain`）解放前の必須条件**:
        (1) AIとCEOのGitHub credentialを分離する（AI/Worker用の最小権限GitHub App、原則1個。
        上記3権限のみ）
        (2) AI用credentialにはRuleset変更・保護設定変更・Administration権限を与えない
        (3) master直接push・force push・branch deletionをGitHub側で外部強制拒否する
        (4) required status checks（Typecheck & Test・Meta Reviewer AI・AIteamOS Approval
        Check）をGitHub側で外部強制する
        (5) Approval CheckをWorkerが偽装できない構成にする（Workflows:write不付与＋
        required statusのsource固定）
        (6) 通常作業（Low/Medium Risk）はAI自身がbranch作成→commit→push→PR作成→checks→mergeまで
        completeでき、CEOの通常作業（GitHub上での追加承認クリック等）を増やさない設計とする
      - **CEO本人のadmin credentialは、AI/Worker実行環境から除去する**。Recovery時は
        新しいRecovery用GitHub Appを別途作らず、**CEO本人のGitHub accountをhuman-onlyで直接
        使用する**（Worker実行環境がRecovery/Administration credentialを保持しない設計）
      - **CODEOWNERS / classic branch protection / Approval Gateの関係（Current Truth）**:
        CEOの人間承認正本はAIteamOS Approval Gateとする。GitHubは、Approval Gate結果を
        GitHub Actions機械checkのrequired statusとして外部強制する役割に限定する。CODEOWNERSは
        protected-path情報の文書化として維持する。GitHub側のcode-owner human review requirementは、
        AIteamOS Approval Gateとの二重承認にならないよう、**Ruleset側だけでなくclassic branch
        protection側（`require_code_owner_reviews`）との整合も実装時に整理する**（Ruleset・
        classic protectionは重ねて適用されるため、片方だけ調整しても不十分になりうる）。
        **今回はbranch protection設定自体は変更しない**
      - **GitHub側の最終保証**: master直接push禁止・force push禁止・branch deletion禁止・
        PR必須・CI（Typecheck & Test）必須・MetaReview必須・**AIteamOS Approval Check必須**・
        通常AI credentialによるRuleset変更不可・通常AI credentialによるApproval Check
        workflow改変不可
      - **AIteamOS側の責務（GitHub Actionsは意味判断を再実装しない）**: Risk分類・
        Approval必要性判断・CEO Approval・Strategic Alignment・MetaReview意味判断・
        protected-file実行前判断・DB/Production Safety・Secret Boundary
      - **GitHubが最終強制できるのは処理手続き（PR経由・checks green・force push/delete不可・
        AI credentialでの保護設定変更不可・Approval Check機械判定の強制）のみであり、
        Approval Gateが持つ意味的判断（このdiffに本当に承認が必要か）を代替しない**。
        `required_approving_review_count=0`のまま運用する場合、Approval Gateの承認結果を
        正しくActions機械checkへ反映する経路がなければ、Approval Gate側のバグをGitHub側は救えない
      - **確定したGap A — Low/Medium ALLOW evidence不足（2026-08-14 read-only調査で確定）**:
        High/Critical等で`ApprovalRequest`が作られる場合は、`targetCommit`/`targetDiffHash`/
        `status`がAPI/DB側に存在し、変更後は`STALE`になるため、GitHub Actionsから信頼できる
        機械検証が可能。**一方、Gateが自動ALLOWする変更については、「このcommit/diffに対して
        Gate評価が実行され、結果がALLOWだった」ことをAPI/DB側で独立して証明できるtrusted
        persistent recordが現在存在しない**。`Job.guardResult`（`permissionGuard`/
        `fileChangeGuard`の結果でありApproval Gate結果ではない。かつWorker自己申告値でAPI側の
        独立再検証がない）は、GitHub外部境界のtrusted evidenceとして**使用しない**。
        **2026-08-19: evidence永続化のみ実装済み**（`gate_evaluations`テーブル、記録は
        `apps/api/src/routes/approvalGate.ts`のGate評価時）。taskId/jobId・targetBranch・
        targetCommit・targetDiffHash・decision・riskLevel・triggeredRules・policyVersionを
        記録し、**自動ALLOW（LOW/MEDIUM）も残す**。Workerの自己申告はevidenceにしない。
        `ApprovalRequest`は流用していない（status群と`expiresAt`/`requestedAction`が
        人間承認専用semanticsであり、自動ALLOWを混ぜると承認待ち一覧・期限・consumeの意味が
        壊れるため）。Gateの権限（Authority）は増やしていない。
        **binding検証**: `targetCommit`/`targetDiffHash`はcaller申告値を無検証で保存しない。
        既存の`readExactApprovalDiff`（実worktreeのHEADとdiff hashの両方へ照合）を再利用し、
        検証水準を`binding_verification`として記録する: `authoritative`（実worktreeへ照合済み）/
        `diff_text_hash`（callerのdiff本文からAPIがhashを算出して一致確認。commitは申告のまま）/
        `unverified`（申告値のまま）。既定は`unverified`で黙ってtrusted扱いにしない。
        外部境界は`unverified`をtrusted bindingとして扱ってはならない。
        **`authoritative`の保証範囲は`targetCommit`+`targetDiffHash`のみで`targetBranch`は含まない**
        （2026-08-19実測: `readExactApprovalDiff`は`rev-parse HEAD`と`git diff HEAD`だけを照合し、
        stale判定もcommit+diffのみ。branchはtrust判断に使われておらず監査metadataである）。
        外部境界の照合対象もcommit+diffとする。
        **Gate Evidence CheckのControl Repositoryへの適用は見送り（2026-08-20確定）**:
        `gate_evaluations.resulting_commit`が証明するのはTarget Repository（`/workspace/target`）の
        commitであり、Control Repository（`softwareDevelopAIteam`）のPR commitとは**別RepositoryのSHA**である。
        実測: Control HEAD=`d020c61` / Target HEAD=`8aecfc4` / Target remoteは**0件でGitHub上に存在しない**。
        照合対象が異なるためControl RepoのPRへ適用すると常にFAILする。**未完成だからではなく適用対象外**
        という判断であり、**Control Repo commit用のgate evidenceは新設しない**。
        `.github/workflows/gate-evidence-check.yml`は削除せず、triggerを`workflow_dispatch`のみに変更して
        自動実行しない状態で保持する（新機構は作らない）。
        **将来の導入条件**: Target RepositoryにGitHub remote / push / PR経路ができた時点で、
        Gate Evidence CheckをTarget Repo側へ適用し、**実PRでPASSを確認してからrequired化**する。
        それまでControl RepoのRuleset required checksは`Typecheck & Test`と`Meta Review`の2つとする。
        **未完了**: これをGitHub Actionsから機械検証する経路はGap B（read-only credential）待ち
      - **Gate evaluation bindingの要件（将来の最小解決方針。今回は永続化方式を決め打ちしない）**:
        Task→Job Full Automation解放前に、GitHub ActionsがPR HEADについて
        `Gate evaluation exists for this exact change AND (outcome = ALLOW OR valid
        ApprovalRequest = APPROVED)`を機械的に確認できる状態を必須とする。判定対象は最低限
        task/job・target branch・target commit SHA・target diff hash・Gate outcomeへ
        bindingされ、変更後に古いGate結果を再利用できないこと。**永続化方式は実装時に
        以下の順で評価する（新しいGate DB/Systemを即追加しない）**: 第一候補＝既存Approval
        Gate永続化構造の自然な拡張／第二候補＝DB Safety B等で導入される既存audit永続化が
        trusted Gate evidenceとして自然に再利用可能ならそこへ統合／それでも責務が不自然な
        場合のみ最小のGate evaluation永続化を追加する
      - **確定したGap B — GitHub Actions API credential不足（2026-08-14 read-only調査で確定）**:
        現在の`API_TOKEN`はscope分離が存在せず、health check以外の全`/api/*`に対しread/write
        可能な強いcredentialであることを確認した。**現在の`API_TOKEN`をGitHub Actions Secretへ
        渡すことは禁止候補とする**。GitHub Approval Checkには、Gate/Approvalのmerge
        eligibility確認だけが可能な最小read-only認証境界が必要。**認証方式は今回確定しない**。
        実装時に(1)既存認証方式の最小拡張、(2)Approval Check専用read-only credential、
        (3)GitHub Actions OIDC等のsecret-less認証、を実装量・Safety・保守性・既存設計との整合で
        比較し最小で自然な方法を選ぶ（新しい汎用RBAC systemは作らない）
      - **Workflow Safety（Current Truth）**: Approval Check workflowは原則PR code
        checkout不要・package install不要・PR script実行不要・PR codeへcredentialを渡さない
        構造とする（`pull_request`イベントmetadataとAPIへのread-only問い合わせのみで成立する
        設計）
      - **将来のPrivate repository化について**: 将来的に本Repositoryをprivateへ変更する予定が
        ある。private化後もGitHub Actions・Ruleset・required checks・PR外部強制境界は維持する
        前提とする。必要プランは現時点の調査では**個人Repository + GitHub Proを第一候補**とし、
        Team限定機能が本当に必要と判明しない限りTeamへは上げない方針候補とする（料金/プラン
        情報は変わりうるため、実際のprivate化時に再確認するものとし、現時点では確定しない）
      - **今回のスコープ外**: Secret exposure対策（別項目、上記「VPS常駐運用化」参照）
      - **現在の人間監督下MVP開発（Meta Review MVP Hardening・DB Safety等）は、この
        GitHub外部境界が未実装でも継続可能。今回の調査・設計により現在作業を停止しない**
      - **「Task→Job Full Automation解放前必須」を正本とする**（「MVP後」という表現は
        Task→Job Full Automationの位置づけと紛らわしいため使用しない）。実装
        （Ruleset有効化・GitHub App作成・credential分離・Approval status連携）は現時点では
        未着手

      **Worker↔API credential / authority separation — 設計確定・ローカル実装完了
      （2026-08-15。Production移行は未実施）**: `project-auto-meta-review-hardening`で実装した
      `design_review_evidence`（`POST /api/design-review-evidence`）を含め、Workerが現在
      単一の万能`API_TOKEN`（他の全API呼び出しと同一）で全API操作可能だった問題を確認した
      （2026-08-14確認。Workerが`decision: 'ALIGNED'`等を自己申告してevidence偽装可能・CEO
      Approval決定を偽造可能・Task/Project自由変更可能・permission grant自己発行可能等、
      read-only調査で確認済み）。

      **確定設計・実装済み**: generic RBAC/Permission DBは作らず、既存`apiTokenAuth`
      （`apps/api/src/auth/apiToken.ts`、AV-001保護対象外）を最小拡張する2-credential方式。
      - **ADMIN credential**: 全API操作可能。API側は`ADMIN_TOKEN_SHA256`（平文ではなくSHA-256
        ハッシュ）のみ保持し、timing-safe比較。平文はVPS上のWorkerと同一OS userから読める場所
        （`.env`・process env）へ置かない
      - **WORKER credential**: `WORKER_TOKEN_SHA256`と一致した場合のみ、method +
        `req.routeOptions.url`（Fastifyのroute登録pattern）のallowlist（`apps/api/src/auth/
        workerAllowlist.ts`、11経路。実使用経路のread-only調査結果のみで構成）を通過。
        allowlist外はDefault Deny（403）
      - **auth mode定義（2026-08-15、testで固定。both-or-neither invariant）**: modeは
        `ADMIN_TOKEN_SHA256`/`WORKER_TOKEN_SHA256`の設定状態だけで決まる（空文字は未設定扱い）。
        - **両方とも未設定** → legacy mode（既存`API_TOKEN`単一credential方式）
        - **両方とも設定** → split credential mode（ADMIN全許可／WORKERはallowlistのみ）
        - **片方だけ設定** → invalid configurationとして**全requestを503で拒否**（fail closed。
          片側credentialだけ有効な中途半端な状態でProductionを動かさない）
        - **両方設定されているが値が同一** → invalid configurationとして**全requestを503で
          拒否**（2026-08-15追加。同一hashだとADMIN判定が先に評価されWORKER tokenでも
          ADMINとして通過してしまい、authority separationそのものが無効化されるため）
        **split credential modeでは旧`API_TOKEN`は（envに値が残っていても）認証に使えない**。
        legacyとsplitの共存・段階的移行は成立しないため、cutoverは短い計画停止を伴う
      - **Reviewer専用credentialは作らない**: `apps/worker/scripts/designReview.ts`は
        Worker runtimeから一切呼ばれない手動CLIであることを確認済みのため、ADMIN credentialで
        実行すれば足り、WORKER credentialからは`design-review-evidence`をDefault Denyにした
      - 新規table・新規storage interface・新規サービス・新OS user・署名システムはいずれも
        追加していない
      - tests: WORKER allowlist 11経路通過／CEO Approval決定・Task/Project mutation・
        permission grant発行削除・design-review-evidence・Job自己生成・KG delete等の
        Default Deny／ADMIN全許可／unknown token・token無し401／既存`apiTokenAuth`
        testsの回帰なし、を確認済み
      **Production未実施（別途安全手順レビュー後に実施）**: 上記auth mode定義により、
      **code deployとcredential cutoverは必ず分離する**。またlegacy/splitは共存できないため、
      **cutoverは短い計画停止（API再起動を挟む）を前提とする**。「新ADMIN tokenをAPIより先に
      検証する」ことは原理的に不可能（APIがhashを知る前は必ず401になる）ため、そのような
      手順を置かない。
      - **Phase 1: code deployのみ**（`ADMIN_TOKEN_SHA256`/`WORKER_TOKEN_SHA256`は設定しない）
        → 両方未設定のためlegacy `API_TOKEN`方式のまま動作し続ける。**挙動変化なし**。
        **2026-08-16 実施済み**（Production `239f8da9` → `aef0722`）
      - **Phase 1・2とも完了（2026-08-16）**。以降のProduction baselineは
        `docs/PROJECT_CURRENT_STATE.md`「Production Baseline」を正本とする
        （現在: `9e41062`。2026-08-18 deploy、acceptance PASS、rollback不要）
      - **Phase 2: credential cutover**（Phase 1とは別タイミング。計画停止として実施）:
        1. 新ADMIN token・新WORKER tokenを生成する
        2. ADMIN平文をCEO Mobile / **trusted control/operator端末**（VPSではなく、CEOが
           管理する手元の実行環境）側へ安全に準備する（**VPSへは置かない**）
        3. **VPSへ置くもの／置かないものを分ける（2026-08-17訂正。旧記述「VPSには両tokenの
           ハッシュのみ」は実装と矛盾していたため修正）**:
           - **ADMIN raw tokenはVPSへ一切置かない**（CEO Mobileのsecure store、および
             **trusted control/operator端末**のprocess envにのみ保持する。ここでいう
             「operator process env」は**VPS上のshell/env/fileではなく、VPS外にある
             CEO管理の手元端末**を指す。VPS上の`ai-team` user（Worker runtimeと同一OS user）
             から読める場所へADMIN平文を置く運用は禁止）
           - `ADMIN_TOKEN_SHA256`はVPS/APIへ設定する（hashのみ）
           - `WORKER_TOKEN_SHA256`はVPS/APIへ設定する（hashのみ）
           - **WORKER raw tokenはVPS上でWorker用credentialとして保持する**。Workerには
             `WORKER_TOKEN`等の専用env名が存在せず`apps/worker/src/utils/apiAuth.ts`が
             既存env名`API_TOKEN`から読むため、VPSの`API_TOKEN`へWORKER raw tokenを置く
             （env名のrenameは行わない）
        4. cutover直前に **running Job = 0 / pending outbox = 0** を確認する
           （実行中のJobがある状態でcredentialを切り替えない）
        5. Workerをgraceful停止（`SIGTERM`。process tree全体の終了を確認）
        6. **Worker起動より前に**、VPSの`.env`の`API_TOKEN`の値を**新WORKER raw tokenへ
           置換する**（2026-08-17訂正。旧手順では置換が最後（旧手順10）にあり、その前段で
           Workerを起動する記述と矛盾していた＝旧tokenを送って401になる順序だった）。
           `API_TOKEN`というenv名自体は削除しない。この置換により旧`API_TOKEN`値は
           VPS上から除去される
        7. APIへ`ADMIN_TOKEN_SHA256`と`WORKER_TOKEN_SHA256`を**同時に、かつ異なる値で**
           設定する（片方だけ設定、または両方に同じhash値を設定した状態はいずれも
           invalid configurationとして503で全停止する。特に同一値の設定はauthority
           separationそのものを無効化する重大な設定ミスのため、投入前に2値が異なることを
           確認する）
        8. API再起動でsplit modeへ切り替える（**この時点で旧`API_TOKEN`値は失効する**）
        9. **cutover成功判定は`/health`だけで行わない**（後述の既知gap参照）。以下を
           この順で個別に確認する:
           - 新ADMIN tokenで認証付きAPI（例: `GET /api/projects`）が200で成功する
           - Workerを起動する（手順6で`API_TOKEN`が新WORKER raw tokenへ置換済みであるため、
             Workerは新WORKER credentialで認証する。既に起動中のWorkerは古いprocess envを
             保持するので、必ず停止→再起動で反映させる）
           - Workerのallowlist route（Job poll等）が成功する
           - Worker credentialで禁止route（CEO approval decision・Task/Project
             mutation・design-review-evidence等）が**403**になる
           - Job pollingが継続して動作している
        10. Job poll / gate/check / permission-grant / watchdog等の正常動作を確認する
        11. **CEO Mobileへ新ADMIN tokenを保存し直す**（Mobileは`expo-secure-store`へ実行時に
           保存する方式のため**再ビルド・再配布は不要**。接続設定画面から保存し直すだけでよい。
           Mobileの通常操作（Project/Task詳細・承認判断・作成/resume）はWORKER allowlist外の
           ためADMIN credentialが必須であり、この手順を省くとMobileが全面的に403になる）
        起動方式は現行の暫定運用（watch無し`tsx src/index.ts`）に合わせる。正式な
        process supervision導入時は上記「正式Production起動方式の確定」側の手順に統合する
      **旧API_TOKENの扱い（2026-08-15確認。2026-08-17訂正）**: 旧`API_TOKEN`は現状ADMIN相当
      （全API操作可能）のcredentialである。旧`API_TOKEN`**値**は上記cutoverの手順6でVPSの
      `.env`から除去され、手順8のAPI split mode再起動をもって技術的にも認証へ使えなくなるため、
      **「念のため残す」判断はしない**。**ただし`API_TOKEN`というenv名自体は、Workerが自分の
      WORKER credentialを読むためのenv名として引き続き使用する**（手順3・6参照。Worker側に
      専用env名が無いため、env名の削除・renameはcutoverの範囲に含めない）
      **design-review CLIの運用（2026-08-15確認。運用記述のみ、新serviceは作らない）**:
      split credential cutover後、`apps/worker/scripts/designReview.ts`はWORKER credential
      では`POST /api/design-review-evidence`が403になる。**VPS上のWorker実行環境ではなく、
      trusted control/operator環境からADMIN credentialで実行する**。ADMIN token平文をVPS上の
      `ai-team` user（Worker runtimeと同一OS user）から読めるenv/file/processへ渡す運用は
      禁止とする
      **`/health`の既知gap（2026-08-15確認。今回はhealth実装を広げない）**: partial/invalid
      auth configuration（503を返す状態）でも、`/health`・`/api/health`は認証チェック自体を
      バイパスするため200を返し続ける。**cutover成功判定を`/health`だけに依存しないこと**
      （上記手順8参照）。正式なhealth/config validation改善は、「VPS常駐運用化」節の
      ヘルスチェック・正式Production起動方式の確定と合わせて将来統合できるか再評価する
      （cutover完了確認後）ことを標準手順に含める
      **Design Review trust blocker**: 将来design-reviewをWorker自動実行へ組み込む場合の
      trusted evidence問題は未解決のまま`project-auto-task-job-chain`側へblockerとして
      明記した（本項目へ内容を複製しない）
<!-- roadmap:id=project-auto-worker-outbox state=done -->
4. [x] **Worker永続Outbox・結果受信基盤** — 依存: `project-auto-worker-trust-boundary`。
      **着手条件**: Worker安全境界設計で、Outboxへ結果を書き込む接続口が承認済みであること。
      保護対象変更が必要な場合は、実装前にCEOが具体的な差分を承認すること。
      保護対象ルールを包括的に緩和しないこと。

      **実装済み（2026-08-14確認。commit`b1c2d9e`）**: Worker-local outbox
      （`apps/worker/src/outbox/outboxStore.ts`。`recordPending`/`deletePending`/
      `hasPending`/`resendPending`）／API側 idempotent apply（`outbox_applied_events`
      テーブル、`payloadHash`をサーバー側で再計算しWorker申告値を信用しない）／
      pending中は新しいJobを取得しない（`apps/worker/src/index.ts`のpollJobsガード）／
      startup時のpending resend（起動時drain）。いずれも`apps/worker/src/index.ts`
      （実Worker起動経路）に実際に配線されていることをコードで確認済み。
      **残課題**: natural production terminal-result E2E（実VPS環境でのAPI停止・再起動を伴う
      実測確認）に加え、後述する稼働中再送とAPI側FSM強制が未完了。これらが満たされるまで
      checklistは未完了のまま維持する
      **Worker側**: 実行結果を専用の永続Outboxへ保存する（本体DBとは分離し、未送信結果だけを保持）／
      `completionEventId`等で結果を一意識別する／APIからACKを受け取るまでOutboxの結果を削除しない／
      terminal PATCHは通信失敗・429・5xx・タイムアウト時に最大3回retryし、失敗後はOutboxへ残す／
      Worker再起動時はstartup drainで未送信結果を再送する／**未送信結果が残っている間は新しいJobを
      取得しない**。**完了（2026-08-19）**: 稼働中pollでもpending検出時に`resendPending()`を呼ぶ
      （`apps/worker/src/index.ts`）。新しいscheduler/watchdog/retry frameworkは追加せず、
      既存poll cycleに相乗りする。1 pollにつき1 resend batchで、失敗時はpendingを保持し、
      tight loopせず次pollで再試行する。「未送信結果が残っている間は新しいJobを取得しない」
      既存契約は維持している。
      **API側**: 狭い内部Job結果受信口だけを提供する／同じ結果が再送されても一度だけ反映する（冪等）／
      任意のTask・Project・DB操作は受け付けない。**完了（2026-08-19）**: API側は`Result State Application Policy`
      （`apps/api/src/jobResultApplicationPolicy.ts`）で、届いた結果をDB stateへ適用してよいかを
      判定する。Worker側の`ALLOWED_TRANSITIONS`（`apps/worker/src/jobStateManager.ts:37`）は
      **execution FSM**であり責務が異なるため同一化しない。
      HTTP層で拒否（409）するとat-least-once配送の正当な遅延・重複resultを失うため、
      **受理は200のまま、適用可否だけを厳格化する**（stale/非適用な遷移はstatusを適用せず記録する）。
      許可集合は既存テストで固定されている契約をSource of Truthとし、
      `queued`からのterminal直行・terminalへ遅れて届くterminal結果の記録・requeueを許可し、
      **確定済みterminal stateは遅延resultで上書きしない**（terminalからはrequeueのみ許可）。
      これは`failIfRunning`が`WHERE status = 'running'`でterminalを保護し、
      `persistProviderTimeoutFailure`がrunning以外でno-opを返す既存の意図と揃えたものである。
      **完了条件**: API停止中にWorkerが完了しても結果が失われない／Worker稼働中および再起動後に
      未送信結果を再送できる／同じ結果を複数回送ってもDB反映は一度だけ／APIがfrom→toのFSMを
      強制する／APIがACKするまで次Jobへ進まない／Workerから本体DBへ直接アクセスできない

      **attemptとOutbox eventの対応（2026-07-31確定）**: 1 Job行＝1 attemptであり、
      Outbox eventは`jobId`＋Worker生成の`event_id`で該当attemptに紐づく。attemptの
      再実行（`base_commit_hash`を引き継ぐ新Job行の作成）は状態不明時のみ1回、
      `project-auto-worker-trust-boundary`側のgit worktree破棄・再実行設計に従う。
      **Outbox保存前のクラッシュで確定できなかった結果は救出しない**
      （at-least-once保証はterminal結果がOutboxへ永続化された後にのみ成立する契約とする。
      それ以前の実行は「unknown」として扱い、自動的に成功/失敗を推測しない）。
      **未送信eventが残っている間は新しいJobを取得しない**ことと、
      **stale recovery（状態不明判定・worktree破棄・自動retry）はOutbox整合性確認より後に
      実行しない**（起動順序: Outbox整合性確認→未送信event再送→状態不明attempt処理→
      通常pollJobs）ことを、この項目の実装がそのまま満たす設計とする。
<!-- roadmap:id=project-auto-db-safety state=done -->
5. [x] **本体DB安全・復旧基盤** — 依存: `project-auto-worker-trust-boundary`。
      `project-auto-worker-outbox`とは**並行実装可能**。
      本体DBを書き込める主体をAPIへ限定する／任意SQLを受け付けない／重要状態変更の監査ログ／
      定期バックアップ／世代管理／復元手順／**実際の復元テスト**／重要データの物理削除を
      通常フローから分離する／migration・一括削除の管理権限を分離する。
      **完了条件**: バックアップが自動作成される／世代管理が機能する／復元テストが成功している／
      重要な状態変更を追跡できる／AI・Workerが本体DBを直接削除できない

      **DB Safety A: production運用確認完了（2026-08-13確定）**: production fail-closed
      （`NODE_ENV=production`時の`DB_PATH`未設定・`:memory:`・ファイル不在での起動拒否）・
      WAL-safe backup（Online Backup API・`PRAGMA journal_mode=DELETE`によるWAL/SHM分離）・
      `PRAGMA integrity_check`+コアテーブル検証・世代ローテーション・isolated restore test・
      systemd user timer（6時間毎）・`loginctl enable-linger`まで実装・実測済み。**2026-08-13
      18:00 JST・2026-08-14 00:00 JSTの2回連続で、手動トリガーなしの完全無人自然発火→
      バックアップ作成→systemd journalでの成功ログ確認まで実測済み**（`journalctl --user -u
      ai-team-db-backup.service`で確認）。
      **DB Safety B: 完了（2026-08-14）**: 重要状態変更の監査ログを`audit_log`テーブル
      （actor/operation/entityType/entityId/result/createdAt）として新設し、既存の破壊的操作
      （KG系7種のdelete・permission_grants delete・approval-requests/approvalsの人間による
      承認・却下決定）へ計測を追加。監査記録は対象の状態変更と同一DBトランザクション内で
      書き込まれ、部分失敗（変更されたがauditが残らない状態）を防ぐ。migration/一括削除の
      管理権限分離は、対象となるランタイムAPIが存在しない（migrationは起動時の加算専用
      自動実行のみ、bulk delete/raw SQL経路は無く全delete文が単一entity指定）ため、新規admin/
      role基盤を追加せず現状で要件を満たすと判断（最小変更原則）。state-mutatingな全routes/
      storage操作の網羅確認済み（Task/Project等の通常CRUDはaudit対象外、review/QA結果は
      append-only履歴で追跡可能なため対象外）
<!-- roadmap:id=project-auto-project-roadmap-visibility state=done -->
6. [x] **Project別Roadmap可視化** — 2026-08-14実装完了、Mobile実機（Expo Go）でのruntime smokeも
      CEO確認済みのためdone。既存項目
      （`project-auto-completion-detection`＝Project完了判定のみ、`project-auto-ceo-alignment`＝
      Phase完了通知のみ、`project-auto-context-pack-wiring`＝AI CLIへのcontext供給のみ）とは責務が
      異なるため独立項目のまま完了とした。

      **Current Truth**:
      - implementation complete（下記実装範囲を参照）
      - tests/typecheck complete（`pnpm verify`全通過、API 579 tests・Worker 911 tests）
      - **Mobile runtime smoke complete**（2026-08-14、Expo Go経由の実機確認でCEOが確認済み。
        Goal・Design Philosophy・Roadmap全体進捗バー・進捗%・完了Task数/全Task数・
        Current Phase/全Phase数・Phase 1 completed/Phase 2 current/Phase 3 upcomingの位置関係・
        各Phaseのgoal・Phase別Task進捗・inactive旧Phase非表示・既存Project Detail表示、いずれも
        正常表示を確認）

      **正本設計**: Project別Roadmapのstructured source of truthはDB（新設`project_roadmap_phases`
      テーブル）とした。既存`POST /api/cto/generate-roadmap`のTask同期（`syncRoadmapTasks()`、
      db.transaction内でcreate/update/reactivate/deactivateとconflict検出を行う既存機構）が
      Phase同期より先にDB確定させる設計だったため、Task粒度は元々DBが実質的な正本であったことを
      確認した上で、不足していたPhase粒度（`name`/`goal`）だけを同一機構・同一transactionへ
      最小追加した。`docs/roadmap.md`はどこからも再読込されない書き込み専用のドキュメントである
      ことをコード調査で確認し、target-project内の人間向け生成snapshotという現状の役割のまま維持
      （parser新設・逆同期は行わない）。AIteamOS自身の`tasks/roadmap.md`（CEOのgit diffレビューに
      組み込まれたDocument SoT）とは統治モデルが異なるため、同じ方式を適用しないと判断した

      **Phase再同期の整合性**: `(projectId, phaseNumber)`をMVPのPhase識別に用いる。Job履歴がある、
      またはstatusが`pending`でないTaskを持つPhaseは「着手済み」とみなし、そのPhaseの`name`/`goal`
      変更を既存`RoadmapTaskConflictError`と同じ枠組みでconflict化して409で拒否する（Task側の
      spec freeze思想とPhase側を統一）。着手済みTaskを含まないPhaseは自由に更新できる。消失した
      Phaseは削除ではなく`roadmapActive=false`（Task同様、活動中Jobを持つ場合は拒否）。Phase/Task
      同期は同一DB transaction内で行い、一方の書き込みが失敗すれば両方ロールバックされる。Milestone
      entity・Phase UUID・generic versioning systemは追加していない

      **最小schema**: `project_roadmap_phases(project_id, phase_number, name, goal, roadmap_active,
      created_at, updated_at)`。PRIMARY KEY (project_id, phase_number)。既存`tasks`テーブルの
      `phase`/`roadmapTaskKey`/`roadmapActive`/`dependencies`/`acceptanceCriteria`はスキーマ変更
      なしでそのまま再利用した

      **実装範囲**: (1) Phase metadata storage（`schema.ts`/`interface.ts`/`sqlite.ts`）
      (2) `generate-roadmap`実行時のPhase+Task同期（`ctoAi.ts`、`roadmapTaskValidation.ts`へ
      `validateRoadmapPhases()`追加） (3) `GET /api/projects/:id/roadmap`読み取りAPI新設
      (4) Mobile Project Detail: Goal・Design Philosophy・Phase名/goal・Phase別Task進捗（
      `roadmapActive`なPhase/Taskのみ表示）、Roadmap全体進捗バー（completed active roadmap
      tasks / total active roadmap tasksの単純比率。Task weighting等は追加しない）、現在位置表示
      （active PhaseをphaseNumber順に並べ、全Task完了→completed、未完了Taskを含む最も早いPhase→
      current、それ以降→upcomingという既存dataのみの分類。新しいplanning algorithm・AI判断は
      追加していない）を追加。次Taskを決定するplanning algorithmは追加していない（既存data・既存
      API・既存job/approval状態の再利用のみ）

      **DB Safety**: additive migrationのみ（新規テーブル追加、既存テーブルへのALTERなし）。
      Roadmap生成/再生成はTask/Project通常CRUDと同様の性質（削除ではなくsoft
      deactivate、authorization/approval判断を伴わない）と判断し、`audit_log`（DB Safety B）の
      対象には追加しなかった（audit system自体の拡張は行わない）

      **完了条件（すべて満たした）**: Phase metadataがDB正本として取得可能／PhaseとTaskが再同期時
      にも矛盾しない（テストで検証）／`docs/roadmap.md`はsnapshotとして維持／Mobile Project Detail
      でGoal・Design Philosophy・Roadmap全体進捗バー・進捗%・完了Task数/全Task数・Current Phase/
      全Phase数・Phase位置関係（completed/current/upcoming）・各Phaseのgoal・Phase別Task進捗を
      確認可能（2026-08-14 Expo Go実機smokeでCEO確認済み）／inactive旧Phase/Taskが現在Roadmap表示
      へ混ざらないこと（実機確認済み）／既存Task Roadmap同期を壊さない（既存test全件regression
      なし）／新規Milestone/versioning/generic planning systemなし
<!-- roadmap:id=project-auto-task-job-chain state=done -->
7. [x] **Task→Job自動生成と連続実行** — 完了（PR #15 / #16、master `d4d4fa8`）。
      (a) はroadmap Task同期・Markdown保存・既存Design Review Gate通過後に
      `task:<taskId>:initial-implement` を生成する。 (b) は`git_commit` successを
      Task `done` と`task_continuations`のpending handoffへ同一transactionで永続化し、
      replay-safeに次Taskのinitial workflowを起動する。crash-window deterministic testsは5/5 PASS。
      新規Queue / Scheduler / Gateは追加していない。

      **runtime follow-up（MVP blockerではない）**: 実Worker runtimeが提供された時点で、
      live「1 Task完了 → 次Task開始」E2Eを1回だけ確認する。Gemini adapterについても同時に、
      PLの手動trust指定なしでrepository内ファイルをread-only取得できることを1回だけ確認する。
      これらの確認のためだけにcontainer・compose・runtimeを新設しない。

      **以下は実装前の設計調査履歴**: 実装済み範囲と矛盾する着手不可・不足範囲の記述は、
      上記の完了状態に置き換えられている。
      依存: `project-auto-worker-outbox` と
      `project-auto-db-safety` の**両方**。安全基盤が未完成のため実装項目としては着手不可。
      **加えて、GitHub外部強制境界（`project-auto-worker-trust-boundary`参照）が完成するまで、
      自律的なgit push/mergeを解放しない**（詳細は同項目参照。本項目へ内容を複製しない）。
      ただし**設計調査は継続中**（2026-07-30時点でCodex `gpt-5.6-sol` read-only独立レビュー実施済み）。
      **接続済み範囲と不足範囲**: workflowへ入った後の成功系
      `implement success → review Job自動生成 → approved → git_commit Job自動生成`は接続済み
      （`apps/api/src/routes/jobs.ts:361,303`）。一方、公開APIから`workflowStepKey`を設定できず、
      initial workflow Jobを作るproduction serviceも無いため、新規Taskからこのchainへ入る入口が無い。
      手動の`POST /api/jobs`とblocked Jobの`resume`は既に存在する。不足しているのは初回Jobの
      自動生成、次Taskへの自動継続、および主にfailure recovery側であり、chain全体が未接続なのではない。
      **設計方針**: DB Task同期とMarkdown保存の**両方**が成功するまで初回Jobを作らない／
      Worker結果がAPIへ確定反映されるまで次Jobを作らない／API側の**薄いapplication service**が
      Task状態更新と次Job生成を担当する（新しい常駐Orchestratorは作らない）／
      Task単位のqueued/running Job重複は、`workflow_step_key`のunique制約＋transaction内active Job
      チェック＋deterministic keyで防止する。`workflow_step_key IS NULL`のmanual Jobは同一Taskに複数active可
      という既存契約があるため、Task全体へのglobal partial unique indexは採用しない／
      `blocked`（Approval・Permission・Safety）、`rejected`、CEO操作が必要な場合、Worker起動時に
      attemptの状態が不明な場合、およびpaused Projectでは継続しない。**`failed`は一律停止条件にせず、
      failureの種類と安全な再試行条件に従ってStage 1/2へ振り分ける**／MVPでは単一Workerのみ／
      **Context Pack完全接続は含めない**。

      **Stage 1 — 限定technical/transient retry（Core Auto-Recovery完成ではない）**:
      次の条件を**すべて**満たす場合だけ、同一内容のJobを限定的に再実行する。
      - `aiCliPrompt`が完全一致し、provider・mode・SafeCommand等の実行条件も同一
      - rate limit・provider timeout・network transient等、機械的に再試行可能と判定できるfailure
      - 前attemptによるworktreeおよびHEADの変更がない
      - Taskの最新Design Review evidenceのhashが引き続き一致する
      - bounded retry、failure fingerprint、duplicate active Job防止、必要なTask状態同期を備える
      **Stage 1の対象外（自動修正しない）**: test/build/lint failure、implementation error、
      changed filesがあるattempt、review `changes_requested`、failure contextをpromptへ追加する必要が
      あるfailure。Stage 1は同一入力の限定的な再実行機能にすぎず、失敗内容を踏まえて実装を直す
      自動修正機能でも、Core Auto-RecoveryやFull Automationの完成でもない。

      **Stage 2 — Trusted Design Review経路完成後のauto-recovery**:
      test/build/implementation failureを踏まえた再実装、review `changes_requested`からの自動修正、
      changed promptに対するtrusted Design Review、異なる修正アプローチの試行を扱う。同じ失敗を
      無限反復せず、failure fingerprintとboundedな試行履歴に基づき、AIが合理的な解決手段を
      使い切った場合、一時的resource/external wait、またはCEO操作・承認・判断が必要な場合に
      Humanへescalateする。Safety Gate / Design Reviewは迂回・弱体化しない。

      **Stage分割の技術的根拠（2026-08-17 read-only確認）**:
      Design Review Gateは`computeDesignTextHash(input.aiCliPrompt)`で`aiCliPrompt`全体をhash化し、
      Taskの**最新**evidenceのhashと厳密比較する（`apps/api/src/designReviewEvidencePolicy.ts:46,55`）。
      Job型には`failureContext`/`failedTests`/`reviewFindings`等の専用フィールドが無く、failure contextを
      渡すには`aiCliPrompt`へ含めるしかないため、1文字でも加えるとhashが変わる。`contextFiles`は型に
      あるが、`jobRunner`は常に空配列を渡しており利用可能な経路ではない
      （`apps/worker/src/jobRunner.ts:665`）。hash対象外の経路でfailure contextを渡す設計はGateの
      実質的な迂回となり、stderr・test出力・review findingsにはprompt injectionも混入し得る。
      また全Jobは共有の`/workspace/target`で実行され、失敗後もresetされないため、前attemptの
      未commit変更が次Jobから見える（`apps/worker/src/jobRunner.ts:671`）。worktree隔離はroadmap上の
      計画だけで未実装。このためStage 1は「prompt完全一致かつworktree/HEAD変更なし」に限定し、
      failure contextや変更済みworktreeを扱う再実装はtrusted経路完成後のStage 2へ分離する。

      **2026-09-08 追記（PR-C 以降の新しい consequence。重複Findingは作らず本項目へ集約）**:
      この「共有 `/workspace/target` が失敗後も reset されず、前 attempt の未commit変更が
      次 Job から見える」問題は、**P1 Phase 1（workspace baseline 導入）以降、症状が変わった**。

      以前は「前 attempt の変更が次 Job の差分へ混入する（汚染）」だった。現在は、
      次の normal Job が clean worktree を要求する baseline を取得できず、
      **`workspace_baseline_failure` として quarantine される**（実測した理由文字列:
      `normal Job requires a clean worktree but found 2 changed path(s): ...`）。
      つまり静かな汚染ではなく、**workflow の停止**として顕在化する。

      **決定的な問題は、その quarantine を解除する actor が存在しないこと。**
      quarantine の再検証は Worker 起動時の `recoverJobsAtStartup()` →
      `recoverStaleJobs()`（`apps/worker/src/index.ts:605-607`）だけで、定期実行は無い。
      しかも clearance は clean worktree を要求するため、**未追跡ファイルが残っている限り
      Worker を再起動しても再び quarantine になるだけ**で、本質的に解消しない。
      2026-09-08 実測: production の `/workspace/target` は `? e2e/` が untracked のまま残り、
      同一の clean-worktree quarantine が「Mobile E2E」「Mobile E2E 2」の2 Project で連続発生した。

      したがって現状は **放置しても復旧しない**。root cause は本項目が扱う
      「共有 workspace を Job 間で reset しない」ことであり、根本対処は本項目の
      worktree 隔離（1 Job = 1 worktree）である。**新しい recovery subsystem を先に作らない。**

      **着手時に確認すること**: 残った変更をどの source Job が作ったかを
      persisted baseline / manifest / 既存 repair 情報から特定できるか、
      既存 `repairFlow` / reconciliation / manifest ロジックで
      継続・commit・revert・quarantine維持 のいずれかを安全に選べるか。
      **曖昧な変更を自動削除しない。安全に帰属できない場合は quarantine を維持し PL へエスカレートする。**
      CEO に Git 判断をさせない。

      **Cleanup-deadlock（2026-09-08 Phase 1/2 Operational E2E で2回実測。上記と同一 root cause のため
      別Findingにせず本項目へ集約）**: baseline を持たない quarantine と dirty workspace が重なると、
      **循環して抜け出せない**状態になる。

      - baseline 計算に失敗した quarantine には persisted baseline が無い。したがって clearance は
        「過去との一致」ではなく **known-good（clean worktree / clean index / marker 無し）** を要求する
        （PR-C で意図的にそう設計した。復元を主張できない以上、新しい安全な基準点を要求するのが正しい）
      - しかし workspace は dirty のままであり、**clean へ戻す正規の recovery path が存在しない**。
        `revertBlockedJobChanges()` は File Change Guard 違反時にしか走らず、しかも manifest 由来の
        変更しか対象にしない。untracked ファイルはどの経路でも掃除されない
      - 結果: clearance には clean が要るが、clean にする手段が無い → **quarantine が恒久化する**

      2回とも、CEO 承認を得た **path を限定した手動 cleanup** で脱出した。これは運用として持続しない。

      **注意（設計を弱めないこと）**: この deadlock の解決策として「clearance の known-good 要件を
      緩める」ことを選んではならない。その要件は「安全と証明できない限り所有権を解放しない」という
      hard invariant そのものである。**必要なのは clearance を緩めることではなく、workspace を
      安全に clean へ戻す正規経路**であり、それは本項目の worktree 隔離
      （1 Job = 1 worktree、破棄すれば dirty は残らない）で構造的に解消する。

      **今すぐ新しい cleanup subsystem は作らない。** 着手時は、残った変更の帰属を
      persisted baseline / manifest / 既存 repair 情報から特定できるかを先に確認し、
      安全に帰属できない場合は quarantine を維持して PL へエスカレートする。
      曖昧な変更の自動削除はしない。

      **UI 側の扱い（MOB-001 で対応済み・別責務）**: 自動復旧 actor が無い事実を
      Mobile 上で正直に表示する（「自動では復旧しません」）。復旧機構そのものは本項目の担当。

      **既知の穴（実コード検証済み）**: `POST /api/jobs`に同一Taskのqueued/running重複チェックが無く、
      `projectId`とTaskのProjectの一致検証も無い（`routes/jobs.ts:122-137`）。
      `Task.status`を自動更新するコードが存在せず事実上`pending`のまま。
      `approval_requests`に`project_id`列が無く`findWaiting()`が全Project横断で返るため、
      停止条件では`tasks`とJOINしてProject限定する必要がある。
      API側`TARGET_ROOT`は環境変数で可変だがWorker側は`/workspace/target`ハードコードのため、
      不一致時は全Jobがblockedになる（Job生成時にfail-closedで検出する）。
      `canExecuteCommands: false`のassignee（`cto_ai`/`context_manager`/`reviewer_ai`）が
      最小候補になると同じTaskを選び続けて永久停止するため、ロードマップ検証側で拒否する。
      **Task取得不能時のJob確定（2026-07-31 Codex指摘。変更検出修正では対処せず本Stepへ送る）**:
      Workerの`fetchQueuedJob()`は`/api/tasks`が失敗すると`if (!tasks) continue`で
      次のProjectへ進むため、**queued Jobをfailedへ確定できずポーリングに残り続ける**
      （`apps/worker/src/index.ts`）。AIは実行されないため安全側だが、
      「Task取得失敗はAI実行前にfailedで停止する」という状態契約を満たさない。
      正しく直すにはqueued Jobを先に取得して`taskId`からTaskを引くポーリング契約へ変える必要があり、
      API側の変更を伴うため本Step（薄いapplication serviceによる進行管理）の設計に含めて解決する。
      **Trusted Design Review evidence trust blocker（Stage 2着手前に解決必須）**:
      evidence authorityはAPI / Control Plane側に置き、Workerへevidence登録権限を与えず、既存の
      WORKER credential allowlistを拡大しない。Reviewer AIはreview実行者でありauthorityではない。
      Worker結果PATCH内でLLMを同期実行しない（結果PATCHのtimeoutは5秒）。既存Strategic Review、
      `design_review_evidence`、storage transaction、Job資産を最大限再利用する。
      `design_review_runs` 1テーブル案は**有力な最小案**だが最終実装としては未確定。Stage 2実装前に
      Production構成をread-only確認し、API runtimeのreview用credential、deploy artifact、runner配置を
      確認してから最終決定する。`apps/worker/scripts/designReview.ts`は自らevidenceをPOSTし、保存失敗を
      exit codeへ反映しないうえ、Worker build対象は`src`のみで`scripts/`はproduction `dist`に含まれない。
      したがって同script全体ではなくreview実行部分の`runStrategicMetaReview()`のみ再利用候補とする。
      hash対象外のfailure context経路やWorkerの自己申告でtrust blockerを回避しない。
      **完了条件**: 新規Taskからworkflowへ入る入口があり、1つのProjectで複数Taskが順に自動実行され、
      二重生成を防止し、Stage 1の限定retryとStage 2のtrusted auto-recoveryを区別して実行できること。
      通常failureは安全な範囲で自動回復し、指定した停止・Human escalation条件ではfail-closedになること
      （既存`resumeBlockedTask()`の原子的チェック＋作成パターンを流用）。Stage 1だけでは本項目を
      完了扱いにせず、Full Automation完成とも扱わない
<!-- roadmap:id=project-auto-recovery-e2e state=planned -->
8. [ ] **障害復旧E2E・自律実行有効化** — 依存: `project-auto-task-job-chain`。
      **確認シナリオ**: API停止中にWorkerが完了／API復旧後に結果再送／ACK消失による重複送信／
      Worker再起動／API再起動／Outbox書き込み後のクラッシュ／DB反映後・ACK前の通信切断／
      paused Project／blocked・failed・Approval待ち／同一Taskへの同時Job生成／
      バックアップからの復元。
      **完了条件**: 結果消失がない／二重反映がない／二重Job生成がない／復旧後に正しい位置から
      再開できる／異常時はfail-closedで停止する。
      **この項目の完了をもって自律連続実行を有効化する。**

      **確認シナリオへ追加（2026-07-31）**: 状態不明attemptの検出（Outboxに該当eventが
      存在しないrunning Job）／該当worktree・専用ブランチの破棄／同一`base_commit_hash`からの
      新attempt自動生成（1回まで）／2回目の状態不明でfail-closed停止し、CEO承認を要求せず
      既存のJob/Task失敗可視化経路にそのまま乗ること／replay-safeでないJob（既存
      `CommandKindSchema`に無い外部作用を伴うJob）は本メカニズムの対象にしないこと。
<!-- roadmap:id=project-auto-completion-detection state=done -->
9. [x] Project全体の完了判定 — **完了（2026-09-11 の棚卸しで実態を確認。実装は MOB-001 系で
      到達済みだったが ledger が追随していなかった）**。全Task完了をもってProject完了とみなす判定。
      **既知の穴（決着済み）**: `ProjectStatus`に`completed`が無い（`draft/running/paused/archived`のみ。
      `types/project.ts:3`）問題は、**状態を増やさず計算値にする**方向で決着した。
      **完了条件（達成）**: 完了/未完了がAPIで取得でき、Mobileから確認できること。
      `getRoadmapCompletion()`（`apps/api/src/routes/projects.ts:33`）が `roadmapActive` な Task
      だけを対象に `completedTaskCount` / `totalTaskCount` / `isComplete` を計算し、
      `GET /api/projects/:id/roadmap` が `completion` として返す。Mobile は
      `apps/mobile/app/index.tsx` で全 roadmap Task 完了時に「完了」バッジを表示する。
<!-- roadmap:id=project-auto-ceo-alignment state=planned -->
10. [ ] CEO Alignment Checkpoint: Phase完了・主要機能完成時にサマリーと当初計画との差分をCEOへ通知する。
      **通知後も開発は継続し、通常チェックポイントでは停止しない**。既存の`notifier`
      （LINE/Slack）・`summaryEngine.ts`・Approval Gateの再利用を前提とし、新しい停止Gateは作らない。
      **完了条件**: Phase完了時にCEOへ通知が届き、開発が止まらないこと。CEOが修正指示を返す経路は
      「追加開発指示（追加Task作成）」を使う
<!-- roadmap:id=project-auto-meta-review-hardening state=done -->
11. [x] **Meta Review MVP Hardening — Strategic Alignment / Review Load Distribution**（2026-08-13
      foundation実装完了。2026-08-14、残り3 Acceptance Criteria全件を実production経路への
      接続まで含めて完了しdoneへ）— 既存Meta Reviewer（`docs/meta_reviewer/`prompt/checklist、
      `apps/worker/src/metaReviewer/runner.ts`・`geminiRouter.ts`、AV-001保護）の改善。新しい
      Review基盤・新Agent種類・新Workflow engineは作らない。目的: 局所的には合理的な設計・実装が
      Goal / Design Philosophy / Constitution / CEO Decision / Roadmap目的と矛盾したまま実装
      されることを、実装前に検出して止める。

      **完了済みAcceptance Criteria（foundation実装、AV-001対象ファイルは無変更）**:
      - deterministic Review Load分類（`reviewLoadClassifier.ts`。Risk Levelとは独立、
        diff行数に非依存の固定ルール）
      - Risk Levelとの分離（コード上参照なし。独立モジュールとして実装・確認済み）
      - Focus selection（`focusSelector.ts`。既存7 checklistへのmapping、新checklist追加なし）
      - Strategic Alignment Review（Goal→Design Philosophy→Constitution→関連Decision→
        関連Roadmap item→Task→設計、の優先順位でcontext構築。Repository全文投入なし）
      - System-level Integration Review（Focused Review結果の矛盾・全体最適破壊を確認。
        diff本文の再レビューはしない）
      - ALIGNED / CONFLICT / UNCERTAIN判定（`strategicReview.ts`の`resolveFinalDecision()`）
      - REVIEW_UNAVAILABLE fail-closed（Gemini失敗・パース失敗・context欠如・checklist欠如の
        いずれでも`ALIGNED`にならないことをコード・テスト双方で確認済み）
      - design-review CLI（`apps/worker/scripts/designReview.ts`、
        `pnpm --filter @ai-team/worker design-review`で起動可能。実装前の設計テキストに対して
        動作する独立ツール。2026-08-13、実LLMによるE2Eで意図通りCONFLICT検出を確認済み）
      - 既存7 checklist再利用（新規checklistなし）
      - tests（`apps/worker`: 45 files / 886 tests、既存test regressionなし）

      **残り3 Acceptance Criteria（2026-08-14、全件完了）。読み方の確定: 「automatic hook」＝
      Task→Job Full Automationの有効化ではなく、実装開始を許可する既存経路の直前へDesign
      Reviewを必須preconditionとして接続できるinterface/hookを完成させること。protected file
      （AV-001）は今回変更していない）**:
      1. **Strategic Alignment Reviewのpre-implementation hook — 完了**: 当初
         `checkPreImplementationDesignReview()`を追加しただけでproduction呼び出し元が
         ゼロ件という未達が判明したため（2026-08-14中間確認）、Worker実行とAPI強制を分離する
         設計へ差し替えて実接続した。**APIはGemini/Codex認証情報を持たない**（実測確認済み:
         production API processのenvは`API_TOKEN`/`DB_PATH`/`HOST`/`NODE_ENV`/`PORT`/
         `OPENCODE_GO_API_KEY`のみで`CLAUDE_API_KEY`/`GEMINI_API_KEY`を含まない）ため、
         APIがGemini/Codexを直接呼ぶ設計は採らず、次の分離構成にした:
         Worker側（`designReview.ts`の`main()`）が既存`runStrategicMetaReview()`実行後、
         新規`persistDesignReviewEvidence()`で結果を`POST /api/design-review-evidence`へ
         POSTする（`apps/api/src/routes/designReviewEvidence.ts`新設。protected対象の
         `index.ts`は編集せず、既存の非protected`approvalGateRoutes`内で`app.register()`する
         形で追加）。サーバー側は`designText`から`sha256`を**自前で再計算**し
         （`apps/api/src/designReviewEvidencePolicy.ts`の`computeDesignTextHash()`。
         `approvalGate.ts`の`targetDiffHash`検証と同じ既存パターンを再利用。クライアント申告
         hashは信用しない）、新規`design_review_evidence`テーブル（`task_id`・
         `design_text_hash`・`review_load`・`decision`・`independent_review_required`・
         `independent_review_verdict`）へ保存する。**実強制点**: `jobs.create()`
         （`apps/api/src/storage/sqlite.ts`。`POST /api/jobs`・`resumeBlockedTask()`の両方が
         収束する唯一の低レベル関数であることを事前調査で確認済み）の直前で
         `checkImplementJobDesignReviewEvidence()`
         （`apps/api/src/designReviewEvidencePolicy.ts`）を呼び、`aiCliMode==='implement'`の
         場合のみ、最新evidenceの`design_text_hash`が今回の`aiCliPrompt`のhashと一致し、
         かつ`decision==='ALIGNED'`であることを要求する（不一致・エビデンスなし・
         ALIGNED以外はすべて409で拒否、fail-closed）。resume経路も同じ関数を呼ぶため
         迂回不可（`sqlite.ts`の`resumeBlockedTask()`内で同一chokepointを通ることをコードで
         確認済み）。非implement Job（`aiCliMode`未指定・`review`・`qa`・`summarize`）は
         この判定を一切通らない。**2026-08-16 Option A実装完了**: `POST /api/tasks`はTaskのみを
         作成してJobを作らない契約へ変更し、initial implement Job作成は既存`POST /api/jobs`へ
         完全に合流させた。Gateを通らずTaskとimplement Jobを同時作成できた
         `createWithInitialImplementJob()`はstorage interface・実装・結果型ごと削除し、将来の
         bypass経路として残していない。**2026-08-16 requeue hardening**: `PATCH /api/jobs/:id`で
         既存implement Jobを非queued状態から`queued`へ戻す際も、保存済みJobの`aiCliPrompt`に
         対して同じDesign Review Gateを再検証する。あわせて、公開Job作成APIが許容する
         implement + `git_commit` Jobをapproval承認SQLが再queueする経路にも同じ再検証を適用し、
         非implement Jobのstatus更新・git_commit承認にはGateを広げない
      2. **Critical Independent Reviewの実実行接続 — 完了**: `strategicReview.ts`に
         `runIndependentReview()`を追加し、`reviewLoad === 'critical'`のときだけ既存
         `reviewerAdapter.ts`の`createReviewerAdapter('codex')`（既存のCodex独立レビュー機構。
         reviewer専用モデル`gpt-5.6-sol`、primaryのGemini呼び出しとは別プロバイダ・別モデル・
         別呼び出し）を実行し、結果を`finalDecision`へ反映する
         （`applyIndependentReviewOverride()`: blocking→CONFLICT、changes_requested時ALIGNED→
         UNCERTAIN、reviewer自体が失敗/未応答→fail-closedでREVIEW_UNAVAILABLE）。**この経路は
         `designReview.ts`の`main()`＝既存の`design-review` CLI（`pnpm --filter @ai-team/worker
         design-review`）という、変更前から存在する本物のproduction entry pointから実際に
         呼び出し可能**（1と異なり、この呼び出し元は新設ではなく既存CLIそのもの）。新しい
         Reviewer Agent・Provider Router・Workflow engineは追加していない。independenceは
         テストで検証済み（primary Geminiのprompt/応答が独立レビュー呼び出しへ混入しないこと
         を個別テストで確認）
      3. **Production相当E2E — 完了**: 二層で実証。(a) `apps/worker/scripts/
         designReview.e2e.test.ts`が、Review Load分類・Focus選択・Strategic Alignment・
         Integration Review・Independent Review（上記2）という核心ロジックを実際の
         production code path経由で検証（LLM/CLI呼び出し境界＝`callGeminiWithFallback`・
         `createAiCliAdapter`のみモックし、ALIGNED/CONFLICT（rollback時DB safety迂回、
         2026-08-13の実LLM E2Eと同じ設計内容）/UNCERTAIN/CRITICAL/reviewer unavailableの
         5シナリオを確認）。(b) `apps/api/src/routes/jobs.test.ts`「POST /api/jobs Design
         Review evidence gate」が、実際の`POST /api/jobs`・`POST /api/tasks/:id/resume`
         route（`app.inject()`）を通し: ALIGNED evidenceあり→201成功／evidenceなし→409／
         CONFLICT・UNCERTAIN・REVIEW_UNAVAILABLE→409／レビュー対象と異なるdesign textでの
         古いALIGNED（hash不一致）→409／resume経路でのevidenceなし→409／CRITICALで
         independent review未承認→409／CRITICALでindependent review承認済み→201／
         非implement Jobはevidenceなしで成功、を確認。新しい巨大E2E frameworkは作らず、
         既存`strategicReview.test.ts`・`jobs.test.ts`と同じvitest/`app.inject()`方式を再利用。
         加えて`tasks.test.ts`で、`POST /api/tasks`→201かつJob 0件、evidenceなしの後続
         `POST /api/jobs`→409、matching ALIGNED evidence保存後の同prompt→201を実routeで確認した。
         requeueについても`jobs.test.ts`でevidenceなし・CONFLICT・UNCERTAIN・
         REVIEW_UNAVAILABLE・stale・CRITICAL独立承認なしの409とALIGNEDの200を、
         `approvalGate.test.ts`でimplement + `git_commit`承認時の拒否・成功を実routeで確認した

      **完了条件（達成）**: `POST /api/tasks`はTaskのみを作成し、implement Job作成は既存
      `POST /api/jobs`へ合流する。Design Reviewを呼ばずにimplement Jobを作成できる全productionの
      経路（`POST /api/jobs`・resume・PATCH requeue・approval requeue）はAPI側で機械的に拒否され、
      旧Task＋initial implement Job同時作成APIも削除済みであることを実route経由のE2Eとcall site確認で
      証明した。
      Review Load分類・Strategic Alignment・Integration Review・Independent
      Review・fail-closedのすべてが実production経路で実証された
      （`apps/api`: 39 files / 633 tests、`apps/worker`: 46 files / 911 tests、既存test
      regressionなし。`pnpm verify`・`git diff --check`成功。AV-001対象ファイルは無変更）。
      既存の統合Meta Review（LOW時）・既存Implementation Meta Review（`autoReview.ts`）の
      挙動は変更していない

**将来項目（Step 2系の完了後に個別判断。今回は着手しない）**

<!-- roadmap:id=meta-review-structured-output-robustness state=planned -->
12. [ ] **Meta Reviewer structured-output robustness / false-BLOCKED の解消** — 2026-09-07、PR #98 / #99
      の実測により登録。`project-auto-meta-review-hardening`（上記11、done）の後続で、**同じ既存
      Meta Review経路の改善**である。新しいReviewer・新しいReview基盤・新しいGateは追加しない。

      **観測された事象1: format/parse failure による false BLOCKED**
      Geminiが JSON 指定にもかかわらず prose / fenced JSON（```json や「## フェーズ1: …」で始まる
      説明文）を返すと、parserが失敗し `[critical] Meta Review AIの応答が不正なフォーマットです`
      として fail-close BLOCKED になる。**substantive review自体は成功しているのに format だけで
      失敗するケースがある**（PR #98 の1回目の実行では、ownership/quarantine機構に対する肯定的で
      具体的な講評が応答内に出力された後、parse段で失敗している）。PR #98では3回連続で再現した。
      同一failureへの blind retrigger は provider quota を浪費するだけで解消しない。
      大きなdiffで再現しやすい可能性はあるが、**現時点では断定しない**（PR #98は約4,300行）。

      **観測された事象2: 二点間diffによる phantom deletion で false BLOCKED**
      `apps/worker/src/metaReviewer/autoReview.ts:75` が
      `['diff', baseSha, headSha]`（**二点間diff**）でreview対象を構築している。`BASE_SHA` は
      `.github/workflows/meta-review.yml:69` で `github.event.pull_request.base.sha`（**現在の**
      base tip）が渡されるため、PR head が base の一部commitより古いと、**その base側commitが
      「削除」として現れる**。実例: PR #99 は `tasks/roadmap.md` のみ71行追加のdocs PRだったが、
      Meta Reviewは「Project開始ワークフロー全体が削除された」として `BLOCKED / critical` を返した
      （PR #97 を含まないbaseからbranchを切っていたため）。rebase後に同じPRはPASSした。
      本セッション中に同種のphantom deletionを複数回観測している。

      **注意: これは「reviewの前にbaseを最新化する処理が無い」問題ではない。** baseはむしろ最新
      であり、head側が古いまま**二点間**で比較されることが原因である。したがって新しい
      「base最新化gate」を追加するのではなく、diffの取り方を直すのが正しい対処である。

      **対応方針（実装時。新Reviewerを足さず既存Meta Reviewを改善する）**:
      - provider側の structured output / JSON schema 強制（`geminiRouter.ts` は既に
        `--output-format json --json-schema` を渡せる。Meta Review経路へ接続できるか確認する）
      - fenced JSON（```json …```）の安全な正規化
      - parse failure時に**既に得られている substantive response を捨てない**設計
        （少なくともログ/PRコメントへ残し、人間が判断できるようにする）
      - 同一 parse failure に対する bounded retry（無限・無制限の retrigger を避ける）
      - 事象2は `autoReview.ts` の diff を三点間（merge-base起点、`baseSha...headSha` 相当）へ
        変更することで解消する。既存のBASE_SHA受け渡し自体は変更しない

      **今回実装しないもの（明記）**: 本項目はFinding記録であり、PR-C（#98）のmergeとは分離する。
      新しいReviewer種別・新しいReview基盤・新しいmerge gate・base最新化専用gateは追加しない。

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

      **2026-09-07 追記（P1 Phase 2 独立レビュー B5）**: 同一 workspace を所有する Job が同時に
      走らないことは、現状 **host レベルの `flock -n`（Worker unit の ExecStart）と Worker プロセス内の
      `findWorkspaceOwningTaskId()` の組み合わせ**で担保されている。本番でこの flock は実測済みであり、
      P1 Phase 2 の blocker ではない。ただし **`jobs` schema には `working_dir` の lease も
      active-owner 制約も無い**ため、所有権は durable な制約ではなく運用構成に依存している。
      これは containment とは別 root cause であり、本項目（atomic claim / ownership・lease）で扱う。
      新規 Finding は起こさない（重複のため）。
<!-- roadmap:id=project-auto-resource-allocation state=deferred -->
4. [ ] **AI Resource Allocation / Capacity管理**（2026-08-14監査により新規登録。現状Repository上に
      完全未登録であることを確認済み。単一Worker前提のMVPでは配分問題自体が発生しないため
      `project-auto-multi-worker`の後続として位置づける。**現在のMVP順序には割り込ませない**）。
      概念のみ登録（仕様詳細・実装は今回追加しない）:
      - Project別のAI resource allocation
      - 固定処理量
      - 過去utilization / idle capacityの把握
      - 配分時の進捗予測
<!-- roadmap:id=project-auto-incident-pattern-improvement state=planned -->
5. [ ] **ヒヤリハット・反復非効率検知 — Incident Pattern Improvement Loop**（2026-08-13仕様反映。
      `AIteamOS ヒヤリハット・反復非効率検知機能 仕様設計`に基づく）— 新しい独立Incident Management
      System / Quality Management System / Lesson Systemを作るものではない。既存の
      `Telemetry → Team Health → Self Diagnosis → Improvement Planner → CEO Proposal →
      Experiment / Evolution`（本ファイル944-1030行、`specs/13_future_system_architecture.md`
      5b章）を再利用し、「AI Team OS内部で反復するヒヤリハット・非効率・無駄行動を自動検出し、
      原因分析と改善提案まで行う」という具体的end-to-endユースケースを完成させるための統合
      milestone。新しい実装基盤を意味する項目ではない。**MVP完成までは実装しない**（roadmap登録の
      み）。DB Safety / Meta Review Hardening / Worker Outbox / Task→Job automationの実装順序を
      この項目のために変更しない。

      **責務分担（既存Service Extensionへの分散統合方針）**:
      - **Telemetry**: Incident Candidate（`incident_id`/`timestamp`/`project_id`/`task_id`/
        `job_id`/`actor_type`・`actor_id`/`department`/`workflow`/`process_stage`/
        `incident_category`/`trigger`/`action_taken`/`result`/`estimated_impact`/
        `reversibility`/`blast_radius`/`evidence_strength`/`wasted_time`/`wasted_ai_cost`/
        `retry_count`）に必要な最低限の事実を記録可能にする。既存ログ（Job実行履歴・Review結果・
        Approval Gate・Watchdog・failure/retry/blocked記録）を最大限再利用し、不足分だけ最小
        event記録を追加する。Secret・Prompt全文は無条件保存しない
      - **Team Health**: actor（Claude Code/Codex/ChatGPT/Reviewer AI/Worker/Scheduler/Planner/
        特定Workflow/特定Department/System Rule/Human/CEO/External Service/Unknown）・
        department・workflow別のIncident反復傾向を可視化する。実行量補正指標
        （Incident/100 Jobs等）を併用し、**件数だけで部署・actorを悪いと判定しない**
      - **Self Diagnosis**: 意味的に類似したIncidentをProblem Clusterへ集約する（完全一致では
        ない）。Repeat Level（0:単発／1:類似確認／2:反復可能性高／3:構造的問題／
        4:改善後も再発）を判定し、Level 3以上を改善候補とする。重大Incident
        （データ消失・セキュリティ事故・本番破壊・復旧困難・高額コスト・CEO承認領域の無断変更）は
        **反復を待たず即時分析対象とする**。Direct/Root/System/Actor/Environment Causeへ分解し、
        **外部障害（VPS/API障害・rate limit等）をAIの失敗として誤分類しない**、
        **Context供給不足等のSystem CauseをActor責任と誤認しない**
      - **Improvement Planner**: 反復Problem Clusterから改善候補を生成する。優先順位は
        既存機能の改善→既存Rule変更→既存Prompt改善→既存Workflow改善→既存レビュー改善→
        **新規機能追加は最後の手段**。CEOへ出す前に内部セルフレビュー（本当に必要か／偶発事象
        でないか／既に対策済みでないか／既存機能で対応できないか／重複にならないか／改善コストが
        利益を上回らないか／別の非効率を生まないか／安全性を過剰に高め速度を落とさないかを自問）を
        通過したものだけ候補とする。**過剰安全策・過剰レビュー自体もIncident候補として扱う**
      - **CEO Proposal**: 個別Incidentの一覧ではなく改善提案単位で提出する。**通常は週1〜2件**
        （CEOレビューが新たなボトルネックにならないようにする）。ただしCritical
        （データ消失リスク・セキュリティ重大問題・復旧困難・大規模障害・大きな金銭損失・
        改善後の重大事故再発・AI Team OS自身の制御不能につながる問題）は**件数制限なしで即時
        提出可能**。CEO Actionは`Approve` / `Reject` / `Deep Dive` / `Modify` / `Defer`とし、
        既存Approval Gate/CEO Proposal経路をそのまま使う。新しい承認経路は作らない
      - **Experiment / Evolution**: 改善実装後の再発率を追跡する
        （`improvement_id`/`implemented_at`/`expected_effect`を紐付け、`Resolved`/`Improved`/
        `No Effect`/`Worse`/`Insufficient Evidence`で判定）。**改善後も再発した場合はRepeat
        Level 4へ引き上げる**。根本方針（Goal/Design Philosophy/Constitution等）の変更が
        必要な場合は既存のCEO Approval経路をそのまま使う

      **重要な設計条件（Acceptance Criteriaとして必ず維持）**:
      - 単発偶発Incidentでは原則Improvement Proposalを作らない（記録のみ）
      - 重大Incidentは反復を待たず即時分析対象とする
      - 同一actor / department / workflowでの反復を、全体件数比較より重視する
      - 部署間の単純件数ランキングを改善対象選定の主判定にしない
      - 外部障害をAIの失敗として扱わない
      - Context不足等のSystem CauseをActor責任と誤認しない
      - 改善案は新規機能追加より既存機能改善を優先する
      - 過剰安全策・過剰レビュー自体もIncident候補として扱う
      - この機能自身が大量token・大量LLMレビューを消費しない（全Jobへの追加LLMレビュー・
        全Taskの常時LLM再分析は行わない。既存ログ・既存レビュー結果の再利用を基本とする）
      - CEOへの通常Improvement Proposalは週1〜2件、Criticalのみ件数制限なし
      - 改善実装後の再発を追跡する
      - **改善案の自動実装は禁止**。`Incident → Cluster → 反復検知 → 原因調査 → 改善案 →
        AI内部レビュー → CEO Proposal → CEO承認 → 通常のAI Team OS Task → 既存開発Workflow`
        という既存経路のみを使う。改善機能専用の別実装ルートは作らない

      **Document Rotとの関係（2026-08-13、Document Architecture Audit実施により追記。新規
      roadmap項目は追加せず本項目へ統合）**: 既存ログ・既存Review・既存Diagnosis等によって
      **既に検出された**Document Rot / Doc↔Code Drift（Append-only Rot・Internal
      Contradiction・Duplicate Truth・Dangling Reference・Orphan Document・Structural
      Degradation等）は、Incident Candidate / Problem Clusterとして本項目のend-to-end
      （反復原因分析→改善提案）に接続できる。**本項目がDocument Rotを能動的に検出する責務は
      持たない**。repository全体の定期Document scan・Orphan Document専用crawler・Document
      Integrity専用Agent・専用Gate・専用Workflow・常時LLM巡回はいずれも本項目の範囲外であり
      新設しない。

      **MVP完成までに行うこと**: roadmap登録（本項目）のみ。既存ログ（Job実行履歴・Review結果・
      Approval Gate記録・Watchdog・failure/retry/blocked記録等）を、後から分析可能な状態で
      失わずに保存し続けていることの確認のみ行い、新規実装は行わない

      **MVP完成後・初期実装（最小構成）**: 既存ログからのIncident Candidate抽出／類似Incident
      clustering／Repeat検知／重大Incidentの即時昇格／上位1〜2件だけの原因分析／Improvement
      Proposal生成／CEOへ週1〜2件提出。これ以上の巨大な品質管理システムを最初から構築しない

      **後段階（必要性が実証されてから追加。最初から実装しない）**: 高度なActorランキング、
      Incident専用の大規模DB、Incident専用Agent群、Incident専用Workflow engine、Incident専用
      Approval Gate、全Jobへの追加LLMレビュー、常時LLM分析、自動改善実装、Review/Prompt自己進化、
      高度な効果測定Dashboard

      **成功指標（実装時の参考。件数発見量では測定しない）**: 同一Problem Clusterの再発率低下／
      無駄なJob・retry減少／手戻り減少／AI作業時間削減／CEOへの不要な確認減少／重大Incident再発率
      低下／改善による新たな複雑性を増やしていないこと

      **完了条件**: Incident Candidate抽出→Problem Cluster集約→Repeat Level判定→上位候補の原因
      分析→Improvement Proposal生成→CEO週次提出、のend-to-endが最小構成で機能すること。既存
      Telemetry/Team Health/Self Diagnosis/Improvement Planner/CEO Proposal/Experiment/
      Evolutionの責務定義（本ファイル944-1030行）と重複する独立実装を作っていないこと
**統合設計確定（2026-09-01、CEO承認。項目6・7・8・9の関係を以下に固定する）**:
Natural-language Project Definition → AI structured constraints → Readiness → Roadmap
generation → deterministic constraint validation → whole-roadmap independent Design
Review → Task sync → individual Task Design Review → Implement、の順序で統合する。
項目6はstage 1-3、項目9はstage 4-6（項目8はstage 6が毎回自動判定する既定ルールの1つとして
内包し、専用Gateを新設しない）、stage 7-9は既存のまま変更しない。**着手順序: 項目6 →
項目9+8統合 → Phase 1c自然文Goalでの再検証 → 項目7**（項目7はDesign Reviewの判定自体が
信頼できるようになってから着手する）。

CEOレビューで以下3点を各項目の設計へ反映する（詳細は各項目内に記載）:
1. 項目6: 「Mobile操作は無変更」ではなく、通常のProject作成体験は維持しつつ、重要なGapが
   ある場合のみ既存Gap Analysisの質問・回答をMobileフローへ接続する
2. 項目9: authoritative Project Definition / Structured Constraints / Roadmap /
   Whole-Roadmap Review evidenceをversion/hashで結び、Review後に定義またはRoadmapが
   変わった場合は古いReview evidenceを再利用できないようにする（新Gateではなく既存の
   Review freshnessの延長として扱う）
3. 項目8/9: Control-plane SeparationはWhole-Roadmap Reviewだけに依存せず、Task
   purpose/categoryを構造化して機械判定可能なものはdeterministic validatorでも拒否し、
   semantic Reviewではcategoryと実際のTask内容の一致を独立確認する

<!-- roadmap:id=interactive-project-definition-readiness state=done -->
6. [x] **Interactive Project Definition / Readiness — 完了（2026-09-01）**。
      PL交代（Codex→Claude）時のread-only監査で、Codexから「別責務としてRoadmapへ登録した」との
      報告があったが本リポジトリの`tasks/roadmap.md`・`tasks/task_graph.md`・
      `docs/project_memory/`・全commit履歴のいずれにも存在しないことを確認したため、正式に
      本項目として登録し直した。

      **背景**: authoritative spec `specs/09_project_creation_flow.md` に、Project作成→
      Specification Analysis→Gap Analysis→不足情報をユーザーへ質問→Readiness Review→CEO Approval→
      Initialization→Roadmap、という正式フローが定義済み。GapごとにCEO回答／Skip／AI仮決定を扱う
      仕様も存在する。実装部品として`specAnalyzer`・`POST /api/cto/analyze`は既に実装済み。
      **しかし通常のMobile Project作成導線（`draft→running`）はこれを呼んでいない**。
      `projectInitialization.ts`が不足項目を空のまま扱い、Readinessを固定`100`にしてRoadmap生成へ
      進んでいる。これは既存機能のregressionではなく、**正式仕様＋既存部品が通常Mobile導線へ
      統合されていない**状態。

      **目的**: Project作成→AI解析→Goal/Design Philosophy/Scope/Constraints/Success Criteria等の
      不足検出→必要な場合だけCEOへ質問→Project Memory/authoritative definitionへ反映→Readiness→
      Approval→Roadmap、という一連の流れを通常のMobile導線へ接続する。既存の
      `specAnalyzer`/`POST /api/cto/analyze`・Project Memory・Approval・Roadmap同期を再利用し、
      **新しいQueue / daemon / Gateは安易に追加しない**。

      **Project Definition Truncation Prevention（2026-09-01追加。Phase 1c Minimal Production E2E
      Project作成時の実測で発見。本項目の一部として扱う）**: `GET /api/projects/{id}`の`goal`が
      ちょうど500文字で切れており、CEOが実際にMobileへ入力したProject Definition（Goal本文の後に
      Constraints・Success Criteriaが続く想定だった）が欠落していた。原因を特定済み:
      **Mobile側UI入力欄のsilent truncationであり、API/Storage/DBには文字数制限が存在しない**
      （`apps/mobile/app/create.tsx:82` `<TextInput maxLength={500} ... />` — Goal欄のみに
      React Native `TextInput`の`maxLength`が設定されており、上限到達後は警告・エラーなしに
      入力・貼り付けが無音で切り捨てられる。対して`apps/api/src/routes/projects.ts`の
      `CreateProjectBody`は`goal: z.string().min(1)`で上限なし、`apps/api/src/storage/schema.ts`の
      `goal TEXT NOT NULL`もSQLite TEXTで無制限）。**したがって500文字はMobile UI由来の恣意的な
      上限であり、API/schema/DB側の制約ではない**。名前欄`maxLength={100}`も同様の恣意的UI上限。
      **重大な帰結**: このProjectのDesign Review ALIGNED判定は、CEOが意図した完全なGoalに対してではなく、
      **truncateされた500文字のGoalに対する判定**であった可能性が高い。「CEOが意図した完全GoalとのALIGNED」
      とは扱わない（該当Project `95509639-7cf2-47b8-af70-d2fdf28958b3`はresumeせず証拠として保持。
      詳細は本ファイル該当コミットの経緯を参照）。
      **完了条件に追加**: authoritative Project Definitionをsilent truncateしない／UI・API・Storage間で
      情報を欠落させない／文字数上限が必要な場合は保存前に明示的に拒否・警告する（無音での切り捨てをしない）／
      structured Project DefinitionをProject Memoryへ保持する／Roadmap生成・Design Reviewが
      同一の完全なauthoritative definitionを参照すること。

      **Mobile UX方針（2026-09-01、CEOフィードバック反映。「Mobile操作は無変更」ではない）**:
      通常のProject作成体験（名前・Goal・Design Philosophyを入力してすぐ開始できる、という
      現行のシンプルさ）はそのまま維持する。**重要なGapがある場合だけ**、既存Gap Analysis
      （`specAnalyzer`）の質問・回答をMobileフローへ接続する。機械的に確定できる項目や
      軽微なGapはCEOに聞かず自動確定し、Goal/Design Philosophyの根幹に関わる項目・曖昧で
      機械判定できない項目だけをMobile上でCEOに質問する。**質問はGapがある時だけ発生し、
      通常は今までと同じ体験のまま完了する**。

      **実装内容（完了、PR #61 `feat/interactive-project-definition`）**:
      - **Truncation Prevention**: `apps/mobile/app/create.tsx`のGoal欄から`maxLength={500}`を
        削除。API/DB側はもともと無制限のため、Mobile UI由来の恣意的な上限を撤廃しただけ
        （名前欄`maxLength={100}`はAPI側の`z.string().max(100)`と一致する非silentな上限のため維持）。
      - **Gap Analysis接続**: 新規`apps/api/src/ctoAi/projectDefinitionAnalysis.ts`
        （`analyzeProjectDefinition()`）が、Project.goal/designPhilosophyから既存
        `specAnalyzer.analyzeSpec()`（Claude Haiku、新しいLLM呼び出し経路は追加していない）を
        呼び、既存`POST /api/cto/analyze`と同じ基準（`severity: 'must_resolve'`＝重要Gap）で
        重要Gapだけを抽出する。`routes/projects.ts`の`PATCH /api/projects/:id`が、**Roadmap未生成
        での初回running遷移の場合だけ**（resumeは対象外）これを呼び、重要Gapが残っていれば
        `409 { error: 'Project Definition has unresolved gaps', project, gaps }`を返して
        running化を止める（ただしgoal/designPhilosophy等の編集は保存する）。重要Gapが無ければ
        （＝通常の大半のケース）今まで通り即座にRoadmap生成へ進む。解析結果（`SpecAnalysis`）は
        `initializeApprovedProject()`の既存`options.analysis`にそのまま渡され、`gap_analysis.md`
        等のProject Memoryへ実際の解析内容が反映されるようになった（従来の
        `buildApprovedProjectAnalysis()`という空gaps・固定readinessScore100のpass-throughは、
        Roadmap未生成の初回起動時だけ実解析へ置き換わった）。
      - **Mobile UI**: 新規`apps/mobile/app/projects/gaps.tsx`。「開始」ボタンが409＋gapsを
        受け取ると自動的にこの画面へ遷移し、Gapごとに自由記述で回答（空欄でスキップ）できる。
        回答は`gapAnswers`として次のPATCHへ渡され、再解析で重要Gapが解消されていれば
        そのままrunningへ進む（2回目の「開始」タップは不要）。まだ残っていれば同じ画面で
        続けて聞く。
      - **新しいQueue/daemon/Gateは追加していない**。既存`specAnalyzer`・
        `initializeApprovedProject()`の`options.analysis`・既存Project作成/PATCH APIを
        そのまま再利用。

      **テスト**: `apps/api`に`projectDefinitionAnalysis.test.ts`（7件）と、
      `routes/projects.test.ts`へGap Analysis gatingのテスト5件（重要Gapでblockされ
      running化されないこと／should_resolve・optionalはblockしないこと／回答して再送すると
      2回目の手動操作なしに進むこと／blockされた際もフィールド編集は保存されること／
      resume（hasActiveRoadmap）はGap Analysisを再実行しないこと）を追加。`apps/api`全体
      60ファイル/893テスト成功、`apps/mobile`10テスト成功、両パッケージ`tsc --noEmit`成功。

      **今回の作業範囲**: Approval Policy・Architecture・DB migration・認証・secretの変更は
      行っていない。**Phase 1c（Phase 1c Minimal Production E2E）のscopeへは混ぜていない。**

      **完了条件（達成）**: 通常のProject作成体験を壊さずGap Analysisを接続、Truncation
      Preventionを実装、既存テスト（`apps/api`・`apps/mobile`）がregressionなく通過することを
      確認済み。

      **残っていた4項目の追加実装（同PR #61ブランチへの追加commit、2026-09-01完了）**:
      PL（Claude）による8条件（本節冒頭6条件＋統合設計確定文書の2条件）に対するread-only
      gap分析で、上記実装内容が「structured constraints抽出」「authoritative definitionの
      version/hash」「Roadmap生成が同一definitionを参照」「definition変更後の古いReview
      evidence再利用防止」の4条件を満たしていないことを確認。既存機構の再利用のみで追加:
      - **Structured constraints**: `specAnalyzer.ts`の`SpecAnalysisSchema`へ
        `structuredConstraints`を追加。プロンプトは「明示的・曖昧でない記述だけを抽出し、
        曖昧・重要な場合は推測せずmust_resolve Gapとして質問する」と明記（新しい質問経路は
        追加していない）。
      - **Version/hash**: `computeProjectDefinitionHash()`（sha256、
        `designReviewEvidencePolicy.ts`の`computeDesignTextHash()`と同じ方式）と、
        `docs/project_memory/project_definition.json`（definitionHash・structuredConstraints・
        constraintsHash等）を`writeProjectMemory()`へ追加。**DB migrationは行っていない**
        （既存のProject Memory書き出し＋`commitGeneratedDocs()`をそのまま再利用）。
      - **Roadmap生成への伝播**: `roadmapGenerator.ts`のプロンプトへcanonical definition
        text・definitionHash・structuredConstraintsを追加（resume等fresh analysisが無い
        呼び出し元は従来通り、後方互換）。
      - **Freshness guard**: `PATCH /api/projects/:id`が、Roadmapが既に存在するProjectへの
        goal/designPhilosophy変更を`409`で拒否する（新しいGateではなく既存バリデーションの
        拡張）。再生成そのものは項目9の範囲として実装しない。
      - **Readiness閾値の統一**: `POST /api/cto/analyze`（readinessScore>=70）と
        `PATCH /api/projects/:id`（must_resolve Gapのみ）で異なっていた採否判定を
        `isProjectDefinitionReady()`へ共通化。

      Codex CLI（別プロバイダ、OpenAI/GPT-5.5）による独立レビューを2回実施:
      1回目（gap分析結果の実装に対するレビュー）で、readinessScore単体でblockする際に
      具体的なGapが0件だとMobileのGap回答画面（質問カード＋回答欄前提のUI）が
      行き止まりになるblocking issueを検出。`isProjectDefinitionReady()`が
      readinessReasonから合成Gapを1件生成する形で修正し、新しいUIを追加せず既存の
      Gap回答フローへ載せた。2回目のレビューでは残課題なしを確認。

      Meta Reviewer AI（Gemini、CI）が`ProjectDefinitionGap`（Mobile）・
      `StructuredConstraint`（API）がAPI/Mobile間・複数ctoAiモジュール間で共有されるべき
      型でありながら個別宣言されていた点をCHANGES_REQUESTEDとして指摘。
      `packages/shared/src/types/project.ts`へ`Gap`・`StructuredConstraint`を追加し、
      `specAnalyzer.ts`のZod schemaを`z.ZodType<Gap>`等で型として強制、Mobile側は
      shared型のaliasへ差し替えて対応（APPROVED再取得）。

      **既知の残課題（今回のscope外、記録のみ）**: `POST /api/cto/generate-roadmap`
      （手動呼び出し用の旧経路）は呼び出し元が渡す`analysis`をそのまま使うため、
      Project行のauthoritative definitionと乖離しうる。通常のMobile導線
      （本項目が対象）には影響しないため今回は対象外。

      最終検証: `apps/api`（60ファイル/905テスト）・`apps/mobile`（10テスト）・
      `packages/shared`（4ファイル/54テスト）全て成功、3パッケージとも`tsc --noEmit`成功。
      Meta Reviewer AI・Typecheck & Test 両requiredチェックとも green（bypassなし）。
      PR #61は通常のmerge手順でmaster統合済み（`b01b9c3`）。
<!-- roadmap:id=design-review-conflict-recovery state=done -->
7. [x] **Design Review CONFLICT Recovery — 完了（2026-09-02）**（2026-09-01登録。上記と同じ経緯で、
      Codexからの登録報告が本リポジトリに見つからなかったため正式登録し直す）。

      **目的**: Design Review CONFLICTが発生した際、PL（AI）がCONFLICTの理由を分析し、
      Goal / Design Philosophy / Approval Policyを変更せずに修正可能な場合はRoadmapを自動修正して
      Design Reviewを再実行し、ALIGNEDを目指す。Goal / Design Philosophy / Approval Policyの変更が
      必要な場合のみCEOへエスカレーションする。

      **既存項目との関係（重複実装にしないこと）**: 既存の`resumeBlockedTask()`・Mobile resume UI
      （PR #47 `codex/resume-design-review`・PR #48で拡張済み）は、**CEO/人間が新しいinstructionを
      与えて再レビューさせる人間駆動の経路**。本項目は**PL（AI）がRoadmap側を自律的に修正して
      再試行する経路**であり別責務。`project-auto-task-job-chain`のStage 2 auto-recovery
      （本ファイル1112-1117行）とも、対象がtest/build/implementation failureではなく
      **Design Review CONFLICTそのもの**である点で異なる。

      **制約**: Safety Gate迂回禁止。CONFLICTのまま無理にJobを生成しない（Job直接生成による
      Gate迂回は禁止）。Approval bypassは行わない。Design Review結果の書換えは行わない。

      **既存CONFLICT Project（Phase 1c以前のE2E Project、Roadmap/active Tasks 12件・
      initial Implement Job 0件・Design Review CONFLICT・Integration Review CONFLICT）は
      Safety Gateがfail-closedした証拠として保持する方針であり、本項目の実装対象・テスト対象には
      流用しない。**

      **今回の作業範囲（禁止事項）**: 今回はroadmap登録のみ。詳細設計・実装は行わない。
      **Phase 1c（Phase 1c Minimal Production E2E）のscopeへは混ぜない。**

      **完了条件**: CONFLICT理由分析の方式・Roadmap自動修正の許容範囲（Goal/Design
      Philosophy/Approval Policy不変の判定方法）・CEOエスカレーション条件がCEOに採択されていること。
      実装着手はCEO承認後

      **実装完了（2026-09-02、PR #75 `feat/roadmap-conflict-recovery-item7`）**:
      `initializeApprovedProject()`内でRoadmap生成→deterministic constraint validation→
      Whole-Roadmap Design Reviewをbounded loop化（`ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS=3`）。
      deterministic validation失敗またはWhole-Roadmap ReviewのCONFLICT判定の場合のみ、
      その具体的な理由（`roadmapGenerator.ts`新設の`priorAttemptFeedback`オプション経由）を
      次回生成promptへ渡してRoadmapのみを再生成——Project Definition/structured constraints/
      Goal/Design Philosophy/Approval Policyは試行間で一切変更しない。UNCERTAIN・
      REVIEW_UNAVAILABLE（provider unavailable相当）は初回で即fail-closed（再生成attemptを
      消費しない——regenerateしても解決しない性質のため）。新設`executeRoadmapReviewToTerminal()`
      が既存run-level bounded retry（claim/fence/requeue、Phase 1/2既存）を先にdecisiveな結果まで
      drainしてから outer loopが判定するため、runner timeoutやclaim競合をCONFLICTと誤分類して
      Roadmapを無駄に再生成することもない。古いreview evidenceの再利用は、Roadmap内容が変われば
      `reviewMaterial`のhashも変わるという既存freshness機構だけで自然に防止（特別な仕組みを
      追加していない）。Task syncはループがALIGNEDを得た場合のみ1回実行、却下された中間試行では
      Task行を1件も作成しない。Phase 1c再検証で実際に観測した
      scope_simplicity CONFLICT（9ケースのテスト追加を5 Task・2 Phaseに過剰分割）を
      regression caseの実体として利用したが、このケース専用のタスク数ルールにはしていない
      （Whole-Roadmap Reviewの意味的判断に委ねる設計を維持）。`designReviewCoordinator.ts`へ
      roadmap-kind限定の`buildRoadmapRejectedReason()`を追加——決定的なCONFLICT判定は
      従来`rejectedReason`が空のままだったため、これがないと再生成feedbackが
      「reject されました」程度の中身のない文字列にしかならなかった。Task-kind reviewの挙動は
      無変更（既存test suite全通過で確認）。apps/api 64ファイル/964テスト成功。apps/worker・
      Control Repositoryは無変更のためAV-001対象外。production（api.aiteamos.uk）へ
      deploy・health確認済み。
8. [~] **Roadmap Task / Control-Plane Workflow Separation**（2026-09-01登録。Phase 1c Minimal
      Production E2E Projectの実行結果で発覚。調査・roadmap登録のみ行い、Phase 1cのscopeへは
      混ぜない）。

      **進捗（2026-09-01）**: deterministic側の防止・検出は項目9のdeterministic pathと統合実装し
      完了（PR #64 `feat/roadmap-deterministic-constraint-validation`、詳細は項目9の進捗欄参照）。
      本項目の設計で挙げたsemantic側の二重検証（categoryと実際のTask内容の一致確認、
      Whole-Roadmap Design Review経由）はまだ未実装。既存Design Review pipelineへの
      review subject一般化調査（read-only、Codex quota切れのためOpenCode CLIで代替実施）が
      完了し、Control Repository実装（`apps/worker/scripts/designReviewRunner.ts`・
      `apps/worker/src/metaReviewer/strategicReview.ts`）に着手可能な設計案が揃った段階。
      AV-001の正式経路・独立provider reviewを経てから実装する（現時点で未着手）。

      **発覚した事実**: Phase 1c用に生成されたRoadmapは11 Taskで構成されていたが、うち5件
      （「Design Review用ドキュメント準備」「Design Review提出・Approval取得」「Feature Branch作成・
      変更コミット」「Pull Request作成・CI Gate確認」「Commit Gate通過・マージ完了」）は、
      Projectの成果物ではなく**AIteamOS自身が既にTaskの外側で自動的に担当しているcontrol-plane処理**
      （`checkImplementJobDesignReviewEvidence()`によるDesign Review Gate、Approval Gate、
      `git_commit` SafeCommand、shadow Commit Gate等、既存の自動フロー）をなぞる内容だった。

      **原因（コード確認済み）**: `apps/api/src/ctoAi/roadmapGenerator.ts`の`SYSTEM_PROMPT`
      （59-97行）には、タスク粒度（「1タスク=最大2日」）・Phase構成・タスク数（10〜20件）の
      指示はあるが、**「Design Review実行／Approval取得／Branch・commit workflow／PR・CI
      orchestration／Commit Gate実行／Task completion machineryをRoadmap Taskとして生成しない」
      という制約は一切存在しない**。既存Meta Reviewerチェックリスト（`docs/meta_reviewer/checklist.md`・
      `checklists/*.md`）にも同種の検出項目はなく、Design Review Strategic Alignment側にも
      「このTaskはAIteamOS自身のworkflow機構を再実装しようとしていないか」を判定する視点は
      現状組み込まれていない。**部分的に壊れていたのではなく、この種のsemantic invariantが
      最初から存在しない**ことを確認した。

      **リスク**: Roadmap Taskとしてこの種の項目が生成されると、(a) Task本体に実装すべき差分が
      実質存在しない（例:「Commit Gate通過・マージ完了」はコード変更を伴わない）、(b) その
      Taskの`aiCliPrompt`自体がDesign Reviewの対象になるため、Design Review実行を指示する内容が
      さらにDesign Reviewを通る、という概念的な循環が生じ得る、(c) 既存自動フローとの二重化により
      不要なJob生成・混乱した失敗状態を招きうる。

      **目的**: Roadmap Taskは常に「成果物を作るための作業」を表すという制約を、Roadmap生成・
      （可能なら）Design Review側に持たせる。既存のDesign Review Gate・Approval Gate・
      `git_commit`・shadow Commit Gateの自動フローはそのまま維持し、新しい実行機構は追加しない。

      **評価事項（実装ではなく調査）**: `roadmapGenerator.ts`の`SYSTEM_PROMPT`へ制約を追加する案、
      および生成後のバリデーション（タスクtitle/descriptionが既存control-plane処理と重複しないかの
      機械的・LLMベースの検出）で防ぐ案の両方を比較する。Design Review Strategic Alignment
      （`strategicReview.ts`）の既存7 checklist・focus selectionへ新しい観点を追加する場合の
      責務境界（Roadmap生成時点で防ぐか、Design Review時点で検出するかの二段防御）を整理する。

      **今回の作業範囲（禁止事項）**: 今回はroadmap登録のみ。`roadmapGenerator.ts`の`SYSTEM_PROMPT`
      変更・Design Reviewチェックリスト変更・バリデーション実装は行わない。
      **Phase 1c（Phase 1c Minimal Production E2E）のscopeへは混ぜない。**

      **完了条件**: 防止方式（生成時制約／生成後検出／両方）の採択、Design Review側で検出する場合の
      チェックリスト・focus設計方針がCEOに採択されていること。実装着手はCEO承認後
<!-- roadmap:id=roadmap-generation-constraint-compliance state=in_progress -->
9. [~] **Roadmap Generation Constraint Compliance**（2026-09-01登録。Phase 1c 2回目の試行
      `phase 1c v2`（Project ID `4a55dd0f-6b2f-4ad6-8864-f699d586d9b4`）で、1回目とは独立に再現。
      調査・roadmap登録のみ。Phase 1cのscopeへは混ぜない。今回専用の「タスク数が1でなければreject」
      というハードコードはしない）。

      **進捗（2026-09-01）**: 設計方向性3経路のうちdeterministic constraint（タスク数上限・
      許可パスのみ・dependency数上限）とcategoryベースの機械的拒否（項目8）を統合実装し完了
      （PR #64 `feat/roadmap-deterministic-constraint-validation`。`roadmapGenerator.ts`へ
      `category`フィールドと構造化制約優先の指示を追加、`roadmapTaskValidation.ts`へ
      `validateRoadmapConstraints()`を追加し`initializeApprovedProject()`の
      `syncRoadmapTasks()`より前に組み込み済み。`forbidden_new_files`/`forbidden_technologies`は
      意味的判断が必要なため意図的に機械検証せず、`checkedKinds`/`uncheckedKinds`で
      検証範囲を監査可能にしている。DB migrationなし、新Gate/Queue/daemonなし。
      apps/api 926テスト・packages/shared 54テスト成功、独立レビュー2回実施
      〈実装内容の精査で1件の実修正（`allowed_path_prefixes`のpath境界チェック不備）を発見・
      修正済み〉）。

      残り: semantic constraint（禁止技術・architecture変更禁止等）を扱うWhole-Roadmap
      Design Reviewは未実装。既存Design Review pipelineへの一般化可能性調査
      （read-only、Codex quota切れのためOpenCode CLIで代替実施）が完了し、`taskId`は
      DB上FK未強制の不透明な識別子でありclaim/fence/bounded retry/provider separationは
      subject非依存であることを確認済み。ただしCEOの明示的指示により、`task_id`へ
      `roadmap:<projectId>`のようなsynthetic値を入れてTaskを偽装する案はそのままでは
      採用せず、`review_kind`カラムの追加的migration（新テーブルではなく既存の
      idempotent `MIGRATION_STATEMENTS`パターンでの1カラム追加）でreview subjectを
      `task | roadmap`として正しく一般化する方向で調整中。Control Repository実装
      （`apps/worker/scripts/designReviewRunner.ts`・
      `apps/worker/src/metaReviewer/strategicReview.ts`）はAV-001の正式経路・独立provider
      reviewを経てから着手する。

      **進捗（2026-09-02、Phase 2完了）**: review subject一般化のPhase 2
      （`reviewKind`/`subjectId`をcoordinator→storage→runner→reviewer engineまで正式に
      thread）を実装・独立レビュー・merge済み（PR #67
      `feat/design-review-subject-generalization-phase2`）。`reviewKind='roadmap'`専用の
      固定focus選択（`selectRoadmapReviewFocuses()`: strategic_alignment/scope_simplicity/
      architecture_responsibility）と固定critical load分類
      （`ROADMAP_REVIEW_LOAD_CLASSIFICATION`）を新設し、changedFilesベースの既存
      `classifyReviewLoad`/`selectFocuses`とは完全に別経路にした（synthetic changedFilesは
      使わない）。`createAndExecuteRoadmapReview()`をcoordinatorへ追加的entrypointとして新設
      （既存`createAndExecuteDesignReview()`・Task Review呼び出し元は無変更）。Roadmap
      freshnessは項目6のdefinitionHash/constraintsHash/生成Roadmapを`composeRoadmapReview
      Material()`で1つの正本テキストへ合成し、既存`computeDesignTextHash()`をそのまま
      再利用する形で実装（新しいhash方式は追加していない）。apps/api 63ファイル/949テスト・
      apps/worker 1051/1054テスト（残り3件はCRLF/watchdogタイミングに起因する無関係な既存
      environmental failureと確認済み）。独立レビュー（Codex、実装provider=OpenCodeとは別）で
      1件の実修正を発見・修正済み: `runIndependentReview()`が`reviewKind='roadmap'`の
      projectIdを`ReviewerRequest.taskId`（`AiCliRequest.taskId`まで転送される）へ渡していた
      synthetic taskIdの取りこぼしを検出し、`ReviewerRequest`へ`reviewKind`/`subjectId`を
      追加した上でtaskId欄はtask-kind限定・roadmap-kindでは`roadmap-review:<projectId>`という
      明示ラベル付き値（disguiseではない）へ修正、再レビューでAPPROVE_WITH_NOTESを取得。
      `projectInitialization.ts`からの実接続・Task同期順序変更・Roadmap regeneration/CONFLICT
      recoveryはPhase 3として引き続き未着手（意図的にスコープ外）。

      **発覚した事実**: `phase 1c v2`のGoalは今回truncateされておらず（`goalLength: 292`、
      項目6のTruncation Preventionとは無関係な独立事象）、Goal本文に「Roadmap Taskはこの1件のみ」と
      明記されていたにもかかわらず、生成されたRoadmapは4 Taskだった。項目8で見つかった
      control-plane処理の重複は今回発生しなかった（改善は確認できた）が、**明示的なRoadmap
      cardinality制約自体は守られず、Design Reviewもこれを検出せずJob生成まで進んだ**。

      **原因（コード確認済み）**:
      - `apps/api/src/ctoAi/roadmapGenerator.ts`の`SYSTEM_PROMPT`（68行）が
        「タスク数は合計10〜20件程度（MVPスコープに絞る）」を**全Project共通のハードコードされた
        ガイドライン**として与えている。これがProject固有の構造的制約（Goal自由文中の指示）と
        競合し、LLMは両方を部分的にしか汲み取れない（今回は10〜20件よりは大幅に少ない4件まで
        譲歩したが、指定された1件には届かなかった）。
      - `initializeApprovedProject()`（`apps/api/src/ctoAi/projectInitialization.ts`）は
        `validateRoadmapTasks`/`validateRoadmapPhases`（`apps/api/src/storage/
        roadmapTaskValidation.ts`）で生成後のRoadmapを検証しているが、確認した内容は
        **重複キー・存在しない依存先・循環依存・不明phaseというグラフ構造の妥当性のみ**であり、
        **Projectが宣言した意味的・構造的制約（タスク数上限・許可パスのみ・新規ファイル禁止・
        dependency数上限・特定技術禁止等）との適合性を検証する機構は存在しない**。
      - Design Review側は`docs/project_memory/goal.md`経由でProjectの完全なGoalテキストに
        アクセスできる（`buildApprovedProjectAnalysis()`が`project.goal`をそのまま
        `SpecAnalysis.goal`へ渡し、`writeProjectMemory()`がRoadmap生成・Task同期の直後に
        goal.mdへ書き出す。今回のケースでは全文が正しく反映されていたことをコードで確認済み）。
        **しかしDesign Reviewは常に1 Task単位でのみ呼ばれ**（`createInitialImplementWorkflow()`の
        `designText: task.description`）、**Roadmap全体の形（Task一覧・総数）を一度も見る機会が
        ない**。今回の4 Taskはいずれも単体で見ればGoalの精神と矛盾しないため、CONFLICTと
        判定されなかったのは個々のTask単位では自然な結果であり、「部分的に壊れていた」のではなく
        **Roadmap全体の構造的制約を検証する視点そのものが存在しない**。
      - Meta Reviewerチェックリスト（`docs/meta_reviewer/checklist.md`・`checklists/*.md`）にも、
        Project宣言済み制約を体系的に1件ずつ検証する仕組みはない。Strategic Alignment Reviewは
        自由記述のALIGNED/CONFLICT/UNCERTAIN判定であり、制約ごとのchecklist形式ではない。

      **目的（今回専用のハードコードにしない一般化）**: Project Definitionから機械判定可能な
      制約を構造化して抽出し、Roadmap生成後に機械的に検証し、Design Review側でもRoadmap全体を
      対象とした独立確認を行う、という一般機構を設計する。対象例: タスク数上限／read-only限定／
      特定ファイルのみ変更／新規ファイル禁止／dependency数上限／特定技術禁止／architecture変更禁止等、
      Project Definitionに書かれうる任意の構造的・機械判定可能な制約。

      **設計方向性（2026-09-01 CEOフィードバック反映。調査・設計のみ、実装は行わない）**:
      1. **構造化制約の取得はAI主導、CEO手入力UXにしない**: CEOが多数の技術フィールド
         （maxTaskCount等）を手入力するUXは採用しない。**通常は自然言語のProject Definitionから
         AIが構造化制約を抽出する**。機械的に確定できるもの（例: 「1件のみ」→
         `maxTaskCount=1`、「docs/配下のみ」→`allowedPathPrefixes=["docs/"]`）は
         **自動確定**し、CEOに聞かない。**曖昧な場合、またはGoal/Design Philosophyの根幹に
         関わる重要項目の場合だけ**、既存`interactive-project-definition-readiness`項目の
         Gap Analysis経由でCEOへ質問する（新しい質問経路を追加しない。既存Gap
         ⇒CEO回答／Skip／AI仮決定の枠組みをそのまま使う）。
      2. **責務分離（3経路、混在させない）**:
         - **deterministic constraint**（タスク数上限・許可パスのみ・新規ファイル禁止・
           dependency数上限等、機械的に数えられるもの）→ 既存`validateRoadmapTasks`/
           `validateRoadmapPhases`と同じ「生成後・DB同期前にfail-closedで拒否する」
           validatorパターン（`validationIssues.length > 0` → 422）を拡張して強制する。
           新しいGate/Queueは作らない。
         - **semantic constraint**（特定技術禁止・architecture変更禁止等、意味的判断を要する
           もの）→ **Roadmap全体を対象とした既存Design Reviewによる独立確認**で扱う。
           既存`runIntegrationReview()`のパターン（複数の個別結果を統合してALIGNED/
           CONFLICT/UNCERTAINを出す既存の仕組み）を参考に、新しいReview Agent種類は
           追加しない。
         - **個別Task Design Review**（現行の`createInitialImplementWorkflow()`が
           `task.description`単位で呼ぶもの）→ **従来通り、別途維持する**。Roadmap全体の
           確認に置き換えない・混在させない。
      3. **実行順序: Roadmap全体の確認をTask同期・初回Implement Job生成より前に置く**。
         現状`initializeApprovedProject()`は「生成→(グラフ構造)検証→Task同期→Project
         Memory書き込み→Roadmap書き込み→Task毎のinitial implement workflow（Design Review
         込み）」の順で進む。deterministic validatorとsemantic Design Reviewのいずれも、
         **Task同期（`syncRoadmapTasks()`）より前**で完結させ、不正Roadmapからは
         そもそもTask/Jobが1件も生成されない構造を優先する（今回のように、後から気づいて
         Projectごと保持・破棄するのではなく、生成された時点でfail-closedにする）。
      4. **Evidence freshness（2026-09-01 CEOフィードバック追加。新Gateにしない）**:
         authoritative Project Definition・Structured Constraints・Roadmap・
         Whole-Roadmap Review evidenceをversion/hashで結ぶ。Design Review後にProject
         DefinitionまたはRoadmapが変わった場合、古いReview evidenceは再利用できないように
         する。これは新しいGateではなく、既存の`checkImplementJobDesignReviewEvidence()`
         （`design_text_hash`が現在の`aiCliPrompt`と一致しない限りevidenceを再利用させない、
         既存Design Review Gateの核心ロジック）と同じ**freshness/hash一致の考え方を
         Roadmapレベルへ拡張したもの**として位置づける。新しいevidence保存機構は増やさない。
      5. **Control-plane Separation（項目8）の二重検証化（2026-09-01 CEOフィードバック追加）**:
         項目8をWhole-Roadmap Review（semantic）だけに依存させない。Task purpose/category
         （例:「実装」「検証」「control-plane操作」等）を構造化・機械判定可能な形でRoadmap
         生成時に付与し、**deterministic validator側でも**「Design Review実行・Approval
         取得・Branch/commit・PR/CI・Commit Gate実行に該当するcategoryのTaskを拒否」を
         機械的に強制する（4と同じ既存validatorパターンの拡張）。semantic Design Review側は
         **categoryと実際のTask内容（description等）が一致しているか**を独立確認する
         （category詐称・categoryはdeterministic validatorを通ったが実態が異なる、を検出する
         役割）。1つの判定に両方が依存しない二重検証にする。

      **既存項目との関係（重複実装にしないこと）**: `roadmap-task-control-plane-separation`
      （項目8）は、本項目が一般化する制約体系の**具体例の1つ**（「Design Review/Approval/PR/CI/
      Commit GateをTaskとして生成しない」という暗黙の制約）として位置づけ直せる。本項目の一般機構が
      実装されれば項目8はその下のデフォルト制約の1つとして扱える可能性があるが、責務は本項目
      （一般機構）と項目8（具体的な検出内容）で分離したまま残す。

      **証拠**: `phase 1c v2`（Project ID `4a55dd0f-6b2f-4ad6-8864-f699d586d9b4`）は2件目の
      regression evidenceとして保持し、resumeしない（4 Taskのまま後続Task/Jobへ進めない）。

      **Phase 1c再開方針**: v3 Projectは今は作成しない。本項目・項目8等の前提条件（prerequisite
      defects）の修正後、禁止事項を細かくprompt/Goalへ書き並べない自然なProject Definitionで
      Phase 1cを再開する（今回のように「Design Review/Approval/PR/CI/Commit Gateをタスク化
      しない」「Roadmap Taskはこの1件のみ」等を毎回Goal本文へ明記する運用を前提にしない）。

      **今回の作業範囲（禁止事項）**: 今回はroadmap登録・調査のみ。`roadmapGenerator.ts`の
      `SYSTEM_PROMPT`変更・`roadmapTaskValidation.ts`への新規バリデータ実装・Design Reviewへの
      新しい呼び出しポイント追加は行わない。**Phase 1c（Phase 1c Minimal Production E2E）の
      scopeへは混ぜない。**「タスク数が1でなければreject」という今回専用のハードコードは行わない。

      **完了条件**: AI主導の構造化制約抽出（自動確定 vs Gap Analysis経由でCEOへ質問する境界線）、
      deterministic/semantic/個別Task Design Reviewの3経路分離、Task同期より前にRoadmap全体を
      確認する実行順序、の設計がCEOに採択されていること。実装着手はCEO承認後

      **進捗（2026-09-02、Phase 3完了）**: 設計採択済みの3経路分離のうち、deterministic
      constraint（Phase 1c v2完了時点で既済）に続き、semantic constraint用のWhole-Roadmap
      Design Reviewを実際の`initializeApprovedProject()`へpre-sync接続した（PR #70
      `feat/roadmap-review-presync-connection`）。実行順序はRoadmap生成→deterministic
      validation→Whole-Roadmap Design Review→ALIGNEDの場合のみ`syncRoadmapTasks()`→個別Task
      Design Review→Implement、を厳密に強制。CONFLICT/UNCERTAIN/provider failure/stale・
      不一致evidenceは既存`ProjectInitializationError`（422）経路でfail-closed、Task行は
      1件も永続化されないことをtestで証明（イベントログでreview実行時点のTask数=0・評価保存後に
      初めてTask数が増えることを確認）。Project Memory書き込みを`syncRoadmapTasks()`より前へ
      移動（`options.writeProjectMemory`が真の場合のみ、既存の任意フラグは変更なし。
      strategic_alignment focusがgoal.md/design_philosophy.mdを読める前提を満たすため）。
      retry時はcheck→execute→re-checkパターン（`initialImplementWorkflow.ts`の既存Task-kind
      gateと同型）でfresh ALIGNED evidenceを再利用し二重review・二重syncを防止。新Gate/Queue/
      daemon/evidence store/hash方式は追加していない。apps/api 64ファイル/954テスト成功、
      apps/worker・Control Repositoryは無変更のためAV-001対象外。

      **Phase 1c再検証 完了（2026-09-02）**: production（api.aiteamos.uk、VPS
      `aiteamos-vps`/`ai-team-e2e`）を最新masterへ安全同期（read-only preflight→canonical DB
      copyへのPR #66 migration事前検証→fresh backup→旧新process同時実行なしの
      stop→pull→migrate→verify→start順序→provider canary、の全手順で実施。row count・
      integrity_check・foreign_key_check・idempotencyすべてPASS、production HEADは
      意図したmaster HEADと一致）。canary・Whole-Roadmap Review双方でGemini
      APIが正常応答することを確認済み。

      同期後、通常Mobileフロー（`POST /api/projects`→`PATCH /api/projects/:id
      {status:'running'}`。`POST /api/cto/generate-roadmap`等のlower-level経路は不使用）で、
      「1 Task」「control-plane Task禁止」等の正解を一切書かないGoal（`computeTaskDisplayStatus
      のテスト不足を、小規模で低リスクな変更として改善してください。既存ArchitectureやPolicyは
      変更しないでください。`）でPhase 1c再検証を実施。

      **実行中に発見・修正した実バグ**: Gap回答を含む再解析でClaude Haikuが
      `structuredConstraints[0].value=null`を出力し、`specAnalyzer.ts`の厳格な単一
      `SpecAnalysisSchema.safeParse()`がこれを未処理の500として落としていた
      （PR #72 `fix/spec-analyzer-null-structured-constraint-crash`。malformed AI
      response＋error handling不足として分類、structuredConstraints単位のdefensive
      filteringのみで修正、retry機構等は追加せず、production再同期・再検証済み）。

      **確認できたこと（成功条件どおり）**: Gap Analysis/Readinessを複数ラウンド経由（都度
      readinessScoreとgapsが非決定的に変化＝実際のLLM非決定性を確認）→readinessScore=92で
      Roadmap生成へ進行→deterministic constraint validation通過→Whole-Roadmap Design
      Reviewが実プロバイダー経路（Gemini focused review×3・integration review・critical-load
      independent review=Codex）で実行→`scope_simplicity`focusが「9ケースのテスト追加を
      5 Task・2 Phaseに過剰分割」という実在するスコープ違反を正しく検出→integration
      reviewがCONFLICTと判定→independent review（Codex）はレスポンスparse失敗で
      unavailable→最終決定REVIEW_UNAVAILABLE→`syncRoadmapTasks()`到達前に
      `ProjectInitializationError(422)`でfail-closed→**Task行は1件も作成されず**（DB直接
      確認済み）。1回目の試行では同一runがrunner 120秒timeoutでrequeueされ（bounded retry、
      attempt_count 1→2）、2回目の再実行で完了した点も含め、既存claim/fence/bounded retry
      機構が実際に機能することを確認できた。

      **意図的に行わなかったこと**: 検出されたCONFLICT（過剰分割）は修正・迂回せず、対象
      Projectはpausedのまま保持（旧`Phase 1c Minimal Production E2E`と同じ扱い）。Roadmap
      generation自体の改善・Task分割数の調整は今回の検証範囲外。

      Roadmap regeneration・Design Review CONFLICT Recoveryは項目7として引き続き別管理・
      未着手。
<!-- roadmap:id=project-pause-continuation-gap state=done -->
10. [x] **Project Pause / Continuation-Control Gap — 完了**（2026-09-01登録・同日実装完了。
      `phase 1c v2`のregression evidence保持作業中に発見。Phase 1cへは混ぜていない）。

      **発覚した事実**: Projectを`paused`にしても、Task→Task自動継続（`ensureTaskContinuation()`
      が呼ぶ`createInitialImplementWorkflow()`）は止まらない。同関数
      （`apps/api/src/ctoAi/initialImplementWorkflow.ts:31-34`）が拒否するのは
      `!project || project.status === 'archived'`の場合のみで、`paused`と`running`を
      区別していない。つまりTaskがimplement→review→approve→`git_commit`まで完走しTask
      `done`になると、**Projectがpause中でも次Taskの初回Jobが自動生成される**。
      現行の唯一の停止手段は`archived`だが、archive操作は既存Guardにより「Job running中は
      不可」（`apps/api/src/routes/projects.ts`の`ArchiveBlockedByRunningJobError`）のため、
      稼働中のJobがある間はarchiveもできない。

      **一般原則**: 新しいTask/Jobへの自動継続は`project.status === 'running'`の場合のみ
      許可する。`paused`を実質的な「即時停止」の代用にしなくても済む設計（＝`paused`状態自体が
      新規継続Jobの生成を正しく止める）を優先して検討する。`archived`を停止のためだけに
      使う運用（元に戻せない操作を一時停止の代わりに使う）は避けるべき設計上の課題として扱う。

      **既存項目との関係**: `roadmap-generation-constraint-compliance`（項目9）とは別の欠陥
      （項目9はRoadmap生成・検証時点の話、本項目はTask完了後の自動継続時点の話）。
      `project-auto-task-job-chain`（本ファイル該当箇所、state=done）が実装した既存の
      継続機構自体の見直しであり、新しい継続機構を追加するものではない。

      **証拠**: `phase 1c v2`（Project ID `4a55dd0f-6b2f-4ad6-8864-f699d586d9b4`）は
      regression evidenceとして永久保存する。task-001の初回Jobが終端状態に達した後、
      稼働中Jobが無い状態を確認できた時点で既存の正式なarchive APIのみを用いてarchiveする
      （Project/Task/Job/Review履歴の削除・書換えは行わない）。archive前に後続Taskへの
      自動継続が発生した場合は、迂回・強制変更をせず、その事実を本項目の追加evidenceとして
      記録する。

      **実装内容（完了、PR #54 `fix/project-pause-blocks-task-continuation`、コミット
      `f53b2ff`）**: `createInitialImplementWorkflow()`（初回Task Job生成・自動継続の両方が
      通る唯一のchokepoint）の判定を、`project.status === 'archived'`のみ拒否 →
      `project.status !== 'running'`なら拒否、へ変更（`apps/api/src/ctoAi/
      initialImplementWorkflow.ts`）。ただし`paused`は`archived`と区別し、
      `{ status: 'skipped', reason: 'project is not running', retryable: true }`を返す。
      `ensureTaskContinuation()`は`retryable`な skip の場合、`task_continuation`を
      `failed`にせず`pending`のまま残す（既存ロジック、変更なし）。**新しいGate/Queue/daemonは
      追加していない**: `pending`のまま残った継続は、既存のWorker Outbox再送機構
      （`routes/jobs.ts`の`git_commit`成功処理が、継続`pending`中は常にHTTP 503を返し
      Workerの Outbox が同一イベントを再送する既存の仕組み）がそのまま「Project再開後に
      自動的にretryする」役割を果たす。`archived`は従来どおり非retryableな終了状態のまま
      （既存の"keeps the archived Project boundary"テストは無変更で成功）。

      **テスト**: `initialImplementWorkflow.test.ts`に「Projectがpaused中はJobを作らず
      retryableなskipを返す」「pausedから復帰後は正常にJobを作る」の2件を追加（8/8成功）。
      `apps/api`全体: 59ファイル/877テスト成功、`tsc --noEmit`成功。CI（Typecheck & Test・
      Meta Reviewer AI）green、通常のreview/PR経路でmaster反映済み。

      **今回の作業範囲**: `initialImplementWorkflow.ts`のみ変更。`ensureTaskContinuation()`・
      `routes/jobs.ts`のOutbox/git_commit成功処理は無変更（既存の再送挙動をそのまま利用）。
      **Phase 1c（Phase 1c Minimal Production E2E）のscopeへは混ぜていない。**

      **完了条件（達成）**: `paused`が新規継続Jobの生成を正しく止め、`archived`は従来どおり
      終了状態のまま維持されていることをテストで確認済み。新しいGate/Queue/daemonなし。

      **追記（2026-09-01、CEO指示によるOutbox retry-limit/dead-letter確認で発覚・修正済み、
      PR #56 `fix/paused-continuation-outbox-starvation`、コミット`c833c44`）**: データ消失は
      なかった（`apps/worker/src/outbox/outboxStore.ts`にretry上限・dead-letterはなく無期限保持）。
      しかしより深刻な可用性の問題を発見した — `apps/worker/src/index.ts`の`pollJobs()`は
      `outboxStore.hasPending()`が真の間、**全Project分のqueued Job取得を毎poll cycleスキップ**し、
      3周期連続でCRITICALアラートを発報する。本項目の実装（pause中は`retryable: true`）は、
      `routes/jobs.ts`の既存503応答（「Non-2xx keeps the Worker Outbox event durable」という
      設計）と組み合わさると、**1つのProjectをpauseしている間、単一production Workerが他の
      全Projectのjob取得を止めてしまう**という副作用を持っていた（元々この503設計は秒〜分単位の
      一時的技術障害向けで、CEOが任意の長さpauseできる状態を想定していなかった）。
      **修正**: `routes/jobs.ts`はcontinuation対象Projectが`paused`の場合だけWorkerへ即座に
      2xxを返す（`ensureTaskContinuation()`は呼ばず`task_continuations`は`pending`のまま）。
      `routes/projects.ts`のPATCH running遷移時に`taskContinuations.findPendingByProjectId()`
      （新規クエリ）でpending中の継続を見つけ、既存の`ensureTaskContinuation()`で再試行する。
      `archived`は既存通り503→数poll cycleで自己解決する挙動のまま無変更。
      新しいGate/Queue/daemonなし、`apps/worker/src/index.ts`（CONTROL REPOSITORY保護対象）も
      無変更。テスト2件追加、`apps/api`全体59ファイル/879テスト成功。

      **再追記（2026-09-01、CEOレビューで発覚・修正済み、PR #58
      `fix/continuation-retry-durable-not-single-attempt`、コミット`d48ef3a`）**: 上記PR #56の
      修正は、running遷移時に`ensureTaskContinuation()`を**1回だけ**試行する設計だった。
      その1回が失敗・未完了（例: 依存Task未完了）で終わると、`routes/jobs.ts`のack-without-503化
      によりWorker Outbox側の再送機会も既に失われているため、**再試行する契機が二度と来ない
      （永久pending）**リスクがあった。**修正**: `taskContinuation.ts`に共有関数
      `retryPendingContinuationsForProject()`を切り出し、`PATCH /api/projects/:id`のresume時
      だけでなく、`GET /api/projects/:id`・`GET /api/projects`（いずれもMobileの`usePolling`が
      既に継続的にpollしている既存endpoint）からも呼ぶよう変更。Workerの`pollJobs()`が自分の
      poll cycleにOutbox再送を相乗りさせているのと同じパターンをMobile側の既存poll cycleへ
      適用しただけで、新しいQueue/daemon/pollingは追加していない。テストで
      (a) 依存Task未完了でresume単体では完了できないこと、その後**2回目の手動resumeなしに**
      次のGET pollだけで自動回収されること、(b) resume時sweepとpoll時sweepが同時に競合しても
      既存の`workflow_step_key`一意制約により重複Jobが生成されないこと、を確認済み。

**目的:** CEOがスマホだけで「開発指示を出す→Project/Task/Jobを確認する→進捗を見る→危険操作は承認で
止まる→承認/却下する→結果・失敗理由を見る→必要なら再指示する」という一連のサイクルを完結できる状態にする。
スマホ操作MVPの定義・現状・不足機能の詳細な整理は `docs/PROJECT_CURRENT_STATE.md`「スマホ操作MVPの現在地」を参照。

**MVP必須（このセクションの5項目）:**

<!-- roadmap:id=codex-last-message-temp-file-in-target-repo state=planned -->
0. [ ] **Codex `--output-last-message`一時ファイルが対象リポジトリ内に作られる**（2026-09-07登録。
   PR B（Codex Roadmap Generator基盤）の独立レビューで発覚。**本PRが持ち込んだ挙動ではなく
   既存adapterの共通挙動**で、現在のCodex independent reviewも同じことをしている）。

   **事実**: `expectJson: true`のとき`apps/worker/src/aiCli/adapter.ts`が
   `.codex-last-message-*.json`を`request.workingDir`（＝`/workspace/target`）直下に作り、
   `codexAdapter`が`--output-last-message`で渡す。実行後に削除されるが、プロセスが途中で
   落ちると対象リポジトリにuntrackedファイルが残る。

   **なぜ問題か**: レビュー・生成という読み取り専用のはずの工程が、対象リポジトリの
   working treeを一時的に変化させる。File Change Guardや「working tree不変」を前提にした
   検証と相性が悪く、crash時に残骸が次のJobの変更検出へ混入しうる。

   **PR C（Roadmap topology cutover）までに解消すること**（CEO判断、2026-09-07）。
   正常終了時は削除されるが、process crash / SIGKILL では対象repoに一時ファイルが残りうるため、
   「read-only generator」としては未完成である。PR Bの時点ではproductionから新Generatorへの
   到達が0件なので既存wartとして残してよいが、cutoverでCodexが実際にRoadmapを生成し始める
   前に解決する。

   **実測済み（2026-09-07 20:07 JST、CEO承認canary）**: 実Codex CLI 0.147.0で
   `--output-last-message`をOS temp directory（`/tmp/codex-lastmsg-*/lastmsg.json`）へ向け、
   `--sandbox read-only`＋`-c use_legacy_landlock=true`下で実行したところ**正常に書き込めた**
   （652 bytes）。同じ実行で対象リポジトリのHEAD / tracked diff / untracked files / 全ファイルの
   sha256はすべて不変で、repo内に一時ファイルは残らなかった。
   **したがってrepo外tempへ移す最小修正は実行可能**であり、PR C cutover前に入れる。

   **ただし保証範囲に注意**: この一時ファイルを書くのは**Codex CLIプロセス自身**であって、
   sandboxされているのはmodelが生成したshell commandの方である。よって上記の実測が示すのは
   「移設が機能する」ことであって「sandboxがrepo外書き込みを許可した」ことではない。

   **未解決の間の表現**: 「モデルによるrepo変更は禁止される」とは言ってよいが、
   **「filesystem上完全read-only」とは主張しない**。

<!-- roadmap:id=task-codex-review-cannot-read-repo state=planned priority=high -->
0. [ ] **既存Task系Codex independent reviewがrepoを読めていない（degradation）**（2026-09-07登録、
   **高優先度**。CEO判断: Roadmap topology cutover（PR C）とは別責務なので**PR Cへ混ぜない**）。

   **事実**: task-kindのCodex independent reviewは、`buildReviewPrompt()`
   （`apps/worker/src/approvalLevel/reviewerAdapter.ts:151`）が
   `git diff`本文（post）または変更計画本文（pre）を**promptへ埋め込んで**渡している。
   一方でCodexは`--sandbox read-only`下でshell commandを1つも実行できない
   （roadmap: codex-sandbox-off-deprecated-landlock）。
   つまりレビュアーは**渡されたdiffしか見ておらず、その周辺のコードを読んでいない**。

   **影響**: レビューは機能しているが**degraded**である。
   「この変更は既存の呼び出し元と整合しているか」「他に同じパターンの箇所は無いか」
   「この関数の実際の契約はどうなっているか」といった、diff外の事実に依存する指摘は
   原理的に出せない。**壊れてはいないが、想定より弱い。**

   **運用上の注意**: 「Codex independent reviewがPASSした」ことを
   「Codexがrepoを読んで確認した」証拠として扱わないこと。
   過去のCodex APPROVEも同じ前提で読み直す必要がある。

   **修正候補**: call-localな`-c use_legacy_landlock=true`をtask-kind reviewer経路にも適用すれば
   repoを読めるようになる（Roadmap経路では実測済み）。ただし
   **これはdeprecatedな暫定手段**であり、恒久解決は
   `codex-sandbox-off-deprecated-landlock`側で行う。適用範囲を広げる変更は
   既存production reviewerの挙動を変えるため、独立した変更として扱いCEO承認を得ること。

<!-- roadmap:id=roadmap-evidence-before-task-sync-crash-window state=planned -->
0. [ ] **evidence登録後〜Task sync前のcrashでRoadmapが再生成されうる**（2026-09-08登録。
   PR Cのprovider-separated reviewで指摘。**PR Cのblockingにはしない**（CEO判断））。

   **事実**: Roadmap design review evidenceは`designReviewCoordinator.ts`で登録され、
   Task行は後から`projectInitialization.ts`のTask syncで作られる。
   `hasActiveRoadmap()`（`projectStartWorkflow.ts:63`）は**active Task行だけ**を見るため、
   この間にcrashするとrecoveryは「Roadmapがまだ無い」と判断し`kickProjectStart()`で
   頭から作り直す。

   **Step 1 durability契約を破ってはいない**: 契約は「persisted authoritative Roadmapを
   再生成しない」であり、authoritativeの定義はこれまでもTask行の存在だった。
   evidenceだけがある状態はauthoritativeとして扱われてこなかった。
   ただし**契約の適用範囲が言葉の印象より狭い**ことは記録しておく価値がある。

   **PR Cで変わったのはコストと結果の重さ**: 破棄されるのは
   Codex `gpt-5.6-sol`/xhighが生成し、Gemini focused ×3 と Claude Opus integrationが
   ALIGNEDと判定したRoadmapである。再生成はLLMなので同じ内容にならない。
   E2E中にこれが起きた場合、原因不明の再生成に見えるので誤診しないこと。

   **やること**: authoritativeの判定をTask行の存在だけに依存させず、
   「acceptedなevidenceがある」段階もrecoveryが認識できるようにする。
   新しいstatus体系を作らず、既存のevidence行とstart_stageで表現できるかをまず検討する。
<!-- roadmap:id=review-substage-progress-reporting state=planned -->
0. [ ] **Whole-Roadmap Reviewのsub-stageをAPIへ報告する**（2026-09-08登録。PR Cのscope判断から派生）。

   **現状**: APIから見るとWhole-Roadmap Reviewは`executeRoadmapReviewToTerminal()`の
   **1回のatomicな呼び出し**である。focused review（Gemini ×3）が終わって
   integration review（Claude Opus）が始まる境界はrunner/Worker内部で起きるため、
   API側からは観測できない。

   **したがってPR Cでは`integration_review`を発火させていない。** 観測できない境界で
   stageを更新すると、表示される進捗が実際の処理と対応しなくなる。これは
   `feasibility_review`を偽って発火させないのと同じ理由である（CEO判断、2026-09-08）。

   **現在実際に発火するstage**:
   `roadmap_generation` → `deterministic_validation` → `focused_review`
   →（必要なら`roadmap_regeneration`）→ `task_sync` → `completed` / `blocked`

   **やること**: runner/Workerが実行中のsub-stageをAPIへ報告できる経路を用意し、
   `integration_review`を**実際にClaude統合が始まる直前**に更新できるようにする。
   provider失敗時に「どの段で止まったか」が分かるようになるのが主目的。

   **やらないこと**: 新しいQueue/Daemon/進捗専用DBを作らない。
   既存の`design_review_runs`行やrunnerのstdout契約の拡張で足りるかをまず検討すること。
<!-- roadmap:id=pl-review-process-supervision state=planned priority=high -->
0. [ ] **workflow progressionをblockするbackground taskを、進捗・完了監視なしで走らせない**
   （2026-09-08登録、**高優先度**。CEO判断: 運用上の欠陥として扱う。
   当初はPL delegation限定で登録したが、**個別task列挙ではなく性質による定義**へ改めた。
   scopeの正本は下記「対象の定義」であり、実障害ケース1〜3はscopeそのものではなく
   **contractを検証する実例**である）。

   ### 実障害ケース1: PR #108のCodex independent reviewが0 byteのまま放置された（2026-09-08）

   **発生事象**: PR #108のCodex independent reviewを、PL作業として
   `ssh <host> "codex exec ..."` の単純background processで起動した。
   Bash toolのtimeoutでssh sessionがbackgroundへ回された時点で子processごと死亡し、
   出力は0 byteのまま残った。**誰も異常を検知せず、CEOの進捗確認で初めて発覚した。**
   「出力が返るまで放置」する運用そのものが原因である。

   **read-only調査の結果、必要な不変条件はすでにproduction側に存在する**
   （新しいqueue/daemonを作る必要は無く、再利用が正しい）:

   - 実行状態の追跡 … `design_review_runs`（status / started_at / attempt_count / claim_token）
   - session非依存 … `executeRunner()`はAPI processがspawnし、client接続に紐づかない
   - process消失の自動検知 … `executeRunner()`はchildのclose/exitでsettleし、
     timeout時はSIGTERM→SIGKILLへ昇格する（`designReviewCoordinator.ts:308-366`）
   - verdict無しの終了を成功扱いしない … 非0 exit / parse失敗は`REVIEW_UNAVAILABLE`へ倒れ、
     ALIGNEDにはならない（fail-closed）
   - bounded retry … `DESIGN_REVIEW_MAX_ATTEMPTS = 3` + requeue
   - 二重採用の防止 … `claim_token` によるstale completion fencing
   - API crash後の回収 … `recoverStaleRunningAtStartup()`
   - 失敗分類 … `geminiRouter.ts:152/155` のretryable / config-error 正規表現

   **不足している点**:

   1. **quota/usage limitのsignatureが分類器に無い**。`geminiRouter.ts:152`は
      408/500/502/503/504とnetwork系のみで、429や`usage limit` / `try again at` を
      拾わない。今回実際に踏んだ失敗モードが未分類のまま落ちる。
   2. **PL作業（ad-hoc provider review）がこの機構の外にある**。run行も無く、retryも無く、
      verdict有無の検査も無い。今回の欠陥はここに集中している。

   **方針**: 新しいqueue/daemonを作らない。PL側review用に、
   `setsid`によるsession非依存起動 + 実行状態ファイル（pid/開始/終了/exit code）+
   **明示的な`VERDICT:`行が無ければ完了扱いしない**検査 + 上記分類器の再利用
   （quota signatureを追加）+ bounded retry、を薄いwrapperとして用意する。
   ~~将来的にはPL reviewにも`design_review_runs`の行を持たせ、claim_token fencingを
   そのまま継承させるのが筋。~~ **撤回（2026-09-08、実障害ケース2を受けたCEO判断）**:
   Gate / evidence用テーブルへreview以外のrunを混ぜない。受け皿は下記C-10の
   汎用`supervised_runs`とし、claim_token fencingは**設計だけを踏襲する**。

   **暫定運用ルール（即時適用）**: 数分以上かかるAI review/implementation/analysisを
   単純なbackground processへ投げて放置しない。最低でも
   **session非依存実行 + 明示的なliveness確認**をセットにする。

   ---

   ### 実障害ケース2: Expo restart background taskが約25分RUNNINGのままになった（2026-09-08）

   **Observed（確認済みの事実のみ）**: Phase 3 Mobile確認中、`Restart Expo on manage master`
   というbackground taskが約25分間RUNNING表示のままだった。Expo / Metro restartは通常
   数秒〜数分でMetro process起動 → port listen → ready state → exp:// URL / QR生成まで到達する処理であり、
   約25分RUNNING表示のままだったため、正常な長時間処理とは考えにくい状態だった。

   **Corrected diagnosis（2026-09-08 追加調査で確定。当初のstalled疑いは誤りだった）**:
   **Metro自体はハングしていなかった。** 実測値:

   - Metroは 8081 を listen していた
   - bundle requestを行うと 953 modules を正常compile
   - manifest endpoint: HTTP 200
   - Expo Go bundle endpoint: HTTP 200 / bundle size 7,122,031 bytes / response 約1.2秒
   - restart後のready判定は約9秒

   **ログが止まって見えた理由**: Metroはclient activityが無いidle状態ではログを出さない。
   したがって **`lastLogAtが古い = stalled` という判定は誤りになり得る**。

   **QRが出なかった理由**: ExpoはTTYへ接続されたconsoleでのみQRをrenderする。background taskでは
   stdoutをfileへpipeしていたため、**QRがconsoleへ出ること自体が不可能だった**。
   つまり「QRがログへ出るまで待つ」というcompletion predicateはbackground executionで成立しなかった。
   今回は exp:// URL を既知のhost/portから生成し、QRを別途生成することで解決した。

   **Confirmed root cause**: Expo / Metro itself was healthy. The background task lacked a
   completion predicate valid for a non-TTY execution environment and waited on an
   interactive-only QR / log signal.

   **障害の分類（C-11参照）**: これは **workload failureではなく completion-detection failure** である。
   当初この項目に記録した「Expoがハングした疑い」は撤回する。

   **Finding（本項目で扱う確定事項）**:
   *Background task can remain RUNNING indefinitely without progress/completion monitoring* —
   workflow progressionをblockするbackground taskが、実進捗またはcompletionを監視されないまま
   無期限RUNNINGになれる。ケース1（PR #108のCodex review 0 byte放置）と同じ欠陥が、
   **AI delegation以外のbackground taskにも存在する**ことを示す2例目である。
   したがって本項目の対象は「PL delegation」という特定の作業種別ではない。
   **対象は性質で定義する**（下記「対象の定義」）。本ケースはその定義を満たす一例にすぎない。

   **Generalized defect（追加調査後の最終形）**: *Background task supervision must validate actual
   task outcome through environment-independent completion predicates rather than equating
   process / log activity with progress.*
   ケース1は「completion signalが無い」ことによる無期限RUNNING、ケース2は
   「completion signalはあったが実行環境で成立しない形をしていた」ことによる無期限RUNNINGであり、
   **同じcontract欠落の異なる現れ方**である。

   **Risk scenario（Observedではない。今回未確認）**: Mobile中心の自律運転では、
   CEOがProjectを開始 → AIがbackgroundで長時間処理 → CEOがアプリを閉じる →
   background taskが実質停止 → statusだけRUNNING → PL/Workerも完了を待ち続ける →
   誰も異常を認識せず、Projectが永久に再開しない、という状態が起こり得る。
   **「Mobileを閉じたら実際にtaskが停止した」事実は今回確認されていない。**
   このchainは検証対象のrisk scenarioとして記録するにとどめ、確定した障害として扱わない。

   **仕様上の原則**: **「processが存在すること」と「taskが正常に進行していること」を同一視しない
   （PID alive != healthy）。**

   ---

   ---

   ### 実障害ケース3: PR #123のCI待ちでPL control loopがresumeしなかった（2026-09-08）

   **発生事象**: PLがPR #123を作成し、CEOへ「CI監視中。確定次第報告する」と宣言した。
   GitHub Actionsは短時間でgreenになったが、**PLは自律的に再開せず待機したままだった**。
   CEOの指摘で初めて発覚した。

   **実測タイムライン（すべてUTC。read-only確認済み）**:

   | 時刻 | 事象 |
   |---|---|
   | 05:49:40 | PR #123 作成 |
   | 05:49:43 | CI / Meta Review の両run開始 |
   | 05:50:25 | `Meta Reviewer AI (Gemini)` success（38s） |
   | 05:51:11 | `Typecheck & Test` success（1m25s）→ **この時点で全check green** |
   | 06:06 | CEOの指摘で発覚。watcherは`running`のまま、eventを1件も出していない |

   **green到達からPLが気付くまで約15分**。全checkはPR作成から**91秒**で完了していた。

   **実際に使っていたwatch mechanism（read-only確認）**: harnessのMonitor（background bash task、
   task id `bt9tsssnf`）。30秒間隔で`gh pr checks 123 --json name,bucket`をpollし、
   `jq`で非pendingのcheckを抽出、`comm`で差分をstdoutへ出し、
   `jq -e` で全check非pendingになったらループを抜ける、という構成だった。

   **watcherは「存在した」が「機能していなかった」**:

   - task statusは最後まで`running`。**armされていたことは事実**である
   - しかし **`jq`がこのWindows環境のbash PATHに存在しない**（`gh`は存在し、`--json`出力も正常）
   - そのため抽出結果は毎回空になり、**progress eventが1件も出なかった**
   - 完了判定も`jq -e`だったため常にfalseになり、**ループは一度もbreakしなかった**
     （＝completionを検知する手段が最初から無かった）
   - `jq: command not found` はstderrへ31回出ていたが、
     **Monitorはstderrをeventにしない仕様**のため、この失敗はPLへ届かなかった

   **Confirmed root cause**: watcherのcompletion predicateが**実行環境で成立しない道具（`jq`）に
   依存**しており、かつ**watcher自身の失敗がsilent**だった。CI・GitHub Actions側には問題が無い。

   **障害の分類（C-11）**: **monitoring failure**。ケース1（supervisorごと消滅）と同種だが、
   今回は「watcherプロセスは生きているのに検知能力がゼロ」という形をしている。
   **ケース2（completion-detection failure）とも構造が同じ**である —
   Expoは「TTYが無いのでQRが出ない」、今回は「`jq`が無いので判定式が動かない」。
   どちらも **completion signalが実行環境で成立するかを検証していない**（C-3a違反）。

   **Finding**: *external background operationのcompletion後にPL control loopを再開する仕組みが
   保証されていない。* 「監視中」と宣言することと、監視が成立していることは別である。

   **contractへの含意**: CI待ちは「対象の定義」を当然に満たす（workflow progressionをblockする
   external-wait operationである）。**scopeを拡張したのではなく、定義から自動的に含まれる**。
   本ケースが示す固有の論点は、external operationには**自前のchild processが存在しない**ため
   `PID alive`ベースの監視が原理的に使えず、external probe（C-2a）が唯一の手段になる、という点である。

   ### Background Task Supervision Contract（共通化するのは実装ではなく契約）

   #### 対象の定義（scopeの正本。個別task列挙にしない）

   本contractの対象は、**workflow progressionをblockし得るすべての asynchronous /
   background / external-wait operation** である。

   判定は「どの種類のtaskか」ではなく、**次の性質を持つか**で行う:

   - 呼び出し元が結果を待つ間、**workflowが前に進まない**
   - 完了が**同期的な戻り値では得られない**（別process / 別host / 外部service / 後続event待ち）

   自前でspawnしたchild processか、外部serviceの完了待ちか、
   人間の応答待ちかは問わない。**この性質を持つ限り対象である。**

   **AI delegation / Expo restart / CI wait / deploy / build はscopeの定義ではない。**
   これらはcontractを検証する**実障害例およびacceptance例**として扱う。
   **新しい種類のasync処理が追加されるたびに個別のwatchdog仕様を追記しないと漏れる設計は禁止する。**
   新種のasync operationは、列挙へ追加されたから対象になるのではなく、
   上記の性質を満たす時点で**既定で対象**である（closed by default）。

   #### 最低限の共通要求（下記C-1〜C-13はこの8項目の具体化である）

   | 要求 | 内容 | 対応する条項 |
   |---|---|---|
   | durable run/state | run stateがprocess再起動をまたいで残る | C-10 |
   | observable progress | 実進捗が観測可能（経過時間・PID生存だけに依らない） | C-2 / C-2a / C-4 |
   | task-specific completion predicate | 「成功」の定義をtaskごとに持ち、実行環境で成立する | C-3 / C-3a / C-3b |
   | stall detection | 進捗停止を検知し、診断してから動く | C-4 / C-5 / C-11 |
   | bounded recovery | recoveryは有限回で打ち切る | C-6 |
   | terminal verdict | 必ず終端へ到達する（無期限RUNNING禁止） | C-1 / C-12 |
   | automatic continuation | 完了時にcontrol loopが自動resumeする | C-13 |
   | session / Mobile非依存 | 監視主体が呼び出し元sessionと運命を共にしない | C-7 / C-8 |

   #### 正式運用経路への参入条件（admission rule）

   **workflowをblockするasync operationは、この8要求を満たさない限り正式運用経路に載せない。**
   満たさないまま使う場合は、workflowをblockしない形（fire-and-forget、
   または結果を待たない補助的用途）に限る。
   実障害ケース1〜3はいずれも「満たしていないoperationがworkflowをblockする位置に置かれた」結果であり、
   個別のbug修正では再発を止められない。

   **E-1. admission ruleは維持する。** 新規に作るもの、および新しく正式運用へ載せる
   workflow-blocking async operationは、Supervision Contract未充足なら**原則禁止**である。
   下記のlegacy exceptionは、この原則の緩和ではなく**既存運用を壊さないための期限付き猶予**である。

   #### Legacy exception registry（CEO判断、2026-09-08。期限付き。open-endedにしない）

   **E-2. 対象は「現時点で既に運用されている未配線operation」だけ**とする。
   下表に**明示登録されたものに限り**、supervised_runsへの正式配線が完了するまでの間、
   workflow-blockingな使用を認める。

   **E-3. 各exceptionは必ず4項目を持つ。** owner / 不足しているcontract要件 / 暫定監視方法 /
   解消条件。**解消条件は「いつか直す」ではなく「supervised_runsへの正式配線完了」**とする
   （sunset条件）。配線が完了した時点でその行は削除する。

   **E-4. 新しい種類のexception追加は禁止する。** 今後新しいworkflow-blocking async operationが
   現れた場合、「legacyだから」を理由に本表へ追加してはならない。**先にContractへ適合させる。**
   本表は増えない表であり、配線が進むにつれて減っていく表である。

   **E-5. exception中でも無期限RUNNINGは禁止する（C-1はexceptionの対象外）。** 正式配線前でも、
   既存のwatch / poll / manual check等でterminal outcomeを確認する暫定運用を必ず持つ。
   **「何も監視せず待つ」は例外としても認めない。** これは今回の3件すべての直接原因であり、
   ここを緩めるとexceptionを設ける意味がなくなる。

   | kind | owner | 不足しているcontract要件 | 暫定監視方法（E-5） | 解消条件（sunset） |
   |---|---|---|---|---|
   | `deploy` | PL Role | durable run/state・observable progress・completion predicate・stall detection・bounded recovery・automatic continuation・session非依存（**ほぼ全項目**）。VPS deployは`jobs`を経由しないPL手順であり、run行が存在しない | 手順の各stepで**明示的なmanual check**（systemd unitのactive確認、`/health`応答確認）を行い、確認できるまで次stepへ進まない。結果は作業報告へ必ず残す | `supervised_runs`へ`deploy` kindを配線し、8要求を満たすこと |
   | `build` | PL Role | observable progress（`checkStall()`が`startedAt`のみで、log等の実進捗を見ない）。durable state・terminal・automatic continuationは既存`jobs` + jobRunnerの`JOB_TIMEOUT_MS`とpoll loopで**すでに満たしている** | 既存のJob経路をそのまま使う（`jobs`行 + Worker watchdogのstall検知 + timeoutによる強制終端）。**Job経路を迂回した直接実行はexceptionの対象外**とする | `stallDetector.checkStall()`へ進捗signalを渡せるようにし、`supervised_runs`へ配線すること |
   | `external_ci` | PL Role | durable run/state・automatic continuation（実障害ケース3で実証）。自前のchild processが無いためPID系の監視は原理的に使えない | **watcherをarmする前に、判定に使うコマンドの実在を確認する**（ケース3の直接の再発防止）。加えてwatcher任せにせず、**明示的な再確認を1回は行う**まで完了と報告しない | `supervised_runs`へ`external_ci` kindを配線し、GitHub API pollまたはwebhookでautomatic continuationを満たすこと |

   **登録されていないoperationはexceptionではない。** 表に無いworkflow-blocking async operationは
   E-1の原則どおり禁止であり、必要なら先にContractへ適合させる。

   #### 実装方針（機構は統合しない）

   他セッションでも長時間監視対策を調査中である。**この件を理由に新しい watchdog / supervisor /
   monitoring daemonを新設しない。** runtime Worker watchdog（`apps/worker/src/watchdog/watchdog.ts`）と
   `scripts/delegate-watchdog.sh` は監視対象・実行主体・障害モードが異なるため、
   **実行機構は責務を分けたままでよい。統合しない。**
   共通化するのは上記の要求（contract）と、C-10の永続run stateだけとする。

   以下、個別条項。

   **C-1. 必ずterminal stateへ到達できる。** RUNNING / SUCCEEDED / FAILED / STALLED / TIMED_OUT 等、
   最終的に必ずterminal verdictへ到達する。**無期限RUNNINGは禁止。**

   **C-2. 経過時間だけでstalled判定しない（progress predicate）。** 固定タイマーのみで判定せず、
   可能なtaskでは既存の実進捗signalを使う。**PIDが生きているだけでhealthyと判定しない。**

   **C-2a. log activityをprogressの唯一の根拠にしない（ケース2で実証）。** taskによっては
   正常なidle状態でログが出ない（Metroはclient activityが無い間ログを出さない）。
   `process alive` / `last log update` / `elapsed time` の3つだけでstalled判定してはならない。
   可能なら**task固有のexternal health / completion probeを優先する**（Expoなら port listen と
   manifest / bundle endpointへの実probe）。

   **C-3. taskごとにcompletion predicateを持てるようにする。** 「成功」の意味はtaskごとに異なる。
   Expoなら`Expo process spawned`ではなく`MetroがreadyになりCEO端末から接続可能な入口が生成された`
   ところまでが成功。deployならhealth 200、buildならexit 0、reviewならverdict取得、
   delegated AIならDONE/BLOCKED/ERROR。**新しい汎用状態機械を過剰に作る前に、既存task/watchdogの
   completion判定を拡張できないか必ず先に確認する。**

   **C-3a. completion predicateが「実行環境でも成立すること」を確認する（ケース2の直接の原因）。**
   interactive / TTY環境では成立しても、background / redirected stdout / detached実行では
   成立しないsignalがある。実例: interactive ExpoはconsoleへQRを出すが、background Expoは
   stdoutがpipeなのでQRを出さない。completion signalを設計するときは必ず次を確認する:

   - interactive専用のsignalではないか
   - TTY依存ではないか
   - stdoutをpipeへredirectしても取得できるか
   - detached executionでも成立するか

   **C-3b. observable side effectをsuccess判定に使う。** 描画・表示といったpresentation artifactを
   成功条件にしない。Expo restartのsuccess predicateは今後:
   (1) Metro processが存在 → (2) expected port 8081がlisten → (3) manifest endpointが200 →
   (4) Expo Goが要求するbundle endpointが200 → (5) exp:// URLを生成可能、まで確認できればREADY。
   **「QRがconsoleに描画されたこと」は成功条件にしない。**
   QRはURLから別途生成可能なpresentation artifactとして扱う。

   **C-4. progress heartbeat / stale detection。** lastProgressAt / lastLogAt / currentStage を
   既存情報から取得できるようにする。一定時間進捗がなければ`still running`ではなく
   `stalled suspected`として監視側が調査する。正常な無出力時間はtaskごとに異なるため、
   一律の短いtimeoutだけで判断しない。

   **C-5. stalled検知後は自動診断を先に行う（blind retry禁止）。** 最低限:
   process存在 / expected child process存在 / log更新 / expected port・resourceのready /
   **completion predicateを既に満たしていないか** / stale・duplicate processの有無。
   Expo事例なら Metro process・8081 listener・manifest 200・bundle 200・duplicate Metro。
   **`latest Metro log` と `QR state` は診断根拠にしない**（ケース2で、どちらも健全なMetroに対して
   誤った停止判定を出す原因だったことが実測で確定した）。

   **C-6. recoveryはboundedにする。** diagnose → stale process cleanup → 1回restart →
   completion predicate再確認 → success / failed / escalated。無限retryは禁止。
   同じ失敗を繰り返してprovider quotaやVPS resourceを消費しない。

   **C-7. 監視主体と監視対象を同時に殺さない。** PLが「background taskが終わるまで待つ」状態のまま、
   監視自体を同じsession / 同じbackground processに依存させない。
   既存watchdog / persisted Job stateへ統合できるならそれを優先する。

   **C-8. Mobile / sessionを閉じても監視・復旧は継続する。** task state / current stage / last progress /
   stalled判定 / retry・recovery / terminal verdict はbackend側で継続する。
   Mobile再オープン時は見せかけのtimerではなく、**backendで実際にどこまで進んでいるか**へ復帰する。

   **C-9. stalledをrunningと表示しない。** MOB-001と同じ問題。既存状態から導出可能な範囲で
   「正常進行中 / 長時間処理中 / 停滞を検知・確認中 / 自動復旧中 / 復旧失敗・AI開発チーム対応必要」
   を区別して表示する。**recovery actorが実際に動いていないのに「自動復旧中」と表示してはならない。**

   **C-10. 共通の永続run stateを1つ持つ（唯一の共通実装）。** 実行機構は分けたままにするが、
   「今どのbackground taskが走っていて、最後に進捗したのはいつで、terminal verdictは何か」を
   backend側で1箇所から観測できなければ C-1 / C-7 / C-8 / C-9 はどれも成立しない。

   **C-11. monitoring failureをworkload failureと誤認しない。** 記録・通知・recovery判断では次の3つを
   区別する:

   - **workload failure** … 実処理そのものが失敗した（Metroが起動しない、buildがexit≠0 等）
   - **monitoring failure** … 監視側が死んだ・見ていなかった（ケース1: supervisorごと消滅）
   - **completion-detection failure** … 実処理は成功しているが完了を検知できない（ケース2）

   **正常なserviceを「ログが止まった」という理由だけでkill / restartしてはならない。**
   これはC-5（診断を先に行う）とC-6（bounded recovery）の存在理由そのものである。

   **C-12. STALLED と READY-but-wrapper-waiting を区別する。** ケース2の実状態は
   `Metro = READY` / `background wrapper = RUNNING` だった。child / serviceが既に目的を達成
   しているのに、wrapperだけterminal stateへ遷移しないケースがある。監視側はcompletion predicateを
   **wrapperの状態と独立に再評価し、predicate satisfiedならwrapperがRUNNINGでもSUCCEEDEDとして
   回収できる**設計とする。これはAcceptance **Case Cの実例**であり、
   Case Cはもはや仮想ケースではなく再現済みの実障害である。

   **C-13. 「監視中」という宣言を監視成立とみなさない（ケース3）。** watcherをarmしたと述べることと、
   completionを検知してcontrol loopがresumeすることは別である。次の3点を
   **機械的に確認できる**必要がある:

   1. **watcher / poller / webhook等が実際にarmされている**（task id等の実体が取得できる）
   2. **completionを検知できる**（判定に使う道具・signalが実行環境に実在することを、
      待ち始める前に確認する。ケース3は`jq`不在で判定式が一度も評価できなかった）
   3. **completion時にcontrol loopが自動resumeする**（検知しただけで通知経路が無い状態にしない）

   加えて **watcher自身の失敗をsilentにしない**。ケース3では`jq: command not found`が31回
   stderrへ出ていたが、stderrはevent化されない経路だったため誰にも届かなかった。
   **監視の失敗は、監視対象の失敗と同じ重さで表面化させる**（C-11のmonitoring failure）。
   silenceをhealthyの証拠として扱わない — 「何も来ていない」は
   「順調」と「watcherが死んでいる」の両方と区別がつかない。

   実装上の含意: watcherは**armされた時点でheartbeatを出す**べきであり、
   一定時間eventもheartbeatも無いwatcherは、監視対象ではなく**watcher自身をstalled扱い**にする。

   ---

   ### C-10の受け皿: 汎用 `supervised_runs`（新規。`design_review_runs`へは相乗りしない）

   **`design_review_runs` への相乗りは採用しない（CEO判断、2026-09-08）。**
   同テーブルはGate / evidenceの根拠であり、`completeWithEvidence()` が
   `design_review_evidence` を単一transactionで発行する経路を持つ。ここへreview以外のrun
   （Expo restart / deploy / build / AI delegation）を混ぜると、Gateの根拠テーブルに
   Gateと無関係な行が入り、`ux_design_review_runs_subject_active` の意味・
   `recoverAndRekickAtStartup()` の再kick対象・fail-closed分岐がすべて曖昧になる。
   **Gate / evidence用テーブルへreview以外のrunを混ぜない。**

   `delegation_runs` も採用しない。今回の対象はAI delegationに限らないため名前が狭すぎる。
   **候補名: `supervised_runs`（第一候補）/ `background_runs`。**

   保持すべき最小の列（実装時に確定させる。ここでは契約として必要なものだけ列挙する）:

   - `kind` … supervised runの種別。**registry lookupのキーであり、判定ロジックそのものは持たない。**
   - `subject_id` … PR番号 / project id / task key 等
   - `status` … RUNNING / SUCCEEDED / FAILED / STALLED / TIMED_OUT（C-1のterminal集合）
   - `started_at` / `last_progress_at` / `current_stage` … C-4のheartbeat
   - `progress_source` … 何を進捗signalとして見ているか（log mtime / port listen / marker等）
   - `predicate_key` / `predicate_version` … C-3。**判定ロジックはDBに置かず、code側registryを引くキーだけを保存する**（下記「D-2」）
   - progress / completion evidence … predicateが「満たされた」と判断した根拠（観測値）。判定式ではなく観測結果を保存する
   - `recovery_attempt_count` … C-6のbounded recovery
   - `terminal_verdict` / `error` … 終端理由
   - `supervisor` … どの機構が見ているか（`worker_watchdog` / `delegate_watchdog` / なし）。
     **C-9で「自動復旧中」と表示してよいのは、ここに実在するrecovery actorが記録されている場合だけ。**

   `claim_token` によるstale completion fencingは `design_review_runs` の実装が有効性を実証済みなので、
   **パターンとして踏襲する（テーブルを共有するのではなく、設計を踏襲する）。**

   ---

   ### 実装前提として固定した決定（CEO判断、2026-09-08。#110初期実装のスコープ）

   **D-1. 初期接続`kind`は2つに限定する（scopeではなくrollout順序）。** #110の初期実装で
   `supervised_runs`へ接続するのは **`ai_delegation` と `expo_restart` のみ**とする。
   `kind`は将来拡張可能な形（新しい値の追加がschema変更を要求しない形）で設計する。

   **これはcontractのscopeを狭める決定ではない。** contractの対象は「対象の定義」で決まり、
   `deploy` / `build` / `external_ci` も定義上すでに対象である。D-1が決めているのは
   **どの順で既存supervisorを配線するか**だけである。

   **決定済み（CEO判断、2026-09-08）**: admission ruleとD-1を併せると、まだ配線されていない
   `deploy` / `build` / `external_ci` はworkflow-blockingな形で使えないことになるが、
   これらは現に運用中である。**選択肢(a)「期限付きの明示的例外」を採用する。**
   実体は上記「Legacy exception registry」であり、E-1〜E-5の制約下でのみ有効である。
   採用しなかった案: (b) rollout前倒し、(c) blockしない形へ一時的に落とす。

   **D-1のrollout順序**: まず `ai_delegation` / `expo_restart` を配線し、
   **その後legacy exceptionを順次解消する**（registryの行を1つずつ消していく）。
   `external_ci`は自前のchild processを持たないため、progress sourceもcompletion predicateも
   `ai_delegation` / `expo_restart` とは異なる形（GitHub APIのpoll、あるいはwebhook）になる。
   registryが空になった時点で、E-1の原則が例外なく適用される状態になる。

   **D-2. completion predicateをDBで実行しない。** predicateを自由文字列やDB内DSLとして保存し、
   それを解釈・実行する経路は作らない。DBに保存するのは
   `predicate_key` / `predicate_version` / progress・completion evidence だけとし、
   **実際の判定ロジックは`kind`ごとのcode側registryで解決する。**

   - **再起動後にも同じpredicateを復元できること**。`predicate_key` + `predicate_version` から
     registryを引き直せば、process再起動をまたいでも同じ判定が再現される。
     `predicate_version`を持つのは、registry側のロジックを更新したときに
     「どのversionの判定で終端したか」が過去のrunから読めなくなるのを防ぐため。
   - **unknown predicateはfail-closedにすること**。registryに存在しない`predicate_key`、
     または解決できない`predicate_version`に遭遇したrunは、
     SUCCEEDEDにもRUNNING継続にもせず、**terminal（FAILED / 要escalation）へ倒す**。
     「判定できないので成功とみなす」「判定できないので待ち続ける」はどちらも禁止
     （後者はC-1違反そのものであり、今回の障害を再生産する）。

   ---

   ### 既存機構の調査結果と最小接続案（read-only確認済み。実装はまだ行わない）

   | 機構 | 監視対象 | 進捗signal | terminal保証 | contract上の欠落 |
   |---|---|---|---|---|
   | Worker Job watchdog<br>`watchdog/watchdog.ts` + `stallDetector.ts` | `jobs` の running行 | **無し**。`checkStall(commandKind, startedAt)`は経過時間のみ | **無し**。`watchdog_events`へ記録し通知するが、Jobをterminalへ遷移させない | C-1 / C-2 / C-3 / C-6。閾値表は`CommandKind`固定でAI CLI実行・外部process系のkindが無い |
   | delegated-task watchdog<br>`scripts/delegate-watchdog.sh` | detached opencode child | log size/mtime + child process有無（inactivity 120s / long_tool 600s） | **有り**。marker必須で`verdict`と`telemetry.json`を必ず書く | provider決め打ち（`is_opencode_pid`）。run_dirがローカルのみでbackendへ載らない（C-8 / C-10） |
   | design_review_runs<br>`designReviewCoordinator.ts` | API processがspawnするrunner | 無し（同期await） | **有り**。fail-closed + claim_token fencing + bounded attempt + startup recovery | timeout 120s固定で長時間task不可。API process内awaitのためC-7を満たさない。**相乗り先にはしない** |
   | Mobile status derivation<br>`apps/mobile/lib/taskWorkflow.ts` | 上記の結果を表示 | `isWatchdogConfirmedStalled()`がwatchdog_eventsを参照 | — | `running_healthy` / `running_stalled` の2値のみ。C-9が要求する「停滞を確認中」「自動復旧中」「復旧失敗」に相当する表示が無い |

   **最小接続の方針（新daemonを作らない）**:

   1. **`stallDetector.checkStall()` の拡張** — 現在 `startedAt` しか見ておらず、これがC-2 / C-4欠落の根本。
      `lastProgressAt` を引数に取れるようにする。`jobs.stdout_path` / `stderr_path` は既に存在するため、
      log mtimeをheartbeat sourceにする経路は新規テーブル無しで作れる見込み。
   2. **`supervised_runs` への書き込みは各supervisorが行う** — Worker watchdogと
      delegate-watchdog.shはそれぞれ自分の観測結果を同じ表へ書く。読む側（Mobile / PL）は1箇所を見る。
      **実行機構は統合しない。共有するのはこの表だけ。**
   3. **Case Cの回収経路** — 現行のどの機構も「completion predicateは満たしているがwrapperが終わらない」を
      検出できない。C-5の診断に completion predicate 再評価を必ず含め、満たしていれば
      wrapperの生死に関わらず SUCCEEDED で回収する。
   4. **Mobile** — `JobDisplayState` / `ProjectExecutionHealth` はいずれも既存状態からの導出であり、
      `supervised_runs` を導出元に追加するだけで拡張できる。新しいstatus体系は作らない。

   ---

   ### Acceptance（長時間task監視のE2E / 回帰試験に必ず含める）

   - **Case A**: processは生きているが進捗が止まる → stalled検知できる
   - **Case B**: process自体が消える → stalled / failed検知できる
   - **Case C**: processは生きておりcompletion predicateも達成済みだが、task wrapperだけ終了しない
     → successを再確認して回収できる。**2026-09-08のExpo事例で実際に発生済み**（Metro READY /
     wrapper RUNNING）。仮想ケースではない。現行のどの機構もこの経路を持っていないため、
     新規に設計が必要な唯一のケースである
   - **Case D**: stalled → recovery成功 → taskが再開しterminal successになる
   - **Case E**: stalled → recovery不能 → 無限RUNNINGにならずBLOCKED / ERROR等で終わり、
     PL / CEOへ必要な情報が出る
   - **Case F**: CEOがMobileを閉じて再度開く → backendで継続した現在の実状態へ復帰する
   - **Case G**（ケース3由来）: watcherが判定に使う道具・signalが実行環境に存在しない
     → **watcher自身がstalled / 起動失敗として表面化する**。eventもheartbeatも出ないまま
     `running`を維持し続けないこと。監視対象がgreenになっても誰も気付かない状態を作らない

   **Expo / Metro regression（ケース2の再現試験。Case Cの具体化）**: stdoutをnon-TTYへredirectし、
   QRのconsole outputが無く、Metroは正常起動して manifest 200 / bundle 200 を返す状態を再現し、
   **監視がSTALLEDではなくREADY / SUCCEEDEDと判定できること**を確認する。
   また、**QR artifactはrepoではなくtmp等へ生成し、`git add`等でproduction sourceへ混入させないこと**。

   **CI wait regression（ケース3の再現試験）**: watcherが依存する外部コマンドを不在にした状態で
   external CI待ちを開始し、**watcher自身の異常が一定時間内に表面化すること**、および
   CIがgreenになった際に**control loopが自動resumeすること**を確認する。
   「eventが来ない」状態がhealthyと区別できることを試験の合格条件に含める。

   **現状**: 本項目は設計フェーズ。**実装は未着手であり、着手前にこのcontractのCEOレビューを受ける。**

<!-- roadmap:id=deleg-001-watchdog-respawn state=planned -->
0. [ ] **DELEG-001: `delegate-watchdog.sh` の respawn が旧childを確実に終了できず、recovery attemptを二重計上する**
   （2026-09-10登録。#110 Step 3（PR #128）のCI中に**Linux実測**したため、Windows固有ではなく
   **実運用上の既知欠陥**として扱う）。**#128へは混ぜず独立Findingとする**（CEO判断）。

   **実測（Linux CI、2026-09-09）**: `scripts/delegate-watchdog.test.sh` が
   `expected recovery_attempt_count '1', got '2'` で失敗した。**同一コードの再実行では pass**（9660ms）。
   したがって決定的な失敗ではなく**非決定的挙動**である。
   これまでWindowsローカルでのみ観測していたが（`ps -p <pid> -o args=` によるprovider同定が
   MSYSで機能しない件とは別）、**Linuxでも再現することが確認された**。

   **リスク**:

   1. **respawn時に旧childを確実に終了できない** — `safe_kill_process()` は
      `is_opencode_pid()` が真のときしか kill せず、判定に失敗すると
      「Warning: PID N is not an opencode process, skipping kill for safety」で**素通りする**。
   2. **recovery attemptが二重計上される** — 1回の失敗に対して `recovery_attempt_count` が
      2進むケースがある（上記の実測）。
   3. **bounded recoveryが予定より早くexhaustする** — 2の帰結。
      本来 `DELEGATION_MAX_RECOVERY_RETRIES` 回試せるはずの委任が、半分程度で
      `ESCALATE:recovery_exhausted` に倒れ得る。**C-6（bounded recovery）の bound が
      設計値どおりに効かない**ことを意味する。
   4. **stale / duplicate child が残る** — 1の帰結。旧childが生きたまま新childが起動すると、
      同一委任に対して2つのprovider processが並走し得る。

   **なぜ今これが効くか**: #110 Step 3 で `ai_delegation` の実行監督を
   `delegate-watchdog.sh` に寄せた（**retry actorはここだけ**という構造をCEOが確定）。
   したがって本欠陥は、`supervised_runs` 側の bounded recovery とは独立に、
   **委任1件あたりのretry回数を設計値から狂わせる**。
   Step 3 の Acceptance A〜E は実経路でPASSしているが、それらは
   `supervised_runs` 側の bound を検証したものであり、**watchdog側のbound精度は別問題**である。

   **方針**: **既存 `delegate-watchdog.sh` の責務内で最小修正する。**
   **新しい watchdog / supervisor は追加しない**（#110 の構造決定に従う）。
   想定する修正の方向（実装時に確定）:

   - respawn の**前に**旧childの終了を確定させる（kill後に終了を待ち、待てない場合は
     retryせず terminal verdict へ倒す。素通りさせない）
   - `is_opencode_pid()` が判定できないときに「安全のためskip」ではなく
     **fail-closed（retryせずescalate）**へ倒す。現状は判定不能が実質「無視」になっている
   - `recovery_attempt_count` の加算を、respawn 1回につき1回だけ起きる位置へ寄せる
   - `scripts/delegate-watchdog.test.sh` を**繰り返し実行しても安定して通る**ことを完了条件にする
     （1回passでは非決定性を潰した証明にならない）

   **重複確認済み（2026-09-10）**: 本Findingと重なる既存項目は無い。
   `worker-cgroup-delegation-contract` は systemd の cgroup delegation 契約であり無関係。
   `pl-review-process-supervision`（#110）は `delegate-watchdog.sh` を機構として参照しているが、
   そこで挙げている欠落は「provider決め打ち」「run_dirがbackendへ載らない」であり、
   **respawn/二重計上は含まれていない**。

   **#110 Legacy exception registry との関係**: 同registryには `deploy` / `build` / `external_ci` の
   3行があり、**`ai_delegation` の行は存在しない**。ただし本Findingが解消するまでは、
   **`ai_delegation` の retry 挙動は設計値どおりとみなさない**こと。
   Step 3 完了をもって「委任監督は完全に解決済み」とは扱わない。

<!-- roadmap:id=strategic-decision-unknown-value-fail-open state=done -->
0. [x] **`resolveFinalDecision` が未知のdecision値をALIGNEDへfall-throughする（fail-open） — 完了（2026-09-11, `4a0fbaf` / PR #146）**
   （2026-09-10登録、**高優先度・安全性**。PR #136（continuation reconcile）の作業中に発見。
   **#136へは混ぜず独立Findingとする**）。

   **内容**: `packages/shared/src/strategicDecision.ts:22-40` は decisions に `'CONFLICT'` が
   含まれれば CONFLICT、空か `'UNCERTAIN'` を含めば UNCERTAIN を返し、
   **それ以外は無条件に `return 'ALIGNED'`** する。有効な `StrategicDecision` は
   `ALIGNED | CONFLICT | UNCERTAIN` のみ（`packages/shared/src/types/meta_review.ts:115`）だが、
   focused / integration の decision 値はこのenumに対して検証されていない。

   **実測（2026-09-10）**: continuation reconcileのテストで、design reviewを意図的に
   不一致にするため `decision: 'NOT_ALIGNED'`（実在しない値）を返させたところ、
   **ALIGNEDとして受理され**、design review evidenceが登録され、implement Jobが作られた。
   `'CONFLICT'` に変えて初めてテストが正しく落ちた。

   **リスク**: この出力は design review evidence になり、Job Gate が implement Job の
   実行可否を判断する根拠である。runnerのschema drift・typo・provider差し替えによる
   語彙違い・truncateされた値のいずれでも「未レビュー同然の変更が承認される」。

   **非対称性**: `recomputeDecision`（`apps/api/src/designReview/designReviewCoordinator.ts:176-260`）は
   independent review verdict の未知値は明示的にrejectし、focus集合の不一致もrejectする。
   **decision値だけが素通りする。**

   **方針（実装前に確認）**: fail-closedへ倒す。parse境界でdecision値をenum検証するか、
   `resolveFinalDecision` を「全decisionが厳密に `'ALIGNED'` のときだけALIGNED、
   未知値はUNCERTAIN」へ反転する。未知値がALIGNEDにならない回帰テストを追加する。
   `packages/shared` はapi/worker双方が参照するため、AGENTS.mdのReview Levelに従うこと。

   **MVP blocker（CEO判断・2026-09-11）= M0。** Exit Criteria本文には現れないが、Exit Criteria
   2（AIがタスク生成）・3（AIが実装）が依拠するReview Gateそのものの健全性であり、
   `AGENTS.md` 0章の例外条件「Approval Gate・権限・安全境界を迂回できる」に該当する。
   **新しいReview機構は作らず、既存のdecision解釈・validation境界のみを最小変更する。**

   **完了（2026-09-11, commit `4a0fbaf` / PR #146）**: `resolveFinalDecision()` を反転し、
   **判定が1件以上ありその全件が厳密に `'ALIGNED'` のときだけ ALIGNED**、それ以外（空・
   UNCERTAIN混在・enum外の未知値）はすべて `'UNCERTAIN'` へ倒すようにした。
   判定語彙の正本を `STRATEGIC_DECISIONS` に1箇所化し、`isStrategicDecision()` を追加している
   （`packages/shared/src/strategicDecision.ts`）。新しいReview機構は追加していない。
   **本 entry が `state=planned` のまま残っていたのは記録漏れであり、2026-09-12 に是正した。**

<!-- roadmap:id=approval-resume-liveness-dependency state=done -->
0. [x] **approval後にblocked git_commit Jobが自動resumeせず、client起点の `/resume` が要る**
   — **前提が誤っていた。実装は既に存在しており、本Findingはcloseする（2026-09-11）**
   （2026-09-10登録。PR #136の調査で判明したとされたが、**参照したrouteが別物だった**。
   下記「訂正」参照）。

   **内容**: CEOがblocked な git_commit Job を承認しても、Jobは自力で再開しない。

   1. `apps/worker/src/jobRunner.ts:490-560` — Gateが `block_until_approved` を返すと
      Workerは通知して `return { status: 'blocked' }` する。待機もGate再pollもせず、Jobは終端する。
   2. `apps/api/src/routes/approvals.ts:75-89` — `PATCH /api/approvals/:id` は承認行を
      書くだけで、Jobを作らず再queueもしない。
   3. 復旧は `POST /api/tasks/:id/resume`（`resumeBlockedTask()`）= **client起点**。

   **帰結**: 1 Taskあたり **承認 + resume の2回のclient操作**が要る。
   これは PR #136 が解消したGET polling依存とは**別**のliveness依存であり、
   「clientを閉じたままProject完了」は現状不可能である。

   **前提（変更しないこと）**: `git_commit` は riskLevel に関わらず無条件でCEO承認必須
   （`apps/api/src/routes/approvalGate.ts:415-417`）。low-risk auto approvalの設定・env flagは
   存在せず、`apps/worker/src/guards/safetyAuditor.ts:74` は `autoApprove` というキーワード自体を
   CRITICALとして検出する。**auto-approvalは本Findingの解決策ではなく**、
   採用するならセキュリティモデル変更としてCEO承認が要る。

   **問うべき範囲**: 「**正当な承認が既に存在する**場合に、blocked git_commit Job の再開を
   backend側（既存のWorker poll cycle / reconcile）が行ってよいか」。
   `resumeBlockedTask()` が既に持つdedupとGate再チェックを再利用する前提で、
   まずread-onlyで調査し、call pathと最小変更案を出してから実装する。

   **MVP blocker（CEO判断・2026-09-11）= M2。** Exit Criterion 5「Goal変更以外で開発が止まらない」
   に直撃する。

   **2026-09-11 read-only調査で判明した追加事実（深刻度が登録時の想定より高い）**:
   `findWorkspaceOwningTaskId()`（`apps/worker/src/index.ts:92`）は **`blocked` Job を
   workspace の所有者として扱う**。`fetchQueuedJob()` は所有者がいる間、**他のすべての Task の
   queued Job を skip する**（同 124行）。したがって承認待ちで blocked になった git_commit Job は、
   誰も再開させない限り workspace を握り続け、**当該 Task だけでなく Worker 全体が
   1件も Job を拾わなくなる**。したがって「承認待ちで止まる」の影響範囲は Task 単位ではなく
   **Project横断の全体停止**である。
   （⚠️ 登録当初ここには「承認後も誰も resume しない限り」「過去の Production E2E が完走できたのは
   client が手動 resume を呼んだためである」と書いていたが、**後者は検証していない推測で誤り**。
   承認は auto-resume を伴う。下記「訂正」を参照。所有権機構の記述自体は正しい。）

   **完了条件（CEO確定・2026-09-11）**: Approval が CONSUMED された後、client の
   `POST /api/tasks/:id/resume` なしに既存 Worker 処理で後続 Job が進み、blocked Job の
   workspace ownership が解消されること。duplicate resume / duplicate Job を起こさないこと。
   Approval Gate 自体（`git_commit` の無条件CEO承認）は維持する。

   ### 訂正（2026-09-11、実routeでの検証により）— **本Findingの前提は誤り。実装済みだった**

   **何が間違っていたか**: 本Findingは `PATCH /api/approvals/:id`
   （`apps/api/src/routes/approvals.ts:73-87`）が「承認行を書くだけでJobを再queueしない」ことを
   根拠にしていた。しかしこのrouteは**Project単位の `approvals` テーブル**のものであり、
   **git_commit の Approval Gate とは別系統**である。git_commit Gate が作るのは
   `approval_requests` で、承認口は `PATCH /api/approval-requests/:id/status`
   （`apps/api/src/routes/approvalGate.ts:773`）である。

   **実際の挙動**: そのrouteは `requestedAction === 'git_commit'` かつ `APPROVED` の場合、
   `storage.approvalRequests.approveAndResumeJob()`（`apps/api/src/storage/sqlite.ts:2389`）を
   呼ぶ。この関数は**単一transaction**で
   (a) approval_request を APPROVED にし、
   (b) `jobs.approval_id` で紐づく Job を `status='queued'` へ戻し、前回実行の結果
   （stdout/stderr/exitCode/changedFiles/commitHash/guardResult 等）をクリアする。
   したがって**承認だけで Job は再開し、client の `/resume` は不要**である。
   同一 Job 行を再利用するため duplicate Job にもならず、`approval_id` の紐づきが保たれるので
   後続の `consume` も成立する。expired / 二重承認 / Job不一致 / Design Review evidence 不成立は
   いずれも 404/409 で fail-closed（承認自体が成立しない）。
   競合時の巻き戻し防止も既にあり、Worker の blocked 書き戻しが承認後に届いても
   `jobs.update()`（`sqlite.ts:1136`）が APPROVED/CONSUMED を見て queued を維持する。

   **Production 実測（2026-09-11、continuation E2E test 9 の audit_log）**: 本番 DB の
   `audit_log` を read-only で確認したところ、git_commit の承認2件はいずれも
   **`approve success` の1行のみ**で、当日 `resume` 系の監査エントリは **0件**だった。
   ```
   approval-20260911-b75bcfcf  06:12:53  approve success   (Task 1 commit)
   approval-20260911-d1884c76  06:21:15  approve success   (Task 2 commit)
   resume entries today:       (none)
   ```
   CEO は approve しか押しておらず、それだけで Job が再開して commit まで到達している。
   コード読解だけでなく**実機の実行痕跡でも auto-resume が裏づけられた**。
   **同時に訂正すべき記述**: 上記「深刻度」欄で「過去の Production E2E が完走できたのは
   client が手動 resume を呼んだためである」と書いたが、**これは検証していない推測であり誤り**。
   承認だけで再開するため、E2E の完走は auto-resume で説明できる。
   `findWorkspaceOwningTaskId()` が `blocked` Job を所有者として扱い Worker 全体を止める、
   という機構の記述自体は正しい。正しくないのは「承認しても解放されない」という部分で、
   実際には**承認によって blocked が queued へ変わり所有権は解放される**。

   **client `/resume` が依然として必要な経路（MVP blocker ではない）**: approval が
   STALE / SUPERSEDED / EXPIRED / REJECTED になった場合は Job が blocked のまま残り、
   `POST /api/tasks/:id/resume` が要る（`resumeBlockedGitCommitJob.test.ts` が対象）。
   これは異常系であり、`AGENTS.md` 0章の異常系水準「既存の正規手段で再開または復旧できる」を
   Mobile の Task 詳細「追加指示して再開」で満たしている。MVP後の改善対象とする。

   **訂正（2026-09-12, 実測）**: 直上の「Mobile の Task 詳細『追加指示して再開』で満たしている」は
   **`WAITING_FOR_USER` のまま期限切れになった場合には成立しない**。期限切れ行は
   `findWaiting()` から除外されて Mobile の承認画面に出ず、かつ `resumeBlockedTask()` が
   status だけを見て resume を拒否するため、スマホからは一切復旧できなかった。
   詳細と修正は `approval-expired-waiting-blocks-resume` を参照。

   **本Findingで実際に行った作業**: production code は変更していない。既存挙動を固定する
   回帰テスト `apps/api/src/routes/approvalAutoResumeLiveness.test.ts`（8件）を追加した。
   実route（`PATCH /api/approval-requests/:id/status`）経由で、承認だけで queued へ戻ること、
   同一 Job 行であること、前回結果がクリアされること、**blocked Job が残らない
   （workspace ownership が解放される）**こと、Worker が claim に使う
   `GET /api/jobs?taskId=` から queued として見えること、二重承認が 409 で拒否され Job が
   増えないこと、REJECTED では queued へ戻らないこと、未承認なら blocked のままであることを
   固定した。**M3 の production E2E で「手動 resume なし」を実測して最終確認する。**

<!-- roadmap:id=workspace-dirty-leakage-cleanup state=planned -->
0. [ ] **terminal 失敗が dirty worktree を共有 workspace に残し、掃除する actor がいない**
   （2026-09-11登録。**MVP blocker = M1**。P1 completion handoff が
   「この cluster には open な owner 項目が無い」と指摘していた root cause の正式な owner 項目。
   root cause の記述自体は `project-auto-task-job-chain`（done）の本文に残っているが、
   **実装責務は本項目が持つ**。重複 Finding を作らないこと）。

   **root cause（2026-09-11 read-only調査でコード確認済み）**: worktree から変更を除去する
   コードはシステム全体で `revertBlockedJobChanges()`（`apps/worker/src/jobRunner.ts:1351`）の
   1箇所だけで（`git clean` / `git reset` の実呼び出しは同1404-1406行のみ）、
   その呼び出し元3箇所（913 / 1237 / 1641）は**すべて File Change Guard 違反
   （`!guard.allowed`）条件下**にある。したがって AI CLI が失敗しても変更が
   `allowedPaths` 内に収まっていれば cleanup は一度も走らない。

   **roadmap 既存記述の訂正**: `project-auto-task-job-chain` 本文の
   「untracked ファイルはどの経路でも掃除されない」は不正確。
   `revertBlockedJobChanges()` は `added` を `git reset -q HEAD -- <path>` +
   `git clean -fdq -- <path>` で **path 限定に削除でき、untracked も掃除できる**。
   欠けているのは能力ではなく**呼び出し条件**である。

   **現在の表面症状（P1 Phase 1 の admission 分類修正後）**: repair が
   `MAX_REPAIR_ATTEMPTS=3` を使い切ると `escalateTaskToHuman()` が Task を `blocked` にするが
   worktree には触れない。その Job は `failed` で終わり、`failed` は
   `findWorkspaceOwningTaskId()` の所有者条件に入らないため**所有者不在のまま dirty が残る**。
   次 Task の `task:<id>:initial-implement` は `computeWorkspaceBaseline()` で
   `normal Job requires a clean worktree but found N changed path(s)` となり、
   `ownsWorkspaceBeforeClaim=false` のため **quarantine ではなく `failed`** になる
   （`apps/worker/src/index.ts:448`）。以後すべての新規 Task が同じ場所で死ぬ。
   roadmap が記録した「quarantine が恒久化する」症状のうち
   `implement:<id>:review` / `review:<id>:git-commit` の誤分類分は P1 Phase 1 で
   `isIntentionallyDirtyJob()` へ追加され解消済み。**構造欠陥は同一だが症状が変わっている。**

   **方針（CEO確定・2026-09-11）**: **worktree isolation は導入しない。**
   帰属データは既に durable に永続化されている（`jobs.changed_files` /
   `jobs.workspace_baseline`、`apps/api/src/storage/schema.ts:72,79`）。
   repair/retry がその dirty state を**もう継承しないと確定した terminal transition**で、
   その Job に帰属できる変更だけを**既存の `revertBlockedJobChanges()` により** cleanup する。
   `prepareRepairFlow()` / `escalateTaskToHuman()` は cleanup 開始条件を確定する地点として
   利用してよいが、**API 側へ cleanup ロジックを複製せず**、実際の cleanup は既存
   architecture の責務（Worker）に合わせて最小変更で行う。
   **新しい cleanup subsystem / 新 status / 新 Gate は追加しない。**

   **維持すること（CEO確定）**: `preExistingPaths` は触らない ／ 帰属不能な変更は削除しない ／
   HEAD が変わっている場合の既存 skip 条件を維持 ／ known-good 条件を緩めない ／
   cleanup 失敗・不完全時は fail-open せず escalation を維持 ／
   repair/retry が dirty state を正当に継承する経路を壊さない ／
   duplicate cleanup を起こさない。

   **完了条件**: 人間の手動 git cleanup が通常復旧手段として必要な状態を解消すること。
   M3 production E2E で手動 git 操作なしに複数 Task が通ることで実測する。

   ### 実装（2026-09-11）— worktree isolation なし・既存関数の呼び出し条件の追加のみ

   **変更したのは「いつ呼ぶか」だけで、`revertBlockedJobChanges()` 自体は無変更**。
   安全性（path 限定 / `preExistingPaths` 不可触 / HEAD 移動時 skip / 失敗は握り潰さない）は
   すべて既存関数のまま。新しい subsystem / status / Gate / route / sweep は追加していない。

   - **API（開始条件だけを伝える。リポジトリは触らない）**: `PATCH /api/jobs/:id` が
     `prepareRepairFlow()` の結果 `escalate` のとき応答へ `workspaceCleanupRequired: true` を
     付ける。`queue`（repair 生成）のときは付けない —— repair Job は INTENTIONALLY-DIRTY として
     dirty を正統に継承するため、掃除してはならない。
   - **Worker（掃除の実体）**: `patchJobWithRetry()` が応答本文からこのフラグを読み、
     `persistJobResult()` が `cleanupEscalatedWorkspace()` 経由で既存
     `revertBlockedJobChanges()` を呼ぶ。材料（`workingDir` / `startCommitHash` /
     `preChangedPaths`）は `JobRunResult.workspaceCleanup` として実行結果に持たせる。
     Worker 側で repair/escalate の判定を再実装しない（`decideRepairAction()` は API の責務）。
   - **fail-open しない**: skip / 部分失敗時は CRITICAL 通知を出す。Task は既に escalate 済み
     （`blocked`）なので、既存の Human escalation 経路がそのまま受け皿になる。
   - **後方互換**: `PatchJob` は素の boolean も受け付ける（`normalizePatchJobResult()`）。

   **カバー範囲（正直な記述）**: 自動で掃除されるのは「implement/repair Job 自身が失敗し、
   repair budget を使い切って escalate した」経路。これが 2026-09-08 に production で
   観測された経路である。
   review が changes_requested で implement Job を escalate する経路と、
   `executeQueuedRepair()` 内の escalate は**フラグを付けていない**。理由は回避ではなく
   **帰属**で、それらの時点で dirty を作ったのは既に terminal な別の Job であり、
   PATCH 中の Job から見ると `preChangedPaths` に入る（＝`revertBlockedJobChanges()` は
   触らない）。「帰属不能な変更は削除しない」制約に従うと、そこで消せるものは無い。
   この経路の復旧は既存の正規手段（Mobile Task詳細「追加指示して再開」→ `resume:` Job は
   INTENTIONALLY-DIRTY なので dirty 上で実行できる）で完結し、**人間の手動 git 操作は要らない**。

   **検証**: `apps/worker/src/workspaceEscalationCleanup.test.ts`（8件・実 git リポジトリ）で
   「escalate 後に `computeWorkspaceBaseline()` が次の normal Job を admission できる」
   ことを直接固定した。あわせて repair 継承経路を壊さないこと、`preChangedPaths` 不可触、
   HEAD 移動時の skip + CRITICAL 通知、manifest 無しでは掃除しない、PATCH 失敗時は掃除しない、
   二重実行耐性を固定。API 側は `apps/api/src/routes/workspaceCleanupSignal.test.ts`（4件）。

<!-- roadmap:id=supervised-runs-reconcile-worker-allowlist state=planned -->
0. [ ] **`POST /api/supervised-runs/reconcile` が WORKER_ALLOWLIST に無い（credential split有効化時に403になる潜在欠陥）**
   （2026-09-10登録。PR #136 のIndependent Reviewで同型の欠陥が指摘され、
   既存経路にも同じ漏れがあることが判明した。**PR #136 には混ぜない**）。

   **内容**: Workerは毎poll cycleで `POST /api/supervised-runs/reconcile` を呼ぶ
   （`apps/worker/src/index.ts`）が、このrouteは `WORKER_ALLOWLIST`
   （`apps/api/src/auth/workerAllowlist.ts`）に**含まれていない**。
   WORKER credentialはDefault Denyのため（`apps/api/src/auth/apiToken.ts:103`）、
   **credential splitを有効化した時点で毎cycle 403**になる。

   **重要な訂正（2026-09-10、production実測）**: 登録時は「live production defectであり
   現に403になっている」と記載したが、**これは誤りだった**。本番APIの実プロセス環境変数は
   `API_TOKEN` のみで、`ADMIN_TOKEN_SHA256` / `WORKER_TOKEN_SHA256` は**設定されていない**。
   したがって `apiToken.ts` は `legacySingleTokenAuth` へ落ち、**allowlistは一切評価されない**。

   実測（PR #136 deploy直後、WORKER credentialで実行）:
   - `POST /api/supervised-runs/reconcile` → **200**（403ではない）
   - split有効時にWORKERへ明示的に禁止される `PATCH /api/approvals/:id` → **404**
     （routeに到達している = allowlist不適用）
   - Worker journalにも403警告は出ていない

   **現状の正しい評価**: 稼働中のproductionは壊れていない。**潜在欠陥**であり、
   credential split（`ADMIN_TOKEN_SHA256` / `WORKER_TOKEN_SHA256` の設定）を
   有効化した瞬間に顕在化する。したがって
   **「splitを有効化する作業」の前提条件**として扱うのが正しい。

   **顕在化した場合の帰結**: Worker側は `!response.ok` をwarnして返すだけなので
   静かに失敗し続ける。supervised run の reconcile が成立せず、完了済みの委任が
   RUNNING のまま残り、`#110 Step 3` で配線した「terminal後のcontinuation起動」も動かない。

   **付随して確認が要る点**: credential splitが現在無効ということは、
   `docs`・memory類にある「本番はauth splitを強制している」という記述が事実と異なる。
   splitを有効化する予定があるのか、既に廃止されたのかをCEOへ確認すること。

   **再発防止（本項目の一部として検討）**: allowlist漏れはunit testでは検出しにくい
   （`WORKER_ALLOWLIST` を反復するテストは追加後に自動でpassする）。
   PR #136 では自分が追加したrouteについて、実route登録＋auth hookを通す統合テストを
   `workerCredentialAuthorization.test.ts` へ足した。同型のテストを既存の
   Worker呼び出し経路すべてに用意するか、経路一覧とallowlistの整合を確認する手段を持つか決める。

<!-- roadmap:id=task-allowed-paths-not-normalized state=planned -->
0. [ ] **task の allowedPaths が正規化・検証されず、絶対パスだと必ず File Change Guard で落ちる**
   （2026-09-11登録。continuation E2E（Production E2E test 4）で実際に1サイクル失った。
   **MVP後へ延期** — 回避策は仕様書のパス表記を相対にするだけでコード変更が不要なため）。

   **内容**: File Change Guard は git が報告する **リポジトリ相対**の changedFiles と
   task の `allowedPaths` を比較する（`apps/worker/src/guards/fileChangeGuard.ts`）。
   `allowedPaths` に**絶対パス**が入ると、どの changedFile とも一致せず
   **常に fileChangeAllowed=false** になる。

   実測（2026-09-11, Production E2E test 4 / task-001）:
   ```
   allowed_paths = ["/workspace/target/test.js"]
   changed_files = ["test.js"]
   guard_result  = {"permissionAllowed":true,"fileChangeAllowed":false,"fileViolations":["test.js"]}
   stderr        = File Change Guard blocked (stage A): test.js
   ```
   過去に成功した全タスクの `allowedPaths` は相対だった（`test.js` / `e2e/` /
   `e2e/phase12-smoke.js`）。絶対パスが入ったのは今回が初。

   **直接原因は仕様書側**: 投入した仕様書が対象ファイルを
   `/workspace/target/test.js` と絶対パスで書いており、Roadmap generator が
   その表記を `allowedPaths` へそのまま採用した。**Guardの挙動は設計どおり**で、
   許可側の over-block は安全側（同ファイルのコメントに明記あり）。

   **したがって製品欠陥ではなく入力検証の欠落**。ただし以下が実運用コストになる:
   - task sync 時点で「このallowedPathsはどのchangedFileにも一致し得ない」ことを検出しない
   - 失敗メッセージが `File Change Guard blocked: test.js` であり、
     **allowedPaths自体が不一致である**ことを示さない。CEO/AIは
     「test.jsが禁止されている」と誤読する（今回実際に調査時間を要した）

   **対応方針（MVP後）**: 次のいずれか。新しいGate/仕組みは作らない。
   1. task sync 時に `allowedPaths` をリポジトリ相対へ正規化する（workingDir prefixを剥がす）
   2. 正規化せず、絶対パスを task sync 時に**検証エラーとして弾く**（fail-fast）
   3. Guardのblockメッセージに allowedPaths を含め、不一致の原因が読めるようにする

   3 は単独でも誤読コストを消せるので、最小対応として有力。

   **なお状態は壊れていない**: guard block後も worktree は clean に戻り、
   `test.js` は未変更、verify.js baseline も FAIL のままだった。
   異常検出 → 安全停止 → 状態保全 → 原因特定可能 → 正規手段で再開、は満たしている。

<!-- roadmap:id=quarantined-dirty-task-generic-recovery state=planned -->
0. [ ] **既に quarantine 済みで dirty な Task を汎用的に復旧する手段が無い**
   （2026-09-11登録、**高優先度**。Production E2E test 8 で実際に復旧不能になった。
   PR #150 には混ぜない）。

   **PR #150 との関係（重要）**:
   #150 は「review が structured result を返せず失敗した Task」が quarantine へ落ちる
   **将来の経路を塞ぐ**（Task を blocked へ escalate し、既存 resume の `resume:` Job =
   intentionally-dirty 経路へ合流させる）。
   **しかし既に quarantine 済みの Task は救済しない。** #150 は予防であって治療ではない。

   **現状の解除手段と、それが効かない理由**:
   - `PATCH /api/jobs/:id/clear-quarantine` は実在するが、`observation` と `knownGood` の
     提示を必須とし、サーバ側で再検証する（`apps/api/src/routes/jobs.ts`）。
     **人力・force・admin による無条件解除経路は無い**（意図的な設計）。
   - 自動申請は Worker 起動時の `recoverStaleJobs` →
     `reconcileQuarantinedJobAtStartup` のみ（`apps/worker/src/jobStateManager.ts`）。
     baseline がある場合は `verifyWorkspaceAgainstBaseline` の成功が必要、
     baseline が無い場合は `worktreeClean` を含む known-good 観測が必要。
   - **dirty worktree ではどちらも成立しない**ため、Worker を再起動しても解除されない。
   - `resumeBlockedTask` は Task の任意の未解除 quarantine Job を見て fail-closed で拒否する
     （`WORKSPACE_QUARANTINED`）。
   - Mobile は quarantine 時に進行ボタンを隠す（`allowsProgressActions()` が false）。
     案内文も「承認や再開では解除されません。自動では復旧しません。
     AI開発チーム側で作業領域の復旧が必要です」と明記している。

   **結果**: CEO はスマホから一切復旧できない。MVP の目的（スマホだけで運営）と正面から衝突する。

   **安全上の核心 — ここが本 Finding の難所**:
   dirty worktree の中身は、多くの場合 **implement が作った正当な未コミット成果**である
   （test 8 では Task 1 の正しい変更がそのまま残っていた）。
   したがって「quarantine を解除する」＝「その成果を捨てる or 引き継ぐ」の判断が必要で、
   **正当な未コミット成果を誰が破棄してよいかが安全上の核心**になる。
   - 自動破棄は、レビュー済み・承認待ちの正当な変更を消す危険がある
   - 自動引き継ぎは、検証できない workspace 上で次の Job を走らせることになり、
     quarantine が守っていた前提そのものを壊す

   **やってはいけないこと**:
   **generic unquarantine / force cleanup を安易に追加しない。**
   `clear-quarantine` の observation + knownGood 要件を緩めない。
   無条件解除は quarantine の存在意義を消すため、追加するなら
   「誰が・何を根拠に・何を捨てるか」を明示した設計が先。

   **#150 後も残る到達経路（要確認）**:
   Worker が implement 実行中に crash / kill されると Job は `running` のまま残り、
   起動時 `reconcileRunningJobAtStartup` が workspace を検証する。
   implement の baseline は `mode:'clean'` なので、部分的な変更が残った worktree は
   検証に失敗し **quarantine される**。この経路は #150 では塞がれない。
   なお deploy 手順の preflight は `jobs_running = 0` を要求するため、
   計画的な再起動では発生しない。想定外の crash / OOM / kill が引き金になる。

   **再現証拠**: Production E2E test 8（`733643fe`）を失敗記録として保持している。
   quarantine 済み Job `01de09fc` と `quarantineReason` がそのまま残っており、
   本 Finding の実機再現材料として参照できる。

<!-- roadmap:id=done-task-stale-blocked-job-owns-workspace state=done -->
0. [x] **`done` Task の滞留 blocked Job が workspace 所有権を握り続ける** — 完了（2026-09-13）
   （2026-09-12登録、**MVP-BLOCKING（CEO判断）**。`approval-expired-waiting-blocks-resume` の
   修正を Production で検証した直後に発覚。commit は成功したのに後続が進まなかった）。

   **内容**: `findWorkspaceOwningTaskId()`（`apps/worker/src/index.ts`）は Job の status だけで
   所有者を決め、**Task の status を一切見ていなかった**。`resumeBlockedTask()` は新しい Job を
   別行として作り、旧 `blocked` 行を監査証跡として残す（`approveAndResumeJob()` は同一行を
   `blocked -> queued` へ UPDATE するので滞留しない）。そのため resume 経路でだけ
   「`done` Task に blocked 行が残る」状態が生まれ、所有権が永久に解放されなかった。

   **実害**: 期限切れ Approval からスマホで正規復旧して commit に成功しても所有権が解放されず、
   後続 Task / Project が進まない。解放手段が **archive / pause しか無い**状態は
   Design Philosophy 1「スマホ完結」を満たさない。

   **Production 実測（2026-09-12）**: 同一形状が **4件**。いずれも
   `review:…:git-commit` の blocked 行 + より新しい Job 1件で、いずれも archived / paused。
   つまり過去の run はすべて archive/pause でしか解放されていなかった。
   `1d50d5d7`/`e60ba617`（Production E2E test 10）、`240d1949`/`9b1789e2`（Phase1b Approval Level
   較正検証用）、`3a1aff17`/`83041277`（Phase1 Shadow Gate 検証用）、
   `9a9c9423`/`7a014347`（E2E確認用プロジェクト9）。

   **修正（最小）**: 「終わった Task に取り残された blocked 行」は所有権を**無条件には**持たず、
   **workspace がまだ使用中の間だけ**所有者として振る舞う。手放してよい状態になれば自然に解放する。
   候補条件は (1) Task が `done` (2) その blocked Job が quarantine されていない の2つだけで、
   解放するか否かは worktree の実観測が決める。

   **解放条件は admission と同じ定義にそろえる（独立レビュー round 3 の指摘）**:
   `computeWorkspaceBaseline()` は manifest を読む**前に** `detectGitOperationState()` で
   fail-closed する。したがって manifest が空でも `index.lock` / `MERGE_HEAD` / rebase 途中が
   残っていれば次の Task は始められない。manifest の空だけで手放すと、所有者不在のまま後続 Task の
   initial-implement が必ず失敗する。そこで解放条件を「manifest が空 **かつ** 進行中の git 操作が
   無い」とした。git 操作の検出に失敗した場合も「無い」とみなさず保持する（fail-closed）。
   検出は manifest が空のときだけ行うので、通常の cycle に追加コストは乗らない。
   `running` / `queued` の判定、cleanup / quarantine / resume / repair の条件は一切変更していない。

   **durable な自己申告を信用しない（独立レビュー round 1・2 の指摘）**: 当初案は
   `task.status === 'done'` だけを、次案は `commitHash` + `createdAt` の追い越しを条件にしたが、
   **どれも「もう dirty が無い」ことの証明にならない**ことが判明した。
   - `task.status` は `PATCH /api/tasks/:id` が検証なしで書き込む（`apps/api/src/routes/tasks.ts`）
   - `job.commitHash` は `PATCH /api/jobs/:id` が検証なしで受け取る（`apps/api/src/routes/jobs.ts`）。
     逆に commit 後・永続化前に落ちれば欠ける
   - `createdAt` の大小は因果順ではない（clock skew で逆転しうる）
   - 正当な commit でも、commit 後に残る差分（post-commit dirt）はありうる
   いずれの経路でも、誤って手放すと後続 Task の initial-implement が clean worktree 要件で死ぬ。
   そこで判定を durable state から **worktree の実観測**へ移した。dirty なら由来を問わず保持する
   （安全側）。これにより上記4経路はすべて構造的に無効化される。

   **例外**: quarantine された blocked Job は worktree が clean でも所有権を維持する
   （PR-C の hard invariant「安全と証明できない限り所有権を解放しない」を優先）。
   この場合は worktree を観測せずに owner を確定する。

   **poll cost**: **所有権判定が行う**観測は「強い owner が居ない かつ 滞留候補または
   blocked Task が居る」cycle だけで、その場合も `buildWorktreeManifest()` は最大1回
   （M1-a で確立した性質をそのまま維持している）。強い owner が居る cycle では一切観測しない。
   なお claim 後の `computeWorkspaceBaseline()` は admission のために別途 manifest を読むため、
   **poll cycle 全体としては 1 回ではない**。これは本項目以前からの既存挙動で、変更していない。

   **旧 blocked 行は残したまま**にしている。行を残すのは既存設計で
   `resumeBlockedGitCommitJob.test.ts` が固定しており、監査証跡でもあるため、
   行には触れず**所有権の述語だけ**を直した。
   **回帰テスト**: `apps/worker/src/workspaceOwnerDoneTask.test.ts`（41件）。
   上記 Production 4件を fixture として使用している。**修正を外すと 15 件が落ちる**
   （解放側 = 本項目が直した挙動）。残りは既存挙動の固定（running / queued / pending /
   blocked / quarantine / initial-implement / M1-a fallback / resume・repair 中の dirty /
   強い owner が居る cycle では観測しない）と、保持側の新分岐
   （外部 PATCH で done + dirty / commit 後の残差 dirty / 進行中 git 操作 / HEAD 未解決 /
   各検出の失敗時 fail-closed / 候補複数時の fail-closed / poll cost）である。

<!-- roadmap:id=approval-expired-waiting-blocks-resume state=done -->
0. [x] **期限切れ `WAITING_FOR_USER` Approval が blocked git_commit Job の resume を永久に塞ぐ**
   — 完了（2026-09-13）
   （2026-09-12登録、**MVP-BLOCKING（CEO判断）**。M3 Production E2E の準備中に Production で
   実際に発生し、M3 が開始できなくなったことで発覚）。

   **内容**: `expiresAt` は参照時の遅延判定で、期限切れ行を掃除する actor は存在しない。
   そのため `WAITING_FOR_USER` のまま 24h 経過すると、次の3つが同時に成立して Task が
   **スマホから一切復旧できなくなる**（Design Philosophy 1「スマホ完結」に抵触）。
   1. `findWaiting()` が `expires_at > now` で除外するため、`GET /api/approval-requests/waiting`
      に出ない = Mobile の承認画面から承認ボタンへ到達できない
   2. `approveAndResumeJob()` は期限切れを `EXPIRED` として拒否する（正しい fail-closed）
   3. `resumeBlockedTask()` が status だけを見て「承認待ち」として resume を拒否する
   行を `EXPIRED` へ進める actor が居ないため、2 も 3 も永久に成立し続ける。

   **Production 実測（2026-09-12）**: Project「Production E2E test 10」の Task `1d50d5d7` が
   `review:…:git-commit` Job `e60ba617` で blocked。承認 `approval-20260911-63d33155` は
   `WAITING_FOR_USER` / `expires_at=2026-09-12T08:31:31Z`（当時 14:45Z = 6時間超過）。
   同時刻の `GET /api/approval-requests/waiting` は **0 件**を返した。

   **修正（最小・1条件）**: `resumeBlockedTask()` の「有効な承認待ち」を**未期限の**
   `WAITING_FOR_USER` だけに限定した（`apps/api/src/storage/sqlite.ts`）。
   期限切れ承認は resume を妨げない。resume は Approval Gate を迂回せず、新 Job が
   `/gate/check` で**新しい** Approval Request を発行し、CEO が Mobile から承認する
   正規経路へ戻す。

   **やっていないこと（CEO 指示）**: expired approval の自動承認／Approval Gate の迂回／
   古い approval 行の force delete／新 daemon・reaper・scheduler の追加／
   「押しても必ず失敗する expired approval」の Mobile 再表示／共通 expiry 処理への拡張。

   **適用範囲（独立レビュー CLAIM 5 を受けて明示）**: この条件は git_commit 分岐より手前にあるため、
   **非 git_commit（AI CLI）の resume にも等しく効く。これは意図した適用範囲である** —— 罠は
   `requestedAction` ではなく「期限切れ行を `EXPIRED` へ進める actor が居ない」ことに由来し、
   非 git_commit の承認待ち（`POST /api/approval-requests` 由来）でも同じく復旧不能になるため。
   迂回にはならない: 非 git_commit では Design Review evidence 判定が閉じたまま（test 11、
   runner は差し替え済みで外部呼び出しをしない）、git_commit では Gate 再実行が新しい
   Approval Request を要求する（test 3・4・8）。

   **回帰テスト**: `apps/api/src/routes/resumeExpiredApproval.test.ts`（13件）。
   修正を外すと 8 件が落ち、既存挙動を固定する 5 件（未期限 WAITING / APPROVED / REJECTED /
   期限切れ APPROVED / 非 git_commit の未期限 WAITING）は修正の有無にかかわらず通ることを確認済み。

<!-- roadmap:id=orphan-dirty-workspace-no-owner state=deferred -->
0. [ ] **M1-b: どの Task にも帰属できない dirty workspace（orphan dirty）を復旧する手段が無い**
   （2026-09-12登録、**高優先度・MVP後defer**。M1 を M1-a / M1-b に分割したうちの後半。
   M1-a は PR #154 で完了済み。**本項目の実装は MVP 完成まで開始しない**）。

   **内容**: `resolveWorkspaceOwnership()`（`apps/worker/src/index.ts`）の fallback は、
   dirty を説明できる blocked Task が**1つも無い**場合 `{ kind: 'none' }` を返す。
   その結果 Worker は次の Task を claim し、その initial-implement が clean worktree 要件で
   失敗する。dirty の持ち主が居ないので `resume:` / `retry:` / `repair:` のどれも起動できず、
   **自動復旧経路が存在しない**。人手で worktree を戻すまで系は前に進まない。

   **到達経路（少なくとも2つ）**:
   1. Worker が implement 実行中に crash / kill され、部分的な変更だけが残る
      （`quarantined-dirty-task-generic-recovery` と重なるが、あちらは quarantine 済み Task の
      復旧、こちらは**そもそも帰属先 Task が無い**場合であり、別問題として扱う）
   2. `workspaceBaseline` を持たない**旧い Job** しか残っていない場合。M1-a の gate は
      baseline commit と HEAD の一致を要求するため、baseline が null の Job は候補にならない。

   **実測（2026-09-12, Production, M1-a deploy 直後）**: `/workspace/target` は `M test.js` で
   dirty、blocked Task は 9 件あるが、**その 9 件の Job はすべて `workspace_baseline` が NULL**
   （baseline 永続化より前に作られた行。DB全体では 148 Job 中 34 Job のみ baseline を持つ）。
   現時点では blocked な `review:...:git-commit` Job `e60ba617` が**既存条件で** owner なので
   fallback は評価されないが、その Job が解けた後に同じ dirty が残ると orphan dirty になる。

   **やってはいけないこと**: **誤判定で worktree を自動 cleanup しない。**
   M1-a と同様、帰属を証明できない変更を系が勝手に捨ててはならない。
   汎用 force cleanup を追加するなら「誰が・何を根拠に・何を捨てるか」の設計が先。

   **関連**: `workspace-ownership-content-identity`（M1-a の受容済み既知制約）、
   `quarantined-dirty-task-generic-recovery`（quarantine 済み Task の復旧）。
   3項目は**別 Finding として分離したまま**扱い、まとめて1つの機構にしない。

<!-- roadmap:id=workspace-ownership-content-identity state=deferred -->
0. [ ] **fallback workspace ownership は content identity を証明しない（CEO受容済みの既知制約）**
   （2026-09-12登録。M1-a / PR #154 の独立レビュー CLAIM 7。**Codex Sol round 2 は
   `REJECT blocking=1` のまま**であり、blocking 0 にはなっていない。
   CEO が「accepted known limitation」として merge を判断した）。

   **判定範囲**: `resolveWorkspaceOwnership()`（`apps/worker/src/index.ts`）の fallback は
   `current HEAD` + `current dirty paths` + durable な `job.changedFiles` までで帰属を判定する。
   **dirty の内容そのものが当該 Job のものか（content identity）は証明しない。**

   **誤判定の条件**: blocked Task の変更を **HEAD を動かさずに**手動 revert し、その後で人間が
   **同じ path だけ**を別内容で編集した場合、現在の dirty paths と記録された `changedFiles` が
   一致し、baseline commit も HEAD と一致するため、元の Task を owner と誤認する。

   **なぜ塞がないか**: 内容の同一性を証明するには per-path content hash 等の
   **新しい永続 state** が必要で、M1-a の要件「新しい永続 state を追加しない」と衝突する。
   MVP 直前に永続 state と移行を増やすコストが、下記のとおり安全側に倒れる残存リスクに
   見合わないと判断した。

   **影響（すべて安全側）**:
   - 他 Task はその cycle で claim せず停止する。説明のつかない dirty がある状況では
     停止自体が本来正しい挙動であり、進めても clean worktree 要件で失敗するだけ。
   - **本判定は cleanup には一切使わない。誤判定だけでデータが削除されることはない。**
   - ただし owner Task の `resume:` が out-of-band な手動編集を引き継ぐ可能性は残る。
     なお `resume:` が dirty を継承するか否かは `isIntentionallyDirtyJob()` が決めており、
     M1-a はこれを変更していない（この経路自体は M1-a 以前から同じ）。

   **MVP運用境界（非対応）**: **active / blocked な target workspace を人間が VPS 上で
   直接編集しない。** out-of-band manual edit は MVP では非対応とする。

   **本項目と M1-b（真の orphan dirty）は別 Finding**であり、まとめて扱わない。

<!-- roadmap:id=implement-acceptance-criteria-not-mechanically-verified state=planned -->
0. [ ] **implement Job が受入条件を機械的に検証せず、条件を満たさない成果物が `success` になる**
   （2026-09-11登録、**高優先度**。Production E2E test 9 で実害として観測。
   continuation / quarantine の修正には混ぜない）。

   **内容**: implement Job の SafeCommand は `kind: 'test'`（= `node test.js` / `pnpm test`）
   固定であり、Task の `acceptanceCriteria` に書かれた検証コマンドは**一切実行されない**。
   その結果、受入条件を満たさない成果物でも Job は `success` になる。

   **実測（2026-09-11, Production E2E test 9 / task-001 の 1 回目）**:
   受入条件は「先頭行が `// Executed: YYYY-MM-DDTHH:mm:ssZ` 形式」「`node verify.js 1` が
   exit code 0 で PASS」だったが、実装は次を出力した:
   ```
   // 2026-09-11T14:04:56+09:00     ← `Executed: ` 欠落、UTC `Z` ではなく `+09:00`
   ```
   `node verify.js 1` は exit 1（FAIL）。それでも `node test.js` は README を見るだけなので
   通り、**Job は success** になった。

   **救ったのは review**: 後続の review Job が同じ 2 点（書式違反 / `verify.js` の実行証跡なし）を
   指摘して `changes_requested` を返し、`repair:` Job が正しい形へ修正した。
   系としては自己回復したが、**最後の砦が LLM レビュー1枚**という状態である。

   **リスク**: review が甘い判定をした場合、受入条件を満たさない変更がそのまま
   Approval Gate へ進む。CEO は「レビュー済み」として承認することになる。

   **対応方針（MVP後）**: 新しい Gate は作らない。既存の SafeCommand 機構の中で、
   Task の受入条件に現れる検証コマンドを implement Job の判定に反映できないか検討する。
   最小案としては「受入条件に実行可能なコマンドが含まれる場合、それを SafeCommand として
   実行し、失敗したら Job を success にしない」。

<!-- roadmap:id=outbox-blocked-critical-false-alarm state=planned -->
0. [ ] **正常な continuation 中に `Worker Outbox resend is blocked` の CRITICAL が誤発報する**
   （2026-09-11登録、**中優先度**。Production E2E test 9 で観測）。

   **内容**: commit 成功時に continuation が pending だと `PATCH /api/jobs/:id` は
   **意図的に非 2xx（503）を返す**。Worker は Outbox イベントを保持して poll cycle ごとに
   再送し、continuation が完了したら 200 を受けて解消する — これは設計どおりの正常系である。

   ところが `notifyOutboxDeliveryBlocked()` は pending が **3 cycle** 続いた時点で
   CRITICAL 通知を上げる。Task の design review を伴う continuation は 30 秒前後かかり、
   poll 間隔が 5 秒なので **正常系で容易に 3 cycle を超える**。

   **実測（2026-09-11）**:
   ```
   15:12:57  PATCH failed after retries → persisted in Outbox
   15:13:02 / 15:13:09 / 15:13:15   Pending Outbox events remain
   15:13:17  [CRITICAL] Worker Outbox resend is blocked
             New Job intake is paused until delivery succeeds
   15:13:22 / 15:13:28              Pending Outbox events remain
   15:13:33  Task 2 implement 開始（= 正常に完了した）
   ```

   **リスク**: 障害でないのに CRITICAL が鳴り続けると、本番で通知が信用されなくなる
   （狼少年）。実際この E2E では「Job intake is paused」という文面が出ているが、
   実際には 36 秒後に正常へ復帰している。

   **対応方針（MVP後）**: 新しい通知機構は作らない。既存の閾値・文面の調整で足りるはず。
   continuation 起因の 503 滞留を「想定内」として区別できるか、あるいは閾値を
   design review の所要時間より長くするか。

<!-- roadmap:id=review-structured-output-schema-strictness state=planned -->
0. [ ] **review の structured output が `"rule": null` で strict schema 違反になり fail-closed する**
   （2026-09-11登録、**中優先度**。Production E2E test 8 で観測。test 9 では再発せず）。

   **内容**: review 結果のスキーマは `rule: string` を必須にしている
   （`packages/shared/src/types/approvalLevel.ts:52`）。レビューモデルが findings の一部に
   `"rule": null` を出力すると strict validation が弾き、Job が
   `Structured review output failed strict schema validation (fail-closed)` で failed になる。

   **fail-closed 自体は正しい**（解釈できないレビューを承認扱いにしない）。
   問題は、**そこから先の復旧経路が無かった**こと。test 8 では review 失敗により
   Task 1 の実装成果が未コミットのまま残り、以後の通常 Job が clean worktree 要件で
   quarantine され、UI から復旧不能になった。
   → その復旧不能性は `quarantine recovery` として別途 MVP-BLOCKING で扱う。

   **断続的**: test 5 / test 7 / test 9 の review は同じ経路で成功している。
   findings を伴うレビューで出やすい可能性があるが、test 9 は findings ありで成功したため
   確定していない。

   **対応方針（MVP後）**: `rule` を optional にするか、parse 前に `null` を除去/正規化するか。
   いずれも既存スキーマの調整で足り、新しい仕組みは不要。

<!-- roadmap:id=continuation-reconcile-nonblocking-followups state=planned -->
0. [ ] **continuation reconcile の非blocking指摘2件（Independent Review NON-BLOCKING）**
   （2026-09-10登録。PR #136 のIndependent Reviewで指摘。
   **MVP完了を阻害しないため延期**。CEO方針: MVPスコープを広げない）。

   1. **sweepが毎cycle全Projectを走査する** — `reconcileTaskContinuations()` は
      `projects.findAll()`（`SELECT * FROM projects ORDER BY created_at DESC`）を毎cycle実行する。
      `ux_projects_single_running` により実作業は最大1 Projectに限られるため実害は小さいが、
      走査自体はfull-tableである。**CEO方針により、性能上の実測問題が出るまで新queryは追加しない。**
      対応するなら `findRunning()` 相当の追加。
   2. **continuationの実エラーが握り潰される** — `ensureTaskContinuation()` の catch は
      workflow生成時の例外を捕捉して**何もログしない**（`apps/api/src/ctoAi/taskContinuation.ts`）。
      routeは `stillPending` を含む結果を返すが、ログは recovered/failed が動いた時だけ出る。
      永続的なstorage障害・design review基盤障害があると、無限にretryし続けて
      API側に何のエラー signal も残らない。**この catch は #136 以前からの既存挙動**であり、
      #136 が新規に持ち込んだものではない。状態は壊れず durable state は正しいままなので、
      MVP後に扱う。
   ### 訂正（2026-09-11、CEO指示）— 「Step 3 で正式配線した」は誤りだった

   本項は以前「Step 3 で正式配線したため exception 対象ではない」と記載していたが、
   **これは Production normal path への配線完了を意味しない**。実測（grep）で
   `launchSupervisedDelegation()` には **test 以外の呼び出し元が存在しない**ことが判明した
   （参照は `*.test.ts` と `delegationProductionPath.e2e.test.ts` のみ）。
   production deploy 後に `supervised_runs=0` だった事実とも整合する。

   - **実装済み**: `supervised_runs` schema / storage、completion predicate registry、
     `launchSupervisedDelegation()`、reconcile route、Worker poll からの reconcile 呼び出し、
     `delegate.sh` / `delegate-watchdog.sh`、Acceptance A〜E の実経路E2E
   - **未配線**: `launchSupervisedDelegation()` を呼ぶ **production の実入口**。
     したがって production では supervised delegation が1件も発生していない
   - 製品の AI 実行（MVP Workflow の「Developer実装」）は別経路
     `jobRunner.ts → aiCli adapter → runContainedOrThrow()` を通り、
     **こちらは per-job cgroup containment 済み**である

   ### 進捗（2026-09-11、CEO判断）— #132 は不採用・close。残作業は formal wiring と同時に行う

   **#132（process group 方式の hardening）は merge せず close した。**
   独立レビューにより、process group は **signaling scope であって containment ではない**ことが
   確認された（子が `setsid`/`setpgid` すれば group を離脱し、supervisor は
   「group 空＝成功」と誤報告し得る）。さらに check→kill 間の TOCTOU
   （最後の member が消えて同じ数値 PGID が別 group に再利用される）も process group だけでは
   閉じられない。shell 側へ cgroup プロトコルを二重実装する案も不採用（**両方式を重ねない**）。
   したがって master には PGID / setsid のコードは入っていない。

   **既存 cgroup containment 資産（再利用先）**: `apps/worker/src/execution/runContainedCommand.ts`
   （P1 Phase 2、本番実測済み）。1 job = 1 unique cgroup、workload 開始前に `cgroup.procs` へ配置、
   `cgroup.kill` → `cgroup.events populated 0` → `rmdir` まで確認し、
   `isContainmentSafe()` が false の結果では terminalize させない。
   **`setsid` した孫も cgroup からは抜けない**（本番実測済み）。

   **MVP判定（既存 `specs/10_mvp_scope.md` のみで判定）**: MVP Exit Criteria は
   「仕様書からプロジェクト生成 / AIがタスク生成 / **AIが実装** / Dashboardで状況確認 /
   Goal変更以外で開発が止まらない」であり、MVP Workflow の実装工程は「Developer実装」である。
   これは配線済みの jobRunner 経路が満たす。`launchSupervisedDelegation` / `delegate.sh` は
   `specs/10_mvp_scope.md` に一度も現れず、AGENTS.md が定める
   **PL role の委任 wrapper（運用ツール）**である。
   よって **supervised ai_delegation の production 配線は MVP 必須ではない → MVP後へ延期**。

   **延期作業（1つの変更としてまとめて行う。単独では着手しない）**:
   formal supervised delegation を production へ配線する際に、同じ変更で
   1. 既存 cgroup containment（`runContainedCommand.ts`）の再利用
   2. **F7 の修正**: `safe_kill_process` は PID 同定に失敗して kill を skip しても、
      `kill -9` 後に対象が生存していても `return 0` を返す（fail-open）。
      cleanup 未確認を上位へ伝播させ、`ESCALATE:stale_child` 等へ倒す
   3. 独立レビュー由来の F1（pgid未記録でrespawn）/ F2（`kill -- -0` 等の危険な PGID 値）/
      F5（PID単体killと未検証operand）は **cgroup 方式では不要**になるため持ち込まない
   4. F4（子孫の group escape）は cgroup で解消される
   を行う。**単独の F7 修正 PR は作らない**（当該経路が未配線のため。CEO判断 2026-09-11）。

   **非決定性の再現記録（2026-09-11）— master 上でまだ生きている**:
   **docs のみを変更した PR #141** の CI が
   `expected recovery_attempt_count '1', got '2'` で失敗した。
   同PRはコードを1行も変更していないため、**master 側の既存 flake**である。
   空コミットのみ追加した再実行では **pass**（同一コードで pass/fail が分かれる）。
   同じ master のコードを開発機 WSL で **20回連続実行しても 20/20 pass** しており、
   GitHub runner（共有CPUで負荷が高い）でのみ観測される点も、
   当初の「負荷依存の race」という観測と整合する。
   なお master の `delegateWatchdog.test.ts` は shell suite を **1回だけ**実行する
   （反復実行版は #132 に含まれていたため master には入っていない）。

   **運用上の影響**: 本 flake は required check を確率的に落とすため、
   **無関係な PR の merge を妨げ得る**。当該経路は未配線で修正は MVP後へ延期しているので、
   当面は「落ちたら再実行」で運用する。CI から外す（skip / quarantine）判断は
   **CEO判断が要る**（検証していないものを緑に見せることになるため、独断では行わない）。

   **検証可能性の制約（実測）**: containment の実封じ込めテストは CI で実行されない。
   #132 の CI 実測で `runContainedCommand.test.ts` は **20 tests / 13 skipped**
   （`isContainmentAvailable()` gate）。開発機の WSL も cgroup v1 hybrid で作成不可。
   よって cgroup 側の Acceptance は **production でしか検証できない**前提で計画すること。

<!-- roadmap:id=codex-sandbox-off-deprecated-landlock state=planned priority=high -->
0. [ ] **Codex sandboxをdeprecated Landlockに依存しない経路へ移行する**（2026-09-07登録、
   **高優先度**。CEO判断: PR Cでは`use_legacy_landlock`を暫定的な安全経路としてのみ使用し、
   恒久解決として扱わない）。

   **事実**: このVPSではCodex 0.147.0の既定sandbox（bubblewrap）が動作しない。
   `bwrap`はsystem PATHに無く、bundled bwrapはUbuntu 24.04の
   `kernel.apparmor_restrict_unprivileged_userns=1`によりunprivileged user namespaceを
   作れないため `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` で失敗する。
   結果としてCodexは**shell commandを1つも実行できない**（＝repoを読めない）。
   2026-08-19のインストール以来ずっとこの状態で、PR Bのcanaryで初めて発覚した。

   **現在の回避策**: call-localな `-c use_legacy_landlock=true`。実測でrepo読み取り・
   write拒否ともに成立した（PR C前提として採用）。global `~/.codex/config.toml`は変更していない。

   **なぜ恒久解決でないか**: `codex features list`は
   `use_legacy_landlock deprecated` / `use_linux_sandbox_bwrap removed` を報告する。
   bwrapが無条件の既定になり、Landlockは撤去予定のfallbackである。
   **Codexのupgrade一回でこの回避策は消えうる**。消えた瞬間、Codexは再びrepoを読めなくなり、
   PR C後はRoadmap生成そのものが機能しなくなる。

   **候補**: system bubblewrapの導入（apt install。Ubuntu版はuserns許可のAppArmor profileを同梱）、
   またはAppArmor/sysctl設定の変更。**いずれもsudoによるhost変更でありYellow Zone**。
   CEO承認なしに実施しないこと。

   **既存Codex reviewerへの影響**: 現行のCodex independent reviewは
   `buildReviewPrompt()`がgit diff / 計画本文をpromptへ埋め込むため、shell無しでも機能している。
   ただし**diffの周辺コードを確認する能力は失われている**（degraded）。
   「Codex reviewがPASSした」ことを「Codexがrepoを読んだ」証拠として扱わないこと。

<!-- roadmap:id=opencode-feasibility-reviewer state=deferred -->
0. [ ] **OpenCode repo-aware feasibility reviewer（保留）**（2026-09-07登録。Step 2 provider
   topology検討中に実測して保留を決定。**Step 2をBLOCKしない**）。

   **保留理由1: vendor不明**。VPS上の`opencode models`は`opencode/*`の7モデルのみで、
   既定は`big-pickle`。公式にstealth modelでunderlying vendorが非公開のため、
   **provider-independent expertとして数えられない**。無料枠は収集データがmodel improvementへ
   使われうるため、実repoを読むproduction reviewerには使わない（CEO判断）。

   **保留理由2: read-onlyを権限層で保証できていない**。`--dir`は作業ディレクトリ指定に
   過ぎずread-only保証ではない。既定の`build` agentは`{"permission":"*","action":"allow"}`で
   書き込み込みの全許可。`plan` agentは`edit: * → deny`を持つ一方、**`bash`は明示ルールが無く
   ワイルドカードのallowに落ちる**。実測では書き込み指示を2回とも拒否したが、いずれも
   モデルが「plan modeだから」と自己申告したもので、権限層が拒否した形跡は観測できていない。

   **有効化の条件**: (1) underlying vendorを明示できるモデルを選べること
   （第一候補はGrok 4.6だが、VPSのOpenCodeからは選択不可で、新規credentialと有料契約が要る。
   CEOが追加しない判断のため現状は不可）。(2) OpenCodeの正式なpermission機構で
   edit/write/bash/external_directory/subagent/skill/execute系とsecret readを明示denyした
   AIteamOS専用agentを作り、**「書け」と明示指示しても権限層で拒否される**ことを実測できること。
   runner所有のruntime configで強制し、対象repo内のconfigで弱められないようにする。`--pure`併用。
   使い捨てdetached worktreeはprimary boundaryではなくdefense-in-depthとして併用する。

   **上記を保証できない場合は完成させず、本項目のまま延期する**（CEO判断）。

   **Step 2との関係**: Step 2のproduction topologyはCodex(OpenAI) generator /
   Gemini(Google) focused ×3 / Claude Opus(Anthropic) final integrationの3 vendor構成で
   成立するため、本項目の完了を待たない。OpenCodeは後から追加できる独立expertとして扱う。

<!-- roadmap:id=continuation-get-liveness-dependency state=done -->
0. [x] **Task ContinuationのGET依存解消（高優先度）— 完了（2026-09-11）**（2026-09-07登録。Project-start durability
   実装の独立レビューで発覚。**今回のProject-start変更が導入したものではなく既存設計**であり、
   PR混入を避けるため別項目として登録した）。

   **事実**: `GET /api/projects` と `GET /api/projects/:id` は read-only ではない。両ルートが
   `retryRunningProjectContinuations()` を呼び、`retryPendingContinuationsForProject()` を
   fire-and-forgetする（`apps/api/src/routes/projects.ts`）。これはJobを作りうる副作用である。
   当該コードのコメント自身が「Mobileが両ルートを常時pollするので各poll tickがretryの機会になる」と
   明言しており、**Mobile pollingがcontinuationのliveness driverになっている**。

   **なぜ問題か**: CEO要件「Mobileを閉じてもProject全体の処理が継続する」に直接関わる。
   Project-start workflowについてはbackend所有化済みで、GETなしで完走しGETでstageも進まない
   ことをルート層のテストで固定した。しかしTask完了後の継続は依然としてclientのpollに依存する。
   **この項目が未解決のまま、上記CEO要件をDONE扱いにしてはいけない。**

   **作業範囲**: (1) GETをread-onlyへ戻す (2) Mobile pollingをcontinuationのliveness driverに
   しない (3) 新Queue/Daemonを安易に作らない (4) 既存のcontinuation/recovery機構
   （起動時recovery・Worker Outbox再送・`task_continuations`）でbackend-ownedな再駆動が
   可能かをread-onlyで調査する。単純にGETから外すだけでは pending continuation を駆動する
   ものが無くなるため、代替driverの設計とセットで行う。

   **既存項目との関係（重複実装にしないこと）**: `project-pause-continuation-gap`（done）は
   「アプリを閉じても最後まで進む」を確認する前に解決すること。

   **完了（2026-09-11）**: 作業範囲4点すべてを満たした。(1)(2) `GET /api/projects` /
   `GET /api/projects/:id` から `retryPendingContinuationsForProject()` の fire-and-forget を
   削除し純粋 read-only へ戻した（PR #143）。(3) 新Queue/Daemonは追加していない。
   (4) backend-owned な再駆動は Worker poll cycle からの
   `POST /api/task-continuations/reconcile` として実装済み（PR #136）。continuation を進める
   経路は commit 成功時の `PATCH /api/jobs/:id`（非2xxならWorker Outbox再送）／
   `PATCH /api/projects/:id` の resume retry ／ Worker poll cycle の reconcile の3本で、
   いずれも backend で完結する。実測は
   `docs/project_memory/decisions/continuation_get_liveness_dependency_e2e.md`
   （Production E2E test 5。2 Task・依存あり・両Task commit 成功）。
   **未取得の証拠**: Worker sweep が Production で実際に pending を回収した事例は未観測
   （他経路が先に成立し sweep の出番が無かったため）。sweep 自体の回収能力は
   deterministic test で確認済み。
   **本項目の完了は「clientを閉じたままProject完了」を意味しない。**
   別 liveness 依存である `approval-resume-liveness-dependency`（M2）が残るため、
   その完了をもって初めて M3 で通しの実測を行う。

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
<!-- roadmap:id=mobile-task-create state=done -->
4. [x] 追加開発指示（追加Task作成）画面（Mobile） — 完了（2026-08-14確認）。
   通常のTaskはProject作成後にAIが自動生成する想定（下記「Project自動開発フロー」参照）であり、
   この画面はCEOが**既存Projectへ後から要望を追加する入口**（追加機能・改善・不具合・調査・
   完成後アップデート）と位置づける。CEOが通常Taskを一件ずつ手作業で登録する設計にはしない。
   **現状**: `apps/mobile/app/tasks/create.tsx`が通常Task作成画面として実装済み（タイトル・
   自然文の開発指示を入力し、既存`POST /api/tasks`をそのまま呼ぶ。特別なTask種別や別APIは
   使わない）。`apps/mobile/app/index.tsx`のProjectカードに「＋ Taskを追加」導線があり、
   `projectId`を渡して本画面へ遷移する。作成成功後はTask詳細画面（`/tasks/:id`）へ自動遷移する。
   導線はProject一覧のカードにあり、Project詳細画面（`projects/[id].tsx`）自体には同等の
   ボタンはまだない（機能到達は可能なため未完了条件としては扱わない）
<!-- roadmap:id=mobile-task-resume-ui state=done -->
5. [x] 再実行・追加指示UI（Mobile） — 完了。Task詳細画面に「追加指示して再開」機能を実装
   （`POST /api/tasks/:id/resume`。コミット`c90d50e`, `d184d87`）

**MVP完成宣言前の必須クリーンアップ（MVP必須5項目とは別枠。最後に実施する）:**

<!-- roadmap:id=temp-mvp-completion-policy-cleanup state=planned -->
- [ ] **`TEMP_MVP_COMPLETION_POLICY cleanup`** — MVP完成宣言の**直前**に、期限付き方針
      `TEMP_MVP_COMPLETION_POLICY`（`AGENTS.md` 0章 と `CLAUDE.md` 冒頭のポインタ段落）を
      共通指示から完全に削除し、repository全文検索で共通開発指示として残っていないことを確認し、
      削除commitをMVP completionに含める。
      **完了条件・手順の正本**: `specs/10_mvp_scope.md` 12章「TEMP_MVP_COMPLETION_POLICY cleanup」。
      **このcleanupが完了するまでMVPを「完成」と記録しない。**
      一時ポリシーの内容を恒久的なDesign Philosophy・一般開発原則へ自動転記しないこと。

      **本項目は MVP Exit Criteria である（CEO 訂正・2026-09-10）。「MVP後へ延期」ではない。**
      Exit 必須条件として維持するのは次の3点:
      1. `TEMP_MVP_COMPLETION_POLICY` の削除
      2. 関連する temporary marker / wording の cleanup
      3. **cleanup 完了確認**

      **上記とは区別すること**: 2026-09-10 に roadmap parser が本項目に対して
      「metadata が checkbox 行に続いていない」を報告している。この**整形問題そのものは
      MVP 本線を block しない**。原因は parser の
      `CHECKBOX_LINE_REGEX = /^(\s*\d+\.\s+\[)( |x)(\]\s+)(.*)$/` が**番号付き**項目
      （`1. [ ]`）を要求する一方、本項目が箇条書き（`- [ ]`）で書かれているため。

      ⚠️ ただし帰結として、**本項目は `getValidRoadmapItems()` から見えない**。
      上記3の「cleanup 完了確認」を parser ベースの自動 check に委ねると、
      本項目を見落としたまま通過し得る。MVP Exit を実施する担当は、
      **手動で確認するか、先に整形（`- [ ]` → 番号付き）を直してから自動 check を使うこと。**
      **CEO判断（2026-09-11）: M4 着手前に正規形式へ直す。**

      **同種の parser 不整合（2026-09-11 実測。いずれも MVP 本線を block しないため今回は直さない）**:
      `pnpm roadmap:check` は本項目を含め5件を報告する — `priority=high` 付き metadata 3件
      （parser の `ROADMAP_METADATA_REGEX` が `id` と `state` の2属性しか受け付けない）、
      `roadmap-generation-constraint-compliance` の `[~]` 表記1件
      （`CHECKBOX_LINE_REGEX` が `( |x)` しか受け付けない）、本項目の `- [ ]` 1件。
      **帰結**: `roadmap:sync` は validation を前提とするため実行できず、
      `docs/PROJECT_CURRENT_STATE.md` の `AUTO-GENERATED:ROADMAP_CURRENT_STATE` ブロックは
      **stale のまま**である（CI は `typecheck` / `test` のみを実行するため CI は落ちない）。
      M4 で本項目を正規形式へ直す際に、残り4件も併せて解消するか判断すること。

**セキュリティ残タスク（2026-07-29 Codexレビューで発見。MVP必須5項目とは別枠）:**

- [x] MobileがAPI tokenの`Authorization`ヘッダーを送っていない — **解消済み（2026-08-17
      Current Truth修正。当初2026-07-29の指摘時点では未実装だった）**。現在は
      `apps/mobile/lib/api.ts`の共通`apiFetch()`が保存済みtokenを読んで
      `Authorization: Bearer <token>`を付与し、Mobileの全API呼び出しがこれを経由する。
      tokenは`EXPO_PUBLIC_*`（バンドルへ埋め込まれる）ではなく`expo-secure-store`
      （iOS Keychain / Android Keystore、キー`api_token`）へ実行時に保存し、Dashboardの
      接続設定画面から保存・変更・削除できる。このため**token変更時もMobileの再ビルド・
      再配布は不要**。403行目「認証強化の要否確認」は方式の強化検討であり本項目とは別。
      **完了条件（達成）**: `API_TOKEN`を設定した状態でMobileの主要操作（Project一覧・作成・
      承認・Task詳細・resume）が通ること

**UX残タスク（2026-08-06 実機E2E中に発見。MVP必須5項目とは別枠）:**

- [ ] 承認画面のヘルプ文言「内容が分からない場合は承認せず、ChatGPT/Claudeに説明を依頼してください」
      （`apps/mobile/app/approvals.tsx:158`）に対応する実際の導線が無い — 文言のみ実装されており、
      CEOが変更内容の説明をAIへ依頼するボタン・画面は存在しない。現状はCEOが本文言に従う場合、
      アプリ外で別途AIに問い合わせる必要がある。実装するには変更内容（diff/changedFiles）を
      要約依頼として送るAPI連携が新規に必要であり、単純な文言修正では済まない。
      **完了条件**: 承認画面から変更内容の説明をAIへ依頼でき、結果が承認/却下の判断材料として
      画面内に表示されること

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
- [x] Mobile: Project詳細画面（2026-08-14確認。実装済み、`apps/mobile/app/projects/[id].tsx`。
      commit`1f71d32`）。**現状（Current Truth）**: Project詳細画面あり／`ProjectCard`タップで
      遷移可能（`index.tsx`の`onPress`→`/projects/[id]`）／name・status表示済み／Recent Jobs
      表示済み／Task進捗（status別件数）集計あり。**未実装**: Goal未表示（`Project.goal`は
      型に存在するが画面未参照）／Design Philosophy未表示（`Project.designPhilosophy`も同様）
      ／個別Task一覧なし（集計のみ）／次Task明示なし／Approval待ちの独立表示なし（「要対応Task」
      内に間接的に含まれるのみ）
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
- [ ] **正式Production起動方式の確定**（2026-08-14、Incident `inc-20260814-1d8`確認により追記）。
      **現在のTruth**: Productionは正式常駐方式として`tsx watch`（dev-mode）は使用しない
      （git pull時の意図しないauto-reloadを避けるため）。現状は暫定対応として、API/Workerとも
      watch無しの`tsx src/index.ts`直接実行で常駐している。**`build`（`tsc`）の成功は
      `Production runnable`の判定に使わない**: `apps/api`/`apps/worker`自体はbuildできても、
      workspace依存先`@ai-team/shared`が`package.json`の`main`/`types`を`./src/index.ts`のまま
      ビルド出力を持たないため、plain `node dist/index.js`は現状**成立しない**
      （`ERR_MODULE_NOT_FOUND`で起動不能）。正式Production起動方式は、API/Worker単体だけでなく
      workspace依存関係を含めた実起動確認をもって確定する（`packages/shared`側のbuild追加を
      含め、正式Production packaging時にこのgapを解消する）。旧processを停止する前に、
      新しい起動方式は可能な限りsafe/isolatedな環境で先に実起動確認しておく。
      crash時自動復旧・OS再起動後自動起動・process supervisionは上記「再起動耐性」の
      既存未解決事項のまま維持する。
      **API起動時のenvは`env -i`＋明示allowlistで与える（2026-08-18確定。同種事故が再発したため）**:
      `set -a; . .env`（.env全体のsource）でAPIを起動することを**禁止**する。これを行うと
      APIが本来持たない`CLAUDE_API_KEY`/`GEMINI_API_KEY`/`OPENAI_API_KEY`/`GITHUB_TOKEN`まで
      process envへ載り、Secret boundaryが黙って広がる。
      APIのallowlistは`PATH`/`HOME`/`NODE_ENV`/`HOST`/`PORT`/`DB_PATH`/`API_TOKEN`/
      `ADMIN_TOKEN_SHA256`/`WORKER_TOKEN_SHA256`/`OPENCODE_GO_API_KEY`のみ。
      Workerは必要credentialが異なる（`API_TOKEN`とprovider key・git設定・`TARGET_REPO_PATH`等）ため、
      **APIとWorkerのallowlistを共用・混同しない**。値は環境変数として渡し、argvへ載せない
      （`ps`露出防止）
- [ ] **Single-worker enforcement / duplicate startup prevention**（2026-08-15確認。
      `project-auto-multi-worker`＝複数Workerを安全に並列稼働させる将来機能とは別責務。
      本項目はMVPの「Workerは1インスタンスに限定する」前提が現状**強制されていない**ことへの
      対策）。
      **発生した事象**: Production上でWorkerプロセスが手動起動により**2本同時稼働**していた
      （2026-08-15確認。起動時刻・稼働commit・接続先APIとも同一で、いずれも残留processではなく
      実稼働中だった）。単一起動を強制するpidfile/lockfile/flock等のガードが存在しないため発生した。
      **実測した危険性（発生時点では実害なし。running Job 0件・pending outbox 0件のため顕在化せず）**:
      - atomic claimが未実装（`fetchQueuedJob()`はGETのみ、`running`化は別リクエスト）のため、
        両Workerが同一queued Jobを同時取得し**同一Jobの二重実行**が起こり得た
      - `recoverStaleJobs()`が起動時に全`running` Jobを無条件failedにするため、一方の再起動が
        **他方の実行中Jobを破壊**し得た
      - 両Workerが同一`outbox.db`（`job_id`がPRIMARY KEY）へ書き込むため、**衝突**し得た
      **対応**: 2026-08-15、余剰Workerプロセスツリーへ`SIGTERM`を送り正常終了させ、single Workerへ
      正常化した。Production DB・backup・APIへの変更なし
      **恒久対策として必要なもの**: single-worker enforcement / duplicate startup preventionが
      必要（今回は対策実装しない）。**正式process supervision導入（上記「再起動耐性」
      「正式Production起動方式の確定」）時に、1ユニット=1インスタンスの強制として自然に統合する
      ことを第一候補とする**。新規roadmap itemは追加せず、本項目へ統合する
- [ ] **Secret output exposureの構造的再発防止**（2026-08-14、Security Critical寄り重大Incident由来。
      `project-auto-incident-pattern-improvement`の「重大Incidentは反復を待たず即時分析対象とする」
      方針に従い、反復発生を待たずMVP後早期の改善候補へ即時昇格）。
      **発生した事象**: Secret存在確認作業中に値を含むgrepコマンドを使用し、`OPENCODE_GO_API_KEY`の
      実値がツール出力へ露出した。「Secret値を出力禁止」という既存Prompt/Rule上の注意が存在した
      にもかかわらず発生したため、**注意喚起の追記だけでは不十分というEvidence**として扱う。
      **原因候補（優先度順に検討。今回は原因分解のみで対策実装はしない）**:
      1. 既存command/helper/toolの安全化（値を返さないSecret存在確認手段の標準化）
      2. 既存Secret handling ruleの実行方法改善（ルールの記述ではなく実行経路側の改善）
      3. output redaction等の既存Safety mechanism改善（stdout/stderr中央redactionの要否は
         `project-auto-worker-trust-boundary`で既出（未実装・見送り済み）だが、対象はJob実行時の
         AI CLI出力であり、今回のような人間/AIの手動ops作業時のtool出力は別スコープ）
      4. Secret確認用の安全な標準手順の整備
      5. 上記で不十分な場合のみ新機構検討（新しいSecurity Gate/Reviewerを今回の1件だけを理由に
         即追加しない）
      **Acceptance Criteria候補（MVP後早期に対策実装する際の完了条件）**:
      - Secretの存在確認で値が出力されない
      - env確認で値が出力されない
      - process env確認で値が出力されない
      - 誤って一般的なcommandを使用した場合のblast radiusを可能な限り小さくする
      - Secretを必要とする正常運用を過剰に阻害しない
      - AI作業全体へ過剰なreview/token負荷を追加しない
      - 実際のSecretを使わないE2Eで再発防止を確認する
      **今回は対策実装しない**。新規roadmap itemも追加せず、本項目（VPS常駐運用化）へ統合する

### Execution Runtime Boundary（AIteamOSの責務境界と、実行基盤のHarness委譲候補）

**位置づけ:** 2026-09のP1（stuck-running-Job recovery）設計・実装を通じて、「AIteamOSが自作すべき責務」と
「将来的に外部AI Harnessへ委譲した方が合理的な低レベル実行責務」の境界が実測により明確になったため、
会話上の知見で終わらせず設計方針として記録する。**本節はRoadmap記録のみであり、Harness導入・OpenHands導入・
Adapter実装を開始する指示ではない**。実装着手はHigh-priority Repairが一段落した後に別途判断する。

既存の`Worker Registry / Worker Adapter Framework`（本ファイル「将来アーキテクチャ移行」節）は
**「どのWorker（LLM/Agent/Tool/Script）に仕事を振るか」というRouting責務**の抽象化であり、本節の
**「Agentプロセスをどの実行基盤で安全に動かし、確実に終了・復旧させるか」というExecution Runtime責務**
とは別レイヤーである。両者を混同しない。

**AIteamOS側に残す責務（＝長期的な競争力の所在）**
- CEO / Mobile UI
- Claude PL（判断・委任・統合）
- Goal / Roadmap / Task orchestration
- Approval / Risk Gate
- Finding / Repair management
- AI / model routing
- Review policy
- Project state / business workflow
- 自己改善・運用判断

**将来的にHarnessへ委譲候補とする責務（＝独自実装を競争力と位置付けない）**
- agent process execution
- process-tree containment / termination
- sandbox / VM isolation
- workspace isolation
- command timeout / cancellation
- child-process cleanup
- Git execution
- crash recovery at execution-runtime level
- execution artifacts / logs
- agent runtime resume
- low-level filesystem / network permissions

## P1 stuck-running-Job recovery — CLOSED（2026-09-08）

**P1 は Phase 1 / Phase 2 / Phase 3 すべて完了。** 以下はその完了記録であり、
ここに列挙した「別扱いで open のまま維持する項目」は P1 の未完を意味しない。

### Phase 1 — crash-safe startup recovery（CLOSED）
workspace baseline の durable 保存 / quarantine と ownership safety /
startup reconciliation。master 反映・production deploy 済み。

Operational E2E で、正規 workflow が dirty workspace を継承する2経路
（`implement:<jobId>:review` / `review:<jobId>:git-commit`）が normal Job 扱いされ
quarantine していた admission classification の漏れを2件発見し、
どちらも exact-shape 判定として修正・test・review・deploy 済み。
production 上で正常 claim を確認済みのため、同一 root cause として CLOSED / VERIFIED。

### Phase 2 — async per-job cgroup containment（CLOSED）
per-job cgroup 作成 / 配置 / 非同期実行 / timeout・kill・drain /
子孫 cleanup / 実行後 workspace reconciliation / ownership 解放の安全性。
master 反映・production deploy 済み。production 実動確認で、直接の子が exit 0 でも
`setsid` 子孫が残る場合に `outcome:'killed'` / `killedDescendants:true` /
drain 22ms / cgroup 削除 を実測。deploy canary 全 PASS。

### Phase 3 — 残 Finding 3件（CLOSED）
- **R5-N1** 通知の再送・fallback: merged / deployed / operational check PASS
- **DB-007** WatchdogEvent の durable dedup: merged / migration 適用済み / operational check PASS
  （dedup key は `(job_id, started_at)`。復旧後の正当な再 stall を潰さないため job_id 単独にしない）
- **MOB-001** Mobile の stalled / quarantine 可視化: merged（#113 / #116 / #117）

MOB-001 は CEO 実機確認で UX defect を検出し #117 で修正。
別 provider による bounded UI/UX independent review は **APPROVE**（6観点すべて RESOLVED）。

**UNVERIFIED — no naturally quarantined production Job available**:
修正版 quarantine UI の再実機確認だけは、確認時点で自然発生した quarantined Job が
0件のため未実施。**P1 completion の blocker とはしない**（人工的な quarantine を
production に作らない方針のため）。将来自然な quarantine が発生した時点で
operational observation として確認する。

**CEO 実機再確認（2026-09-09〜10）— MOB-001 の残 2 項目**:

- **approval waiting**: `UNVERIFIED — no naturally pending approval available`。
  確認時点で自然発生した approval 待ち Job が 0 件のため未実施。quarantine UI と同じ扱いで
  P1 completion の blocker とはしない（人工的な approval を production に作らない方針）。

- **failure explanation / AI question**: `PASS — functional`（2026-09-10 CEO 実機確認）。
  当初は `FAIL — API refused before the AI call` として記録したが、**#130 で修正し
  production 反映後に実経路で PASS を確認**した。実経路
  Mobile → API → failure explanation 生成 → AI response → Mobile 表示 が成立。

  **実測 evidence**: target Job `ecfa0132-cbb0-4293-baf9-0c25aa93c593` の
  `failure_explanation_json` が **NULL → 生成済み**（`classification=configuration`、
  `likelyCause` / `impact` / `recommendedNextAction` すべて充足、
  `generatedAt` 2026-09-10T09:24:12Z）。DB 全体の生成済み件数も **0 → 1** で、
  その1件が対象 Job 本体であることを帰属レベルで確認済み（候補 Task は14件あるため、
  DB 全体件数だけでは帰属を示せない）。「AIに質問する」も同 Task で回答本文を実機確認。

  説明品質（非エンジニア向けの分かりやすさ・technical vocabulary の多さ・
  CEO と AI 開発チームの責任分離・フォーマット固定）の課題は **functional blocker とせず**、
  既存 item `failure-explanation-pregeneration`（**post-MVP**）へ統合済み。
  MVP 完成まで説明品質改善を理由に本線を止めない（CEO 判断・2026-09-10）。

  以下は当初 FAIL の原因記録として残す。
  「実行失敗の説明」「AIに質問する」の両方が AI 障害の文言を返していたが、production log で
  **AI が一度も呼ばれていなかった**ことが判明した。CEO の 3 リクエスト（Task `11066c6f`）は
  いずれも HTTP 200 / 4.7ms・44.7ms・5.5ms で完了し `level:40` warn は 0 件。provider を実コードで
  直接叩いた実測は 1 回 66〜74 秒なので、5ms は AI 呼び出し前の早期 return を意味する。

  原因は Mobile と API の表示述語の乖離。Mobile (`[id].tsx:725`) は
  `failed || blocked || task.blocked`、API (`tasks.ts:192`) は `failed || task.blocked` で、
  `blocked` が欠けていた。**Job が blocked でも Task は `pending` に留まる**ため、
  この状態の Task（production 上 **14 件**。当初 3 件と報告したが直近25件しか見ておらず、
  全件走査で14件と判明）では
  Mobile が説明セクションを表示するのに API が「対象なし」を返していた。

  元実装 `4ad0fb6` では両者は一致していた。`d8bcf0c`（#124）で **Mobile 側だけを広げた
  regression** であり、MOB-001 自身の責務内。既存 AI provider / router の障害ではない
  （quota・auth・timeout・parse failure・missing record のいずれでもない）。

  修正は共通経路 1 点。API 側で既存 `isTaskFailureJob()` を `shouldExplain` にも共有させ、
  両サイトが二度と別々に書かれないようにした。あわせて Mobile が `result.error` /
  `answer.error` をそのまま表示するようにし、AI 以外の原因（対象 Job なし・通信エラー）を
  AI 障害として誤報しないようにした。この誤報が診断を困難にしていた二次欠陥である。

**派生 Finding（本 PR では修正しない・別扱いで open）**:
`cheapAiClient` の実測レイテンシが 1 回 66〜74 秒で、`CHEAP_AI_CONFIG.timeoutMs = 60_000` を
超えているのに 2 回の probe が成功した（`spawn({ timeout })` が子を終了させていない）。
述語修正後は実際に AI 生成が走るようになるため表面化する。60s 設定値と Cloudflare の
100s 上限の両方に近いことも含め、`containment-success-path-observability` とは別の
`cheap-ai-latency-and-timeout-contract` として扱う。

### P1 完了時点の production 実測
API health 200 / API・Worker とも active・NRestarts=0 / production tree clean /
`/workspace/target` clean / running Job 0 / quarantined Job 0 /
DB `integrity_check` ok / Worker エラーログ 0。

### P1 とは分離して open のまま維持する項目（P1 の未完ではない）
これらは P1 の実装で顕在化した、または隣接する別責務であり、重複 Finding は作らない。

- shared-workspace leakage / cleanup-deadlock（本節の該当項目へ集約済み）
- worktree isolation（`project-auto-worker-trust-boundary`）
- adversarial cgroup escape（`containment-adversarial-escape-threat-model`）
- `Delegate=yes` hardening（`worker-cgroup-delegation-contract`）
- containment success path の可観測性（`containment-success-path-observability`）
- Meta Reviewer robustness（`meta-review-structured-output-robustness`）
- background-task supervision
- legacy `API_TOKEN` → ADMIN / WORKER split credential migration
- cheap AI（説明・質問経路）の latency と timeout 契約（`cheap-ai-latency-and-timeout-contract`）


### 次に着手すべき root-cause cluster（P1 完了時点の handoff・2026-09-08）

**選定: shared workspace の dirty leakage → 恒久 quarantine（cleanup-deadlock）→ worktree isolation**

**なぜ次か**: open 項目の中で、**実際に production の workflow を止め、
CEO 承認の手動介入を要した唯一のクラスタ**であるため。2026-09-08 の Operational E2E で
2回実測しており、再現性がある（別 Project でも再発）。他の open 項目は
hardening（`Delegate=yes`・containment observability）、対象外と判断済みの threat model
（adversarial escape）、あるいは別系統（Meta Reviewer robustness）であり、
いずれも現時点で production を停止させていない。

**既存実装との関係**:
- P1 Phase 1 がこの問題を**可視化**した。以前は「前 attempt の未 commit 変更が
  次 Job へ静かに混入する」汚染だったものが、baseline admission により
  `workspace_baseline_failure` quarantine として**停止**するようになった。
  Phase 1 が原因ではなく、既存の欠陥を検出できるようにしただけである
- P1 Phase 2（containment）はこの問題に触れていない。cgroup はプロセスを回収するが、
  ファイルシステム上に残った変更は回収しない
- **clearance の known-good 要件を緩めて解決してはならない。** それは
  「安全と証明できない限り所有権を解放しない」という hard invariant そのもの。
  不足しているのは安全性チェックではなく、**dirty から正規に known-good へ戻す経路**

**ledger 上の注意（着手前に解消すべき）**: この root cause を扱う
`project-auto-worker-trust-boundary` は `state=done` になっている。
これは「設計項目（実装を伴わない）」として完了した経緯によるもので、
worktree isolation の**実装は未着手**。つまり現状、この cluster には
**open な owner 項目が無い**。新しい重複 Finding を作るのではなく、
この項目の state を実態に合わせるか、実装用の後継項目を1件立てるかを先に決めること。

**最初に行う read-only 調査（実装前）**:
1. 残った変更の**帰属**を既存情報だけで特定できるか。`workspace_baseline` /
   `buildWorktreeManifest` / `fingerprintWorktreeEntries` / repair 情報から
   「どの source Job が作った変更か」を判定できるか
2. `revertBlockedJobChanges()` の適用条件（現在は File Change Guard 違反時のみ、
   かつ manifest 由来の変更のみ）を、untracked を含む一般的な cleanup へ
   安全に広げられるか。広げられない場合は何が不足しているか
3. worktree isolation（1 Job = 1 worktree）を既存 `resumeBlockedTask()` の
   「新 Job 行を作る」形へ載せられるか。roadmap 424-470 行の既存設計案が
   現在の Phase 1/2 実装（baseline / quarantine / containment）と整合するか
4. 帰属不能な変更が残った場合の扱い。**自動削除はしない**方針を維持したまま、
   quarantine 維持 + PL エスカレーションで運用が回るか

**着手時の禁止事項**: 曖昧な変更の自動削除 / CEO への Git 判断の要求 /
clearance 条件の緩和 / 新しい cleanup subsystem の先行実装。


**現行P1実装の位置づけ:** P1 Phase 1（workspace baseline・quarantine・startup reconciliation）と
P1 Phase 2（async per-job cgroup containment）は**いずれも完了**している
（Phase 2: 2026-09-08、master `5825433`、production deploy 済み）。これらは
**現在のAIteamOSを安全に運用するために必要なので継続する**。ただしこれらは
上記「委譲候補」に該当する低レベルexecution機能であり、**長期的なAIteamOS独自競争力とは位置付けず、
将来的なHarness置換候補として扱う**。

**Phase 2 完了時に実測した挙動（Harness評価時の比較基準として使える）:** 直接の子が exit 0 でも
`setsid` した子孫が残っていれば success 扱いにせず containment kill する / recursive `populated=0`
を確認する / cgroup cleanup を確認する / そこまで成功して初めて workspace reconciliation へ進み、
reconciliation 成功後にのみ Job を terminalize する。production 実動確認では
`outcome:'killed'` / `killedDescendants:true` / drain 22ms / cgroup 削除済み を実測し、
deploy canary は全 PASS だった。

<!-- roadmap:id=execution-runtime-harness-bakeoff state=planned -->
1. [ ] **Harness Bake-off / Execution Runtime Evaluation** — High-priority Recovery修正が一段落した後、
      **新規機能を増やす前に**実施する評価項目。第一候補としてOpenHands等のvendor-neutral /
      self-host可能なHarnessを評価するが、**特定ベンダー前提にはしない**。

      **評価方法の必須条件:** 機能表・ドキュメントの比較だけで判断しない。**AIteamOSで実際に発生した
      障害を再現して比較する**こと。最低限、以下を再現・比較する:
      - agent強制終了
      - descendant process残存（`setsid`等でprocess groupを抜けるケースを含む）
      - dirty workspace
      - concurrent agent
      - Worker / runtime crash
      - Git操作の途中停止（`index.lock` / sequencer等の中途状態）
      - timeout / cancellation
      - resume / recovery
      - workspace contamination防止
      - APIからの自動制御
      - 複数AI / model利用
      - self-host / vendor lock-in

      **移行判断基準:** Harnessが「安全性 / 復旧性 / 保守性 / 実装量 / vendor-neutrality / API統合性」
      で**明確に優れる**と確認できた場合にのみ、
      `AIteamOS Job Runner / execution runtime → Harness Adapter` への**段階的置換**を検討する。
      **AIteamOS全体を置き換える前提にはしない**。上位OrchestrationはAIteamOSに残し、
      **低レベルexecution layerだけを差し替え可能にする**方向を優先する。

      **今回実装しないもの（明記）:** Harness導入 / OpenHands導入 / Harness Adapter実装 /
      既存Job Runnerの置換 / 新しいsandbox基盤の構築。本項目はRoadmapへの将来方針と評価条件の
      記録のみであり、着手可否は既存High-priority Repair完了後に判断する。

<!-- roadmap:id=containment-adversarial-escape-threat-model state=planned -->
2. [ ] **Containment adversarial escape（cgroup migration / git external helper）— security Finding** —
      2026-09-07、P1 Phase 2（async per-job cgroup containment）のCodex独立設計レビューで指摘。
      **Phase 2の対象外としてCEO判断済み**であり、本項目は記録のみ。

      **Phase 2が守る範囲（CEO確定のthreat model）**: trusted Worker / trusted execution tools /
      accidental runaway・timeout・crash・daemonized descendant。
      PR-Cで確定した Worker trust boundary をそのまま維持する。

      **本項目が扱う、Phase 2の対象外**:
      - **cgroup migration**: payload が per-job cgroup から自分のPIDを親/兄弟の `cgroup.procs` へ
        書き込んで**意図的に脱出**するケース。`Delegate=yes` は delegated subtree 全体からの脱出は
        防ぐが、subtree **内**の移動を本質的に禁じるものではない。`cgroup.kill` は kill 開始前に
        移動し終えたプロセスには届かない。**本番で実際に移動可能かは UNVERIFIED**（未実測）
      - **git external helper 経由の脱出**: `core.fsmonitor` hook や clean/process filter は
        git が外部プロセスを fork する正規の仕組みであり、封じ込め対象外で実行される
        `git status` / `git add` から起動され得る。repository-local な git 設定を無害化していない限り、
        daemon 化した helper が worktree を変更し続け得る

      **なぜPhase 2に入れないか**: いずれも「payload または trusted tool 自身が意図的に脱出する」
      前提を必要とし、現行の trust boundary とは別の threat model に属する。防御するには
      non-migration enforcement と全 git 呼び出しの hardened invocation が要り、
      **新しい sandbox / security architecture の導入**になる。Phase 2 の目的（事故で残った
      プロセスの確実な回収）とは責務が異なる。

      **着手する場合の前提（実装ではなく判断材料）**: まず本番で「payload が親/兄弟 cgroup へ
      migrate できるか」を実測すること。移動が実際に拒否されるなら、この経路の優先度は下がる。
      関連: 上記1 Harness Bake-off（低レベル execution layer ごと差し替える選択肢）。

      **2026-09-08 production probe（部分的 evidence。UNVERIFIED は維持する）**:
      Phase 2 deploy 後、本番 VPS で SSH session から Worker の cgroup へ自プロセスを移動しようと
      `echo $$ > .../ai-team-worker.service/cgroup.procs` を実行したところ、**EACCES で拒否された**。
      cgroup v2 は移動元・移動先の共通祖先に対する書き込み権限も要求するため、
      delegated subtree の**外側にいるプロセス**は Worker cgroup へ入れない。

      ただしこれは以下を**区別**して読むこと:
      - **測定できたこと**: 外部プロセスからの migration は拒否される
      - **測定していないこと**: trusted Worker subtree の**内部**で動く payload（＝Job の子孫。
        既に Worker cgroup 配下にいるため共通祖先条件を満たし得る）が、意図的に親/兄弟 cgroup へ
        escape できるかどうか。**こちらは未検証のまま**

      したがって本 Finding の `UNVERIFIED` は取り下げない。「payload が絶対に escape できない」
      ことを示した測定ではない。内部からの escape 可否を実測するまで、この項目の前提は変わらない。

      **今回実装しないもの（明記）**: non-migration enforcement / git設定のhardening /
      新sandbox基盤 / attestation。本項目はFinding記録のみ。

<!-- roadmap:id=worker-cgroup-delegation-contract state=planned -->
3. [ ] **Worker unit の cgroup delegation を明示契約にする（systemd contract hardening・低〜中優先）** —
      2026-09-08、P1 Phase 2 完了時に記録。**今すぐ unit file を変更しない。**

      **現状（実測）**: production の `ai-team-worker.service` は `Delegate=no` である。
      それでも per-job cgroup の作成・`cgroup.kill`・`cgroup.events`・`rmdir` はすべて動作する。
      理由は、`user@.service` 配下の subtree が既にユーザーへ delegate されており、
      Worker unit の cgroup ディレクトリが `ai-team` 所有で書き込み可能だからである。
      Phase 2 の production 実動確認（`Delegate=no` のまま）は成功しており、
      **`Delegate=yes` は Phase 2 の完了条件ではない**。

      **それでも記録する理由**: 現在の動作は「user service subtree delegation という
      *周辺の構成* にたまたま依存して成立している」状態であり、Worker が per-job cgroup を
      作れる権限が **unit 自身の契約として明示されていない**。systemd のバージョン更新、
      unit の slice 変更、user session 構成の変更、コンテナ化などで、
      **予告なく作れなくなり得る**。その場合 containment は fail-closed で
      `unavailable` を返し、containment 必須 Job が実行されなくなる（安全側ではあるが停止する）。

      目的は「今たまたま動く」ではなく「**将来の systemd / config 変更後も per-job cgroup 作成権限が
      明示的に保証される**」ことである。

      **着手時にやること（実装ではなく再確認から始める）**:
      - その時点の production unit と systemd delegation 構成を**再確認**する
        （`systemctl --user show ai-team-worker.service -p Delegate`、
        cgroup ディレクトリの所有者・書き込み可否、`user@.service` 側の delegation）
      - その上で `Delegate=yes` の追加が**本当に必要か**を判断する。
        既に別の形で明示保証されているなら追加しない
      - 追加する場合も `KillMode=control-group` は維持し、controller は有効化しない
      - 変更後は containment の実動確認（direct child exit 0 + 生存 descendant の kill、
        `populated=0`、cgroup 削除）をやり直す

      **今回実装しないもの（明記）**: unit file の変更 / delegation 構成の変更 /
      新しい supervision 方式の導入。本項目は記録のみ。

<!-- roadmap:id=containment-success-path-observability state=planned -->
4. [ ] **Containment success path の可観測性（低優先 hardening）** — 2026-09-08、P1 Phase 1/2
      Operational E2E の完走後に記録。**Phase 1/2 を reopen する必要は無い。動作は正常。**

      **現状**: 失敗経路（drain_timeout / cleanup_failed / kill_failed 等）は quarantine と
      CRITICAL alert として明確に残るが、**成功経路**の
      `per-job cgroup 作成 → recursive populated=0 → cgroup 削除` は通常ログから追いにくい。
      そのため「containment が実際に効いている」ことを、事後に運用ログだけで確認しづらい。

      Phase 2 の実装自体は必要な情報を既に持っている（`ContainedResult` に
      `outcome` / `killedDescendants` / `drainMs` / `cgroupPath` があり、
      成功時に `outcome:'killed'` と `killedDescendants:true` を返す実測も取れている）。
      不足しているのは **その情報を通常運用ログへ出していない**ことだけ。

      **着手時の方針**: 新しい telemetry 基盤・新しいログ収集系は作らない。既存の
      `console.log` / journalctl 経路へ、成功時も1行の構造化サマリ（jobId / attempt /
      outcome / drainMs / killedDescendants）を出す程度に留める。
      ログ量が増えるため、Job あたり1行以内に抑えること。

      **今回実装しないもの（明記）**: metrics backend / トレーシング / 新しいログ基盤。
      本項目は記録のみ。


<!-- roadmap:id=failure-explanation-pregeneration state=planned -->
5. [ ] **Failure Explanation の事前生成と CEO 向け構造化（次段改善）— `post-MVP`** —
      2026-09-10 登録。**本項目は明示的に post-MVP。MVP 完成まで説明品質改善を理由に
      本線を止めない**（CEO 判断・2026-09-10）。
      #130（predicate regression 修正）とは**別責務**。#130 / Phase 3 closure を先に完了する。

      **2026-09-10 CEO 実機確認の結果**: 技術的な実経路
      （Mobile → API → failure explanation 生成 → AI response → Mobile 表示）は**成立**し、
      Phase 3 の **functional PASS** として記録済み。以下は品質課題であり
      **functional blocker として扱わない**。MVP 前の追加修正は行わない。

      同確認で挙がった UX / quality 課題（**新規 item を作らず本項目へ統合**）:
      - 非エンジニア向けとして分かりにくい
      - technical vocabulary が多い
      - 技術的確認を `recommendedNextAction` として CEO へ提示する場合がある
      - **CEO がすべきこと / AI 開発チームがすべきことの責任分離が弱い**
      - 説明フォーマットが十分に固定されていない

      **CEO 向け固定フォーマット（post-MVP で実装する形）**: 少なくとも次の5問に
      一貫して答える形へ固定する。technical details は secondary 表示へ分離する。
      1. 何が起きた？
      2. なぜ止まった？
      3. 今どうなっている？
      4. 次に何が行われる？
      5. CEO がすることは？

      あわせて、**AI 側で解決可能な技術作業を CEO へ要求しない**こと、
      **CEO 判断が必要な場合のみ**具体的な質問を提示することを満たす。


      **Goal**: Job が failed / blocked になった時点でバックグラウンドに説明を生成・レビュー・
      保存し、CEO が Mobile を開いた時には**原則完成済みの説明が即表示**される状態にする。
      現状は Mobile を開いてから on-demand 生成が走り、cheap explainer の実測が
      1回 66〜74 秒のため待たされる（`POST /api/tasks/:id/failure-explanation`）。

      **着手前に再利用可否を確認すること（新規 framework を作らない）**:
      調査済みの再利用候補を以下に記す。作り直しの前にこれらを潰すこと。

      - **`TaskFailureFacts.whatHappened`** — 「何が起きたか」は**既にコード構築の事実として存在**。
        AI に作らせない
      - **technical details の分離も既に存在** — `facts`（`stderrExcerpt` / `stdoutExcerpt` /
        `exitCode` / `changedFiles` / `guardResult`）と `aiAnalysis` は型で分かれており、
        Mobile も `TaskFailureFactsView` と AI 分析ボックスを別描画している。新設不要
      - **`failure_explanation_json`（`PersistedTaskFailureExplanationV1`）** — 永続化・
        `contentHash` による invalidation・`schemaVersion` / `inputVersion` は既にある。
        事前生成の保存先はこれ。新テーブルを作らない
      - **`cheapAiClient` / `requestText`** — provider 呼び出し経路。`opencode-go` / `mimo-v2.5`、
        隔離 HOME、`permission:deny`。新しい client を作らない
      - **`supervised_runs`（#126 / #128、2026-09-09 merged）** — 「workflow progression を
        block し得る asynchronous / background operation」の共通 run state。
        `(kind, subject_id)` の active unique index が**二重生成を防ぎ**、`claim_token` /
        startup recovery / stall sweep も設計済み。**有力な再利用候補**だが、
        **本 Roadmap では新用途への利用を絶対条件にしない**（CEO 判断・2026-09-10）。

        着手時に、`background execution` / `deduplication` / `recovery` / `terminal state` /
        `subject ownership` の各責務が Failure Explanation 生成にも**自然に適合するか**を
        確認すること。適合するなら**新しい queue / daemon を作らず再利用**する。
        不自然な責務拡張になる場合にのみ別案を検討する。

        なお既存 D-1（CEO 判断・2026-09-08）は初期接続 `kind` を `ai_delegation` と
        `expo_restart` に限定しているが、これは **rollout 順序の決定であって contract の
        scope を狭める決定ではない**と同項に明記されている。新 `kind` の追加自体は
        schema 変更を要求しない設計。
      - **Worker Outbox** — at-least-once が必要な場合の既存経路
      - **independent review**: 既存 designReview coordinator と `reviewSeparation.ts`
        （同一 vendor / 未知 vendor を fail-closed で弾く provider 分離アサーション）。
        新しい review framework を作らない
      - **bounded regeneration**: まず Failure Explanation 自身の既存経路に
        regeneration / repair があるかを確認する。無い場合の**形の参考**として
        `priorAttemptFeedback` + `ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS`（Roadmap generator
        固有）があるが、**同じ機構への依存は要求しない**

      **既存 schema の gap 分析（実測）**: CEO が求める6点のうち、既存 field で賄えるものは
      再利用し、不足分のみ最小追加する。`TaskFailureAiAnalysis` は現在
      `classification` / `likelyCause` / `impact` / `recommendedNextAction` の4 field。

      | CEO が知りたいこと | 既存で賄えるか |
      |---|---|
      | 何が起きたか | ✅ `facts.whatHappened`（コード構築） |
      | なぜ起きたか | ✅ `aiAnalysis.likelyCause` |
      | 現在どういう状態か | ✅ `aiAnalysis.impact` + `facts.taskStatus` / `facts.jobStatus` |
      | 次に**何が行われるか**（誰が） | ❌ 不足。`recommendedNextAction` は「すべきこと」で、実行主体が無い |
      | CEO の操作が必要か | ❌ 不足（真偽値が無い） |
      | 何を判断してほしいか | ❌ 不足（CEO 判断が要る時の具体的な問い） |

      → 最小追加は3項目。ただし**「次に何が行われるか」を AI に推測させない**こと。
      復旧 actor が実在するかは `supervised_runs.supervisor` から**導出**する。
      これは MOB-001 で確定した「実在する recovery actor が無い限り『自動復旧中』と
      表示しない」という原則そのもの（同じ制約が supervised_runs schema の C-9 コメントにもある）。

      **Pre-generation の制約**:
      - Job の failed / blocked 確定を **AI 生成完了待ちにしない**
      - 説明生成の失敗が Job lifecycle・workspace ownership を壊さないこと
        （P1 Phase 1/2 の ownership 不変条件を侵さない）
      - Mobile からの on-demand 生成は**未生成時の fallback として残す**

      **Prompt contract**: 確認済みの Job / Task / failure facts のみを入力し、入力に無い原因を
      推測しない／原因不明なら不明と明記／非エンジニア向け日本語／Git・worktree・process 等の
      専門語は平易に翻訳／AI 側で処理可能な技術問題を CEO へ丸投げしない／CEO 判断が必要な時
      だけ具体的な問いを出す。自由作文に依存せず既存 schema による structured output を優先。
      既存 system prompt（`EXPLANATION_SYSTEM_PROMPT`）には未信頼データ扱い・
      blocked を失敗と断定しない等が既にあるので、置き換えず**追記で拡張**する。

      **Independent explanation review**: 生成担当とは別 provider / model による bounded review。
      観点は factual correctness / unsupported inference が無い / 非エンジニア CEO が理解できる /
      next action が明確 / CEO action required の真偽が正しい / technical repair を CEO へ
      不必要に要求していない / 不確実な原因を断定していない。
      FAIL 時は review feedback を使った**最大1回程度の bounded regeneration**。

      ⚠️ **blind retry しないこと。** `fix/roadmap-parse-failure-retry` の review で実測した
      同種の欠陥を繰り返さない: そこでは `catch` が無条件で全 error を regeneration へ流し、
      provider quota / auth / CLI 実行失敗 / infra まで内容 feedback 付きで再試行していた。
      **retry 可否は「出力内容の失敗」か「provider / infra の失敗」かの構造境界で決める。**
      分類には既存 `classifyFailure`（`quota` / `transient` / `auth_or_config` / `unknown`）を
      使い、新しい classifier を作らない。prompt / log へ出す診断は既存 `sanitizeMessage` を
      通し、raw stderr・巨大 stack trace・secret を混ぜない。
      **reviewer 自体の失敗で元 Job を壊さないこと。**

      **Mobile**: 生成済み analysis を優先表示。生成中は事実どおり「説明を作成中」等を表示して
      よいが、**生成 actor が動いていない場合に「作成中」と表示しない**（MOB-001 と同じ honesty
      原則）。生成失敗時は **AI 障害とその他の取得失敗を区別**する（#130 で入れた
      `result.error` をそのまま出す方針を維持し、固定文言へ戻さない）。

      **Acceptance（実入口で確認する）**:
      `failed / blocked` → **Mobile を開かずに** explanation generation が始まる →
      independent review → persistence → Mobile を開く → **reviewed explanation が即座に出る**。

      さらに次の3ケースで CEO 向け説明が正しく変わることを pin する:
      1. technical failure / CEO action 不要
      2. Goal・spec decision / CEO action 必要
      3. cause uncertain

      **Model routing（CEO 指定・2026-09-10）**: 生成担当と review 担当を**分離**する。
      同一 provider / model へ固定しないことを最優先とする。

      | 役割 | 第一候補 | 実測した既存資産 |
      |---|---|---|
      | Generator | 既存 `cheap_explainer` | `opencode-go` / `mimo-v2.5`（`cheapAiClient.ts` の `CHEAP_AI_CONFIG`） |
      | Reviewer | 既存 Copilot 統合の軽量 model | `DEFAULT_COPILOT_META_REVIEW_MODEL = 'mai-code-1.1-flash'`（`copilotRouter.ts`） |

      OpenCode の別 model を Reviewer に使うこと自体は禁止しないが、**通常系では provider
      diversity を優先し Copilot を Reviewer 第一候補**とする。分離の強制には既存
      `packages/shared/src/reviewSeparation.ts`（同一 vendor / 未知 vendor を fail-closed で
      弾く）を再利用し、新しい分離機構を作らない。

      ⚠️ `copilotRouter.ts` / `copilotAdapter.ts` / `geminiRouter.ts` はいずれも
      **CONTROL REPOSITORY（AI 編集禁止）**。**import して使うだけ**にし、編集しない。

      **Generator fallback（CEO 裁定・2026-09-10 確定）**: 現在 `cheap_explainer` には
      **provider fallback が存在しない**（`requestText` は key 不在で throw、
      `runOpenCodeCli` は失敗でそのまま throw）。既存 router / provider 統合の範囲で
      最小限の fallback を用意する。

      **既存 `metaReviewFallbackRouter` の fail-closed 方針を優先する。**
      同 router の `COPILOT_ELIGIBLE_FAILURE_CLASSES = {quota, transient}` と同じ境界を採り、
      既存挙動を変えない。

      | 既存分類 | fallback するか |
      |---|---|
      | `quota` | ✅ する |
      | `transient`（一時的な provider unavailable） | ✅ する |
      | `auth_or_config` | ❌ **しない**。設定不備を fallback で隠さない |
      | `unknown` | ❌ **しない**（既存分類で安全に fallback 可能と証明できない限り） |
      | input / 対象 Job 不備 | ❌ しない。provider failure ではない |

      - **schema / parse / structured-output failure は provider failure と区別する。**
        **provider fallback では処理しない。** 着手時に Failure Explanation の既存経路に
        bounded regeneration / repair があるかを確認し、あれば再利用する。無ければ
        **同一 Generator へ validation feedback を返す最大1回程度の bounded regeneration**を
        最小実装として検討する。Roadmap generator 固有の `priorAttemptFeedback` へ
        依存することは要求しない（形として参考にするだけ）
      - 判定は既存の構造境界（出力内容の失敗か、実行経路の失敗か）で行い、分類には既存
        `classifyFailure` を使う。**新しい error classifier を追加しない**
      - fallback 先は **既存 Codex 統合の軽量構成**。新しい汎用 model router を作らない
      - **通常時に Codex を消費しない**。OpenCode が上表の対象クラスで失敗した時のみ発火する

      ⚠️ **VPS 制約（実測済み・2026-09-07）**: この VPS では Codex の bubblewrap sandbox が
      動かず、**Codex は shell command を一切実行できない**。ただし prompt → text の
      単純呼び出しにはこの制約は効かない（既存 Codex independent review が成立しているのと同じ理由）。
      Generator fallback は repo 探索を要求しない使い方に留めること。

      **Reviewer fallback**: Copilot が利用不能なら既存 OpenCode の**別 model**で review 可能か
      検討する。ただし **Generator と Reviewer が同一 model にならないこと**（`reviewSeparation`
      で強制）。

      - **Reviewer failure は元 Job lifecycle を壊さない**
      - 説明生成済みだが review 未完了の場合は「**review 待ち**」として残し、後から再試行可能に
        する。`supervised_runs` の run state（`running` / `stalled` / `succeeded` / `failed` /
        `timed_out`）と `(kind, subject_id)` active unique index を使えば、再試行の二重起票を
        防ぎつつ後追いできる
      - **blind retry は禁止**。再試行は失敗分類に基づいて行う

      **今回実装しないもの（明記）**: 新しい AI framework / reviewer framework / queue /
      汎用 model router、
      新しい provider、新しい logging 基盤。本項目は登録のみ。

      **隣接する別項目（統合しない）**: cheap explainer の latency と timeout 契約
      （`spawn({ timeout })` が 60s で子を終了させていない実測。#122 に記録）は
      **別責務**。本項目は「いつ生成するか」、あちらは「1回の生成の時間契約」。

<!-- roadmap:id=worker-jobs-401-anomaly state=planned -->
6. [ ] **Worker 自身から `GET /api/jobs` へ 401 が継続している（原因未特定・記録段階）** —
      2026-09-08、Phase 1/2 operational E2E の観測中に発見。E2E は阻害していないため
      **記録と原因特定まで**とし、P1 regression 修正を優先した。

      **実測できたこと**:
      - **発生元は Worker プロセス自身**。`ss -tnp` で `:3000` へ接続しているのは
        Worker(pid) と API(pid) のみ。外部クライアントは存在しない
      - **401 になるのは `GET /api/jobs?taskId=...` だけ**。同一 Worker からの
        `/api/projects`・`/api/tasks`・他の `/api/jobs` 呼び出しは 200 を返している
        （観測窓: 200 が 7,291 件に対し 401 が 627 件、直近2分でも 961:81）
      - **周期は 1〜6 秒**（4〜6秒が最頻）。Worker の `POLL_INTERVAL_MS = 5000` と一致し、
        Watchdog の 30 秒周期とは**一致しない**
      - 401 対象の taskId は **paused / archived Project に属する Task**。
        ところが poll loop（`index.ts` の `fetchQueuedJob`）は
        `project.status !== 'running'` を skip するため、本来これらを問い合わせないはずである
      - Worker / API を再起動しても継続する。Phase 2 containment とは無関係で、
        **Phase 2 以前から存在する**（containment 経路を通らない読み取り専用 GET）
      - 現時点で**機能影響は観測されていない**。E2E は完走し、Job claim・
        workspace_baseline 保存・containment・terminalize はすべて成功した

      **未特定（この項目で解くべきこと）**:
      1. **どの call site が出しているか。** poll loop は running Project しか見ないのに、
         401 の taskId は non-running Project のもので、周期は poll loop と一致する。
         この矛盾が本件の核心。候補は `watchdog.ts:checkRunningJobs`（Project status で
         絞らず全 Project を走査する唯一の経路。ただし周期は 30 秒）、
         `jobStateManager.ts:recoverStaleJobs`（同じく全 Project 走査。既定引数
         `headers = {}` を持つが、`index.ts:607` の呼び出しでは認証ヘッダを渡している）、
         および未特定の第三の経路
      2. **auth header 欠落か、誤 credential か。** 同一プロセス・同一ヘッダで
         `/api/projects` が 200 を返している以上、単純なヘッダ欠落では説明できない。
         API 側 hook / WORKER allowlist の扱いも含めて確認する
      3. **同一 Worker PID 内で 200 と 401 が混在する理由**（上記1・2の帰結）
      4. **resource / log impact**: 1時間あたり約 600 件の無駄な往復とログ行。
         journal のノイズになり、本当に見るべき 401 を埋もれさせる
      5. **実機能への影響**: もし 401 を出しているのが Watchdog なら、
         **stall 検出が実質的に機能していない**（Job 一覧を取得できないため）可能性がある。
         これは記録段階では未確認であり、最初に確かめるべき点である

      **調査の起点（推奨）**: Worker 側で 401 応答を受けた時点の呼び出し元を一度だけ
      ログに出す（既存の `fetchJson` は `!res.ok` で `null` を返すだけで、
      **status を捨てている**）。新しい仕組みを作らず、この戻り値の握り潰しを直すだけで
      call site は特定できるはずである。

      **今回実装しないもの（明記）**: 認証まわりの変更 / Watchdog の再設計 /
      新しい retry・auth framework。本項目は記録と原因特定まで。
      P1 regression（`implement:<jobId>:review` の dirty 継承）や Phase 3 とは混ぜない。

      **2026-09-11 再実測（記録のみ・調査範囲は広げない）**: 本 Finding は**未解決のまま
      継続中**である。production API ログ（`ai-team-api.service`、2026-09-11 09:00:01〜
      10:26:56 JST の約87分）で `"statusCode":401` が **3,588 件**、同窓の
      `"statusCode":200` が **44,041 件**。401:200 比は約 **1:12.3** で、2026-09-08 観測時の
      627:7,291（約 1:11.6）と**ほぼ同じ**。比が変わらず絶対数だけ増えているのは
      全体トラフィックが増えたためであり、**新しい事象ではない**。
      call site・根本原因は依然として未特定で、上記「未特定」項目に変更はない。

### 将来アーキテクチャ移行（Constitution / Team・Service Extension構想。MVP後・未着手）

**前提（正本）:** `specs/00_constitution.md`（最上位思想）、`specs/13_future_system_architecture.md`
（将来のCore/Service Extension/Team Extension構造・現状マッピング）、
`specs/20_token_efficient_intelligence_policy.md`（AI利用量抑制方針）。

**重要:** 以下はいずれもMVP完成後の将来構想であり、今すぐ実装するものではない。MVP開発中に先回りして
実装しない。現行のAPI / Worker / Approval Gate / Risk Control / Watchdog / Mobile app等は
`docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」に明示された維持対象であり、
本セクションの将来構想によって削除・置換されることはない。

**上位アーキテクチャの移行方向（正本）:** 本OSは最終的に次の構造へ移行する方向とする。

```text
現在: AI Development Team OS（単一構成）
  ↓
将来: AI Organization OS Core（汎用部分）
      + Development Team Extension（Development固有部分）
```

- **汎用部分（Core行き）**: Task Engine / Worker Registry / Worker Routing / Worker Adapter Framework /
  Approval Gate / Policy / Cost / Knowledge / Learning / Observability
- **Development固有（Team Extension行き）**: Git操作 / Repository理解 / branch / commit / diff /
  lint / typecheck / test / build / deploy / code review

**この移行はMVP完成後に着手する。** MVP中は「境界を作る」ことのみを目的とし、汎用機能の実装は行わない。
判断に迷った場合は`specs/13_future_system_architecture.md`と`specs/00_constitution.md` 3.7
（Vendor Independence）を正本とする。Worker抽象化の包含関係（Worker Registry ⊃ Model Registry 等）は
`specs/13_future_system_architecture.md` 5b-7-9を参照。

- [ ] Extension Registry正式化・Service Extension Interface定義（Telemetry/Notification/Knowledge等の抽象化）
- [ ] Technology Sourcing / OSS Reuse Team MVP（Shared Expert Team / on-demand）
      `specs/14_technology_sourcing_oss_reuse_team.md`を正本とする。Extension Registry正式化と
      Team Extension境界を前提に、Capability Request/Registry lookup、Lightweight Scout、Static Filter、
      Security Preflight、Disposable Trial、Reuse Gate、OSS Registry、Capability Registry、Adapter、
      Contract Test、Exit Strategyを最小構成で実装する。**Learning / Evolution Coreの完成は前提にしない。**
      `Experience` / `Prediction` / `Actual`は後続Coreへ接続可能な形式で保存するが、独自Learning Engineは
      実装しない。Production導入・Secret利用・課金・Security最終承認は既存Gateを迂回しない。
- [ ] Company共通 Learning / Evolution Core（Development / OSSの共通化）
      `specs/13_future_system_architecture.md` 5cを正本とする。既存のSelf Diagnosis、Improvement Planner、
      Investigate、Experiment、Evolutionの責務を維持したまま、共通Experience、Prediction vs Actual、
      Lesson Candidate、Evidence/Confidence、Policy Proposal、Namespace、Versioning、Rollback、
      `development` / `oss_sourcing` Learning Profileを統合する。Operationalizeは既存Proposal Lifecycleと
      CEO明示承認を毎回必要とし、低リスクを含めPolicyの自動適用は行わない。
- [ ] Team別 Learning Profile展開
      Learning / Evolution Core完成後にEvaluation、Security、Marketing等へProfileを追加する。Team固有の
      Metrics、Evidence threshold、Critical condition、Feedback timing、Policy targetをProfileとして定義し、
      独自Learning Engineを増やさない。Team LessonのCompany Lesson昇格はCross-domain validationを要し、
      自動全社適用をしない。
- [ ] Development TeamのTeam Extension化（現状はClaude Code/Codex/Geminiが`apps/worker`に直接組み込まれた
      単一構成。将来的にTeam概念として抽象化するかは要検討）
- [ ] Team Health（Team単位の状態可視化。現状のProject単位health-scoreとは別軸。actor・
      department・workflow別のIncident反復傾向可視化を含む。件数だけで悪い部署と判定しない。
      詳細: `project-auto-incident-pattern-improvement`）
- [ ] Self Diagnosis Framework（観測のみ・変更なし。Token-Efficient Intelligence Policy準拠必須）
- [ ] Improvement Planner（改善提案作成のみ・本番反映なし）
- [ ] Problem-Driven Research（外部調査。具体的課題がある場合のみ開始）
- [ ] Experiment（Replay/Shadow/Canary。本番反映前の段階的検証）
- [ ] Personal Evolution / Profile Evolution / Core Evolution（CEO承認付き昇格フロー）
- [ ] `docs/AI_TEAM_OS_DESIGN.md`「第3弾」（AI Reliability/KPI/Conflict Management/Learning Control/Rollback/
      AI Runtime State）との重複整理（要整理・将来統合検討。今回は削除・置換しない）

### Architecture Debt: Organization Core切り出しの阻害要因（2026-08-09調査で確定・MVP中は修正しない）

将来 Development OS を「Development Team Extension」へ、汎用部分を「AI Organization OS Core」へ移行する
際、以下が前提条件となる。**MVP完成を優先し、現時点では大規模リファクタリングを行わない。**

- [ ] Debt-1: Core型の`CommandKind`がDevelopment/Git専用
      `packages/shared/src/types/command.ts`の11種すべてがGit/devツールチェーン
      （`git_commit` / `typecheck` / `test` / `build` / `lint`等）。Core層がDevelopment語彙を直接保持している
- [ ] Debt-2: `Job` schemaにDevelopment固有情報が混在
      `changedFiles` / `commitHash` / `rollbackInfo`がCore Job型・`jobs`テーブルに存在。
      汎用Task/Resultへ寄せる場合、これらはExtension metadata側へ退避が必要
- [ ] Debt-3: Approval Gate / DB schemaがGitロジックへ密結合
      `approval_requests`の`target_branch` / `target_commit` / `target_diff_hash`列、
      `apps/api/src/routes/approvalGate.ts`の`requestedAction === 'git_commit'`分岐とdiff scan。
      Approval GateはRisk / Action Type / Policyのみを扱う形へ抽象化が必要

**Architecture Rule（MVP中も適用。絶対禁止ではなく判断基準）:** 上記3点はMVP中にリファクタリングしない。
基本原則は「**新規実装で同種の密結合を不用意に増やさない**」ことであり、これをArchitecture判断基準に含める。
具体的には、(a) Core型・Core DB schemaへDevelopment固有概念を新たに必須項目として追加しない、
(b) Approval GateへGit固有ロジックを新規追加しない、(c) Worker出力をProvider固有形式のまま新規の判断
ロジックへ流さない、を原則とする。

**例外を認める条件:** 次のいずれも満たす場合は例外として密結合の追加を認めてよい。目的はMVP完成を優先
しながら将来の切り出しを不用意に阻害しないことであり、現在のDevelopment OSを今すぐ汎用Organization OS
へ作り替えることではない。

- MVP完成に不可欠である
- 現時点で無理に汎用化すると実装複雑性が大きく増える
- 将来Extensionへ切り出せることが明確である

例外を適用した場合は、本セクションへ**新しいDebt項目として追記**し、無断で密結合を積み増さない。

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

**組織学習の不足分（2026-08-09のsemantic gap analysisで判明。既存項目へ統合済み・新規Phaseは追加しない）:**

既存の`Investigate` / `Distill` / `Loop Metrics`は、それぞれ「失敗の原因深掘り」「Rule化」「内部Loop状態
把握」を責務としており、以下は**射程外**であることを確認した。既存機能を肥大化させず、下記として整理する。
詳細定義は`specs/13_future_system_architecture.md` 5b-5-1 / 5b-6-1 / 5b-6-2 / 5b-8 / 5b-9 / 5b-10。

- [ ] Self Diagnosis Frameworkの責務定義に基づく実装（Current State / Objective / Goal Gap /
      Trajectory Gap / Degradation / Opportunity / Bottleneck / Riskを観測し改善対象候補を検出する。
      **悪化検知だけに限定しない**。既存Investigateをこの検出機能へ肥大化させない。仕様: 5b-8。
      反復するヒヤリハット・非効率行動のProblem Cluster化・Repeat Level判定・原因分析
      （Root/System/Actor/Environment Cause分離、外部障害の誤分類禁止）を含む。
      詳細: `project-auto-incident-pattern-improvement`）
- [ ] Improvement Plannerの責務定義に基づく実装（Expected Outcome Impact / Strategic Importance /
      Probability of Success / Urgency / Implementation Cost / Time to Learn / Riskで優先順位付け。
      下位KPI改善が上位KPIを犠牲にしないことを条件とする。原因分析は既存Investigateを再利用。仕様: 5b-9。
      反復Problem Clusterからの改善候補生成（既存機能改善を最優先、新規機能追加は最後）・
      週1〜2件のCEO Proposal提出（Critical時のみ件数制限なし）を含む。
      詳細: `project-auto-incident-pattern-improvement`）
- [ ] Knowledge Lifecycle State（External Claim / Observation / Hypothesis / Evidence /
      Validated Knowledge / Operationalized Knowledge / Revalidation）と属性
      （`applicable_conditions` / `confidence` / `causal_confidence` / Internal・External区別）。
      現行5b-3のKnowledge種別（内容カテゴリ）と直交する軸として追加する。仕様: 5b-5-1
- [ ] Knowledge Conflict（外部主張と自社実績の不一致をエラーとせず`CONFLICT`として記録し、
      原因候補を保持する。Conflict自体を価値ある知識として扱う。仕様: 5b-5-1）
- [ ] 指標体系の分離（Execution/Loop Metrics ／ Business Outcome ／ Objective Progress を別軸として扱う。
      **Loop Metricsへ事業指標を統合しない**。仕様: 5b-6-1）
- [ ] 評価概念の分離（Worker/Execution Quality ／ Strategy/Playbook Performance ／ Business Outcome を
      混同しない。仕様: 5b-6-2）
- [ ] Problem-driven Learningの順序原則の実装
      （Objective/Gap/Opportunity → 原因・仮説 → Internal Knowledge → 不足時のみExternal Knowledge →
      Experiment → Outcome → Knowledge更新。外部ノウハウを改善活動の起点にしない。仕様: 5b-10）
- [ ] Quality Stabilizer（Worker間の品質ばらつきを吸収し最終成果物品質を一定範囲へ収束させる層。
      必要なレベルまでしかescalationしない。仕様: 5b-7-9）

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
      Developer AI実行全体への拡張として整理し、後日既存Quota Policyと統合する。
      **2026-08-12追記（2026-08-12再検討で更新）**: このCost and Model PolicyへData Sensitivity Policy
      も統合する（下記Model Registry Lite拡張を参照）。判断基準は**モデルの物理hosting locationの特定**
      ではなく、**Task/Dataの機密度（Data Sensitivity）× ProviderのData Policy（training・retention・
      明示的な地域制限）の適合可否**とする。Policy不適合の候補（機密度に対して不適合なProvider、または
      CEOが禁止したregionへの明示opt-inが必要と判明しているmodel）は、budget上余裕があっても自動
      Routing対象から除外する。Policy不適合モデルの自動Routing禁止は新しい独立Gateを作らず、既存の
      Routing選択ロジック（現状はTask.provider固定割当、将来はモデルクラス自動選択）が候補モデルを
      絞り込む際の必須フィルタとして組み込む）
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

      **2026-08-12追記（2026-08-12再検討で全面更新）: Data Sensitivity × Provider Data Policyを
      本レジストリのfieldとして統合する**（独立した「中国モデル監視機能」・新しいSecurity Gateは作らず、
      既存Model Registry Lite・Static/Dynamic Model Routing・Cost and Model Policyの拡張で実現する。
      背景: OpenCode Go `deepseek-v4-flash`が、同一model IDのまま最新版で中国ホスト限定・明示的opt-in
      必須に変更されたことが判明した。ただし多くのProviderは個々のmodelの正確な物理hosting locationを
      常時公開しておらず、hosting location特定を利用可否の必須条件にすると利用可能モデルを過剰に除外
      する。**目的はモデルの物理所在地監視ではなく、データ機密度に応じて信頼できるProvider/modelだけを
      Routingすること**であり、判断基準はhosting locationそのものではなくData Sensitivity × Provider
      Data Policyの適合可否とする）。

      **Provider-level Policy優先（Acceptance Criteria）**: Data Policyは原則Provider／契約単位で
      管理し、model固有条件（例: 特定modelだけの地域制限）だけをmodel側へ持たせる。同一Provider配下の
      多数のmodelでPolicyが共通する場合、modelごとに重複保存・重複確認しない設計とする。
      - [ ] Provider（または契約）単位で以下を管理できる:
            - `trainingPolicy`: `no_training` / `opt_out_available` / `may_train` / `unknown`
            - `retentionPolicy`: `zero_retention` / `limited_retention` / `provider_default` / `unknown`
            - `providerTrustTier`: 高機密用途で許可されたProviderかを表現できればよい（enum詳細は
              実装時に決定）
            - `lastVerifiedAt`（最終確認日時）
            - `verificationSource`（情報源。**providerのmodels endpointだけを唯一の情報源にしない**。
              models endpointがこれらの情報を返さない場合があることを2026-08-12のOpenCode Go調査で
              確認済み）
      - [ ] model単位では、Provider-level Policyを継承した上で、model固有の例外だけを追加で持てる:
            - `explicitRegionRestriction`: `none` / `prohibited_region` / `requires_explicit_opt_in` /
              `unknown`（`unknown`は「情報が単に無い」状態。「禁止regionでの処理が明示されている」
              状態とは区別する。後者の実例が今回のOpenCode Go `deepseek-v4-flash`）
            - model固有Policy（`explicitRegionRestriction`等）が存在する場合だけ、そのPolicy自身に
              `lastVerifiedAt`／`verificationSource`相当のverification metadataを持たせられる
              （Provider-level Policyのverification metadataとは別物として、model-level側にも
              必要な場合だけ保持する。全modelへ無意味に複製しない）。目的は、同一model IDのまま
              region条件が後から変わった場合に、model固有Policy側で個別にstale判定・再確認できる
              ようにすること
      - [ ] `hostingRegion`・`hostingStatus`（判明していれば記録できる補助情報）は、利用可否を決める
            必須条件ではなく**optional metadata**として扱う。hosting locationが単に不明であることを
            理由に自動利用禁止にはしない
      - [ ] Provider-level PolicyとModel-level例外の差分（同一model IDのままPolicyが変更された場合を
            含む）は、`lastVerifiedAt`超過によるstale判定、または再確認時の差分検出のいずれかで検出
            できる。新しい常時監視プロセスは作らない
      - [ ] Policy情報の更新は、毎request時の外部問い合わせではなく、**キャッシュされたmetadata +
            適切なrefresh interval**（利用前のstale確認、または定期バッチのいずれか）で行う

      **Routing/Policy連動（Acceptance Criteria）**:
      - [ ] CEOが設定したData Sensitivity別Policyと、Model Routingの候補選択が連動し、機密度に対して
            不適合なProvider/modelは自動Routing候補から除外される
      - [ ] `explicitRegionRestriction: prohibited_region`または`requires_explicit_opt_in`かつCEO
            Policyで禁止されているmodelは自動Routing対象外とする。CEOが明示的にPolicyを変更した場合
            のみ利用可能とする
      - [ ] Task.provider固定割当・Cheap AI（`cheap_explainer`等の固定role）を含む、**固定model
            指定の経路にも同じData Sensitivity Policyを適用する**（Dynamic Routing実装前でも、固定
            割当先のモデルがPolicy不適合にならないことを個別に確認する運用でよい。ただし毎requestごと
            にLLMや外部APIへPolicy確認を行う設計にはせず、キャッシュされたRegistry metadataを利用し、
            staleな場合のみ再確認する。新しいGateは作らない）
      - [ ] 該当Data Sensitivityで利用可能なmodelが0件の場合、機密レベルを自動的に下げない。
            対象Taskだけを安全側で停止し、他Taskは継続可能とする（Project全体は停止しない）。
            既存のTask statusで表現できる場合は新しいstatusを追加しない
      - [ ] Secret（APIキー・パスワード・秘密鍵・access token・credential等）そのものの外部LLMへの
            非送信は、機密レベルに関係なく既存Worker Trust Boundary側の責務とする。Model Routing側へ
            重複したSecret Gateを新設しない

      **初期Data Sensitivity別Model Policy（Acceptance Criteria）**:
      - [ ] **低機密・通常機密**: OpenCode Go等を含め、既存のCost/Quality/Quota Policyに従って
            Routing可能。ただし明示的な禁止region条件（`explicitRegionRestriction`）や、明確に不適合
            と判明しているProvider Data Policyが判明している場合は除外する
      - [ ] **高機密**: 「API入力・出力をmodel trainingへ利用しないことが明示されている」
            「retention policyが明示されている」「Providerの契約・データ取扱条件を確認できる」を
            少なくとも確認できるProviderを優先する。初期運用ではOpenAI API / Anthropic APIを優先候補
            とする
      - [ ] **最高機密**: 当面はOpenAI API・Anthropic APIのみを許可Providerとする。前提: commercial
            API契約を使用する／model trainingへ使用しないことがProviderから明示されている／標準の
            限定的retention（abuse monitoring等）は許容する。将来的にLocal LLM/Self-hosted modelを
            最高機密用fallback候補として追加検討する余地を残すが、**Local LLMは今回実装しない**

      **CEO向け表示（Acceptance Criteria、既存Model Registry Lite表示への追加として。新規画面は必須で
      はない）**:
      - [ ] 「利用可能」「Data Policy不適合のため利用禁止」「確認が必要」の3状態でモデル一覧を確認
            できる

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

**将来のWorker抽象化との包含関係（2026-08-09追記。移行方向の明示のみ。現行機能の削除・改名は不要）:**

本セクションの各機能はいずれも**LLM（モデル）だけを対象としたsubset**である。将来のAI Organization OS
Coreでは実行主体をモデルに限定せずWorkerとして抽象化する。最終正本はWorker系の名称とする。

```text
Worker Registry                 ← 最終正本
  └ Model Registry (Lite)           LLMのみを対象とするsubset

Worker Routing / Execution Plan ← 最終正本
  └ Model Routing (Static/Dynamic)  単一モデル選択のみのsubset

Worker Adapter Framework        ← 最終正本
  └ AI CLI Adapter                  現行実装（`apps/worker/src/aiCli/*`）。CLI型LLMのみのsubset
```

将来Workerには、LLMに加えAgent（Lovable / OpenHands等）・Tool（Apify Actor / n8n等）・Script（Python /
shell）・Deterministic（validator / test runner / linter）等を含める。Routingの最適化単位も単一Workerに
限らずWorker Compositionまで拡張しうる。最適化目標は「最も安いWorker」ではなく
「**要求品質を満たす実行計画の総コスト最小化**」（＝本セクション既出の「修正/再試行を含む完了までの
総コスト」と同一概念）。詳細: `specs/13_future_system_architecture.md` 5b-7-9。

**優先順位:** 1. MVPの完成 → 2. 単純な固定ルールによる安定運用 → 3. 実行ログの収集 →
4. 実際に問題が出た部分だけモデル選択を改善 → 5. 必要性が確認された場合のみ限定比較 →
6. 十分なデータと費用対効果がある場合のみ動的ルーティング

**今回実装しないもの（明記）:** 全モデルの常時比較／タスクごとの複数モデル完全実行／自動ベンチマーク
基盤／複雑な選択確信度計算／機械学習によるモデルルーティング／モデル選択ルールの自動変更／本番成果物への
Shadow結果の自動反映／CEO承認なしの予算上限超過／Model Registryの自動インターネット更新／
プロダクションコードの変更。

<!-- roadmap:id=project-auto-gemini-worker-eligibility state=planned -->
1. [ ] **Gemini 3.7 Flash Free Tier Worker適合性調査** — 2026-08-14、CEO指示により新規登録。本節の
      Static/Dynamic Model Routing・Data Sensitivity Policy・Model Registry Lite・Quota Policyの
      枠組みを、具体的な1 Providerへ最初に適用する調査。新しい独立Provider評価の仕組みは作らない。

**位置づけ**: 「無料だから仕事を振る」のではなく、「そのTask・Contextに適しており、安全性と品質を満たす
場合、その中でFree Tierを優先活用する」。「Geminiを追加する」ことを先に決めず、既存Worker/Router/
Context/Security構造との適合性を調査し、安全かつ合理的な配置が確認できた場合のみ実装する。

```text
MVP完成 → 初期安定化 → Gemini Worker適合性調査 →
  適合性あり → 最小実装
  適合性なし/構造不足 → 保留または必要な前提機能へ統合
```

MVP完成を遅らせない。MVP直後のCritical bug/Safety issue/運用安定化より優先しない。Gemini追加のためだけに
Router等の大規模新機能を先行実装しない。

**既存Geminiとの違い（重複ではないことの確認）**: 既存のGemini利用（`geminiRouter.ts`/`geminiClient.ts`
経由のRisk Review・Step Review・Independent Review、Reviewer/Meta Reviewer層）とは別物。本項目が扱うのは
Taskを実行するWorker Providerとしての Gemini 3.7 Flash Free Tierであり、既存Gemini Reviewerの変更・
置換は含まない。

**Phase 1（コード変更なし。調査のみ）**:
- [ ] 現在のWorker/Provider構造の調査 — Claude/Codex/OpenCode/cheap AI client等の既存Providerが
      どこで定義されるか、Task固定指定か・Job生成時決定か・Worker起動時決定か、retry/resume時の
      引き継ぎ方を確認する。上記「1タスク＝1プロバイダー」（`Task.provider`）原則がどこまで実装済みか
      を含む
- [ ] Routerの実装状況調査 — Fixed Provider Selection／Rule-based Routing／Dynamic Routing（Task
      内容・難易度・Risk・Cost・quota・Worker availability・過去成績・Data Sensitivityを考慮）の
      どこまで実装済みかを区別して確認する。**Routerが未実装だからという理由だけでGemini導入のために
      大規模Routerを新規実装しない**
- [ ] Gemini Freeへ渡るContextの調査（最重要） — 現在Worker Contextへ自動的に含まれるもの（Task本文/
      Project Goal/Design Philosophy/Architecture/Current State/Roadmap/Decisions/source code/
      git diff/logs/filesystem情報/environment情報/credentials等）を確認する。Task自体が非機密でも
      自動Context Packによってprivate codeや内部設計が混入しないかを重点確認する。
      `project-auto-context-pack-wiring`（現状`contextFiles`未接続。`jobRunner.ts`が
      `contextFiles: []`をハードコード）の状態を前提として踏まえる
- [ ] Gemini Free利用禁止情報の定義 — API keys/passwords/tokens/private keys/`.env`/Personal
      Data/Customer Data/Private Repository source/unpublished architecture/confidential
      business informationを送信禁止候補として評価する。原則: 明確にNon-sensitive→候補／
      Sensitive→禁止／判定不能→禁止（**Default Deny**）。上記Data Sensitivity Policy（低機密・
      通常機密／高機密／最高機密の3tier）と整合させる（Gemini Free候補はこの3tierのうち最も低い
      区分に位置づく想定だが、実装前提として断定しない）
- [ ] 既存Security分類の再利用確認 — 現在のRisk分類・protected files・permissions・security
      classification・Task metadata、および上記Model Registry Lite（`trainingPolicy`/
      `retentionPolicy`/`providerTrustTier`）で再利用できるものがないか先に確認する。既存分類で
      合理的に実現可能なら新規分類は追加しない
- [ ] Geminiへ向いているTaskの実測ベース分類 — 実際のAIteamOSのTask/Context構造を確認した上で、
      Allowed/Conditional/Denied/Unknownへ分類する（想定候補: 公開情報整理・分類・タグ付け・
      非機密ログ分析・Incident分類・Document Rot候補検出・重複候補検出・公開OSS調査・軽量一次
      レビュー等。あくまで例であり実構造確認後に判断する）
- [ ] 「配置ミス」評価 — 性能だけでなく品質不足による手戻り・誤判断・retry増加・Incident/Near Miss・
      Context不足・private data送信リスク・高性能Modelへ戻す必要性・結果的な総コストを評価する。
      単純なtoken単価だけでProviderを選ばない

**Phase 2（Phase 1で適合性ありと判断された場合のみ着手）**:
- [ ] Experimental/Free/Non-sensitive/Limited scopeのWorkerとして開始する。最初からClaudeの代替・
      Codexの代替・主力Coding Worker・全TaskのDefault Providerにはしない
- [ ] 最小導入案を優先する。既存Provider abstractionへの自然な追加（既存Provider定義+Gemini、既存
      Worker launcher+Gemini adapter、既存metadata+eligibility判定、既存Routing+非機密条件）程度を
      優先する。Routerが十分でない場合はOption A（対象Taskだけ明示的にGemini指定）／Option B（非常に
      小さいRule-based Routing）／Option C（本格Dynamic Router）を比較し、A/Bで十分ならCを実装しない
- [ ] Quota/Fallback確認 — Rate Limit・quota exhaustion・Provider unavailable・timeout・retryを
      確認する。Gemini Freeが使えない場合に自動で有料Providerへ切り替えることで予期しないコストが
      発生しないかを確認する。既存Cost/Budget Approval機構（上記「CEO予算上限の遵守・無料枠優先」）を
      再利用する
- [ ] 実運用評価 — 新しいAnalytics Systemを安易に作らず、既存の記録（上記Model Usage Telemetry、
      Task成功率・Review一発通過率・retry率・failure率・duration・token/cost・Incident/Near Miss・
      手戻り・1 successful taskあたりコスト）でGemini/Claude/Codex等を比較できるか確認する

**2027-01-01前後の再評価（条件として必須）**: Gemini 3.7 FlashはPaid Tier価格変更が2027-01-01から
予定されているため、2026年末〜2027年1月にProvider継続評価を行う。評価内容: Free Tier継続有無・Free
quota/Rate Limit・最新利用条件・Paid価格・実運用成功率・Incident率・1成功Taskあたりコスト・Claude/
Codex/他Providerとの比較。継続/役割縮小/Paid利用/Freeのみ利用/他Providerへ置換/廃止を再判断する。

**重複確認・既存項目との関係**:
- 本項目は本節（Static/Dynamic Model Routing・Data Sensitivity Policy・Model Registry Lite・Quota
  Policy）の枠組みを、Gemini 3.7 Flashという具体的Providerへ最初に適用する調査であり、独立の評価
  システムを新設するものではない
- `project-auto-resource-allocation`（deferred、AI Resource Allocation/Capacity管理、概念登録のみ）
  とは責務が重なる可能性があるが、あちらはProject別配分・稼働量管理が中心。Phase 2実装時、Resource
  Allocation機構が先に実装されていればFree quota/Worker capacity/Provider performance/Costの
  Routing責務はそちらへ統合し、本項目で重複実装しない
- `project-auto-context-pack-wiring`（deferred、Context Pack未接続の事実）とは調査前提として関連
  するが責務は別（あちらはContext接続そのものの実装、本項目はContext内容のsensitivity調査）
- 既存Gemini Reviewer（`geminiRouter.ts`等）とは別物（上記参照）
- `project-auto-multi-worker`（deferred、複数Worker**プロセス**対応）ともスコープが異なる（本項目は
  単一Worker内でのProvider選択の話であり、複数Worker並行実行の前提条件ではない）

**今回の作業範囲（禁止事項）**: 今回はRoadmap登録のみ。Gemini API実装・API key取得/登録・Provider
追加・Router実装・Context Filter実装・DB migration・Worker変更・外部API接続テストは行わない。

**完了条件（Definition of Done）**: 単に「Gemini APIを呼べるようになった」では完了扱いにしない。
少なくとも次を満たすこと: (1) Worker/Router現状調査済み (2) Context流入経路確認済み (3) Free利用
禁止情報を定義済み（Default Deny） (4) Gemini適用Task範囲決定済み（Allowed/Conditional/Denied/
Unknown分類） (5) Default Denyが成立 (6) 最小Provider統合完了 (7) quota/fallback動作確認 (8) 実績
計測可能 (9) 既存Providerへの回帰可能。**ただし調査の結果Gemini追加が不適切と判断された場合は
「追加しない」という判断でも本項目は正常終了（done）とする**。

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

## PL Console（ベンダー非依存のPL指示UI。低優先・本線安定化後に着手）

**位置づけ:** 将来の重要基盤だが、**現在の完成作業を遅らせない低優先度タスク**。
Phase 1c E2E・Recovery・Worker・Gate・Roadmap実行系などの**本線安定化を常に優先する**。
本セクションは検討・評価のための項目であり、登録時点では実装・PoC・本線変更を一切行っていない。

**目的:**
- CEOがPC/スマホからPL（Project Lead Role）へ指示を出す画面を、特定ベンダーUI
  （Claude Desktop等）に依存しない構成にする
- Claude/Fable・OpenAI/Codex・その他Providerを将来交換可能にする
- **UI層とPL Provider層を分離する**（UIはProviderを直接呼ばない）
- 会話履歴・Project Memory・Decision Log等のsource of truthを、最終的にAIteamOS側に
  置ける構成を目指す

**想定候補:** LibreChat（第一候補）。**現時点では採用確定ではない**。
AIteamOSのPL指示画面として利用可能かを評価したうえで採否を決定する。

**制約（着手条件・Guard Rail）:**
- 優先順位は低。本線タスクと競合する場合は常に本線を優先する
- **本線安定化（Phase 1c E2E / Recovery / Worker / Gate / Roadmap実行系）が完了するまで、
  AIteamOS本体との接続実装を開始しない**
- DB schema・Production API・Worker・Roadmap実行系・Gateへ**先行して変更を入れない**
- **他タスクのついでに接続・配線しない**（PL Console起因の変更は必ず独立タスクとして扱う）
- 将来着手する際も、**まず隔離環境でPoCしてから統合する**
- 外部サービス追加・課金・認証・本番公開に該当する判断はYellow Zone（CEO承認必須）

<!-- roadmap:id=pl-console-candidate-evaluation state=deferred -->
1. [ ] **PL Console候補の評価（調査のみ・コード変更なし）**
      - LibreChatを第一候補として評価する
      - PC/モバイル双方での操作性（スマホ完結の Design Philosophy を満たせるか）
      - マルチProvider対応（Claude/Fable・OpenAI/Codex・その他の切替可否）
      - 認証方式・MCP対応・Agent連携の可否
      - 改造量・保守コスト・ライセンス条件の確認
      - 成果物: 評価メモ（採用可否の判断材料）。**採用しないという結論でも本項目は正常終了**

<!-- roadmap:id=pl-console-isolated-poc state=deferred -->
2. [ ] **隔離PoC（AIteamOS本体と非接続）**
      - AIteamOS本体とは接続せず、別環境（隔離環境）で起動・検証する
      - 本番DB・Production API・Worker・Gateには一切接続しない
      - PoCを通じて、**必要となるPL Gateway interfaceを整理する**
        （指示送信・会話取得・Project/Task参照・承認要求の受け渡し等）
      - 着手条件: 項目1の評価完了 かつ 本線安定化が阻害されないこと

<!-- roadmap:id=pl-console-gateway-design state=deferred -->
3. [ ] **PL Gateway設計（設計のみ・実装は本統合で行う）**
      - UIからAI Providerを直接呼ばず、**AIteamOS側のGatewayを経由する**構成にする
      - Provider Adapterを交換可能にする（既存`AiCliProvider`/Adapter基盤との関係を整理する）
      - 会話・Project・Decision状態の**保存責任の所在を明確化する**
        （UI側に持たせず、source of truthをAIteamOS側へ置けること）
      - Authority / Safety Boundary（Approval Gate・Permission Guard・File Change Guard）を
        迂回しないインターフェースであることを設計時点で担保する
      - 着手条件: 項目2の隔離PoC完了

<!-- roadmap:id=pl-console-integration state=deferred -->
4. [ ] **本統合（着手条件付き）**
      - **Phase 1cおよび主要Recovery/E2Eが安定した後にのみ着手する**
      - 既存Mobile UI・Production workflowへ影響を出さない形で段階導入する
      - DB schema変更・API追加が必要な場合は、それ自体を独立タスクとして切り出す
      - Rollback可能な導入手順（機能フラグ・切り戻し手順）を用意する
      - 着手条件: 項目3の設計完了 かつ 本線安定化完了 かつ CEO承認

---

*Updated: 2026-09-04*
