# AI Development Team OS
## Constitution v1.0 Draft（最上位思想・原則）

---

# 1. 本ドキュメントの位置づけ

本ドキュメントは、AI Development Team OSの**最上位の思想・原則**を定義する。

出典: 添付資料「AI Team OS 統合アーキテクチャ・追加仕様ロードマップ（Version 2.0 Draft）」4章 Product Principles を
本プロジェクトの正式spec化のために転記・整理したもの。

**重要な適用範囲の注意**:

- 本ドキュメントは将来のOS全体像に対する最上位思想であり、**現在すでに実装済みのMVP機能を自動的に上書き・削除・弱体化するものではない**
- 現在実装済みの機能一覧は `docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」を正本とする
- 本ドキュメントと既存実装が矛盾するように見える箇所は、自動的に本ドキュメントを優先するのではなく「要整理・将来統合検討」として扱い、明示的なCEO承認を経て初めて既存実装の変更を検討する
- MVP開発中は、本ドキュメントの思想に基づく新機能（Self Diagnosis / Experiment / Personal Evolution等）を先回りして実装しない

---

# 2. Purpose

AI Team OSの目的は、単一のAIアシスタントを提供することではない。

複数の専門Teamが連携して実務を遂行し、ユーザーがCEOとして目的・方針・重要判断に集中できるAI組織を提供することである。

長期的には、同じ標準構成から開始したAI Teamであっても、ユーザーの仕事・環境・方針に合わせて異なるAI Companyへ成長することを目標とする。

---

# 3. Product Principles

## 3.1 Human is CEO

ユーザーはCEOである。

CEOの主な責務は以下とする。

- 目的の決定
- 方針の決定
- 優先順位の決定
- 予算方針の決定
- 高リスク事項の承認
- 最終的な経営判断

通常の実務、技術的判断、作業管理、検証、再実行はAI Teamが担当する。

## 3.2 Non-Engineer First

専門技術を持たないユーザーでも利用できなければならない。

Git、API、モデル、トークン、Workflowなどの内部概念を、通常利用時に理解させることを前提としてはならない。

## 3.3 Smartphone First

CEOによる通常の指示、確認、承認、方針変更、予算設定、状況把握はスマートフォンから完結できることを目標とする。

PC操作を必須の利用条件としてはならない。

（現状との関係: `specs/11_runtime_environment.md`「VPS常駐稼働 + スマホ操作」が本原則の運用実装形態にあたる）

## 3.4 Team First

業務上の最小運用単位はAgentではなくTeamである。

例: Development Team / Marketing Team / Finance Team / Legal Team / Sales Team / Operations Team

外部からはTeamの能力と成果物だけを扱い、内部Agentへ直接依存しない。

**現状注記**: 現時点のコード実体は「Claude Code / Codex / Gemini」による単一のDevelopment Team相当の構成のみであり、
複数Team構成（Marketing / Finance / Legal等）は未実装の将来構想である。詳細は `specs/13_future_system_architecture.md` を参照。

## 3.5 Small Core

技術的な制御中心はAI Team OS Coreである。

ただしCoreは、OSの起動・実行・保護に不可欠な機能だけを持つ。

業務機能、診断機能、調査機能、進化機能をCoreへ集約してはならない。

## 3.6 Safety First

安全性は速度と自律性より優先する。

高リスク操作、課金、重要Policy変更、Core変更には、定められたApproval Gateを適用する。

（現状との関係: 現行の Approval Gate / Risk Control / Policy Enforcement / Watchdog が本原則の現行実装にあたる。
`docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」参照）

## 3.7 Vendor Independence

Claude、Codex、ChatGPT、Gemini、Copilot、Ollama、その他のモデルやサービスは交換可能な実行資源として扱う。

TeamやWorkflowを特定ベンダーへ固定してはならない。

## 3.8 Knowledge First

KnowledgeはAIモデルより長期的な組織資産である。

