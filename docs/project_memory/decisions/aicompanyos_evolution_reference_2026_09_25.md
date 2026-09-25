# AIcompanyOS への長期発展 — 設計参照と Roadmap 統合判断（2026-09-25）

**種別**: Decision History / Design Reference（実装指示ではない）
**対応する Roadmap 項目**: `company-state-foundation` / `organizational-learning` /
`cross-project-compounding` / `organizational-self-evolution`（いずれも `state=deferred`）
**本書の目的**: 数か月後に別の PL / Agent が上記項目を担当しても、
「なぜこの項目が存在するのか・何を既に決めて何をまだ決めていないのか」を再構築できるようにする。

**本書は Goal / Design Philosophy / Authority / Zone / Gate を1つも変更しない。**
本書は外部 OSS・外部サービスの採用も決定しない（6・7章）。

---

## 0. 本書の読み方（Source of Truth の分担）

| 知りたいこと | 正本 |
|---|---|
| 現在その項目に着手してよいか | `tasks/roadmap.md` の `state=`（`deferred` は PL の自律採用対象外。`isRoadmapItemAdoptable()` が機械強制） |
| 実装順序・着手条件 | `tasks/roadmap.md` の各項目本文 |
| なぜその項目があるか・外部から得た設計原則・未決事項 | **本書** |
| 将来の Core / Service Extension 構造、Knowledge Lifecycle、指標の分離 | `specs/13_future_system_architecture.md` 5b 章 |
| Safety / Approval の設計原則 | `specs/22_safety_approval_design_principle.md` |
| 反復判断の記録・sensor・Self-Evolution の既存最小形 | `specs/23_system_one_decision_layer.md` |
| AIteamOS と AIcompanyOS の責務境界 | `docs/project_memory/design_philosophy.md` 12（正本は Project レコード） |

本書と上記正本が食い違ったら**上記正本が優先**する。本書は判断材料であり、判断そのものではない。

---

## 1. AIcompanyOS target state

AIcompanyOS の価値は、Agent を長時間動かすことそのものではない。

> 交換可能な AI Worker を使いながら、**会社自身が**正本・経験・判断・結果・学習を所有し、
> Project を重ねるほど賢くなり、最終的には組織自身の仕事の仕方まで安全に改善し続けられること。

最終的に回すループ:

```text
Build → Launch → Operate → Observe → Decide → Experiment → Measure → Learn → Improve → Expand / Kill
```

### 1-1. Conceptual phase（整合確認用。repository の正式 schema ではない）

| Phase | 状態 | 対応（既存 / 今回登録） |
|---|---|---|
| 1 Execute | AI が Project を安全に最後まで進められる | 既存の本線（24h 自律稼働・Recovery・Gate・`project-workspace-isolation`） |
| 2 Operate | 完成後も継続運用できる | 既存の足場: `VPS App Runtime Standard v1`（`/health`・last-run）。Lifecycle 設計は `company-state-foundation` の設計課題 |
| 3 Learn | 運用結果・Decision・Experiment・Outcome を会社に蓄積できる | `company-state-foundation` → `organizational-learning` |
| 4 Improve | 蓄積データから Project および AI 組織を改善できる | 既存: `project-auto-incident-pattern-improvement`（AIteamOS 内部の改善提案）→ `organizational-self-evolution` |
| 5 Compound | Project 横断で Validated Learning が蓄積され、新 Project ほど強い状態から始まる | `cross-project-compounding` |

Phase 番号は本書だけの説明用であり、Roadmap の分類（`state=` と依存記述）を置き換えない。

### 1-2. 非交渉原則（今後の詳細設計でも維持する）

