# AI Development Team OS
## Future System Architecture v1.0 Draft（将来のCore / Extension構造）

---

# 1. 本ドキュメントの位置づけ

本ドキュメントは、AI Team OSの**将来的な**Core / Service Extension / Team Extension構造を定義する。

出典: 添付資料「AI Team OS 統合アーキテクチャ・追加仕様ロードマップ（Version 2.0 Draft）」5〜8章を転記・整理。

**命名についての注意**: 既存の `specs/03_system_architecture.md`（System Architecture v1.0）は
現行MVP実装の正本アーキテクチャドキュメントであり、本ドキュメントはそれを置き換えない。
本ドキュメントは「将来、OSがTeam First / Small Core構造へ発展した場合の目標構造」を示す将来spec であり、
ファイル名も既存の`03_system_architecture.md`との衝突を避けるため `13_future_system_architecture.md` とした。

**重要な適用範囲の注意**:

- 本ドキュメントが示すTeam Extension / Service Extensionは**将来構想であり、現時点のコード実体ではない**
- 現行実装（`apps/api` / `apps/worker` / `apps/mobile`）は、本ドキュメントのCore相当として引き続き維持対象とする
- MVP中に本ドキュメントの構造へ向けた大規模リファクタリングは行わない

---

# 2. 最新全体アーキテクチャ（将来構想）

```text
CEO
 │
 ▼
AI Team OS
 │
 ├── Core
 │
 │   ├── Execution Control
 │   ├── Job / State Control
 │   ├── Identity / Permission
 │   ├── Policy Enforcement
 │   ├── Approval Gate
 │   ├── Security Control
 │   ├── Resource / Cost Gate
 │   ├── Extension Registry
 │   └── Safe Mode
 │
 ├── Service Extensions
 │   ├── Model Routing
 │   ├── Tool Control
 │   ├── Knowledge
 │   ├── Telemetry
 │   ├── Notification
 │   ├── Team Communication
 │   ├── Audit
 │   ├── Health
 │   ├── Diagnosis
 │   ├── Research
 │   ├── Improvement Planner
 │   ├── Experiment
 │   └── Evolution
 │
 └── Team Extensions
     ├── Development Team
     ├── Marketing Team
     ├── Finance Team
     ├── Legal Team
     ├── Sales Team
     └── Future Teams
```

---

# 3. 現状マッピング（現行実装 → 将来構造の対応）

| 将来構造の分類 | 該当する現行実装 | 状態 |
|---|---|---|
| Core: Execution Control / Job / State Control | `apps/worker/src/jobRunner.ts`, `jobStateManager.ts` | 実装済み（MVP Baseline） |
| Core: Identity / Permission | `apps/worker/src/guards/permissionGuard.ts`, `apps/api/src/auth/apiToken.ts` | 実装済み（MVP Baseline） |
| Core: Policy Enforcement | `apps/worker/src/guards/{gatePolicy,gateClient}.ts` | 実装済み（MVP Baseline） |
| Core: Approval Gate | `apps/api/src/routes/approvalGate.ts`, `apps/worker/src/guards/approvalGate.ts` | 実装済み（MVP Baseline） |
| Core: Security Control | `apps/worker/src/guards/{safetyAuditor,gateProcessor,fileChangeGuard}.ts` | 実装済み（MVP Baseline） |
| Core: Resource / Cost Gate | 未実装 | 将来構想 |
| Core: Extension Registry | 未実装 | 将来構想 |
| Core: Safe Mode | 未実装（一部Watchdogの停止検知が近い機能） | 将来構想 |
| Service Extension: Notification | `apps/worker/src/notifier/*` | 実装済み（MVP Baseline） |
| Service Extension: Health | `apps/api/src/routes/knowledgeGraph.ts`（health-score）, `apps/worker/src/watchdog/*` | 部分的に実装済み（Team単位のHealthではなくProject/KnowledgeGraph単位） |
| Service Extension: Telemetry | `apps/worker/src/executionLogStore.ts`, `apps/worker/src/approvalLevel/observationLog.ts` | 部分的に実装済み（最低限のログ記録のみ） |
| Service Extension: Knowledge | `apps/api/src/routes/knowledgeGraph.ts` | 実装済み（MVP Baseline） |
| Service Extension: Model Routing | `apps/worker/src/aiCli/*`（Claude/Codex/Geminiアダプター） | 部分的に実装済み（固定ルーティング＝Static Model Routing。詳細は5b-7章。動的Model Routingは将来構想・低優先度） |
| Service Extension: Diagnosis / Research / Improvement Planner / Experiment / Evolution | 未実装 | 将来構想（MVP後） |
| Team Extension: Development Team | Claude Code（CTO / Developer AI） + Codex（Developer AI サブ） + Gemini（Meta Reviewer） | 実装済みだが「Team」として抽象化されておらず、`apps/worker`に直接組み込まれた単一構成 |
| Team Extension: Marketing / Finance / Legal / Sales Team | 未実装 | 将来構想 |