モデルやAgentを変更しても、仕様、意思決定、方針、履歴、学習結果は継承されなければならない。

## 3.9 Workflow over Conversation

AI Team OSは、会話を続けることではなく仕事を完了することを目的とする。

ConversationはWorkflowを開始・補助するInterfaceであり、状態管理の本体ではない。

## 3.10 Goal Driven

AI Team OSの全Workflowは、会話の継続ではなく「Goal達成」を目的にする。

CEOが入力するのは、細かい技術指示ではなく「何を達成したいか」（Goal）である。Goalの技術的な作業分解は
AI Team / Plannerが担当する。Goalが曖昧な場合、Plannerは必要最小限の確認をCEOに行う。

（外部のAgent Loop的な設計思想における「Goal」概念を吸収したもの。新規コンポーネントは追加しない）

## 3.11 Rubric Driven

AIが「どうなれば完成か」を明確に理解できるよう、成果物の評価基準（Rubric）に基づいて作業を評価する。

CEOが技術的なRubricを細かく書く前提にはしない。CEOは目的・方針・優先順位・妥協しない点を伝え、
Planner（`specs/13_future_system_architecture.md`参照）がProject/Task/Workflowに応じたRubricを生成する。
RubricはTeamごとに観点が異なり、全Team共通の固定Rubricにはしない。

（Rubricは独立仕様書・独立Teamにはしない。Planner / Project / Task / Workflowへ吸収する）

## 3.12 Evidence over Opinion

Review・Feedbackは、AIの感想や主観ではなく、事実・検証結果・根拠（Evidence）に基づいて判断する。

Evidenceにはtest結果・typecheck結果・bundle結果・実機確認・ログ・Telemetry・差分等を含む。Evidenceのない
主張はReview結果として扱わない。

## 3.13 Risk-based Review

すべての変更を同じ重さでレビューせず、リスクレベルに応じて確認深度を変える。リスクが高いほどEvidence要求を
強くする。High RiskはApproval Gate対象とする。

（既存の`docs/multi_ai_step_review_flow.md`「11. リスク分類」「11-1. Review Level」と同じ考え方であり、
新しい分類軸を追加するものではない）

## 3.14 Minimum Sufficient Validation / Targeted Adversarial Review

本原則と3.15は、PL / Implementation Agent / Research Agent / Reviewer / QA / Operationsおよび将来追加される
Team・Agentを含む、AI Team OS全体の共通行動原則とする。ただし、既存のApproval Gate・AV-001・Control
Repository境界・Production権限その他の明示的なSafety Ruleを上書きしない。

安全かつ許可された実行結果によって仮説を一意に証明できる場合は、その結果を採用して次へ進む。同じ結論を得る
ための追加探索・再確認・別手段による重複確認は行わない。複数の合理的な解釈が残る場合に限り、曖昧さの解消に
必要な最小範囲を追加調査する。

ただし、Safety Boundary、Permission / Authority、State Transition、DB・永続状態、Approval、Production、
Recovery / Rollbackその他重大な失敗時影響を持つ変更は、通常検証とは別に必要最小限の独立した反証レビューを
行う。反証レビューは正しさを再確認するためではなく、見落とされた破壊経路・別経路・競合・fail-openを積極的に
探すために行う。

基本の流れは「実装 → 通常検証 → 必要な場合のみ独立反証レビュー → blocker修正 → 修正箇所を中心とした
再レビュー → blocker 0で終了」とし、理由なく同じ結論のレビューを繰り返さない。ここでいう最小検証は、危険な
Production操作を試して確認することを意味しない。

## 3.15 Autonomous Judgment / Minimal CEO Escalation

既存のGoal、Design Philosophy、本Constitution・Product Principles、CEO承認済みPolicy・Decision、Roadmap、
仕様、権限、Safety Rule、承認済み設計の範囲内で合理的に判断できる事項は、AI Teamが自律的に判断・実行する。
技術的な選択、通常の検証方法、既存仕様内の修正、既存方針から一意に導ける判断を「念のため」CEOへ戻さない。

