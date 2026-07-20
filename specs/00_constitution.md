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
