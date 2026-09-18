# Roadmap

**Project**: AI Development Team OS
**Goal**: スマホだけでAI開発チームを運営できるシステム

---

## 現在の可否は `state=` が正本（2026-09-15 CEO 決定）

**`MVP は 2026-09-13 に正式完了した。`** したがって本文中の
「MVP後へ延期」「MVP完成後」「post-MVP」「MVP 完成まで開始しない」といった表現は、
**その項目が書かれた時点の記録**であり、**現在の BLOCK 条件ではない**。
延期条件はすでに充足している。

**「以前は延期されていた」と「現在も実装禁止」を混同しないこと。** 区別は本文ではなく
**既存の `state=` で表す**（新しい state 体系も metadata も追加しない）:

| `state=` | 意味 |
|---|---|
| `planned` | **現在着手してよい。** 本文に「MVP後」と書いてあっても、条件は充足済み |
| `deferred` | **現在は着手しない。** 延期理由は MVP とは別にあり、今も生きている |
| `done` | 完了。履歴として残す |

PL の採用候補は `planned` だけである（`deferred` は候補に入らない）。
**Design Review・PL は、本文の古い延期文言を現在の BLOCK 根拠にしてはならない。**
現在も止めるべき項目は `state=deferred` で表現されている。

これは Review 結果の override ではなく、**Source of Truth の時点整合修正**である。
経緯: `docs/project_memory/decisions/multi_task_continuous_autonomous_development_evidence.md`。

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
- [x] CLI出力パーサー + JSONリトライ機構 (task-023) — 実装済み（`apps/worker/src/aiCli/adapter.ts` の `retryCount`/`maxRetries`/JSON再プロンプト。test: `adapter.test.ts`）。2026-09-15 監査で確認し、`tasks/task_graph.md` の `[x]` と揃えた
- [x] CLI timeout / retry / cancel設計 (task-024) — 実装済み（`adapter.ts` の `request.timeoutMs ?? defaultTimeoutMs` → cgroup SIGKILL。test: `adapter.providerTimeout.test.ts`）。2026-09-15 監査で確認

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

      **2026-09-13 訂正（Project Model 原則との整合。schema・status は増やさない）**:
      本項目の表題「全Task完了をもってProject完了とみなす判定」は、CEO が確定した
      **Project Model 原則**（1 Project = 1 Product / Business / System、Project は最終 Goal 達成まで
      継続、MVP・Phase・Release は Project 分割ではなく Roadmap 上の Milestone）と**矛盾する**。
      正しくは「**現ロードマップ消化判定**」であり、Project の完了ではない。

      **調査結果（2026-09-13）**: 実装側は既に原則と整合していた。`ProjectStatus` に `completed` は
      無く、Project を自動で `archived` / `paused` にするコードも存在しない（検索0件）。
      `taskContinuation` は次 Task が無ければ静かに終わるだけで Project を終了させない。
      **矛盾しているのは表示の意味づけだけ**である。

      **最小修正（これ以上の変更はしない）**:
      1. Mobile のバッジ文言を「完了」→「ロードマップ消化済み」相当へ変更
         （`apps/mobile/app/index.tsx`。表示文字列のみ。schema 変更なし）
      2. `ProjectRoadmapCompletion`（`packages/shared/src/types/project.ts`）へ、
         `isComplete` が Goal 達成ではなく現ロードマップ消化を意味する旨の doc comment を追加
         （改名は任意・低優先）
      3. **Project 完了 = Goal 達成であり、CEO が判断する。自動導出しない**ことを
         `specs/` の Project Model 原則へ明記する
      放置すると AIteamOS 自身が Roadmap 途中で「完了」と表示される。
<!-- roadmap:id=project-auto-ceo-alignment state=planned -->
10. [ ] CEO Alignment Checkpoint: Phase完了・主要機能完成時にサマリーと当初計画との差分をCEOへ通知する。
      **通知後も開発は継続し、通常チェックポイントでは停止しない**。既存の`notifier`
      （LINE/Slack）・`summaryEngine.ts`・Approval Gateの再利用を前提とし、新しい停止Gateは作らない。
      **完了条件**: Phase完了時にCEOへ通知が届き、開発が止まらないこと。CEOが修正指示を返す経路は
      「追加開発指示（追加Task作成）」を使う

      **2026-09-13 追記: Milestone Report をここへ統合候補として残す（新規項目は立てない）**。
      Project Model 原則により MVP / Phase / Release は Project 分割ではなく Roadmap 上の
      Milestone であるため、Milestone 到達時の CEO 向け報告は**本項目の責務**に含める。
      **新規の大規模 Reporting 基盤は作らない。** 入力はすべて既存の確定済み記録を使う:
      `tasks/roadmap.md`（計画と差分）・Review 結果・E2E / Runtime 記録・`audit_log`・
      `executionLogStore`。表現（非エンジニア向け日本語化）は Explainer 責務
      （`failure-explanation-pregeneration` が扱う）へ委譲し、ここでは**事実の収集経路**だけを扱う。
      Explainer は技術判断をせず、確定事実の言い換えに限る（推測・改変の禁止は同項目を正本とする）。
      着手順は `cross-project-state-api` の後が自然（横断状態が取れてからの方が入力が揃うため）。
      本項目の state・優先度は変更しない。

      **2026-09-13 追記2（Milestone Report の具体設計と着手順。PL 判断）**: 上記の統合方針どおり
      **新規項目は立てない**。本項目が Milestone Report の**事実収集と記録**の owner である。

      **2層に分ける**:
      1. **Milestone Snapshot（machine-readable な正式記録）** — 到達時点の事実を決定論的コードで
         組み立てて保存する。LLM を使わない。保存後は書き換えない（append-only）。
      2. **CEO Report（非エンジニア向け説明）** — 1 だけを入力に Explainer が生成する派生物。
         再生成可能で**正式記録ではない**。生成責務は `failure-explanation-pregeneration`。
         保存形式は既存 `PersistedTaskFailureExplanationV1`
         （`packages/shared/src/types/task_failure_explanation.ts` の `schemaVersion` /
         `inputVersion` / `contentHash`）に倣い、「snapshot が正・説明が従」を型で固定する。

      **なぜ「後から再構築」ではなく snapshot なのか（実測・2026-09-13）**: roadmap 再同期は消えた
      Phase / Task を削除せず `roadmap_active=0` にする（`apps/api/src/storage/sqlite.ts`）。
      `GET /api/projects/:id/roadmap` は active な Phase だけを返し、`getRoadmapCompletion()`
      （`apps/api/src/routes/projects.ts:33`）も active な Task だけを数える。したがって
      **次の Roadmap へ進んだ瞬間に、その Milestone 時点の Roadmap と消化率は現在状態から
      再構築できなくなる**。新しい履歴基盤が欲しいからではなく、この非可逆性が理由である。

      **入力（DB 側。上記の `tasks/roadmap.md` / `audit_log` / `executionLogStore` に加えて）**:
      `project_roadmap_phases`（非 active 含む）・`tasks`（`roadmapTaskKey` / `phase` / `status` /
      `acceptanceCriteria` / `commitHash`）・`jobs`（`commit_hash` / terminal state /
      `failure_explanation_json`）・`review_results`（`findings`）・`design_review_evidence`
      （`decision` / `independent_review_verdict`）・`qa_results`・`approval_requests` /
      `gate_evaluations`・`watchdog_events`・`task_continuations` / `supervised_runs`・
      `incident_records` / `decision_records`。**新しい収集経路は作らない。**

      **Metrics / Cost**: token・課金額の計測はリポジトリに1箇所も存在しない（`Model Usage Telemetry`
      に実測を記載済み）。本項目で cost 計測基盤は作らない。v1 の Metrics は既存事実から決定論的に
      導出できるもの（Task / Job 件数、失敗・repair・retry 件数、承認回数、人手介入回数、
      Milestone 開始〜到達の経過時間）に限る。

      **Milestone は planning entity ではない**。上記6（done）の「Milestone entity・Phase UUID・
      generic versioning system を追加しない」を維持し、報告時点のラベルとして扱う。追加 schema は
      **append-only の1テーブルまで**を上限とし、`design_review_evidence` と同じ「hash 付きの確定記録」の
      形に倣う。

      **着手順（PL 判断・2026-09-13。本項目の state・優先度は変えない）**:
      `project-workspace-isolation`（production を止めているクラスタ）→ `cross-project-state-api`
      → **Stage A: snapshot の収集・永続化・参照・到達通知（LLM なし）** →
      `failure-explanation-pregeneration` → **Stage B: CEO Report 生成**。
      Stage B を先に作らない（Explainer 経路の二重実装になる）。

      **完了条件（Stage A）**: Milestone 到達時点の snapshot が保存され、その後 Roadmap を再同期しても
      **保存済み snapshot が変化しない**こと。snapshot だけから次を LLM なしで再現できること —
      目的／完成したもの／未完了・延期したもの／システム上の変更／Runtime・E2E 等の実動確認結果／
      Independent Review・品質確認／発生した問題・Finding／重要な設計変更／Metrics・開発効率／
      残 Technical Debt・Known Limitations／次の Roadmap 段階。Mobile から参照でき、到達時に通知が届き、
      **開発が止まらない**こと。CEO 向け非エンジニア説明は Stage B。

      **順序制約（hard）**: 同一 Project で次の Roadmap へ進む経路を有効化する**前に** Stage A を
      着地させる。現状その経路は**存在しない**（現 Roadmap の消化は `getRoadmapCompletion().isComplete`
      として導出されるだけで、次 Roadmap を作る実装は無い。`ProjectStartStage` の `roadmap_regeneration`
      は Project 開始 workflow 内の作り直しであり、Milestone 後の継続ではない）。実装順は
      `snapshot 保存 → 次 Roadmap 生成 → task_sync` とし、snapshot 未保存のまま `roadmap_active=0` に
      しない。roadmap 再同期は消える Task / Phase に active Job があると throw で拒否するため
      （`Cannot deactivate roadmap task ...`）、切り替えは active Job 0 の時点でのみ成立する。

      **対象 Project の一本化（CEO 方針・2026-09-14）**: Milestone Report は **AIteamOS 自身を含む
      全 Project で一本化**する。AIteamOS は将来 **Project #1** として、他の Product / Business /
      System と同じ Project Model・Milestone Model・**同一の Milestone Snapshot schema** で扱う。
      **「通常 Project 用」と「Control Repository 用」という2つの恒久的な Reporting 概念には分けない。**
      AIteamOS 専用の Report システムは作らない。

      **今すぐ統一するのは概念と schema であって、取得元ではない。** 現時点で許容する差分は
      **入力 adapter だけ**（Source of Truth が今は異なるため）:
      - 通常 Project — 上記の DB 側 source（`tasks` / `jobs` / `review_results` /
        `design_review_evidence` / `audit_log` / runtime records 等）
      - AIteamOS 自身 — Control Repository の `tasks/roadmap.md`・Git 履歴・Review・CI・
        Production E2E・`docs/project_memory/decisions/*.md` から**同じ schema へ**事実を収集する

      `docs/project_memory/decisions/*.md` を手書きで維持する方式は**移行期間の暫定 Source に留め、
      恒久設計にはしない**。`aiteamos-self-development-tier-a` により AIteamOS 自身が AIteamOS 上の
      Project #1 として開発される段階で、**通常 Project と同じ生成経路へ収束**させる。
      したがって分岐は **adapter 層だけに閉じ込め**、snapshot schema・Report 項目・保存先・参照 API・
      Explainer 経路は**最初から共通**にする。

      **今回実装しないもの（明記）**: 新しい Reporting 基盤 / AIteamOS 専用 Report システム /
      新しい log・telemetry・metrics 基盤 / cost 計測 / 新しい review 基盤 / 新しい queue・daemon /
      Milestone planning entity / Task 単位の詳細 Report。本追記は設計方針と着手順の確定まで。
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

      **【2026-09-17 訂正・原因確定・修正済み】事象1の記述「fenced JSON を返すと parser が失敗する」は誤りだった。**

      実測で否定された。`extractJsonCandidates()` は ```json フェンス / ``` フェンス /
      前後に散文がある場合をすべて処理できる（`parseMetaReviewResult()` を直接叩いて確認）。
      **フェンス正規化は既に実装済みで、そこを直しても何も変わらない。**

      **実際の機構は 2 つ**:
      1. **応答の切り捨て（非決定的）** — PR #234 / probe #236 で応答 773〜848 文字、
         末尾が文字列の途中で切れる（閉じ引用符・閉じ波括弧・閉じフェンスなし）。
         ただし probe #237 では **prompt 187,878 文字の完全な diff で応答 2,087 文字が完結し APPROVED**。
         つまり閾値ではなく**確率**であり、「大規模 diff は分割必須」とは言えない
      2. **責務境界のずれ** — `metaReviewFallbackRouter.ts` は
         `callGeminiWithFallback` が throw しない限り成功として返し、parse は
         `autoReview.ts` で **chain の外**で行われていた。よって truncated / malformed でも
         fallback へ戻れず、その場で fail-closed BLOCK していた。
         fallback 条件が狭いのではなく、**成功判定の位置が間違っていた**

      **修正（2026-09-17。CEO 明示指示により CONTROL REPOSITORY を編集。`geminiClient.ts` は強制 Guard 対象のため不変）**:
      - provider attempt の成功条件を「text が返った」から
        **「valid な formal verdict が成立した」**へ変更（`validateResponse` を router へ注入）
      - 不成立は既存 taxonomy の `transient` として、**既存の bounded retry → 次 stage → Copilot** へ流す。
        新しい retry 機構・routing subsystem・chunking は作っていない
      - **判定の中身では分岐しない。** APPROVED / CHANGES_REQUESTED / BLOCKED はどれも成立で chain 終了。
        review shopping は構造的に起きない（回帰テストで固定）
      - agy が PATH に無ければ spawn せず skip（実測: CI は毎回 `spawnSync agy ENOENT`）

      **Copilot fallback は CI で認証できていなかった（2026-09-17 実測）。**
      2026-08-28 の `7b5fc2c` で production の認証を ai-team の保存済み OAuth credential へ
      一本化した際、**GitHub Actions の使い捨て runner には該当 credential が無い**ままだった
      （`No authentication information found.`）。quota 枯渇が起きていなかったため誰も気づかなかった。
      GitHub Actions のときだけ job token を渡すよう修正し、**CI で認証成功を実測**
      （`AUTH_OK`、model `mai-code-1.1-flash`）。**PAT は復活させていない。**

      **観測（既存 CI ログのみ。新 Telemetry backend なし）**: `[metaReview] attempt {...}` を
      成功・不成立の両方で出す。段 / provider / model / failureClass / prompt 長 / 応答長を含み、
      応答本文・prompt 本文・token は出さない。これにより Meta Review 総数 / 段別失敗数 /
      truncation 件数 / Copilot fallback 発動数・成功数 / 最終 BLOCK 数を後から数えられる。

      **【2026-09-17 production 実測で見つけた regression と、その恒久対策】**
      #241 で追加した観測ログが **Design Review runner の stdout プロトコルを壊していた**。
      `designReviewRunner.ts:136` は stdout を JSON channel として使い、coordinator は
      `JSON.parse(execution.stdout)` する。`geminiRouter.ts` / `metaReviewFallbackRouter.ts` は
      **autoReview（stdout = 単なるログ）と designReviewRunner（stdout = プロトコル）の両方**から
      読み込まれるため、`console.log` で出した診断行が JSON に混ざり、本番の Design Review が
      `runner returned unparsable output` で失敗していた（production SHA 5d88047 の時点で既に潜在）。

      **検出したのは Principle Management の production Operational E2E である。** CI でも
      ローカルテストでも出ず、実際に runner を本番で走らせて初めて表面化した。

      **恒久対策は文章ではなくテストにした**（`observation-closes-loop`）: 該当 4 箇所を
      `console.error` へ移したうえで、`runnerStdoutProtocol.test.ts` が runner の読み込む
      モジュール（geminiRouter / metaReviewFallbackRouter / copilotRouter / strategicReview / runner）に
      `console.log` が入ったら落ちるようにした。**再評価条件は「このテストが落ちたとき」であり、
      人の記憶に依存しない。**

      **将来の Model Router との関係**: Copilot より後段の provider routing は本項目では作らない。
      `role-model-registry` が Model Router の owner であり、そちらが実装された時点で
      **Meta Review の post-Copilot fallback もその適用対象とする**（同項目の受入条件に統合済み）。

      **事象2（二点間 diff による phantom deletion）の実例も同時に観測した（2026-09-17）**:
      PR #234 の1回目（base `7bd180a`）で Gemini は「follow-up 機能が削除されている」と指摘したが、
      これは **#233 の追加を削除と読んだ phantom deletion** だった（PR の head が base より古く
      二点間 diff になっていた）。最新 master へ rebase した2回目では**この指摘は消えた**。
      したがって事象2 は rebase で回避でき、三点間 diff 化の優先度は下げてよい。
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

<!-- roadmap:id=independent-review-verdict-instability state=planned -->
13. [ ] **Safety / Authority 変更に対する Independent Review の判定が安定しない** — 2026-09-14登録
      （CEO 指示により独立 Finding として記録）。**本項目は記録であり、今は実装しない。**

      **上記 `meta-review-structured-output-robustness` とは向きが逆である。** あちらは
      parse 失敗・phantom deletion による **false BLOCKED**（安全側へ倒れる誤り）を扱う。
      本項目は **critical な Authority 指摘が再実行で消える**（危険側へ倒れうる誤り）を扱う。
      同じ Meta Review 経路の改善であり、**新しい Reviewer・新しい Review 基盤・新しい merge gate は
      追加しない**。実装時は当該項目と一緒に扱い、重複実装しない。

      **実測（PR #181・2026-09-14）**:

      | run | commit | 判定 | 指摘 |
      |---|---|---|---|
      | 1回目 | `8429d93` | **BLOCKED / critical** | 「`rekick_design_review` の up-front Gate 削除は**AI のコアな権限境界（Cage）の変更**にあたる。CEO の明示的承認を得るまでブロック」 |
      | 2回目 | `50b9226` | **APPROVED / medium** | 「既存 Mandatory Gate Policy と安全原則を遵守しており、**Cage の弱体化は見られません**」。Gate 変更への言及自体が消えた |

      2つの commit の差は **`.env.example` へ環境変数2件を追記しただけ**（1回目の medium 指摘への対応）で、
      **Gate 変更の差分は一字も変わっていない**。それでも critical な Authority 指摘が消え、
      要約は正反対の結論になった。

      **なぜ重要か**: `AGENTS.md` 3-1 は「required checks PASS ＋ **独立レビュー PASS**」を
      AI が merge してよい条件にしている。同じ権限境界変更に対する判定が実行ごとに反転するなら、
      **この merge 条件は想定された強度を持たない**。とくに危険なのは、BLOCKED を受けた AI が
      無関係な指摘を1つ直して再実行するだけで APPROVED を得られてしまう経路である
      （今回は意図せずその経路を踏み、CEO へ明示的に判断を求めることで回避した）。

      **今回の扱い（CEO 判断・2026-09-14）**: `rekick_design_review` の Gate 方針は
      **CEO 判断としてその場で確定**した。したがって本 Finding を理由に #181 を無期限に止めない。
      Safety / Authority 変更に対する判定安定性の改善が必要かは**別途評価する**。

      **着手時に確認すること（実装方針を先に決めない）**:
      - 判定のブレが provider の非決定性（temperature / model 版）か、prompt 側の入力差
        （`.env.example` 追加で diff 構成が変わったこと）か、どちらに由来するか
      - Safety / Authority に触れる差分だけを**決定的に**判定できるか
        （例: `ALWAYS_FORBIDDEN_PATTERNS` / `ACTION_GATE_TABLE` / `guards/` の変更検出は
        LLM ではなく機械的ルールで先に拾い、LLM の判定に依存させない）
      - 既存の `reviewLoadClassifier` / `runMechanicalGate` が同じ役割を果たせないか
        （**新しい分類器を作る前に既存の再利用を確認する**）

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

      **2026-09-15 repository 腐敗監査によるスコープ追記（新規 item は作らない）**:
      本項目が未接続である結果として、**Design Philosophy が実行中の Developer AI へ届く経路が
      現在 1 本も存在しない**ことが判明した。3 つが重なっている:
      (1) 本項目のとおり Context Pack 自体が implement 経路へ未接続、
      (2) 仮に通しても `buildInstruction()`（`apps/api/src/ctoAi/contextManager.ts`）は
      `projectMemory.goal` しか描画せず `designPhilosophy` を**一度もレンダリングしない**
      （`ContextPack` response object には載る）、
      (3) `projectMemoryWriter.ts` は番号付きリスト `N. **...**` を書くのに
      `contextManager.ts` は `- ` / `* ` の bullet しか受け付けないため、
      `summary.designPhilosophy` は**生成ファイルでも本 repository 自身の
      `design_philosophy.md`（`## N. ...` 形式）でも常に `[]`** になる。
      `CLAUDE.md` は「Developer AIはProject Memoryを直接読まない / Context Pack経由でのみ
      情報を参照する」と規定しているので、現状はその保証が未提供という状態である。
      **接続時の受入条件へ (2)(3) を含めること**（いずれも既存関数の修正で足り、新規機構は不要）。
      関連: `docs/project_memory/design_philosophy.md` は CLAUDE.md §3 の 8 原則のうち
      **#8「効果検証可能性」を欠いている**。この差分は alignmentChecker が読む正本側にあるため、
      下記「Repository 腐敗監査 由来の Finding」節の docs sweep で扱う。
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

      **2026-09-13 訂正（stale ledger の是正。挙動変更なし）**: 上記本文の
      「`recoverStaleJobs()` が起動時に全Projectの running Job を無条件 failed にする」は
      **PR-C 以前の記述であり、現在は事実ではない**。現行の `recoverStaleJobs()`
      （`jobStateManager.ts:138-183`）は Project / Task を走査するが、実際の処理は
      **per-job** の `reconcileRunningJobAtStartup(job)` で、
      `verifyWorkspaceAgainstBaseline(job.safeCommand.workingDir, job.workspaceBaseline)` により
      検証し、検証できない場合は quarantine する（無条件 failed ではない）。
      同じ stale な記述が `project-auto-worker-trust-boundary`（done）本文にも残っているが、
      そちらは**完了時点の調査記録**なので履歴として保持し、書き換えない。
      本項目が扱う真の欠落（`jobs` schema の `working_dir` lease / active-owner 制約が無いこと、
      queued 取得と `running` 更新が非 atomic であること）は上記のとおり変わらない。

      **2026-09-13 追記（依存関係）**: 本項目の前提は `project-workspace-isolation` である。
      Project 単位で workspace が分離されるまで、複数 Worker は同一 workspace を奪い合う。
      分離後も**単一 Worker 前提と `flock -n` は維持する**（`project-workspace-isolation` の
      スコープ外と明記済み）。本項目は `deferred` のまま据え置く。
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
      - **Improvement Planner の入力に `principle_sensor` を含める**（2026-09-17 追記）。
        `principle-quality-sensor-to-review` が `audit_log`（`entity_type='principle_sensor'`）へ
        「原則自体の再Review候補」を発火させている。現在の受け皿はその行と
        `GET /api/principles/stats` だけで、**同項目は done なので誰も見に来ない**。
        原則側に別の改善エンジンを作らないための片割れであり、ここに書いていないと
        発火した候補がそのまま埋もれる
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

      **2026-09-17 追記（重複防止）**: 原則自体の品質劣化シグナル
      （CONFLICT 率・UNCERTAIN 率・Reviewer 判定不一致・未使用原則）も、
      **本項目の Improvement Planner → CEO Proposal 経路を再利用する**。
      `principle-quality-sensor-to-review` 側に別の改善エンジンを作らないこと。
      入力元だけが違い（`principle_applications` table）、改善提案の作り方・出し方は同じである
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
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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

<!-- roadmap:id=codex-last-message-temp-file-in-target-repo state=done -->
0. [x] **Codex `--output-last-message`一時ファイルが対象リポジトリ内に作られる** — **完了（2026-09-15 監査で確認。実装は 2026-09-07/08 に着地済みで state だけが planned に残っていた。`apps/worker/src/aiCli/adapter.ts` の `createCodexOutputCapture()` が OS temp へ `mkdtempSync` し、pre/post の TOCTOU 検査つき。同ファイルのコメントが本 roadmap id を過去の動機として引用している。test: `adapter.test.ts` が capture path が workingDir 外であることを assert）**（2026-09-07登録。
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

   **2026-09-13 追記**: 本項目は `cross-project-state-api`（Review 状態の横断読み出し）に
   **包含される**。単独で着手せず、同項目の受入条件として扱う（重複実装を避けるため）。

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
   **【2026-09-14 追記: CI でも flake するようになった】** 本テストは従来「Windows ローカル固有の
   失敗」として MVP 完成記録に整理されていたが、**Ubuntu の GitHub Actions でも失敗を実測**した
   （PR #173。docs のみの変更で、テスト内容に影響し得ない変更だった）。同日の他 PR では通っている
   ため確定的な失敗ではなく flake である。**CI を不定期にブロックする**ため、本項目の優先度は
   「非決定性を潰す」観点でも評価すること（完了条件に「繰り返し実行しても安定して通る」が既にある）。

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

<!-- roadmap:id=resume-design-review-test-not-hermetic state=done -->
0. [x] **resume 経路のテストが実 LLM レビューの判定に依存していた（非 hermetic）— 完了（2026-09-14）**
   （2026-09-14登録・同日完了。Tier A の restricted env 検証中に production VPS で発見）。

   **重要な訂正**: 本項目は当初 `design-review-provider-unavailable-fail-open` として
   「Review provider が使えないと resume の Design Review gate が fail-open する」**Safety defect
   として登録したが、その診断は誤りだった**。実測で runner の raw 出力まで確認した結果、
   **fail-open は起きていない**。誤った Finding を ledger に残さないため、本項目へ差し替える。

   **実際に起きていたこと（runner の raw stdout を実測して確定）**: restricted env でも
   Design Review runner は正常に完了し、**実在の LLM が本物のレビュー結果 `ALIGNED` を返していた**
   （`focusedReviewResults: [{focus:'scope_simplicity', decision:'ALIGNED', summary:'The proposed
   design maintains scope discipline and MVP simplicity...'}]`、`stderr` 空）。
   review が ALIGNED なら evidence が登録され resume が成立して 201 を返すのは
   **route の設計どおりの正しい挙動**である。

   full env では同じ review が `UNCERTAIN` を返し 409 になっていた。つまり
   **env によって LLM の判定が変わっていただけ**で、安全機構は両方とも正しく動作していた。

   **真の欠陥はテスト側**: `apps/api/src/routes/jobs.test.ts` の `buildApp()` が `taskRoutes` を
   **options 無しで register** していたため、resume 経路が `buildDefaultCoordinatorDeps()` に
   fall back し、**実 subprocess を spawn して実 LLM を呼んでいた**。その結果
   「rejects the resume path when no matching Design Review evidence exists」が
   **LLM の気分次第で 409 にも 201 にもなる**状態だった。CI で通っていたのは
   CI に provider credential が無く review が unavailable → UNCERTAIN → 409 に倒れていたためで、
   **偶然の成立**だった。

   **修正**: `jobs.test.ts` の `buildApp()` で `resumeDesignReviewDeps` を注入し、
   「review を完了できなかった」を決定論的に再現するようにした。これにより
   **review が成立しない限り resume させない** fail-closed 契約そのものをテストが固定する。
   注入口（`routes/tasks.ts` の `options.resumeDesignReviewDeps`）は既存で、
   `tasks.test.ts` / `resumeExpiredApproval.test.ts` が既に使っている。
   **新しい仕組み・新しい Gate・production コードの変更はいずれも無い。**

   **fail-closed の確認（コード上。今回の実測で覆るものは無かった）**:
   runner が起動できない / 非0終了 → `!execution.ok` → `finalizeFailure`。
   timeout → 同上（`timedOut`）。出力が壊れている → `unparsable output` で失敗確定。
   focused review が解析不能 → `unavailableFocusedResult()` が `UNCERTAIN`（ALIGNED にしない）。
   independent review が unavailable → `applyIndependentReviewOverride` が安全側へ倒す。
   未知の decision 値 → `strategic-decision-unknown-value-fail-open`（PR #146）で reject 済み。
   いずれも「Review できなかった」と「Review して approve された」を同一視していない。

   **検証**: restricted env（`buildTargetCommandEnv()` と同一の PATH / TMPDIR / LANG / CI のみ）で
   `apps/api` 1222/1222 PASS。同 env で `apps/worker` 1291/1291・`packages/shared` 99/99・
   `apps/mobile` 45/45 も PASS し、**Full Suite 2657/2657** を満たした。

   **教訓**: 実 provider を呼ぶテストは、provider の判定に依存した assertion を置いてはならない。
   既存の注入口があるテストで注入を省くと、CI の「たまたま credential が無い」状態に
   正しさを依存させることになる。

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

<!-- roadmap:id=workspace-dirty-leakage-cleanup state=done -->
0. [x] **terminal 失敗が dirty worktree を共有 workspace に残し、掃除する actor がいない**
   — **完了（2026-09-11, PR #148 / commit `2759a76`）。予防側のみで、治療側は別項目。**
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

   **本項目が閉じた範囲と、閉じていない範囲（2026-09-13 追記）**: 本項目は **予防**
   （escalate 確定時に、その Job に帰属する変更を残さない）だけを閉じた。**治療**
   （既に dirty / quarantine になってしまった Task を復旧する）は別項目である:
   `quarantined-dirty-task-generic-recovery`（quarantine 済み Task の復旧・**open**）、
   `orphan-dirty-workspace-no-owner`（M1-b・帰属不能な orphan dirty・MVP後 defer）、
   および review 失敗経路の予防を担う PR #150 `review-failure-escalation-gap`。
   本項目の done をもって「dirty workspace 問題が解決した」と読まないこと。

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

<!-- roadmap:id=task-allowed-paths-not-normalized state=done -->
0. [x] **task の allowedPaths が正規化・検証されず、絶対パスだと必ず File Change Guard で落ちる**
   — **完了（PR #144 / `c4fcf02` で既に解決済み。2026-09-15 に実測確認して close）**

   **【2026-09-15 close の根拠】** PL がこの項目を自律採用したあと Design Review が `CONFLICT` を
   返したため、下記「対応方針」を実装コードと突き合わせた。結果、**本項目の中心課題は既に解決済み**だった。

   - **対応方針2（絶対パスを task sync 時に検証エラーとして弾く）は実装済み。**
     `nonRelativePathReason()` / `buildNonRelativePathIssues()`
     （`apps/api/src/storage/roadmapTaskValidation.ts`）が、空文字 / POSIX 絶対パス / UNC /
     ドライブレター / `..` セグメント / `./` 接頭辞を弾く。**本項目に載っている実測ケース
     `/workspace/target/test.js` をそのコメントが名指しで引用している。**
     `validateRoadmapTasks()` は**生成経路**（`projectInitialization.ts`）と
     **採用経路**（`roadmapAdoption.ts`）の両方から呼ばれ、テストもある
   - **対応方針1（正規化して workingDir prefix を剥がす）は、実装側が明示的に却下している。**
     同ファイルに「絶対パスを相対へ自動書き換えることもしない（Guard のポリシー入力を
     実質的に広げるため）」と日付つきで書かれている。**採用時の implementationScope は
     この却下済みの案（canonical form への正規化）を含んでいた**ため、Design Review の
     `scope_simplicity` CONFLICT は妥当だった（PL は override せず、判定を支持する）
   - **対応方針3（Guard の block メッセージに allowedPaths を含める）だけが残っている。**
     別項目 `guard-block-message-omits-allowed-paths` として切り出した

   つまり **CONFLICT の2つ目の根拠（より軽い代替がある）は正しく、しかも「代替がある」より強い
   「既に実装されている」だった。** PL の統合判断として本項目を close する。

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

<!-- roadmap:id=quarantined-dirty-task-generic-recovery state=done -->
0. [x] **既に quarantine 済みで dirty な Task を汎用的に復旧する手段が無い — 完了（2026-09-14, PR #166）**
   **【2026-09-14 完了】** 真因は空 dirty baseline（`mode:'dirty', entries:[]`）と clean observation の
   `mode` 不一致で、`baselineEqualsObservation()` が解除要求を必ず 409 にしていたこと。比較前の正規化で修正した
   （`entries` 非空は従来どおり厳密比較 / `startCommitHash` 一致必須 / 実差分があれば解除しない）。
   **production 実測**: stuck していた実 Job `cf259578` で safe observation → quarantine release
   （`quarantineClearedAt` 記録）→ ownership 回復 → resume 可能まで到達した。
   Milestone 記録: `docs/project_memory/decisions/tier_a_self_development_e2e.md`。

   **【2026-09-13 注記】`project-workspace-isolation` は本項目を閉じない。** 分離後も
   1 Project 内で quarantine は発生し、復旧手段が無い状態は変わらない。
   縮小するのは影響範囲（他 Project が巻き添えで停止しなくなる）だけである。

   ---
   **【2026-09-14 production 実測。真因を特定した — 優先度を上げる根拠】**

   Tier A 自己開発 E2E（Project `6d1a5c87` / Task `9adb35e5` / Job `cf259578`）で**実際に発生**し、
   **Mobile 単独では復旧不能**だった。`resumeBlockedTask()` が quarantine を fail-closed で
   拒否するため、CEO はスマホからどの操作をしても先へ進めない。

   **真因（今回初めて特定。従来の「復旧手段が無い」より具体的）**:
   quarantine 解除は `baselineEqualsObservation()`（`apps/api/src/storage/sqlite.ts:210`）で
   永続 baseline と Worker の観測を比較するが、**その先頭が `mode` の一致を要求する**
   （`:214` `if (baseline.mode !== observation.mode) return false`）。

   | | 値 |
   |---|---|
   | 永続 baseline（Job `cf259578`） | `{"mode":"dirty","startCommitHash":"ae7c583…","entries":[]}` |
   | clean な workspace の観測 | `{"mode":"clean","startCommitHash":"ae7c583…"}` |

   `observeWorkspace()`（`apps/worker/src/workspaceVerification.ts:93`）は **worktree が空なら
   `mode:'clean'` しか返さない**。`mode:'dirty'` かつ `entries:[]` を返す経路は存在しない。
   したがって **この Job の quarantine を解除できる観測値は原理的に存在せず**、
   解除要求は workspace が安全でも**必ず HTTP 409（`VERIFICATION_FAILED`）になる**。

   **Worker 自身は workspace を安全と観測できている**。実測ログ:
   `[Recovery] Job cf259578… は安全と観測できたが quarantine 解除申請に失敗（別の起動で再試行）`。
   つまり検証は通っており、**比較の入口で落ちている**。

   **影響は今回限りではない**: `computeWorkspaceBaseline()`（`apps/worker/src/jobRunner.ts:1865`〜）は
   intentionally-dirty Job（`resume:` / `repair:` / `retry:`）に対し、**worktree が空でも
   `mode:'dirty', entries:[]` を記録する**。よって **clean な状態から開始した
   resume / repair / retry Job が quarantine すると、すべて同じ理由で復旧不能になりうる**。

   **最小修正の方向（実装は本項目で行う。Safety Gate 変更のため Independent Review 必須）**:
   比較時に「`entries.length === 0` の dirty baseline は clean と等価」と正規化する。
   **比較時正規化を優先する理由は、既に stuck している永続行を救済できるため**。
   根本側（空なら `mode:'clean'` を記録する）は再発防止として併せて評価してよいが、
   **それだけでは既存 stuck 行を救えない**ので後方互換を考慮すること。
   緩和してはならない条件: `entries` 非空の dirty baseline は従来どおり厳密比較 /
   `startCommitHash` 一致は必須 / その他既存 baseline 条件も一致必須 /
   実際に差分がある workspace は解除しない。
   **新 status・新 Gate・新 Recovery subsystem は追加しない。**

   **関連**: `containment-cleanup-ebusy-quarantine`（今回 quarantine に入った**きっかけ**。
   責務が異なるため別項目。同じ復旧クラスタとして扱うが、1つの PR にまとめない）。
   ---
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

   **解放条件は admission の拒否条件すべてにそろえる（独立レビュー round 3・4・5 の指摘）**:
   `computeWorkspaceBaseline()` が clean を拒否する条件は3つあり、どれか1つでも成立していれば
   次の Task は始められない。manifest の空だけで手放すと、所有者不在のまま後続 Task の
   initial-implement が必ず失敗する。そこで解放条件を次の3つすべてとした:
   1. manifest が空
   2. 進行中の git 操作が無い（`detectGitOperationState()`。manifest を読む**前に**判定される。
      `index.lock` / `MERGE_HEAD` / rebase 途中など）
   3. HEAD を解決できる（`requireCommitHash()` と同じく undefined と空文字の両方を拒否）
   2・3 の確認に失敗した場合も「問題無し」とみなさず保持する（fail-closed）。
   2・3 は manifest が空のときだけ行うので、通常の cycle に追加コストは乗らない。
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

<!-- roadmap:id=m3-final-production-e2e state=done -->
0. [x] **M3 最終 Production E2E（新規 Project・Generator 生成の 2 Task）** — **PASS（2026-09-13）**
   （2026-09-13登録、**MVP-BLOCKING**。これが PASS するまで
   `TEMP_MVP_COMPLETION_POLICY` を削除しない、としていた条件を満たした）。

   **要件**（すべて満たすこと）:
   - 実アプリから新規 Project Start
   - **Roadmap Generator 自身が 2 Task + dependency を生成する**（手動 Task 追加なし）
   - CEO 操作は Approval のみ
   - **手動 resume なし**
   - Task 1 commit → backend continuation → Task 2 implement/review → Task 2 Approval Gate
     まで到達すること

   **2026-09-12〜13 の run は PASS に数えない（CEO 判断）**: Generator が Task を1件しか
   生成せず、Task 2 を手動 `POST /api/tasks` で追加したため。用途を限定し
   「CEO approval 後、手動 resume なしで Task 1 commit まで進める happy-path regression」の
   証拠として記録した。**後半（continuation → Task 2 implement/review）は証明していない**:
   手動追加した Task は `roadmap_active = 0` であり `selectNextContinuableTask()` の
   対象に入らないため、continuation は `next_task_id: null` で終了した。
   記録: `docs/project_memory/decisions/approval_to_commit_happy_path_regression.md`。

   **その run で掘り当てた MVP-BLOCKING 2件は修正済み**:
   `approval-expired-waiting-blocks-resume`（PR #156）と
   `done-task-stale-blocked-job-owns-workspace`（PR #158）。

   **PASS（2026-09-13, Project `ec7d5e1f`）**: 要件6項目すべてを Production で実測した。
   Roadmap Generator が `task-001`（phase 1 / `allowedPaths=["checks.js"]`）と
   `task-002`（phase 2 / `deps=[task-001]` / `allowedPaths=["test.js"]`）を自力で生成し、
   手動 Task 追加は無い。CEO 操作は `approval-20260912-1958c3e1` の承認1回のみ。
   承認後、**Task 1 commit 成功（`8dfaf33`）から Task 2 Approval Gate 到達まで 101 秒**を
   すべて backend 駆動で通過した（continuation `7ae7d9e0` → Task 2 initial-implement →
   review → git_commit blocked → 新 Approval Request `cf65df28` が waiting 一覧に出現）。
   **手動 resume は 0**: `resume:` / `repair:` / `retry:` Job はいずれも 0 件、
   API ログの `/resume` リクエストも 0 件。
   記録: `docs/project_memory/decisions/m3_final_production_e2e.md`。

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

<!-- roadmap:id=orphan-dirty-workspace-no-owner state=planned -->
0. [ ] **M1-b: どの Task にも帰属できない dirty workspace（orphan dirty）を復旧する手段が無い**
   **【2026-09-13 注記】`project-workspace-isolation`（Project 単位 workspace 分離）は本項目を
   閉じない。** per-project 分離が縮小するのは波及範囲（他 Project を巻き込まなくなる）だけで、
   1 Project 内の orphan dirty は残る。本項目を構造的に解消しうるのは
   **per-job worktree 分離（1 Job = 1 worktree）**であり、それは別ステップである。
   （2026-09-12登録、**高優先度・MVP後defer**。M1 を M1-a / M1-b に分割したうちの後半。
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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
   **【2026-09-13 注記】`project-workspace-isolation` は本項目を閉じない。** 分離後も
   1 Project 内の fallback ownership は同じ根拠で判定するため、content identity は依然として
   証明しない。運用境界（active / blocked な target workspace を人間が直接編集しない）も
   Project ごとに同じまま維持する。
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
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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

<!-- roadmap:id=mobile-approval-role-docs state=planned -->
1. [ ] 2種類の承認の役割整理とMobile導線設計 — **Mobile導線は実装完了・文書整理のみ未完**。
   Project単位承認（`/api/approvals/pending`）とTask/Job単位Approval Gate
   （`/api/approval-requests/waiting`）は、統合せず併存させる形で`approvals.tsx`に実装済み
   （一覧取得・承認/却下操作とも動作）。**未完了なのは両者の役割・使い分けの文書化のみ**で、
   これはMVP必須ではなく非ブロッキング（スマホ操作サイクルは現状の併存実装で完結するため、
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**
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

<!-- roadmap:id=temp-mvp-completion-policy-cleanup state=done -->
1. [x] **`TEMP_MVP_COMPLETION_POLICY cleanup`** — **完了（2026-09-13）**。MVP完成宣言の**直前**に、期限付き方針
      `TEMP_MVP_COMPLETION_POLICY`（`AGENTS.md` 0章 と `CLAUDE.md` 冒頭のポインタ段落）を
      共通指示から完全に削除し、repository全文検索で共通開発指示として残っていないことを確認し、
      削除commitをMVP completionに含める。
      **完了条件・手順の正本**: `specs/10_mvp_scope.md` 12章「TEMP_MVP_COMPLETION_POLICY cleanup」。
      **このcleanupが完了するまでMVPを「完成」と記録しない。**
      一時ポリシーの内容を恒久的なDesign Philosophy・一般開発原則へ自動転記しないこと。

      **完了（2026-09-13）**: M3 最終 Production E2E の PASS を受けて実施した。
      (1) `AGENTS.md` 0章を `<!-- TEMP_MVP_COMPLETION_POLICY:BEGIN -->`〜`:END -->` マーカーごと削除。
      (2) `CLAUDE.md` 冒頭のポインタ段落を削除。
      (3) repository 全文検索で、共通開発指示として残っていないことを確認した。
      残存は `specs/10_mvp_scope.md` 12章（cleanup 手順そのもの＝完了記録付き）、
      `docs/project_memory/decisions/` の履歴、本 `tasks/roadmap.md` の完了記録のみで、
      いずれも手順3が明示的に「履歴であり削除不要」としている区分に当たる。
      一時ポリシーの内容は Design Philosophy・一般開発原則へ転記していない。

      **確認方法**: 本項目は箇条書き（`- [ ]`）のため parser から見えず、
      `roadmap check` の自動確認対象に入らない。項目自身の指示どおり**手動で確認**した。
      整形（`- [ ]` → 番号付き）は既存の CEO 判断どおり M4 着手前に行う。

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

      **2026-09-13 進捗**: 本項目の `- [ ]` → `1. [x]` 是正は**完了**（Post-MVP 棚卸しの一環）。
      `pnpm roadmap:check` の報告は **5件 → 4件**へ減った。残る4件はいずれも
      **roadmap.md の編集では直せず parser 側の修正を要する**ため未着手:
      `priority=high` 付き metadata 3件（`ROADMAP_METADATA_REGEX` が `id` / `state` の2属性しか
      受け付けない。line 2203 / 2277 / 3575）と、`roadmap-generation-constraint-compliance` の
      `[~]` 表記1件（`CHECKBOX_LINE_REGEX` が `( |x)` しか受け付けない。line 1855）。
      `[~]` を `[ ]` へ倒すと「進行中」という情報が失われるため、**parser 側で `~` と
      追加属性を受け付ける**のが正しい修正である（`apps/worker/scripts/roadmap/`。テストを伴う
      コード変更のため、roadmap 統合とは別タスクとして扱う）。
      **`roadmap:sync` は依然として実行できず、`PROJECT_CURRENT_STATE.md` の自動生成ブロックは
      stale のままである。** 本ファイルと実装を直接読む場合はその前提で扱うこと。

      **2026-09-14 解消**: `roadmap-parser-metadata-and-checkbox-tolerance`（下記）で
      parser を修正し、残り4件はすべて解消した。`pnpm roadmap:check` は
      **OK（69 items, PROJECT_CURRENT_STATE.md is synced）**で通り、`roadmap:sync` も実行できる。
      上記の「stale のまま」という前提は**もはや成立しない**。

<!-- roadmap:id=roadmap-parser-metadata-and-checkbox-tolerance state=done -->
1. [x] **roadmap parser が追加属性と `[~]` 表記を受理できるようにする — 完了（2026-09-14）**
      （2026-09-14 着手。`temp-mvp-completion-policy-cleanup` が「parser 側の修正を要する」として
      積み残していた4件を解消する項目。**既存 Roadmap 採用機能の前提整備**でもある）。

      **解いた問題**: `ROADMAP_METADATA_REGEX` が `id` / `state` の2属性しか受け付けず、
      ledger で実際に使われている `priority=high` を `invalid_metadata` として弾いていた（3件）。
      `CHECKBOX_LINE_REGEX` が `( |x)` しか受け付けず、進行中を表す `[~]` を
      `missing_checkbox` として弾いていた（1件）。弾かれた項目は `getValidRoadmapItems()` から
      見えず、さらに `roadmap:check` が落ちるため `roadmap:sync` も実行できず、
      `docs/PROJECT_CURRENT_STATE.md` の自動生成ブロックが stale のまま放置されていた。

      **修正（最小・新モデル無し）**:
      - metadata は `id` / `state` の後ろに任意個の `key=value` を許し、**解釈せず素通しする**。
        属性を意味づける新しいモデルは追加していない
      - checkbox は `x` / ` ` に加えて `~` を受理し、既存の `CheckboxState` の
        `unchecked` へ写す。**新しい CheckboxState は追加していない**ため、
        `expectedCheckboxForState()` の「done 以外は unchecked」がそのまま成立する
      - `syncCheckboxLine()` は非 done への更新時に `[~]` を保持する
        （`[ ]` へ潰すと著者が明示した進行中表記を state 更新の副作用で失うため）

      **検証**: `scripts/roadmap/` 24/24 PASS（新規5件: 追加属性1個/複数個、壊れた metadata は
      従来どおり弾く、`[~]` の解釈、`[~]`＋done は従来どおり mismatch、done 更新で `[x]` 化、
      非 done 更新で `[~]` 保持）。実 ledger に対して
      `pnpm roadmap:check` が **OK: 69 roadmap items, PROJECT_CURRENT_STATE.md is synced**。
      `pnpm roadmap:sync` で stale だった生成ブロックを更新済み。

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
      観察データ蓄積を優先する（詳細は`docs/multi_ai_step_review_flow.md` 2-3章）。

      **2026-09-17 追記**: 本項目の「観察と言ったなら後から判断できる状態にする」という要求は、
      機械可読な原則 `observation-closes-loop`（`specs/21`）として登録され、
      core 原則として全 prompt に載るようになった（CEO 指示 2026-09-17）。
      同原則は観察対象・計測値・発火条件・閾値・再評価条件・再評価先・Escalation 条件を
      **同じ変更の中で**書くことを要求する。本項目はその原則の**適用先の整理**であって、
      別の原則ではない。原則本体の管理は
      「Principle 管理（Registry / 適用記録 / Review 統合）」節が担当する
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
- CEO authority（承認権限そのもの）
- Claude PL（判断・委任・統合）
- Goal / Design Philosophy
- Goal / Roadmap / Task orchestration
- Project / Roadmap / Task state
- Approval / Risk Gate（Risk / Approval Policy の正本）
- Finding / Repair management
- AI / model routing
- Review policy / Independent Review policy
- Decision history
- Organizational Knowledge / Learnings（`docs/project_memory/` の lessons_learned を含む）
- Project Graph
- Cross-project knowledge propagation
- Project state / business workflow
- 自己改善・運用判断

**将来的にHarnessへ委譲候補とする責務（＝独自実装を競争力と位置付けない）**
- agent process execution
- durable execution
- process-tree containment / termination
- sandbox / VM isolation / code execution
- workspace isolation
- command timeout / cancellation
- child-process cleanup
- Git execution
- crash recovery at execution-runtime level
- execution artifacts / logs
- agent runtime resume（crash / interruption後のexecution resume）
- low-level observability / tracing
- agent deployment
- multi-agent transport / A2A
- session等の一時的runtime state
- low-level filesystem / network permissions

**正本（authoritative source）は外部Agent Platformへ移管しない（2026-09-15追記。正本は
`specs/00_constitution.md` 3.7 Vendor Independence・3.8 Knowledge First）**

上の「残す責務」側は、単に自作を続けるという意味ではなく、**状態・知識・governance・decision history の
authoritative sourceをAIteamOS / AIcompanyOS側に置き続ける**という意味である。外部Agent Platform
（OpenHands / Google Agent Runtime・ADK等）には**executionを委譲してよいが、会社・Projectの正本にはしない**。
判定基準は次の一点に集約する: 外部platformが利用不能になったとき、
**「会社やProjectを再構築する」のではなく「execution backendを交換する」だけで継続できるか**。
できないなら、その責務は委譲候補ではない。

なお `Cost / Revenue attribution` と `Capital allocation` も同様に外部へ移管しない正本だが、これらは
**AIcompanyOS側の責務**であり、本節に挙げることはAIteamOSへ今それを実装する意味ではない
（Business機能をAIteamOSへ持ち込まない既存境界を維持する。本ファイル `cross-project-state-api` の
「AIcompanyOS 互換の最小範囲」を参照）。

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
  → **2026-09-15 監査で、この id が ledger に存在しないことが判明した**（実測 0 件）。
  PL の `adopt_roadmap_item` は ledger 上の id 実在を検証するため、**構造的に採用できなかった**。
  下記「Repository 腐敗監査 由来の Finding」節で正式な item として登録した。


### AIteamOS 自己開発への移行（Stable / Candidate。2026-09-13 CEO 方針・Multi-Project とは別マイルストーン）

**目的**: AIteamOS 自身の残 Roadmap 開発を、外部 Claude / Codex セッション中心から
**Mobile 上の Stable AIteamOS 自身による通常の Roadmap 開発へ移す**。AIteamOS の実運用試験を兼ねる。
**Multi-Project 基盤の完成を待たない。**

**正式 Roadmap は1つだけ**: 正式な AIteamOS Project と正式 Roadmap（本ファイル）は1つのまま維持する。
Candidate は正式な別 Project ではなく、**次バージョンを検証するための隔離された
Disposable Test Environment** である。Candidate 内部の Project / Roadmap / DB はテスト専用でよく、
**正式 Roadmap や運用 state を Candidate 側へ複製・二重管理しない**。
Candidate は必要に応じて破棄・再作成できること。

**最重要の調査結果（2026-09-13）: 自己開発は `project-workspace-isolation` に依存しない。**
production の実配置は Stable のコードが `/srv/ai-team/softwareDevelopAIteam`（systemd
`WorkingDirectory`）、target workspace が `/workspace/target`（**git remote を持たない
使い捨ての E2E Target Project 用 repo**。実プロダクト repo ではない）、API DB が
`/srv/ai-team/data/e2e-ai-team.db`。つまり:

- 自己開発時の running Project は **AIteamOS 自身の1つだけ**なので、
  `ux_projects_single_running` interlock と単一共有 workspace は**そもそも制約にならない**
- `/workspace/target` を **Candidate clone に差し替えるだけ**でよく、コード変更を伴わない
- Stable 自身のコード（`/srv/ai-team/...`）は `isInsideTargetRoot()` が既に書き込みを禁じており、
  **新しい安全機構を足さずに現行の仕組みだけで保護される**

したがって自己開発の切替点は Multi-Project より**大幅に手前**にある。

**Repository / Workspace の選択（PL 決定）: 同一 canonical repository の「別 clone」**。
worktree と別 repository は採らない。
- **worktree を採らない理由**: `.git` を Stable 側と共有するため、Candidate での破壊的テスト
  （下記テスト種別1）が Stable の object store / refs を壊しうる。`rm -rf` で捨てられず
  disposability 要件を満たさない
- **別 repository を採らない理由**: CI / secrets / repository 設定が二重化し、Git 履歴の一貫性が切れ、
  Candidate が恒久的な別 Product に見えてしまう（CEO 方針で禁止）
- **別 clone を採る理由**: `.git` が独立するので破棄・再作成が自由。remote は同一なので
  **Promotion は既存の push → PR → GitHub Actions CI → verified-SHA `--ff-only` deploy を
  そのまま再利用**でき、新規機構がゼロ。Stable の deploy ディレクトリ自体も同 repo の clone であり、
  Candidate はその兄弟 clone になる

**Candidate 検証の2種別（区別する）**:
1. **Synthetic / Destructive Test** — テスト専用の Project / Roadmap / DB を使い、
   dirty workspace・quarantine・provider failure・stuck state・他 Project への不正アクセス等を
   意図的に発生させてよい環境
2. **Upgrade Compatibility Test** — 本番 state / DB の**安全な snapshot コピー**を
   Candidate 専用環境へ複製し、migration・startup reconciliation・resume・既存 state 互換性を確認する。
   **Candidate から本番 DB / 本番 runtime state を直接操作してはならない**
   （snapshot は既存の `ai-team-db-backup.service` を再利用する。新しい backup 機構は作らない）

<!-- roadmap:id=roadmap-item-adoption state=done -->
0. [x] **正式 Roadmap の1項目を実行可能な Task として採用する最小経路 — 完了（2026-09-14）**
      （Tier A Operational E2E の前提。`POST /api/projects/:id/roadmap-adoptions`）。

      **解いた問題**: Project が Roadmap を得る唯一の手段が「生成」だったため、
      `tasks/roadmap.md` という**既に存在する正式 Roadmap** を持つ AIteamOS 自身の Project を
      開始できなかった。`paused → running` にすると `hasActiveRoadmap=false` のため
      `kickProjectStart()` が走り、`roadmapWriter` が `docs/roadmap.md` と
      **実在の `tasks/task_graph.md` を上書きして commit** してしまう。

      **設計**: ledger 全体を Task 化しない。Roadmap は Finding・設計メモ・deferred 項目・
      調査記録を含む**長期台帳のまま維持**し、「PL が次に実装すると決めた1件だけ」を
      実行可能な Task specification へ具体化して採用する。

      **PL が明示するもの（ledger の散文から推測しない）**: `allowedPaths` と
      `acceptanceCriteria`。実行時の安全境界と完成判定そのものであり、空なら fail-closed で拒否する。

      **既存情報から決まるもの**: `roadmapTaskKey` = `roadmap:id`（追跡可能性）、
      `title` と `description` = ledger から取得。
      **固定 default**: `assignee='developer_ai'`（`selectNextContinuableTask()` と初回 Implement Job の
      eligibility が要求するため実質1択）、`category='implementation'`、`dependencies=[]`、
      `phase=1`（単一固定 Phase。ledger へ Phase 体系を導入するものではなく、
      `GET /api/projects/:id/roadmap` が Phase 単位で返すため Mobile から見えるようにする最小措置）。

      **再利用した既存機構（新規は作っていない）**: `roadmapParser`（`getValidRoadmapItems` が
      ledger の不整合で throw する = fail-closed）、`validateRoadmapTasks` /
      `validateRoadmapPhases`（allowedPaths の repository-relative 検証を含む）、
      `syncRoadmapTasks`（`roadmap_task_key` キーで冪等）、
      `ensureInitialWorkflowsForActiveTasks`（採用直後に初回 Implement Job を作る）。
      **新しい adoption state / 管理テーブル / Task status / Project status は追加していない。**

      **累積集合を持たない根拠（実装を確認して決定）**: `syncRoadmapTasks` は入力に無い既存
      roadmapActive Task を非活性化するが、次 Task 選択の `selectNextContinuableTask()` は
      `status === 'pending'` を要求するため**完了済み Task はそもそも候補にならない**
      （`roadmapActive` の値によらない）。よって「直前に採用した1件だけが roadmapActive」で
      continuation・resume・履歴はすべて成立する。累積集合を管理する仕組みは作らない。
      ただし **0件同期は禁止**（全非活性化 → `hasActiveRoadmap=false` → 次の running 遷移で再生成）。

      **確認した不変条件**: Roadmap を再生成しない（LLM を呼ばない）／
      `docs/roadmap.md`・`tasks/task_graph.md` を書かない（`roadmapWriter` を使わない）／
      `roadmap:id` と Task の対応が追跡できる／`allowedPaths` と `acceptanceCriteria` が必ず明示される／
      同じ `roadmap:id` を重複実行しない（Job 実行済みなら `ALREADY_EXECUTED`）／
      `done` 項目は再実行しない／adoption 失敗時は Task を作らない（fail-closed）／
      採用後は `hasActiveRoadmap=true` になり pause/resume で再生成へ戻らない。

      **検証**: `roadmapAdoption.test.ts` 15/15 PASS、`apps/api` 全体 1230 passed。

      **【2026-09-14 production 実測。後続改善の評価対象】**
      Tier A 自己開発 E2E で本経路を初めて実運用し、**採用そのものは設計どおり動いた**
      （Roadmap 再生成なし / `tasks/task_graph.md` 無変更 / `hasActiveRoadmap=true` /
      `roadmap:id` と Task の対応が追跡可能）。一方で **Task specification の質に問題が出た**。

      **事象**: description は ledger 項目の**本文全文**になる。採用した
      `continuation-reconcile-nonblocking-followups` は**項目1と項目2の2つ**を含み、本文の冒頭が
      項目1（`reconcileTaskContinuations` の full-table scan → `findRunning()` 化）で占められていた。
      `acceptanceCriteria` で「項目1は対象外」と明示していたにもかかわらず、実装 AI は項目1にも着手し、
      `allowedPaths` 外の `apps/api/src/routes/taskContinuations.ts` を変更して
      **File Change Guard に停止させられた**（安全機構としては正しく作動。workspace も自動 revert された）。

      **回避できた**: Mobile の「追加指示して再開」で対象を項目2へ絞り、変更禁止パスを明示したところ、
      2回目は**スコープ内2ファイルのみ**の正しい実装になった。よって**本項目は E2E blocker ではない**。

      **評価する最小改善（本項目の後続。基盤修正より後でよい）**: 採用時に、選択した `roadmap:id` とは別に
      **その実行時の implementation scope を PL が明示できる**ようにする。案としては採用 API へ任意の
      `implementationScope` を追加し、description は ledger 全文のまま、プロンプト上のスコープだけを
      上書きする形が最小。**ledger 側へサブ項目の構造化（A-1 相当）は持ち込まない。**

<!-- roadmap:id=aiteamos-self-development-tier-a state=done -->
1. [x] **Tier A: 自己開発の最初の安全な切替点 — 完了（2026-09-14）**
      **Milestone: AIteamOS Self-Development Tier A Operational E2E Complete。**
      Project `AIteamOS Post-MVP Development`（`6d1a5c87`）で、AIteamOS 自身が正式 Roadmap 項目
      `continuation-reconcile-nonblocking-followups`（項目2）を実装 → validation → Independent Review
      → commit（`78220e6`）まで完走した。PR #169 → master `8571dd0`。CEO 操作は承認1回のみ、
      人間が書いたコードは0行。**Project は完了扱いにせず running のまま継続する。**
      詳細な snapshot: `docs/project_memory/decisions/tier_a_self_development_e2e.md`。
      **移行後の第一選択**: typecheck / test / CI / Independent Review で正しさを示せる変更は Mobile。
      **まだ外部セッションが必要**: push / PR（`worker-restricted-remote-publish`）、採用 API の実行
      （Mobile UI 未実装）、Tier B 変更、production deploy。

      **これが「最短地点」である。**

      **成立根拠**: 外部 Claude / Codex セッションが今まさに行っている AIteamOS 開発も、
      第2の AIteamOS インスタンスを起動してはいない。編集 → typecheck / test →
      Independent Review → commit → PR → CI → deploy で回している。Stable の Worker には
      この一連を実行する機構が**すべて既にある**（`CommandKind` の `typecheck` / `test` / `lint` /
      `build` / `git_commit`、Independent Review、Approval Gate、File Change Guard）。
      よって **typecheck / test / CI / Independent Review で正しさを示せる変更**は、
      Candidate runtime 無しで自己開発できる。

      **Tier A に必要なもの（いずれも小さい。新規サブシステムなし）**:
      - [ ] `/workspace/target` を Candidate clone（同一 canonical repo・同一 remote）へ差し替える。
            運用手順であってコード変更ではない
      - [ ] `AGENTS.md` §1「ワークツリー境界」の **文言明確化**（緩和ではない）。
            「Control Repository」＝**稼働中 Stable インスタンスのコードと state**
            （`/srv/ai-team/softwareDevelopAIteam`・その DB・env）であり、
            「AIteamOS ソースのあらゆる checkout」ではないことを明記する。
            物理強制は現行の `isInsideTargetRoot()` のままで**安全機構は変更しない**
      - [ ] Tier A 対象 Task の `forbiddenPaths` に **CONTROL REPOSITORY 保護対象**
            （`apps/worker/src/index.ts` / `jobRunner.ts` / `guards/permissionGuard.ts` 等）を指定する。
            既存の File Change Guard で表現でき、新機構は不要
      - [ ] Mobile から自己開発 Task を投入して1周する Operational E2E を1回
            （Goal/指示入力 → Task → 実装 → Independent Review → commit → PR）

      **Tier A で扱えない変更（Tier B へ回す）**: Worker / API runtime の挙動そのもの、
      DB migration、startup reconciliation、resume / recovery、guard・claim 経路。
      **`project-workspace-isolation` の S1〜S3 自身がこれに該当する**ため、
      **AIteamOS は自分の workspace isolation を Tier A では自己開発できない**。
      当面この種の変更は外部セッションに残る。

      **既知の品質制約（blocker ではない）**: production VPS では Codex が shell command を
      実行できない（bubblewrap / AppArmor。`codex-sandbox-off-deprecated-landlock` 参照）。
      Independent Review は prompt 埋め込みの diff で成立するため機能するが、
      **周辺コードとの突き合わせができない degraded 状態**である。
      Codex review が通ったことを「Codex が repo を読んだ」証拠として扱わないこと。

      **完了時の CEO 報告（通常の進捗報告に埋め込まない。CEO 指示・2026-09-13）**:
      切替条件を満たした時点で「**AIteamOS 自己開発への移行準備が整いました**」という表題で、
      非エンジニア向けに次を説明する — 何が安全になったか / まだできないこと /
      Mobile AIteamOS から何を入力すれば開始できるか / Stable と Candidate がどう分離されるか /
      問題発生時にどう rollback するか / 外部セッションからどこまで作業を移せるか。

      **移行後の原則**: 以降の AIteamOS 通常 Roadmap 開発は **Mobile AIteamOS 側を第一選択**とする。
      外部 Claude / Codex セッションは、AIteamOS 自体が停止している / Candidate・Promotion 機構が
      壊れている / AIteamOS から自己修復できない / Design Philosophy・CEO 判断が必要、
      といった **AIteamOS 内部で適切に処理できない場合の復旧・監査経路**として残す。

<!-- roadmap:id=worker-restricted-remote-publish state=planned -->
3. [ ] **最小かつ制限された remote 公開能力（push / PR）** — 2026-09-14登録。CEO 方針:
      push / PR を恒久的に人間・外部セッション必須にはしない。**今回の bootstrap に限り
      外部セッションでの push / PR を許容し、本項目で早期に解消する。**

      **現状（実測）**: `CommandKind` は11種（`git_status` / `git_diff` / `git_log` /
      `git_branch_create` / `git_checkout` / `git_commit` / `git_revert` / `typecheck` /
      `test` / `build` / `lint`）で **push は存在しない**。VPS には `gh` 2.97.0 が導入済みで、
      `git ls-remote origin` は credential helper 無しで成功する。

      **既存機能では実現できない理由（確認済み）**: SafeCommand は
      `buildTargetCommandEnv()` の allowlist（`PATH` / 一時ディレクトリ / locale / `CI` のみ）で
      実行されるため、**push に必要な credential が子プロセスへ一切渡らない**。
      これは意図的な設計（secret の唯一の関所）であり、**ここを緩めて解決してはならない**。
      したがって push は SafeCommand の env 経路に相乗りできず、
      Design Review runner と同じく **API 側が明示的に env を構築して起動する専用経路**として
      設計する必要がある。これが本項目を「小さな CommandKind 追加」にできない理由である。

      **能力の定義（自由な git 操作にしない）**: 「現在の Candidate / feature branch を
      canonical origin へ安全に公開し、PR / CI 経路へ進める」ことだけを行う。

      **維持する制約（CEO 指定）**:
      - origin 以外への push 禁止
      - `master` / Stable branch への直接 push 禁止
      - force push 禁止
      - 任意 refspec 禁止（branch 名は server 側で決定・検証する）
      - Candidate / feature branch のみ
      - audit 可能（既存 `audit_log` を使う。新しい台帳は作らない）
      - **credential を Job payload へ渡さない**
      - Stable への反映は PR / CI / verified-SHA deploy のみ

      **PR 作成**: 既存能力は無い。`gh` が導入済みなので、不足分は Tier A に必要な最小
      （branch を push し PR を1本開く）に限定する。**PR の merge 能力は含めない**
      （merge は既存の required checks + Ruleset 経路のままとする）。

      **今回実装しないもの（明記）**: 任意 git コマンドの開放 / merge / release /
      tag 操作 / `safeEnv.ts` の allowlist 緩和 / 新しい secret 配布経路。

      **依存**: Independent Review 必須（secret 境界に触れるため）。
      `aiteamos-self-development-tier-a` の E2E は、本項目の完了前は
      **bootstrap 例外として外部セッションが push / PR を担当**してよい。

<!-- roadmap:id=roadmap-adoption-followups state=planned -->
2. [ ] **Roadmap 採用経路の残作業3件（`roadmap-item-adoption` の後続）** — 2026-09-14登録。
      親項目 `roadmap-item-adoption`（done）は採用経路そのものを実装済み。以下は Tier A E2E で
      実運用して判明した**残作業**であり、親項目の再オープンではなく後続として扱う。

      **【2026-09-15: (1) 実装済み。(2) は未着手のまま】** 採用 API へ任意の `implementationScope` を
      追加し、指定時のみ description の先頭へ「今回実装する範囲」を載せる（ledger 本文はその後に残す）。
      未指定時の description は従来と同一で、**ledger の書式は一切変更していない**。
      `buildAdoptedDescription()`（`ctoAi/roadmapAdoption.ts`）に閉じた純粋関数で、
      回帰テストで指定時・未指定時・空白のみ・ledger 本文の非改変を固定した。

      **本項目を選んだ根拠（production 実測・2026-09-14）**: 同じ欠陥が**2回目**の再現をした。
      `roadmap-adoption-followups` 自身を採用した Task の implement Job が、対象外と明記した
      サブ項目(2)側の `storage/schema.ts` / `storage/sqlite.ts` / `types/task.ts` / `routes/tasks.ts` /
      `storage/roadmapTaskValidation.ts` を変更し、File Change Guard が `fileChangeAllowed:false` で
      停止させた（安全機構は正しく作動し、変更は revert 済み。workspace は clean）。
      **自己開発では抜け出せない欠陥**（Implementer は毎回スコープ外へ出るため）なので外部セッションで実装した。

      **(1) 採用時に implementation scope を明示できない** — description は ledger 項目の本文全文に
      なるため、複数サブ項目を含む項目では対象外まで実装対象と解釈される。E2E 初回で実際に
      `allowedPaths` 外を変更し File Change Guard に停止させられた（安全機構は正しく作動）。
      resume の追加指示で回避できたが、毎回 PL が言い直すのは運用として弱い。
      **最小案**: 採用 API へ任意の `implementationScope` を追加し、description は ledger 全文のまま
      プロンプト上のスコープだけを上書きする。**ledger 側へサブ項目の構造化は持ち込まない。**

      **【2026-09-15 追記: (2) の範囲を実測で拡張する。別項目は立てない】**
      同じ「`retryable` で skip したあと誰も拾い直さない」形が **running な Project でも起きる**。
      実測: 採用時の design review の attempt 1 が失敗 → `createInitialImplementWorkflow()` が
      `design review did not align (requeued)` で retryable skip → その後 attempt 2 が成功して
      evidence が登録されても、**`ensureInitialWorkflowsForActiveTasks()` を再実行する経路が無いため
      初回 Job が作られないまま Task が `task_ready_without_job` で止まる**（外部から採用 API を
      再実行して回避した）。
      したがって (2) の本質は Project status ではなく **「retryable skip の再拾い上げ経路が無い」**ことである。
      最小案も同じ: **既存の `ensureInitialWorkflowsForActiveTasks()` を呼び直せる経路を1つ用意する**
      （resume 分岐に加え、requeue 後の再評価も同じ経路に載せる）。新しい queue / daemon は作らない。

      **【2026-09-18 production 実測: 同じ形が再発し、17 時間止まった。新しい事実は「サービス再起動で解ける」こと】**
      `project-completion-badge-wording-correction` の採用（2026-09-17 08:55:53Z）で
      design review run は `succeeded` になったが **evidence 行が 1 件も残らず、初回 Job も作られなかった**。
      以後 `task_ready_without_job` のまま **約 17 時間**放置され、PL は 18:01 JST に
      `human decision required` で Escalate したあと `idle` を返し続けた。
      **この間 API / Worker は落ちていない**（`systemd` の Stopped/Started は 2026-09-17 17:41 の次が
      2026-09-18 10:29）。つまり **プロセスが生きている限り自力では復帰しない**。
      2026-09-18 10:29 のサービス再起動後、2 回目の design review run（01:49:32Z）が `ALIGNED` evidence を
      残し、初回 Job → review → git-commit まで通って Task は `done` になった。
      **CEO 判断で Job を手動生成した訳ではなく、既存の正規経路がそのまま通った。**

      示唆が 2 つある。
      - **再拾い上げ経路が事実上「再起動」になっている。** 上の最小案（`ensureInitialWorkflowsForActiveTasks()`
        を呼び直せる経路）が無いままだと、復帰手段が運用者のプロセス再起動しかない
      - **止まっている間、PL の採用が止まる。** `maybeAdoptNext()` は `attention` が 1 件でもあれば
        採用しないため、無関係な Roadmap 項目の自律採用も同時に止まる（今回まさにそれが起きた）。
        この項目の優先度は「1 Task が遅れる」ではなく「自律開発ループ全体が止まる」で見るべきである

      **(2) paused / draft の Project へ採用しても初回 Job が作られない** —
      `createInitialImplementWorkflow()` は `project.status !== 'running'` を `retryable` で skip し、
      `PATCH /api/projects/:id` の resume 分岐は `retryPendingContinuationsForProject()` しか呼ばず
      `ensureInitialWorkflowsForActiveTasks()` を呼ばない。`reconcileTaskContinuations()` も
      `task_continuations` 行しか sweep しないため、running 化後に拾い直す経路が無い。
      E2E では採用 API の再実行（冪等）で回避した。
      **最小案**: resume 分岐でも `ensureInitialWorkflowsForActiveTasks()` を呼ぶ。
      **Project lifecycle の変更**なので Independent Review 必須。

      **(4) 上限を超えた planned 項目が PL へ一度も提示されない** — 2026-09-16 実測・登録。
      **【同日対応済み。単純な上限引き上げはしていない】**

      `PL_ADOPTION_CANDIDATE_LIMIT = 40` に対し planned が **55件**あり、`.slice(0, 40)` で
      ledger 後方の **15件が恒久的に不可視**だった。その中には今回の原因項目
      `adoption-does-not-check-implementation-feasibility` 自身、
      `reconcile-evidence-not-fully-machine-verified`、`control-repository-header-vs-enforced-guard`、
      `chatgpt-mcp-inspect`、`operator-chat-mobile` 等が含まれていた。
      **PL がいくら正しく判断しても、見えない項目は選べない。**

      CEO 指示（2026-09-16）により上限を上げるだけの対処はしない（本文を載せるぶん prompt が
      膨らむため）。既存情報だけで解いた:
      - **`priority=high` は常に提示する**（ledger の既存表記をそのまま読む。CEO が付けた優先度を失わせない）
      - 残り枠は**回転窓**で埋める。回転位置は**既存 `audit_log` の採用試行回数**から取るので、
        **新しい state を持たずに全 planned 項目がいずれ候補になる**
      - **新しい selection subsystem は作っていない**（`selectAdoptionCandidates()` は
        既存 candidate 生成の内側の純粋関数）

      **(3) アプリ（Mobile）から追加された Task が採用経路の入口に無い** — 2026-09-15 実測・登録。
      production DB で確認: `POST /api/tasks` で作られた Task `3d8878e9`（「copilotのモデル指定」/
      Project `bb509fee`）は `roadmap_active=0` / `roadmapTaskKey=null` のまま、Job も Design Review run も
      0件で pending に滞留している。手動 Task の既定は `roadmapActive=false`（`storage/interface.ts`）で、
      初回 Job 生成の eligibility（`initialImplementWorkflow.ts`）も `attention` の
      `task_ready_without_job`（`state/systemState.ts`）も `roadmapActive` を要求するため、
      **PL の Observe（`buildSystemState()`）に一切現れず、誰も拾わない**。
      `project-auto-ceo-alignment` は「CEO が修正指示を返す経路は追加開発指示（追加Task作成）」と
      定めているので、その経路が**PL からは見えない**ままになっている。

      **方向性（CEO 指示・2026-09-15）**: 追加 Task を**無条件に `roadmapActive=true` にしない**。
      PL が追加 Task を観測し、**既存 Roadmap 項目へ統合 / 新規 Roadmap item として採用 / 保留・却下**を
      **既存 adoption 機構の延長**（`runAdoptionStep()` / `adopt_roadmap_item` / `ACTION_GATE_TABLE`）で
      判断できる形にする。**新しい task orchestration / queue / 専用 state store を作らない。**

      **境界（重複させない）**: 観測面の語彙は `cross-project-state-api`（`attention`）が owner であり、
      別の検知面を作らない。PL の action 語彙と強制 Gate は `mandatory-gate-policy` / 既存 PL action が owner。
      本サブ項目が持つのは「**追加 Task が採用経路へ入る入口が無い**」ことだけである。

      **着手時に決める（実装方針を先に固定しない）**: 既存 `attention` で表現できるか新しい kind が要るか /
      保留・却下を既存 state（`task.status` / `audit_log`）で表現できるか（**新しい Task status を足さない**）/
      採用時に手動 Task 自身を roadmapActive 化するのか、ledger 項目として採用し直すのか。

      **関連**: Mobile に採用 UI が無く PL が API を実行している点は Known Limitation として
      `docs/project_memory/decisions/tier_a_self_development_e2e.md` に記録済み。
      UI 実装は本項目に含めない（自己開発移行を遅らせないため）。

<!-- roadmap:id=aiteamos-self-development-tier-b state=planned priority=high -->
2. [ ] **Maintenance Lane v0 = Tier B: 自分では触れない変更を、正本を手放さずに管理する** —
      **最優先テーマ（CEO 指示・2026-09-15）**。
      AIteamOS が Task / Review / Gate / Audit / Approval の正本を保持したまま、
      protected file 等に到達する変更を外部実行者へ出して回収できるようにする。

      **本項目が Maintenance Lane v0 の正本である。新しい項目は作らない。**
      元々「Candidate 専用 runtime / DB / Worker」として登録されていた項目に、
      CEO の Maintenance Lane v0 要件を統合した（重複を作らないため）。

      ---

      ### なぜ今これが最優先か（2026-09-15 実測）

      protected file を要する Task に当たったとき、現在の運用は**手動 handoff**になる:

      ```text
      AIteamOS → 外部 Claude → 外部実装 → 外部 Independent Review → merge / deploy
               → AIteamOS へ reconcile
      ```

      この経路は今日 1 往復を実際に完走した（`docs/project_memory/decisions/
      multi_task_continuous_autonomous_development_evidence.md` 第4ラウンド）。
      **成立はしたが、正本が AIteamOS の外にある。** 特に Independent Review の結果は
      外部セッションのローカルにしか無く、reconcile 時には**申告として渡している**だけである。

      ### Goal

      上記 handoff を、**AIteamOS 自身が正本を保持したまま管理できる形**へ変える。
      外部セッションは「AIteamOS が指示した最小差分を実装する実行者」に縮小し、
      判断・記録・承認は AIteamOS 側に残す。

      ### v0 の対象（CEO 提示。これ未満では v0 と呼ばない）

      - **Maintenance 専用 isolated workspace**（通常 Candidate と分離）
      - **通常 Candidate と分離された権限**
      - **production 直接編集の禁止**
      - **exact implementation commit SHA の固定**
      - **その exact SHA に対する Independent Review**
      - **Review 結果を caller 自己申告ではなく正式 record として保存**
      - **reviewer / provider / model / timestamp / reviewed SHA の保存**
      - **CI 結果と commit の紐付け**
      - **canonical master 包含の確認**
      - **Stable 包含の確認**
      - **merge / deploy / Task completion の audit**
      - **完了後の VPS autonomous adoption への自動復帰**

      ### 既存項目との関係（重複を作らないための対応表）

      | v0 要件 | 既存項目 | 扱い |
      |---|---|---|
      | isolated workspace / 権限分離 | 本項目（元の Candidate 専用 runtime）| **本項目で実装** |
      | master 包含・Stable 包含の**独立**確認 | `reconcile-evidence-not-fully-machine-verified` (1) | **既存を消化**。ここで再定義しない |
      | Review 結果の正式 record 保存 | `reconcile-evidence-not-fully-machine-verified` (2) | **既存を消化**。保存先は既存構造の小さな拡張で足りるかを先に見る |
      | Task completion の audit | `external completion reconcile`（実装済み・master `828878a`）| **既存を再利用**。新しい completion 経路を作らない |
      | 完了後の autonomous 復帰 | 実装済み（2026-09-15 実測で復帰確認）| **既存で充足** |
      | protected file の境界定義 | `control-repository-header-vs-enforced-guard` | **依存**。注記と実強制の不一致を先に解消する |
      | Gate 層が Job 経路へ未配線 | `review-gate-layers-implemented-but-unwired` | **別問題**。Maintenance Lane とは独立に進む |
      | Multi-Project の workspace 分離 | `project-workspace-isolation` | **別目的**。Maintenance Lane は 1 Project 内の話 |

      **`Review Class A/B/C` は Roadmap に既存項目が無い**（全文検索で0件）。
      ただし **CEO 指示により v0 には含めない** — 下記「v0 に含めないもの」を参照。

      ### v0 に含めないもの（CEO 指示）

      - **CEO Approval の削減**。Maintenance Lane の**最終実行または promotion については
        CEO Approval を維持する**
      - **Review Class B による CEO Approval 削減**。これは
        **Maintenance Lane v0 の Operational E2E が成立した後**に別途扱う

      ### Bootstrap の進め方（CEO 指示）

      - **VPS AIteamOS 自身で変更できる部分は VPS に実装させる。** 外部セッションが先回りしない
      - VPS が **Safety Boundary / Authority / protected file / Gate・Guard 根幹**へ到達したら、
        **PL は自分で権限を拡張せず、Guard も迂回しない**。**その最小変更だけ**を Tier B として
        外部セッションへ Escalate する
      - 外部 Tier B は**必要最小差分だけ**を実装し、Independent Review / CI / 既存 Gate を通して
        正式経路（`reconcile_external_completion`）で VPS へ返す

      ### 将来の依存低減

      現在 CEO → VPS PL の正式な対話経路が無いため、ローカル Claude セッションを
      **暫定 Control Proxy** として使っている。`chatgpt-mcp-inspect` / `operator-chat-mobile` が
      成立したら、**この Control Proxy 依存を減らせる形**にしておくこと。

      ---

      以下は登録時の技術設計（そのまま有効）。

      Tier A の後。Tier A を待たせない。

      runtime 挙動・migration・startup reconciliation・resume を伴う変更は、テストと CI だけでは
      正しさを示せないため、**Candidate 専用の API / Worker / DB を別ポート・別 DB パス・
      別 systemd user unit で起動**して検証する。上記テスト種別1・2の実行環境がこれにあたる。

      **設計上の制約**: Candidate の Worker は Stable の DB / Outbox / env を参照してはならない。
      既存の systemd user unit 構成（`EnvironmentFile` 分離・`flock` による単一インスタンス強制）を
      複製する形にし、**新しい supervision 方式・新しい container 基盤は作らない**。
      Promotion は Tier A と同じく既存の verified-SHA `--ff-only` deploy を使う。

      **依存**: 「正式Production起動方式の確定」（本ファイル VPS 常駐運用化の節）と整合させる。
      1ユニット=1インスタンス強制の議論はそちらが正本。

**Multi-Project との関係（同一マイルストーンにしない。CEO 指示）**:
自己開発移行は Candidate 分離が成立した時点で先に開始する。
Project #2 の並行開始は別途、`project-workspace-isolation` / Project 内 claim isolation /
Project 間 failure containment / Multi-Project Operational E2E /
`SingleRunningProjectError` の安全な解除が成立した時点で行う。
最終形は Project #1 = AIteamOS（全 Roadmap 完遂まで継続）と Project #2+ = 実事業 / Product を
同時に AIteamOS から開発できる状態。

## CEO優先方針の統合とPL優先順位決定（2026-09-14）

**位置づけ**: 2026-09-14 の CEO 方針10項目を既存 Roadmap へ最小変更で統合し、PL が最終的な
優先順位を決定した記録。**CEO の列挙順を Roadmap 順にしていない**（CEO 指示による）。

**運用原則（item 1）**: 今後の AIteamOS 自身の開発は `tasks/roadmap.md` を Source of Truth とし、
**PL が Roadmap 全体を見て次項目を判断する**。CEO が毎回次 Task を指定しない。新しい CEO 方針・
要求・Finding が出たら Roadmap へ最小変更で統合し、その後は Roadmap ベースの自律開発へ戻る。

### 棚卸し結果（重複を作らないための対応表）

| CEO方針 | 既存項目 | 判定 |
|---|---|---|
| 2. ChatGPT↔MCP | 無し（`MCP` は repo 全体で参照0件） | **新規1件**: `chatgpt-mcp-inspect` |
| 3. Operator Chat | PL Console 4件（deferred。LibreChat 評価等の重量級） | **新規1件**: `operator-chat-mobile`（PL Console は deferred のまま） |
| 4. MCP/Chat 共通基盤 | `cross-project-state-api` | **既存強化**。新 Control subsystem は作らない |
| 5. Remote Publish | `worker-restricted-remote-publish` | **既存**。優先度を上げる |
| 6. Adoption 残作業 | `roadmap-adoption-followups` | **既存**。最優先へ |
| 7. Multi-Project | `project-workspace-isolation` | **既存**。維持 |
| 8. Explainer | `failure-explanation-pregeneration` | **既存**。責務は登録済み |
| 9. Role/Provider/Model | `role-model-registry` | **既存強化**（コスト方針を追記） |
| 10. AIcompanyOS 互換 | `cross-project-state-api` 内の `audit_log.project_id` | **既存で充足**。Business 機能は入れない |

**新規は2件だけ**。他はすべて既存項目の強化・優先度変更で足りる。

### item 4 の結論: 共通基盤は `cross-project-state-api` が担う

MCP 用と Mobile Chat 用に別々の操作系を作らない。両方とも次の1本を消費する。

```text
ChatGPT → MCP adapter ─┐
                       ├→ cross-project-state-api（read）+ 既存API（write）
Mobile Operator Chat ──┘
```

**read 側**: `cross-project-state-api` が Project / Roadmap / Task / Job / blocked 理由 /
quarantine / retry / recovery / Review / Approval / runtime progress / cost を1本で返す。
**write 側**: 既存の `POST /api/tasks/:id/resume`・`PATCH /api/jobs/:id/clear-quarantine`・
`PATCH /api/approval-requests/:id/status` 等をそのまま使う。**新しい Control subsystem を作らない。**

### 横断制約: 従量課金APIを新しい標準経路にしない（CEO 追加指示・2026-09-14）

Operator Chat・MCP・Explainer のいずれについても、OpenAI API / Anthropic API 等の**従量課金 API を
新たな標準経路として導入しない**。既存の provider abstraction と Claude / Codex 等の CLI 実行経路を
再利用する。

**MCP の向き**: `ChatGPT → MCP → AIteamOS Control / State Interface`。
**AIteamOS 側が ChatGPT との接続のために OpenAI API を呼ぶ構造を前提にしない。**
推論は接続元の契約で行われ、AIteamOS は接続口と事実の提供に徹する。
深い分析・判断が要る場合は Control Interface から**既存の PL / Role 実行経路**へ渡す。

**現行実装は既にこの形である**（実測）: 既存 Explainer（`aiExplain/cheapAiClient.ts`）は
OpenCode CLI を spawn しており、`AiCliProvider` も claude_code / codex / gemini / copilot と
すべて CLI 経路。よって本制約は**新しい制限ではなく既存パターンの明文化**である。

**ただし密結合はしない**: 特定 provider / CLI へ固定せず、`role-model-registry` から交換可能な
設計を維持する。将来 API 経路が合理的になった場合も Registry の1エントリとして扱えるようにし、
経路の種別を Role 側へ埋め込まない。

### 優先順位の再評価（2026-09-14 夜・PL不在の実証を受けて）

**上記の順位は下記で置き換える。** 初回の自律 Task 実行で「VPS 上に PL が居ない」ことが
production で実証されたため（`vps-pl-execution-loop` の evidence）、PL 実行基盤を最優先へ繰り上げる。

| 順 | 項目 | 理由 |
|---|---|---|
| **1** | `cross-project-state-api` | PL の Observe の入口。これが無いと VPS 上の PL も判断できない。他の全項目の前提 |
| **2** | `mandatory-gate-policy` | PL に判断を任せる前に**強制境界**を確定させる。既存 Gate の再利用が大半で、不足は薄い Policy Engine 1つ |
| **3** | `vps-pl-execution-loop` | **単一障害点（ローカル PC 依存）の除去**。1・2 の上に載る |
| 4 | `design-review-runner-production-timeout` | 現在の自律開発を実際に止めている。3 の最初の実戦対象にもなる |
| 5 | `operator-chat-mobile` → `chatgpt-mcp-inspect` | 1 の同じ interface を消費。PL へのアクセス経路 |
| 6 | `roadmap-adoption-followups` (1) | 有用だが**PL が居てこそ効く**改善。順位を下げる |
| 7 | `worker-restricted-remote-publish` | 外部依存の除去。PL 基盤の後で十分 |
| 8 | `role-model-registry` → `failure-explanation-pregeneration` | Escalation の説明品質に効く |
| 9 | `project-workspace-isolation` → Project #2 | 最大規模・最高リスク。PL 基盤が整ってから着手する方が安全 |

**`roadmap-adoption-followups` を 1 位から 6 位へ下げた理由**: 採用スコープの改善は「PL が毎回
口頭で言い直す手間」を減らすものであり、**PL が VPS 上に居なければ効果が出ない**。
PL 基盤が先である（CEO 指摘・2026-09-14）。

**Project #2 の約10日目安について**: PL 基盤を先に置くことで見かけ上は遠回りに見えるが、
Multi-Project は「並行する2つの Project を誰が見張るのか」という問題を必然的に伴うため、
PL 基盤なしに Project #2 を開始しても運用が成立しない。**安全性を優先し hard deadline にしない**
という CEO 方針に従う。

**後続項目の位置づけ（2026-09-14 追加・CEO 方針）**: 監視責務の段階分離
（`monitoring-tiering-watchdog-monitor-pl`）は **上表のどこにも割り込ませない**。
3（`vps-pl-execution-loop`）の最小実装と VPS 上の実運用 E2E が完了し、その実測データが出るまで
着手しない。**まず State 取得 → Mandatory Gate → VPS PL 実行ループ → 既存操作の呼び出し →
結果確認 / Escalation → VPS 上での実運用 E2E を完成させる。**
段階分離は VPS PL 本体と責務を分けるが、状態取得・Control Interface・Gate は同じものを再利用する。

### PL が決定した優先順位（**SUPERSEDED — 上の「優先順位の再評価（2026-09-14 夜）」が正本。以下は履歴**）

> **2026-09-15 監査で付記**: 本表は置換済みだが置換後の表より下に置かれているため、
> 上から読むと最後に目に入る。supersede を明示する。

| 順 | 項目 | 理由 |
|---|---|---|
| **1** | `roadmap-adoption-followups` (1) implementation scope | **最小コストで最大の複利**。以後の全採用が使う。Tier A 安全で Mobile が実施できる。E2E で実際に踏んだ欠陥 |
| 2 | `cross-project-state-api` | MCP・Operator Chat・AIcompanyOS 互換の**共通前提**。Tier A 安全。ここが無いと 2/3/4/10 が動けない |
| 3 | `worker-restricted-remote-publish` | 自己開発の**最後の外部依存**を除去。ただし secret 境界に触れるため Independent Review 必須 |
| 4 | `role-model-registry` → `failure-explanation-pregeneration` | Explainer が軽量モデルを選べるようにしてから Explainer 本体。CEO の理解可能性は品質の一部 |
| 5 | `chatgpt-mcp-inspect`（read 中心） | 2 の上に薄く載る。inspect / audit / explain から |
| 6 | `operator-chat-mobile` | 同じく 2 の上。既存 resume / recovery / approval を再利用 |
| 7 | `project-workspace-isolation` → Project #2 | 最大規模・最高リスク。約10日目安だが hard deadline にしない |
| — | `roadmap-adoption-followups` (2) paused/draft の Task 初期化 | Project lifecycle 変更のため Tier B。1 と同時ではなく直後 |

**なぜ 1 が最初か**: Project #1 開始後、あらゆる作業が「Roadmap 項目を採用する」ことから始まる。
現状は ledger 本文全文が description になり、複数サブ項目を含む項目では対象外まで実装対象と
解釈される（E2E 初回で実際に File Change Guard に停止させられた）。ここを直さないと、
**以後の全 Task で PL が毎回口頭でスコープを言い直す**ことになる。最小の変更で複利が最も大きい。

**なぜ Multi-Project が最後か**: 最も価値が大きいが、全 guard の信頼境界に触れる最高リスク変更
であり、他項目への依存も無い。安全インターロック（`ux_projects_single_running`）は
**isolation が実測されるまで解除しない**（CEO 指示・`project-workspace-isolation` の受入条件7）。


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

**→ 決着（2026-09-13, CEO承認済み）**: **後継項目を1件だけ立てる**方を選んだ。
`project-workspace-isolation`（下記 0 番）がこの cluster の実装 owner である。
`project-auto-worker-trust-boundary` は設計項目としては実際に完了しているので
`state=done` のまま触らない。**新しい重複 Finding は作っていない。**

ただし後継項目のスコープは、この handoff が想定していた
**「1 Job = 1 worktree」ではなく「1 Project = 1 workspace」**である。両者は分離可能な
別ステップであり、`project-workspace-isolation` は後者のみを扱う
（理由と、前者でなければ解消しない Finding については当該項目を参照）。

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

<!-- roadmap:id=project-workspace-isolation state=planned -->
0. [ ] **Project 単位 workspace 分離（Multi-Project の前提・最優先）** — 2026-09-13登録。
      上記 cluster の**実装 owner 項目**（`project-auto-worker-trust-boundary` の後継1件）。
      CEO が 4-3 安全境界方針を承認済み。S1〜S3 は通常の Roadmap 開発として進めてよい。

      **解く問題**: 現在すべての Project が単一の `/workspace/target` を共有し、
      `fetchQueuedJob()` が全 running Project の Task を1配列へ平坦化して
      **グローバルに単一の** `resolveWorkspaceOwnership()` を解く。結果、Project A の dirty /
      `ambiguous` / 進行中 git 操作が **Project B を含む全 Project の claim を止める**。
      これは「Multi-Project が未実装」ではなく「**動かすと相互に停止する**」状態である。

      **今それが表面化していない理由（＝着手順序を決めている制約）**: DB の partial unique index
      `ux_projects_single_running`（`schema.ts`）が running Project を1件に制限している。
      この interlock が共有 workspace を現在安全に保っている。**先に workspace を分けずに
      interlock を外すと即座に事故る。** 順序は選択ではなく強制されている。

      **調査で判明した最重要事実（2026-09-13, read-only 調査）**: 実行・recovery 経路は
      **すでに `workingDir` パラメータ駆動**である。`jobRunner.ts` は全面的に
      `job.safeCommand.workingDir` を使い（`436` / `785` / `922` ほか）、
      `computeWorkspaceBaseline(job, workingDir)` / `verifyWorkspaceAgainstBaseline(workingDir, ...)` /
      `detectGitOperationState(workingDir)` / `buildWorktreeManifest(workingDir)` /
      `observeWorkspace(workingDir)` はいずれも引数で受け取る。`resolveWorkspaceOwnership()` も
      第2引数に `workingDir` を持つ。**`TARGET_ROOT` はデータ経路ではなく値の供給元が固定されて
      いるだけ**であり、新しい workspace 管理サブシステムは要らない。

      **`TARGET_ROOT` / `TARGET_WORKING_DIR` 実参照（dist・test 除く）**:
      (A) 検証境界2箇所（`guards/permissionGuard.ts:110`・`aiCli/adapter.ts:393`）、
      (B) デフォルト引数2箇所（`utils/pathUtils.ts:49`・`index.ts:243`）、
      (C) レビュー経路のハードコード3箇所（`approvalLevel/reviewerAdapter.ts:267` /
      `:389`・`metaReviewer/strategicReview.ts:502`）、
      (D) API 側 Job 生成時の値7箇所（`routes/jobs.ts`・`storage/sqlite.ts`・
      `ctoAi/initialImplementWorkflow.ts`・`routes/approvalGate.ts`）。
      加えて `routes/ctoAi.ts:81` が設定値と異なる `targetProjectRoot` を能動的に拒否する。

      **workspace root の決定方式（CEO 安全不変条件・2026-09-13）**:
      **任意 path を永続化しない。** Project ID から server 側で決定的に導出する。
      `projects.id` は `randomUUID()` で **server 生成**・PK・不変・一意であるため、
      導出結果は自動的に「server 側のみが生成」「一意」「作成後変更不可」「client 偽造不能」を満たす。
      - `derived` レイアウト: `join(WORKSPACE_BASE, 'projects', project.id)`
      - `legacy` レイアウト: 定数 `/workspace/target`（既存 Project 用。**移行しない**）
      - 永続化するのは **path ではなくレイアウト選択子**のみ:
        `projects.workspace_layout TEXT NOT NULL DEFAULT 'legacy'`（`'legacy'|'derived'`）。
        新規 Project のみ server が `'derived'` を設定する
      - `workspace_layout` は `CreateProjectBody` / `UpdateProjectBody` のどちらにも追加しない
        （後者は `.strict()` のため未知キーは 400 で拒否される）
      - 解決結果は常に canonical 化し、`WORKSPACE_BASE` 配下であることを再検証する
      - **Job payload（`job.safeCommand.workingDir`）を Source of Truth にしない。**
        Worker は project レコードから独立に解決し、Job の値と**一致するか**を検証する
      → **Project B が Project A の workspace root を指定する余地は構造的に存在しない**
        （導出関数の入力が `project.id` だけであるため）。

      **既知の受容事項**: `legacy` な既存 Project 同士は引き続き同一 root を共有する
      （＝今日と同じ挙動）。これは interlock が running を1件に制限している限り安全であり、
      本項目では移行しない。interlock 解除時の扱いは下記受入条件を参照。

      **安全境界（CEO 承認済み・2026-09-13）**: `isInsideTargetRoot()` の定数境界を
      **2段判定**へ置き換える。
      1. `dir` が `WORKSPACE_BASE` 配下か（偽造不能。現在と同等の強度を維持）
      2. `dir` が当該 Job の Project root と一致するか（**現在は存在しない追加制約**）
      判定1が現行保証を維持し、判定2が Project 間アクセスを新たに禁止する。
      よって境界は緩まず**厳しくなる**。API が `safeCommand.workingDir` を server 側で
      上書きする既存不変条件（`routes/jobs.ts:395`）は維持する。

      **本項目のスコープ外（明記）**: **1 Job = 1 worktree（per-job 分離）は含めない。**
      per-project 分離は波及範囲を1 Project へ縮小するだけで、Project 内の orphan dirty は
      解消しない。`orphan-dirty-workspace-no-owner`（M1-b）・
      `quarantined-dirty-task-generic-recovery`・`workspace-ownership-content-identity` は
      **本項目では閉じない**（per-job worktree 側の課題）。
      複数 Worker 対応も含めない（`project-auto-multi-worker`。単一 Worker 前提と
      host の `flock -n` は維持する）。

      **2026-09-13 追記: 自己開発移行は本項目に依存しない（同一マイルストーンにしない）**。
      AIteamOS 自身の自己開発は running Project が1つで足りるため、interlock も共有 workspace も
      制約にならない（根拠は `aiteamos-self-development-tier-a`）。本項目の完成を
      **自己開発移行の前提条件にしないこと**。
      逆向きの依存だけが存在する: **本項目の S1〜S3 は guard・claim 経路を変えるため
      Tier A（typecheck / test / CI / Review で示せる変更）では自己開発できず、
      Tier B または外部セッションが担当する**。

      **廃止する既存機構は無い**。admission（`computeWorkspaceBaseline`）・quarantine・
      startup reconciliation・M1-a fallback・#158 の stale-blocked 解放判定は、
      1 Project 内でも同じ理由で必要であり全て残す。変わるのは適用範囲
      （全体で1つ → Project ごとに1つ）だけである。

      **段階導入（各段階で前段へ rollback 可能）**:
      - **S1**: `workspace_layout` 列を additive に追加（誰も読まない・誰も書かない）。
        旧コードは列を無視するため rollback 互換
      - **S2**: 解決関数を導入。既存 Project は全て `'legacy'` のため
        **全員 `/workspace/target` に解決＝本番挙動ゼロ変化**
      - **S3**: 2段ガード・レビュー3経路・`fetchQueuedJob()` の claim ループを変更。
        **2つ目の Project はまだ作らない**。`ambiguous` 時の `return null` を
        `continue` へ変えるのが Project 間波及を断つ本質的な差分
      - **S4**: 検証環境で2つ目の Project を作り下記 E2E を実施（本項目の完了条件）
      **S3 までは本番挙動が変わらない**（全 Project が `'legacy'` に解決されるため）。
      これが最大の安全弁である。

      **S3 の必須検証（CEO 指示・省略しない）**: 既存単一 Project の regression、
      Independent Review、Runtime / E2E、deploy canary。Guard と claim 経路そのものが
      変わるため、「挙動互換だから省略してよい」とは扱わない。

      **Project 間非波及 E2E（検証環境。A=既存 legacy / B=新規 derived）**:
      - E2E-1: A の workspace を dirty で放置 → A 停止・**B は claim して完走**
      - E2E-2: A を quarantine → A は fail-closed 維持・**B 無影響**
      - E2E-3: A に `index.lock` / `MERGE_HEAD` を残す → A の admission fail-closed・**B 無影響**
      - E2E-4: A を承認待ち blocked で放置し B で commit して HEAD を進める →
        A の帰属判定が B の HEAD 移動で壊れない（別 workspace のため構造的に不可能なことを確認）。
        **現行設計で最も起きやすい相互破壊がこれ**
      - E2E-5: B の Job が A の workspace path を指す偽造 Job → Permission Guard が拒否（判定2）

      **`SingleRunningProjectError` 解除の受入条件（解除は本項目と分離した後続変更）**:
      1. S1〜S3 完了、既存 Project が無変更で動作すること
      2. 2段ガードが Project 間アクセスを拒否することをテストで固定
      3. レビュー3経路が subject の Project root を使うこと
      4. claim の ownership 判定が Project 内で閉じること
      5. E2E-1〜5 が実測 PASS
      6. 単一 Worker 前提を維持（`flock -n` はそのまま）
      7. 解除時は `ux_projects_single_running` を**撤廃ではなく縮小**する:
         「running な `legacy` Project は最大1件」へ置き換える。`derived` Project は無制約。
         legacy 同士の root 共有という受容事項が、解除後も破られないようにするため
      **上記が全て満たされるまで interlock は維持する（CEO 指示）。**

<!-- roadmap:id=execution-runtime-harness-bakeoff state=planned -->
1. [ ] **Harness Bake-off / Execution Runtime Evaluation（CEO HOLD: 明示解除まで着手しない）** —
      High-priority Recovery修正が一段落した後、
      **新規機能を増やす前に**実施する評価項目。第一候補としてOpenHands等のvendor-neutral /
      self-host可能なHarnessを評価するが、**特定ベンダー前提にはしない**。評価候補には
      **self-host型Harness（OpenHands等）と managed Agent Platform（Google Agent Runtime / ADK 等）の
      両方**を含める（後者の評価条件は本項目後半の「外部managed Agent Platform…」節を参照）。

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

      **外部managed Agent Platform（Google Agent Runtime / ADK 等）の評価（2026-09-15・CEO指示で本項目へ統合）**

      目的が本項目と同一（**低レベルexecution layerだけを差し替え可能にする**）なので、新規Roadmap項目を
      作らず本項目へ統合する。検証したいのは、以下の**非コア領域を今後自前開発・強化せず外部Agent Platformへ
      委譲できるか**である: agent runtime / durable execution / crash・interruption後のexecution resume /
      sandbox・code execution / low-level observability・tracing / agent deployment /
      multi-agent transport・A2A / session等の一時的runtime state。

      **移管しない正本**は本ファイル「Execution Runtime Boundary」節の「正本（authoritative source）は
      外部Agent Platformへ移管しない」に従う（Project / Roadmap / Task state / Goal / Design Philosophy /
      Risk・Approval Policy / CEO authority / Independent Review policy / Decision history /
      Organizational Knowledge・Learnings / Project Graph / Cost・Revenue attribution / Capital allocation /
      Cross-project knowledge propagation）。同じ内容を本項目に再掲せず、境界の正本は1箇所に置く。

      **これはAIteamOSをGoogleへ移行するTaskではない。** 現在のproduction AIteamOS / Worker / Recovery /
      Project State を置換・変更しない。最初は**完全に隔離した評価**として実施する。

      - **Phase 1: Shadow Evaluation** — 既に完了済みの代表的Taskを使い、同等入力をGoogle側runtimeで
        再実行する。**production repositoryへのwriteは禁止**。AIteamOSの既存execution pathは変更しない。
        結果は比較評価のみ。評価項目: task完遂能力 / 長時間実行 / interruption・resume / cancellation /
        failure handling / observability / cost / latency / Independent Reviewとの接続容易性 /
        vendor lock-in / Google停止時の代替可能性。
      - **Phase 2: Isolated Runtime Evaluation** — Phase 1で有望だった場合のみ、**専用test repository /
        disposable project**で検証する: execution / intentional crash / restart・resume / approval待ち /
        cancellation / duplicate execution防止 / state recovery / failure visibility。
        上記の障害再現リスト（agent強制終了・descendant残存・dirty workspace 等）もこのtest repositoryに対して
        適用する。**production Projectは使用しない。**
      - **Phase 3: Optional Backend Evaluation** — Phase 1・2で既存runtimeより**明確なメリット**が確認できた
        場合のみ検討する。既存execution境界を維持したまま `current executor` / `google executor` を選択可能に
        する。**defaultは `current executor` のままとし、Googleをproduction defaultへ変更しない。**

      **着手条件:** 現在優先しているAIteamOSのproduction運用安定化・MCP監査（`chatgpt-mcp-inspect`）・
      Blocked / Resume 系を妨げないこと。具体的には `cross-project-state-api` / `mandatory-gate-policy`
      （いずれも in_progress）等の進行中項目が一段落した後、**または** production Projectに触れない独立した
      検証環境で安全に実行可能になった時点で着手する。本項目の追加自体では既存production実装を変更しない。

      **この着手条件は機械的に強制されない（2026-09-15 実装確認）。** PL の採用候補は
      `readAdoptionCandidates()` が `state !== 'done'` で絞るだけであり、`deferred` / `blocked` へ変えても
      採用は妨げられない。`checkRoadmapItemAlignment()` も「ledger に実在し done でない」ことしか見ず、
      ledger には優先度・依存関係を機械判定する metadata が無い（`priority=` は parser が
      **解釈せず素通し**し、PL の選択プロンプトにも渡らない）。本項目の title に着手条件を併記しているのは、
      選択時に PL へ届く項目単位の情報が `id — state — title` だけだからであり、
      **enforcement ではなく選択時の判断材料**である。**この抑止のためだけに state を変更しない。**

      **Yellow Zone（CEO承認が必要な範囲）:** Google / GCP 等の**外部サービスへの実操作・resource作成 /
      credential設定 / 課金を伴う評価の開始**にCEO承認を要する（`CLAUDE.md` 4章 Authority Principle の
      「外部サービス追加 / 課金発生」）。**ドキュメント調査や、外部サービスを変更しない事前調査は承認対象に
      広げない**（Design Philosophy「承認最小」）。

      **今回実装しないもの（明記）:** Harness導入 / OpenHands導入 / Google Agent Runtime・ADK導入 /
      Harness・executor Adapter実装 / executor選択機構 / 既存Job Runnerの置換 / 新しいsandbox基盤の構築 /
      GCPアカウント作成・課金設定 / production defaultの変更 / 新しい Gate・Roadmap state の追加。
      本項目はRoadmapへの将来方針と評価条件の記録のみであり、着手可否は既存High-priority Repair
      完了後に判断する。

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

<!-- roadmap:id=containment-cleanup-ebusy-quarantine state=done -->
3. [x] **cleanup だけが失敗した containment が Job を quarantine させる — 完了（2026-09-14, PR #167 / #168）**
      **【2026-09-14 完了】** 真因は AIteamOS 自身のテストが `drain_timeout` 用 cgroup を残し、自己開発では
      それが Job の cgroup の**子**になって親を削除できないこと。テスト側の後片付けで修正した（#168。
      production コードは無変更）。bounded retry と診断情報（#167）は一過性 EBUSY への備えとして維持し、
      この真因特定を可能にした。**production 実測**: 修正後の Job chain で cleanup 成功、
      quarantine に入らず残留 cgroup 0件。
      **残す follow-up（本項目では実装しない）**: production 側で「空の子 cgroup を削除してから親を
      `rmdir`」すべきかは未決。安全経路の挙動変更であり本当のリークを隠す副作用もあるため、
      必要性が実証されるまで実装しない。

      — 2026-09-14、Tier A 自己開発 E2E の production 実測で登録。**高優先度**。
      既存 containment 項目（上記 `worker-cgroup-delegation-contract` / 下記
      `containment-success-path-observability`）は delegation 契約と成功経路の可観測性を扱っており、
      **cleanup 失敗そのものの扱い**は射程外のため、最小の後継項目として1件だけ立てる。

      **実測（Job `cf259578`）**: AI CLI の実装は**正常に完了**していた。その後の containment
      cleanup で per-job cgroup の `rmdir` が EBUSY になり、Job は次の理由で quarantine へ入った:

      ```
      workspace could not be proven quiescent: containment failed: cleanup_failed
      (EBUSY: resource busy or locked, rmdir '.../job-cf259578-…-safe-command-3136700-4')
      (workspace quarantined; ownership retained)
      ```

      **ところがその cgroup は実際には空だった**。直後に実測した値:
      `cgroup.procs` = 0 行 / `cgroup.events` = `populated 0`。
      Worker を再起動すると残留 cgroup は 0 件になった（サービスの cgroup subtree ごと破棄）。
      つまり **プロセスは1つも残っておらず、`rmdir` だけが一時的に失敗していた**。

      **なぜ重要か**: 実装が完了しているのに**後片付けの一時的失敗だけで Job が失敗扱いになり、
      さらに quarantine 経由で Task が復旧不能になった**
      （復旧不能の真因は別項目 `quarantined-dirty-task-generic-recovery`）。
      Tier A 自己開発 E2E はこれで停止した。

      **着手時の順序（EBUSY を単に無視しないこと）**:
      1. まず観測する — `cgroup.events` の `populated`、tracked process と descendants の有無、
         cleanup を実行するタイミング、`rmdir` 直前／直後の状態
      2. `populated=0` かつ process 0 で起きる**一時的 EBUSY** に対して、
         **bounded retry → short grace → 再確認 → cleanup** で安全に解消できないかを最優先で検討する
      3. それでも残る場合に限り、「containment は正常終了しており cleanup だけが失敗した」ケースを
         Job failure / quarantine にする必要があるかを既存の安全設計と照合する。
         安全性を下げずに cleanup を deferred にできる既存経路があれば**そちらを優先する**

      **維持する不変条件**: プロセスが残っている場合の fail-closed は**緩めない**。
      `populated` が 0 でないとき、drain timeout、kill 失敗は従来どおり quarantine とする。
      新しい supervision 方式・新しい sandbox 基盤は作らない。

      **【2026-09-14 追記: 真因を特定。当初の「一過性 EBUSY」仮説は誤りだった】**

      bounded retry（PR #167）を入れたところ、同時に追加した診断情報が真因を暴いた:

      ```
      still failing after 3 retries (populated 0, child cgroups remain:
        job-job-drain-1789359652300, job-job-drain-throw-1789359652319)
      ```

      **一過性ではなく、誰も消さない空の子 cgroup が残っていた**（実測: 両方とも
      `populated=0` / `cgroup.procs` 0 行の空ディレクトリ）。親の `rmdir` は ENOTEMPTY 相当で
      必ず失敗するため、短い retry では原理的に解消しない。

      **子 cgroup の出所は AIteamOS 自身のテスト**だった。
      `apps/worker/src/execution/runContainedCommand.test.ts` の `drain_timeout` 再現テスト2件
      （`jobId: 'job-drain'` / `'job-drain-throw'`）は、`drainMs: 0` と生存する `setsid sleep 30` で
      **意図的に drain_timeout を起こす**。`drain_timeout` 経路は production と同じく `rmdir` へ
      到達しないため cgroup が残る。

      **これは自己開発でのみ問題になる自己参照**である。通常運用では残るのは「その Job 自身の
      cgroup」であり、親は systemd 所有の Worker cgroup なので誰も `rmdir` せず無害。
      ところが **Tier A 自己開発では Candidate 上で `pnpm test` が Job の cgroup の内側で走る**ため、
      テストが作る cgroup が**その Job の子**になり、Job 終了時の `rmdir` を妨げる。
      よって **worker テストスイートを実行する自己開発 Task では決定論的に再発する**。

      **修正（テスト側。production コードは変更しない）**: 当該2件のテストが、意図的に残した
      cgroup を `cgroup.kill` → `populated 0` 待ち → `rmdir` で後片付けする。
      production の `drain_timeout` 挙動（cgroup を残す fail-closed）は**変更しない**。

      **PR #167 の retry は無駄ではない**: 一過性 EBUSY への備えとして妥当であり、
      何より**追加した診断情報がこの真因の特定を可能にした**。EBUSY を単に ignore していたら、
      空の子 cgroup が残り続ける本当の問題は見えないままだった。

      **未決（本項目に残す）**: production 側で「空の子 cgroup を削除してから親を `rmdir` する」
      ようにすべきかは別途判断する。payload が正当に入れ子 cgroup を作る場合
      （nested container 等）に備える価値はあるが、**安全経路の挙動変更**であり、
      本当のリークを隠す副作用もあるため、必要性が実証されるまで実装しない。

      **関連**: `quarantined-dirty-task-generic-recovery`（この quarantine から**出られない**理由。
      同じ復旧クラスタだが根本原因と責務が異なるため、**1つの実装 / PR にまとめない**）。

<!-- roadmap:id=containment-success-path-observability state=planned -->
4. [ ] **Containment success path の可観測性（低優先 hardening）** — 2026-09-08、P1 Phase 1/2
      Operational E2E の完走後に記録。**Phase 1/2 を reopen する必要は無い。動作は正常。**

      **2026-09-13 追記**: 本項目は `cross-project-state-api` に**包含される**。
      単独で着手せず、同項目の受入条件として扱う（重複実装を避けるため）。
      本項目の方針「新しい telemetry 基盤・ログ収集系は作らない／Job あたり1行以内」は
      そのまま `cross-project-state-api` 側でも維持する。

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
      **【制約: 従量課金APIを標準利用しない（CEO 指示・2026-09-14）】**
      Explainer も従量課金 API を標準利用せず、**既存 CLI / provider 実行経路から Role として
      割り当てる**方向を優先する。
      **現行実装は既にこの形である**（実測）: `apps/api/src/aiExplain/cheapAiClient.ts` は
      OpenCode CLI（`node_modules/opencode-ai/bin/opencode`）を spawn しており、raw HTTP endpoint は
      rollback 用のコメントとしてのみ残っている。したがって本項目は経路の作り直しではなく、
      **Role 割り当てを `role-model-registry` 経由へ寄せる**作業である。
      ただし特定 provider / CLI へ密結合させず、Registry から交換可能な設計を維持する。

      2026-09-10 登録。**本項目は明示的に post-MVP。MVP 完成まで説明品質改善を理由に
      本線を止めない**（CEO 判断・2026-09-10）。
      #130（predicate regression 修正）とは**別責務**。#130 / Phase 3 closure を先に完了する。
   **（延期条件は充足済み: MVP は 2026-09-13 に完了。上記の「MVP後」は書かれた時点の記録であり、現在の BLOCK 条件ではない。現在の可否は `state=` が正本。）**

      **2026-09-13 スコープ拡張: 本項目を Explainer 責務の owner とする（新規項目は立てない）**。
      調査の結果、Explainer は**既に3箇所に散在して実装済み**であることを確認した:
      `apps/api/src/aiExplain/cheapAiClient.ts`（`role: 'cheap_explainer'`、
      `opencode-go` / `mimo-v2.5` をハードコード）を
      `approvalExplain/approvalAi.ts` と `taskFailureExplain/taskFailureAi.ts` が共用し、
      `/approval-requests/:id/explanation`・`/:id/ask`・`/:id/failure-explanation`・
      `/:id/failure-ask` が稼働している。**したがって新規能力の追加ではなく、
      散在した3つを1責務へ統合し、対象を失敗説明から進捗・完了・Milestone 報告へ広げる作業**である。
      **4つ目の Explainer 実装を作らないこと。**

      あわせて、これまで別枠に置かれていた UX 残タスク
      「承認画面の説明導線（`apps/mobile/app/approvals.tsx:158` の文言に対応する導線が無い）」は
      **本項目へ吸収する**（重複管理しない）。

      **Explainer の責務境界（固定する）**: 技術判断をしない。
      入力は PL / Review / Test / Runtime が**既に確定させた事実**のみ
      （Source of Truth はそれらの記録であり、Explainer 自身ではない）。
      何をやったか / 何が実現したか / 何が問題だったか / ユーザーから見て何が変わるか /
      未解決事項 / 次に何をするか を、専門用語を最小限にした日本語で述べる。
      **推測・改変を禁止し、不明なことは「不明」と出力する。**
      最高性能モデルの常用は不要で、軽量モデルを選択できることを要件とする
      （モデル選択は `role-model-registry` の対応表で行い、ここに別の選択機構を作らない）。

      **依存**: `role-model-registry`（役割別に軽量モデルを指定できるようになってから着手するのが自然）。
      Milestone Report の文章表現は本項目が担い、事実収集は
      `project-auto-ceo-alignment` が担う（責務分離）。

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

      **2026-09-13 追記（実測）**: 現在リポジトリ全体に `tokenUsage` / `inputTokens` / `costUsd`
      等のコスト・使用量記録は**1箇所も存在しない**（検索ヒット0件）。したがって本項目は
      「既存記録の拡張」ではなく**最初の1本を通す**作業である。ただし新しい metrics backend は
      作らず、既存 `executionLogStore.ts` への追記に留める方針は変えない。
      Design Philosophy 8（効果検証可能性）を満たすための前提であり、
      `role-model-registry` の効果測定もこの記録が無いと行えない。

<!-- roadmap:id=role-model-registry state=planned -->
1. [ ] **Role / Provider / Model Registry（役割別ルーティング設定表）** — 2026-09-13登録。
      **【制約: 実行経路は CLI を既定とし、特定 provider へ密結合しない（CEO 指示・2026-09-14）】**
      Role への provider/model 割り当ては、**既存の CLI 実行経路（`AiCliProvider`）を既定**とする。
      Operator Chat / MCP / Explainer のために従量課金 API を新しい標準経路として追加しない。
      一方で**特定の provider / CLI へ密結合させない**。Registry から交換可能であることを維持し、
      将来 API 経路が合理的になった場合も Registry の1エントリとして扱えるようにする
      （経路の種別を Role 側へ埋め込まない）。

      **【2026-09-14 追記: CEO のコスト / 性能方針】**
      OpenAI・Claude とも現在は利用枠に余裕がある。**コスト節約を過度に優先して性能を下げない。**
      PL 判断・設計・Root Cause 分析・Independent Review・Safety 判断では、必要な推論能力を確保する
      （本 E2E で2回続けて誤診断した経緯からも、これらで性能を削るのは割に合わない）。
      一方 Explainer・定型処理は軽量モデルでよい。
      **契約プラン固有の上限値をコードや Design Philosophy へ固定しない**（枠は変わるため、
      設定値として扱い、判断ロジックへ埋め込まない）。
      本項目は `failure-explanation-pregeneration`（Explainer）の前提でもある。

      **新規サブシステムではなく、既に散在している設定を1箇所へ引き上げる作業**である。

      **受入条件に統合（2026-09-17）**: **Meta Review の post-Copilot fallback も本 Router の適用対象とする。**
      現在の Meta Review は Gemini CLI → Gemini API →（quota 時のみ Antigravity Claude）→ Copilot →
      fail-closed で終端し、Copilot より後段の provider routing を持たない
      （`meta-review-structured-output-robustness` で意図的に作らなかった）。
      provider availability / model selection / quota を本 Router が一元的に扱えるようになった時点で、
      **Meta Review 専用の第二の Router を作らず**この機構へ寄せること。その際
      `[metaReview] attempt {...}` の実測（段別失敗数・truncation 率・Copilot 成功率）を
      routing 設計の入力として使う。

      **既に存在するもの（作り直さない）**: `AiCliRequest`（`packages/shared/src/types/ai_cli.ts`）は
      `model` / `reasoningEffort` / `fallbackPolicy` / `timeoutMs` を**既に持つ**。
      `Task.provider`（1タスク=1プロバイダー原則）と `aiCli/factory.ts` の4 adapter も稼働中。
      2026-09-07 に production VPS で `gpt-5.6-sol` + `xhigh` の実動を確認済み。
      `apps/api/src/aiExplain/cheapAiClient.ts` は `role: 'cheap_explainer'` /
      `provider: 'opencode-go'` / `model: 'mimo-v2.5'` を**ハードコード定数**として持つ。
      **欠けているのは「役割 → 設定」の対応表1枚だけ**である。

      **やること**: PL / Implementer / Reviewer / Researcher / Meta Reviewer / Explainer 等の役割ごとに
      provider・model・reasoning level・fallback・cost policy・data sensitivity を
      設定・変更できる単一の対応表を持つ。`CHEAP_AI_CONFIG` と `Task.provider` の既定値を
      そこへ引き上げる。高性能モデルを全処理へ使わず、役割に必要な能力で選べるようにする。

      **維持する不変条件**: 生成担当と独立Review担当の provider 分離（既存の独立性原則）を
      対応表で表現できること。ここを緩める設定を可能にしない。

      **今回やらないこと（明記）**: Dynamic Model Routing / 自動モデル昇格 / ベンチマーク基盤 /
      Model Registry Lite 本体（Phase 2）/ 新しい Gate。本項目は静的な対応表のみ。
      `project-auto-gemini-worker-eligibility` は本項目の**最初の適用事例**として扱い、
      **2026-09-15 追記**: `review-provider-exhausted-alternate-rereview` も本項目の利用者である
      （Reviewer Role の provider 候補順を Registry で表現し、生成担当との vendor 分離を
      緩められない形で持つ）。候補表を本項目の外に二重に作らないこと。
      別枠の Provider 評価の仕組みは作らない。

      **【2026-09-15 追記: Copilot の Meta / Design Review fallback model は本項目が正本】**
      アプリ追加要求（Task `3d8878e9`）のうち「fallback 時に model を明示指定する」側は**本項目へ統合する**。
      新規項目は立てない。Reviewer Role の1エントリとして **Copilot fallback の model を明示**し、
      **`auto` / 未指定を許さない**（`copilot --model` は `auto` を受け付けるが、これを使わない）。
      fallback policy（いつ Copilot へ落ちるか）は既存 `COPILOT_ELIGIBLE_FAILURE_CLASSES`
      （quota / transient）が正本であり、本項目はそれを**表現するだけで緩めない**。

      **採用 model（2026-09-15 production 実測。ledger の値を無条件に信用せず再確認した）**:
      `copilot` CLI 1.0.83 で `--model mai-code-1.1-flash` が exit 0 で応答した。未知 model は
      exit 1 で拒否される（利用可能一覧を返す subcommand は無く、可否は実行で確かめるしかない）。
      よって現時点の採用値は **`mai-code-1.1-flash`**。ただし model ID は変わりうるため
      **Registry の設定値として持ち、判断ロジックへ埋め込まない**（本項目の既存方針どおり）。
      `copilotRouter.ts` の `DEFAULT_COPILOT_META_REVIEW_MODEL` は protected 側の既定値なので、
      Registry 値と一致することを確認し、**乖離したら fail-closed**（どちらかを黙って優先しない）。

      **独立性を緩めない**: model を固定しても `reviewSeparation.ts` の copilot 未登録は変えない。
      model 固定を Independent Reviewer への昇格根拠にしない
      （`review-provider-exhausted-alternate-rereview` の不変条件と同じ）。

      **依存**: `project-workspace-isolation` とは独立で、並行実施できる。
      Model Usage Telemetry（上記）と対で入れると効果検証が可能になる。

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

## Repository 腐敗監査 由来の Finding（2026-09-15）

**出典**: 2026-09-15 の repository 全体 read-only 監査（92 Finding）。
統合判断の記録は `docs/project_memory/decisions/repository_rot_audit_2026_09_15.md`。

**採用方針（PL）**: 92 Finding を機械的に item 化しない。
**既存 item の scope / acceptance criteria の改善で解決できるものは新規 item を作らない。**
Safety Boundary 系 6 件は `control-repository-header-vs-enforced-guard` へ、
Context Pack 系 2 件は `project-auto-context-pack-wiring` へ吸収した。

**master 側で既に解決済みだったもの（監査側を取り下げた）**:
- 延期表記（「MVP後へ延期」）の扱いは **#211 が「現在の可否は `state=` が正本」という方針で解決済み**。
  監査が用意していた棚卸し（7 箇所の一覧）と CEO 判断の提起は**不要になったため追加しない**。
  `adopted-item-blocked-by-stale-deferral-text` は本統合中に **#217 で `state=done`** になった。
  監査側からは一切触れていない
- `task-allowed-paths-not-normalized` は **#212 が `state=done` で close 済み**。
  監査の関連 Finding（空配列）は**別の失敗方向**なので下記に独立 item として登録する。
  なお **#216 が `guard-block-message-omits-allowed-paths` を `state=done`** にした際、
  block メッセージへ `(empty - so this is NOT an allowedPaths mismatch)` を追加している。
  これは空配列が guard へ到達して「不一致ではない」と扱われることを**明示した**ものであり、
  下記 `allowed-paths-empty-disables-file-change-guard` の裏付けになる（解消ではない）
- 憲法の共通行動原則の範囲表記（3.14〜3.15 / 3.16 / 3.17 の不一致）は
  **PR #85 / #87 が扱っているため本節では扱わない**

**全 item 共通の制約**: **新しい Gate / Review / Workflow / telemetry 基盤を追加しない。**
いずれも既存実装・既存ルール・既存 validation・既存生成処理の修正で成立する。

---

### 優先度 1: 実動作上の安全性・Approval / Gate 境界

<!-- roadmap:id=safe-work-only-not-applied-to-ai-cli state=planned priority=high -->
0. [ ] **`continue_safe_work_only` が AI CLI のコード変更を止めていない** — 2026-09-15 監査（Confirmed / P1。2026-09-15 の master で再確認済み）。

   **事実**: `apps/worker/src/guards/gatePolicy.ts` の `SAFE_WORK_ALLOWED_COMMAND_KINDS`
   （`git_status` / `git_diff` / `git_log` / `typecheck` / `test` / `lint`）は
   「読み取り・テスト・品質チェックのみ。**コード変更・commit は禁止**」と定義されている。
   `apps/worker/src/jobRunner.ts` はこれを `job.safeCommand.kind` にだけ適用し、
   その後の AI CLI 実行ブロックは `gateResult.policy` を**一切参照しない**（実測: 当該ブロック内に
   `gateResult` / `policy` の参照が 0 件）。
   implement Job は `safeCommand: { kind: 'test' }` + `aiCliMode: 'implement'` で作られる
   （`apps/api/src/ctoAi/initialImplementWorkflow.ts`）ため、`'test'` が許可リストにあることで
   safe-work チェックを通過し、直後に任意のコードを書く AI CLI が走る。

   **到達性（通しで確認）**: gate は Job 開始時点の worktree 差分で評価される。
   blocked commit 後に resume した implement Job はその差分を持ち、
   `auth` / `guards` / `migration` 等に触れていれば HIGH → `/gate/check` が
   `BLOCKED` + `continue_safe_work_only` → `kind === 'test'` で通過 → AI CLI が更にコードを書く。
   通常の `resume:<jobId>:1` フローであり例外経路ではない。

   **同じ決定点のもう1つの欠落（同時に直す）**: `gatePolicy.resolvePolicy` に
   **`decision === 'REJECTED'` の分岐が無く**、`policyMap[apiPolicy]` = `continue_safe_work_only` へ落ちる。
   上記と重なると **CEO が明示的に却下した変更でも implement Job の AI CLI が走る**。
   `apps/worker/src/guards/gateClient.ts` は「実挙動では policyMap 経由の一般経路を通っていた
   （挙動は不変）」と記録しており、**挙動ではなく型の方を挙動へ合わせた**形になっている。

   **P0 ではない理由**: `git_commit` は許可リストに無いため commit 自体は依然ゲートされる。
   壊れているのは「承認待ち・却下中は作業を止める」という Approval Gate の意味である。

   **着手時に確認すること（実装方針を先に決めない）**:
   - safe-work 判定を Job の**実効行為**に対して行えるか（`aiCliMode` が非 read-only のとき拒否する等）
   - `REJECTED` を `block_until_approved` へ倒す。併せて `gateClient.ts` の判断を再評価する
   - **新しい Gate を作らない。** 既存 `SAFE_WORK_ALLOWED_COMMAND_KINDS` と `resolvePolicy` の範囲で表現する
   - 効果検証可能性: safe_work_only 下で AI CLI を止めた件数が既存 `gate_evaluations` /
     `observationLog` から数えられること

<!-- roadmap:id=review-gate-layers-implemented-but-unwired state=planned priority=high -->
0. [ ] **実装済みと記録されているレビュー / Gate 層が Job 経路に配線されておらず、うち1つは gate 緩和の理由になった** — 2026-09-15 監査（Confirmed / P1）。個別の未配線ではなく **1 つの問題**として扱う。

   **(1) Alignment Checker / Safety Auditor / `processGate` が Job 経路で一度も走らない**:
   `apps/worker/src/jobRunner.ts` の `buildLocalGateResult()` は `runRiskReview(changedFiles)` を
   呼ぶだけで **`alignmentRiskLevel: 'LOW'` を固定値で返す**。
   `runSafetyAudit` / `runAlignmentCheck` / `processGate` の production caller は
   `apps/worker/scripts/audit.ts`（= 手動 `pnpm audit:gate`）**のみ**である（2026-09-15 master で実測）。
   結果として `gatePolicy.ts` の「API が continue でもローカルが HIGH/CRITICAL なら escalate」は
   **API 側が既に実行したのと同一の純関数を同一入力で呼んだ結果**と比較しており、原理的に発火しない。
   `alignmentChecker.ts`（承認フロー迂回・Design Philosophy 違反の検出）と
   `safetyAuditor.ts` の `DANGEROUS_KEYWORDS`（diff 本文の `autoApprove` / `bypassApproval` 検出）は
   どちらも Job 判定に一度も寄与していない。

   **(2) `/gate/check` の Secret Scan（Step D）が production caller から到達不能**:
   `apps/api/src/routes/approvalGate.ts` の secret scan は `if (diffText !== undefined)` の中にある。
   `callGateCheck` の唯一の production 呼び出し（`jobRunner.ts`）は `changedFiles` のみを渡す。
   同ファイルは「Step D 実装済み: diffText 内容スキャン（シークレット検出）」と主張している。

   **(3) `safetyVerifier.overallPassed` が構造的に常に false で、その結果 commit gate が緩和された**:
   `jobRunner.ts` のコメント自身が「TYPECHECK/RELATED_TESTS/FULL_TESTS の3チェックが未接続のため
   fail-closed であり、any severity で実行しても overallPassed は常に false（構造的問題）」と述べる。
   その結果 `apps/worker/src/approvalLevel/commitGate.ts` が**全 tier の必須成果物から
   `SAFETY_VERIFICATION_RESULT` を外した**。恒久的に赤いチェックを迂回するために gate を弱めた形であり、
   `overallPassed` は情報量ゼロの信号になっている。

   **(4) Shadow Commit Gate が観測記録を残さない**: `jobRunner.ts` は
   「判定結果はconsole.logのみ。停止・通知・永続化は行わない（Job結果にも載せない）」。
   直後の `appendObservationLog` に commit-gate フィールドが無い。
   **「観測してから Gate にする」ことが唯一の目的の機構が、shadow と real の一致率を
   後から問い合わせられる記録を残していない**（Design Philosophy 8 に抵触）。

   **(5) 併せて棚卸しする未配線モジュール（いずれも理由がコードに明記済み。事故ではない）**:
   `apps/worker/src/approvalLevel/preReviewer.ts` の `runPreReview`（caller 無し。
   `PRE_REVIEW_RESULT` は全 reviewPolicy の必須から外されている）、
   `apps/worker/src/approvalLevel/finalReviewPacket.ts`（非テスト importer 0）、
   `reviewerAdapter.ts` の `shouldEscalateToChatGpt`（本体が `return false` のみ）。

   **なぜ1つの item にするか**: 個別に直すと「どの層が本当に効いているのか」の答えがまた分散する。
   **現在 Job 判定に実際に寄与している層の一覧を1つ確定させる**ことが目的である。

   **着手時に確認すること（実装方針を先に決めない）**:
   - (1)〜(3) は **配線する / 記述と必須指定を実態へ合わせる** のどちらかを層ごとに決める。
     **両方の正本を残さない**（`control-repository-header-vs-enforced-guard` と同じ原則）
   - (2) は server 側が既に `targetDiffHash` と照合するため、`diffText` を渡すだけで成立するかを先に見る
   - (3) を配線する場合、`commitGate.ts` の必須成果物を戻せるかまで含めて判断する
   - (4) は既存 `observationLog` へフィールドを足すだけにする。**新しい telemetry 基盤を作らない**
   - (5) は「残す（理由を再確認）」「消す」のどちらかを明示的に決め、宙吊りにしない

<!-- roadmap:id=allowed-paths-empty-disables-file-change-guard state=planned priority=high -->
0. [ ] **`allowedPaths` が空配列だと File Change Guard の範囲チェックが丸ごと無効になる** — 2026-09-15 監査（Confirmed / P1。**#212 が close した `task-allowed-paths-not-normalized` とは失敗方向が逆の別 Finding**）。

   **事実**: `apps/worker/src/guards/fileChangeGuard.ts` は
   `// 4. タスクのallowedPathsチェック（指定がある場合のみ）` `if (policy.allowedPaths.length > 0) { ... }`。
   空配列だと範囲制限がスキップされ、`ALWAYS_FORBIDDEN_PATTERNS` と `forbiddenPaths` だけが残る。

   **空配列を生む経路がある（2026-09-15 master で再確認）**:
   `apps/api/src/ctoAi/roadmapGenerator.ts` の schema は `allowedPaths: z.array(z.string()).default([])`、
   `projectInitialization.ts` がそのまま渡し、`apps/api/src/storage/roadmapTaskValidation.ts` は
   `for (const path of task.allowedPaths)` で**各要素**を検証するが、**配列長は検証しない**。
   PR #144 で入った `nonRelativePathReason()` は `'must not be empty'` を持つが、これは
   **空文字列の要素**に対するもので、**空配列ではループ自体が回らない**。
   一方 `apps/api/src/ctoAi/roadmapAdoption.ts` は空配列を fail-closed で拒否し
   （`'allowedPaths must be explicitly provided and non-empty'`）、
   `apps/api/src/pl/actionGate.ts` の `assertAdoptionScopeIsBounded()` も同様。
   **同一責務に対する2経路で扱いが逆。**

   **原則との関係**: `actionGate.ts` が既に明記している —
   「`allowedPaths` は File Change Guard の効き方そのものを決める。PL が `.` や `apps` のような
   広いパスを宣言できると、Guard は形だけ残って実質無効になる」。**空配列は `.` より広い。**

   **`task-allowed-paths-not-normalized`（#212 で done）との関係**: あちらは絶対パス →
   **常に不一致で over-block**（fail-closed・安全側）。本項目は空配列 → **範囲チェック消失**（fail-open）。
   **修正は同じ関数（`validateRoadmapTasks()`）に着地する**ので、着手時はそちらの実装を必ず参照すること。

   **着手時に確認すること（実装方針を先に決めない）**:
   - `validateRoadmapTasks()` に `roadmapAdoption.ts` と同じ長さ検証を足す形でよいか
   - `fileChangeGuard` 側の空ポリシーを「何も許可しない」へ倒すべきか
     （倒すと既存の空 `allowedPaths` Task がすべて block される。移行影響を先に測る）
   - **新しい Gate を作らない。** 既存の検証関数と guard の範囲で表現する
   - 効果検証可能性: 空 `allowedPaths` で作られた Task が過去に何件あったかを DB から数えられること

   ---

   **【2026-09-17 CEO 判断: A / B に分離する。B を A に混ぜて通常 Executor へ流さない】**

   **A: 非 protected — 入口を塞ぐ（通常の VPS Candidate で実装可能）**
   - 対象: `apps/api/src/storage/roadmapTaskValidation.ts`
   - 内容: 空 `allowedPaths` を validation error として拒否する
   - 位置づけ: 既に `roadmapAdoption.ts`（`allowedPaths.length === 0` で fail-closed）と
     `actionGate.ts` の `assertAdoptionScopeIsBounded()` が同じ要件を持つ。**同一責務の3経路のうち
     ここだけが素通し**なので、生成ロジックの変更ではなく既存 validation の整合修正である。
   - 新しい Gate / workflow / state を追加しない

   **B: protected — 既存分を塞ぐ（Maintenance Lane / Tier B でのみ実装可能）**
   - 対象: `apps/worker/src/guards/fileChangeGuard.ts`
   - 内容: `if (policy.allowedPaths.length > 0)` を、空なら Task 単位の変更範囲を
     fail-closed にする向きへ倒す
   - `ALWAYS_FORBIDDEN_PATTERNS` 対象。**通常 Executor では原理的に実装できない**
   - 既存影響を確認してから実施する。**着手直前に件数と state 別内訳を測り直す**
     （過去値を使い回さない）

   **B の移行影響（2026-09-17 実測。着手時は再測定すること）**:
   空 `allowedPaths` は 45 / 206。ただし **44 件は archived project 所属**である。
   稼働中の project は `AIteamOS` のみ（7 tasks）で、そのうち空は1件だけ
   （`copilotのモデル指定` / `pending` / `roadmapActive=false` / **Job 0件** / 2026-09-15 以降未実行）。
   `completeTaskAndCreateContinuation()` は archived project の継続を作らないため、
   **B の実影響は休眠中の1件**である。当初懸念した「45件が一斉に block」は起きない。

   **【重要: この item は既に PL から採用不能になっている】**

   この item には Task `6f8b41ef` があり、Job `d913fa9d` が実行済み（blocked）である。
   そのため `state=` を何にしても PL はこの item を二度と採用できない。
   機構と根本原因は既存 Finding **`executed-item-remaining-work-has-no-continuation`**
   （`state=deferred`）に記録済みなので**ここでは繰り返さない**。本項目はその実例である。

   **結果として A も B も、PL の autonomous adoption では着手できない。**
   どちらも Maintenance Lane / Tier B 等、採用経路を通らない実装手段が要る。
   `planned` / `deferred` の使い分けでは表現できない（採用可否は state ではなく
   Job 実行履歴で決まるため）。CEO 指示により、**新しい state も workflow も追加しない**。

---

### 優先度 2: Escalation / recovery / resume

<!-- roadmap:id=pl-escalation-recorded-without-delivery state=planned priority=high -->
0. [ ] **PL Escalation が未配達でも `escalated` と記録し、以後 PL の全作業が永久に止まる** — 2026-09-15 監査（Confirmed / P1相当。2026-09-15 master で再確認済み）。

   **事実**: `apps/api/src/pl/executionLoop.ts` の `escalateTo()` は
   `await escalate({...})` の直後に**無条件で** `record(storage, key, 'escalated', reason)` する。
   `defaultEscalate` は `sendAlert` の**戻り値を捨てている**。
   `apps/worker/src/notifier/notifier.ts` は通知チャネル未設定時に `console.warn` の後**正常 resolve** し、
   全チャネル失敗時（`🚨 UNDELIVERED`）も正常 resolve する。
   そして `executionLoop.ts` は `hasEscalated()` で escalated 済み対象を
   `actionable` から**恒久的に除外**する。

   **情報は既に手元にある**: `sendAlert` は `SendResult[]` を返しており、成功チャネルの有無は判定できる。
   捨てているだけである。

   **【2026-09-18 訂正: PR #249 を受けて前提を作り直した。旧本文のままでは実装できない】**

   #249（採用エスカレーションの incident 単位 dedup）以降、**「通知せずに `escalated` を記録する」のは
   正式挙動になった**。同じ対象で同じ failure class が続く間、CEO への通知は最初の1回だけにし、
   audit と PL state には毎回残す —— そうしないと「通知を止める」が「障害を消す」になるためである。

   したがって旧本文の「**未配達なのに escalated が記録されること自体が不具合**」という前提は、
   そのままでは**広すぎる**。区別すべきは4つある:

   | | 意味 | 現状（2026-09-18 master 実測） |
   |---|---|---|
   | **A** | PL が escalation を判断した | ✅ `record(..., 'escalated', ...)` で残る |
   | **B** | CEO へ実際に delivery された | ❌ **残らない**（`defaultEscalate` が `SendResult[]` を捨てる） |
   | **C** | duplicate として意図的に抑制した | ⚠️ 採用経路のみ（`notify:false` + `pl_adoption_escalation_notified`） |
   | **D** | 新規 incident なのに delivery が失敗した | ❌ **区別されない**（`sendAlert` は全失敗でも正常 resolve。console の `🚨 UNDELIVERED` だけ） |

   **本項目が直すのは B と D である。** A は既に正しく、C は #249 が入れた。

   **`escalated` と `notification delivered` を同義にしない。**
   - **「`sendAlert` が成功したときだけ `escalated` を記録する」仕様にしてはならない。**
     #249 の duplicate suppression では送信そのものを行わないため、この仕様は
     「抑制した incident を escalation として記録できない」ことになり、
     retry window（escalation を境界に切り替わる）まで壊れる
   - 逆に **「`escalated` なら届いている」とも扱わない。** それが今の不具合である

   **`hasEscalated` の抑制自体は正しい**（CEO 判断待ちの間 tick ごとに Diagnose で
   provider CLI を回すのを避けるため、理由がコードに明記されている）。
   **直すべきは抑制ではなく「届いていないのに escalated と記録する」点**である。

   **`vps-operation-docs-current-truth` と重なると深刻**: 文書化された API 起動 env allowlist は
   `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` / `SLACK_WEBHOOK_URL` を含まない。
   **手順どおりに再起動すると、この経路は必ず「未配達だが escalated と記録」になる。**

   **隣接 item との責務分離**: `pl-escalation-blames-the-wrong-cause` は Escalation **本文の原因誤認**、
   `mobile-push-ceo-escalation` は**将来の第一チャネル**の話であり、いずれも別責務。
   本項目は**配達結果と記録の整合**だけを扱う。

   **着手時に確認すること（実装方針を先に決めない）**:
   - `defaultEscalate` が捨てている `SendResult[]` を、**`escalated` の記録を止めずに**
     どこへ残すか。判定材料は既にあり、捨てているだけである
   - **D（新規 incident で delivery 失敗）をどう表すか。** A の記録は残したまま、
     「誰にも届いていない」ことが後から分かる形にする。
     再試行や復旧を抑止する状態にはしない
   - C（意図的な抑制）と D（届かなかった）を**取り違えない**こと。
     どちらも「送っていない / 届いていない」だが、前者は正常で後者は障害である
   - 配達結果を後から数えられるようにするか。`IStorage` に notifications store は無い。
     **新しいテーブルを作る前に、既存 `audit_log` の detail へ載せて足りるかを先に見る**
   - **新しい通知基盤を作らない。** `sendAlert` 自体の挙動も変えない

   ---

   **【2026-09-17 実態修正: 止まるのは「その対象」ではなく PL の全作業である】**

   表題の「以後**その対象の**処理を永久に止める」は実態より軽い。production 実測で、
   **escalate 済みの attention が1つでもあると PL は採用も含めて一切前進しなくなる**ことが判明した。

   **実測（2026-09-16〜17）**: 2026-09-16T09:59:02Z に `job_blocked:d913fa9d` を escalate。
   以後 **15時間以上 `audit_log` が1行も増えていない**。api / worker は `active` で、
   PL tick は数秒ごとに走っている（`/api/jobs?taskId=...` のポーリングが journal に出続けている）。
   **ループは生きていて、何も選べない状態**だった。

   **原因は独立した2条件の組み合わせで、片方だけ見ても分からない**:
   - `runPlTick()` は `actionable` を作るとき `hasEscalated()` で escalate 済みを**除外**する
     → 復旧対象として選ばれない（この抑制自体は上記のとおり正しい）
   - しかし `maybeAdoptNext()` の先頭は `if (state.attention.length > 0) return undefined` で、
     **除外前の `state.attention`** を見ている
     → attention は消えていないので**採用も止まる**

   つまり除外は「復旧」側にしか効かず、「採用」側には効かない。結果として
   **直せない対象が1つあるだけで、無関係な Roadmap 項目の採用まで恒久的に止まる。**

   **【2026-09-18 訂正: 出口はできた。ただし自動では解けない】**

   下の「外から解く手段が現状ない」は **PR #235（`abort_task`）で解消済み**である。
   `POST /api/tasks/:id/abort` が CEO Approval を要件に Task を park する
   （`done` にせず `roadmapActive=false`、Job 履歴は残す）。2026-09-18 に production で2回使用し、
   いずれも attention が解除されて PL が再開した。

   **ただし「1件の解けない対象が採用まで止める」構造そのものは残っている。**
   `maybeAdoptNext()` は今も除外前の `state.attention.length > 0` を見ており
   （`apps/api/src/pl/executionLoop.ts`）、`runPlTick()` 側の `hasEscalated()` 除外は
   採用側に効かない。出口が CEO の手動操作しかない点も変わっていない。

   以下は 2026-09-17 時点の記録として残す（`abort_task` の項だけ上記のとおり古い）。

   **この状態を外から解く手段が現状ない**（2026-09-17 read-only 確認）:
   - `job_blocked` attention の条件は `task.status !== 'done'`。消すには Task を `done` にするしかない
   - `TaskStatus` は `pending | in_progress | review | done | blocked` で、
     **`done` 以外の終端状態が無い**
   - `roadmapActive=false` にしても `currentTask` からは外れるが、attention は
     `roadmapActive` を見ていないので**残る**（採用は止まったまま）
   - `abort_task` は `PL_ACTION_KINDS` と gate table に**定義はある**が、
     `executeAction()` に executor が無く、専用 route も無い。提案されても
     `no executor wired for 'abort_task'` で終わる
     （`allowedActionsFor('job_blocked')` にも入っていないので、そもそも提案されない）

   → 未達成の Task を `done` にするか、新しい状態を足すか以外に出口が無い。
   **どちらも CEO 指示で禁止されている。**

   **着手時に確認すること（追加分。新しい recovery subsystem は作らない）**:
   - `maybeAdoptNext()` の `state.attention.length > 0` を、`actionable` と**同じ除外**を通した
     attention で判定するだけで解けるか。
     「止まっているものを放置して新しい仕事を増やさない」という元の意図は、
     **未 escalate の停滞に対しては維持される**（escalate 済み＝既に人の判断待ち、である）
   - `job_blocked` attention が `task.roadmapActive` を見ていない点を併せて直すか、分けるか
   - 既存 `no-status-for-closing-a-task-without-implementing` と同じ出口の問題である。
     **新しい TaskStatus を足す前に**そちらの検討結果と突き合わせる

<!-- roadmap:id=pl-resume-task-design-review-evidence-mismatch state=planned -->
0. [ ] **PL の `resume_task` が AI CLI implement Job に対して構造的に失敗し、attempt を使い切って CEO へ上がる** — 2026-09-15 監査（Confirmed / P2）。復旧経路が 2 重に実装されており、PL 側だけ復旧処理を持たない。

   **事実（2026-09-15 master で再確認）**: HTTP route 側（`apps/api/src/routes/tasks.ts`）は
   `resumeBlockedTask` を呼び、`DESIGN_REVIEW_PRECONDITION_FAILED` のときは
   **新しい指示 prompt に対して `createAndExecuteDesignReview` を走らせてから再試行する**
   （「再開指示は元Jobとは異なる実装promptになるため、元promptへのevidenceを流用しない」）。
   PL ループ側（`apps/api/src/pl/executionLoop.ts`）は `storage.jobs.resumeBlockedTask(...)` を
   `DEFAULT_RESUME_INSTRUCTION` で直接呼ぶだけで、この復旧を持たない。

   **なぜ必ず失敗するか**: `apps/api/src/storage/sqlite.ts` は AI CLI 分岐を
   `checkImplementJobDesignReviewEvidence({ aiCliPrompt: instructionPrompt })` でゲートし、
   `computeDesignTextHash(instructionPrompt)` を `evidence.designTextHash` と比較する。
   保存されている evidence は**元の implement prompt** に対するものなので
   `DEFAULT_RESUME_INSTRUCTION` とは一致し得ない。結果として毎回
   `resume refused: Latest Design Review evidence was created for different design text` を返し、
   attempt を消費し、`PL_MAX_ATTEMPTS_PER_TARGET` 到達後に CEO へ escalate する。

   **#214 との関係（別バグ）**: #214 は `collectSystemEvidence()` が
   **最古の** ALIGNED evidence を Gate へ出していた問題を直した（`findLatestByTaskId()` を使う）。
   本項目は「どの evidence を選ぶか」ではなく「**resume 用 prompt の hash がそもそも一致しない**」
   という別の層の問題であり、#214 の修正では解消しない。

   **着手時に確認すること（実装方針を先に決めない）**:
   - route 側の「design review をやり直してから resume」を関数へ切り出し、**両方から呼ぶ**形にできるか
     （`重複排除` / `既存機能への合理的統合`）
   - PL が resume 時に使う instruction をどう決めるか。`DEFAULT_RESUME_INSTRUCTION` 固定のままでよいか
   - **新しい recovery 経路を作らない。** 既存の 2 経路を 1 本へ寄せる
   - 効果検証可能性: この理由で消費された attempt / escalation の件数が後から数えられること

<!-- roadmap:id=cheap-ai-latency-and-timeout-contract state=planned -->
0. [ ] **cheap AI（説明・質問経路）の latency と timeout 契約** — 2026-09-15 監査により**正式登録**（それ以前は本文中で open と宣言されながら `roadmap:id` を持たず、PL が構造的に採用できなかった）。

   **登録経緯**: 本ファイルの「### P1 とは分離して open のまま維持する項目」で
   `cheap-ai-latency-and-timeout-contract` として open と宣言されていたが、
   ledger に `roadmap:id` メタデータが存在しなかった（実測 0 件）。
   PL の `adopt_roadmap_item` は ledger 上の id 実在を検証するため、
   **宣言だけあって構造的に採用できない状態**だった。

   **内容**: `apps/api/src/aiExplain/cheapAiClient.ts` は `timeoutMs: 60_000` を持つが、
   記録されている実 latency は 66〜74 秒である。kill は `spawn({ timeout })` に依存している。
   影響範囲は `/approval-requests/:id/explanation`・`/:id/ask`・
   `/:id/failure-explanation`・`/:id/failure-ask`、および PL の diagnosis / adoption。

   **着手時に確認すること**: 実測 latency の分布 / timeout 値の根拠 / timeout 時に
   PL の attempt を消費してよいか（`provider-outage-burns-attempt-budget` と隣接）。
   **新しい timeout 機構を作らない。**

---

### 優先度 3: AI へ注入される Current Truth の誤情報

<!-- roadmap:id=vps-operation-docs-current-truth state=planned priority=high -->
0. [ ] **VPS 運用手順の Current Truth が古く、文書どおりに再起動すると CEO Escalation が届かなくなる** — 2026-09-15 監査（Confirmed / P1）。「VPS常駐運用化」節をまとめて現在の実態へ更新する。

   **(1) 起動 env allowlist が API の実際の読み取りを欠いている（最も実害が大きい）**:
   本ファイル「VPS常駐運用化」節の「**正式Production起動方式の確定**」は `set -a; . .env` を禁止したうえで
   「APIのallowlistは `PATH`/`HOME`/`NODE_ENV`/`HOST`/`PORT`/`DB_PATH`/`API_TOKEN`/
   `ADMIN_TOKEN_SHA256`/`WORKER_TOKEN_SHA256`/`OPENCODE_GO_API_KEY` のみ」と確定している。
   しかし API が実際に読む次が入っていない:
   - `ACTIONS_READONLY_TOKEN_SHA256`（`apps/api/src/auth/apiToken.ts`）。無いと第3 credential class が
     存在せず、`gate-evidence-check.yml` の `verify-commit` が認証できない
   - `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` / `SLACK_WEBHOOK_URL`。
     **API プロセス自身が CEO Escalation を送る**（`apps/api/src/pl/executionLoop.ts` と
     `apps/api/src/index.ts` が `@ai-team/worker/src/notifier/notifier.js` を動的 import して
     `sendAlert` を呼ぶ）。`.env.example` は「どちらも未設定だとコンソール（journal）にしか出ない」と明記
   本ファイル自身が後に、CEO が LINE credential を `/srv/ai-team/env/api.env` へ入れたことと
   `PL_LOOP_*` を systemd drop-in で有効化したことを記録しているが、
   **canonical な allowlist 記述だけが更新されていない**。
   `pl-escalation-recorded-without-delivery` と重なると
   「届いていない escalation を `escalated` と記録して以後止める」状態になる。

   **(2) 完了済み項目が未着手として並んでいる**: 同節の未チェック項目のうち、HTTPS化・
   ヘルスチェック（`apps/api/src/routes/health.ts` が `docs/vps_app_runtime_standard.md` v1 準拠で
   実装・登録済み）・再起動耐性（systemd user units `ai-team-api.service` / `ai-team-worker.service`）は
   **既に達成済み**である。本当に open なのは **Docker化** と **ログ保存 / rotation 方針**。
   同じ drift が `specs/11_runtime_environment.md` にもある（同時に直す）。

   **(3) `sandbox/hooks/pre-push` は成功しえないのに `setup-hooks.sh` が VPS への設置を指示している**:
   `pre-push` は `pnpm --filter @ai-team/worker tsx src/metaReviewer/autoReview.ts` を実行するが、
   `apps/worker/package.json` に `tsx` script は無い（動作する形は CI と同じ `exec tsx`）。
   さらに `set -e` により `EXIT_CODE=$?` 以降の分岐（BLOCKED / 実行失敗）は**到達不能**。
   指示どおり設置すると**そのマシンからの全 push が pnpm エラーでブロックされる**。

   **(4) 復元手順が存在しないのに `done` item の完了条件に含まれている**:
   `project-auto-db-safety`（`state=done`）の完了条件は「定期バックアップ／世代管理／**復元手順**／
   **実際の復元テスト**」。`apps/api/scripts/dbRestoreTest.ts` は存在するが、
   `apps/api/ops/systemd/README.md` は backup timer の設置しか書かず、repository 内の全 `.md` を
   検索しても復元手順への参照は 0 件、`package.json` の wrapper も起動する systemd unit も無い。

   **(5) CI と production で Meta Review のモデルが違う**: `.github/workflows/meta-review.yml` は
   `GEMINI_MODEL` に `gemini-2.5-flash` を必ず渡す。コード既定は
   `apps/worker/src/metaReviewer/autoReview.ts` の `gemini-3.5-flash` で、
   同ファイルのコメントは 3.5-flash を「このプロジェクトが実運用として使ってきた既定値」と説明する。
   **merge gate が実運用と違うモデルで判定している。**

   **(6) `.env.example` がコードの読む変数を欠く（`AGENTS.md` Q7 違反）**:
   未記載で production コードが読むもの: `ANTHROPIC_API_KEY`（**最も実害が大きい** —
   `apps/api/src/ctoAi/specAnalyzer.ts` は `CLAUDE_API_KEY` へフォールバックせず throw する。
   Worker は `adapter.ts` で橋渡しするが **API プロセスには橋が無い**）、
   `ACTIONS_READONLY_TOKEN_SHA256`、`DB_PATH`、`DB_BACKUP_DIR`、`TARGET_ROOT`、
   `WATCHDOG_INTERVAL_MS`、`AGY_CLI_PATH`、`CODEX_CLI_PATH`、`SUPERVISED_RUN_ROOT`、
   `DESIGN_REVIEW_{REPO_ROOT,RUNNER_COMMAND,CONTROL_CONTEXT_DIR}`、`DELEGATION_*`。
   逆に `CONTROL_REPO_PATH` / `TARGET_REPO_PATH` / `GIT_USER_NAME` / `GIT_USER_EMAIL` は
   **どのコードも読まない**（`sandbox/docker-compose.yml` 専用）。
   併せて `BACKUP_KEEP_COUNT = 28`（= 7日分）がどこにも文書化されていない。

   **CEO へ渡す判断**: production を生かしている systemd unit
   `ai-team-api.service` / `ai-team-worker.service`（`PL_LOOP_*` drop-in と `flock` 単一インスタンス強制を含む）は
   **repository に存在せず VPS 上にしかない**。version 管理下に置くかは production 設定の扱いに関わるため
   CEO 判断とする（`worker-cgroup-delegation-contract` の前提でもある）。

   **着手時の制約**: **(1)〜(6) はすべて記述・設定側の修正で足りる。新しい仕組みを作らない。**
   production への操作（再起動・env 変更）は本項目の範囲外で、別途 CEO 承認のうえ既存 deploy 手順で行う。

<!-- roadmap:id=current-truth-dual-record-prevention state=planned priority=high -->
0. [ ] **「新しい Current Truth を追記しつつ古い記述を残す」ことで 1 ファイルに 2 つの真実が同居する問題を、既存ルール・既存生成処理・既存 validation の改善で止める** — 2026-09-15 監査（Confirmed / P1）。監査 92 Finding の**共通根本原因**。

   **#211 が既に一部を解決している（重複しないこと）**: #211 は
   「現在の可否は `state=` が正本」という方針を本ファイル冒頭へ加え、
   ledger 本文の延期表記を「書かれた時点の記録」と位置づけた。
   **本項目はその方針を前提とし、ledger 以外の surface と機械側の 2 点だけを扱う。**

   **観測された事実**: repository には既に正しいルールがある —
   `docs/project_memory/rules/development_rules.md` の
   「**Current Truth優先 — 該当箇所そのものを現在の結論へ更新する**」。
   しかし実際には**追記的**に適用されてきた:
   - `specs/11_runtime_environment.md` は §18 に「Current Truth（2026-08-14修正）」を足したが、
     §3b / §4 / §6 / §7 の旧記述（Docker Sandbox が現行機構・`/workspace/project`）を残した
   - `AGENTS.md` は §1-1 を足したが、§1 の「Docker が物理的に強制する」を残した
   - `project-auto-completion-detection` は `state=done` の item の**後ろ**に訂正を足した
     （結果、訂正が生成ブロックの未完了一覧に現れない）
   - `docs/project_memory/decisions/006_ai_cli_adapter.md`（Status: active）は
     「Meta Reviewer AI は CLI ではなく API を使う」と規定したまま、実装が `preferCli: true` へ
     変わったことを記録していない

   **【2026-09-16: Goal / Design Philosophy / `CLAUDE.md` §7 を本項目の範囲として処理した】**

   read-only 調査で、**Project 固有の Goal と Design Philosophy が2系統あり内容が違う**ことが判明した。
   どちらも**生きていて別々の消費者が読んでいた**:
   - **Project レコード**（`projects.goal` / `projects.designPhilosophy`）… Roadmap 生成・Project 定義分析が読む。
     CEO-authored の15原則と4点 Goal が入っている
   - **`docs/project_memory/goal.md` / `design_philosophy.md`** … `contextManager.ts` が
     **実装 AI へ渡る Context Pack** として読む。2026-05-28 の旧 Mission と旧8原則のまま

   CEO 指示（2026-09-16）に従い、**正本を Project レコードへ一本化**し、
   2つの Markdown は**独立した正本ではなく同期された View** として扱う形に直した
   （先頭に「正本は Project レコード。食い違ったら Project レコードを正とする」と明記）。
   **新しい Roadmap item は作っていない。**

   併せて **`CLAUDE.md` §7 の stale な事実記述**を実体へ同期した（CEO が限定承認）。
   §7 は存在しない `features/` と `lessons_learned/` を正式 home として記載し、
   **実在する `specs/` を記載していなかった**。実物を確認して置き換え、
   Lessons は実際の置き場である `decisions/` に集約すると明記した。
   **Design Philosophy / Safety Boundary / Authority / Approval / Gate / Guard 要件は変更していない。**
   原則の追加・削除もしていない。事実記述の同期のみである。

   **本項目でやらないこと（明記）**: **新しい Review / Gate / Workflow / doc-lint 基盤を追加しない。**
   「文書更新を強制する新しいゲート」を作ると、それ自体が次の二重正本になる。

   **(A) 既存ルールの改善 — `development_rules.md` の Current Truth 章**:
   現行は「該当箇所そのものを更新する」で止まっており、
   **置換できない場合（履歴として残す必要がある場合）の扱いが書かれていない**ため、
   実務では追記が選ばれてきた。追記を選ぶときは
   **旧記述側に supersede マーカーと日付を付ける**、という 1 点を足せば、
   二重正本は機械的にも人的にも識別可能になる。
   `docs/adr/0001` / `0002` は既にこの形（冒頭に正本ポインタ）を実践しており、**手本が repository 内にある**。
   #211 が roadmap の `state=` について行った整理を、他の surface へ一般化する作業でもある。

   **(B) 既存 validation を CI で走らせる**:
   `pnpm roadmap:check` は既に存在し root `package.json` の `verify` にも含まれているが、
   **`.github/workflows/ci.yml` は `pnpm -r typecheck` と `pnpm -r test` しか実行しない**。
   そのため roadmap のメタデータ不整合と `PROJECT_CURRENT_STATE.md` の同期ずれは PR で検出されない。

   **2026-09-17 実測（この欠落が実際に master を壊した）**: `blocked-job-revert-material-not-persisted` が
   `tasks/roadmap.md` に 2 箇所存在し、**master 上で `roadmap:check` が失敗する**状態が発生した。
   #240（Finding 登録・`state=deferred`）と #235（実装 PR・`state=planned`）が同じ item を
   それぞれ持ったまま両方 merge されたため。どちらの PR も CI は green だった —
   `ci.yml` が `roadmap:check` を実行しないので、**重複 ID は誰にも検知されずに master へ入った**。
   検知されたのは、無関係な作業中に手元で `pnpm verify` を回したときである。
   修復は別 PR で行い、内容が superset だった #240 側（`deferred`）を残して #235 側を削除した。
   **本項目の (B) が入っていれば、この重複は PR の時点で落ちていた。**
   **既存 workflow に 1 step 足すだけ**で再発は防げる。
   新しい workflow も新しい required check も追加しない（required 化の要否は CEO 判断）。

   **(C) 既存生成処理の破損修正 — `extractTitle()`**:
   `apps/worker/scripts/roadmap/roadmapParser.ts` の `extractTitle()` は
   `checkboxText.indexOf('—')` で最初の em-dash までを title とし、
   `CHECKBOX_LINE_REGEX` は**1 行しか読まない**。結果、
   `docs/PROJECT_CURRENT_STATE.md` の自動生成ブロックに **`**` 不整合が 18 件**残っている
   （2026-09-15 master で実測）。加えて 1 行目が折り返している item は文中で切れる。
   最悪例は生成結果が `- **`⚠️ CONTROL REPOSITORY（state: planned）` となり、
   原文「…注記と実際に強制される保護範囲が一致していない」に対し**意味が反転している**。
   `roadmap:check` は byte 一致を見るだけなのでこの破損を検知しない。
   なお `**Title** — 説明`（em-dash が bold の外）の形は現在の実装でも正しく処理される。

   **着手時に確認すること（実装方針を先に決めない）**:
   - (A) は `development_rules.md` への**1 段落追加**で足りるか。Importance Level と Status は既存のまま
   - (B) は `ci.yml` への**1 step 追加**で足りるか。required 化するかは分けて判断する
   - (C) は `extractTitle()` を emphasis-aware にするか、title を `**...**` の範囲で取るか、
     折り返し行を連結するか。**既存の roadmap 本文を一括書き換えして回避しない**
   - 効果検証可能性: (B) 導入後に CI が drift を検出した件数が数えられること

---

### 優先度 4: implementation ↔ docs 不一致

<!-- roadmap:id=governance-and-spec-docs-current-truth-sweep state=planned -->
0. [ ] **governance / spec / decision 文書の Current Truth 一括更新（実装は変更しない）** — 2026-09-15 監査（Confirmed / P2）。個別 item 化せず 1 回の sweep として扱う。`current-truth-dual-record-prevention` (A) を最初に適用する対象でもある。

   **本 sweep が扱わないもの（重複回避）**: 憲法の共通行動原則の範囲表記
   （3.14〜3.15 / 3.16 / 3.17 の不一致）は **PR #85 / #87 が扱っている**ため対象外。
   ledger 本文の延期表記は **#211 が方針で解決済み**のため対象外。

   **最優先（AI へ注入されるため）**:
   - `docs/multi_ai_step_review_flow.md` **全体が「Claude Sonnet が実装者」という旧 Role 体制のまま**。
     `AGENTS.md` §3-2（`CLAUDE.md` が正本と宣言）では PL Role は Claude Opus で
     **原則として自分で作業する Agent ではなく**、実装は OpenCode Go / Codex Sol。
     この 2 つは当該文書に **0 回**登場し、supersede 注記も無い。
     `role-model-registry` が完成するまでの間の正本ポインタとして最低限 §3-2 を指すこと
   - `docs/project_memory/design_philosophy.md` に **Design Philosophy #8「効果検証可能性」が無い**
     （`CLAUDE.md` §3 は 8 原則、こちらは 7 原則）。**機械が読むのはこちら**
     （`apps/worker/src/guards/alignmentChecker.ts` の `DESIGN_DOCS_PATHS`。`CLAUDE.md` は含まれない）。
     結果 #8 は Gemini Alignment Review へ一度も提示されていない
   - `AGENTS.md` §4「自律修正ループ（暫定 — task-009実装まで）」は**自らの削除条件を満たしている**
     （task-009 は両 ledger で `[x]`、`jobRunner.ts` は稼働コード）。さらに §4 の
     「マージは **CEO（人間）が行う**。AIはマージしない。」が §3-1 の
     「…すべて満たす通常変更は、AI側でmergeまで進めてよい」と**同一ファイル内で無条件に矛盾**している
   - `AGENTS.md` と `docs/multi_ai_step_review_flow.md` が **Review Level 1 で正反対**
     （前者は「Codex+Gemini postReview」、後者は「原則Gemini不要」）
   - `CLAUDE.md` §7 の Project Memory 構造に **`features/` と `lessons_learned/` が存在しない**
     （`specs/05` の Layer 4 / Layer 6、`specs/10` では Feature Knowledge が MVP Required）。
     未記載の `docs/project_memory/specs/` がある

   **specs/**:
   - `specs/10_mvp_scope.md` が**出荷済みの 5 機能**（Reviewer AI / QA AI / Drift Detection /
     Notification System / Health Metrics）を「除外 / Phase 2 Candidates」と記載。
     同章に残る `Memory Governance` と `Context Feedback Loop` は本当に未実装なので
     **リストの半分だけが正しい**。`mvp_completion.md` が「判定根拠はこれのみ」と指定した文書である
   - `specs/10` の「Storage: Markdown Files のみ / DB不要」→ Decision-003 で SQLite へ変更済み
   - `specs/11` の「認証（現状はAPI Token方式のみ）」→ 3 モード実装済み
   - `specs/11` の Current Truth ブロック自身が古い（`execFileSync` → 現在は per-job cgroup 封じ込め）。
     「コンテナ隔離・Job単位 mount namespace は未実装」という狭い主張は依然 true で、
     **機構の説明だけが古い**。`jobRunner.ts` の docstring も同じ
   - `specs/11` が Workspace Boundary を **`/workspace/project`** と書く（実装は `/workspace/target`）
   - `specs/11` の Command Allowlist が `CommandKind`（11種）と一致せず、
     `npm install` / `python -m pytest` を許可と読める
   - `specs/03` が未実装の復旧設計（隔離環境を破棄して 1 回だけ自動再実行）を現行挙動として記載。
     実際は `jobStateManager.ts` が**workspace を保持して quarantine する**
   - `specs/04` の Meta Reviewer provider 記述が 4 段フォールバック
     （Gemini API → Gemini CLI → Antigravity/Claude → Copilot）を反映していない。
     Claude 段が発動すると **spec が挙げる相関バイアス排除の根拠が崩れる**
   - `specs/09` の「作成直後の状態: `Running`」→ 実装は `default('draft')`。
     `specs/08` に実装されたことのない `Maintenance` があり `draft` が無い
   - 本ファイルが `specs/14_technology_sourcing_oss_reuse_team.md` を「正本とする」と参照するが**存在しない**
   - `specs/03/05/06/07` に実装ステータス注記が無く、未実装の設計目標が現在形で書かれている。
     `specs/11`/`13`/`20` は持っている形式。**設計目標そのものは古いという理由で変更しない**
   - **「MVP開発中」という発動条件が消滅した制約**が `specs/00`（3 箇所）/ `specs/20`（2 箇所）/
     `specs/13`（1 箇所）で現在形のまま AI の振る舞いをゲートしている。
     #211 は ledger の `state=` について解決したが、**spec 側のこの表現は対象外**だった。
     対象機能（Diagnosis / Research / Experiment / Evolution 等）は本当に未実装なので
     **未実装ステータス自体は正しい**。問題は条件文だけ。
     継続するかは Constitution §3.15 に基づく **CEO 判断**

   **decision records / API 記述**:
   - `006_ai_cli_adapter.md`（Status: active）が「Meta Reviewer は CLI ではなく API を使う」と
     規定するが、実装は `preferCli: true` で CLI 優先、さらに Copilot CLI / Antigravity CLI 段を持つ
   - 削除済み `POST /api/cto/generate-roadmap` が本ファイルの 6 箇所で現在形のまま
     （`ctoAi.ts` に `// removed in PR C.`）。`roadmap_topology_cutover_step2_production_e2e.md` は
     正しく削除を記録しており、**ledger 側だけが古い**
   - 本ファイルが存在しない `POST /api/tasks/:id/failure-questions` を将来実装者への確認対象として
     指示している（実在は `/failure-ask`）
   - `docs/PROJECT_CURRENT_STATE.md` の「現在Productionで稼働しているcommit」が 2026-08-19 のまま
     （以降の deploy を本ファイルが記録している）。ヘッダの `最終更新` も同様
   - 件数・行番号 drift: test ファイル数（記載 52 / 実測 147）、共有型（19種 → 25 ファイル）、
     `specs/`（01〜11 → 15 ファイル）、workflows（2 → 3）、
     Mobile app（`{index,create,approvals}.tsx` → **実測 8 画面**。同ファイルの自動生成ブロックは
     Task/Job 一覧・詳細画面を完了項目として列挙しており**自己矛盾**）、
     「`apps/mobile` は test を持たない」→ 実在する、
     「`scripts/` ディレクトリごと存在しない」→ 実在する（削除は `scripts/metaReview.ts` 単体）、
     Codex `--approval-mode auto-edit` → 実際は `exec --sandbox`

   **着手時の制約**: **実装は一切変更しない。** 記述のみ。
   `current-truth-dual-record-prevention` (A) を適用し、**置換できないものには supersede マーカーを付ける**。
   量が多いため、AI へ注入される 4 件（`multi_ai_step_review_flow.md` / `design_philosophy.md` /
   `AGENTS.md` §4 / Review Level 1）を先に片付けること。

<!-- roadmap:id=project-completion-badge-wording-correction state=done -->
0. [x] **`done` item の中に埋もれた 2026-09-13 の訂正が未実施のまま、生成ブロックからも見えない**
   — **完了（2026-09-18, Candidate `ea3141c`）**。VPS PL による Tier A 自己開発。

   **完了の根拠（acceptance criteria と実成果を照合した）**:
   1. `apps/mobile/app/index.tsx:425` のバッジが `ロードマップ消化済み`。`完了` ラベルは無い
   2. `packages/shared/src/types/project.ts:51-63` に doc コメント。
      「Goal 達成ではなく Roadmap 消化状態」「`isComplete` を Project 終了の根拠に使わない」を明記
   3. `specs/00_constitution.md:118`（3.10 Goal Driven）へ Project Model 原則を統合。
      **新規 spec は作っていない**（commit の specs/ 差分は `M` のみ）
   - Review Job `03a232c2` = `approved`。QA AI 自身が「3 件すべて実施、受入条件 4 件を満たす」と要約
   - File Change Guard 通過、変更は上記 3 ファイルのみ（`allowedPaths` 内）
   - `git_commit` は CEO 承認（`approval-20260918-037d5430`, CONSUMED）を経て成立

   **この `done` は未検証完了ではない。** 上記 evidence と受入条件を照合したうえでの完了記録である。

   **本件から出た設計上の学び**は `executed-item-remaining-work-has-no-continuation` と
   `adoption-does-not-check-implementation-feasibility` へ記録した（重複記載しない）。

   ---
   以下は登録時の記録。

   2026-09-15 監査（Confirmed / P2。2026-09-15 master で 3 件とも未実施を再確認）。

   **事実**: `project-auto-completion-detection`（`state=done`）の `[x]` item の**後ろ**に
   2026-09-13 の訂正が追記され、3 つの最小修正を指示し
   「放置すると AIteamOS 自身が Roadmap 途中で「完了」と表示される」と結んでいる。3 件とも未実施:
   1. Mobile のバッジを「完了」→「ロードマップ消化済み」相当へ —
      `apps/mobile/app/index.tsx` は今も `<Text style={styles.badgeText}>完了</Text>`
   2. `ProjectRoadmapCompletion` に doc コメント — `packages/shared/src/types/project.ts` は
      3 フィールドのみでコメント無し
   3. Project Model 原則を `specs/` へ — `grep -rn "Project Model" specs/` → 0 件

   **なぜ独立 item にするか**: 親 item が `state=done` のため、この訂正は
   `docs/PROJECT_CURRENT_STATE.md` の自動生成「未完了・保留項目」に**現れない**。
   訂正が可視化機構から構造的に漏れている。
   これは `current-truth-dual-record-prevention` が扱う「追記型 Current Truth」の具体例でもある。

   **着手時の制約**: 文言と doc コメントのみ。**判定ロジックは変更しない**（訂正自身がそう指示している）。

---

### 優先度 5-6: dead / orphan / obsolete と単純 cleanup

<!-- roadmap:id=audit-2026-09-15-low-priority-cleanup state=planned -->
0. [ ] **2026-09-15 監査由来の低優先 cleanup（P3 一括。単独で着手せず、近くを触る通常開発のついでに片付ける）** — Confirmed / P3。

   **重要**: 以下はすべて**現時点で実害が確認されていない**。
   **「古いから」という理由だけで削除しない。** 各項目の理由を確認してから触ること。

   **dead / orphan（削除前に理由を確認する）**:
   - どこからも参照されない export 8 件: `currentStateSync.ts` の 2 件、`roadmapParser.ts` の 1 件、
     `types/actor.ts` の `DEFAULT_AGENT_ROLES`、`types/command.ts` の `COMMAND_ZONES`、
     `types/meta_review.ts` の `META_REVIEW_BLOCKED_TRIGGERS`、`types/project.ts` の 1 件、
     `types/supervised_run.ts` の 1 件。
     **`COMMAND_ZONES` は単純削除より先に確認が要る**: 全 `CommandKind` を `'green'` にマップしており
     `git_commit` も含むが、現行ポリシーは逆（`routes/approvalGate.ts` の
     `GIT_COMMIT_POLICY_LABEL = 'git_commit requires CEO approval (policy)'`）。
     CLAUDE.md §4 の Green/Yellow/Red Zone へ配線されると commit を Green と誤分類する。
     **dead かつ現行ポリシーと矛盾**
   - `apps/worker/src/guards/approvalGate.ts`（re-export shim。production importer 0）と、
     そこに複製された `computeDiffHash`（`routes/approvalGate.ts` と同一実装。
     「computeDiffHash 互換性」テストがあり分裂を認識している）
   - invoker の無い CLI: `apps/worker/scripts/deployCanary.ts`（本ファイルが「deploy canary 全 PASS」を
     運用事実として記録しているので**手動実行されている**が、起動コマンドがどこにも記録されていない）、
     `apps/api/scripts/dbRestoreTest.ts`（`vps-operation-docs-current-truth` (4) と同根）
   - `apps/api/src/designReview/repairFlow.ts` の `runRepairFlow` — production caller 無し。
     live な経路は同ファイルの `prepareRepairFlow` / `executeQueuedRepair` / `escalateTaskToHuman`。
     **他の未配線コードと違い理由コメントが無い**ので、存廃を明示的に決める
   - 意図的に非到達な provider 分岐（**理由がコードに明記済み。削除しないこと**）:
     `copilot` provider（API ingress schema が除外。2026-08-26 独立レビューの記録あり）、
     `ClaudeReviewerAdapter`、`case 'chatgpt'`。`reviewSeparation` 周りの「常に false な条件」も
     **将来の定数変更を検知する tripwire** なので削除しない
   - `.gitignore` の `data/quota-exhausted.json` は `geminiRouter.ts` が書かなくなったため無効。
     コメントが参照する `data/README.md` も `data/` ごと存在しない

   **fix 後に残ったコメント・記述**:
   - `apps/worker/src/approvalLevel/safetyVerifier.ts` の「Step3時点ではPost-Reviewは未実装のため…」→
     `postReviewer` は実装済みで `jobRunner.ts` が渡している
   - `docs/project_memory/rules/001_codex_integration_risks.md` の「⏳ …は task-009 で実装」は
     **両方向に誤り**（task-009 は完了、adapter 側 `shouldFallback()` も実装済み。
     ただし `fallbackPolicy` は未配線で、それは `AGENTS.md` が正しく記述している）
   - `docs/project_memory/decisions/native_runtime_verification_codex_phase2_real_e2e.md` が
     「一時ファイルは `workingDir` 配下に作られ…File Guard管理外にはならない」と
     **現在形の一般的な安全保証**として書いているが、
     `codex-last-message-temp-file-in-target-repo` の修正により OS temp（`workingDir` の外）へ移った。
     日付スコープを付ける
   - `packages/shared/src/types/approval_gate.ts` と `approvalGateLogic.ts` の
     「TODO: Phase 2 で Independent AI Review に差し替え」— 独立レビューは**別機構で稼働中**
     （`reviewerAdapter.ts` / `strategicReview.ts` / `pl/actionGate.ts`）で、
     `RiskReviewResult.independentReviewResult` は未使用。かつ live な verdict 語彙は別値
     （`routes/designReviewEvidence.ts` の `['approved','changes_requested','blocking']`）。
     **同名・別値・片方 dead** なのでどちらが正本かを決める

   **その他**:
   - `apps/api/src/storage/schema.ts` の `DELETE FROM watchdog_events` が
     `INDEX_STATEMENTS` という名前のリストに入り毎起動実行される。範囲は限定的で初回以降 no-op だが、
     `production state を破壊しない` 原則から一度きりの guarded migration へ移す
   - `.github/workflows/gate-evidence-check.yml` — header は `pull_request_target` を使う理由を
     長く説明するが実際の trigger は `workflow_dispatch` のみ。かつ
     `github.event.pull_request.number` を読むため手動実行では `PR_NUMBER` が空になり
     `gh api "repos/.../pulls//commits"` が 404 → `set -euo pipefail` で中断する。
     「適用対象外」という判断自体は正しく記録されているので、header か inputs のどちらかを合わせる
   - Meta Review の fallback 順序が 3 箇所のコメントで逆
     （`meta-review.yml` / `metaReviewFallbackRouter.ts` / `geminiCliAdapter.ts`）。
     実際は `preferCli: true` により CLI(agy) → API → Antigravity/Claude → Copilot。
     `docs/multi_ai_step_review_flow.md` だけが正しい。**挙動は安全**なのでコメントのみ
   - `docs/multi_ai_step_review_flow.md` の**見出し番号が衝突している**（Final Review Packet
     テンプレートが `## 1.`〜`## 15.` を文書自身の章番号と同じレベルで使う。
     `## 2-2` が `## 2-1` より前、`### 19-1/19-2` が `## 20` の下）。
     これが原因で `CLAUDE.md`（10-1章）、`AGENTS.md`（11-1章）、`specs/00`、`specs/13` の参照が
     **すべて存在しない章を指している**。テンプレート部を `###` 以下へ落とすか code fence 化し、
     参照側を直す。**憲法の範囲表記そのものは PR #85 / #87 の担当なので触らない**
   - commit / branch 規約がいずれも実運用と違う（`CLAUDE.md` / `AGENTS.md` / `development_rules.md`）。
     default branch は `master`、実際の commit は Conventional Commits + PR 番号で
     agent/task prefix 無し。`AGENTS.md` の「`git log --oneline` が誰が何をしたかのタイムラインとして
     読める状態を維持する」は現状成立していない
   - `SUBPHASE_PROGRESS.md`（repository root、**日付なし**）が自己矛盾。
     表は SP-1〜SP-7 を `✅ done` とするが本文は `## SP-2〜SP-7（予定）`、
     SP-1 の完了条件チェックリストは全て `[ ]`、「本流復帰ポイント」は既に完了した作業を指す。
     **表側が正しい**（KG の全エンドポイントが実在、`knowledgeGraphRoutes` は登録済み）。
     完了日付と history ラベルを付ける
   - `ALIGNMENT_VIOLATIONS.md` AV-001 の未チェック行とチェック済み行が**同一 entry 内で矛盾**
   - 本ファイル内で「`cross-project-state-api` に包含される」と自ら宣言しながら `state=planned` のまま
     独立 open item として数えられている 2 件
     （`review-substage-progress-reporting` / `containment-success-path-observability`）
   - 本ファイルが cheap AI の spawn 先を `node_modules/opencode-ai/bin/opencode` と書いているが、
     実装は `bin/opencode.exe`。**`.exe` が正しい**（下記 false positive 参照）。記述側を直す
   - `docs/codex_prompt_footer.md` は repository 内のどこからも参照されていない orphan doc で、
     内容も Windows PowerShell 前提（`docs/env-notes.md` も同様に完了済み task の指示と、
     死んだ `tasks/active/` 運用のチェックリストを残している）
   - `docs/adr/0002` の `process.env` 一覧が drift（行番号が全てずれ、7 変数が未収載）
   - `docs/meta_reviewer/checklist.md` の 2 パスが `src/` 抜け。
     `docs/meta_reviewer/checklists/sandbox.md` は「`curl` 等が追加されていない」を要求するが
     `sandbox/Dockerfile` が `curl` を install しており、**自リポジトリの Dockerfile を fail させる**。
     `runner.ts` の `getFileChecklists()` は `apps/api/src/{pl,ctoAi,supervision,designReview,auth}/` と
     `apps/worker/scripts/` に専用 checklist を当てない（カバレッジのギャップ）
   - `tasks/task_graph.md` は `*Updated: 2026-06-06*`、`Phase 2 進行中`、
     Target Project が別製品（`ai-distribution-engine`、Windows パス）のまま。
     control repo 側を更新する自動経路は存在しない（`summaryEngine.ts` と `roadmapWriter` は
     **targetProjectRoot 配下にのみ**書き、`roadmapAdoption.ts` は書かないと明記）。
     `tasks/active/` の 12 ファイルはすべて完了済み作業。
     `CLAUDE.md`「タスク完了時は必ず `task_graph.md` を更新する」が実行不能な状態なので、
     **CLAUDE.md §8 を実態（roadmap.md が正本）へ合わせるか、両者に history ラベルを付けるか**を決める

   **本項目では新しい仕組みを一切作らない。**

---

### 監査で false positive と確定した Finding（記録のみ・対応不要）

- **「`cheapAiClient` が Linux production で Windows バイナリを解決する」→ false positive。**
  `apps/api/src/aiExplain/cheapAiClient.ts` の
  `join('node_modules','opencode-ai','bin','opencode.exe')` は**正しい**。
  2026-09-15 に npm registry の実配布物で確定した:
  `opencode-ai@1.18.16` の `package.json` は `bin = {"opencode": "bin/opencode.exe"}` を
  `os: ["darwin","linux","win32"]` すべてに対して宣言し、tarball の bin ファイルは
  `package/bin/opencode.exe` の**1 つだけ**。`postinstall.mjs` は
  `sourceBinary = platform === "windows" ? "opencode.exe" : "opencode"` を
  **全 platform で `targetBinary = bin/opencode.exe` へコピーする**。
  すなわち Linux 上でも `bin/opencode.exe` が正規パスであり、中身は Linux バイナリである。
  production で PL adoption がこの経路を通って成功している観測とも整合する。
  **コードは正しく、本ファイルの記述（`bin/opencode`）の方が不正確**（上記 cleanup item で扱う）。

### 追加調査が要る Finding（item 化しない）

- Design Review の idle 検知が `currentTask` に限定されている（`systemState.ts`）。
  2 つの design-review run が同時に queued になる経路を特定できなかった。
  緩和策は存在する（`totals.activeDesignReviews` は全体集計、`recoverAndRekickAtStartup` は全 queued を drain）
- Watchdog の stall 閾値が AI CLI Job（`kind: 'test'`）を想定していないが、
  AI CLI 自身の timeout が先に発火するのが通常で、live な誤報を確認できなかった
- `requiresIndependentReview` が分岐に使われていないが、`gate_evaluations` 行に
  evidence として載っているかを未確認（載っていれば有効）
- root `pnpm build` と per-app `start` が成立しない件は本ファイルが既に記録済み
- ledger に id が無いまま open と宣言されている「legacy `API_TOKEN` → ADMIN / WORKER split
  credential migration」は、対応する item が存在しない。**CEO 判断**（production cutover を伴うため）

---

## PL Console（ベンダー非依存のPL指示UI。低優先・本線安定化後に着手）

**位置づけ:** 将来の重要基盤だが、**現在の完成作業を遅らせない低優先度タスク**。
Phase 1c E2E・Recovery・Worker・Gate・Roadmap実行系などの**本線安定化を常に優先する**。
本セクションは検討・評価のための項目であり、登録時点では実装・PoC・本線変更を一切行っていない。

**2026-09-13 追記**: 下記 PL Console 4項目（いずれも `deferred`）の**前提**として
`cross-project-state-api` を新規登録した。見た目の Console より先に
「正確な状態・イベントが取得できること」を優先する方針であり、
PL Console 4項目の state・優先度は変更していない。

<!-- roadmap:id=cross-project-state-api state=in_progress -->
0. [~] **横断状態読み出し API（Console より先に、状態が取れることを優先）** — 2026-09-13登録。
      **【2026-09-14 進捗: read 口を実装。残りは `audit_log.project_id`】**
      `GET /api/state`（`apps/api/src/routes/systemState.ts` / `src/state/systemState.ts`）を実装した。
      **read-only で副作用を持たない**（既存 GET の契約を維持。回帰テストで固定）。
      権限判断もしない（必要 Gate の決定は `mandatory-gate-policy` の責務）。

      返すもの: Project ごとの status / roadmap 進捗 / current task（allowedPaths 含む）/
      Job の status 別件数と最新 Job（provider・exitCode・commitHash・changedFiles・stderr 末尾・
      quarantine 状態）/ 承認待ち件数 / pending continuation 件数 / Design Review の status・attempt・
      error・**idle 判定**。加えて全体 totals（Project/Job の status 別、quarantine 数、承認待ち、
      continuation、active design review、active supervised run）。

      **`attention` 配列が PL 向けの中核**である。単なる状態羅列ではなく「いま止まっている / 判断が要る」
      ものだけを返す: `job_blocked` / `workspace_quarantined` / `approval_waiting` /
      `design_review_failed` / **`design_review_idle`** / `continuation_pending` /
      **`task_ready_without_job`** / `job_running_long`。
      `design_review_idle` と `task_ready_without_job` は、今回 production で実際に発生した
      「誰も再開しないまま止まる」2形態をそのまま検出する。
      **`attention` は観測事実のみで、対処方法は含めない**（行動選択は PL、実行可否は Gate）。

      **【2026-09-14 Operational Verification: production の実停止状態で検証済み】**
      Stable `bb46910` を production へ deploy し、実際に止まっている状態へ当てて検証した。
      結果: `attention` は2件のみを返し、両方とも実際に止まっている Task `76ea5ff3` のものだった。
      `design_review_failed`（detail: `design review failed after 3 attempt(s): runner timed out
      after 120000ms`）と `task_ready_without_job`。**誤検出ゼロ**（archived 57 Project と、
      archived 配下の queued Job 3件はいずれも `attention` に出ない）。
      **副作用ゼロ**を実測で確認した（呼び出し前後で 10 テーブルの件数と内容 hash が完全一致:
      `40c4879f044dd12f`）。

      **この検証で見つけた欠落と、その修正（PR #175 / `bb46910`）**: 初回 deploy 時点では
      `design_review_failed` が出なかった。`findActiveByTaskId()` が queued/running しか返さず、
      **failed で終端した review＝まさに停止理由そのものが観測対象から外れていた**ためである。
      read-only の導出 `findLatestByTaskId()` を追加して修正した。
      `design_review_idle` は現時点の production に queued/running の review が存在しないため
      実機では観測できていない（検出経路は unit test で固定済み）。**観測できていないものを
      「検証済み」とは書かない。**

      この結果をもって、本項目は VPS PL 基盤の Observe 入口として**実運用で機能することが
      確認された**。最初に検出した停止理由がそのまま open Finding
      `design-review-runner-production-timeout` を指しており、PL 基盤完成後の最初の実戦対象になる。

      **残っている作業（本項目は完了にしない）**: `audit_log` への `project_id` 追加（additive）。
      AIcompanyOS 互換の最小構造であり、PL ループには必須でないため後続で行う。
      archived Project は観測対象から除外している（履歴は既存の Project 単位経路で読む）。

      **【2026-09-14 追記: 本項目は MCP と Operator Chat の共通基盤である】**
      CEO 方針 item 4（MCP 用と Mobile Chat 用に別々の操作系を作らない）の受け皿は本項目とする。
      `chatgpt-mcp-inspect` と `operator-chat-mobile` は**どちらも本項目の read 口を消費**し、
      write 側は既存 API（`POST /api/tasks/:id/resume` / `PATCH /api/jobs/:id/clear-quarantine` /
      `PATCH /api/approval-requests/:id/status` 等）をそのまま使う。
      **新しい Control subsystem は作らない。**
      したがって本項目は単独の観測改善ではなく、**2/3/4/10 の共通前提**として優先度が上がる。
      返す情報には blocked 理由・quarantine・retry / resume 状況・Recovery / Watchdog も含める
      （Operator Chat の6問に答えるために必要）。

      **新しい UI・新しい telemetry 基盤・新しいダッシュボードは作らない。**

      **解く問題**: 既存エンドポイントはすべて Project 単位か entity 単位であり、
      「いまシステム全体で何が起きているか」に答えられるものが無い。
      人間だけでなく **AI 自身が現在状態を理解できること**を目的とする。

      **既に存在する素材（再利用する）**: `/dashboard`・`/kg/health-score`・`/kg/timeline`・
      `/watchdog-events`・`gate_evaluations`・`design_review_runs`・`supervised_runs`・
      `audit_log`・`executionLogStore`・`jobs.failure_explanation_json`。
      不足しているのは**横断して1度に読む口**と、下記の `project_id` である。

      **やること**:
      - Project ごとに Roadmap 進捗 / Current Task / Job / Provider・Model / Review 状態 /
        Approval 待ち / error / retry / recovery / cost / runtime progress を返す読み出し口
      - `audit_log` へ `project_id` を追加（**additive**。既存4箇所程度の書き込み側を更新）。
        Project 単位で event を切れるようにする
      - cost は `role-model-registry` 対の Model Usage Telemetry が入って初めて実値になる。
        未記録の間は「未計測」を明示し、**推測値を返さない**

      **AIcompanyOS 互換の最小範囲**: `audit_log.project_id` と上記読み出し口までを
      「後から全 Project を大改修せずに済む最小情報構造」とする。
      **Business Goal / Success Metrics / Target Customer 等の Business Management 項目は
      AIteamOS へ持ち込まない**（AIteamOS と AIcompanyOS の責務境界を維持する）。

      **依存**: `project-workspace-isolation`（Project が実際に並行しないと横断の意味が薄い）。
      `containment-success-path-observability` と `review-substage-progress-reporting` は
      本項目に**包含される**（重複実装しない。両項目は本項目の受入条件へ畳む）。

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

<!-- roadmap:id=mandatory-gate-policy state=in_progress -->
0. [~] **Mandatory Gate Policy — PLは判断するが、自分の権限とGateの要否を決めない** — 2026-09-14登録。
      **【2026-09-14 進捗: Policy Engine と enforcement seam を実装。残りは PL ループからの配線】**
      `resolvePlActionPolicy()`（`packages/shared/src/plActionPolicy.ts`）と
`authorizePlAction()` / `previewPlActionPolicy()`（`apps/api/src/pl/actionGate.ts`）を追加した。
      **新しい Gate 本体・新しい Review 工程・新しいテーブルは作っていない**（記録は既存 `audit_log`）。

      実装した不変条件（テストで固定）:
      - `plRiskOpinion` は `requiredGates` の算出に**一切使わない**（記録のみ）。
        全 action kind について、LOW 申告でも CRITICAL 申告でも requiredGates が同一になることを検査している
      - `plProposedGates` は **union にしか効かない**（増やせるが減らせない）。
        解決できない Gate 名は無視するだけで、減らす方向には働かない
      - `change_safety_boundary` / `change_own_permission` / `override_gate_block` /
        `skip_required_review` は常に `forbidden`。自己申告を足しても解けない
      - **未知の action kind は素通しではなく forbidden**（語彙を1つ増やすだけで Gate を回避できない）
      - Independent Review の独立性条件は PL より上位。同一 vendor になる provider 切替と、
        vendor を特定できない provider への切替は `forbidden`（`reviewSeparation` を再利用）
      - BLOCK 時に PL が取れるのは fix / re-review / 代替案 / CEO Escalation の4つのみ。
        **override 経路は型としても存在しない**
      - 変更ファイルがあるときは既存 `runRiskReview()` と `runMechanicalGate()` へそのまま通し、
        HIGH/CRITICAL で independent_review、CRITICAL と Mechanical Gate hit で ceo_approval まで上げる

      **【独立レビュー（OpenAI / Codex, 2026-09-14）の指摘と、それを受けた修正】**
      初版は「判定結果オブジェクト」と「充足済み Gate の文字列配列」を引数で受け取っていた。
      PL ループは外部プロセス（LLM + provider CLI）であり、そのどちらも PL が作れる。
      **Policy Engine を置いても、seam が PL の作った値を信じるなら境界は存在しない**という
      指摘は正しく、以下を修正した:
      - 許可経路は**提案から判定を作り直す**。判定オブジェクトを
        差し込む引数を廃止した（`recomputeDecision()` が runner の自己申告を採用しないのと同じ形）
      - 充足の根拠は **DB の実レコードで検証する**。渡せるのは「どのレコードか」だけで、
        Gate 名の文字列を渡せば通る経路を無くした。Design Review evidence は `ALIGNED` のみ、
        Independent Review は `independentReviewRequired` かつ verdict が `approved` のときのみ、
        Approval Request は `APPROVED` かつ未失効のみ、CEO Approval は `approved` のみを充足とする
      - **検証手段の無い Gate は充足できない**（fail-closed）。`strategic_alignment_review` と
        `safety_review` は参照できる永続レコードが無いため、それを要求する操作
        （`clear_workspace_quarantine` / `rollback_commit` / `adopt_roadmap_item`）は
        配線が入るまで PL から実行できない。これは欠陥ではなく意図した fail-closed である
      - `changedFiles` が空の変更操作は `forbidden`。申告を空にするだけで file 由来の Gate を
        全て外せる穴を塞いだ
      - `resume_task` の必要 Gate に `design_review` を追加（理由文と Gate 一覧が不一致だった）

      **【独立レビュー 2巡目（OpenAI / Codex, 2026-09-14）: changes_requested → 修正済み】**
      1巡目の修正でも「根拠が対象へ束縛されていない」「認可と検証の間に隙間がある」という
      指摘が残り、以下を修正した:
      - **根拠を操作対象へ束縛する。** Task A の ALIGNED evidence で Task B の resume を
        通せない。`job` 対象では申告された `taskId` が本当にその Job のものかを DB で照合する。
        操作種別ごとに要求する対象種別（task / job / project / system）も固定した
      - **古い ALIGNED の持ち出しを禁止。** Design Review evidence はその Task の最新1件のみ有効
      - **認可と充足検証を1つの呼び出しに閉じた。** `assertPlActionExecutable()` を廃止し、
        許可を得る経路は `authorizePlAction()` だけにした。「認可した提案」と「検証した提案」が
        ズレる隙間を無くすため。見るだけの `previewPlActionPolicy()` は記録も実行権も持たない
      - **時刻を呼び出し側から受け取らない。** 期限判定を呼び出し側の時計に依存させない。
        壊れた期限値（`NaN`）を「未失効」として通さない
      - **CEO Approval に scope 束縛を追加。** 操作種別ごとに要求する `ApprovalType` を固定し、
        用途の違う承認を流用できないようにした

      **【独立レビュー 3巡目（OpenAI / Codex, 2026-09-14）: changes_requested → 修正済み】**
      fail-open は見つからなかった一方、対象種別を固定したことで**永久に充足不能な操作**が
      生まれていた（安全側だが「根拠を積めば通るはず」という誤解を招く）。修正:
      - `adopt_roadmap_item`（project 対象）は **roadmap-kind の Design Review evidence**
        （`subjectId` が projectId）で束縛できるようにした。Task 対象は従来どおり task-kind
      - `deploy_production`（system 対象）は Task/Project スコープの Review 根拠を
        構造的に結び付けられない。**充足不能であることを `unbindableGates()` が明示する**
        （missing に紛れ込ませない）。deploy スコープの Review 根拠の用意は配線側の責務

      **【独立レビュー 4巡目（OpenAI / Codex, 2026-09-14）: changes_requested → 修正済み】**
      Task スコープの照合が `taskId` 一致だけで、`reviewKind` を見ていなかった。
      `taskId` を持つ roadmap-kind の record が Task 単位の Gate を満たし得たため、
      kind も明示的に照合するようにし、回帰テストで固定した。

      **【独立レビュー 5巡目（OpenAI / Codex, 2026-09-14）: approved】**
      「fix → re-review」を Gate 結果として扱い、approved になるまで merge しなかった。
      provider 分離: 実装は Anthropic / Claude、Independent Review は OpenAI / Codex。

      **指摘のうち、ここでは直さず `vps-pl-execution-loop` の受入条件へ回したもの**:
      - `changedFiles` も `providerChange` も PL の申告値であり、**実差分・実構成との束縛は
        この層では行えない**。権威ある判定は既存の File Change Guard と Job の `gate/check` が行う。
        配線時に「申告ではなく実際の対象」を渡すこと
      - `retry_job` / `resume_task` は対象 Job の分類を引き継いでいない。配線時に
        対象 Job の risk / production 影響を継承させること
      - `allowedResponsesWhenBlocked` は情報であって強制ではない。BLOCK 後の再提案を
        別種の action で回避できないようにするのは配線側の責務
      - 実行者の Role・Production 操作権限はこの層では表現していない
      - 許可した提案と、**実際に実行される操作**が一致すること。この層は「この提案は通る」までしか
        言えない。executor を提案から構造的に dispatch するのは配線側の責務
      - CEO Approval の Project スコープ束縛。`approvals.findById()` が `projectId` を返さないため、
        現状は Approval の `type` による束縛までしかできない（`findById` の additive 拡張が要る）

      **残っている作業（本項目は完了にしない）**: PL 実行ループからの配線。
      `vps-pl-execution-loop` の受入条件に「PL の全 write 操作が `authorizePlAction()` を通ること」
      「充足の根拠は PL 出力ではなく DB の実レコードであること」「executor は許可した提案から
      構造的に dispatch すること」を含める。

      **【2026-09-14 追記: 実操作の棚卸しと語彙の網羅性】**
      正式な操作を実経路から棚卸しし、判定表との差分を埋めた（**新しい Gate は作っていない**）。

      | 操作 | 実行経路 | 既存の強制 | production 影響 | 可逆性 |
      |---|---|---|---|---|
      | Task resume | `POST /api/tasks/:id/resume` | resume 用 prompt を **Design Review へ再投入**してから resume（元 prompt の evidence を流用しない）。quarantine 中は 409 | 無 | 可逆（Job 追加） |
      | quarantine 解除 | `PATCH /api/jobs/:id/clear-quarantine` | `observation` + `knownGood` 必須 + **サーバ側再検証**。force / admin による無条件解除経路は無い | 無 | 可逆 |
      | 停止 Job の強制終端 | `PATCH /api/jobs/:id/fail-if-running` | `workspaceVerified` 省略時は **fail-closed で quarantine** | 無 | 不可逆（実行中の作業は失われる） |
      | Job 完了報告 | `PATCH /api/jobs/:id` | continuation pending 中は意図的に 503 → Outbox 再送 | 無 | — |
      | Roadmap 採用 | `POST /api/projects/:id/roadmap-adoptions` | `allowedPaths` / 受入条件は**呼び出し側が明示**（ledger 散文から推測しない） | 無 | 可逆 |
      | 承認 | `PATCH /api/approval-requests/:id/status` | CEO 権限。PL の語彙に入れない（未知 → forbidden） | 無 | 可逆 |
      | Design Review 再kick | **API 経路が無い**（`recoverAndRekickAtStartup()` は API 起動時のみ） | — | 無 | 可逆 |
      | service 再起動 / deploy / rollback | **AIteamOS の外**（systemd / deploy script / git） | 既存 deploy 手順（ff-only・verified SHA） | 有 | deploy は rollback 可能 |

      判定表に無い操作は fail-closed で forbidden になるため、**語彙の穴は「その操作が永久に取れない」ことと
      同義**である。棚卸しの結果、次の3件を追加した（**fail-closed は緩めていない**。未知の値は依然 forbidden）:
      - `escalate_to_ceo` … BLOCK 時に PL へ返す4択に含まれるのに語彙に無く、提案すると forbidden になる
        自己矛盾があった。**Gate を要さない**（escalation を塞ぐと PL に残された行動が実際には取れない）
      - `rekick_design_review` … `vps-pl-execution-loop` の production evidence で実際に必要だった復旧。
        bounded retry の再実行なので `retry_job` と同じ `approval_gate`。attempt 上限は既存 coordinator が持つ
      - `fail_stuck_job` … 既存の fail-closed 経路。進行中の作業を破棄するため `abort_task` と同じ `approval_gate`

      **未決の Policy 判断（CEO 判断事項。AI 側で変更しない）**: `rollback_commit` は現在
      `safety_review` + `approval_gate` + `ceo_approval` を要求するが、CLAUDE.md 4章は**ロールバックを
      Green Zone** に置き、Design Philosophy 4・10 は「失敗しても即座に戻せる」ことを要求している。
      復旧手段が障害より重い Gate を要求する状態は、`project-auto-incident-pattern-improvement` が
      Incident 候補として扱う**過剰安全策**にあたる。推奨は target repository の git rollback（Green・可逆）と
      production deploy の rollback（Yellow・本番影響）を分け、前者を `approval_gate` のみにすること。
      **CEO Approval の要否を変える判断であるため、本変更には含めていない。**

      **Design Review 再kick の実行経路が無い点は本項目の scope 外**（`vps-pl-execution-loop` 側で扱う）。
      Policy は「その操作にどの Gate が要るか」だけを決め、実行は既存 API 経路を使う。

      **CEO 確定の不変条件（2026-09-14）**。PL の思考・原因分析・方針判断は制限しない。
      安全性は「PL が判断できないようにする」ことではなく、**PL が決めた変更・操作を必ず既存 Gate へ
      通す**ことで担保する。

      ```text
      PL → 変更案 / 実行案 → Policy Engine が必要Gateを自動判定
         → 既存Gateへ強制ルーティング → 通過したものだけ実行可能
      ```

      **PL が自分で変更・回避できないもの（不変条件）**: Strategic / Alignment Review の要否 /
      Design Review の要否 / Safety Review・Safety Gate の要否 / Independent Review の要否 /
      CEO Approval の要否 / Production 操作権限 / Safety boundary / 自身の Role・Permission level /
      Independent Review の独立性条件 / **Gate の BLOCK 結果**。
      PL がリスク分類や推奨 Gate を出すことは可能だが**参考情報に留め**、最終的な Gate 適用は
      システム側が決定する。**PL の自己申告だけで Low Risk 化して Gate を減らせる構造にしない。**

      **BLOCK されたときに PL が取れる行動**: 修正 / 再 Review / 代替案提示 / CEO Escalation の4つのみ。
      **override による実行は不可。**

      **既に満たされている部分（実測。再利用する）**:
      - `reviewLoadClassifier.ts` — review load を **changedFiles から客観的に算出**する（自己申告ではない）
      - `designReviewCoordinator.recomputeDecision()` — runner の `finalDecision` を**採用せず API が再計算**する
      - `guards/gatePolicy.ts` — ローカル判定と API 判定を統合し**安全側へ escalate** する純粋関数。
        かつ **CONTROL REPOSITORY（AI編集禁止）**
      - `guards/permissionGuard.ts` / `fileChangeGuard.ts` / Approval Gate — いずれも CONTROL REPOSITORY
      - `ALWAYS_FORBIDDEN_PATTERNS` — 安全中核ファイルの変更を機械的に拒否

      **不足している最小分（ここだけ補う）**: 上記はいずれも「Job / 変更ファイル」を入力とする。
      PL が提案する**操作（action）**（例: API 再起動 / quarantine 解除 / retry / rollback /
      provider 切替 / Task 中止）に対して必要 Gate を決める入口が無い。
      変更対象・変更種類・Production 影響・DB 変更・権限変更・Safety boundary・Design Philosophy・
      不可逆性から**必要 Gate を決定する薄い Policy Engine** を1つ足す。
      **新しい Gate 本体・新しい Review 工程は作らない**（既存 Gate へルーティングするだけ）。

      **Role / Provider / Model Routing との関係**: 独立 Review の provider 分離等の必須制約は
      **PL より上位の Policy として強制**する（`role-model-registry` から PL が緩められないようにする）。

<!-- roadmap:id=review-class-b-enhanced-ai-review state=deferred -->
4. [ ] **Review Class B（強化AIレビュー）: 通常AI判断とCEO必須判断の中間を埋める（Tier Bとは別概念・CEO承認が着手条件）** —
      2026-09-15登録（CEO 指示）。**本項目は登録であり、この指示だけを根拠に Safety Policy を変更しない。**

      **上位原則（2026-09-17 追記）**: 本項目の Class A / B / C は
      **`specs/22_safety_approval_design_principle.md`（2026-09-17 CEO 採用。同ファイルが正本）** の 10 章に従って設計する。
      同原則の採用によって本項目の**着手手順は免除されない**（下記「着手手順」1〜3 はそのまま有効であり、
      `state=deferred` も維持する）。CEO が与えたのは Class A/B/C の**定義**であって、
      着手手順 1 が要求する**具体例つき境界表**とその承認ではない。

      同原則から本項目へ入る追加要求は次の 3 点である。
      - **Risk は変更内容だけで判定しない**（同原則 3 章）。machine facts には最低限
        **blast radius / detectability / recoverability / irreversibility** に対応する事実を含める。
        「protected file か」「migration を含むか」だけでは同原則 3 章を満たさない
      - **Recoverability を実装前に確認する**（同原則 8 章）。Class B の成立条件に
        「rollback path が存在し、previous stable state が分かり、rollback 後の整合性確認方法がある」ことを含める。
        **rollback 可能性を Reviewer の自己申告で埋めない**
      - **Class B の効果は CEO 呼び出し回数では測らない**（同原則 0 章）。測るのは
        「CEO を呼ぶべき変更の識別精度」であり、**Class C の取りこぼしが 0 であること**が先に来る

      **名称の注意**: 既存の `aiteamos-self-development-tier-a` / `aiteamos-self-development-tier-b` の
      **Tier B（外部セッションで protected / high-risk 変更を扱う運用形態）とは別概念**である。
      Tier は「誰がどの環境で作業するか」、Class は「その変更にどれだけの証拠を要求するか」。混同しないこと。

      **Goal**: 通常 AI 判断（Class A）と CEO 必須判断（Class C）の間に、**十分な独立レビューと
      機械的検証を通せば AI だけで妥当に完結してよい Class B** を置く。CEO を呼ぶ回数を減らすことが
      目的ではなく、**CEO を呼ぶべき変更の識別精度**を上げることが目的である。

      **current problem（2026-09-15 実測。推測ではない）**: 既存3分類器
      （`runRiskReview()` / `runMechanicalGate()`+`classifyApprovalLevel()` / `classifyReviewLoad()`）へ
      同じ入力を通して測定した結果は次のとおり。

      | 実変更 | runRiskReview | reviewLoad | ApprovalLevel |
      |---|---|---|---|
      | `guards/fileChangeGuard.ts` に**ログ行を1行足すだけ** | HIGH | critical | **Level 3 / ceo_required** |
      | `guards/fileChangeGuard.ts` の**拒否条件を env で外す** | HIGH | critical | **Level 3 / ceo_required** |
      | 後方互換 migration（`ADD COLUMN ... NULL`） | HIGH | high | Level 2 |
      | 破壊的 migration（`DROP COLUMN`） | HIGH | high | Level 2 |

      1と2、3と4は**意味が正反対なのに出力が同一**である。さらに:
      - 破壊的 migration が `destructive operation` ルールを引いたのは**ファイル名に `drop` が
        入っていたから**にすぎず、`0043_cleanup_owner.ts` と改名すると後方互換 migration と
        **全分類器で完全に同一判定**になる（実測）
      - 2 と同じ差分を **protected でないファイル**（`apps/api/src/pl/executionLoop.ts`）で行うと
        `runRiskReview=LOW` / `reviewLoad=medium` まで落ち、Level 3 を保っているのは
        `UNMATCHED_FALLBACK`（confidence 0.4）という「**知らないものは全部 Level 3**」の既定だけである（実測）

      つまり現在の粗さは2方向に出ている。**(a) 安全な変更まで CEO へ寄る**（過剰安全策。
      `project-auto-incident-pattern-improvement` が Incident 候補として扱う対象）。
      **(b) 危険な「意味」を path でしか捕まえていない**。
      **(b) を放置したまま (a) だけ緩めてはならない。本項目は (b) を先に埋める。**

      **根本原因**: `classifyReviewLoad()` は `changedFiles` しか受け取らず **diff 本文を見ていない**。
      `runRiskReview()` も changedFiles の**パス文字列**へ正規表現を当てているだけである。
      意味を判定する材料が、そもそも入口に存在しない。

      **Class A / B / C の役割**:
      - **Class A（通常 AI 判断）** — 既存どおり。変更しない
      - **Class B（強化 AI レビュー）** — machine facts が「CEO 領域に触れている」と言うが、
        **意味は既存 Policy の範囲内**だと強い証拠で確認できる変更。CEO Approval を必須にしない。
        候補: protected file 内のバグ修正で Safety Boundary 不変 / Guard・Gate のログ・診断・
        observability 改善 / 既存 Safety Policy へ実装を適合させる修正 / 権限を**狭める**変更 /
        Control Repository 内の挙動・authority 不変なリファクタリング / 後方互換かつ rollback 可能な
        DB 変更（nullable column 追加・index 追加等、既存の意味を壊さないもの）
      - **Class C（CEO 必須。Class B へ降格させない）** — AI の authority を拡大する /
        protected・forbidden 範囲を縮小する / Guard・Gate・Approval 要件を弱める /
        Safety Boundary を弱める / CEO Approval を不要化する / production で不可逆または重大な
        destructive 変更 / rollback 困難な migration / データの意味・所有権を変更する migration /
        Design Philosophy・Goal そのものの変更 / AI が自分の権限を広げる変更 /
        Binding Safety Review との重要な衝突が未解消

      **machine facts と AI semantic judgment の分離**:
      - **machine facts** … サーバ側が**実際の変更**から算出する。AI の自己申告を入力にしない。
        protected file か / Safety・Gate・Guard・Approval 関連か / migration を含むか /
        permission・authority 関連か / Design Philosophy 関連か / production destructive を含むか /
        不可逆の可能性があるか。**PL が LOW と自己申告しても Gate は弱まらない**
      - **AI semantic judgment** … machine facts が立った差分に対してのみ実行し、diff と既存 Policy を
        根拠に最低限 `policy_maintained` / `policy_strengthened` / `policy_weakened` /
        `authority_expanded` / `irreversible_or_destructive` / `design_philosophy_change` /
        `undecidable` を区別する
      - **巨大な if 文やファイル名だけで「意味」まで機械判定しようとしない。** 逆に、意味判定を
        LLM 単独へ委ねもしない（machine facts が立たない限り Class B の土俵に乗らない）

      **disagreement 時の fail-closed**: Class B の成立を**単一 AI の YES/NO で決めない**。
      2名が独立に `policy_maintained` と判定し、かつ機械 Gate / CI が PASS のときだけ Class B とする。
      重要な不一致（維持 vs 弱化 / 安全 vs authority 拡大 / `undecidable` 混在）があれば
      `Second Independent Review → Meta Review → 未解消なら CEO Escalation` へ**安全側へのみ**倒す。
      目的は「AI の判断を常に正しくする」ことではなく、**判断が揺れたときに必ず上へ上がる構造**を作ること。

      **existing mechanism reuse（新しい Review system を重複して作らない）**:

      | 必要なもの | 再利用する既存機構 | 必要な最小変更 |
      |---|---|---|
      | machine facts | `classifyReviewLoad()`（`apps/worker/src/approvalLevel/reviewLoadClassifier.ts`） | 出力へ **additive に facts を足す**。`ReviewLoad` の語彙は増やさない。**`diffText` を受け取れるようにすることが最小の本質**（現在は changedFiles のみ） |
      | 破壊的・不可逆の検出 | `MECHANICAL_GATE_PATTERNS`（diff 型パターンが既にある） | migration 本文向けの diff パターンを追加し、ファイル名依存をやめる |
      | 意味判定の実行 | Focused Review（`MetaReviewFocus` / `selectFocuses()`） | **focus を1つ足すだけ**。新しい Reviewer・新しいプロンプト基盤・新しい JSON パーサーを作らない |
      | 2名の独立性 | `isGeneratorSeparatedFromFinalReviewer()`（`packages/shared/src/reviewSeparation.ts`） | そのまま |
      | 不一致の fail-closed | `resolveFinalDecision()` / `applyIndependentReviewOverride()`（`packages/shared/src/strategicDecision.ts`） | **そのまま使える**。既に「全件 ALIGNED のときだけ ALIGNED」「未知値は UNCERTAIN」「independent は安全側にのみ倒す」 |
      | 強い Independent Review の発火 | `recomputeDecision()` の「reviewLoad が critical なら independentReviewRequired」 | そのまま |
      | 必要 Gate の決定 | `resolvePlActionPolicy()` / `authorizePlAction()`（`mandatory-gate-policy`） | Class を `requiredGates` 算出の**入力**として足す |
      | 記録 | 既存 `audit_log` / `data/logs/review_observation.jsonl` | そのまま |

      **統合先の第一候補は `mandatory-gate-policy` の Policy Engine である。** Class A/B/C を新しい
      並行分類軸として持たせるのではなく、**既存 classifier の出力と policy decision を拡張する**形にする。
      新しい Class enum を上位の語彙として増やさない。

      **関連項目（重複実装しないこと）**:
      - `mandatory-gate-policy`（in_progress）— 必要 Gate を決める入口。**本項目はその入力を精緻化する**もので、
        Gate を減らす仕組みではない。`plRiskOpinion` を `requiredGates` の算出に使わない不変条件は維持する
      - `independent-review-verdict-instability`（planned）— 同じ差分への判定が実行ごとに反転する実測。
        本項目の disagreement fail-closed と**同じ問題の別側面**であり、着手時は一緒に扱う。
        当該項目の「着手時に確認すること」（Safety/Authority 差分は LLM より先に機械ルールで拾う／
        新しい分類器を作る前に `reviewLoadClassifier`・`runMechanicalGate` の再利用を確認する）は
        **本項目の方針そのもの**である
      - `meta-review-structured-output-robustness`（planned）— parse 失敗による **false BLOCKED**。向きが逆
      - `project-auto-incident-pattern-improvement`（planned）— 過剰安全策・過剰レビューを Incident 候補として扱う。
        Class B の効果（CEO 呼び出し回数の変化と取りこぼしの有無）はここで測る

      **non-goals**:
      - 新しい Review system / 新しい Reviewer 種別 / 新しい Gate 本体 / 新しい承認経路 / 新しいテーブル
      - 既存 Risk Level（LOW/MEDIUM/HIGH/CRITICAL）・Review Level 0〜3・`ReviewLoad`・`ApprovalLevel` の**置き換え**
      - Tier A / Tier B（作業形態）の再定義
      - **CEO Gate の迂回路**にすること / PL が protected file を自由に変更する権限 /
        Safety Boundary を緩和する仕組み / **PL 自身が自分の risk を下げる仕組み**
      - Policy そのものを変える変更を Class B で通すこと（それは定義上 Class C）

      **operational validation 条件（机上のルール追加で完了にしない）**: 実変更例で次を**測定**して示す。
      1〜4 は上の実測表がそのまま before として使える。
      1. protected file だがログ・診断改善のみ → Class B 候補になる
      2. protected file で Guard 条件を弱める → Class C になる（**ファイル名を変えても保たれること**）
      3. rollback 可能な後方互換 DB migration → Class B 候補になる
      4. destructive / irreversible migration → Class C になる（**ファイル名に `drop` が無くても**）
      5. Reviewer 同士が重要点で不一致 → CEO 側へ安全に昇格する
      6. PL が LOW と自己申告しても、実 diff が Class C なら Class C になる
         （現状 `resolvePlActionPolicy()` は LOW 申告でも CRITICAL 申告でも `requiredGates` が
         同一であることを実測済み。この不変条件を Class 導入後も回帰テストで固定する）

      **効果検証可能性（Design Philosophy 8）**: Class 判定・machine facts・2名の semantic verdict・
      不一致の有無・最終 disposition を既存 `audit_log` / `review_observation.jsonl` へ記録し、後から
      「Class B により CEO 呼び出しがどれだけ減ったか」「Class C の取りこぼしが出ていないか」を
      判定できるようにする。**記録経路を持たない実装で完了にしない。**

      **state=deferred の理由（CEO 判断・2026-09-15）**: 本項目自体が「どの変更を CEO Approval 必須から
      AI 完結可能へ移すか」という Authority / Safety 境界の変更であり、**本項目の定義に照らして Class C** である。
      よって PL の自律採用対象から外す意図で `deferred` とする。

      **着手手順（この順序を飛ばさない）**:
      1. PL が Class A / B / C の境界表を**具体例つき**で CEO へ提示する（実装ではなく境界表だけ）
      2. CEO が境界表を承認する
      3. `state=planned` へ変更して実装着手する

      **`deferred` は現在は機械的に強制される（2026-09-17 確認。2026-09-15 時点の記述を訂正）**:
      登録時点では採用経路3箇所とも `done` だけを除外しており `deferred` は素通りしていたが、
      その後 `isRoadmapItemAdoptable()` による **`planned` のみの allowlist** へ統一され、
      3経路すべてが同じ述語を共有している。
      - `apps/api/src/pl/adoptionStep.ts` の `readAdoptionCandidates()` … `.filter(item => isRoadmapItemAdoptable(item.state))`
      - `apps/api/src/ctoAi/roadmapAdoption.ts` … `ITEM_NOT_ADOPTABLE`
      - `apps/api/src/pl/actionGate.ts` の `checkRoadmapItemAlignment()` … 同じ述語で拒否

      したがって本項目の `state=deferred` は**意図の記録であると同時に実効的な停止**でもある。
      着手には上記手順 3（`state=planned` への変更）が必要で、その前に CEO の境界表承認が要る。

<!-- roadmap:id=vps-pl-execution-loop state=done -->
1. [x] **VPS 上で PL 判断ループを動かす（PL 不在の単一障害点を除去）** — 2026-09-14登録。**最優先級**。
      **【2026-09-14 進捗: 最小ループを実装。残りは VPS 上の Operational E2E】**
      `runPlTick()`（`apps/api/src/pl/executionLoop.ts`）と `POST /api/pl/tick`（`routes/pl.ts`）を実装した。
      1 tick で `Observe → Diagnose → Decide → Mandatory Gate → Execute → Verify → Continue / Escalate`
      を1件だけ進める。**常駐 Agent・新しい state store・新しい Recovery subsystem・新しいテーブルは
      作っていない。**

      - **Observe** … `buildSystemState()`（`GET /api/state` の実体）をそのまま呼ぶ。PL 専用の状態収集経路は無い
      - **Diagnose** … 既存 provider CLI 経路（`aiExplain/cheapAiClient` = OpenCode CLI）。
        従量課金 API は追加していない。role / model の選択は `role-model-registry` の責務として
        差し替え口（`PlLoopDeps.diagnose`）1箇所に閉じた
      - **Decide** … PL の出力から取り出すのは `actionKind` の**文字列だけ**。補正も推測もしない。
        未知値は `resolvePlActionPolicy()` が forbidden にする
      - **Gate** … `authorizePlAction()` が唯一の許可経路。PL の `plRiskOpinion` は判定に効かない
      - **Execute** … v1 の executor は `rekick_design_review`（既存 `executeDesignReviewRun()`）と
        `escalate_to_ceo`（既存 `sendAlert()`）のみ。**attempt を使い切った run は盲目的に再kickしない**
      - **Verify** … 操作後に状態を読み直し、`normalized` / `unchanged` / `different_anomaly` /
        `needs_gate_or_ceo` に分類する。**実行側の戻り値だけで成功扱いにしない**
      - **有界性** … 同一対象への試行は `audit_log` から数えて2回で打ち切り、以降は再試行ではなく
        CEO Escalation（同一対象へ重複通知しない）

      **`rekick_design_review` の Gate を up-front 無しに確定した**（`mandatory-gate-policy` 側も更新）。
      workspace を変えない / `DESIGN_REVIEW_MAX_ATTEMPTS` で有界 / 判定は `recomputeDecision()` が
      API 側で再計算する、の3点を満たすためで、**この理屈を workspace を書き換える復旧へ広げない**
      ことを境界テストで固定した。

      **既定では起動しない**。`PL_LOOP_ENABLED=true` を置いたときだけ API プロセス内の interval が
      tick を呼ぶ（`PL_LOOP_INTERVAL_MS` 既定 60s）。deploy しただけでは production の挙動は変わらない。

      **CONTROL REPOSITORY 変更を含む（CEO 承認が必要）**: `apps/api/src/index.ts` への
      route 登録と interval 追加。`apps/worker/src/index.ts` は
      `ALWAYS_FORBIDDEN_PATTERNS` に該当するため触っていない（Worker poll cycle へは載せられない）。

      **【2026-09-14 Phase 1 Operational E2E: PASS（production 実測）】**
      master `d06436d` を production へ deploy し（API+Worker を停止 → ff-only → API 起動 → 健全性確認 →
      Worker 起動。DB backup 取得済み）、**`PL_LOOP_ENABLED` は false のまま** `POST /api/pl/tick` を
      **1回だけ**手動実行した。対象は実在の停止状態
      （Project `bb509fee` / Task `76ea5ff3` / `design_review_failed`「runner timed out after 120000ms」、
      約2.6時間停止）。

      | 検査項目 | 実測 |
      |---|---|
      | 対象 Task / Review の特定 | `design_review_failed:76ea5ff3…` を選択（同 Task の他 run へは触れず） |
      | PL の判断根拠 | 「複数回の timeout 失敗は systemic な問題を示し、retry では安全に解決できない」 |
      | 提案 action | `escalate_to_ceo`（**`rekick_design_review` を含む想定外操作は行わなかった**） |
      | Mandatory Gate | `audit_log` に `pl_action_authorize / authorized / kind=escalate_to_ceo gates=none policy=pl-action-policy-v1` |
      | workspace 変更 | **ゼロ**（`/workspace/target` HEAD `5079a2f`・dirty 0・branch 不変、前後一致） |
      | attempt 上限 | run `060b8c66` は `attempt_count=3 / failed` のまま。**再kickしていない** |
      | 結果確認 | `GET /api/state` を再取得。attention は不変（= 正常化していない）と正しく判定 |
      | 盲目的 retry | 無し。1 tick で Escalation へ倒れた |
      | 監査 | `pl_action_authorize`（Gate）と `pl_loop`（判断・結果）の2行が残った |
      | 所要 | 25.3 秒（大半は Diagnose の provider CLI 実行） |

      **Phase 1 で判明した欠陥（修正済み）**: escalation は attempt として数えないため、
      **Escalation 済みの対象を選択段階で外さないと、CEO の判断待ちの間 tick ごとに Diagnose
      （実測25秒の provider CLI）を走らせて最後に捨てる**。60秒 interval では枠を焼き続ける挙動であり、
      本項目の目的（不要な PL 起動を減らす）に反する。選択段階で除外し、回帰テストで固定した。

      **Phase 1 で判明した運用上のギャップ（コード欠陥ではない）**: 通知チャネル未設定のため、
      PL の CEO Escalation は `[Notifier] 通知チャネルが未設定です` としてジャーナルにしか出ない。
      **PC を閉じても継続する**という目的に対しては、Escalation が CEO へ届く経路の設定が前提になる。

      **【2026-09-14 Phase 2: interval 有効化・観測 PASS】** 修正を `df2d71a` として deploy し、
      `PL_LOOP_ENABLED=true` / `PL_LOOP_INTERVAL_MS=60000` を **systemd drop-in**
      （`~/.config/systemd/user/ai-team-api.service.d/pl-loop.conf`）で有効化した。
      **`/srv/ai-team/env/*.env` は読み書きしていない**（無効化は drop-in の削除のみ）。
      起動ログ `PL execution loop enabled (intervalMs=60000)` を確認し、約8分（≒8 tick）観測:
      非 idle tick 0 件 / 新規 `audit_log` 行 0 件 / Escalation 再送 0 件 / `PL tick failed` 0 件 /
      API・Worker とも active。**ローカル PC 無しで PL が回り続け、既に CEO へ上げた案件については
      provider も消費せず何もしない**ことを実測した。
      実測記録: `docs/project_memory/decisions/vps_pl_execution_loop_operational_verification.md`。

      **【2026-09-14 実復旧 Operational E2E: 完走（VPS 単独・無人）】**
      安全なケースの作り方: 障害を人工的に作らず、**既存の採用 API を同一スコープで呼び直した**
      （`POST /api/projects/:id/roadmap-adoptions` に DB 上の現行 `allowedPaths` /
      `acceptanceCriteria` をそのまま渡す）。これは停止中 Task を進めるための正規操作であり、
      結果として新しい Design Review run が作られ、既知の 120s timeout で **requeue → idle** になった
      （production evidence と同型。attempt 1/3、残 2）。以降は**手動 tick を使わず 60 秒 interval に任せた**。

      | 時刻 | 監査 | 実測 |
      |---|---|---|
      | 09:52:59.054 | `pl_action_authorize / authorized` | `kind=rekick_design_review gates=none policy=pl-action-policy-v1` |
      | 09:52:59.058 | — | run `944ce2e0` が `queued → running`、`attempt_count` 1→2、`started_at` 設定（**実際に再実行された**） |
      | 09:55:04.078 | `pl_loop / acted` | `kind=rekick_design_review exec_ok=true verify=unchanged`（runner がまた 120s timeout → requeue） |
      | 09:55:50.112 | `pl_action_authorize / authorized` | `kind=escalate_to_ceo` |
      | 09:55:50.125 | `pl_loop / escalated` | 「2回 timeout で失敗しており、systemic な問題で上位の介入が要る」 |

      **PL は attempt 上限（3）を待たず、2回目で自ら Escalation を選んだ**（run は `attempt_count=2`・
      残1で停止）。既に escalate 済みの `design_review_failed` キーへは**重複通知していない**。
      Job は1件も作られず（`jobs created today: 0`）、`/workspace/target` は HEAD `5079a2f`・dirty 0・
      branch 不変。検証用に作った使い捨て Project は archived 済みで、running Project は本番の1件のみ。

      **正常化はしていない。** 再実行そのものは成功したが、`design-review-runner-production-timeout`
      が未解決のため review 自体はまた timeout した。**PL ループの欠陥ではなく、当該 Finding が
      実復旧の成立を塞いでいる**（＝ VPS PL 完成後の優先 Root Cause 調査候補という位置づけを裏づける）。

      **【進行ルール（CEO 指示・2026-09-15）】** 残る evidence（実復旧 → 正常化）の**自然発生待ちを
      理由に、AIteamOS 全体の Roadmap 開発を停止しない。** 安全に独立して進められる他項目は、
      正式 Roadmap の dependency / Safety / Leverage に従って通常どおり継続する。
      **done 判定のためだけに production へ危険な障害を人工注入しない。**
      自然発生した復旧可能事象で
      `Observe → Diagnose → Decide → Mandatory Gate → Existing Recovery Action → Verify → normalized`
      が VPS PL 単独で成立したら、その audit evidence を記録して done 判定する。

      **【done 判定（CEO 確定・2026-09-15）: 下記2条件をいずれも充足したため done】**

      **1. 実復旧の Operational E2E（2026-09-15 充足）。**

      **自然発生した事象で、VPS PL が無人で復旧に成功した**（人工注入なし。次項目の採用作業中に
      design review の attempt 1 が失敗 → requeue → `design_review_idle` になったものを PL が拾った）。

      | 時刻 (UTC) | 監査 |
      |---|---|
      | 17:24:02.419 | `pl_action_authorize / authorized` — `kind=rekick_design_review gates=none policy=pl-action-policy-v1` |
      | 17:26:34.093 | `pl_loop / acted` — `kind=rekick_design_review exec_ok=true verify=different_anomaly design review rekick: evidence_registered` |

      対象は `design_review_idle:bd80c4ce…`。**再kickされた review は ALIGNED で evidence が登録され**、
      停止していた Task はその後 implement Job の実行まで進んだ。
      つまり `Observe → Diagnose → Decide → Mandatory Gate → Existing Recovery Action → Verify` は
      VPS 単独で完走し、**復旧対象そのものは解消した**。

      記録された verdict は `different_anomaly` である（`design_review_idle` は消えたが、
      同じ Task に後続状態 `task_ready_without_job` が現れたため）。
      **CEO 判断（2026-09-15）: これは Recovery 失敗ではない。**「対象異常が解消し期待した前進が起きた／
      その後に別の異常が出た」ケースを失敗として扱わないよう、完了条件と実装を実態へ合わせた。

      実装側も同じ読み方へ揃えた（**新しい状態モデルは作っていない**。verdict の語彙は4つのまま）:
      `isRecoveryTargetResolved()`（`apps/api/src/pl/executionLoop.ts`）を単一の判定点にし、
      `normalized` / `different_anomaly` を「対象が解消した」、
      `unchanged` / `needs_gate_or_ceo` を「解消していない（Escalation 対象）」とする。
      これが無いと**復旧に成功するたびに CEO へ Escalation が飛ぶ**（後続工程が現れるのは pipeline の正常形）。
      `needs_gate_or_ceo` を成功扱いにしないのは、後続が approval 待ち / quarantine で
      **PL に executor が無く人の判断が要る**ためである。

      **`design-review-runner-production-timeout` の解決を本項目の必須依存にはしない**（別 Finding）。
      なお当該 Root Cause は 2026-09-14 に特定・修正・deploy 済みで、今回の再kickが成功したのはその効果である。

      **2. CEO Escalation が実際に CEO へ届くこと（2026-09-15 充足）。**
      **新しい通知基盤は作っていない。既存 notifier（`sendAlert()` → `lineAdapter`）の設定だけで足りた。**
      CEO が LINE Messaging API の credential を `/srv/ai-team/env/api.env` へ設定し
      （**AI は env ファイルを読み書きしていない**。AI が行ったのは設定手順の提示と、
      値を出さない形での検証のみ）、API を再起動して反映した。

      検証（値を一切表示していない）:
      - `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` ともに **configured**。
        User ID については**形式が妥当であることのみ確認**した（表示名や `@` 付き LINE ID の
        取り違えを検出するため）。**値・長さ・形式そのものは記録しない**（CEO 指示・2026-09-15:
        secret の確認は configured / not configured を基本とし、機能上必要でない限り
        長さ・形式も出力しない）
      - env の更新 01:29:21 に対し API の起動 01:31:13。**編集後に再起動されている**
        （systemd は EnvironmentFile を起動時にしか読まないため、この前後関係が有効化の証拠）
      - 既存 `sendAlert()` の1回実行で `[{"channel":"line","success":true,"attempts":3}]`。
        **CEO が受信を確認済み**
      - 安定性の確認として `sendLine()` を直接2回: いずれも1回目で成功（482ms / 354ms）。
        初回の `attempts:3` は一過性であり、systematic な不安定さではない
      - ファイル権限は `mode=600 owner=ai-team` のまま維持

      **既知の限界（意図的に未設定）**: `worker.env` には未設定のため、**Worker 側の CRITICAL 通知**
      （Outbox 滞留等）は引き続きコンソールのみである。PL の CEO Escalation は API プロセスなので
      本条件は充足するが、Worker 由来の通知も届けたい場合は同じ2行を `worker.env` へ追加する。
      また `MAX_SEND_ATTEMPTS = 3` なので、LINE 側が連続で失敗すると通知は失われる
      （現状は単発成功しているため追加対処はしない）。

      **将来の正式第一チャネルは Mobile Push（`mobile-push-ceo-escalation`）**であり、
      LINE はそこへ至るまでの bootstrap 通知として位置づける（CEO 方針・2026-09-14）。

      **問題**: PL 判断能力が無いのではなく、**PL が VPS 上で継続実行される経路へ接続されていない**。
      現在 PL 判断（状態把握・停滞検知・原因分析・調査・証拠収集・方針判断・次Task選択・委任・
      Review 評価・復旧方法選択・CEO Escalation）はすべてローカルの Claude / Codex セッションが担う。
      **ローカル PC を落とすとこれらが全部止まる。**

      **production evidence（2026-09-14 実測）**: Design Review が timeout → requeue → attempt 2 で
      `queued` のまま**実行プロセス無し**で停止。外部 PL（ローカルセッション）が気づくまで
      誰も再開しなかった。`recoverAndRekickAtStartup()` は API 起動時にしか走らないため、
      **timeout→requeue した run を再kickする常時経路が無い**。Worker の poll は
      `task-continuations/reconcile` と `supervised-runs/reconcile` は叩くが design review は叩かない。

      **制御ループ**: Observe → Diagnose → Investigate → Decide → Select Action →
      **既存 Gate / Review**（`mandatory-gate-policy`）→ Execute → Verify → Continue / Escalate。

      **常駐 Agent の新規作成を目的にしない。** event-driven / scheduled check / 既存 Worker・API の
      実行経路 / 既存 provider CLI を比較し、**最も単純で自然な構造**を選ぶ。
      Worker の poll cycle に載せるのが最小である可能性が高い（既に reconcile を2種類叩いている）。

      **新しい Recovery subsystem を作らない。** 既存の Resume / Retry / re-kick / reconciliation /
      quarantine recovery / provider fallback / API・Worker restart / rollback / Review 再実行を
      **PL が適切に選択して呼べる**ようにする。既存で合理的に復旧できない場合のみ新機構を検討する。

      **推論経路**: 従量課金 API を新標準にしない。既存 provider CLI（`AiCliProvider`）を使う
      （横断制約・2026-09-14）。重要な PL 判断・設計・Root Cause 分析・Independent Review では
      性能を優先してよい（`role-model-registry`）。

      **CEO Escalation の要件**: 「エラーです」では不十分。何が起きているか / 原因として何が分かって
      いるか / 何を調べたか / 選択肢 / PL の推奨案 / それぞれのリスク を**非エンジニア向けに**説明する。
      代表例: Design Philosophy 変更 / Safety boundary 変更 / 新規権限 / 重大な不可逆操作 /
      既存 Gate の削除・弱体化 / Business Goal 変更 / 経営判断が要る複数選択肢 /
      原因不明で安全な復旧方法を確定できない / 同じ Recovery を規定回数試しても改善しない。

      **依存**: `cross-project-state-api`（状態取得。PL の Observe の入口）→ 本項目 →
      `operator-chat-mobile`（Mobile から PL へ問い合わせ・指示）。
      **Console UI は後**。まず正確な状態取得と判断ループを優先する。

      **後続（本項目の完了後に着手する最適化）**: `monitoring-tiering-watchdog-monitor-pl`
      （監視責務の Watchdog / Lightweight Monitor / VPS PL への段階分離）。
      **本項目より先に着手しない。** 本項目の実運用データ（PL 起動頻度・rule だけで閉じる異常の割合）を
      見てから具体化する。効果検証に必要な記録の要件は当該項目に記載した。

<!-- roadmap:id=lowrisk-candidate-commit-auto-approval-evaluation state=planned -->
2. [ ] **十分に制約された LOW-risk Candidate commit を自動承認してよいかを評価する（評価のみ。今は緩和しない）** —
      2026-09-15登録（CEO 指示）。**本項目は評価であり、実装でも Policy 変更でもない。**
      **既存 Safety Policy は今この時点では一切変更しない。**

      **確認された事実（production 実測・2026-09-15）**: VPS が Candidate 内で自律実装を完了し、
      変更は `allowedPaths` 内の2ファイルのみ・risk_level は `LOW` だったが、
      `triggered_rules` は `git_commit requires CEO approval (policy)` で承認待ちになった。
      **すべての `git_commit` が risk level に関係なく CEO 承認必須**であり
      （`apps/api/src/routes/approvalGate.ts`）、これが**連続自律開発の human bottleneck** である。
      1 Task ごとに CEO を待つため、Roadmap を連続で消化できない。

      **重複確認済み**: 既存 `approval-resume-liveness-dependency`（done）が
      「low-risk auto approval の設定・env flag は存在せず、`safetyAuditor.ts` は `autoApprove` という
      キーワード自体を CRITICAL 検出する。auto-approval は当該 Finding の解決策ではなく、
      採用するならセキュリティモデル変更として CEO 承認が要る」と記録している。
      **本項目はその「採用するなら」の評価を担う後続**であり、当該項目を再オープンしない。
      他に auto-approval を扱う項目は無い（`autoApprove` / 自動承認で ledger を検索して確認）。

      **評価する前提候補（CEO 提示。すべて満たす場合に限る、を出発点とする）**:
      - **Candidate 環境のみ**（`/workspace/target` の Candidate clone 内。Stable には一切触れない）
      - 変更が **`allowedPaths` 内**に収まっている
      - **protected / safety files の変更が無い**（`ALWAYS_FORBIDDEN_PATTERNS` 相当）
      - **tests / required validation が PASS**
      - **Independent Review が PASS**
      - **Mandatory Gate が PASS**
      - **Stable Promotion / production deploy とは別権限**（自動承認は commit までで、
        promotion・deploy には一切及ばない）

      **引き続き CEO Approval 対象として残すもの（緩和しない）**: Safety boundary /
      production 操作 / 権限変更 / DB migration / protected files / Goal・Design Philosophy 変更。

      **着手時に確認すること（実装方針を先に決めない）**:
      - `safetyAuditor.ts` が `autoApprove` を CRITICAL 検出する設計をどう扱うか。
        **検出を弱めるのではなく**、自動承認が「Gate を迂回する経路」ではないことを
        構造で示せるか（例: 承認レコード自体は作られ、誰が承認したかが監査に残る）
      - 上記7条件を**機械的に検証できるか**。1つでも自己申告に依存するなら採用しない
      - 効果検証可能性（Design Philosophy 8）: 自動承認した commit と CEO 承認した commit を
        後から区別・比較できる記録経路を同時に設計する
      - 撤回可能性: 自動承認を止めたいとき、**設定1つで即座に全件 CEO 承認へ戻せる**こと

<!-- roadmap:id=approval-qa-leaks-internal-representation state=done -->
3. [x] **承認画面の「AIに質問する」が内部表現（tool call・検索用プロンプト）をCEOへ表示した** —
      2026-09-15登録・同日修正（CEO 実機報告）。

      **事象**: CEO がスマホの承認画面から「CONTROL REPOSITORY と allowedPaths の矛盾について、
      今回の変更を承認してよいか」と質問したところ、回答欄に**リポジトリ検索用の内部プロンプトと
      `<tool_call><function><parameter>…` 相当の文字列がそのまま表示**された。
      非エンジニアが判断できる回答になっておらず、Explainer の実運用上の欠陥である。

      **Root cause**: `answerApprovalQuestion()`（`apps/api/src/approvalExplain/approvalAi.ts`）が
      **モデルの生テキストを無検証でそのまま返していた**。説明生成側
      （`generateApprovalExplanation()`）は Zod schema で形を固定していたのに、
      **質問応答側だけ素通し**だった。`POST /api/approval-requests/:id/ask` はそれを
      `answer` としてそのまま返す。モデルは「リポジトリを調べる」ためにツール呼び出しを
      出力したが、この経路にツールは無いので、呼び出しの意図がそのまま文字列として表示された。

      **修正**: 回答を CEO 判断用の項目へ固定した（`ApprovalAnswerSchema`）—
      何が問題か / Safety Policy 上の扱い / 今回変更してよいか /
      推奨（approve・reject・hold）/ 足りない情報。
      加えて `containsInternalRepresentation()` で `<tool_call>` 等を検出し、
      **見つかったら整形せず fail-closed**（既存の「AIから回答を取得できませんでした」を出す）。
      同じ漏洩は説明生成側にも起こりうるため、そちらの prose にも同じ検査を掛けた。
      system prompt にも「ツールもリポジトリ検索も無い。検索指示・ツール呼び出しを出力しない。
      事実が足りなければ hold にして不足を書く」を明記した。

      **回帰テスト**: 実際に表示された `<tool_call>` 文字列を入力にして、route まで含めて
      `ok:false` になり **レスポンス全体に `tool_call` も検索語も含まれない**ことを固定した。

<!-- roadmap:id=approval-qa-cannot-answer-repository-questions state=planned -->
4. [ ] **承認画面のQ&Aは Repository を調べられない。調査が要る質問の正式な行き先が無い** —
      2026-09-15登録（CEO 指示）。`approval-qa-leaks-internal-representation` の**構造的な残り**。

      **事象**: Explainer は「この画面を閉じるまでのやり取りだけ」で答える設計で、入力は
      Approval payload（task / approvalRequest / review / QA / exactDiff）のみ。
      CEO の実際の質問は「`CONTROL REPOSITORY` 注記と `allowedPaths` の矛盾」で、
      **答えるには repository の中身（`ALWAYS_FORBIDDEN_PATTERNS` やヘッダ注記の分布）が要る**。
      直前の修正で「hold にして不足情報を示し、PL へ回す」ところまでは倒せるようになったが、
      **CEO がスマホから PL へ正式に問い合わせる経路が無い**（現状は CLI セッション頼み）。

      **CEO 指示（重複防止）**: **新しいチャット基盤を重複して作らない。**
      既存 Explainer・PL 実行経路の改善で解決できないかを優先する。
      将来の Operator Chat / Control Interface を作る場合も、既存 PL 経路へ正式に問い合わせる形にする。

      **着手時に確認すること（実装方針を先に決めない）**:
      - 既存の `POST /api/tasks/:id/failure-questions` が同型の問い合わせ口として使えるか。
        使えるなら**承認向けに一般化**できるか（新設ではなく拡張で足りるか）
      - PL 経路へ回す場合、**Mandatory Gate を通る**こと。Q&A が調査のために勝手に
        操作を実行できてはならない（read-only 系の既存操作に限る）
      - 「この画面内だけ」という現在の契約を変えるなら、履歴を保存しない前提が崩れないか
      - 効果検証可能性（Design Philosophy 8）: hold で終わった質問がどれだけあり、
        そのうち何件が PL へ届いたかを後から数えられること

<!-- roadmap:id=reconcile-evidence-not-fully-machine-verified state=planned -->
5. [ ] **external completion reconcile の根拠2つが、まだ機械照合になっていない** —
      2026-09-15登録（CEO 指示の後続確認事項）。**初回 reconcile のブロッカーではない**
      （CEO 判断で実行済み）。経路そのものは master `828878a` で稼働している。

      **本項目は `aiteamos-self-development-tier-b`（Maintenance Lane v0）の構成要素である。**
      v0 要件のうち「canonical master 包含の確認」「Stable 包含の確認」
      「Review 結果を caller 自己申告ではなく正式 record として保存」
      「reviewer / provider / model / timestamp / reviewed SHA の保存」は**ここで消化する**。
      Maintenance Lane 側で再定義しないこと（重複を作らない）。

      **(1) canonical master への包含と、running Stable への包含を分けていない。**
      `verifyExternalCompletion()` が行うのは
      `git merge-base --is-ancestor <sha> HEAD`（**Stable の HEAD に対する**祖先判定）だけである。
      Stable が `origin/master` からしか fast-forward されない運用のもとでは master 包含も
      含意するが、**それは運用上の不変条件であって独立した証明ではない**。
      今回は PR #216 の merge 済み事実を別途確認しているため問題にしていない。

      **(2) Independent Review の `approved` は caller の自己申告である。**
      現状の検査は
      `evidence.independentReviewVerdict.trim().toLowerCase() !== 'approved'` で弾くだけで、
      **「approved」と書いた caller はそのまま通る**。保存済みの正式 Review record とは
      照合していない。**ここは追加実装が要る**（CEO 確認事項2への回答: 「既にそうなっている」
      ではない）。

      そもそも今回の Independent Review は**外部セッションが Codex CLI で実行**したもので、
      その結果は DB に保存されていない。`design_review_evidence` は Design Review のレコードであり
      別物である。**「どこに保存するか」から決める必要がある。**

      **着手時に確認すること（実装方針を先に決めない）**:
      - (1) について: `origin/master` の ref と Stable HEAD を**別々に**照合できるか。
        API が fetch を打つのは避けたいので、**deploy 手順側が記録した master SHA** を
        既存のどこか（`audit_log` の deploy 記録など）から読めないか
      - (2) について: 外部 Tier B の Independent Review 結果を**保存する既存の置き場**があるか。
        無い場合でも、**新しい review subsystem は作らない** — 既存 `design_review_evidence` の
        reviewKind を増やす等、既存構造の小さな拡張で足りないかを先に見る
      - **どちらも fail-closed の方向にしか変えない。** 現在通っているものを通らなくする変更は
        既存 reconcile 済み Task を壊さないこと（冪等性は `ALREADY_DONE` で担保済み）
      - 効果検証可能性（Design Philosophy 8）: reconcile が何回使われ、そのうち何件が
        機械照合で弾かれたかを後から数えられること

<!-- roadmap:id=guard-block-message-omits-allowed-paths state=done -->
6. [x] **File Change Guard の block メッセージに `allowedPaths` が出ず、原因を誤読する**
      — **完了（2026-09-15, PR #216。Tier B / protected file 変更）**。

      **実装は Candidate ではなく外部セッションが行った。** 対象が `jobRunner.ts`
      （`ALWAYS_FORBIDDEN_PATTERNS` の protected file）であり、CEO が**この Task に限って**
      承認した。Candidate AI の権限拡大・`ALWAYS_FORBIDDEN_PATTERNS` の緩和・protected 指定の解除・
      Safety Guard の迂回・`allowedPaths` の拡張は**一切行っていない**。
      **`fileChangeGuard.ts` は変更していない**（判定基準は不変。変えたのは表示だけ）。

      `formatGuardBlockNote()` が per-file の理由と `allowedPaths` を1行にまとめ、既存
      `withLeadingNote()` で **stderr の先頭**へ置く（末尾だと `saveJobLogs()` の
      プレビュー切り詰め 4000字で診断ごと消えるため）。

      Independent Review（Codex `gpt-5.6-sol`）は **3ラウンド**。`changes_requested` 2回は
      いずれも実欠陥だった: 末尾追記による切り詰め消失 / path と reason を連結してから切ると
      長いファイル名が理由を食い潰す / 300字上限で `allowedPaths` が押し出される /
      **こちらが書いたテストの1件が vacuous だった**（変数を渡しておらず何も検証していなかった）/
      制御文字注入で偽の診断行が作れる / 「only these are permitted」は言い過ぎ。
      最終 `approved`、残 Low 3件は記録済み。

      Task 側の扱いは `no-status-for-closing-a-task-without-implementing` を参照
      （外部 Tier B 完了を Task へ reconcile する既存経路が無い）。

      ---
      以下は登録時の記録。

      2026-09-15登録。`task-allowed-paths-not-normalized`（close 済み）の**対応方針3だけが残ったもの**。

      **事象**: Job の stderr は `File Change Guard blocked (stage A): test.js` で終わる
      （`apps/worker/src/jobRunner.ts`）。これは「`test.js` が禁止されている」と読めるが、
      実際の原因は **`allowedPaths` がどの changedFile とも一致し得ない**ことである。
      2026-09-11 の実測では CEO / AI の双方がこれを誤読し、調査時間を要した。

      **根拠はすでに計算されている。** `fileChangeGuard` は per-file の `reasons` を返しており、
      `jobRunner` はそれを `console.error` へ出している（journal には出る）。
      **Job の stderr（= CEO が Mobile で見る場所）に入っていないだけ**である。

      **着手時に確認すること（実装方針を先に決めない）**:
      - **`jobRunner.ts` は `ALWAYS_FORBIDDEN_PATTERNS` に入っている protected file であり、
        Candidate の AI は変更できない。** 誰が実装するかを先に決める必要がある
        （関連: `control-repository-header-vs-enforced-guard`）
      - 既存の `reasons` を stderr へ載せるだけで足りるか。**新しいエラー型や新しい通知は作らない**
      - stderr に載せる情報量。`allowedPaths` 全件か、不一致の理由1行か
      - 効果検証可能性（Design Philosophy 8）: 誤読による調査時間が減ったことを、
        Guard block 後の再質問回数などで後から見られるか

<!-- roadmap:id=no-status-for-closing-a-task-without-implementing state=planned -->
7. [ ] **採用した Task を「実装せずに閉じる」正式な状態が無い** — 2026-09-15登録（実運用で詰まった）。

      **事象**: PL が自律採用した Task `21d69075` は、調査の結果**実装すべきでない**と判明した
      （対象の Roadmap 項目が既に PR #144 で解決済みだった）。しかし `TaskStatus` は
      `pending / in_progress / review / done / blocked` の5つしかなく、
      **「着手せず取り下げる」を表す値が無い**。

      `done` にすると「受入条件を満たした」と読めてしまい、`pending` のまま残すと
      `currentTask` を占有して **autonomous adoption が永久に止まる**
      （`maybeAdoptNext()` は `currentTask === undefined` を要求する）。
      今回は description に理由を書いたうえで `done` にしたが、**記録としては正確でない**。

      **CEO 指示（2026-09-15）**: 今回 `done` を使ったのは **currentTask を解放するための暫定措置**
      であり、「受入条件を満たして完了した Task」と意味が混ざる。**恒久運用にはしない。**
      着手時は**新しい TaskStatus を追加する前に**、次だけで正確に表現できないかを優先して確認する:
      - `roadmapActive=false`
      - 既存の terminal state
      - 既存 Task / Job lifecycle の**小さな拡張**

      **同じ責務の新しい status や workflow を安易に追加しないこと。**

      **同じ責務としてここへ統合した別ケース（2026-09-15, Tier B 実測）**:
      **外部 Tier B が完了した Task を、既存経路では Task へ reconcile できない。**
      Task `7bd4a65a`（`guard-block-message-omits-allowed-paths`）は protected file を要したため
      CEO 承認のもと外部セッションが実装し、master `40bfed1` として production へ入った。
      しかし調べた範囲では、**Task を正しく終端させる既存経路が無い**:
      - Task が自動で `done` になるのは `applyCommitResult`（Candidate 自身の git_commit 成功）だけ。
        **外部 merge からは走らない**
      - 受入条件の機械検証は存在しない（既存項目
        `implement-acceptance-criteria-not-mechanically-verified` に登録済み）
      - Candidate を master と同期しても、resume した実装 Job は「既に実装済み」で
        `no file changes` になり失敗する。検証経路として使えない
      - 残るのは `PATCH /api/tasks/:id` に `status: 'done'` を直接書くことだけで、
        これは**未検証のまま done にする**ことであり CEO が明示的に禁じた

      **したがって「未検証 done」も「DB 直書き」もせず、Task は `pending` のまま残している。**
      新しい仕組みを作る前に、この不足を CEO へ報告済み（CEO 指示どおり）。

      **着手時に確認すること（上記と共通の方針で）**:
      - 外部完了の reconcile も、新しい workflow ではなく**既存の continuation / Job lifecycle の
        小さな拡張**で表現できないか
      - 「誰が外部完了を宣言してよいか」は権限問題。PL の自己申告で done にできてはならない

      **着手時に確認すること（実装方針を先に決めない）**:
      - **新しい status を増やす前に**、既存の `roadmapActive=false` だけで十分か
        （Task は残るが候補から外れる）。state 空間を広げない方が望ましい
      - 自律運用では**誰が取り下げを決めるか**。PL の統合判断で足りるのか、CEO 承認が要るのか
      - 取り下げた Task が後から再開されうるか。されるなら履歴をどう残すか
      - 効果検証可能性（Design Philosophy 8）: 取り下げ件数とその理由を後から数えられること

<!-- roadmap:id=task-design-review-conflict-has-no-recovery-route state=deferred -->
8. [ ] **adopt 済み Task が task-kind Design Review で CONFLICT し Job が 0 件のとき、訂正して再レビューする正式な経路が無い** —
      2026-09-18登録（production 実測）。**本項目は Finding であり、まだ実装しない。**

      **事象**: PL が `project-completion-badge-wording-correction` を自律採用した直後、
      task-kind Design Review が `finalDecision: CONFLICT`（`scope_simplicity: CONFLICT`。
      「提案の scope 要約が3つの対象訂正のうち2つを誤記しており、範囲が曖昧で対象外のロジックまで
      変更しかねない」）を返した。evidence が登録されないため Job は作られず、Task は
      `pending` / `roadmapActive=1` / Job 0 件のまま **16.5 時間放置された**。

      **3経路すべてが塞がっていた（実測）**:
      - **PL**: `task_ready_without_job` は `NOTIFY_ONLY_ATTENTION_KINDS`。
        「Job 生成は Design Review evidence が要り、その判定を PL が覆すことは許されない」という
        **正しい設計**であり、PL は通知して停止する
      - **人間**: `resumeBlockedTask()` は blocked Job を要求する。この Task は Job が1件も無いため
        `No jobs exist for this task` で使えない。Mobile の resume 導線も同じ経路を使う
      - **AI 自動**: `design-review-conflict-recovery`（done）は **roadmap-kind** の
        Whole-Roadmap Review を project 初期化時に再生成する経路であり、task-kind は対象外

      さらに attention が1件でも立つと `maybeAdoptNext()` は採用を見送るため、
      **この Task 1件で PL 全体の自律採用が止まる**。

      **今回の復旧は手順化されていない経路で行った**: CEO 承認のもと、既存
      `POST /api/projects/:id/roadmap-adoptions` を訂正済み `implementationScope` /
      `allowedPaths` で叩き直した（Task は Job を持たないため `syncRoadmapTasks` が可変として
      更新し、fresh Design Review が走って ALIGNED になった）。**再現手順として文書化されていない。**

      **2件目（2026-09-18、同日中に別 item で再発）**: PL が
      `pl-escalation-recorded-without-delivery` を自律採用（Task `c3849205`）。
      task-kind Design Review が `finalDecision: CONFLICT` を返し、evidence 0 件・Job 0 件のまま
      `task_ready_without_job` が立ち、**採用が全面停止**した。本 Finding を登録した当日である。
      **単発の事故ではなく再発する構造**であることの実証。

      この2件目は内訳も示唆的で、`scope_simplicity = ALIGNED` / `integration = CONFLICT` と
      **reviewer 同士が要件を逆に読んでいた**。item 本文は「未配達でも escalated と記録するのが不具合」と
      書き、PL は「配達成功を確認してから記録する」と提案したが、integration review は
      「未配達でも escalated と記録するのが要件」と読んだ。原因は PL の出力ではなく
      **Source of Truth（ledger 本文）が PR #249 後の実仕様に追いついていなかったこと**である
      （item 側は同日 docs-only で訂正した）。

      → **CONFLICT の原因が ledger 本文の陳腐化であることがある。** 復旧経路を設計するときは、
      「PL の提案を直す」だけでなく「Source of Truth を訂正して再レビューする」形も要る。


      **【2026-09-18 追記: 3経路すべてに実装が入った】**
      本 Finding が挙げた3経路のうち **PL 経路**は
      `independent-remediation-design-review-conflict`（PR #255）で埋まった。
      `task_ready_without_job` は CONFLICT のときに限り notify-only を外れ、
      `Independent Critic → PL revision → 既存 formal review`、
      Critic が Finding 自体を根拠付きで dispute した場合のみ frozen spec への
      once-per-(spec,finding) な再評価、それでも解決しなければ Independent Remediation、
      という段階経路を通る。

      残っていた **人手経路と手順書**は `human-recovery-zero-job-blocked-task` で埋めた:
      - **人手経路**: `POST /api/tasks/:id/recover`（Human Recovery）。Job 0 件の blocked Task を
        `blocked` → `pending` へ戻すだけで、**Job も Review も Approval も作らない**。
        up-front の CEO Approval Gate は課さない（CEO 決定・2026-09-18）が、fresh Design Review と
        既存下流 Gate はすべて維持される。AI/PL は「語彙が無い」「配線が無い」
        「worker allowlist に無い」の3重で到達できない
      - **手順書**: `docs/project_memory/rules/human_recovery.md`。症状別の使い分け、
        CONFLICT の原因が提案側か ledger 側かの切り分け、訂正済み `implementationScope` /
        `allowedPaths` で採用 API を叩き直す手順、`audit_log` からの効果検証まで記載した

      **同時に、本 Finding が書けていなかった穴を1つ塞いだ。** `failContinuation()` 経由の
      CONFLICT は Task を `blocked` にするため `findRemediationSubject()`（`pending` を要求）から
      外れ、**PR #255 の新経路にも届かない**。しかも attention は全9箇所が「Job があること」か
      「`status='pending'` であること」を条件にしているため **1件も立たず**、
      `occupiesProject()` が blocked を roadmapActive に関係なく占有と数えることと合わさって、
      **誰にも見えないまま Project の枠を保持し続ける**。2026-09-18 に `:memory:` storage へ
      同じ状態を作って実測した（`attention = []` /
      `resumeBlockedTask() = "No jobs exist for this task"`）。
      notify-only の `task_blocked_without_job` attention を足して可視化した。

      **`state` は merge と Production E2E 確認まで `deferred` のまま維持する。** 実装は入ったが、
      自然な CONFLICT が出たときの観測はまだ取れていない（PR #255 と同じ扱い）。

      **2件目の内訳は新経路の想定ケースそのものである。** `scope_simplicity = ALIGNED` /
      `integration = CONFLICT` で reviewer 同士が要件を逆に読み、原因は PL の出力ではなく
      **ledger 本文が実仕様に追いついていなかったこと**だった。これは Critic が
      `grounds=contradicts_code_or_spec` で dispute し、frozen spec の再評価へ分岐する型の
      ケースである。**自然な CONFLICT が出たときの観測対象**として扱う。
      **既存項目との違い（重複実装しないこと）**:
      - `adoption-does-not-check-implementation-feasibility`: allowedPaths と実装対象の不一致。
        **検出の話**であり、本項目は**その後の復旧の話**
      - `adopted-item-blocked-by-stale-deferral-text`（done）: 原因が古い ledger 本文だった事例。
        同項目自身が「原因が別のものは分ける」と明記している
      - `design-review-conflict-recovery`（done）: roadmap-kind 専用

      **着手時の前提（CEO 指示・2026-09-18）**: 解決策として **元 PL 自身に remediation を戻さない**。
      別セッションで進行中の **Independent Remediation 設計との統合**を前提とすること。
      CONFLICT を出した当人に訂正させると、Review 判定を迂回する圧力がそのまま残る。

      **やらないこと（non-goals）**: 新しい AttentionKind / TaskStatus / Roadmap state の追加 /
      `task_ready_without_job` を PL が実行可能な attention に変えること /
      Design Review evidence 無しで Job を作れるようにすること /
      本 Finding を根拠に Safety・Approval 境界を動かすこと。

      **【2026-09-18: Triage 側を実装し、復旧経路は #255 が入れた】**
      `blocked-resolution-triage`（done）が、この CONFLICT を機械的事実から
      `rootCauseClass=design_review_conflict` / `lane=independent_remediation` として分類する。
      **実際の復旧は #255（`independent-remediation-for-design-review-conflict`）が配線した。**
      PL ループでは復旧経路（`remediateConflict()`）が Triage より**先**に走り、
      Triage が受け持つのはその対象外（`roadmapTaskKey` 無し・予算枯渇など）だけで、
      その場合は構造化報告を添えて CEO へ渡す。


<!-- roadmap:id=blocked-resolution-triage state=done -->
8. [x] **Blocked Resolution Triage: Blocked の原因を構造化して分類し、既存の解決レーンへ渡す** —
      2026-09-18 完了（CEO 指示・同日着手）。**新しい Incident Management system は作っていない。**
      既存 VPS PL loop（Observe → Diagnose → Decide → Mandatory Gate → Execute → Verify / Escalate）の
      **Diagnose の手前に純粋関数を1つ足しただけ**である（`apps/api/src/pl/blockedTriage.ts`）。

      **責務**: Blocked を直接解除することではなく、
      「なぜ止まったか」を機械的事実から分類し、**既存の正しいレーンへ渡す**ところまで。

      | lane | 条件（すべて機械的事実） | 今日の到達先 |
      |---|---|---|
      | `auto_recovery` | 既存の bounded recovery が実在する（provider timeout + workspace 未変更 / 未使用 attempt が残る Design Review / resume 可能な blocked Job）| 既存 Diagnose → Gate → 既存操作 |
      | `independent_remediation` | task-kind Design Review が ALIGNED 以外 / allowedPaths と実装対象の不一致 | **CONFLICT は #255 が配線済み**（Triage より先に実行）。それ以外は CEO Escalation |
      | `maintenance_lane` | protected だが runtime / infrastructure（allowlist 4件）| 未実装のため Tier B handoff を添えた CEO Escalation |
      | `ceo_escalation` | Safety / Authority 中核・secret・quarantine・承認待ち・attempt 枯渇・原因不明 | CEO Escalation |

      **Safety 上の中心的性質**:
      - **Triage は permission を作らない。** `triageAllowedActions()` は必ず既存候補との積を返すので、
        ここから action が増えることが構造的に起こらない。可否は従来どおり `authorizePlAction()` だけが決める
      - **PL の自己申告は分類の入力に存在しない。** `triageBlocked(storage, item)` は
        attention と実レコードしか受け取らない（`riskLevel` / rationale を渡す口が無い）
      - **protected path は allowlist 方式**。`ALWAYS_FORBIDDEN_PATTERNS` が増えても、
        Maintenance allowlist に足さない限り新しい protected path は既定で CEO へ倒れる
      - **未実装の2レーンはどちらも CEO Escalation で終端する**ので、レーン分類を誤っても
        CEO を迂回することが起きない
      - **証拠不足（`confidence: 'low'`）では状態を変えない。** 候補が read-only の応答だけに絞られ、
        「よく分からないけど retry」が成立しない
      - 無限ループ防止は**既存 `PL_MAX_ATTEMPTS_PER_TARGET` をそのまま使う**（新しい閾値を作らない）

      **CEO 通知は既存 `sendAlert` のまま**で、本文だけを構造化した（何が止まったか / 原因 / 証拠 /
      AI が試したこと / なぜ自己解決できないか / 必要な CEO 判断 / **複数の**安全な選択肢）。
      選択肢を1つに決め打ちしない。重複通知の抑止は既存 `hasEscalated()` のままである。

      **効果検証可能性（Design Philosophy 8）**: 既存 `audit_log.detail` の先頭へ
      `lane=` / `cause=` / `layer=` / `conf=` を載せ、`summarizeBlockedTriage()` が
      総数・原因別・route 別・AUTO_RECOVERY 成功率・CEO escalation 率・UNKNOWN 率・同一原因の再発数を導く。
      `GET /api/pl/triage-summary` が read-only で返す。**新しい metrics backend も新しい表も作っていない。**

      **Operational E2E（2026-09-18、production スナップショットの実レコード）**:
      危険な障害を故意に作らず、**自然に発生した過去の Blocked 3件**で検証した
      （production DB を `scp` で取得し、その使い捨て複製に対して実行。production は read-only）。
      - Job `d913fa9d`（`apps/worker/src/guards/fileChangeGuard.ts` 違反）→
        `safety_or_authority_boundary` / `ceo_escalation`。**2026-09-16 に PL が
        「mismatched allowed paths … configuration issue」と誤分類した当の事象**で、
        新しい本文は「どんな allowedPaths でも通らない」と明記した
      - Job `3e95c82b`（`specs/00_constitution.md`）・Job `8664cddc`（`docs/project_memory/rules/approval_rules.md`）→
        `allowed_paths_mismatch` / `independent_remediation`
      - Blocked → 構造化診断 → lane → Gate → Escalation → 状態再取得 → audit → 集計まで追跡できた。
        **provider 診断の呼び出しは 0 回**（escalate しか選べない対象にモデル枠を使わない）。
        2 incident で通知 2 通、以降の tick は idle（spam しない）
      - 再現は `apps/api/scripts/blockedTriageReplay.ts`（read-only）

      **この項目で実装していないもの（重複を作らないため）**:
      - **Independent Remediation 本体**。#255 が先に master へ入ったため、Triage 側に置いていた
        引き渡し用のデータ形（`buildRemediationRequest()`）は**重複になったので削除した**。
        PL ループでは #255 の `remediateConflict()` が Triage より**先**に走る ——
        **分類はレーンの選択であって実行ではない**ので、配線済みの復旧がある対象を
        Triage が横取りしてはならない（この順序は `blockedTriage.test.ts` 12b で固定した）。
        Triage 側に注入可能な dispatch callback は**置いていない** ——
        独立レビュー（2026-09-18）で「Gate を通らない状態変更経路になる」と指摘されたため。
      - **Review Class B**（`review-class-b-enhanced-ai-review` は `deferred`・CEO 承認が着手条件）。
        Class B policy をここで代替実装していない。接続点は `BlockedDiagnosis` が既に持つ machine facts
        （`requiresSafetyBoundaryChange` / `requiresAuthorityChange` / `irreversible` / `evidence`）で、
        Class B が入ったら `safety_or_authority_boundary` を降格してよいかを決めるのはそちらの責務である
      - **Maintenance Lane v0 = Tier B**（`aiteamos-self-development-tier-b` は `planned`）。
        レーンの**ラベルと handoff 本文**だけを用意し、実行経路は作っていない
      - 新しい AttentionKind / TaskStatus / JobStatus / Roadmap state / Gate / approval system /
        notification system / metrics backend / DB table —— **いずれも追加していない**

      **残っている観測ポイント（CEO escalation をさらに減らせるか）**:
      1. `unknownRate` —— 高ければ分類材料が足りない。どの事実が欠けているかを audit から特定できる
      2. `byRootCause` の `allowed_paths_mismatch` 件数 —— Independent Remediation が入れば
        そのまま自動化候補になる母集団である
      3. `byRootCause` の `protected_path` 件数 —— Maintenance Lane v0 の投資対効果の実測値
      4. `recurringRootCauses` —— 同じ原因が繰り返すなら、レーンではなく上流（採用時の scope 検証）の問題
<!-- roadmap:id=adoption-does-not-check-implementation-feasibility state=planned -->
8. [ ] **採用も Design Review も通るのに、allowedPaths 内では実装不能だと実装段階で初めて分かる** —
      2026-09-15登録（production 実測）。CEO 指示により**既存 adoption / Design Review /
      PL diagnosis の改善候補**として記録する。

      **【2026-09-16: 予防側を実施した。検出側（validation）はまだ入れていない】**

      read-only 調査で**真因が判明した。PL の能力不足ではなく、判断材料が無かった。**
      `buildAdoptionPrompt()` が PL へ渡していたのは `id — state — title` だけで、
      Project Goal・Design Philosophy・**ledger 本文**・Source of Truth・repository の実在構造は
      **1文字も含まれていなかった**（`ADOPTION_SYSTEM_PROMPT` を grep して0件）。
      `mobile-approval-role-docs — 2種類の承認の役割整理とMobile導線設計` という1行から
      `docs/approval-roles` を推測したのは、与えられた情報の範囲では自然な出力である。

      実施した最小改善（**新しい Knowledge system / Context subsystem は作っていない**。
      既存 `buildAdoptionPrompt()` / `ADOPTION_SYSTEM_PROMPT` の改善のみ）:
      - 候補に **ledger 本文の先頭200字**を添える（全文は載せない。planned 全件で20万字超）
      - **Project Goal の要約**（524字）を prompt 先頭へ
      - **実在する home の小さな地図**と、**allowedPaths を名称から創作するな**という原則
      - **触れない範囲**（guards / jobRunner / safeEnv / apiAuth / .env）を明示し、
        採用段階で実装不能な項目を選ばせない

      **CEO 指示により、ここで新しい Gate は追加しない。** まず Operational Evidence を取り、
      **存在しない path の生成がなお再発する場合のみ**、既存 validation への最小追加を検討する。

      **2例目（同日 08:20 頃、実測）**: PL が `mobile-approval-role-docs` を自律採用し、
      `allowedPaths: ["docs/approval-roles"]` を宣言した。実装 AI は実際には
      `docs/project_memory/rules/approval_rules.md` と `docs/approval_roles_and_mobile_flow.md`
      を書き、**File Change Guard が blocked**（`fileChangeAllowed: false`）。
      `docs/approval-roles` という**存在しないディレクトリ**を範囲に選んでいた。
      1例目（protected file）と原因は違うが、**「採用時に宣言した範囲が実装先と噛み合わない」
      という同じ症状**である。頻度は低くない。

      なお、このとき stderr には Tier B（PR #216）で入れた診断がそのまま出ており、
      **原因の特定に追加調査を要さなかった**:
      `File Change Guard blocked. Why: … — Not in task.allowedPaths: … allowedPaths scope …`

      **3例目（2026-09-18、production 実測。follow-up Task で発生）**: PL が
      `project-completion-badge-wording-correction#2`（follow-up）を採用し、
      `allowedPaths: ["tasks/roadmap.md"]` を宣言した。実装 AI は `specs/00_constitution.md` を
      編集しようとして **File Change Guard が blocked**（`fileChangeAllowed: false`、Job `3e95c82b`）。

      1・2 例目と違い、**宣言した範囲は存在するディレクトリだった**。ずれたのは
      「その Task で何を実装するか」の認識である。follow-up は「ledger の state を更新する」
      つもりで `tasks/roadmap.md` を宣言したが、Task description には元 item の本文
      （= 既に実装済みの3件）がそのまま載っており、実装 AI はそちらを実装しようとした。
      **宣言範囲と description が別のことを指していると、Guard で初めて露見する。**

      follow-up をそもそも作るべきでなかった点は
      `executed-item-remaining-work-has-no-continuation` の A/B/C 判定で扱う（重複記載しない）。
      ここで扱うのは **allowedPaths と実装対象の突き合わせ**である。

      **3例目（2026-09-16、実測。#227 適用後）**: PL が
      `allowed-paths-empty-disables-file-change-guard` を自律採用し、
      `allowedPaths: ["apps/api/src/**"]` を宣言した。しかし **File Change Guard は glob を
      解釈しない**。突き合わせは前方一致である（`fileChangeGuard.ts`:
      `normalized === normalizedAp || normalized.startsWith(normalizedAp + '/')`）。
      よって `apps/api/src/**` という**文字列**は、`apps/api/src/pl/executionLoop.ts` を含め
      **何にも一致しない**。宣言した範囲は「狭すぎた」のではなく、**実質的に空**だった。

      症状は 1・2例目と同じ（宣言した範囲が実装先と噛み合わない）が、**原因はさらに別**である。
      1例目は protected file、2例目は存在しないディレクトリ、そして今回は
      **path は実在するのに記法が Guard の仕様と違う**。したがって #227 で入れた
      「名称から path を創作するな」では防げない — `apps/api/src` は実在し、創作でもない。

      **prompt 側の欠落として確認済み**: `ADOPTION_SYSTEM_PROMPT` は allowedPaths に
      「repository-relative で2階層以上」とだけ要求し、**前方一致であること・glob が使えないことを
      一度も述べていない**。PL の出力は与えられた規約に反していない。

      **着手時に確認することへの追加**: 上の「どこまでなら機械的に言い切れるか」に対する
      **答えの一部がここにある**。glob metacharacter（`*` `?` `[`）を含む allowedPaths 要素は、
      実装対象ファイルを推測しなくても **Guard 上で必ず不一致になる**と言い切れる。
      実装対象の予測を要する protected 判定とは違い、**誤検出の余地が無い**。
      ただし**どこで弾くかは着手時に決める**（新しい Gate も新しい Review 段も作らない、は不変）。

      **事象**: PL が `guard-block-message-omits-allowed-paths` を自律採用 → Design Review は
      **ALIGNED** → implement Job 作成、まで進んだ。しかし対象は `jobRunner.ts` /
      `fileChangeGuard.ts`（**`ALWAYS_FORBIDDEN_PATTERNS` の protected file**）で、
      採用時の `allowedPaths` は `apps/api/src/ctoAi` / `packages/shared/src` だった。
      実装 Job は `implementation produced no file changes`（exit 0 / `changedFiles: []` /
      `workspaceState: unchanged`）で失敗。**File Change Guard すら発動していない**
      （そもそも触れるファイルが範囲内に無い）。

      **つまり「その Task は Candidate では原理的に完了できない」ことを、
      採用も Review も検出していない。** 判明するのは provider を1回消費したあとである。
      （この Task 自体は CEO 承認のもと Tier B として外部実装し、master `40bfed1` で解決した。
      ここで扱うのは**次に同じことが起きるのを防ぐ**話である。）

      **着手時に確認すること（実装方針を先に決めない）**:
      - **新しい Gate も新しい Review 段も作らない。** 既存のどこで検出できるかを先に決める:
        採用時の `validateRoadmapTasks()` か、Design Review の focus か、
        `createInitialImplementWorkflow()` の eligibility か
      - 判定材料は既にある。`ALWAYS_FORBIDDEN_PATTERNS` と `allowedPaths` の突き合わせは
        `fileChangeGuard` と同じ情報源でできる。**Guard 側は変更しない**
      - ただし「実装対象ファイル」は採用時点では宣言されていない（`allowedPaths` は範囲であって
        対象一覧ではない）。**推測で弾くと正当な Task まで落とす**ので、
        どこまでなら機械的に言い切れるかを先に見極める
      - 検出できたとき何をするか。自動で Tier B へ回すのか、CEO Escalation か。
        **PL に権限を与える話にしない**
      - 効果検証可能性（Design Philosophy 8）: 「採用したが allowedPaths 内で実装不能だった」
        件数を後から数えられること

<!-- roadmap:id=adopted-item-blocked-by-stale-deferral-text state=done -->
9. [x] **自律採用した項目が「MVP後へ延期」という古い本文のせいで Design Review に CONFLICT される**
      — **完了（2026-09-15, PR #211）**。CEO 判断により、ledger 全体の時点整合を取って解消した。

      **やったこと**: MVP 関連の記述を全走査して各出現を囲う item と state に対応づけ、
      open item 9件へ「延期条件は充足済み」の注記を入れ、延期理由が MVP 待ちだけだった2件を
      `deferred` → `planned` にした。**現在の可否は `state=` が正本**という規則を ledger 冒頭へ置き、
      `readAdoptionCandidates()` を `planned` のみに絞って **`deferred` を実際に効かせた**
      （従来は `!== 'done'` で、「現在も実装禁止」を表す手段が事実上存在しなかった）。
      **新しい state 体系も metadata も追加していない。**

      **今回の Task 固有の対応はしていない**（CEO 指示: 個別 Task 専用の例外処理を作らない）。

      なお、同じ「採用したのに進めない」症状でも**原因が別**のものは
      `adoption-does-not-check-implementation-feasibility` へ分けた。

      ---
      以下は登録時の記録。

      2026-09-15登録（production 実測。**CEO 判断が要る**）。

      **事象**: PL が `task-allowed-paths-not-normalized` を自律採用した直後、Design Review が
      `finalDecision: CONFLICT` を返して実装 Job が作られず、連続自律開発が2件目で止まった。
      経緯と全ログは
      `docs/project_memory/decisions/multi_task_continuous_autonomous_development_evidence.md`。

      **CONFLICT の根拠は2つあり、性質が違う**:
      1. **「post-MVP へ延期されている」** — 採用元 ledger 項目の本文が
         「**MVP後へ延期** — 回避策は仕様書のパス表記を相対にするだけでコード変更が不要なため」と
         書いている。しかし **MVP は 2026-09-13 に完了**し `TEMP_MVP_COMPLETION_POLICY` も削除済みで、
         **延期条件はすでに満たされている**。ledger 本文が古いまま残っていることが誤読を招いた
      2. **「より軽い代替がある」** — 絶対パスを警告する / guard のメッセージに `allowedPaths` を
         書く、といった選択肢に比べて path 正規化層は複雑すぎる、という指摘。
         **これは (1) と独立に成立する**（scope_simplicity）

      **外部セッションはここを解決しない。** ledger 本文を書き換えれば CONFLICT は消えるが、
      それは **Binding Review の入力を外から操作して判定を覆す**ことに等しい。
      `approval_rules.md`「Review finding の扱い」章に従い、Second Independent Review →
      Meta Review → CEO Escalation で再評価する。

      **着手時に確認すること（実装方針を先に決めない）**:
      - 「MVP後へ延期」と書かれた ledger 項目が他に何件あるか。**MVP 完了後もこの表記が残っている限り、
        PL が何を採用しても同じ CONFLICT が再発しうる**。個別対応ではなく表記の扱いを決める
      - 延期条件の充足を Design Review が読めるか。読めないなら、ledger 側で
        「延期 → 解除済み」を機械的に表せるか（**新しい state 語彙を増やさずに**）
      - (2) の scope_simplicity 指摘は正当か。正当なら、採用時の `implementationScope` を
        より軽い案へ絞れば通るのか
      - 効果検証可能性（Design Philosophy 8）: CONFLICT で止まった採用が何件あり、
        そのうち何件が表記起因だったかを後から数えられること
<!-- roadmap:id=executed-item-remaining-work-has-no-continuation state=in_progress -->
10. [~] **一度実行した Roadmap 項目に残作業があると、誰も次の Task を作れない（continuation dead-end）** —
      2026-09-17登録（read-only 調査 + production 実測）。**本項目は Finding であり、まだ実装しない。**

      **事象**: Roadmap 項目が ledger 上まだ open で、その項目の Task が既に done、
      かつ本文に残作業がある状態になると、**人手なしでは二度と先へ進めない**。
      既存経路が全部断る（in-memory SQLite で再現、2026-09-17）:

      | 経路 | 結果 |
      |---|---|
      | `readAdoptionCandidates()` | 候補に出さない（`executedKeys` で除外） |
      | `adoptRoadmapItem()` | `ITEM_NOT_ADOPTABLE`（in_progress のとき） |
      | `adoptRoadmapItem()`（state を `planned` へ戻しても） | **`ALREADY_EXECUTED`** |
      | `resumeBlockedTask()` | 拒否（`Latest job status is success, not blocked`） |
      | `task_continuations` | commit 時点で `status=completed` / `nextTaskId=null` として**既に終端済み** |
      | `buildSystemState()` の `attention` | **NONE**（PL には何も見えない） |

      その後 PL は `maybeAdoptNext()` で**次の planned 項目を採用して先へ進む**。
      残作業は誰にも気付かれずに落ちる。**失敗として観測されない**のが最も危険な点である。

      **root cause（単独の欠陥ではなく4つの組み合わせ）**:
      1. 採用は 1 Roadmap 項目につき実質 1 Task。`syncRoadmapTasks()` は入力外の
         roadmapActive Task を落とすので、2件目の Task は存在しない
      2. 一度でも Job が走ると `ALREADY_EXECUTED` で**再採用が恒久的に不可能**になる
         （`roadmapAdoption.ts`。`adoptionStep.ts` の `executedKeys` も同じ事実で候補から外す）
      3. `selectNextContinuableTask()` は**既存の pending roadmapActive Task しか選ばない**。
         Task を作る責務をどこも持っていない
      4. `AttentionKind` は全て Task / Job / continuation スコープで、`systemState.ts` は
         **ledger を一切読まない**。「項目に残作業がある」ことを表す事実がシステム内に存在しない

      **PR #226 の planned-only は原因ではない。** `state` を `planned` へ戻しても
      `ALREADY_EXECUTED` で詰まることを実測している（上表）。
      planned-only は refusal を1つ増やしただけで、行き止まり自体はそれ以前から存在する。

      **production 実測（2026-09-17・read-only）**: CEO が例示した3項目
      （`mandatory-gate-policy` / `cross-project-state-api` /
      `roadmap-generation-constraint-compliance`）は**いずれも Task が1件も無い**
      （外部セッションが実装したため採用経路を通っていない）。
      よって3件とも **Case A = 詰まっていない**。人が `pnpm roadmap:update <id> planned` で
      state を戻せば通常どおり採用でき、`task_ready_without_job` も正常に出る（再現確認済み）。

      **実際に詰まっているのは別の項目である。** `roadmap_task_key` を持つ Task を
      production DB で全件照合した結果、**ledger で open なのに Task が実行済み**なものが実在する:

      | roadmap id | ledger | Task | jobs |
      |---|---|---|---|
      | `roadmap-adoption-followups` | planned | done | 1 |
      | `meta-review-structured-output-robustness` | planned | done | 5 |
      | `mobile-approval-role-docs` | planned | done | 6 |
      | `continuation-reconcile-nonblocking-followups` | planned | done | 6 |
      | `allowed-paths-empty-disables-file-change-guard` | planned | pending | 1 |

      **重要な差異（CEO 提示の定義より範囲が広い）**: 上記はすべて `in_progress` ではなく
      **`planned`** である。行き止まりの条件は `state === 'in_progress'` ではなく
      **「ledger で open ＋ その項目の Task が既に Job を実行済み」**である。
      `in_progress` は手動 CLI でしか書かれない（`roadmap:update` のみ）ので、
      実際には `planned` のまま残っている方が多い。
      なお下2件は別の pending Task / 未終了 Task を持つため進行経路は残っている（再採用だけ不可）。
      完全な行き止まりは上3件。

      **設計原則（CEO 指示・2026-09-17。実装時に守る）**:
      - **planned-only の initial adoption は維持する。`in_progress` を通常の採用対象へ戻さない**
      - 「既に実行済みの open 項目に残作業がある場合**だけ**、bounded な follow-up Task を作る」
        という**狭い continuation** として設計する
      - 新しい continuation system / workflow / TaskStatus / Roadmap state を**先に作らない**。
        既存の `adoptRoadmapItem` / Task 生成 / `implementationScope` / Design Review /
        Mandatory Gate / Independent Review / PL / State API の再利用を優先する

      **成立の最低条件（実装時の受入条件）**:
      prior executed Task あり / active Task なし / pending continuation なし /
      旧 Task は resume 不可 / **新しい `implementationScope` を必須**にする /
      **新 Task として作る**（旧 Task を再利用しない）/ Design Review・Gate・`allowedPaths` を
      **再計算する** / **過去の approval・authority を一切継承しない**。

      **Detection（先に検討する順序）**: 「open な項目に残作業があるが active Task が無い」を
      **既存 State API / `attention` へ載せられないか**を最初に見る。
      既存 `AttentionKind` で表現できるなら**新しい kind を増やさない**。
      ただし現状の `attention` は Task / Job / continuation からしか作られず、
      `systemState.ts` は ledger を読まないため、**事実の入口が無い**のが実装上の争点になる。
      観測面の語彙は `cross-project-state-api` が owner なので、そちらと重複させない。

      **関連項目（重複させない）**:
      - `roadmap-adoption-followups`（planned）— サブ項目(3)は「**手動作成 Task** が採用経路の
        入口に無い」問題で、本項目の「**実行済み項目の残作業**」とは別。ただし直す seam は同じ
        adoption 経路なので、着手するなら同時に設計する。
        **この項目自身が上表の行き止まり実例でもある**
      - `no-status-for-closing-a-task-without-implementing`（planned）— 「実装せず閉じる」状態が
        無い問題。本項目は「閉じたが残っている」側であり別
      - `adoption-does-not-check-implementation-feasibility`（planned）— 採用時点でスコープの
        実現可能性が分からない問題。本項目とは別
      - `pl-autonomous-roadmap-adoption`（done）/ `mandatory-gate-policy` — action 語彙と
        強制 Gate の owner。本項目で新しい PL 権限を作らない

      **【2026-09-17 更新: CEO が follow-up 境界を確定し、`deferred` → `in_progress` へ】**

      保留理由は解消した。deferral の根拠は「解決策が `ALREADY_EXECUTED` への例外＝adoption authority の
      条件付き拡大になる可能性が高く、CEO がその境界を決める前に PL が採用しないため」だった。
      CEO が 2026-09-17 に follow-up の成立条件・上限・Class 境界・検出方式を確定したため、この理由は無くなった。

      **`planned` を経由せず直接 `in_progress` にしている。** 本項目はローカルセッションが実装担当であり、
      `planned` に戻すと VPS PL の自律採用対象になって同じ項目を二重に着手しうるためである
      （CEO 指示・2026-09-17）。**採用可能 state は `planned` のみという既存 allowlist は変更していない。**

      **確定した境界（実装はこれに従う）**:
      - follow-up は許可する。ただし**必ず新しい Task** として作り、旧 Task を resume・再利用しない
      - Task identity を `<ledger id>#<sequence>` で分けることで、**`ALREADY_EXECUTED` 本体は緩めない**。
        保証は「この Roadmap item は永久に禁止」から「**同一 Task identity の二重実行は禁止**」へ精緻化する
      - 成立条件（AND）: 元 item が open / prior Task が done / active Task なし / pending continuation なし /
        prior を resume すべき状態でない / 未完了作業を特定できる / 新しい `implementationScope` が明示されている
      - blocked は既存 resume 経路、failed は既存 PL diagnosis・recovery 経路。**follow-up で迂回しない**
      - 上限は 1 item あたり follow-up 10 回。**これは通常作業の制限ではなく最後の異常センサー**であり、
        同一 scope・進捗なし・同一失敗の反復は 10 回を待たず早期停止する
      - follow-up は毎回 Design Review / Gate / allowedPaths / risk / Review を**再計算**し、
        過去の Approval・authority・evidence を**継承しない**
      - follow-up 自体は最低でも Class B。Safety Boundary / Authority / security model / 現行 Policy 上の
        DB migration / destructive・不可逆 / Reviewer 間の重要な不一致が未解消、は Class C
      - 検出は B+ 方式。**candidate limit / priority / rotation より前**に open 全件へ機械判定を当て、
        skip は `audit_log` へ記録し、3 回連続 skip で**順序だけ**繰り上げる（Gate・Class 判定は弱めない）

      **【2026-09-18 production 実測で追加した原則。ここが本 Finding の中心である】**

      **Roadmap item が open であることだけを、remaining implementation scope の証拠にしてはならない。**

      実測: `project-completion-badge-wording-correction` を PL が自律実装し、Review approved・
      CEO 承認・commit（Candidate `ea3141c`）まで到達した。ところが ledger の `state` は
      `planned` のままだった（**ledger を書く経路がシステム内に無い**。`tasks/roadmap.md` は
      `roadmapAdoption.ts` も `roadmapWriter.ts` も書かず、`pnpm roadmap:update` + PR という
      人手経路でしか更新されない）。follow-up 検出は「item が open」を残作業の証拠として扱い、
      `...#2` を作成。その follow-up は `allowedPaths: ["tasks/roadmap.md"]` — すなわち
      **「ledger の state を更新すること」を製品実装スコープとして採用していた**。

      **follow-up 候補化の前に、次の3つから状態を区別すること**:
      - Roadmap item 全体の acceptance criteria
      - 過去 Task が**実際に完了した内容**（changedFiles / commit）
      - Review / commit evidence

      | 判定 | 意味 | すること |
      |---|---|---|
      | **A** | 実質的に完了済み | **follow-up Task を作らない。** Roadmap completion reconcile の対象 |
      | **B** | 明確な remaining implementation scope がある | その具体的な `implementationScope` だけを follow-up へ |
      | **C** | 判断不能 | 勝手に follow-up を作らず Review / Escalation へ回す |

      **`tasks/roadmap.md` の state 更新そのものを follow-up の実装スコープにしない。**
      それは製品実装ではなく completion reconcile であり、実装 Task の形にすると
      「ledger を直すための Task」が延々と生まれる。

      **新しい workflow / TaskStatus / Roadmap state を先に追加しないこと**（CEO 指示・2026-09-18）。
      まず上の A/B/C 判定を既存の検出経路のどこへ置けるかを決める。

      **（履歴）当初 `state=deferred` とした理由（CEO 判断・2026-09-17）**: 本 Finding の最終的な解決は
      `ALREADY_EXECUTED` に対する**限定的な例外**、すなわち既存の adoption authority を
      条件付きで広げる形になる可能性が高い。CEO がその境界を決める前に PL がこの項目を
      自律採用しないよう、`deferred` にする。
      **Finding の存在・優先度を下げる意味ではない。実装着手だけを保留する。**
      `deferred` は PR #226 以降、候補一覧・直接採用・Gate alignment の3経路すべてで
      機械的に効くので、この保留は文言ではなく強制である。

      **着手手順**: 次の4点の境界を CEO へ提示し、承認を得てから `state=planned` へ戻す。
      (1) どの条件なら executed item の follow-up を許すか /
      (2) `ALREADY_EXECUTED` のどこまでを維持するか /
      (3) follow-up が新 Task として Design Review・Gate・`allowedPaths` を全て再計算すること /
      (4) 過去の approval・authority を一切継承しないこと。

      **Detection と Action を別 Finding へ分割しない（CEO 指示・2026-09-17）。**
      両者は同じ root cause（実行済み項目の残作業を表す事実がシステム内に存在しない）から
      出ているため、本項目にまとめて残す。

      **やらないこと（non-goals）**: `ALREADY_EXECUTED` を単純に撤去すること
      （同じ Task の二重実行を防いでいる既存の防御であり、外すと 2026-09-15 の
      attempt 予算消費事故が戻る）/ `in_progress` を採用対象へ戻すこと /
      新しい Task status・Roadmap state・継続専用テーブルの追加 /
      本 Finding を根拠に Safety・Approval 境界を動かすこと。
      **`ALREADY_EXECUTED` に例外を設けるのは既存 guard の緩和にあたるため、CEO 判断事項とする。**

<!-- roadmap:id=blocked-job-revert-material-not-persisted state=deferred -->
11. [ ] **blocked になった Job の変更を、後から安全に取り消す材料が残っていない** —
      2026-09-17登録（`abort_task` 実装中に実測）。**本項目は Finding であり、まだ実装しない。**

      **事象**: `revertBlockedJobChanges()`（`apps/worker/src/jobRunner.ts`）は
      `(workingDir, startCommitHash, manifest: ChangeManifest, preExistingPaths)` を要求するが、
      **後ろ2つが Job 行に永続化されていない**。実行中プロセスの `JobRunResult` にしか存在しないため、
      **過去に blocked になった Job に対しては呼べない**。

      現在の起動経路は job 報告時の1本だけで、API が escalate を確定したとき
      `workspaceCleanupRequired: true` を返し、Worker がその場の in-memory 結果で掃除する。
      Worker が再起動すれば材料は消える。

      **永続化されている情報では代用できない**:
      - `jobs.changed_files` … **パスだけ**。`ChangeManifest.changes` が持つ種別
        （added / modified / deleted / renamed）が無い。種別なしでは「復元」か「削除」かを
        推測することになり、逆向きの操作をすれば被害が出る
      - `preExistingPaths` … 一切残っていない。これが無いと
        「Job 開始前から dirty だったパスには触れない」という同関数の中核原則を守れない
      - `jobs.workspace_baseline` … 開始時点の参照点であって、**この Job が何を変えたか**ではない

      **影響**: dirty なまま blocked になった Job は、どの経路からも安全に掃除できない。
      所有権解放には workspace 検証が要り（`failAndPrepareRepair`:
      「未検証の workspace で所有権を解放してはならない」）、検証を通すには掃除が要る、という循環になる。
      `clearWorkspaceQuarantine()` は quarantine metadata を消すだけで status を変えないので、
      所有権は解放されない。

      **`abort_task`（#235）との関係**: #235 は **verification-only** で成立している
      （workspace が baseline と一致し、かつ known-good であれば park、そうでなければ fail-closed）。
      2026-09-17 の production 実測では対象 workspace が既に baseline と一致していたため、
      revert は不要だった。**本項目は #235 を止めない**が、
      dirty なまま残った blocked Job は abort できない、という制約は残る。

      **着手時に比較すること（実装方針を先に決めない）**:
      - revert に必要な情報（manifest の種別 + preExistingPaths）を**永続化する最小変更**。
        既存 `jobs` 列への追加で足りるか、量・秘密情報の観点で問題ないか
      - 既存 `changed_files` + `workspace_baseline` + git の実状態から**復元可能か**
        （種別を git から再導出できるか。できるなら永続化は不要）
      - **blocked にする時点で掃除まで終わらせる**方が自然ではないか。
        材料がある唯一の瞬間はそこであり、後から掃除する経路を作るより状態空間が小さい
      - **新しい cleanup subsystem を先に作らない。** 上記3案を比較してから決める

      **`state=deferred` の理由**: 上記3案のうち2案（材料の永続化 / blocked 時点での掃除）は
      `jobs` 表のスキーマ変更を伴う。現行 Policy 上 DB migration は Class C であり、
      どの案を採るかを CEO が決める前に PL が自律採用しないよう `deferred` にする。
      **Finding の優先度を下げる意味ではない。実装着手だけを保留する。**

      **関連**: `workspace-dirty-leakage-cleanup`（done）が escalate 時の掃除を入れた項目。
      本項目はその**適用範囲外**（blocked のまま残った Job）を扱う。重複実装しないこと。

<!-- roadmap:id=approval-gate-evidence-not-action-bound state=deferred -->
12. [ ] **`approval_gate` evidence は action へ束縛されず、Gate 経路では使い切られない** —
      2026-09-17登録（#235 の独立レビュー Finding 3 から分離）。**本項目は Finding であり、まだ実装しない。**

      **事象**: `checkApprovalGate()`（`apps/api/src/pl/actionGate.ts`）は
      ApprovalRequest について **target Task / `APPROVED` / 期限**しか見ない。

      - **どの action への承認かを見ない。** ApprovalRequest は Task 単位で発行されるため、
        同じ Task に対する別 action（例: `git_commit`）の承認が、
        `approval_gate` を要求する**別の PL action の evidence として通る**
      - **使い切らない。** Gate を通過しても `CONSUMED` へ遷移しないため、
        同じ承認が**何度でも**別の action を authorize できる。
        これは `packages/shared/src/types/approval_gate.ts` の
        「承認は特定 commit/diff に対する**一回限りの許可**」という契約と食い違う

      **現在の影響範囲**: `resolvePlActionPolicy()` が `approval_gate` を要求する action は
      複数ある（`packages/shared/src/plActionPolicy.ts`）。`git_commit` 系は
      `POST /api/approval-requests/:id/consume` という**別経路**で使い切られており、
      そこでは `requestedAction !== job.safeCommand.kind` の照合もある。
      **Gate 経路だけがその2つを持っていない。**

      **`abort_task`（#235）は本項目の影響を受けない**: #235 は `abort_task` について
      `requestedAction === 'abort_task'` の一致を要求し、park transaction 内で
      `APPROVED → CONSUMED` まで進める。**他 action の挙動は #235 では変えていない**
      （既存 action の承認 semantics を広く変える改修になるため、本項目へ分離した）。

      **着手時に確認すること（実装方針を先に決めない）**:
      - action → 必要 `requestedAction` の対応表を全 action へ広げられるか。
        既存の承認がどの文字列で発行されているかを**実データで**確認してから決める
        （対応表を先に書くと、既存の承認が一斉に弾かれて全 PL action が止まりうる）
      - Gate 経路での consume をどこに置くか。**Gate 判定の時点では action はまだ実行されていない**ため、
        判定時に consume すると「承認を使ったのに何も起きなかった」状態を作る。
        #235 は「実行を確定させる transaction の中で consume する」形を採った
      - 既存 `/consume` 経路と**二重に**使い切らないこと。同じ承認が両経路から
        consume されると、片方が STATUS_CONFLICT で失敗する
      - 効果検証可能性（Design Philosophy 8）: 束縛を入れた後に
        「action 不一致で弾かれた承認」が何件あるかを `audit_log` から数えられること

      **`state=deferred` の理由**: これは既存 Approval の semantics を全 action へ広げる変更であり、
      `specs/22_safety_approval_design_principle.md` の Human Approval 境界に直接触れる。
      誤ると**全 PL action が承認を得られず停止する**方向にも、
      **承認が実質無検証になる**方向にも倒れうる。CEO が境界を決める前に自律採用しないよう
      `deferred` にする。**Finding の優先度を下げる意味ではない。**

      **やらないこと（non-goals）**: 新しい承認種別・新しい Gate・新しい状態語彙の追加 /
      `approval_gate` を要求する action 一覧の変更 / 本 Finding を根拠に
      Yellow Zone・Safety Boundary を動かすこと。

<!-- roadmap:id=control-repository-header-vs-enforced-guard state=planned -->
10. [ ] **`⚠️ CONTROL REPOSITORY — AI編集禁止` 注記と、実際に強制される保護範囲が一致していない** —
      2026-09-15登録（CEO の承認画面での指摘が発端）。

      **確認された事実（2026-09-15 実測）**:
      - 当該ヘッダは **30以上のファイル**に付いており、`alignmentChecker.test.ts` /
        `safetyAuditor.test.ts` / `geminiRouter.test.ts` のような**純粋なテストファイルにも付いている**
      - 一方、**機械的に強制される**のは `ALWAYS_FORBIDDEN_PATTERNS`
        （`apps/worker/src/guards/fileChangeGuard.ts`）だけで、こちらは
        guard 群 / `jobRunner` / `safeEnv` / `apiAuth` / `gateClient` / `gatePolicy` /
        `metaReviewer/geminiClient` 等に**日付つきの根拠コメントを添えて厳選**されている
      - 実例: `apps/worker/src/metaReviewer/autoReview.ts` はヘッダで「AI編集禁止」と宣言しているが
        `ALWAYS_FORBIDDEN_PATTERNS` に無く、`allowedPaths` に入れば AI が変更できる
        （実際に Task `bd80c4ce` がこの状態で承認待ちになった）

      **なぜ問題か**: **注記が boundary として使えない。** CEO が承認画面で
      「AI編集禁止と書いてあるが変更してよいのか」と判断できない。
      注記を信じると Tier A 自己開発がほぼ全面停止し、注記を無視すると
      「禁止と書いてあるものを無視してよい」という運用が常態化する。どちらも良くない。

      **着手時に確認すること（実装方針を先に決めない）**:
      - 注記の意味を**1つに決める**。「変更に追加の Review が要る」なのか
        「AI は一切触れない」なのか。今は両方の読み方ができる
      - 決めた意味を**機械で強制できる形**にする（`ALWAYS_FORBIDDEN_PATTERNS` へ寄せる／
        注記を機械可読にして guard が読む／注記を落として一覧を単一の正本にする）。
        **2つの正本を残さない**
      - **新しい Guard を作らない。** 既存 `fileChangeGuard` の範囲で表現できるかを先に見る
      - 承認画面へ「この変更対象に保護対象が含まれるか」を事実として出せるか
        （`triggeredRules` に相当する形で。AI の判断ではなく機械判定として）

      **CEO 指示（2026-09-15）— 解消の条件**:
      **master への Promotion 前に本項目を解消すること。**
      Task `bd80c4ce` の Candidate commit 自体は承認されたが、Promotion はこの解消を待つ。

      **単純にヘッダを削除・書き換えて済ませない。** 次を確認したうえで、
      **正式な Safety Boundary を一本化する**こと:
      - `CONTROL REPOSITORY` の正式な意味
      - どのファイルが**本当に** AI 編集禁止なのか
      - `ALWAYS_FORBIDDEN_PATTERNS` が正式な強制境界なのか
      - `allowedPaths` との関係
      - **コメントと機械強制のどちらを Source of Truth とするのか**

      **AI 側が自分の権限を広げる形で解決してはならない。**
      Safety Boundary 変更に当たる場合は CEO へ Escalate する。
      finding の統合判断の記録は
      `docs/project_memory/decisions/autoreview_diff_range_review_findings.md`。

      **2026-09-15 repository 腐敗監査によるスコープ拡張（新規 item は作らない）**:
      本項目の acceptance criteria（「`CONTROL REPOSITORY` の正式な意味を決める」
      「コメントと機械強制のどちらを Source of Truth とするのか」「**2つの正本を残さない**」）は、
      監査で見つかった以下にもそのまま適用される。**同一の決定を一度に反映する**こと。
      別 item に切ると Safety Boundary の正本が再び分裂するため、ここへ集約する。

      - **憲法の境界名が実在しない**: `CLAUDE.md` §4/§5（「最重要」）・`AGENTS.md` §1・
        `specs/11_runtime_environment.md` が `ai-team-backend/` / `target-project/` という
        **この repository に存在しないディレクトリ名**で境界を定義している。実際に強制しているのは
        絶対 root 封じ込め（`apps/worker/src/utils/pathUtils.ts` の `TARGET_ROOT` +
        `isInsideTargetRoot()`、`apps/api/src/utils/pathGuard.ts`、`ALWAYS_FORBIDDEN_PATTERNS`）。
        `fileChangeGuard.ts` のヘッダは「`target-project/`配下のみ許可」と書くが、
        実装は `target-project/` prefix を**一度も判定していない**。
        同一境界に 5 つの呼び名が流通している。
      - **Meta Reviewer が存在しないルールを毎回監査している**: `docs/meta_reviewer/prompt.md` が
        「`fileChangeGuard` の target-project 限定を解除している」を Cage 弱体化の判定基準に挙げ、
        `docs/meta_reviewer/checklist.md` が「target-project/配下のみ許可のロジックが維持されている」を
        チェック項目にしている。**そのロジックは存在しないため恒久的に判定不能**である。
      - **「Docker が物理的に強制する」という安全性主張が誤り**: `AGENTS.md` §1 の
        「分離の仕組み（手動ではなくDockerが強制）… エージェントは物理的に Control Repository を書けない」は、
        `specs/11_runtime_environment.md` の Current Truth（2026-08-14修正）が明示的に否定しており、
        実際の隔離は per-job cgroup v2（`apps/worker/src/execution/runContainedCommand.ts`）である。
        `AGENTS.md` は**同一ファイルの §1-1 で正しく path ベース guard と書いており内部矛盾**。
        同じ誤りが `docs/PROJECT_CURRENT_STATE.md` と `docs/env-notes.md` にもある。
        `AGENTS.md` は全 ContextPack へ注入されるため、全 AI が誤った安全前提を受け取っている。
      - **active な rule 文書が CEO 承認済みの自己開発を禁止している**:
        `docs/project_memory/rules/development_rules.md`（**Importance Level: 1 / Status: active**）が
        「Control Repository (`apps/api/`, `apps/worker/`, `sandbox/`) の改変」を禁止と書く。
        `AGENTS.md` §1-1（2026-09-13）は Control Repository を「稼働中 Stable インスタンスの
        control plane」と再定義し、隔離された Candidate clone の編集を明示的に許可している。
        **この文書は `apps/worker/src/guards/alignmentChecker.ts` の `DESIGN_DOCS_PATHS` に含まれる
        = Gemini Alignment Review の入力正本**であり、放置すると正当な Tier A 自己開発を
        violation と判定しうる。
      - **CODEOWNERS が安全ロジックの現在地を保護していない**: `.github/CODEOWNERS` は
        `apps/worker/src/guards/` / `sandbox/` / `CLAUDE.md` / `docs/meta_reviewer/` /
        `packages/shared/src/types/agent.ts` を保護するが、`AGENTS.md`
        （`AGENTS.md` 自身が「CEOが具体的diffを明示承認した場合に限り実施する」と宣言している）、
        `packages/shared/src/{approvalGateLogic,approvalLevelClassifier,plActionPolicy,reviewSeparation,
        strategicDecision}.ts`、`apps/api/src/auth/**`、`apps/api/src/pl/actionGate.ts`、
        `apps/api/src/routes/approvalGate.ts`、`apps/api/src/designReviewEvidencePolicy.ts`、
        `apps/worker/src/approvalLevel/**`、`apps/worker/src/execution/runContainedCommand.ts`、
        `docs/project_memory/`（alignmentChecker が読む正本群）は**未保護**。
        「どのファイルが本当に保護対象か」という本項目の答えが、そのまま CODEOWNERS の対象定義になる。
        **CODEOWNERS 変更は Safety Boundary 変更に当たるため CEO 承認が要る。**
      - **存在しないファイルに対する live な保護ルール**:
        `packages/shared/src/approvalLevelClassifier.ts` が `/postTestHook\.ps1$/` を
        Mechanical Gate Level 3 固定ルールとして持ち、
        `apps/worker/src/approvalLevel/safetyVerifier.ts` に `checkPostTestHookUntouched` がある。
        しかし `postTestHook.ps1` は repository に存在しない（`git ls-files` で 0 件）。
        `docs/PROJECT_CURRENT_STATE.md` の R-007 は「意図的な未追跡」と説明しているため、
        **VPS 上の存在確認を先に行う**こと。
      - **`TARGET_ROOT` に 3 つの解決方式が並存する**: (1) env 駆動・既定 `/workspace/target`
        （`apps/api` の 6 箇所）、(2) ハードコードで env 非対応
        （`apps/worker/src/utils/pathUtils.ts` — **`isInsideTargetRoot()` が実際に強制するのはこれ**）、
        (3) ハードコードかつ env を明示的に拒否（`apps/api/src/config/targetWorkingDir.ts`、
        ヘッダに理由記載）。既定以外を設定すると API の roadmap/adoption パスだけが動き、
        Worker の書き込み guard と Job の `workingDir` は動かない。

      **追加制約**: 上記はいずれも**記述側の修正で足り、新しい Guard・Gate・Review は不要**である
      （CODEOWNERS の対象追加のみ CEO 承認事項）。
      **AI 側が自分の権限を広げる形で解決してはならない**という既存の制約を全項目へ適用する。

<!-- roadmap:id=pl-escalation-blames-the-wrong-cause state=planned -->
11. [ ] **CEO / PL に届く停止理由が、実際の原因を指していない** —
      2026-09-15登録（production 実測）。**機構ではなく、届く情報の品質の問題。**

      **【2026-09-15 追記】原因側は大きく改善した。残っているのは attention の detail。**

      Tier B（PR #216）で Job の stderr **先頭**に診断が入ったあと、PL の Escalation 本文は
      「file guard violations outside allowed paths, requiring higher-level decision to adjust
      scope or paths」と**正しい原因**を書くようになった（下記の誤診と対照的）。

      一方で **`attention` の `detail` は依然として噛み合っていない**:
      `systemState.ts` は `tail(job.stderr, 200)` で**末尾**200字を取るが、診断は**先頭**にある
      （末尾に置くとプレビュー切り詰め 4000 字で消えるため先頭にした）。結果、Mobile と PL が
      受け取る `detail` は `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY…` という
      **無関係な警告**のままである。**stderr の生産側と消費側が「どちらの端が重要か」で食い違っている。**

      **着手時に確認すること**: `tail` を `head` に変えるだけで足りるか（末尾が重要なケースが
      他にあるか要確認）。**新しいフィールドも新しい抽出機構も作らない。**
      `apps/api/src/state/systemState.ts` は protected file ではないので **VPS 側で実装できる**。

      ---
      以下は登録時の記録（誤診の実例）。

      **事象**: Task `7bd4a65a` の implement Job が失敗したとき、PL は CEO へ
      「**外部の `ANTHROPIC_API_KEY` の設定問題**であり自動復旧できない」と上げた。
      しかし実際の失敗理由は `implementation produced no file changes`
      （exit 0 / `workspaceState: unchanged` / 変更ファイル0件）で、
      `ANTHROPIC_API_KEY` の行は **stderr 冒頭の警告**（connector が無効という注意書き）にすぎない。
      真因は「対象ファイルが `allowedPaths` の外（しかも protected file）で何も書けなかった」である。

      **なぜ問題か**: Escalation は CEO が判断するための唯一の入力である。原因を取り違えた本文は、
      **CEO を存在しない設定問題の調査へ誘導する**。Design Philosophy 8（効果検証可能性）にも反する。

      **着手時に確認すること（実装方針を先に決めない）**:
      - stderr の**警告行と失敗理由を分離**して渡せるか。今は末尾数百字をそのまま渡している
      - `failureMetadata`（`workspaceState: unchanged` 等）や `changedFiles` の空を、
        診断 context で**より強い手がかり**として提示できるか
      - 「allowedPaths の外を触ろうとした」を機械的に判定して context に載せられるか
        （`guard-block-message-omits-allowed-paths` と同じ情報源）
      - **新しい診断機構は作らない。** 渡す context の作り方（`buildContext()`）の改善で足りるか
      - 効果検証可能性: 誤った Escalation が何件あったかを後から数えられること

<!-- roadmap:id=provider-outage-burns-attempt-budget state=planned -->
12. [ ] **provider の一時障害が bounded attempt を使い切り、復旧後も Task が終端のまま残る** —
      2026-09-15登録（production 実測）。**`design-review-runner-production-timeout` の後続**であり、
      同じ Meta Review 経路の改善として扱う。**新しい retry framework は作らない。**
      **担当境界（2026-09-15）**: 本項目は「transient 起因の失敗が attempt 予算を食い潰す」こと、
      つまり**同じ provider のまま予算の数え方を直す**話である。
      予算を使い切って終端した後に**別 provider へ正式再審査を依頼する**能力は
      `review-provider-exhausted-alternate-rereview` が持つ。両者は補完関係にあり重複しない。

      **実測**: Task `bd80c4ce` の Design Review run `4032eec3` が attempt 3 すべて
      `runner timed out after 300000ms` で失敗。**stderr 保持（`ce9df9b`）のおかげで原因が残っていた**:
      `[503 Service Unavailable] ... models/gemini-3.5-flash:generateContent`。
      Gemini 側の一時障害である。約20分後に同じ model へ probe したところ **200 で復帰**していた。

      **問題はここから**: provider が復帰しても、**run は既に `failed` 終端で attempt も 3/3**。
      誰も再実行しないので Task は止まったままになる。PL は不変条件6に従って
      「attempt を使い切った run を盲目的に再kickしない」ため、正しく Escalation へ倒れる
      （＝安全だが、外部要因が消えても自力復帰しない）。

      **つまり「一時的な外部障害」と「恒久的な失敗」を attempt 予算が区別していない。**
      transient 失敗で予算を使い切った run と、レビュー内容が原因で失敗した run が同じ終端になる。

      **着手時に確認すること（実装方針を先に決めない）**:
      - `geminiRouter` は既に `failureClass` を持つ（`transient` / `config-error` 等）。
        **この分類を run の終端理由まで伝播**できれば、transient 起因の終端だけを別扱いにできないか
      - 再実行の入口は既存のどれか（PL の `rekick_design_review` / startup recovery / 採用 API の冪等再実行）で
        足りるか。**新しい scheduler / watchdog を足さない**
      - 予算そのものを増やすのは筋が悪い（外部障害が長引けば同じことが起きる）。
        「transient 起因の失敗は attempt を消費しない」方が実態に合うか、実測で確かめる
      - PL に「transient 起因なら再kickしてよい」と判断させる場合、**PL の自己申告ではなく
        記録された `failureClass` を根拠にする**こと

<!-- roadmap:id=design-review-runner-production-timeout state=planned -->
2. [ ] **Design Review runner が本番経路でのみ 120s timeout する（Root Cause 未確定）** — 2026-09-14登録。
      **盲目的に re-kick しないこと**（CEO 指示）。

      **事象**: Project `bb509fee` の初回 Task で Design Review が attempt 1〜3 すべて
      `runner timed out after 120000ms` となり `failed` 終端。初回 Implement Job が作られず Task が進まない。

      **切り分け済み（すべて除外）**:
      - runner 自体は正常 — 手動実行で **10〜14秒 / exit 0** で実レビュー結果を返す（3回再現）
      - designText の長さではない — 本番と同一の 1331 字で **11秒**
      - `controlContextDir` の有無でもない — 付与して **10秒**
      - stdin の扱いではない — coordinator は `write()` 後に `end()` している
      - `repoRoot` / script パスでもない — API の実 cwd は `apps/api` で `repoRoot` は正しく解決され、
        runner も実在する（当初 MainPID の cwd を見て誤診しかけた）
      - `HOME` / credential でもない — API プロセスの `HOME=/home/ai-team`、CLI credential も存在
      - プロセスが起動していないのでもない — 再kick 時に runner プロセスの起動を実測

      ~~**未解明**: 上記を除外してなお、**spawn 経由でのみ 120s を超える**。手動では再現しない。~~
      **【2026-09-14 Root Cause 特定（production 実測）。仮説「spawn 経由でのみ遅い」は誤りだった】**

      **なぜ3回の調査で到達できなかったか**: `executeRunner()` が timeout 時に
      `stderr: undefined` として**捕捉済みの stderr を捨てていた**ため、DB に残る `error` は
      `runner timed out after 120000ms` だけだった。原因は記録から消えていた。

      **実測**: 同一入力・同一 spawn（`npx tsx designReviewRunner.ts`・同じ cwd・同じ制限 env）を
      API プロセスの外で走らせると **2.3 秒 / 15.4 秒 / 44.6 秒**とばらついた。44.6 秒の回の stderr は
      `[geminiRouter] attempt failed: provider=gemini_api ... failureClass=transient`。
      つまり**ばらつきは spawn 方法ではなく provider の transient 失敗と retry 待機**由来である。
      `geminiRouter` は `TRANSIENT_RETRY_DELAYS_MS = [10s, 30s]` を API 経路と CLI 経路で個別に消費し、
      **待機だけで最大 40 秒 × 2**、さらに Copilot fallback がある。**上限 120 秒はこれを収容していない。**

      **副次の欠陥（孤児化）**: timeout 中のプロセス木を production で直接観測したところ、runner の実体は
      `npx → npm exec → sh -c → tsx → node` と4段深く、**kill 後も末端の node 2つが生き残って
      systemd へ reparent されていた**。孤児は provider 接続を掴んだままなので、次の attempt の
      transient 失敗を増やす側に働く（旧調査の「runner 関連プロセス6件」と整合）。
      Linux 上で kill 意味論を直接検証: `kill(pid)` だと孫が生存、`kill(-pid)`（プロセスグループ）で回収。

      **対処済み（別 PR）**: timeout 理由へ stderr 末尾を添える / プロセスグループごと kill する /
      上限 120s→300s（API 経路の transient retry 1周を収容）。
      **残: worst case（CLI 経路の exec 120 秒 × 3 + Copilot fallback）は依然未収容。**
      これは caller の timeout を伸ばして解くのではなく、**runner 側の retry 予算を deadline で縛る**
      のが筋であり、本項目の後続作業として残す。新しい retry framework は作らない

      **2026-09-15 追記（担当境界）**: 本項目は「run が走っている最中」の予算の話に限る。
      **attempt 枯渇で終端した後の正式再審査**は `review-provider-exhausted-alternate-rereview`
      が持つ。どちらか一方だけでは 2026-09-14 の停止は解けない。
      （`geminiRouter` の既存 retry に上限を渡す形にする）。

      **関連**: 本件は `vps-pl-execution-loop` の production evidence でもある
      （VPS 上の PL が居れば検知・調査・復旧できたはず）。実際 2026-09-14 の実復旧 E2E では、
      PL がこの timeout を2回観測して「systemic な問題」と判断し CEO Escalation へ倒した。

<!-- roadmap:id=review-provider-exhausted-alternate-rereview state=planned priority=high -->
2. [ ] **Review provider が枯渇したとき、別 provider へ正式に再審査を依頼できるようにする** — 2026-09-15登録。
      **CEO 判断（2026-09-15）**: Review 要件の緩和は承認しない。Review を skip しない。
      既存 BLOCK を override しない。attempt を使い切った run を無理に再利用しない。
      **新しい正式 Review として実行し、結果は既存の API 側判定（`recomputeDecision()`）を通す。**

      **事象（production 実測 2026-09-14）**: Task `bd80c4ce`（Meta Reviewer structured-output
      robustness）の Design Review run `4032eec3` が 3/3 attempt を使い切って `failed` 終端。
      stderr に残っていた実際の原因は
      `[503 Service Unavailable] This model is currently experiencing high demand`（Gemini API）で、
      `geminiRouter` が `transient` と分類し、`metaReviewFallbackRouter` が
      **Copilot CLI へフォールバックしたところで runner が 300s deadline で kill された**。
      実装内容の問題ではなく provider 側の一時障害である（CEO 判断と実測が一致）。
      VPS PL は 3/3 を検出して **re-kick を拒否し CEO Escalation へ倒した**（設計どおり）。

      **既に存在するもの（作り直さない）**:
      - `createAndExecuteDesignReview()`（`designReviewCoordinator.ts`）— **新しい run を作り直す
        正式経路**。attempt 予算が新品になり、evidence 登録は `recomputeDecision()` を必ず通る。
        **production 実績あり**: 同日 Task `76ea5ff3` は run `944ce2e0` が 3/3 failed した後、
        新 run `d584882e` が succeeded して復旧している
      - `reviewWithProviderFallback()`（`metaReviewFallbackRouter.ts`）— run 内の provider 連鎖
      - `createReviewerAdapter('codex')` / `INDEPENDENT_REVIEWER_PROVIDER`（`strategicReview.ts`）—
        **契約済みの OpenAI レビュアー**。CRITICAL Independent Review で既に稼働している
      - `reviewSeparation.ts` — vendor 分離判定。**`copilot` は underlying vendor を特定できないため
        意図的に未登録**であり、独立性の根拠には使えない
      - `role-model-registry` — provider 候補表の置き場。**新しい Registry を作らない**
      - `plActionPolicy` / `actionGate` — PL の action 語彙と強制 Gate

      **不足している最小分（ここだけ補う）**:
      1. **PL に「新しい正式 Review run を作る」action が無い。** `rekick_design_review` は
         3/3 を正しく拒否するだけで、そこから先が無い。`PL_ACTION_KINDS` / `ACTION_GATE_TABLE` /
         `REQUIRED_TARGET_KIND` へ追加しないと、未知 kind は fail-closed で `forbidden` になる
      2. **新しい run に「どの provider で審査するか」を指定できない。** `DesignReviewRun` に
         provider 欄が無く、provider 選択は `strategicReview.ts` 内に固定されている
      3. **どの provider が実際に応答したかが DB に残らない。** `reviewWithProviderFallback()` は
         `providerUsed` を返すが、`strategicReview.ts` は `{ raw }` だけを取り出して捨てている
         （`autoReview.ts` は結果ファイルへ書いている）。**記録が無いと「別 provider で再審査した」
         ことを後から検証できない**（Design Philosophy 8: 効果検証可能性）。additive に持たせる

      **【2026-09-15 追記: provenance へ model を含める（CEO 指示）。アプリ追加要求の統合先】**
      アプリから追加された要求（Task `3d8878e9`「copilotのモデル指定」）は**本項目へ統合する**。
      新規項目は立てない。対象は**既存の Meta / Design Review fallback 経路のみ**とし、
      **Copilot を Independent Review の provider へ追加しない**（`ReviewerProvider` union は変えない）。

      上記 3 の記録内容へ**使用モデルを含める**: `providerUsed` に加えて **requested model**
      （どの model を指定したか）を残す。model の正本は `role-model-registry` であり、
      候補表を本項目へ二重に持たない。

      **actual model 用の別 field は作らない（実測に基づく判断・2026-09-15）**: production の
      `copilot` CLI 1.0.83 は未知・利用不可の model を `Error: Model "..." is not available.` /
      **exit 1** で拒否し、**silent fallback しない**（`--model definitely-not-a-real-model` で実測）。
      したがって exit 0 での完了自体が「指定 model が受理された」証跡になる。成功時の stdout に
      モデル名は出ないため、**確認できない値を field として持たない**。

      **model を確認できない場合は正常 review として扱わない**: 既存の fail-closed
      （非0 exit / 空応答 → `MetaReviewProviderError` → blocked）をそのまま使う。
      **新しい Gate も新しい失敗分類も追加しない。**

      **保存先（schema 変更なしで足りる見込み）**: `design_review_runs.result_json` は runner の
      stdout をそのまま保存している（`designReviewRunner.ts` の `JSON.stringify(result)` →
      `completeWithEvidence()`）。`strategicReview` の戻り値へ additive に足すだけで DB に残るため、
      **列追加より `result_json` への追記を優先する**（migration は API 起動時にしか走らず、
      deploy 順序の制約を増やすため）。

      **protected file を変更しない境界（CEO 指示・2026-09-15）**: `copilotRouter.ts` /
      `metaReviewFallbackRouter.ts` は変更しない。`providerUsed` は既に返っており（捨てているのは
      caller 側の `strategicReview.ts`）、requested model は `DEFAULT_COPILOT_META_REVIEW_MODEL` を
      **import して**記録できる。Registry 値と同定数が乖離した場合は fail-closed にし、既定値の drift を
      沈黙させない。**Registry が router 既定と別 model を要求する場合にだけ** protected 変更が要る。
      その最小案は `reviewWithProviderFallback()` へ optional な copilot model を1つ渡せるようにする
      additive 変更（既定は現状維持）であり、**必要性が実測で示されるまで行わない**。

      **維持する不変条件**:
      - **Review を skip しない / BLOCK を override しない / 3/3 の run を再利用しない。**
        必ず新しい run を作り、判定は既存の `recomputeDecision()` が再計算する
      - **独立性**: 代替レビュアーは生成担当と同一 vendor にしない。Task Design Review の
        implementer は `claude_code`（Anthropic）なので、代替先は Anthropic 以外。
        `copilot` は vendor 不明のため**独立レビュアーの根拠にはできない**
        （通常 Design Review の縮退先としては現状どおり使える）
      - **有界**: 代替 provider での再審査は固定回数まで。尽きたら CEO Escalation。
        provider を無限に巡回させない

      **やらないこと（明記）**: 新しい Gate / 新しい Review 工程 / 新しい retry framework /
      新しい従量課金 API 経路 / Dynamic Model Routing。

      **重複しない境界**:
      - `design-review-runner-production-timeout` が持つのは「**runner の retry 予算を deadline で
        縛る**」であり、run が走っている最中の話。**本項目は run が attempt 枯渇で終端した後**の
        正式再審査であり、別物。どちらか一方では今回の停止は解けない
      - `role-model-registry` が provider 候補表の正本。本項目はその**最初の実利用者**であり、
        表を二重に持たない。Registry 側の不変条件「生成担当と独立Review担当の provider 分離を
        表現でき、緩める設定を可能にしない」をそのまま使う
      - PL action の配線そのものは `vps-pl-execution-loop` の受け皿に載せる
      - `provider-outage-burns-attempt-budget` … **同じ provider のまま attempt 予算の数え方を直す**。
        本項目は予算を使い切って終端した後の話であり、別の層を担当する

<!-- roadmap:id=monitoring-tiering-watchdog-monitor-pl state=planned -->
3. [ ] **監視責務の段階分離（Deterministic Watchdog → Lightweight Monitor → VPS PL）— VPS PL 完成後の最適化** — 2026-09-14登録。
      **【着手条件（CEO 指示・2026-09-14）: `vps-pl-execution-loop` の最小実装と VPS 上の実運用 E2E が
      完了し、その実測データが出るまで着手しない。VPS PL 本体の実装より先に着手しない】**
      **今は設計・実装を深掘りしない。** 本項目は方針の記録であり、具体化は実測後に行う。

      **解く問題**: VPS PL を常時監視・単純な異常検知に使い続けると、高性能 PL のモデル枠が
      単純監視で消費され、一時的・既知の異常で不要な PL 起動が繰り返される。監視責務を段階分離し、
      PL を重要判断へ集中させる。

      **想定構造**:

      ```text
      Deterministic Watchdog / Rules → Lightweight Monitor → VPS PL → Mandatory Gate → 正式操作
      ```

      **Level 0: Watchdog / deterministic detection（AI 無しで判定できるもの）**
      Job / Task stall・timeout・retry exhausted・Worker 停止・quarantine・recovery failure・
      provider failure・Outbox 滞留・state inconsistency・containment 残留 等は、
      **既存 Watchdog・state・rule で検知する**。
      **新しい監視システムを重複して作らない。既存機構の改善を優先する。**
      既存の素材: `apps/worker/src/watchdog/watchdog.ts` + `stallDetector.ts`・`watchdog_events`・
      `supervised_runs`・`GET /api/state` の `attention` 配列・Outbox 滞留通知・quarantine state。

      **Level 1: Lightweight Monitor（一次分類・要約）**
      Watchdog event をすべて高性能 PL へ送らず、必要に応じて軽量 AI が次の4点だけを判定する:
      1. 通常の自動 retry / recovery 中なので待てばよいか
      2. 既知の一時エラーか
      3. VPS PL による判断が必要か
      4. PL へ渡すべき状態・ログは何か

      **原則として強い操作権限を持たせない**（read + 分類 + 要約に留め、実行は Level 2 の判断と
      Mandatory Gate を経る）。Copilot 等の比較的軽量な CLI provider を候補として評価するが、
      **特定 provider へ固定しない**（選択は `role-model-registry` の1エントリとして表現し、
      ここに別の provider 選択機構を作らない）。
      **注意（既存実装の制約）**: `resolveReviewVendor('copilot')` は underlying vendor 不明として
      `undefined` を返す（`packages/shared/src/reviewSeparation.ts`）。Level 1 の出力を
      **Review・独立性の証拠として扱わない**こと（分類・要約は Review ではない）。

      **Level 2: VPS PL（高性能な判断資源）**
      原因分析 / 複数状態の統合 / 仮説形成 / 追加調査 / 復旧方法選択 / Roadmap 判断 /
      CEO Escalation 判断。**理想的には常時監視ではなく、Watchdog / Monitor から必要時に
      呼び出される event-driven な責任者へ寄せる。**

      **目的**: 高性能 PL のモデル枠を単純監視に消費しない / PL を重要判断へ集中させる /
      一時的・既知の異常による不要な PL 起動を減らす / 24時間監視を低コスト・高安定で行う /
      Operator Chat・MCP からも同じ監視・PL 基盤を利用する。

      **共通基盤は VPS PL 本体と共有する（責務だけを分ける）**: 状態取得は
      `cross-project-state-api`（`GET /api/state`）、Control Interface は既存 write API、
      Gate は `mandatory-gate-policy`。**Monitor 専用の状態取得経路・操作経路・Gate を作らない。**

      **重複排除の棚卸し（新規項目は本1件のみ。他はすべて既存 owner のまま）**:

      | 既存項目 | 関係 | 判定 |
      |---|---|---|
      | `vps-pl-execution-loop` | Level 2 本体 | **本項目はその後続**。先に着手しない |
      | `cross-project-state-api` の `attention` 配列 | `job_blocked` / `workspace_quarantined` / `design_review_idle` / `task_ready_without_job` / `job_running_long` 等、Level 0 の観測出力そのもの | **既存で充足**。Level 0 用の別の検知面を作らない |
      | `pl-review-process-supervision`（#110） | `supervised_runs`・heartbeat（C-4）・supervisor 列・「監視の失敗を監視対象の失敗と誤認しない」（C-11） | **既存が owner**。#110 の「新しい watchdog / supervisor を追加しない」構造決定に従う |
      | `deleg-001-watchdog-respawn` | 既存 watchdog の欠陥修正 | **既存が owner**。Level 0 の「既存機構の改善を優先」の実例。本項目へ吸収しない |
      | `outbox-blocked-critical-false-alarm` | 正常系を CRITICAL と誤発報する = Level 0 の rule 精度問題 | **既存が owner**。本項目で重複して閾値調整しない |
      | `containment-success-path-observability` | containment 残留の可観測性 | `cross-project-state-api` へ**包含済み**（当該項目に記載） |
      | Quota Policy / provider fallback（本ファイル冒頭の Review Orchestration 表） | provider failure 時の挙動（wait / handoff_fallback） | **既存が owner**。検知は Level 0、fallback 実行は既存経路。新しい fallback 機構を作らない |
      | `role-model-registry` | Level 1 の provider / model 選択 | **既存が owner**。Registry の1エントリとして表現する |
      | `failure-explanation-pregeneration` | 軽量 AI の既存実行経路（`aiExplain/cheapAiClient.ts` = OpenCode CLI） | **経路は再利用、責務は別**（Explainer は確定事実の説明、Monitor は一次分類）。当該項目の「4つ目の Explainer 実装を作らない」制約を継承する |
      | `project-auto-incident-pattern-improvement` | 反復インシデントの事後分析・改善提案 | **時間軸が違う**（事後分析 vs リアルタイム経路）ため統合しない。ただし「この機能自身が大量 token / LLM を消費しない」という当該項目の制約は本項目にも適用する |
      | `mandatory-gate-policy` | Monitor / PL いずれの提案も同じ Gate を通す | **既存が owner**。Monitor に強い操作権限を与えない不変条件は Gate 側で表現する |

      **具体化の前提（実測データを見てから決める論点）**: VPS PL の実運用後に次を再評価する。
      - PL が実際にどれくらいの頻度で起動するか
      - どの異常が rule だけで処理できるか（＝ Level 0 で閉じるか）
      - どこから軽量 AI が有効か
      - Monitor にどこまで操作を許可すべきか

      **効果検証可能性（Design Philosophy 8）**: 上記の再評価を可能にするため、
      `vps-pl-execution-loop` の実装時点で最低限、PL 起動1回ごとの trigger（どの Level 0 検知に
      由来するか）/ 起動結果（rule だけで足りた・PL 判断が必要だった・CEO Escalation）/
      検知から解消までの時間と、その間に自動 recovery が動いていたか、を後から集計できる状態にしておく。
      **本項目のための新しい telemetry 基盤は作らない**。既存の `watchdog_events` /
      `supervised_runs` / `audit_log` / `attention` で足りるかをまず確認する。

      **やらないこと（明記）**: 新しい監視 daemon / 新しい supervisor / 新しい Recovery subsystem /
      新しい通知基盤 / 新しいダッシュボード / Monitor 専用 DB。既存の改善で足りない場合のみ、
      その時点で不足を具体的に示してから検討する。

<!-- roadmap:id=chatgpt-mcp-inspect state=planned -->
1. [ ] **ChatGPT から AIteamOS を inspect / audit / explain できるようにする（MCP）** — 2026-09-14登録。
      **【制約: 従量課金APIを新しい標準経路にしない（CEO 指示・2026-09-14）】**
      AIteamOS 側が ChatGPT との接続のために **OpenAI API を呼ぶ構造を前提にしない**。
      MCP は `ChatGPT → MCP → AIteamOS Control / State Interface` の**接続口**に徹し、
      推論は接続元（ChatGPT 自身）の契約で行われる。
      深い分析・判断が必要な場合は、Control Interface から**既存の PL / Role 実行経路へ渡し**、
      契約済み CLI（`AiCliProvider`: claude_code / codex / gemini / copilot）を利用する。

      **MCP 導入そのものを目的にしない。** 目的は ChatGPT から AIteamOS の状態を理解・監査できること。

      **前提**: `cross-project-state-api`（上記0番）。**同項目が read 側の唯一の入口**であり、
      MCP はその薄い adapter に徹する。**新しい Control subsystem・新しい state 収集系は作らない。**

      **Phase 1（read 中心。ここから始める）**: Project / Roadmap / Task / Job 状態、blocked 理由、
      quarantine、retry / resume 状況、Review / Approval、Recovery / Watchdog、runtime progress、
      Finding / audit 情報を ChatGPT から読める状態にする。

      **Phase 2（既存 Gate で安全に実行可能な範囲のみ）**: resume / retry / recovery request。
      **既存 API をそのまま使う**（`POST /api/tasks/:id/resume`・
      `PATCH /api/jobs/:id/clear-quarantine` 等）。MCP 専用の resume / recovery 経路は作らない。
      Approval Gate・Permission Guard・quarantine の fail-closed は**一切迂回しない**。

      **今回実装しないもの**: 自由な write API / Gate を迂回する操作 / MCP 専用の state store /
      credential の MCP 側保持。

      **関連**: `operator-chat-mobile`（同じ interface を Mobile 側から使う）。
      **両者で別々の操作システムを作らない**（CEO 指示・2026-09-14）。

<!-- roadmap:id=operator-chat-mobile state=planned -->
2. [ ] **Mobile 内の運用指示窓口（Operator Chat）** — 2026-09-14登録。
      **【制約: 従量課金APIを新しい標準経路にしない（CEO 指示・2026-09-14）】**
      会話処理や PL への指示伝達のために、OpenAI API / Anthropic API 等の従量課金 API を
      **新たな標準経路として導入しない**。既存の provider abstraction と CLI 実行経路を再利用する。

      ```text
      Mobile Operator Chat
        → AIteamOS Control / State Interface
        → 既存 PL 実行経路
        → provider CLI
        → PL による調査・判断・説明・正式 Control 操作
      ```

      **万能 Chat Agent は作らない。** 例外対応・運用指示に絞る。

      **最初の目標**: 次の6問に答えられること。
      「なぜ止まっている？」「現在何が起きている？」「復旧可能？」「安全なら再開して」
      「CEO判断が必要？」「次に何をすればよい？」

      **前提**: `cross-project-state-api`。`chatgpt-mcp-inspect` と**同じ interface を消費する**。

      **再利用するもの（新規に作らない）**: 既存の Task / Job state、`resume`、Recovery、
      Approval、Watchdog、`audit_log`。**Chat 専用の Resume / Recovery 機構は作らない。**

      **PL Console（下記 deferred 4件）との関係**: 別物である。PL Console は「ベンダー非依存の
      PL 指示 UI」（LibreChat 等の評価・Gateway・Provider Adapter を含む重量級）で、本項目は
      **既存 Mobile app 内の運用窓口**という軽量な範囲に限る。**PL Console 4件は deferred のまま
      据え置き、本項目で reopen しない。** 本項目で運用上十分と判明した場合、PL Console の要否を
      改めて判断する。

      **Explainer との関係**: 回答文の平易化は `failure-explanation-pregeneration`（Explainer 責務）
      が担う。本項目は**事実の取得と、既存の安全な操作の呼び出し**に徹する。

<!-- roadmap:id=failed-job-produces-no-attention state=done -->
3. [x] **`failed` な Job は `attention` に出ないため、Task が止まったまま PL から見えない** —
      2026-09-15登録（移管直後の実測）。

      **【2026-09-15 実装済み】** 未完了 Task に **動かせる Job（queued / running / blocked）が1つも無く、
      quarantine でない failed Job が残っている**場合だけ `job_failed` として attention に出す。
      done な Task の failed、後続 Job がある failed、quarantine 済みの failed は**出さない**（履歴は totals に残る）。
      「最新 Job が failed か」を createdAt 順で判定する案は、同一ミリ秒の Job で順序が曖昧になり
      実際に回帰テストが落ちたため採らなかった。
      PL 側は本 kind を actionable に含める。**executor はまだ無い**ので、PL は Diagnose して操作を
      提案するが Gate（根拠不足）で止まり、試行上限で CEO へ Escalation する。
      止まったことが人へ確実に伝わる状態までが本項目の範囲であり、
      **PL に復旧操作そのものを許すかは権限の問題**として `pl-autonomous-roadmap-adoption` と同様に別途扱う。

      **実測**: VPS へ移管した直後、VPS 自身が採用済み Task の implement Job を実行し、
      provider（`claude_code`）が timeout して Job は `failed`（`{"kind":"provider_timeout",
      "workspaceState":"changed"}`）。この結果:
      - Task は `pending` / `roadmapActive` のまま、初回 Job は**既に存在する**ので
        `createInitialImplementWorkflow()` は `initial workflow job already exists` で skip する
        → **誰も再試行しない**
      - `task_ready_without_job` は「Job が無い」条件なので**出ない**
      - `buildSystemState()` の attention 種別に **`failed` は無い**（`job_blocked` /
        `workspace_quarantined` / `job_running_long` 等のみ）→ **PL からは何も見えない**
      - Candidate workspace には当該 Job の変更が2件残る（`autoReview.ts` 変更 +
        `autoReview.test.ts` 未追跡）。**allowedPaths 内に収まっており**、
        `implementationScope` は意図どおり働いた（前回は5ファイルが範囲外だった）

      **つまり「静かに止まる」形が1つ残っている。** これは `vps-pl-execution-loop` が潰したはずの
      失敗モードそのもの（外部が気付くまで誰も再開しない）であり、移管後の自律性を直接損なう。

      **着手時に確認すること（実装方針を先に決めない）**:
      - `failed` を一律 attention にすると、履歴上の失敗（既に別 Job で解決済み・Task が done 等）まで
        鳴り続ける。**「その Task の最新 Job が failed で、後続 Job が無く、Task が未完了」**のような
        条件で絞れるか。`done な Task の blocked Job` と同じ構図なので同じ判定を使えないか
      - 復旧操作は既存のどれか（resume / retry / repair）で足りるか。**新しい Recovery 機構を作らない**
      - PL に実行させるなら必要 Gate は何か。workspace を書き換える操作なので
        `rekick_design_review` の理屈（無 Gate）は**適用しない**
      - 残った dirty をどう扱うか。**曖昧な変更の自動削除はしない**という既存方針は維持する
        （本件の dirty は失敗 Job の `changed_files` に記録済みで帰属は明確）

<!-- roadmap:id=pl-autonomous-roadmap-adoption state=done -->
4. [x] **PL が次の Roadmap 項目を自分で選んで採用できるようにする（自律ループの最後の外部依存）** —
      2026-09-15登録。**本線を VPS へ移管した時点で判明した最大のギャップ。**

      **【2026-09-15 実装済み】** PL が手の空いた Project へ次項目を採用できるようにした。
      設計・実装・独立レビューはすべて外部セッションで行い、**VPS PL 自身には実装させていない**。

      許可の与え方:
      - `strategic_alignment_review` は**残したまま検証可能にした**。根拠は PL の自己申告ではなく、
        その id が CEO 承認済み ledger に**未完了で実在すること**（seam が信頼できるファイルを自分で読む。
        **呼び出し側から ledger 本文を受け取らない**ので、PL が根拠を偽造できない）
      - `design_review` は up-front 要件から外した。**迂回ではない**: 採用操作の内側で必ず実行され、
        ALIGNED で evidence が登録されない限り implement Job は作られない。up-front に要求すると
        「まだ存在しない Task の evidence」を求めることになり構造的に充足不能だった
      - PL が具体化する allowedPaths は **seam が機械的に検証**する（repository-relative /
        2セグメント以上 / `..` 不可）。広い宣言で File Change Guard を骨抜きにできない
      - 採用は attention が1件も無いときだけ行う（止まっているものを放置して仕事を増やさない）。
        同一 Project への採用試行は2回で打ち切り、以降は再試行ではなく CEO Escalation

      **Gate bypass も PL の自己権限変更も行っていない。** 判定は従来どおり  を通る。

      **問題**: VPS PL は採用済み Task の停滞を復旧できるが、**Task が完了した後に次の項目を採用できない**。
      `adopt_roadmap_item` は語彙にあるが `strategic_alignment_review` + `design_review` を要求し、
      両者は `UNVERIFIABLE_GATES` なので **PL からは実行不能**（fail-closed として正しい）。
      結果として、1 Task 終わるごとに外部セッションが採用 API を叩く必要がある。
      CEO 方針「CEO が毎回次 Task を指定する運用へ戻さない」を満たすには、ここが要る。

      **これは Authority 変更である。** 採用は「Project に新しいスコープを約束する」操作であり、
      PL に与えてよいかは**CEO 判断**。実装も、PL が自分の権限を広げるコードを自分で書く形にしない
      （`change_own_permission` が禁止されている趣旨に反する）。**外部セッション + Independent Review** で行う。

      **着手前に決めること（実装方針を先に決めない）**:
      - 採用に必要な Gate をどう検証可能にするか。`strategic_alignment_review` を人が承認する
        代わりに、**ledger 側の既存情報**（CEO が確定した優先順位表・依存関係）で機械的に満たせないか
      - PL が選べる範囲を絞るか（例: CEO が承認済みの優先順位表の上位 N 件からのみ）
      - `allowedPaths` / `acceptanceCriteria` / `implementationScope` を PL が決めてよいか。
        これらは File Change Guard の効き目そのものなので、**PL の自己申告で緩まない形**が要る
      - 失敗時の扱い（採用したが design review が CONFLICT を返した場合）

      **やらないこと**: 新しい Gate・新しい Review 工程・PL 専用の採用経路。
      既存 `POST /api/projects/:id/roadmap-adoptions` と `authorizePlAction()` の上に載せる。

<!-- roadmap:id=mobile-push-ceo-escalation state=planned -->
3. [ ] **CEO Escalation を AIteamOS Mobile Push で届ける（将来の正式第一通知チャネル）** —
      2026-09-14登録（CEO 方針）。
      **着手条件**: `vps-pl-execution-loop` の完成後。**本項目のために VPS PL 最小実装・
      Mandatory Gate・Operational E2E を止めない。** 着手順は CEO の列挙順をそのまま固定優先順位に
      せず、`operator-chat-mobile` / `chatgpt-mcp-inspect` / `monitoring-tiering-watchdog-monitor-pl`
      との依存・Safety・Leverage を **PL が再評価して決める**。

      **棚卸し結果（新規基盤が要ると確認した。重複は無い）**:
      - `apps/mobile/package.json` に `expo-notifications` 等の通知依存は**無く**、push token 取得・
        permission 要求・通知ハンドラの実装も**無い**（grep 0 件）。よって FCM / APNs /
        device token 管理 / permission 管理は新規に要る
      - **deep link は素地がある**: `app.json` の `scheme: "ai-dev-team"` と Expo Router の既存ルート
        （`/tasks` `/approvals` `/projects` `/create`）。deep link 基盤を新設する前にこれを使う
      - 既存 Roadmap に push / 通知基盤の項目は**無い**。`notifier.ts`（Phase 1 の「通知ルーター」）は
        LINE / Slack のチャネル実装であって Mobile Push ではない

      **目標構造（Push 専用の Escalation ロジックを作らない）**:

      ```text
      VPS PL → CEO Escalation → 既存 notifier / alert 経路 → AIteamOS Mobile Push
             → 通知タップ → 対象 Project / Task / Incident / Approval / Operator Chat を直接開く
      ```

      **Source of Truth は既存の CEO Escalation / notifier** であり、Push はその送信先を1つ増やす
      だけにする。判断・分類・宛先決定・状態取得を Push 側へ重複実装しない。

      **通知内容の最低要件**: 何が起きたか / 対象 Project・Task / CEO 判断が必要か / 緊急度 /
      アプリ内で確認すべき場所。将来 Operator Chat・Approval・Incident 画面が整ったときに
      その画面へ deep link できる構造を考慮しておく。

      **LINE / Slack の位置づけ**: **正式な操作画面にはしない。** VPS PL 完成までの bootstrap 通知 /
      将来の fallback / 冗長通知として利用可能にする。Mobile Push 稼働後はアプリ通知を第一経路とする。

      **やらないこと**: Push 専用の Escalation 判定 / 新しい通知 Source of Truth /
      Push 専用の状態取得経路 / 既存 `sendAlert()` と並立する2つ目の通知経路。

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

## Safety / Approval 設計原則の未充足層（2026-09-17 実測）

**上位原則**: `specs/22_safety_approval_design_principle.md`（2026-09-17 CEO 採用）。
同原則 2 章の 8 層防御を現行実装へ突き合わせ、実測した結果が下表である。
**推測ではなく、各ファイルを実際に読んで確認した**（Q2 の 0/4 は `apps/` + `packages/shared/` 全体への
grep が 0 件であることによる）。

| 層 | 状態 | 根拠 |
|---|---|---|
| 1 Isolation | **実装済み・配線済み** | `runContainedOrThrow`（cgroup v2）/ `isInsideTargetRoot()` / `buildTargetCommandEnv()` |
| 2 Simulation / Preflight | **部分的** | `dryRun` は `adapter.ts` で `exitCode:0` を返して**実行を飛ばすだけ**。diff を作らず Gate にも当てない |
| 3 Mechanical Validation | **実装済み・配線済み** | `runMechanicalGate` / `MECHANICAL_GATE_PATTERNS` / `runPolicyGuard` / `runRiskReview` |
| 4 Independent Multi-Model Review | **実装済み・配線済み** | `isGeneratorSeparatedFromFinalReviewer()` / `runIndependentReview` |
| 5 Test / E2E | **実装済み**（CI 強制は本 checkout では未確認。`.github/workflows/` が無い） | worker の `typecheck` / `test` / `lint` gated command |
| 6 Limited Rollout | **部分的** | `deployCanary.ts` は reviewer 経路の単発チェック。feature flag / 段階配信は無い |
| 7 Runtime Monitoring | **実装済み・配線済み** | `startWatchdog()` / `checkStall()` / `watchdogEvents` |
| 8 Fast Rollback / Recovery | **実装済み・配線済み** | `revertBlockedJobChanges()` / `rollbackInfo.rollbackArgv` / `rollback_commit` gate |
| （原則 8 章）実行前の Recoverability 確認 | **無い** | `rollbackInfo` は commit **後**に記録される。`authorizePlAction()` は「rollback path が存在するか」を一度も見ない |
| （原則 11 章）事故→Learning | **部分的** | Incident DB と Context Pack 同梱まで。test / prompt / classifier を自動で更新する経路は無い |

**Risk の 5 次元（原則 3 章）**: `blast radius` / `detectability` / `recoverability` / `irreversibility` は
**4 つとも実入力として存在しない**（型・フィールド・概念のいずれとしても 0 件）。
現行分類器の入力は changed files のパス文字列・diff パターン・ファイル数・action kind enum のみである。
この不足の解消は `review-class-b-enhanced-ai-review` の scope に含めた（同項目の「上位原則」節を参照）。

**事故→Learning は `project-auto-incident-pattern-improvement`（planned）が担当する。**
本セクションでは重複登録しない。

<!-- roadmap:id=recoverability-precheck-before-risky-change state=deferred -->
1. [ ] **高リスク変更の実行前に rollback path の存在を確認する** — 2026-09-17登録。
      `specs/22_safety_approval_design_principle.md` 8 章。**現状は「壊れたら戻せます」が誰にも検証されていない。**

      **実測（2026-09-17）**: `rollbackInfo`（`previousCommitHash` / `rollbackArgv`）は
      `jobRunner.ts` が **commit した後**に記録する。`authorizePlAction()` / `resolvePlActionPolicy()` は
      evidence と approval の有無しか見ず、「この操作に戻り道があるか」を入力に持たない。

      **最小変更の方向**: 新しい Gate を足さない。`resolvePlActionPolicy()` の入力へ
      「rollback path が判明しているか」の**機械的事実**を足し、判明しない操作を安全側へ倒す。
      rollback 可能性を Reviewer / PL の自己申告で埋めない（同原則 7 章）。

      **着手前に確認すること**: `rollback_commit` が既に CEO gate である以上、
      本項目が実際に減らすリスクは何かを先に言語化する。名前を言えない失敗のために制約を足さない
      （`specs/21` standard-design-frame）。

<!-- roadmap:id=dry-run-does-not-simulate state=deferred -->
2. [ ] **dry-run が「実行を飛ばす」だけで simulation になっていない** — 2026-09-17登録。
      `specs/22_safety_approval_design_principle.md` 2 章 第2層。

      **実測（2026-09-17）**: `apps/worker/src/aiCli/adapter.ts:420` で `request.dryRun` は
      `exitCode: 0` / `changedFiles: []` を即返す。**diff を生成せず、Gate にも Review にも当たらない。**
      したがって現状の dry-run は「変更を適用せずに危険性を測る」用途に使えない。

      **着手前に確認すること**: simulation が本当に要るのは Candidate が使えない場面だけではないか。
      Candidate clone 上での実行が既に第2層を満たしているなら、本項目は不要になり得る。
      **不要だと分かったら closed にする**（新しい実行モードを増やさないこと）。

<!-- roadmap:id=staged-rollout-absent state=deferred -->
3. [ ] **段階投入（feature flag / canary / 段階配信）が無い** — 2026-09-17登録。
      `specs/22_safety_approval_design_principle.md` 4 章。

      **実測（2026-09-17）**: `deployCanary.ts` は deploy 後に reviewer 経路を1回叩く単発チェックであり、
      **製品の段階配信ではない**。feature flag も percentage rollout も存在しない（`flagger*` は 0 件）。

      **現状の段階は `Candidate → Stable` の2段だけである。** 外部顧客がまだ存在しないため、
      1% / 5% / 20% の段階配信は**現時点では過剰**である可能性が高い。
      **本項目は「顧客が存在する前に段階配信基盤を作る」ことを意味しない。**
      着手条件は、外部利用者または複数 Project の同時利用が実際に発生することとする。

---

## Principle 管理（Registry / 適用記録 / Review 統合）（2026-09-17 CEO 指示）

**CEO 指示（2026-09-17）**: 原則数が増えたため「毎回すべての原則を prompt へ貼る」方式をやめ、
Task / changedFiles / risk / Roadmap item から**関連する原則を機械的に選択**し、**既存 Review で
遵守確認**する。さらに適用履歴と Review 結果を蓄積し、**原則自体の品質改善**に使えるようにする。

### 着手前に必ず読むこと: 既に動いているもの（2026-09-17 実測）

**「contextual principle selection」は既に実装され、本番の prompt 経路で動いている。作り直さないこと。**
下表は推測ではなく、各ファイルを実際に読んで確認した。

| 要素 | 実体 | 状態 |
|---|---|---|
| 機械可読な原則本文 | `specs/21_outcome_oriented_generalization_principle.md` の `principle-id` / `principle-oneliner` マーカー | 稼働 |
| Registry loader | `packages/shared/src/engineeringPrinciples.ts`（`PrincipleSlug` 11 件 + 失敗を隠さない `ok:false`） | 稼働 |
| contextual selection | `selectPrincipleSlugs({ predictedFocuses, riskLevel })` | 稼働（下記 (1) の欠落あり） |
| changedFiles → 選択signal | `mapFileToFocuses()`（`apps/worker/src/approvalLevel/focusSelector.ts`） | 稼働 |
| prompt への注入 | `buildDesignContract()` → implement / resume / repair prompt | 稼働 |
| Review 側への原則提示 | `buildEngineeringPrincipleReviewGuidance()` → `buildFocusedOutputContract()` | 稼働（下記 (2) の欠落あり） |
| 判定語彙 | `StrategicDecision`（ALIGNED / CONFLICT / UNCERTAIN。`types/meta_review.ts`） | 稼働（focus 単位） |

**実測で判明した欠落**（4 つの `selectPrincipleSlugs()` 呼び出し箇所すべてと Review 側を読んで確認した）:

1. **`riskLevel` はどの呼び出し箇所からも渡されていない。** `RISK_PRINCIPLE_SLUGS`
   （medium / high / critical）は定義されているが **production では一度も効いていない**。
   `routes/tasks.ts:177` と `ctoAi/initialImplementWorkflow.ts:27` は `predictedFocuses` のみ、
   `routes/jobs.ts:314` と `designReview/repairPromptBuilder.ts:162` は**引数なし**（= core 原則だけ）。
   つまり repair prompt と `appendBaseDesignContract()` 経路には contextual selection が効いていない
2. ~~**Review 側は contextual selection を使っていない。**~~ → **2026-09-17 解消。**
   `buildFocusedOutputContract(selection)` が focus ごとの選択結果を受け取るようになり、
   固定 3 件ではなくなった（`buildEngineeringPrincipleReviewGuidance()` の
   finding category ヒント 3 件はそのまま残してある。役割が別なので削っていない）
3. ~~**原則単位の判定が存在しない。**~~ → **2026-09-17 解消。**
   `FocusedReviewResult.appliedPrinciples` / `IndependentReviewOutcome.appliedPrinciples` を追加。
   判定語彙は `StrategicDecision` を再利用し、第二の enum を作っていない
4. ~~**適用履歴が残らない。**~~ → **2026-09-17 解消。** `principle_applications` table を追加
5. **原則が 5 ファイルに散っており、機械可読なのは 1 つだけ。**
   `specs/21`（機械可読・id あり）/ `specs/00` 3.14〜3.18（`constitutionPrinciples.ts` が
   **章まるごと本文を貼る**。id も選択も無い）/ `specs/20` / `specs/22`（どちらも機械可読化されていない）/
   `CLAUDE.md` §3 Design Philosophy 8 件（機械が読まない）/
   `docs/project_memory/design_philosophy.md` 7 件（`alignmentChecker.ts` の `DESIGN_DOCS_PATHS` が読む側）
6. **`specs/21` は Roadmap に登録されていない。** PR #84 で item 無しに入り、
   同ファイル末尾の `home-and-criteria` が自ら完了条件
   （「full document を毎回貼るのではなく marker ID で選択されること」）を宣言しているのに、
   その達成を追跡する先が無かった。**本節がその追跡先である。**

### Source of Truth の決定（2026-09-17 CEO 指示。以後変更しない）

**原則本文・定義は Git が正本。DB を正本にしない。**
DB へ入れるのは**適用と判定の記録だけ**で、原則の定義（rule 本文・severity・カテゴリ）は入れない。
これは `supervised_runs` schema の D-2（「判定ロジックは DB に置かない。code 側 registry を引く
キーと版だけを保存する」）と同じ形であり、新しい方針ではない。

**二重正本を作らないこと。** 原則本文を DB・別 spec・Mobile 画面へコピーしない。
記録側が持つのは `principle_id` と **version/hash** だけであり、本文は Git から引く。

<!-- roadmap:id=principle-registry-and-compliance-ledger state=done -->
1. [x] **Principle Registry の一本化と、Review での原則単位の遵守判定・適用記録** — 2026-09-17登録・完了。
      **2026-09-17 CEO 承認のもと production へ deploy 済み（master `247d407`）。**
      下記「意図的に scope 外とした点」は、いずれも本項目の Acceptance Criteria ではない。

      **実装済み（このブランチ）**:
      - **Registry metadata の一般化** — 既存 marker 方式をそのまま拡張した。新しい Registry
        ファイルは作っていない。追加 marker は `principle-category` / `principle-scope` /
        `principle-tier` / `principle-tags` の 4 つで、**本文と同じ marker block に置く**ので
        metadata 専用の第二の正本ができない。`principle-tier` は必須で、欠けていたら
        黙って contextual へ倒さず `ok:false` で失敗する（core 原則が全 prompt から
        消えたことに誰も気づけない状態を作らない）
      - **core の二重正本を解消** — `BASE_PRINCIPLE_SLUGS`（TypeScript のハードコード配列）を廃止し、
        `corePrincipleSlugs()` が `principle-tier: core` marker から導出する
      - **版の導出** — `versionHash` を本文から算出（手書きの版番号を持たせない）。
        CRLF / LF のチェックアウト差では変わらない
      - **選択理由の構造化** — `selectPrinciples()` が `{ slug, versionHash, source, reason }` を返す。
        `selection_source` / `selection_reason` を記録側が後から作文しない
      - **Review 統合** — `buildFocusedOutputContract(selection)` に Applicable Principles を追加し、
        `appliedPrinciples` を出力契約と JSON schema へ入れた。Independent Review 側も
        `reviewerAdapter` の prompt / parse を同じ形で拡張した。**新しい Review workflow は作っていない**
      - **`principle_applications` table** — 列は CEO 指定の最小形。`reviewer` / provider / model /
        cost / prompt 全文は**持たない**（`review_run_id` から既存 review レコードを引ける）
      - **集計** — `GET /api/principles/stats`。既存 SQLite への集計 SQL のみ。
        新しい metrics backend も Dashboard も作っていない
      - **E2E** — 選択 → prompt → 原則単位判定 → DB 保存 → 集計 → センサー発火を
        `apps/api/src/principles/ledgerE2E.test.ts` で 1 本に通した（本番の coordinator を経由する）

      **設計上の不変条件（変更するときはここを読むこと）**:
      - **記録は Gate ではない。** `recordPrincipleApplications()` は例外を握って warn するだけで、
        Review の判定を変えない。計測を足したことが新しい停止要因になってはならない
      - **`appliedPrinciples` は required schema に入れない。** 原則判定が返らないことを
        review の失敗にしない（`meta-review-structured-output-robustness` が解消するまでの
        暫定ではなく、恒久的にこの方針とする）
      - **聞いたのに答えなかった原則は UNCERTAIN として残す。** 消すと適用数が実態より少なくなり、
        「一度も CONFLICT しない原則」という判断が甘く出る
      - **複数 focus が同じ原則を判定したら強い方（CONFLICT > UNCERTAIN > ALIGNED）を残す。**
        先勝ちにすると衝突を見逃す方向へ倒れる

      **Independent Review（Codex / 2026-09-17）で直した実欠陥**:
      初回実装は `changes_requested` だった。主張どおりでなかった点を直してある。
      - **独立 Reviewer の原則判定が捨てられていた** — `runIndependentReview()` が
        `ReviewerResult.appliedPrinciples` を `IndependentReviewOutcome` へ写していなかった。
        結果 independent stage の行が 1 件も入らず、**stage 間 disagreement が構造的に常に空**だった
      - **記録経路が Review を落とし得た** — `storage.tasks.findById` が ledger の try/catch の外
        にあり、そこで投げると Reviewer 実行後・run 終端前に抜けて run が running のまま残った。
        「記録は Gate ではない」という本項目の不変条件に反していた
      - **disagreement が stage 差を要求していなかった** — 同じ design stage の 2 回の run で
        判定が割れただけのものを不一致として数えていた（時間差であって reviewer 間の不一致ではない）
      - **捏造された原則 id を永続化できた** — runner の JSON を registry 照合なしで保存していた。
        ledger 側で registry に無い id を落とすようにした（信頼境界での検証）
      - **registry キャッシュが無期限だった** — spec を書き換えてもプロセス再起動まで
        古い tier と古い版 hash が使われ続けた。tier は prompt に載る原則を決めるので、
        「古い文章で判定して新しい版として記録する」ことが起き得た。mtime + size で invalidate する
      - **版 hash に tier が入っていなかった** — 文言を変えずに contextual → core へ上げると、
        contextual として集めた実績がそのまま core 降格センサーの根拠になった。tier も hash 入力に含めた
      - **センサーが版を跨いで数えていた** — 原則本文を書き換えても旧版の実績を引き継ぎ、
        **今は存在しない文章についての実績**で降格を提案し得た。センサーは現在の版の行だけを数える

      - **記録が fence の前だった** — claim を失った stale attempt の判定が先に入り、受理された
        attempt の判定が `INSERT OR IGNORE` に弾かれ得た。両分岐とも fence 成功後に記録する
      - **disagreement が run を跨いでいた** — 別々の Review で出た判定を不一致として数えていた。
        同一 run・同一版の中でだけ、stage ごとに畳んでから比べる
      - **版 hash の形式を検証していなかった** — `"x"` のような値でも記録でき、実在しない版の行が作れた
      - **run id 無しで記録できた** — 重複排除 index は `review_run_id IS NOT NULL` にしか効かないため、
        同じ結果を2回処理すると適用数が増えた。run id の無い記録は拒否する

      Independent Review は計4ラウンド実施し、最終ラウンドの指摘3件も解消して `approved` を得た。
      回帰テストは `apps/api/src/principles/independentReviewFindings.test.ts` に固定してある。

      **Independent Review で指摘され、直さずに受容した制約**（いずれも本項目の scope 外か既存事象）:
      - 候補パスの fallback が、壊れた primary を stale な secondary で覆い隠し得る。**既存挙動**。
        本番の探索順では最初の候補が存在するため現状は発現しない
      - `review_run_id` が NULL の行は重複排除されない。**現在の呼び出し元は必ず run.id を渡す**ので
        実害は無いが、将来 meta stage を繋ぐときに再確認すること
      - センサー発火の重複排除が check-then-insert で、`audit_log` に unique 制約が無い。
        API プロセスが複数になったら重複し得る（現在は単一プロセス）
      - `principle_applications` に保持期間が無い。件数が増えたときの集計コストは未測定
      - 版 hash は one-liner だけでなく本文全体を含む。prompt に出るのは one-liner なので、
        hash は「reviewer が見た bytes」ではなく**原則の版**を指す。意図どおりだが同一ではない
      **完了条件の充足（2026-09-17 CEO 指示の Acceptance Criteria）**:
      Registry / 選択 / 原則単位判定 / Design Review 統合 / Independent Review 統合 /
      DB 記録 / stats / stage 間 disagreement / センサー / 本番 migration / Operational E2E。
      production 実測の記録は
      `docs/project_memory/decisions/principle_management_design_2026_09_17.md` 15 章。
      - **本番 DB migration 実行済み。** 追加は `CREATE TABLE IF NOT EXISTS` と index のみで、
        `ALTER` も既存 table への破壊的変更も無く、API 再起動時に適用された。
        migration 前 backup は rotation 対象外へ退避済み（`pre_deploy_*.db`。
        `rotateBackups()` は `/^backup-.*\.db$/` にしか一致しないので、この命名は自然に除外される。
        **新しい backup system は作っていない**）。
        DB migration は現行方針どおり **Class C** のままであり、
        **merge / deploy の判断そのものが既存 CEO Gate にあたる**（CEO 指示 2026-09-17）。
        本件承認は DB migration 一般の Class B 化を意味しない
      - **センサーの発火実績が 0 件であることは完了を妨げない。** 確認したのは
        「閾値に達したら発火する経路が production に存在すること」であって、発火そのものではない。
        **「実際に 50 件溜まるまで待つ」ことを Acceptance Criteria にしない**（CEO 指示 2026-09-17）

      **意図的に scope 外とした点（本項目の完了を妨げない）**:
      - **`specs/00` 3.14〜3.18 / `specs/20` / `specs/22` / Design Philosophy は未移設。**
        意図的に `specs/21` の 11 件だけで通した。記録が実際に取れることを確かめてから範囲を広げる
        （`constitutionPrinciples.ts` は今も章まるごと本文を貼っている）。
        **2026-09-18 に `principle-registry-coverage-and-threshold-review` が owner として引き取った**
      - **`riskLevel` は Review 経路から渡していない。** Review 側が持つのは
        `reviewLoad`（レビューの認知負荷）であって `MetaRiskLevel`（変更のリスク）ではなく、
        **両者は別物なので読み替えなかった**。`selection_source='risk'` は
        実装 prompt 側の経路用に残っている。ここを埋めるなら
        `review-class-b-enhanced-ai-review` の Risk 5 次元と一緒に設計すること
      - **`review_stage='meta'` は schema 予約であって必須 scope ではない**
        （2026-09-17 に read-only で確定）。CEO の当初指示は「**既存 Review** で遵守確認する」で、
        接続先として選んだのは Design Review（`buildFocusedOutputContract()`）と
        Independent Review（`reviewerAdapter`）の 2 箇所である。meta stage は設計決定の時点で
        「意図的に実装しなかったもの」側にある（設計決定 13 章）。
        実装上も、GitHub Actions 側の Meta Review（`autoReview.ts` → `runner.ts`）は
        storage を一切 import しておらず、書き手を足すことは **CI 経路へ DB 依存を新設する**ことを意味する。
        現在 `'meta'` はどこからも書かれず、`buildPrincipleStats()` の stage 別内訳に 0 として出るだけである。
        **enum が未使用であること自体を理由に本項目を未完成扱いにしない。
        enum を使い切ること自体を目的にした配線もしない**（CEO 指示 2026-09-17）

<!-- roadmap:id=principle-quality-sensor-to-review state=done -->
2. [x] **原則自体の再Review候補を、適用記録から機械的に起こす** — 2026-09-17登録・完了。
      **2026-09-17 CEO 指示によりセンサー本体を実装し、production へ deploy 済み（master `247d407`）。**

      **CEO 指摘（2026-09-17）**: 当初この項目は `deferred` で登録していたが、
      `observation-closes-loop` の「50 件で core 継続を再評価する」という条件は
      **適用履歴が保存されないので 50 件到達を検出できない**状態だった。
      これは今回採用した原則そのものに反する。よって履歴・センサー部分を
      将来 TODO として `deferred` に置かず、Step 1 と同時に実装した。

      **実装済み（`apps/api/src/principles/ledger.ts`）**:
      - センサー1 `core-principle-never-conflicts`: core 原則について
        `applications >= 50 AND conflict = 0 AND uncertain = 0` で
        **core → contextual 降格の再Review候補**を発生させる
      - センサー2 `principle-review-not-discriminating`: 全体で
        `applications >= 200 AND conflict + uncertain = 0` のとき、
        **原則管理方式そのもの**の再Review候補を発生させる。
        「原則が完璧だから」と「Reviewer が原則を見ていないから」はこの数字だけでは
        区別できないので、自動で何も変えずに候補として出す
      - 評価タイミングは**記録直後**。新しい scheduler も cron も増やしていない。
        新しいデータが入った瞬間だけが評価の必要なタイミングなので、これで閉ループになる
      - 発火は `audit_log`（`entity_type='principle_sensor'`）へ **1 回だけ**記録する。
        ここは高頻度の多次元集計ではなく「このセンサーは発火済みか」という 1 entity の問い合わせなので、
        既存 `ix_audit_log_entity` にそのまま載る（適用記録を専用 table にした判断と矛盾しない）
      - **原則は自動で書き換えない。** 再評価を発火させるところまでが責務である（CEO 指示）

      **閾値は暫定値である（実データ 0 件の状態で決めたもの）**:
      - `50`: CEO が 2026-09-17 に指定。「1 つの原則について降格を議論するに足る回数」であり、
        観測された分布からの導出ではない
      - `200`: 上の 4 倍。core 原則が 4 件あるため「core 全件がそれぞれ降格閾値に達した規模」を
        機構全体の評価開始点にした。これも分布からの導出ではない
      - **変更するときは、変更後の値だけでなく「どの実測を見てそう決めたか」を併記すること。**
        定義と根拠は `PRINCIPLE_SENSOR_THRESHOLDS` の doc comment が正本

      **scope は「候補を機械的に起こすところまで」で充足している**（項目名のとおり）。
      候補の受け皿を Improvement Planner → CEO Proposal 経路へ繋ぐのは
      `project-auto-incident-pattern-improvement` の scope であり、**別の改善エンジンをここで作らない**。
      本項目が done になると誰も見に来なくなるので、**受け取り側（同項目の Improvement Planner）へ
      「`principle_sensor` を入力に含める」ことを明記した**。
      片側にだけ TODO を書き残す形にしない（`observation-closes-loop`）。

      **完了を妨げない既知の制約**:
      - **実データでの閾値見直しは未実施。** 50 / 200 は実データ 0 件の状態で決めた暫定値である。
        判定が 100 件以上溜まってから分布を見る。溜まる前に閾値を精密化しない。
        **暫定値であること自体は完了を妨げない**（CEO 指示 2026-09-17）。
        **2026-09-18 に `principle-registry-coverage-and-threshold-review` が owner として引き取った**
        （100 件到達で再評価 Review を発火させる sensor をそちらで実装する）
      - **production でセンサーが実際に発火した実績はまだ無い。** 確認したのは、
        閾値に達したら発火する経路が production に存在することである。
        **「実際に 50 件溜まるまで待つ」ことを Acceptance Criteria にしない**（同上）

<!-- roadmap:id=principle-registry-coverage-and-threshold-review state=planned priority=high -->
3. [ ] **Principle Registry の適用範囲拡張と、実データによる閾値の自己再評価** — 2026-09-18登録（CEO 指示）。
      `principle-registry-and-compliance-ledger` / `principle-quality-sensor-to-review` の後続項目。
      目的は「**本番稼働した Principle Management を、Principle Registry の適用範囲拡張と
      実データによる自己再評価まで閉じる**」こと。
      上記 2 項目が `done` になったことで **owner の無くなった残件 2 件をここへ引き取る**
      （`done` 項目の本文にしか書かれていない TODO を残さない — `observation-closes-loop`）。

      **CEO 追加指示（2026-09-18。本項目を VPS PL の自律開発へ回すにあたって）**:
      **本文と下記 Acceptance Criteria が Source of Truth である。** 会話ログではなくここを読むこと。

      - **実装順は Task B → Task A。** 先に Task B（100 件 threshold review sensor）を閉じ、
        そのあとで Task A（Registry coverage 拡張）へ進む。
        **Task B は 2026-09-18 に着地済みなので、残っているのは Task A だけである。**
        理由は、production に既に 38 件の application があり、**coverage を広げると
        application の増加速度が上がり得る**ため。観測範囲を広げる前に
        「100 件到達時に必ず再評価へ戻る」閉ループを先に完成させる
      - **既存機構を優先する。** `principle_applications` / `principle_sensor` / `audit_log` /
        `evaluateAndPersistSensors()` / `project-auto-incident-pattern-improvement` /
        既存 Principle Registry / contextual selection を再利用する。
        **新しい scheduler / monitoring backend / persistent state table / Principle system は作らない**
      - **100 件到達時に 50 / 200 を自動変更しない。** 実データを添えた再Review を発火するだけにする
      - **同じ threshold policy version では 1 回だけ発火させる。** policy を変更したときは再評価可能にする
      - **Principle を安易に core 化しない。** Task に応じて選択できるものは contextual を優先し、
        全 prompt への原則全文貼付を増やさない
      - **既存 `specs/21` の本文・tier を coverage 拡張のためだけに変更しない。**
        production で既に蓄積している 38 件の version-based 実績を不要にリセットしない
      - **Escalate 条件は 1 つだけ。** Safety / Authority Principle について、
        metadata・参照方法・prompt 投入方法の変更を**超えて**、原則の意味 /
        Safety Boundary / Authority / Gate policy を変更する必要が出た場合のみ CEO へ戻す。
        それ以外（大きな設計矛盾が無い限り）は、実装 → tests → Independent Review → merge まで
        **通常 Roadmap 開発として自律的に進めてよい**
      - **production で 100 件に実到達することは完了条件ではない。**
        sensor を fixture / E2E で検証できていればよい
      - **完了後に報告する項目**: Task B 結果 / Task A 結果 / sensor E2E /
        Registry coverage / prompt への影響 / `principle_applications` 記録 /
        Independent Review / merge SHA / 本 Roadmap item を done にしたか

      **現在の実装状態（2026-09-18 時点。着手前に必ずここを読むこと）**:
      - **Task B（100 件 threshold review sensor）は実装済み・merge 済み。** 再実装しない
      - **Task A（Principle Registry coverage 拡張）が残作業。** 本項目を採用したら Task A から始める
      - **`state` は `planned` のまま置いてある。** Task A が残っているので PL に採用させたいが、
        採用候補の allowlist は `planned` だけである（`isRoadmapItemAdoptable()`）。
        `in_progress` へ変えると**採用できなくなり Task A が止まる**ので、
        「半分終わったから」という理由で state を動かさないこと

      **作らないもの（先に読むこと）**:
      - 新しい Principle 管理 system
      - 原則本文の第二の正本（全文を別ファイルへコピーする等）
      - 新しい scheduler / monitoring backend
      - 新しい persistent state（下記「事前確認」で不要と確定済み）

      **Task A — Principle Registry coverage 拡張（残作業。ここから着手する）**

      対象候補: `specs/00` 3.14〜3.18 / `specs/20` / `specs/22` / Design Philosophy /
      `constitutionPrinciples.ts` の章全文 prompt 注入。

      目的は**既存 Principle の意味変更ではない**。
      「既存 Principle を現在の Registry 方式で**選択・Review・履歴保存・集計可能にする**」ことである。
      既存の Principle Registry / contextual selection / `principle_applications` を再利用する。

      - **本文と metadata の二重正本を作らない。** `specs/21` と同じく metadata marker を
        **本文と同じ marker block へ置く**方式を一般化できるなら、それを優先する
      - **`constitutionPrinciples.ts`**: 章全文を毎回 prompt へ貼る方式を、
        現在の Registry から Task に必要な Principle だけ選択する方式へ
        **置き換えられるかを優先して検討する**。全文を別ファイルへコピーして逃げない
      - **Safety / Authority Principle は特別扱いする。** metadata 付与・参照方式変更を超えて
        **意味・権限境界・Safety Policy を変更する必要が出たら CEO へ戻す**（CEO 指示 2026-09-18）。
        `specs/22` と `CLAUDE.md` 4 章の Zone 区分がここに含まれる
      - **`principle-tier` の付与は慎重に決める。** `corePrincipleSlugs()` は
        `principle-tier: core` marker から core を導出し、**core は全 prompt へ入る**。
        移設対象を安易に core にすると prompt が膨らみ、CEO が問題視した「毎回全文を貼る」へ戻る
      - **文書の Current Truth 修正とは別作業である。** `docs/project_memory/design_philosophy.md`
        の Design Philosophy #8 欠落と `specs/00` の章範囲表記の不一致は
        `governance-and-spec-docs-current-truth-sweep` が owner。
        **同じ行を二重に直さない**ので、着手前にそちらの状態を確認すること

      **Task B — 100 件到達で閾値を再評価する sensor（2026-09-18 実装済み・完了）**

      **実装済みなので再実装しないこと。** 入っているものは以下である。

      - `PrincipleSensorId` に `threshold-policy-needs-real-data-review` を追加。
        発火条件は「現在の版の適用が `THRESHOLD_REVIEW_MIN_APPLICATIONS`(=100) 件以上」だけで、
        **50 / 200 センサーと違い「一度も CONFLICT していない」を条件にしない**
        （見たいのは閾値が実態に合っているかであって、判定が割れたかどうかではない）
      - `PRINCIPLE_SENSOR_THRESHOLDS` に `THRESHOLD_REVIEW_MIN_APPLICATIONS: 100` を追加
      - `thresholdPolicyVersion()` — 閾値の**値**から導出する 16 桁 hash。
        版へ入るのは `THRESHOLD_POLICY_SLOTS`（`Record<keyof typeof PRINCIPLE_SENSOR_THRESHOLDS, string>`）
        の**固定 slot 名**であって TypeScript の property 名ではないので、
        **定数を改名しても版は動かない**（改名すると型が合わずコンパイルで気づく）。
        `Record` なので閾値を足したら slot 名を必ず決めることになり、表からの取りこぼしが起きない。
        どれか 1 つでも**値**を変えれば別 policy になる
      - `sensorEntityId()` が `policyVersion` を持つ finding にだけ版を足す
        （`<sensorId>:<principleId|all>:<policyVersion>`）。持たないセンサーの id は従来のままなので、
        **既存の発火記録は無効化されない**
      - `PrincipleThresholdReviewInput` — 再評価 Review が見る実測値（適用数 / ALIGNED・CONFLICT・
        UNCERTAIN 率 / disagreement 率と分母 / 現在の閾値 / 50 件・200 件センサーの発火状況 /
        原則ごとの適用数と割合 / 偏りの要約）。`audit_log.detail` へ**発火時点のスナップショット**として入る
      - `IPrincipleApplicationStorage.countStageComparisons()` — disagreement 率の分子と分母を
        1 箇所から返す。`findDisagreements()` と同じ grouping を共有するので率がずれない
      - 回帰テスト `apps/api/src/principles/thresholdReviewSensor.test.ts`（8 本）

      **新しい table / scheduler / persistent state は増やしていない。** 重複発火防止は
      既存 `audit_log` の `(entity_type='principle_sensor', entity_id)` だけで成立している。
      評価は従来どおり `recordPrincipleApplications()` の記録直後に走る。

      **受容した制約（2026-09-18 独立レビューで再指摘。直していない）**:
      重複排除は check-then-insert で `audit_log` に unique 制約が無い。ただし
      `evaluateAndPersistSensors()` も呼び出し元も `async` を含まず better-sqlite3 は同期なので、
      **1 プロセス内では検査と挿入の間に割り込めない**。破れるのは API を複数プロセスにしたときだけで、
      これは 3 センサー共通の前提であり、`principle-registry-and-compliance-ledger` で既に
      受容済みの制約である。ここだけ直すと全監査利用者が共有する `audit_log` へ制約を足すことになるため、
      **複数プロセス化を決めるときに audit_log 側で一度に扱う。**

      **閾値 policy 版は固定テストで守ってある。** `thresholdPolicyVersion()` の現在値
      （`14ed9fe6c13a805e`）をテストで pin してあるので、閾値以外の変更で版が動けば
      必ずテスト失敗として見える（版が動くと、既に 100 件超の環境では再評価がもう一度発火するため）。
      **意図して閾値を変えるときは、期待値の更新と同時に「どの実測を見てそう決めたか」を
      `PRINCIPLE_SENSOR_THRESHOLDS` の doc comment へ書くこと。**

      以下は実装時の設計根拠として残す。

      2026-09-18 時点の production の `principle_applications` は **38 件**。
      既存方針にある「100 件程度蓄積したら 50 / 200 の暫定閾値を実データで再評価する」を
      **文章だけの TODO にしない**。

      発火条件は `principle_applications >= 100` **かつ**
      「この threshold policy version について再評価 review が未実施」。
      発火先は既存経路のみ: `principle_sensor` → `audit_log` →
      `project-auto-incident-pattern-improvement` の Improvement Planner
      （受け取り側には既に「`principle_sensor` を入力に含める」と明記済み）。

      **閾値を自動変更してはならない**（CEO 指示）。発火するのは
      「閾値変更を検討する Review」だけである。再評価に載せるデータは最低限:
      Principle 別 application 数 / ALIGNED 率 / CONFLICT 率 / UNCERTAIN 率 /
      reviewer disagreement 率 / 50 件 sensor の発火状況 / 200 件 sensor の発火状況 /
      Principle ごとの適用偏り。

      **事前確認（2026-09-18 に read-only で実施済み。実装時に再調査しなくてよい）**:
      **既存の audit / sensor 記録だけで重複発火を防げる。新しい persistent state は要らない。**
      - `evaluateAndPersistSensors()`（`apps/api/src/principles/ledger.ts`）は
        `auditLog.findByEntity('principle_sensor', entityId)` に行があれば **skip する**。
        よって 101 件目・102 件目・103 件目で同じ Review は出ない
      - `entityId` は `sensorEntityId()` が `${sensorId}:${principleId ?? 'all'}` で作っている。
        ここへ **threshold policy version の片**を足せば、
        「この policy version については review 済み」を既存 index（`ix_audit_log_entity`）だけで判定できる。
        version は `PRINCIPLE_SENSOR_THRESHOLDS` の値から導出する（手書きの版番号を持たせない。
        `principleVersionHash` と同じ方針）。閾値を Git で変えたら別 id になり、再び 1 回だけ発火する
      - 評価は既に**記録直後**に走る（`recordPrincipleApplications()` 内）。**新しい scheduler は要らない**
      - `PrincipleSensorId` の union へ id を 1 つ足すのは型の変更であって persistent state ではない

      **既存 38 件をそのまま 100 件カウントへ使うための制約（見落としやすい）**:
      `currentVersionSensorInput()` は**現在の版 hash の行だけ**を数える。
      `principleVersionHash` は one-liner・本文全体・tier を入力に含むので、
      **`specs/21` の既存原則の本文や tier へ手を入れると、その原則の実績はゼロから数え直しになる**。
      Task A は既存 Principle の意味を変えない前提なので通常は問題にならないが、
      marker block を触るときはここを確認すること。
      やむを得ず数え直しになる場合は、**なぜリセットしたかを記録する**（黙って数字が戻らない状態を作らない）。

      **Acceptance Criteria**:
      - `specs/00` / `specs/20` / `specs/22` / Design Philosophy を棚卸しした
      - Registry へ統合可能な Principle を構造化した
      - **Principle 本文の意味変更が無い**（diff で示せる）
      - 不要な章全文 prompt 貼付を削減した
      - contextual selection から必要な Principle だけ取得できる
      - `principle_applications` へ履歴が保存される
      - 既存 38 件がそのまま 100 件カウントへ使われている
      - 100 件到達を機械的に検出する
      - 同一 episode で sensor が重複発火しない
      - 閾値を自動変更しない
      - Improvement Planner へ**既存経路で**戻る
      - `typecheck` / `tests` / `roadmap:check` が PASS

      **CEO へ戻す条件**: Safety / Authority の**意味**変更が必要になった場合、
      または新しい persistent state が必要になった場合**のみ**。
      それ以外は通常 Roadmap 開発として進めてよい（CEO 指示 2026-09-18）。

<!-- roadmap:id=independent-remediation-design-review-conflict state=in_progress -->
4. [~] **Design Review CONFLICT で止まった採用を、独立した flagship AI が作り直す（Independent Remediation）**
      — 2026-09-18登録・実装中（CEO 指示）。まず **task-kind Design Review = CONFLICT に限定する。
      全 Review 種別へ一気に広げない。**

      **事象（production 実測）**: `adopted-item-blocked-by-stale-deferral-text`（done）が記録した
      2026-09-15 の停止がこれである。PL が `task-allowed-paths-not-normalized` を自律採用した直後、
      task-kind Design Review が `CONFLICT` を返し、implement Job が 0 件のまま連続自律開発が
      2 件目で止まった。CONFLICT の根拠は 2 つあり、(1) 古い ledger 本文は PR #211 が解消したが、
      **(2) `scope_simplicity`「より軽い代替がある」は独立に残る**。
      同項目は「ledger 本文を書き換えて CONFLICT を消すのは **Binding Review の入力を外から操作して
      判定を覆す**ことに等しい」と明記しており、着手時確認事項に
      「採用時の `implementationScope` をより軽い案へ絞れば通るのか」を挙げていた。**本項目がそこを埋める。**

      **経路（2026-09-18 CEO 指示で段階化。Independent Remediation は最初の手段ではない）**:

      ```
      PL Task Design → 既存 Design Review → CONFLICT
        → Independent Critic（read-only。Spec も verdict も持たない）
        → PL revision / redesign（PL が Task Design の Owner）
        → 既存 Design Review
        → 再 CONFLICT → 次 Round の Critic → PL revision → 既存 Design Review
        → 解決しなければ Independent Remediation（flagship が Spec を直接再設計）
        → 既存 adoption seam → 既存 Design Review
        → それでも解決しなければ terminal
      ```

      **Critic が Review Finding 自体を具体的根拠付きで dispute した場合だけ**、
      frozen spec に対する `stage=challenge` へ**条件分岐**する（固定 stage ではない）。

      **stage machine は selector であって Review Pipeline を所有しない。**
      `selectConflictStage()` は既存 review state（`design_review_runs` /
      `design_review_evidence`）と既存 audit を観測して次の stage を返すだけで、
      Review 自体は既存経路が実行する。したがって `original_review` / `fresh_review` は
      stage ではなく**入力状態**である。実行する stage は
      `critic` / `pl_revision` / `challenge` / `remediation` / `terminal` の5つ。

      **Challenge の呼称を厳密にする。** これは
      **different-vendor independent re-review ではない**。`DesignReviewRun` に provider 欄が無く
      `strategicReview` が `providerUsed` を捨てているため、元 Design Reviewer の provider / model は
      **取得できず**、再評価側が別 vendor / model である保証も無い。よって
      「reviewer diversity 確認済み」「独立 reviewer による再審査」とは表現しない。
      audit には `orig_provider=unavailable` / `orig_model=unavailable` と明示する。
      不足している provenance の owner は `review-provider-exhausted-alternate-rereview` である
      （本項目では取り込まない）。**保証するのは「Critic の具体的な異議に基づく、同一 frozen
      Task Spec への once-per-(spec, finding) な fresh formal re-evaluation」まで。**

      **Challenge の安全条件（PASS reroll にしない）**:
      - 具体的根拠付きの dispute のみ発火。`grounds`（4種の列挙値）と `evidence` の両方が必須で、
        欠けていれば `insufficient_evidence` へ落として発火させない。単なる uncertainty や
        「別解もあり得る」では起こさない
      - **Binding Safety / Authority finding は Challenge 不可**。`safety_recovery` /
        `auth_permission` / `data_state_integrity` / `independent` / 未知 source は binding 側で、
        既存方針（Second Independent Review → Meta Review → 未解決なら CEO）へ渡す
      - Task Spec は変更せず **byte-identical** で再評価する
      - same spec + same finding につき **1回だけ**。消費は再評価の**前**に記録するので、
        途中で落ちても再抽選できない
      - 元の CONFLICT run / history は削除・上書きしない
      - `CONFLICT` / `UNCERTAIN` / `REVIEW_UNAVAILABLE` では release しない。
        ALIGNED evidence が出た場合のみ**既存 Job Gate** に従って進む（新しい override action は無い）

      **model diversity は Preference、authority separation は Safety Constraint**
      （CEO 指示 2026-09-18）:
      - Critic … 別 model → 別 vendor を優先するが、無ければ**同一 model を再利用してよい**。
        `selectCriticModel()` は**失敗を型として持たない**。Critic は Spec mutation authority も
        formal verdict authority も持たないので、diversity 不足を fail-closed 条件にしない
      - Remediation … flagship 固定。順位は 1) chain 未使用 → 2) その他 → 3) Critic 使用済み。
        **Critic と Remediator が同一 model でも許可する**（Critic は Spec を書かないので
        Task Design author ではない）。hard なのは author model / author vendor / judge vendor の
        分離だけで、`ok: false` はそれを満たす候補が1つも無いときにしか返らない

      **stage ごとに予算を分ける。** Critic Round は `PL_MAX_CRITIC_ROUNDS`、Remediation は
      `PL_MAX_REMEDIATION_ATTEMPTS`、Challenge は (spec, finding) ごとに1回。
      **`countRemediationAttempts()` が全行を数えていたため Critic Round が Remediation の予算を
      食い潰し、Remediation へ到達できなくなっていた**（integration test で検出・修正）。
      loop 側の二重計上防止は「この呼び出しで step が何か記録したか」という別の問いなので、
      stage を問わない `countConflictAttempts()` を使う。

      **権限（拡大していない）**:
      - **新しい PL action kind を作らない。** 使うのは既存 `adopt_roadmap_item`
        （必要 Gate は `strategic_alignment_review` のみ。既に許可済み）
      - **Remediation AI は Review 結果を解除・承認できない。** 提案を作るだけで、判定は従来どおり
        API 側 `recomputeDecision()` が再計算する
      - **PL は Binding Safety Review を override できないまま。** `PL_BLOCKED_RESPONSES` に override は
        無く、本項目も追加しない。行っているのは `fix` / `propose_alternative` を独立 AI に代行させること
      - ledger は CEO の正本なので AI が書き換えない。`abandon` 結論のときは採用せず既存 Escalation へ渡す
        （「実装しないで閉じる」state は作らない → `no-status-for-closing-a-task-without-implementing`）
      - `assertAdoptionScopeIsBounded()` / `ALWAYS_FORBIDDEN_PATTERNS` / ledger の `planned` allowlist は
        従来どおり効く。**Class C 項目は `deferred` なので本経路に乗らない**

      **却下済みテキストの再審査を拒否する（独立 Design Challenge が見つけた穴。対処済み）**:
      `checkImplementJobDesignReviewEvidence()` は `design_review_runs` を見ない。CONFLICT の run は
      evidence 行を作らないので Gate は `MISSING_DESIGN_REVIEW_EVIDENCE` で落ちる —— つまり
      **「prompt が変わったから fresh Review になる」のではない**。hash 束縛が防ぐのは
      「Review 後に prompt を書き換えて実行すること」であって、**同一テキストの再審査は防げない**。
      この repo では同一入力への判定が実行ごとに反転する実測があるため
      （`independent-review-verdict-instability`）、却下済みテキストをそのまま再提出できる設計は
      **判定の揺れで CONFLICT を洗浄する経路**になる。よって提案が作る implement prompt の hash が
      却下済み hash と一致したら **Review を走らせる前に拒否する**
      （`repairPolicy` の `requireDifferentApproach` と同じ趣旨）。

      **暫定 Model Policy**: `independentRemediationPolicy.ts` に flagship 候補表を 1 枚だけ置く
      （`gpt-5.6-sol` / `claude-opus-5`。どちらも 2026-09-07 production 実測済み）。
      **軽量モデルを候補に持たない**ので、品質未満へ自動 fallback する経路が構造的に存在しない。
      除外するのは (a) 提案を書いた側の vendor と (b) **この提案を判定することになる** Review の vendor。
      (b) により critical load では Codex independent review と衝突するので Anthropic 側へ切り替わる
      （自己承認の防止）。**実装者 `task.provider` は author に含めない** —— まだ 1 度も実行されておらず
      却下されたテキストを書いていないため、含めると critical load で候補が尽きて構造的不能になる。

      **独立性について、強制できる部分と確認できない部分を分ける（Independent Review 指摘への回答）**:
      - **model 単位の分離は常に強制する。** `authorModels` に PL の model
        （`CHEAP_AI_CONFIG.model`。識別子を複製せず設定を直接参照する）を渡すので、候補が
        それと同一なら選ばれない。「元の設計者へ解決案生成を戻さない」という要求の核はこれであり、
        vendor 解決の成否に依存しない。2回目以降は前回の Remediation 著者も audit の provenance から
        復元して除外する（Codex が自分の却下案を書き直す構成にならない）
      - **judge との vendor 分離も常に強制する。** critical load では Codex independent review が
        必須なので、そのとき Remediation は Anthropic 側へ切り替わる（自己承認の防止）
      - **PL 自身との vendor 分離だけは確認できない。** `opencode-go` は harness であり
        `reviewSeparation.ts` に**意図的に未登録**である。同モジュールは「識別子ではなく実際の
        underlying model/vendor を渡せる設計にしてから分離判定へ参加させること」と明記しているため、
        **識別子を vendor 表へ登録して分離を主張してはならない**。`unverified_separation=` として
        audit へ記録するだけにする

      **fail-closed（vendor 未解決なら Remediation しない）を選ばなかった理由**: PL の provider が
      harness である限りこの vendor は恒久的に解決しないため、fail-closed は「機構を作らない」のと
      同じ結果になり、CONFLICT の行き止まりが現状のまま残る。**構造的に充足不能な要求を Gate にしない**
      （`adopt_roadmap_item` から up-front の `design_review` を外したのと同じ判断）。
      PL の model を flagship 側へ上げる判断をした場合は、上記の model 単位の除外が自動で効く。

      **既存機構の再利用（新しい仕組みを作っていない）**:

      | 必要なもの | 再利用した既存機構 |
      |---|---|
      | 許可 | `authorizeAdoptionScope()`（`authorizePlAction('adopt_roadmap_item')` + `assertAdoptionScopeIsBounded()`）。採用と**同じ関数**へ寄せた |
      | Task 更新 | `adoptRoadmapItem()`。Job 0 件かつ pending は `syncRoadmapTasks()` の isUnstarted 分岐で spec が更新される（既存挙動） |
      | fresh Review | `ensureInitialWorkflowsForActiveTasks()` → `createInitialImplementWorkflow()` → `createAndExecuteDesignReview()` |
      | model 実行 | 既存 `createAiCliAdapter()`（`remediationRunner.ts` 経由）と既存 `executeRunner()` spawn |
      | vendor 分離 | `reviewSeparation.ts` の `resolveReviewVendor()` |
      | Finding 読み出し | `design_review_runs.result_json` |
      | 有界性・記録 | 既存 `audit_log` |

      **作っていないもの**: 新しい Review engine / Gate / TaskStatus / Roadmap state / provider stack /
      recovery subsystem / retry framework / テーブル。

      **重複しない境界（明記）**:
      - `design-review-conflict-recovery`（done）… **roadmap-kind 限定**の bounded 再生成
        （`ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS`）。task-kind には効かない。本項目が task-kind を担う
      - `review-provider-exhausted-alternate-rereview`（planned/high）… **Review が実行できなかった**
        場合（attempt 枯渇・provider 障害）に**別 provider へ同じ提案の再審査**を頼む。本項目は
        **Review が実行され CONFLICT と判定した**場合に**同じ topology へ別の提案**を出す。層が違う。
        本項目は run が `failed` の Task を対象にしない（そちらの担当である）
      - `roadmap-adoption-followups` (2) … `retryable` skip の再拾い上げ経路が無い問題。
        **本項目は直さない**（CONFLICT 以外は対象外）。run が `queued` / `running` の間は待つ。
        **2026-09-18 に production で 17 時間の停止として再発した**（同項目へ追記済み。#254）。
        症状は本項目とまったく同じ `task_ready_without_job` だが、**原因が違う** ——
        あちらは同じ design text が 2 回目の run で `ALIGNED` になっており、実質は transient な
        非 ALIGNED である。本項目の述語は `recomputeDecision()` を再計算して
        **`CONFLICT` だけ**を対象にするので、あのケースでは発火しない（発火させてはいけない ——
        提案は正しく、Review をもう一度回せば通るものだった）。
        **症状が同じなので取り違えやすい。どちらの経路が必要かは run の decision で判断する。**
      - `review-class-b-enhanced-ai-review`（deferred）… Class 判定は別軸。**依存させない。**
        本項目は Class 境界を 1 つも動かさない
      - `role-model-registry`（planned）… 候補表の最終的な owner。完成したら hardcode を廃止し
        `role = independent_remediation` / `minimum capability = flagship` /
        `vendor independence = required` を Router へ渡す形へ移行する。**候補表を二重に持たない**
      - `adoption-does-not-check-implementation-feasibility`（planned）… 採用も Review も通ったのに
        実装不能だった場合。CONFLICT ではない。将来 Remediation を応答手段として使える可能性はあるが、
        本項目の範囲外

      **実装済み**:
      - `packages/shared/src/independentRemediationPolicy.ts`（pure）… flagship 候補表、
        `selectRemediationModel()`（Safety Constraint と Preference を分離）、
        `selectCriticModel()`（**失敗を型に持たない** Preference のみ）、
        `reviewVisibleSpecKey()` / `isMateriallyDifferentSpec()`
      - `packages/shared/src/independentCriticPolicy.ts`（pure）… Critique schema（**Spec 欄も
        verdict 欄も持たない**）、`FINDING_ASSESSMENT_STATUSES`、`DISPUTE_GROUNDS`、
        Binding / advisory の exhaustive 分類、`shouldChallengeFinding()`
      - `apps/worker/scripts/remediationRunner.ts` … read-only sandbox の one-shot flagship runner。
        **Critic と Remediation が共有する**（名前は Remediation 由来のまま。命名上の負債として記録）
      - `apps/api/src/pl/remediationStep.ts` … Stage 3（既存実装を維持）。
        `applyRevisedSpec()` を PL revision と共有し、authorization + adoption 経路を二重に持たない
      - `apps/api/src/pl/conflictResolutionStep.ts` … `selectConflictStage()`（selector）、
        Critic Round、条件分岐の Challenge、PL revision
      - `apps/api/src/pl/executionLoop.ts` … 解決 Round への配線。
        **旧 direct-remediation 経路は残していない**（`remediate` hook も削除した）
      - `apps/api/src/pl/adoptionStep.ts` … `authorizeAdoptionScope()` 抽出
      - `apps/api/src/aiExplain/cheapAiClient.ts` … `CHEAP_AI_CONFIG` を export
        （PL の model 識別子を複製しないため）

      **`applyRevisedSpec()` の4つの値を混同しない**（独立レビューで2回間違えた箇所）:
      | 値 | 基礎 | 用途 |
      |---|---|---|
      | `rawScope` | 著者が書いた生の scope | 却下済みとの比較キーの材料 |
      | `submittedScope` | 判断記録を折り込んだ最終形 | 実際に採用・review される text |
      | `proposedHash` | `submittedScope` | Job Gate が計算する値と一致させ、Job identity を確認 |
      | `specKey` | `rawScope` | material difference の照合（記録追記で毎回変わる値は使えない） |
      `rawScope` は required input なので、取り違えは missing-field エラーになる。

      **Acceptance Criteria**:
      - CONFLICT で終端した run + Job 0 件 + pending の Task だけが対象になる
      - run が `queued` / `running` / `failed` の Task は対象にならない
      - 却下済みテキストと同一の提案は Review を走らせる前に拒否される
      - 広すぎる `allowedPaths` / ledger に無い項目 / `deferred` 項目は既存 Gate が弾く
      - 採用経路の `ok: true` を成功にせず、**Job の実在**だけを成功の根拠にする
      - `PL_MAX_REMEDIATION_ATTEMPTS` で有界。runner 失敗も試行として記録される
      - 既に CEO へ Escalate 済みの Task でも Remediation が走る（生涯キーで永久に塞がない）
      - provider / model / 除外 vendor / 未確認の分離相手 / hash が `audit_log` へ残る
      - `typecheck` / `tests` が PASS

      **効果検証可能性（Design Philosophy 8）**: `audit_log` の `pl_remediation` /
      `remediate:<taskId>` から「CONFLICT で止まった採用が何件あり、うち何件が Remediation で
      ALIGNED になり、何件が Escalation へ落ちたか」を後から数えられる。

      **Operational E2E**: production Task は既に手動復旧済みなので**同じ事故を再現しない**。
      fixture / isolated 環境で上記 Acceptance Criteria を固定し、**自然な CONFLICT が出た時に
      production E2E へ進む**。

<!-- roadmap:id=remediation-attempt-admission-not-atomic state=planned -->
5. [ ] **Remediation の試行受付が原子的でない（複数 API プロセス前提でのみ問題になる）** —
      2026-09-18登録（`independent-remediation-design-review-conflict` の Independent Review 指摘）。
      **本項目は Finding であり、いま実装しない。**

      **指摘（Codex independent review, changes_requested の項目5）**: Remediation の試行受付は
      `countRemediationAttempts()` で数えてから走らせる **count-then-run** であり、記録は
      長い model 呼び出しの**後**に行う。並行性の防御は `executionLoop.ts` の module スコープ変数
      `inFlight` だけで、これは**プロセスローカル**である。したがって API プロセスが2つ以上あれば
      上限を超えて同時に走り、同じ pending Task を上書きしうる。

      **現状で問題にならない理由（放置の根拠。実装を省いた言い訳ではない）**:
      - `executionLoop.ts` は「API は単一プロセス・単一スレッドなのでこれで足りる」と明記しており、
        既存の PL tick 全体（採用・診断・再kick）が同じ前提に乗っている。
        **本項目だけ別の前提で強化しても、隣の採用経路が同じ形のまま残る**
      - 二重採用そのものは既存機構が弾く: `syncRoadmapTasks()` は単一 transaction で
        `RoadmapTaskConflictError` を出し、Job は `ux_jobs_workflow_step_key` の全体一意 index で
        重複生成できない
      - 成果の誤報は**対処済み**。「Job が1件でもある」ではなく
        **この提案の prompt hash から作られた Job** だけを成功の根拠にした
        （別の試行が作った Job を自分の成果として報告しない）

      **着手時に確認すること（実装方針を先に決めない）**:
      - **単一プロセス前提をやめるかどうかが先。** やめないなら本項目は不要であり、
        やめるなら PL tick 全体（採用・診断・Remediation）を同時に扱う。本項目単独で
        claim table を1つ足すのは、**状態空間を増やして防御が1箇所だけ強い**という最悪の形になる
      - 強化するなら**既存 `claim_token` fencing の設計を踏襲する**
        （`design_review_runs` / `supervised_runs` が既に持っている）。**新しい fencing 方式を作らない**
      - `audit_log` は append-only で、admission の CAS には使えない。
        どこに claim を置くかは上記の判断の後で決める
      - 効果検証可能性（Design Philosophy 8）: 「上限を超えて Remediation が走った」件数を
        後から数えられること。数えられないなら強化の効果も判定できない

      **重複しない境界**: `project-workspace-isolation`（planned）は複数 Project の同時実行を扱う。
      本項目は**同一 Task に対する同一 role の同時実行**であり別物。ただし単一プロセス前提を
      やめる判断は共通なので、**着手する場合は同時に扱う**。

---

*Updated: 2026-09-17*