---

# 4. Extension Model（将来構想）

## 4.1 Service Extension

OSの共通能力を追加する。例: Telemetry / Knowledge / Notification / Research / Diagnosis / Experiment

## 4.2 Team Extension

OSが担当できる仕事・専門領域を追加する。例: Development Team / Marketing Team / Finance Team / Legal Team

すべてを同一種類のPluginとして扱わず、Service ExtensionとTeam Extensionを明確に区別する。

---

# 5. Coreに含める基準（将来構想）

以下をすべて満たす場合のみCoreへ含める。

- OSの通常実行に必須
- 停止すると安全性または状態整合性を維持できない
- ほぼすべてのTeamが共通利用する
- 無効化可能な追加機能として分離しにくい

それ以外はExtensionとして実装する。

Health、Diagnosis、Research、Experiment、EvolutionはCoreへ含めない。

---

# 5b. Planner責務・Workflow Lifecycle・Knowledge Consult（将来構想。外部Agent Loop設計思想の吸収）

本章は、外部のAgent Loop的な設計思想（Goal→評価基準→実行→評価→Feedback→Retry→学習）を、
新規コンポーネントとして追加するのではなく、AI Team OSの既存概念（Planner / Workflow / Knowledge /
Review / Self Diagnosis / Evolution / Team Health）へ吸収するための記述である。**本章はいずれもMVP後の
将来構想であり、現時点では未実装。** 独立した`Rubric.md`・`Loop.md`・`Memory.md`のような新規仕様書は作らない。

## 5b-1. Planner責務とRubric生成

PlannerはCEOのGoal（目的・方針・優先順位・妥協しない点）をProject Planへ変換する責務を持つ。Plannerは
Goal・制約・Risk・優先順位を抽出し、Project/Task/Workflowに応じた**Rubric（完成条件・評価基準）**を
自動生成する。CEOが技術的なRubricを直接書く前提にはしない。RubricはTeamごとに観点が異なり
（例: Development Teamはtypecheck/test/bundle成功、Marketing Teamはターゲット/訴求/CTAの明確さ）、
全Team共通の固定Rubricにはしない。RubricはProject/Task/Workflowに添付される評価基準として扱い、
独立Team・独立Agentにはしない。

## 5b-2. Workflow Lifecycle

Workflowの基本形として以下のLifecycleを採用する（MVP後の正式実装時の基準）:

```text
Goal → Rubric → Execute → Evaluate → Feedback → Retry → Complete
```

- **Goal**: CEOの目的
- **Rubric**: PlannerがGoalから作る完成条件
- **Execute**: Team/Agentが作業する
- **Evaluate**: Review担当がRubricに照らして確認する（Evidence over Opinion原則に従う。
  `specs/00_constitution.md` 3.12参照）
- **Feedback**: 未達項目・修正点をRetry可能な粒度でReview担当が返す。CEOの自由入力・却下指示とは
  区別する（現状Approval Gateの自由入力欄は実行指示として機能しない設計上の課題があり、
  `tasks/roadmap.md`の別課題として扱う）