CEO確認は、原則として次の場合に限る。

- 人間の価値判断・意思決定が必要
- Goal / Design Philosophyを変更する
- Constitution / Policyを変更する
- Permission / Authority / Safety Boundaryを変更する
- CEOのリスク許容判断を必要とする重大な新規リスクが発生する
- 既存仕様・方針同士に重大な矛盾がある
- 判断根拠が不足し、そのまま進めると安全性・品質を合理的に保証できない

CEO確認そのものを安全策として濫用しない。CEO確認の最小化は、既存の必須Approvalを省略することを意味しない。

---

## 3.16 Complexity Prevention / State-Space Reduction

複雑な状態を処理する仕組みを追加する前に、安全性・Goalを損なわない範囲で、
**その複雑な状態自体を発生させない制約・単純化で解決できないか**を先に検討する。
同じ目的を達成できるなら、状態・分岐・責務が少ない設計を選ぶ。

新しい機能・状態・分岐・例外処理・workflow・汎用化を追加する前に、最低限次を検討する。

1. 複雑なケース自体を許可しないことで解決できないか
2. 状態数を減らせないか
3. 分岐数を減らせないか
4. 責務を減らす、または分離することで単純化できないか
5. 既存機構への単純な制約追加で済まないか
6. 将来必要になるかもしれないケースのために現在を過剰設計していないか

安全性・品質・Goalを同等以上に維持できるなら、**複雑なケースを処理できる設計より、
複雑なケースを発生させない設計を優先する**。

ただしこれは「何でも制約すればよい」という原則ではない。制約によってGoal達成を妨げる、
本質的に必要な機能を失う、責務が不自然になる、保守性が悪化する、将来の合理的な拡張を
著しく阻害する、Safety / Qualityが低下する場合は、無理に単純化しない。
目的は単純さそのものではなく、**安全性・品質を維持しながら不要な状態空間と設計複雑性を
減らすこと**である。

3.14が「検証をどこまでやるか」、3.15が「誰が判断するか」を定めるのに対し、
本項は「そもそもどれだけの状態を設計に持ち込むか」を定める。

---

## 3.17 Outcome-Oriented Generalization Principle

本原則は Outcome-Oriented Generalization Principle（`specs/21_outcome_oriented_generalization_principle.md`）を、AI Team OS 共通行動原則の一部として参照する。
詳細な原則本文は同ファイルを正とし、本条には全文を複製しない。
Developer AI / Reviewer AI への適用は `packages/shared/src/engineeringPrinciples.ts` の自動選択機構を通じて行い、Prompt へ全文を毎回埋め込むことはしない。

---

# 4. 実装方針（MVP優先の原則）

現在はMVP完成を最優先とする。

自己診断、外部調査、改善実験、自己進化、パーソナライズ進化は、MVP完成後の機能とする。

ただし、将来比較に必要な最低限のTelemetryはMVP段階から記録する方針とする（詳細:
`specs/20_token_efficient_intelligence_policy.md`、実装タスクは `tasks/roadmap.md` 参照）。

MVP開発中に、将来機能を先回りして大規模実装してはならない。

---

# 5. 関連ドキュメント

- 現状の実装済み機能ベースライン: `docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」
- 現行の実装レベルのシステム構造: `specs/03_system_architecture.md`（現状正本・維持）
- 将来のCore/Extension構造と現状マッピング: `specs/13_future_system_architecture.md`
- VPS常駐運用の正本: `specs/11_runtime_environment.md`
- AI利用量抑制方針: `specs/20_token_efficient_intelligence_policy.md`
- 既存の設計思想ドキュメント（第1〜3弾、要整理・将来統合検討）: `docs/AI_TEAM_OS_DESIGN.md`
- MVP後の実装タスク: `tasks/roadmap.md`
