# AI Development Team OS — 設計思想と全体構想

**作成日**: 2026-06-30
**作成者**: CEO主導 / AI Assistant補助
**位置付け**: 全実装判断の上位にある設計思想・将来構想の記録
**対象読者**: CEO・AIエージェント全員

---

## 本ドキュメントの目的

このドキュメントは、AI Development Team OSの「何を作るか」ではなく「なぜその設計にするか」と「将来どこへ向かうか」を記録するものです。

個別機能の実装仕様は `specs/` ディレクトリを参照してください。
現在の実装状況は `docs/PROJECT_CURRENT_STATE.md` を参照してください。
本ドキュメントに書かれた設計思想は、AIが実装判断をする際の前提として機能します。

---

## 関連ドキュメントとの関係

| ドキュメント | 用途 |
|---|---|
| `specs/01_vision.md` | Mission・North Star Goal |
| `specs/03_system_architecture.md` | 技術コンポーネント構成（v1.0） |
| `docs/project_memory/design_philosophy.md` | 実装時の7原則（短文・AI参照用） |
| `docs/PROJECT_CURRENT_STATE.md` | 現在の実装状況スナップショット |
| **本ドキュメント** | 設計思想の進化・将来構想の全記録 |

---

# 第1弾：今後すべての実装判断の前提となる設計思想

第1弾の項目は「今すぐ実装する機能」ではありません。
今後 Approval Gate・AI CLI接続・Dashboard・Knowledge Graph のどれを実装する場合も、この設計思想を前提として設計・実装してください。

---

## 1. AI Session Architecture

**実装状態**: 未実装（将来構想）

### 説明

AIがただ単発でコードを書くのではなく、各作業を「セッション」として定義・追跡する設計思想です。
1つの AI Session は独立した作業単位であり、開始・実行・完了・引き継ぎまでを一括して管理します。

### 狙い

- AI作業を後から追跡できるようにする
- 中断・再開・引き継ぎを安全にする
- AIが何を根拠に作業したかを残す
- セッションごとの成果と失敗を Knowledge Graph に接続する
- 長いチャットや長期開発で文脈が壊れる問題を減らす

### 含めるべき概念（将来実装時のフィールド候補）

```
sessionId           — セッションの一意ID
goal                — このセッションの目的
assignedAgent       — 担当AIエージェント
inputContext        — 開始時に参照した情報
touchedFiles        — 変更したファイル一覧
decisionsMade       — セッション内で行った判断
testsRun            — 実行したテストと結果
result              — 成果（success / failed / partial）
unresolvedItems     — 未解決事項
nextHandoff         — 次のセッションへの引き継ぎ内容
relatedKGNodes      — Knowledge Graph の関連ノード
```

### 現在の代替手段

現在は Claude Code のセッション履歴と git のコミットログで代替しています。
AI Session Architecture が実装されると、これらを構造化データとして KG に接続できます。

---

## 2. Project Timeline Map の役割定義

**実装状態**: 未実装（KGのノード・エッジは部分実装済み）

### 説明

Project Timeline Map は単なるロードマップや TODO リストではありません。
プロジェクト内で起きた出来事・提案・判断・実装・テスト・失敗・修正・保留・承認を時系列で把握するためのビューです。

`roadmap.md`（これから何をやるか）とは目的が異なります。
Timeline Map は「これまで何が起き、なぜ今この状態なのか」を理解するためのものです。

### 狙い

- プロジェクトの歴史を見える化する
- なぜその設計になったのかを後から追えるようにする
- AIが過去の判断を無視して同じ議論を繰り返すことを防ぐ
- CEOがスマホから現在地を直感的に理解できるようにする
- Knowledge Graph上の出来事を時系列ビューとして表示する

### 含めるべきイベント種別（将来実装時の候補）

```
proposal_created / decision_made / feature_started / feature_completed
approval_requested / approval_approved / approval_rejected
test_failed / test_passed
incident_detected
technical_debt_created / debt_resolved
session_started / session_completed
```