- **Retry**: Rubric未達の場合のみ、Feedbackを入力として再実行する。無制限Retryはしない。
  Retry回数が増えた場合はSelf Diagnosis（Investigate）候補とする
- **Complete**: Rubric達成・必要Evidence確認・必要ならCEO承認完了で完了とする。Rubric未達のまま
  Completeにしない

## 5b-3. Knowledge Consult

MemoryはKnowledgeへ統合する（新規Memory系コンポーネントは作らない）。Knowledgeが持つ種別:
Project / Workflow / Skill / Rule / Architecture Decision / Known Pitfall / Past Decision / Review Finding。

Execution前に、関連するKnowledge（Rule等）だけを検索・抽出してWorkflowに添付する。**Knowledge全文を
毎回AIに渡すことは禁止（または非推奨）とし**、`specs/20_token_efficient_intelligence_policy.md`の
Context Minimization原則に従う。

## 5b-4. Investigate（Self Diagnosisへ吸収）

通常のRetryでは解決できない失敗について原因調査を行う機能。**失敗1回では発動しない。** Retryが複数回
（例: 3回）続いた場合、または既知ルールで原因が分からない場合にのみ発動する。Investigateはコード変更を
直接行わず、原因・Evidence・再発防止案を出すのみで、結果はKnowledgeへ送る。

**責務境界（重要）:** Investigateの責務は「起きた事象の**原因を深掘りする**」ことに限定する。
Goal Gap・Trajectory Gap・Opportunity・Bottleneckといった「**そもそも何を改善対象にするか**」の検出は
Investigateの責務ではなく、Self Diagnosis Framework（5b-8）が担う。優先順位付けはImprovement Planner
（5b-9）が担う。Investigateをこれらの検出機能へ肥大化させない。改善候補について原因分析が必要になった
場合に、Investigateを**再利用する**関係とする（呼び出し順序は5b-10を参照）。

## 5b-5. Distill（Evolutionへ吸収）

ログ・失敗・Review結果・Investigate結果から、再利用可能なRuleやKnown Pitfallを作る処理。
`Observation → Investigate → Verify → Distill → Knowledge登録`の流れを取る。Rule化にはEvidenceが必要である。

**CEO承認必須方針（2026-08-12 CEO確定。既存の「必要に応じてCEO承認対象とする」という表現を明確化する）**:
Lesson / Observation / Hypothesis / Diagnosis / Improvement Proposalの自動生成・蓄積・分析まではAIが
自律的に行ってよい。しかし、それを正式にOperationalize（実際の反映）して、Rule / Prompt / Workflow /
Roadmap / Constitution / Goal / Design Philosophy / Security Policy / Approval Policy /
Model・Data Policy / Risk Policy / AIの自動実行可能範囲 / 全Project・全Teamへ影響するdefaultを
変更する場合は、変更の大小・Evidence量にかかわらず**毎回例外なくCEO Proposalとして提示し、
CEOの明示承認を得てから変更する**。AI自身が「今回は軽微だから承認不要」と判断して自己変更することは
禁止する。この承認経路は既存のProposal Lifecycle（`docs/AI_TEAM_OS_DESIGN.md` 第2弾5章）・
Human Approval Zone（`specs/04_ai_organization.md` 13章）をそのまま再利用し、新しいApproval Gateは
作らない。

### 5b-5-1. Knowledge Lifecycle（将来設計。現行5b-3のKnowledge種別を置き換えない）

5b-3のKnowledge種別（Project / Workflow / Skill / Rule / Architecture Decision / Known Pitfall /
Past Decision / Review Finding）は**内容カテゴリ**であり、知識の確からしさを表す状態ではない。将来的には
これと直交する軸として、以下の**Lifecycle State**を持たせる。

