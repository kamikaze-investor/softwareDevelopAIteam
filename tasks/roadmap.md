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

      **`project-auto-worker-trust-boundary`は、Task→Job→Workerインターフェースの文書化と
      Outbox最小接続口のCEO承認（いずれも2026-08-12）により全Acceptance Criteriaが
      満たされたため、doneとする。**
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
<!-- roadmap:id=project-auto-db-safety state=in_progress -->
5. [ ] **本体DB安全・復旧基盤** — 依存: `project-auto-worker-trust-boundary`。
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
      **DB Safety B（残課題。本項目を`in_progress`のまま維持する理由）**: 重要状態変更の監査ログ・
      migration/一括削除の管理権限分離は未着手。これらが完了するまで本項目は`done`にしない
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
      **Task取得不能時のJob確定（2026-07-31 Codex指摘。変更検出修正では対処せず本Stepへ送る）**:
      Workerの`fetchQueuedJob()`は`/api/tasks`が失敗すると`if (!tasks) continue`で
      次のProjectへ進むため、**queued Jobをfailedへ確定できずポーリングに残り続ける**
      （`apps/worker/src/index.ts`）。AIは実行されないため安全側だが、
      「Task取得失敗はAI実行前にfailedで停止する」という状態契約を満たさない。
      正しく直すにはqueued Jobを先に取得して`taskId`からTaskを引くポーリング契約へ変える必要があり、
      API側の変更を伴うため本Step（薄いapplication serviceによる進行管理）の設計に含めて解決する。
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

      **確認シナリオへ追加（2026-07-31）**: 状態不明attemptの検出（Outboxに該当eventが
      存在しないrunning Job）／該当worktree・専用ブランチの破棄／同一`base_commit_hash`からの
      新attempt自動生成（1回まで）／2回目の状態不明でfail-closed停止し、CEO承認を要求せず
      既存のJob/Task失敗可視化経路にそのまま乗ること／replay-safeでないJob（既存
      `CommandKindSchema`に無い外部作用を伴うJob）は本メカニズムの対象にしないこと。
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
<!-- roadmap:id=project-auto-meta-review-hardening state=in_progress -->
10. [ ] **Meta Review MVP Hardening — Strategic Alignment / Review Load Distribution**（2026-08-13
      foundation実装完了）— 既存Meta Reviewer（`docs/meta_reviewer/`prompt/checklist、
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

      **未完了Acceptance Criteria（3件。この3件が揃うまでdoneにしない）**:
      1. **Strategic Alignment Reviewの実装前自動発火**: 現状`design-review` CLIは手動起動のみで、
         Task/Job作成フローへの自動接続がない。`project-auto-task-job-chain`
         （Task→Job自動生成）が未着手のため、自動接続に必要な「Job作成前フック」相当の
         最小interfaceが現行リポジトリに存在しない。Task→Job full automationは、この項目の
         残Acceptance Criteriaが揃う前に有効化しない（依存関係として明記。ただし
         Task→Job full automation自体は本項目の範囲外であり今回実装しない）
      2. **Critical Independent Reviewの実実行接続**: `independentReviewRequired`フラグは
         CRITICAL時に立つが、実際に別プロバイダへ独立レビューを発注する接続コードは無い
         （現状は既存の運用上のCodex独立レビュー手続き前提）。新しいReviewer Agent・
         Provider Router・Workflow engineは作らず、既存のIndependent Review経路（Codex CLI
         独立レビュー等）へ自然に接続できるpre-implementation interfaceがTask→Job側で
         用意された時点で接続する。**Critical Independent Review execution wiring = pending**
      3. **Production相当E2E**: 実productionワークフロー（Task作成→design-review→
         実装→Job実行）を通した一連のE2Eはまだ実施していない。2026-08-13時点で確認したのは
         design-review CLI単体の実LLM E2E（1シナリオ）のみ

      **完了条件**: 上記未完了3件が満たされ、Review Load分類・Strategic Alignment・
      Integration Review・fail-closedが実運用（PR自動レビューまたはTask/Job自動生成フロー）で
      実証されること。既存の統合Meta Review（LOW時）・既存Implementation Meta Review
      （`autoReview.ts`）の挙動を壊さないこと

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
<!-- roadmap:id=project-auto-incident-pattern-improvement state=planned -->
4. [ ] **ヒヤリハット・反復非効率検知 — Incident Pattern Improvement Loop**（2026-08-13仕様反映。
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