### 現在の代替手段

`logs/dev-sessions/` の手動ログと `docs/PROJECT_CURRENT_STATE.md` で代替しています。
KG のエッジ（depends_on / blocks 等）はすでに実装済みですが、時系列ビューとしての表示は未実装です。

---

## 3. Team Template の役割定義

**実装状態**: 未実装（将来構想）

### 説明

Team Template は、AIチームの構成・役割・権限・責任範囲・レビュー方針・承認ルール・判断基準を再利用するための設計単位です。
単なるプロンプトテンプレートではありません。

たとえば「プロダクト開発チーム」「投資分析チーム」「デバッグ専用チーム」など、目的ごとに AI チーム編成を変えられるようにします。

### 狙い

- プロジェクトごとに適切な AI チーム構成を再利用できるようにする
- どの AI が実装し・レビューし・どこで CEO 承認が必要かを定義する
- チームごとの安全ポリシーや品質基準を持たせる
- 同じ役割混乱や曖昧な責任分担を繰り返さない

### 含めるべき概念（将来実装時のフィールド候補）

```
teamTemplateId / teamPurpose
agents / agentRoles / allowedActions
approvalRules / reviewRules / escalationRules
defaultWorkflow / requiredArtifacts / qualityBar
```

### 現在の状態

現在は単一チーム（Claude Code + Codex + Gemini）の固定編成です。
`AGENTS.md` と `CLAUDE.md` が役割定義の代替として機能しています。

---

## 4. Knowledge Graph を中心記憶とする設計

**実装状態**: 部分実装済み（ノード・エッジ・health-score・health API 実装済み。gate 結果の KG 書き込みは未実装）

### 説明

Knowledge Graph は補助的な記録 DB ではなく、AI チーム OS の中心記憶として設計します。
タスク・機能・判断・提案・技術的負債・インシデント・セッション・ファイル・ドキュメント・承認履歴をすべて関連付けて保存し、AI が次に何をすべきか判断するための中核情報源にします。

### 狙い

- AI が毎回ゼロから文脈を読み直す必要を減らす
- 提案・判断・実装・テスト・失敗・改善をつなげて扱う
- Timeline Map・Dashboard・Health Score・Approval Gate の共通基盤にする
- CEO が非エンジニアでもプロジェクト状態を把握できるようにする

### 実装済みのノード種別

```
feature / phase / task / decision / incident / file / doc
```

### 将来追加予定のノード種別

```
project / proposal / ai_session / approval_request
technical_debt / test_result / agent / team_template
```

### 実装済みのエッジ種別

```
depends_on / blocks / related_to / belongs_to / impacts
```

### 将来追加予定のエッジ種別

```
caused_by / decided_by / implemented_by / reviewed_by / approved_by
supersedes / created_in_session / modifies_file
```

---

# 第2弾：Timeline Map完成後に追加するLifecycle設計

第2弾は Timeline Map が機能してから追加する Lifecycle 管理です。
これらはすべて「状態の変化」と「時間の流れ」を扱うため、Timeline Map とセットで設計・実装します。

---

## 5. Proposal Lifecycle

**実装状態**: 未実装（将来構想）

### 説明

AI や CEO が出した提案を、チャットの中で流さずに追跡する仕組みです。
提案は作成・検討・採用・却下・保留・実装化・撤回・再提案といった状態を持ちます。

### 狙い

- 良い提案がチャット内で埋もれることを防ぐ
- 却下した理由を残して同じ提案を繰り返さない
- 採用された提案をタスクや機能へ接続する
- CEO が後から「なぜこれをやることになったか」を追えるようにする

### 状態定義（将来実装時の候補）

```
PROPOSED / UNDER_REVIEW / ACCEPTED / REJECTED
DEFERRED / CONVERTED_TO_TASK / WITHDRAWN / SUPERSEDED
```

---

## 6. Decision Lifecycle

**実装状態**: 部分実装（`docs/project_memory/decisions/` に手動記録あり。自動追跡は未実装）