```text
External Claim          外部由来の未検証の主張（そのままValidated扱いにしない）
  ↓
Observation             実際に起きた観測（この段階では一般化しない）
  ↓
Hypothesis              原因・因果についての仮説（事実として扱わない）
  ↓
Evidence                仮説を支持/否定する検証結果
  ↓
Validated Knowledge     再現性が確認された知識
  ↓
Operationalized         Rule / Routing / Playbook等へ実際に反映された状態
  ↓
Revalidation            陳腐化を検知して再検証・失効させる
```

**Knowledgeへ持たせる属性（将来）:** `applicable_conditions`（どの条件下で成立するか）、`confidence`、
`causal_confidence`（相関と因果を区別する）、`source_type`（Internal / External）、`evidence`、
`last_validated_at`、`revalidation_condition`。

条件のない断定的な保存（例:「AはBに向いている」）は避け、成立条件つきで保存する。

**Internal / External の優先:** 自社実績（Internal）を外部由来（External Claim）より優先できる設計とする。

**Knowledge Conflict:** 外部主張と自社実績が一致しない場合、これをエラーや例外として捨てず
`CONFLICT`として記録し、原因候補（対象顧客・市場・価格帯・KPI定義・時期・サンプル不足・
適用条件の不足・外部主張自体の誤り等）を保持する。Conflictの記録自体を価値ある知識として扱う。

## 5b-6. Loop Metrics（Team Healthへ吸収）

Workflow Loopの健全性を測る指標（候補: Retry回数・Feedback回数・Rubric達成率・Rule利用率・
Knowledge命中率・Retry後成功率）。Team単位を中心とし、異なるTeamを単純比較しない。Metricsは
状態把握のために使い、それ自体が改善提案や自動変更の根拠にはしない。

### 5b-6-1. 指標体系の分離（将来設計。Loop Metricsへ事業指標を混ぜない）

Loop Metricsの責務は**内部Loopの状態把握**に限定し、事業成果指標をここへ統合しない。将来的には
以下の3系統を**別軸**として扱う。

| 系統 | 内容 | 主な用途 |
|---|---|---|
| **Execution / Loop Metrics**（現行5b-6） | Retry・Feedback・Rubric達成率・Knowledge命中率・Worker execution実績 | 内部Loopの健全性把握 |
| **Business Outcome** | Revenue・Profit・CV・Retention・Customer outcome等 | 事業成果の把握 |
| **Objective Progress** | `target_value` / `current_value` / `target_date` / `trajectory` / `expected_achievement_date` / `goal_gap` | 目標到達見込みの把握（5b-8が参照） |

### 5b-6-2. 評価概念の分離（混同禁止）

以下3つは**別々に評価**し、混同しない。

1. **Worker / Execution Quality** — Workerが指示された仕事を正しく実行したか
   （Correctness / Completeness / Format / Policy遵守 / Acceptance Criteria充足）
2. **Strategy / Playbook Performance** — その手順・戦略自体が有効だったか
3. **Business Outcome** — 上位Objectiveへ寄与したか

例: SNS投稿が売上につながらなかったとしても、Writer Workerの品質が低いとは限らない（Strategyの問題で
ありうる）。逆にWorkerが完全に指示通り動作しても、Strategy自体が誤っていれば成果は出ない。

**注記:** `specs/00_constitution.md` 3.12 Evidence over Opinion が現在列挙するEvidence
（test結果・typecheck結果・bundle結果・実機確認・ログ・Telemetry・差分）は、上記1（Execution Quality）
に相当する。2・3の評価軸は現行憲法の射程外であり、将来必要になった時点で憲法レベルへの昇格を別途検討する
（本ドキュメント追加時点では憲法を変更しない）。

## 5b-7. モデル選択・モデル評価・将来の動的Model Routing（将来構想）