- **A. Company State must live outside the model/vendor.** Claude / GPT / Codex / Gemini 等の
  session・memory・runtime を会社の正本にしない。AI モデルは交換可能な Worker である。
  既存の正本: `specs/00_constitution.md` 3.7 Vendor Independence / 3.8 Knowledge First、
  `tasks/roadmap.md`「Execution Runtime Boundary」節の「正本は外部 Agent Platform へ移管しない」
  （判定基準: 外部 platform が使えなくなったとき「execution backend を交換する」だけで継続できるか）
- **B. Memory is not State. History is not Truth.** 次の4つを区別する。
  - Canonical State = 現在会社として正しい状態
  - History = 過去に何が起きたか
  - Memory / Learning = 過去経験から得た知識
  - Raw Evidence = 判断根拠となった一次情報

  過去に方針 B が100回使われていても現在の Canonical Policy が A なら A を優先する。
  **「新しい記録ほど正しい」「頻出する記録ほど正しい」というルールは採らない。**
  既存の同型パターン: `goal.md` / `design_philosophy.md` は View で正本は Project レコード
  （`CLAUDE.md` 7章）、Roadmap の可否は本文ではなく `state=` が正本（`tasks/roadmap.md` 冒頭）。
- **C. Proposal ≠ Promotion.** `Candidate → Evidence → Verification → Authorization → Promotion`。
  既存の Review / Independent Review / Approval Gate / Mandatory Gate / protected boundary /
  Stable・Candidate 昇格経路を再利用し、**同目的の第二の Governance system を作らない。**
- **D. Root Policy is outside self-evolution.** 次は通常の自己改善から変更不可とする方向で設計する:
  Company Goal / Purpose、CEO 所有の Design Philosophy、Approval boundary、permission escalation rule、
  protected resources、self-evolution evaluator そのもの、promotion authority、
  irreversible external action boundary、audit requirement。
  変更が必要なら既存の Human / CEO decision path を通す。
- **E. Specialist is allowed, Single Point of Failure is not.** 同じ Agent の長期担当は禁止しない。
  禁止するのは「その Agent / session が失われたら会社として仕事を継続できない」状態である。
  標準化するのは Agent 内部の思考方法ではなく、組織との境界
  （Input / Goal / Authority / Canonical State / Evidence / Output / Decision / Result / Handoff）。

---

## 2. Palantir（Foundry / Ontology / AIP）から得た設計原則

**Palantir への依存・互換実装は目的としない。** 採るのは考え方だけである。

| 概念 | 採用する原則 | AIteamOS / AIcompanyOS での対応 |
|---|---|---|
| Ontology | Data / Logic / Action / Security を共通の world model として扱い、**Agent の記憶ではなく Agent 外の Operational State を中心にする** | 原則 A・B。`company-state-foundation` |
| Action Log | 意思決定と action を、そのときの状態・理由（why）と共に **data として残し**、次の判断に使えるようにする | `Observation → Hypothesis → Decision → Action → Result` lineage（`company-state-foundation`） |
| Ontology Scenarios | main state を直接変更せず、fork した scenario で what-if を評価し、必要なら適用する | Secondary capability（5章）。`company-state-foundation` の後段設計課題として保持 |
| AIP Evolve | target / optimization goal / validation strategy / change limits を与え、Agent が改善候補を探索・検証し **proposal として出す**（自動適用しない） | `organizational-self-evolution` の Candidate 生成形。Promotion authority は持たせない |

---

## 3. LOGOS / Fujitsu Kozuchi MAAF から得た設計原則

### 3-1. LOGOS