### 説明

重要判断を単なるメモではなく追跡可能な意思決定として管理する仕組みです。
判断には背景・選択肢・採用案・却下案・理由・影響範囲・見直し条件を含めます。

### 狙い

- なぜその判断をしたかを未来の AI が理解できるようにする
- 判断の前提が変わったときに見直せるようにする
- CEO 承認が必要な判断と AI が自動でよい判断を分離する
- 後から失敗した判断を学習材料にする

### 状態定義（将来実装時の候補）

```
DRAFT / NEEDS_CEO_DECISION / DECIDED / REVISIT_REQUIRED / REVERSED / SUPERSEDED
```

---

## 7. Feature Lifecycle

**実装状態**: 未実装（将来構想）

### 説明

機能を構想から運用まで追跡する仕組みです。

### 狙い

- 機能がどこまで進んでいるかを明確にする
- 実装済みだがテスト未完、テスト済みだがドキュメント未更新などの状態を見える化する
- Timeline Map や Dashboard で進捗を追いやすくする
- AI が未完成機能を完成済みと誤認するのを防ぐ

### 状態定義（将来実装時の候補）

```
IDEA / SPEC_DRAFT / READY_FOR_IMPLEMENTATION / IN_PROGRESS
CODE_REVIEW / TESTING / DONE / RELEASED / NEEDS_REVISION / DEPRECATED
```

---

## 8. Technical Debt 管理

**実装状態**: 未実装（ADR・コードコメントによる手動記録のみ）

### 説明

意図的に後回しにした修正・不完全な実装・暫定対応・リファクタ候補・テスト不足・ドキュメント不足を管理する仕組みです。
重要なのは「なんとなく残す」のではなく、理由・影響・返済条件・リスクを記録することです。

### 狙い

- 暫定対応が放置されるのを防ぐ
- どの負債が安全性・保守性に影響するかを把握する
- MVP 優先で後回しにしたものを後から回収できるようにする
- AI が過去の妥協を忘れないようにする

### 含めるべき項目（将来実装時のフィールド候補）

```
debtId / title / reason / affectedFiles / riskLevel
createdBecause / repaymentCondition / owner / status / duePhase
```

### 状態定義（将来実装時の候補）

```
OPEN / ACCEPTED / SCHEDULED / IN_PROGRESS / RESOLVED / WONT_FIX / EXPIRED
```

---

# 第3弾：MVP完成後に追加する高度な運用制御（将来構想）

第3弾は MVP 完成後に検討する高度な運用制御です。
今すぐ実装する必要はありません。ただし将来の設計時に一からやり直さないよう、ここに記録します。

---

## 9. AI Reliability

**実装状態**: 未実装（将来構想）

### 説明

AI エージェントの信頼性を測定・改善する仕組みです。
AI がどれくらい正確に作業したか・どれくらいレビューで指摘されたか・どれくらい手戻りが発生したか・どの種類のタスクで失敗しやすいかを記録します。

### 狙い

- AI ごとの得意不得意を把握する
- 自動実装の信頼度を数値化する
- 重要タスクに適した AI を選ぶ
- 同じ AI に同じ失敗を繰り返させない

### 指標例（将来実装時の候補）

```
taskSuccessRate / testPassRate / reviewIssueRate / rollbackRate
humanInterventionRate / hallucinationRisk / repeatedFailureCount
```

---

## 10. KPI（AIチームOS自体の成果指標）

**実装状態**: 未実装（将来構想）

### 説明

AI チーム OS が本当に役立っているか判断するための指標です。
機能が増えたかではなく、CEO の作業時間が減ったか・実装速度が上がったか・手戻りが減ったか・安全性が上がったかを見るために使います。

### 狙い

- AI チーム OS が本当に役に立っているか判断する
- 改善の優先順位を決める
- 自動化による効果を可視化する
- MVP 以降の投資判断に使う

### 指標例（将来実装時の候補）