**位置づけ**: 「3. 現状マッピング」表の`Service Extension: Model Routing`行に対応する詳細仕様。
本章はいずれもMVP後の将来構想（一部は既存実装の運用方針整理）であり、特定ベンダー・特定モデル名
（Claude/GPT/Gemini等の個別モデル名）には依存しない。モデルは能力・コスト・用途で抽象化して扱う
（`specs/00_constitution.md` 3.7 Vendor Independenceの原則に従う）。Plannerは自身の内部知識で
モデル情報を記憶するのではなく、将来的にはModel Registry（5b-7-3）を参照する構造にする。

### 5b-7-1. Static Model Routing（現在・MVP開発中の運用方針）

複雑な自動最適化を実装せず、単純で予測可能な固定ルールでモデルを選択する段階。

**現状との対応（新規実装ではなく既存実装の運用方針整理）**: 「1タスク＝1プロバイダー」原則
（`packages/shared/src/types/task.ts`の`Task.provider`フィールド、Rule-001: Codex統合リスクM-1）と
`apps/worker/src/aiCli/*`（Claude Code/Codex/Gemini各アダプター＋`factory.ts`）が、タスク種別ごとに
固定のモデル（プロバイダー）を割り当てる、Static Model Routingに相当する仕組みとして既に実装済み。

**将来の拡張候補（未実装）**:
- リスクまたは重要度に応じたモデルクラスの選択（現状は`Task.provider`固定割当のみで、リスク連動はない）
- 推論工数を低・標準・高など少数段階で設定する仕組み
- 失敗時に上位モデルまたは高い工数へ自動昇格する仕組み（現状は自動昇格ロジックなし）
- CEOが設定した予算上限の遵守・無料枠優先・無料枠枯渇時の待機/CEO承認後の有料切り替え
  （既存の`docs/multi_ai_step_review_flow.md` 20〜21章「Quota Policy」「Review Transport Mode」は
  Gemini Review呼び出し限定の同種方針。本項はDeveloper AI実行全体への拡張として整理し、
  既存Quota Policyと矛盾しないよう後日統合する）
- 使用モデル・推論工数・成功/失敗・Retry回数・トークン量の最低限のログ記録
  （現状`apps/worker/src/executionLogStore.ts`・`apps/worker/src/approvalLevel/observationLog.ts`が
  近い機能を持つが、モデル選択判断用の記録としては未整理）

### 5b-7-2. Model Usage Telemetry（MVP完成後・Phase 1）

AI Team OS自身の実運用結果を収集する。収集項目: タスク種別・使用モデル・推論工数・入出力トークン・
推定/実コスト・実行時間・成功/失敗・Retry回数・Rubric達成状況・Reviewで発見された重大問題・
**最終的な完了までにかかった総コスト**（最初の生成コストだけでなく、修正・再試行を含む完了コストを
評価できるようにする）。既存のTelemetry Service Extension（`apps/worker/src/executionLogStore.ts`等）へ
統合する形で位置づけ、独立した新規コンポーネントにはしない。

### 5b-7-3. Model Registry Lite（MVP完成後・Phase 2）

Plannerが、利用可能なモデルの能力・制約・コスト・状態を参照できるようにする。保持項目候補:
provider・model identifier・状態（active/deprecated/unavailable等）・入出力コスト・コンテキスト上限・
対応機能・推論工数設定の有無・推奨用途・既知の制約・最終確認日時・情報源・AI Team OS内での実運用実績。

**公式情報（ベンダー公表スペック）と内部実績（Model Usage Telemetryの集計結果）は分離して保存する。**
Plannerはモデル情報を内部知識だけで判断せず、Model Registryを参照する構造にする。Model Registry自体の
自動インターネット更新は行わない（後述「今回実装しないもの」参照）。

### 5b-7-4. Selective Model Evaluation（MVP完成後・Phase 2またはPhase 3）

モデル選択が微妙で、かつ今後も繰り返し発生する価値の高いタスクだけを限定的に比較する。全タスクで
複数モデルを並列実行する設計にはしない。比較の実行機構は、既存のExperiment Service Extension
（`specs/13_future_system_architecture.md` 4.1・「3. 現状マッピング」表）の一部として位置づける。