| 原則 | 取り込み方 |
|---|---|
| **Proposal is not Promotion** | 原則 C。AIteamOS 既存の Stable / Candidate 昇格（PR → CI → verified SHA → `--ff-only` deploy）と Approval Gate をそのまま使う |
| versioned **Agent Packs**（agents / tools / knowledge / tests / permissions / policies を1単位で version 管理） | Agent 単体ではなく **Organization Version / Manifest** として追跡する方向（`organizational-self-evolution`）。**独自 VCS は作らず Git を使う** |
| auditable event traces | Company-level ID（`project_id` / `task_id` / `decision_id` / `experiment_id` / `organization_version`）から Agent trace へ辿れる構造。**Agent 内部ログ全体を Company DB へ複製しない** |
| fail-closed verification | 既存の fail-closed 方針（Gate / Review 不確定時の停止）を Self-Evolution の昇格判定にも適用する |
| 学習された prompt / memory / skill / tool / role / workflow は**最初は untrusted candidate** | Candidate は直ちに active にならない（`specs/23` 12章の candidate lifecycle と同型） |
| held-out execution evidence | 評価に使ったデータと別の holdout / replay / E2E で検証する |
| human-controlled policy / explicit authorization / irreversible action は Human Authority 側 | 原則 D |

**AIteamOS へ取り込むべき中核**: 既存 Governance を、Project の開発だけでなく
**AIteamOS 自身の自己改善にも適用する**という思想。

### 3-2. Fujitsu Kozuchi Multi AI Agent Framework（MAAF）

| 観点 | 取り込み方 |
|---|---|
| MAS の構築・運用・改善を1つの Lifecycle として扱う | 1章のループ |
| 実行履歴・human feedback から改善 Candidate を生成 | 既存 `project-auto-incident-pattern-improvement` の入力（Job 履歴・Review 結果・Approval 記録）を再利用 |
| 改善対象: prompt / skill / workflow / tool selection / role assignment | `organizational-self-evolution` の Candidate 対象 |
| Candidate を実行環境で検証し、有効な変更だけ反映 / 重要変更は human approval | 原則 C・D |
| successful pattern / failure reason / evaluation result / modification history を蓄積し他 Use Case へ展開 | `organizational-learning` → `cross-project-compounding` |

---

## 4. AIteamOS との gap（2026-09-25 時点の実測・read-only）

**「無い」と書く前に現行実装を確認した**（`specs/23` 0-1 の教訓）。既にあるものは作り直さない。

| 能力 | 既に在るもの | 無いもの（gap） |
|---|---|---|
| Company State | Project レコード（`goal` / `designPhilosophy` の正本）、`GET /api/state`（`cross-project-state-api`、read-only）、`audit_log`、`design_review_runs`、`principle_applications`、Roadmap `state=` 正本化 | Company / Portfolio / Metric / Capability / Decision / Experiment / Outcome の正本、`Decision → Action → Result` lineage、`audit_log.project_id`（`cross-project-state-api` の残作業）、Canonical / History の区別を機械的に表す規則、Organization Version |
| Operate | `VPS App Runtime Standard v1`（仕様のみ）、`project-auto-completion-detection`（done。完了は状態ではなく計算値） | 完成後 lifecycle（Launch / Operate / Observe / Expand / Kill）の設計 |
| Organizational Learning | `specs/13` 5b-5-1 Knowledge Lifecycle（設計のみ）、5b-6-1 指標体系の分離、5b-6-2 評価概念の分離、`docs/AI_TEAM_OS_DESIGN.md` 12 Learning Control（設計のみ）、`docs/project_memory/decisions/`（人手の Lessons） | 実装は無い（`specs/23` 12章: 2026-09-21 実測で対応する実装ファイル無し）。Business Outcome を Task / Deployment へ接続するデータ経路 |
| Cross-Project Compounding | 「Team Lesson の Company Lesson 昇格は Cross-domain validation を要する」（Roadmap「将来アーキテクチャ移行」）、`applicable_conditions`（5b-5-1） | 転用時の target-project 再検証、negative transfer 防止、実際に並走する第2 Project |
| Self-Evolution | Principle sensor の閉ループ最小形（`specs/23` 12章。原則本文は自動で書き換えず再 Review 候補を出して止まる）、Stable / Candidate 自己開発（Tier A 稼働、Tier B planned）、`role-model-registry`（planned） | Organization Version / Manifest、replay / holdout による Candidate 評価、`dry-run-does-not-simulate` / `staged-rollout-absent`（deferred） |