```
timeSavedByAI / tasksCompletedPerWeek / averageCycleTime
approvalWaitTime / defectRate / reworkRate
CEOInterventionCount / automationCoverage / projectHealthScore
```

---

## 11. Conflict Management

**実装状態**: 未実装（将来構想）

### 説明

AI 同士・AI と CEO・仕様と実装・過去判断と現在判断が衝突したときに扱う仕組みです。
AI が互いに違う提案をしたり、過去の決定と矛盾する実装をしようとしたり、CEO 方針と AI 提案がズレた場合に、衝突として記録・整理します。

### 狙い

- 矛盾を見逃さずに扱う
- AI が勝手に過去方針を上書きしないようにする
- CEO 判断が必要な衝突を明確にする
- 仕様変更なのか、バグなのか、認識違いなのかを分ける

### 衝突種別例（将来実装時の候補）

```
requirement_conflict / design_conflict / implementation_conflict
agent_opinion_conflict / ceo_policy_conflict / timeline_conflict / dependency_conflict
```

---

## 12. Learning Control

**実装状態**: 未実装（将来構想）

### 説明

AI が何を記憶し、何を次回以降に反映してよいかを制御する仕組みです。
すべての出来事を無条件に学習すると、古い判断や一時的な例外が恒久ルールになってしまう危険があります。
そのため、学習対象・反映範囲・有効期限・CEO 承認の要否を管理します。

### 狙い

- 一時的な判断を永続ルールにしない
- AI が間違った学習をしないようにする
- CEO の設計思想と AI の自動改善を分離する
- チームテンプレートや KG への反映を制御する

### 含めるべき概念（将来実装時の候補）

```
learningCandidate / sourceEvent / confidence / scope
expiry / requiresApproval / appliedTo / rollbackLearning
```

---

## 13. Rollback（広義）

**実装状態**: 専用 Rollback 機能は未実装。コード変更は git revert 等の通常 Git 操作で対応可能。広義の Rollback は将来構想。

### 説明

失敗した実装・判断・設定変更・AI 学習・チームテンプレート変更を安全に巻き戻す仕組みです。
コードの git revert だけでなく、判断・KG ノード・Timeline イベント・Team Template・AI Session の結果も巻き戻し対象として考えます。

### 狙い

- AI が失敗しても安全に元に戻せるようにする
- 何を戻すべきかを明確にする
- コードだけ戻して、ドキュメントや KG が古いままになる事故を防ぐ
- CEO がスマホから「この変更は戻す」と判断できるようにする

### 対象例（将来実装時の候補）

```
code_change / config_change / decision / kg_node / kg_edge
team_template_change / learning_rule / approval_state / documentation_change
```

---

## 14. AI Runtime State

**実装状態**: 関連する個別状態は部分的に存在するが、AI Runtime State として統一管理する仕組みは未実装。

### 説明

AI エージェントが現在どの状態で動いているかを統一的に把握する仕組みです。
AI が通常作業中なのか・承認待ちなのか・安全作業のみ許可されているのか・停止中なのか・再試行中なのか・エラー状態なのかを明確にします。

### 狙い

- AI が今何をしているか CEO が把握できるようにする
- safe_work_only や approval waiting 状態を明確にする
- Watchdog や Dashboard と連携する
- AI が中途半端な状態で勝手に次へ進むことを防ぐ

### 状態定義（将来実装時の候補）

```
IDLE / RUNNING / WAITING_FOR_APPROVAL / SAFE_WORK_ONLY
BLOCKED / RETRYING / FAILED / PAUSED / COMPLETED / CANCELLED
```

### 現在の代替手段

Watchdog による停滞検出・Approval Gate の WAITING 状態・jobRunner 内の continuationPolicy で部分的に実装済みです。
統一ランタイム状態管理 API は未実装です。

---

*作成日: 2026-06-30*
*作成者: CEO主導 / AI Assistant補助*
*ステータス: 設計構想文書。実装状態は各項目に明記*