**比較を開始する条件の例**: 新しいモデルを導入するとき／過去実績が少ないタスク種別／既定モデルが
繰り返し失敗したとき／安価なモデルと高性能モデルのどちらが適切か判断しにくいとき／モデル選択ルールを
変更する前／今後何度も発生するタスクで比較コストを回収できる可能性があるとき。

**比較方法（コストが低い順）**: 1. 方針・計画だけを比較する → 2. 難しい部分だけを部分比較する →
3. 必要性が高い場合のみ完全なShadow実験を行う。比較実験によるトークン消費が、得られる改善効果を
上回らないようにする（`specs/20_token_efficient_intelligence_policy.md`の原則に従う）。

### 5b-7-5. Dynamic Model Routing（将来・低優先度）

十分な実運用データ（Model Usage Telemetry）が蓄積された後に、タスク分類・要求品質・リスク・重要度・
予算・レイテンシ・過去の成功率・完了までの総コスト・モデルの利用可能状態・失敗時のエスカレーションから
モデルと推論工数を自動選択する。**複雑性が高く、固定ルール（5b-7-1）で実際に問題が発生した場合のみ
実装を検討する低優先度機能とする。自動最適化を導入すること自体を目的にしない。**

### 5b-7-6. 優先順位

1. MVPの完成
2. 単純な固定ルールによる安定運用（5b-7-1 Static Model Routing）
3. 実行ログの収集（5b-7-2 Model Usage Telemetry）
4. 実際に問題が出た部分だけモデル選択を改善
5. 必要性が確認された場合のみ限定比較（5b-7-4 Selective Model Evaluation）
6. 十分なデータと費用対効果がある場合のみ動的ルーティング（5b-7-5 Dynamic Model Routing）

### 5b-7-7. 今回実装しないもの（明記）

全モデルの常時比較／タスクごとの複数モデル完全実行／自動ベンチマーク基盤／複雑な選択確信度計算／
機械学習によるモデルルーティング／モデル選択ルールの自動変更／本番成果物へのShadow結果の自動反映／
CEO承認なしの予算上限超過／Model Registryの自動インターネット更新／プロダクションコードの変更。

### 5b-7-8. 既存仕様との統合方針（重複回避）

| 領域 | 統合先 |
|---|---|
| モデルの基本情報管理 | Model Registry Lite（本章5b-7-3）。既存のProvider管理実装（`apps/worker/src/aiCli/*`）とは別レイヤーとして整理し、置き換えない |
| 実行結果の収集 | Model Usage Telemetry（5b-7-2）＝既存Telemetry Service Extensionへ統合。Team Health（5b-6）とは別軸（Team単位の健全性 vs モデル単位の実績）だが、将来Team Healthの内訳分析としても参照しうる |
| 比較実験 | Experiment Service Extension（「3. 現状マッピング」表）の一部として実施。独立した`Shadow Experiment`仕様は新設しない |
| モデル選択ルールの改善提案 | Self Diagnosis（5b-4）・Evolution（5b-5）の対象領域の一つとして扱う。独立仕様は新設しない |
| 高額モデル利用の許可 | 既存のBudget Control（`specs/13_future_system_architecture.md`「3. 現状マッピング」表の`Core: Resource / Cost Gate`。未実装・将来構想）＋既存Approval Gateに従う。新しい承認経路は作らない |
| PlannerによるモデルGate選択 | Planner責務（5b-1）の一部として整理。Team ArchitectureまたはWorkflow Lifecycle（5b-2）に接続する |

### 5b-7-9. 将来のWorker抽象化との包含関係（移行方向）

本章5b-7の各機能は、いずれも**LLM（モデル）だけを対象としたsubset**である。将来のAI Organization OS
Coreでは、実行主体をモデルに限定せず**Worker**として抽象化する。最終正本はWorker系の名称とし、
Model前提の密結合を将来へ持ち越さない。

