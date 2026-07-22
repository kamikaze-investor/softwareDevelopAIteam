# AI Development Team OS
## Token-Efficient Intelligence Policy v1.0 Draft

---

# 1. 本ドキュメントの位置づけ

本ドキュメントは、将来のHealth / Diagnosis / Research / Experiment / EvolutionにおけるAI利用量を
最小化するための方針を定義する。

出典: 添付資料「AI Team OS 統合アーキテクチャ・追加仕様ロードマップ」末尾のToken-Efficient Intelligence Policy（Version 1.0 Draft）を転記・整理。

**重要な適用範囲の注意**:

- 本ドキュメントが対象とするHealth / Diagnosis / Research / Experiment / Evolutionは、**すべてMVP後の将来機能**であり、
  現時点では未実装である
- 本ドキュメントは将来これらを実装する際の方針であり、現行のMVP実装（Approval Gate / Risk Control / Watchdog等）の
  AI利用方針を今回変更するものではない
- MVP中に本ドキュメントに基づく新機能を先回りして実装しない

---

# 2. Purpose

自己診断・自己進化はAI Team OSの補助機能であり、通常業務より多くのAI資源を消費してはならない。

---

# 3. Default Principle

機械的に処理可能な判断へAIを使用してはならない。

以下を優先する。

1. 通常コード
2. SQL集計
3. 固定ルール
4. 統計処理
5. 既知パターン照合
6. キャッシュ
7. 小型またはローカルモデル
8. 高性能AIモデル

高性能AIモデルは最後の選択肢とする。

---

# 4. Token Budget

Diagnosis、Research、Experiment、Evolutionが利用できるAIトークンは、通常業務とは別に管理する。

初期目標は、AI Team OS全体の月間AIトークン消費量の1〜3%以内とする。

原則として5%を超えてはならない。

上限到達時は、以下の順に処理する。

1. AI診断を停止
2. Rule-based Diagnosisのみ継続
3. 次回予算リセットまで待機
4. Critical IssueのみCEO承認で実行

---

# 5. AI Invocation Gate

AI Diagnosisは以下の場合のみ実行する。

- Critical Issue
- 異常が一定期間継続
- 複数指標が同時に悪化
- 既知ルールで原因を特定できない
- CEOが明示的に要求
- 承認済みExperimentで非構造評価が必要

軽微または一時的な異常ではAIを呼び出さない。

---

# 6. Context Minimization

AIへ生Telemetryを直接渡してはならない。

AIへ渡す情報は以下に限定する。

- 集計値
- Baselineとの差分
- 影響対象
- 変更履歴
- 最小限の失敗例
- 関連する仕様
- 既知診断結果

重複情報、正常ログ、不要な会話履歴を含めない。

---

# 7. Sampling

AIによる品質評価は、原則としてサンプリングで行う。

通常時は1〜2%、異常時は5〜10%、Experiment時は10〜20%を初期値とする。

全件AI評価はCritical変更など必要な場合に限定する。

---

# 8. Caching and Deduplication

同一または類似Issueの診断結果を再利用する。

以下を保持する。

- Issue Fingerprint
- Previous Diagnosis
- Applied Resolution
- Experiment Result
- Cooldown Period

状態が変化していない場合、同一Issueに対してAI診断を繰り返してはならない。

---

# 9. Deterministic Evaluation

Experimentの以下の評価は通常コードで行う。

- 成功率
- 実行時間
- Token使用量
- Cost
- Retry率
- Test Pass Rate
- Error Rate
- CEO介入率

AI評価は、文章品質、論理性、設計品質など数値化困難な項目だけに使用する。

---

# 10. Model Selection

低複雑度の処理には、ローカルまたは低コストモデルを優先する。

高性能モデルは以下に限定する。

- 複数原因の複雑な分析
- Architecture変更
- 安全性に関わる改善
- Core Evolution
- 高重要度の非構造評価

---

# 11. Frequency

AI Diagnosisを定期的に無条件実行してはならない。

定期処理は通常コードによる集計とルール判定までとする。

AI処理はEvent-drivenかつBudget-controlledで実行する。

---

# 12. Fail-Safe

AI診断予算がなくても通常業務は継続できなければならない。

AI Diagnosis、Planner、Research、Experiment、Evolutionが停止しても、通常のTeam Workflow、Approval、Security、
Telemetryは継続する。

---

# 12b. Rubric生成・Knowledge Consult・Investigate・Distill・Loop Metricsへの適用

外部のAgent Loop的な設計思想（`specs/13_future_system_architecture.md` 5b章参照）を導入する際も、
本ドキュメントの既存原則をそのまま適用する（新しい例外は設けない）:

- Rubric生成はPlannerが必要時（Project/Task作成時）にのみ行う。定期的な無条件生成はしない（11章）
- Knowledge Consultは関連するRuleだけを検索・抽出する。全文を渡さない（6章）
- InvestigateはAI Invocation Gate（5章）の条件（Critical Issue・異常継続・既知ルールで原因不明等）に
  従って発動する。Retry複数回の継続もこの発動条件の一種として扱う
- Distillは全ログを毎回AI処理しない。Caching and Deduplication（8章）に従い、同一Issueへの重複処理を避ける
- Loop Metrics（Retry回数・Rubric達成率等）は原則Telemetry/SQL/通常コードで集計する（Deterministic
  Evaluation、9章と同じ扱い）。AIを使うのは非構造判断・原因分析が必要な場合に限定する

---

# 13. MVP段階での適用（本プロジェクト固有の注記）

現段階（MVP開発中）では、本ドキュメントが対象とするDiagnosis / Research / Experiment / Evolution機能自体が
未実装のため、本ドキュメントは実装方針としてはまだ適用されない。

ただし、将来の比較可能性を確保するため、**最低限のTelemetry記録はMVP段階から行う**方針とする
（既存実装: `apps/worker/src/executionLogStore.ts`, `apps/worker/src/approvalLevel/observationLog.ts`）。
これらの拡張・本格連携はMVP後のタスクとして `tasks/roadmap.md` に記載する。

---

# 14. 関連ドキュメント

- 最上位思想: `specs/00_constitution.md`
- 将来のCore/Extension構造: `specs/13_future_system_architecture.md`
- 現在実装済み機能ベースライン: `docs/PROJECT_CURRENT_STATE.md`「Implemented MVP Baseline」
- MVP後の実装タスク: `tasks/roadmap.md`