**責務境界上の未決事項（CEO 判断事項）**: `design_philosophy.md` 12 は
「AIteamOS は AIcompanyOS そのものにはならない」「AIcompanyOS の Business Management 責務を
先回りして AIteamOS へ取り込まない」と定める。したがって Company / Portfolio / Business Metric の
正本を**AIteamOS の DB 拡張として持つのか、AIteamOS の外側の AIcompanyOS 層として持つのか**は
Design Philosophy に関わる判断であり、`company-state-foundation` 着手前に CEO が決める。
本書はこの判断を先取りしない。

---

## 5. Secondary capability — Scenario / What-if

Canonical State を直接変えずに Strategy A / B・価格変更・resource allocation・workflow 変更等を
isolated state で比較する仕組み。Palantir Ontology Scenarios を設計参考とする。

- **独立 Roadmap 項目にしない。** 4 能力より優先しないため、`company-state-foundation` の後段設計課題として保持する
- 実行系の simulation は既存 `dry-run-does-not-simulate`（`specs/22` 2章 第2層）が owner。
  Business の what-if とは対象が違うので混ぜない
- 最初から Dolt 等の DB 切替を行わない。既存 DB で scenario / overlay / version snapshot を自然に表現できるならそちらを優先する

---

## 6. OSS / external infrastructure candidate map（**採用決定ではない**）

| 用途 | 調査時点の候補 | 位置づけ・前提 |
|---|---|---|
| Observability / Evaluation（trace / dataset / experiment / eval / prompt version / metrics） | Langfuse、OpenTelemetry | 既存 `audit_log` / `executionLogStore` / `observationLog.ts` / `principle_applications` で足りない場合のみ |
| Cross-project retrieval | **SQL first** → sqlite-vec → pgvector → Graphiti | Graphiti は temporal knowledge graph・provenance・superseded fact の将来候補。**初期段階で Graph DB を要求しない** |
| Self-improvement candidate generation | DSPy、GEPA、AFlow 等 | **Candidate generator としてのみ扱う。production promotion authority を与えない** |
| Durable runtime | Temporal、LangGraph 等 | 現行 Worker / Watchdog / Resume / Recovery と責務重複が大きい。現行実装で合理的に解決できる限り rewrite しない（「Execution Runtime Boundary」節の Harness 委譲候補と同じ扱い） |
| Policy engine | OPA 等 | 既存 Approval / Mandatory Gate / `allowedPaths` / File Change Guard で十分なら追加しない。**第二の Policy system を作らない** |
| Scenario data | Dolt 等 | 利用価値が明確になるまで採用しない |

---

## 7. 採用をまだ決めないもの / 今回意図的に採用しなかったもの

- 上表の OSS・managed service はいずれも**未採用**。外部サービス追加・課金は `CLAUDE.md` 4章 Yellow Zone
- Company Ontology engine、Palantir 互換システム、LOGOS のコピー実装
- Postgres への即時 migration、Graph DB 導入
- Temporal / LangGraph への runtime rewrite
- 新しい Policy engine
- Self-Evolution の production 実装
- Project `done` / 完了判定の意味の変更（`project-auto-completion-detection` の「状態を増やさず計算値にする」決着を維持）
- 固定の Business schema（Project 種類ごとに Metric は違うため、先に作り込まない）
- 独自 version-control system（Organization Version は Git を正本とする方向）
- Phase 番号の正式 schema 化

---

## 8. Implementation-time re-research requirement

各項目の着手時に、**必ず次の順で再調査する**（本書の候補リストを前提にしない）:

1. 既存 AIteamOS 機能で実現できるか（`audit_log` / `principle_applications` / `design_review_runs` / Project レコード / 既存 Gate / 既存 Review / Stable・Candidate 経路）
2. current standard / OSS で実現できるか（本書 6章は調査時点のスナップショットにすぎない）
3. managed service を使う合理性があるか（Yellow Zone。CEO 承認）
4. 自作が本当に必要か

