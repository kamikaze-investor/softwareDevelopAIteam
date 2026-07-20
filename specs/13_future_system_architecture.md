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
| Service Extension: Model Routing | `apps/worker/src/aiCli/*`（Claude/Codex/Geminiアダプター） | 部分的に実装済み（固定ルーティング。動的Model Routingは将来構想） |
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