```text
Worker Registry                      ← 最終正本
  └ Model Registry (Lite)                現行の将来構想。LLMのみを対象とするsubset（5b-7-3）

Worker Routing / Execution Plan      ← 最終正本
  └ Model Routing (Static / Dynamic)     現行。単一モデル選択のみのsubset（5b-7-1 / 5b-7-5）

Worker Adapter Framework             ← 最終正本
  └ AI CLI Adapter                       現行実装。CLI型LLMのみのsubset（`apps/worker/src/aiCli/*`）
```

**現行のModel系機能を削除・改名する必要はない。** 上記は「現在の実装は将来の汎用Worker Architectureの
subsetである」という移行関係を明示するものであり、既存実装・既存将来構想を置き換えるものではない。

**Workerに含める対象（LLMに限定しない）:**

| 分類 | 例 |
|---|---|
| AI Worker | Claude / Codex / Gemini / その他LLM |
| Agent Worker | Lovable / OpenHands / Replit Agent 等 |
| Tool Worker | Apify Actor / n8n / Make 等のWorkflow・SaaS |
| Script Worker | Python / shell 等のスクリプト |
| Deterministic Worker | validator / test runner / linter / parser / calculator |

将来的にはHumanもWorker Typeとして表現しうる。

**Execution Plan:** Routingの最適化単位は単一Workerに限らない。Worker Composition
（例: 安価Worker → Deterministic Validator → 低confidenceの場合のみ上位Worker）まで拡張しうる。
最適化の目標は「最も安いWorker」ではなく「**要求品質を満たす実行計画の総コスト最小化**」とする
（既存roadmapの「修正/再試行を含む完了までの総コスト」と同一概念）。

**Quality Stabilizer（将来）:** Worker間の品質ばらつきを後段へ露出させず、最終成果物の品質を一定範囲へ
収束させる層。Deterministic Check → 安価Review → 上位Worker → Human承認の順で、**必要なレベルまでしか
上げない**。全Taskに同一構成を強制しない。

---

## 5b-8. Self Diagnosis Framework（将来構想。改善対象の検出）

「3. 現状マッピング」表の`Service Extension: Diagnosis`に対応する詳細。現在は名称のみで実質未定義で
あったため、本節で責務を定義する。**MVP後の将来構想であり現時点では未実装。**

**責務:** 以下を観測し、「**改善対象候補（Improvement Opportunity）**」を検出する。

| 観点 | 内容 |
|---|---|
| Current State | 現在値の把握 |
| Objective | 上位目標（target_value / target_date） |
| Goal Gap | 現在値と目標値の差 |
| Trajectory Gap | 改善はしているが、その速度では期限までに目標へ到達できない状態 |
| Degradation | 既存指標の悪化 |
| Opportunity | 現在問題がなくても改善余地が大きい箇所 |
| Bottleneck | 全体成果を制限している制約 |
| Risk | 将来的な悪化・事故の兆候 |

**重要:** 検出対象を「悪化（Degradation）」だけに限定しない。「改善しているが目標到達速度が足りない」
「問題は無いが最もレバレッジが大きい」も検出対象とする。

Self Diagnosisは**検出のみ**を行い、優先順位付け（5b-9）・原因分析（5b-4 Investigate）・実行
（Experiment）は行わない。

## 5b-9. Improvement Planner（将来構想。改善候補の優先順位付け）

「3. 現状マッピング」表の`Service Extension: Improvement Planner`に対応する詳細。現在は名称のみで
実質未定義であったため、本節で責務を定義する。**MVP後の将来構想であり現時点では未実装。**

**責務:** Self Diagnosis（5b-8）が検出した改善候補について、以下の観点で優先順位を決める。

- Expected Outcome Impact（期待される成果インパクト）
- Strategic Importance（戦略的重要度）
- Probability of Success（成功確率）
- Urgency（緊急度）
- Implementation Cost（実装コスト）
- Time to Learn（学習に要する時間）
- Risk（リスク）

厳密な計算式として固定しない。**下位KPIの改善が上位KPIを犠牲にしないこと**を優先条件とする
（局所最適の禁止）。例: AI実行コストを削減しても、品質低下・開発速度低下・売上減を招くなら採用しない。

原因分析が必要な候補については、既存のInvestigate（5b-4）を**再利用**する。Improvement Planner自身は
原因分析機能を持たない。

## 5b-10. Problem-driven Learning（改善の起点順序）

改善活動の起点は、外部ノウハウの発見ではなく**Objective / Gap / Opportunity**とする。外部知識は改善の
**材料**であり、改善活動の起点にしない。既存roadmapの「Problem-Driven Research（具体的課題がある場合の
み開始）」を、順序原則として明文化したもの。

```text
Objective / Gap / Opportunity        ← 起点（5b-8で検出、5b-9で優先順位付け）
  ↓
原因分析・仮説                        ← 必要な場合のみInvestigate（5b-4）を再利用
  ↓
Internal Knowledge を先に検索         ← 自社実績を優先
  ↓
不足する場合のみ External Knowledge   ← Research。取得経路のCompliance方針に従う
  ↓
Experiment                            ← Experiment Service Extension。Risk階層とApproval Gateに従う
  ↓
Outcome 評価                          ← Execution Quality / Strategy / Business Outcome を分離評価（5b-6-2）
  ↓
Knowledge 更新                        ← Distill（5b-5）。Lifecycle State（5b-5-1）に従う
```

**禁止対象の明確化:** 禁止するのは「**外部で新しいノウハウを発見したことだけを理由に、改善施策や本番
Experimentを開始する**」ことであり、External Knowledgeの収集・探索そのものを禁止する意味ではない。

- External Knowledgeの収集・Knowledge DBへの蓄積は継続してよい
- External Claim（5b-5-1）として、将来利用できる状態で保持してよい
- ただし改善施策の**優先順位付け**は原則としてObjective / Gap / Opportunity（5b-8, 5b-9）から決定する
- 「面白そうな外部ノウハウを見つけたので試す」という**起点のみ**で改善Experimentを開始しない
- Objective-drivenな改善を行う際に、必要なKnowledgeとして参照する（5b-10図の位置づけ）ことを基本とする

改善活動には必ずObjective / Gap / Opportunity / Riskとの関連を要求する。低コストの探索的分析
（＝収集・保持段階）は許可しうるが、Experiment着手の優先順位は低くする。

**安全性:** 本ループはいかなる理由があっても既存のApproval Gate / Policy Engine / Constitutionを
迂回しない。High Riskの実験はCEO承認を必須とする。改善予算・同時実験数・停止条件・Rollbackを設ける。

---

# 6. 既存ドキュメントとの関係（要整理・将来統合検討）

`docs/AI_TEAM_OS_DESIGN.md`「第3弾：MVP完成後に追加する高度な運用制御」（9〜14章: AI Reliability, KPI,
Conflict Management, Learning Control, Rollback, AI Runtime State）は、本ドキュメントが示すService Extension
（Health / Diagnosis / Experiment / Evolution等）と概念的に重複する可能性がある。

**どちらを正式仕様とするか、または統合するかは未確定。** 本ドキュメント追加によって
`docs/AI_TEAM_OS_DESIGN.md`を削除・置換することはしない。両ドキュメントとも「将来整理対象」として残し、
実際にService Extensionの実装に着手する段階で、CEO確認のうえ統合方針を決定する。

---

# 7. 関連ドキュメント

- 最上位思想: `specs/00_constitution.md`
- 現行MVPの実装レベルアーキテクチャ（現状正本・維持）: `specs/03_system_architecture.md`
- 現在実装済み機能ベースライン: `docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」
- VPS常駐運用の正本: `specs/11_runtime_environment.md`
- AI利用量抑制方針: `specs/20_token_efficient_intelligence_policy.md`
- 既存の設計思想ドキュメント（要整理・将来統合検討）: `docs/AI_TEAM_OS_DESIGN.md`
- MVP後の実装タスク: `tasks/roadmap.md`