汎用インフラ（observability・durable execution・vector search・policy evaluation 等）を独自に再実装しない。
**commodity 化する部分（モデル性能・Agent runtime・一般的な Observability）を moat にしない。**
AIcompanyOS 固有の価値は Company State / Governance / Business Lifecycle / Validated Learning /
Cross-Project Compounding / Safe Organizational Evolution に置く。

外部 Design Reference（9章）も、実装時に一次資料を再確認する。

---

## 9. Dependency / phase（Roadmap 上の順序）

```text
project-workspace-isolation（S1〜S4。planned）
  → SingleRunningProjectError 解除（同項目の受入条件 1〜7 を満たした後続変更）
  → cross-project-state-api の残作業（audit_log.project_id。in_progress）
  → [CEO 判断] Company State の置き場所（AIteamOS 拡張か AIcompanyOS 層か。design_philosophy 12）
  → company-state-foundation（deferred）
  → organizational-learning（deferred）
  → cross-project-compounding（deferred。実際に並走する第2 Project の実運用データが要る）
  → organizational-self-evolution（deferred）
```

- `project-auto-multi-worker`（複数 Worker）は**前提にしない**。複数 Project の同時運用は単一 Worker でも成立する
- 既に稼働している狭い自己改善（Principle sensor、`project-auto-incident-pattern-improvement`）は
  **この順序に巻き込まない**。今のまま進め、`organizational-self-evolution` 着手時に一般化の実例として取り込む
- 4 項目はすべて `deferred` のため、現在の 24h 自律稼働・Multi-Project 化・既存 critical path の PL 採用候補に入らない

---

## 10. Sources（accessed 2026-09-25）

| Source | URL | 確認状況 |
|---|---|---|
| Ichikawa, Arai, Kimura, Sakai, Kobashi, "LOGOS: A Living Logic for AI Agent Teams That Evolve With Humans", arXiv:2607.10878（2026-07-12 投稿） | https://arxiv.org/abs/2607.10878 | abstract ページを取得して確認 |
| Fujitsu, "Fujitsu Begins Early Validation of Fujitsu Kozuchi Multi AI Agent Framework Incorporating Self-Evolving Multi-AI Agent Technology"（2026-07-13 発表、7/15 検証開始） | 公式 press release の URL は**未確認**（`global.fujitsu` が HTTP 429 を返し取得できなかった）。Fujitsu Research 公式 X 投稿: https://x.com/fujitsulabs/status/2077585174221803906 | **実装時に公式 press release の URL を確定すること** |
| Fujitsu, "Fujitsu develops self-evolving multi-AI agent technology that learns and adapts to business operations"（2026-05-25、要素技術の発表） | https://global.fujitsu/en-global/pr/news/2026/05/25-01 | 検索結果で確認 |
| Fujitsu Research Portal, "Multi AI Agent Framework" | https://en-documents.research.global.fujitsu.com/multi-ai-agent-framework/ | 検索結果で確認 |
| Palantir, "Why create an Ontology?" | https://www.palantir.com/docs/foundry/ontology/why-ontology | 検索結果で確認 |
| Palantir, "Action types • Action log" | https://www.palantir.com/docs/foundry/action-types/action-log | 検索結果で確認 |
| Palantir, "Workshop • Scenarios • Overview" / "Core concepts" | https://www.palantir.com/docs/foundry/workshop/scenarios-overview / https://www.palantir.com/docs/foundry/workshop/scenarios-concepts | 検索結果で確認 |
| Palantir, "AIP Evolve • Overview" | https://www.palantir.com/docs/foundry/aip-evolve/overview | ページを取得して確認 |

いずれも**コピー対象ではなく設計判断を支える参照**である。
