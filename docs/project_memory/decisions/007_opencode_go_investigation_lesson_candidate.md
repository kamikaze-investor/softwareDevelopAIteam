# Decision-007: Risk-weighted Progress（credible worst caseに基づく停止/継続判断）— Lesson Candidate

**Importance Level: 2**
**Status: lesson_candidate（正式Ruleではない）**
**Date: 2026-08-12（初版）／2026-08-13（Risk-weighted Progressへ更新）**

---

## これは何か

これは正式な開発Decision/Ruleではなく、**Lesson Candidate**（教訓候補）の記録である。
将来Self Diagnosis Framework / Improvement Planner / Distill（`specs/13_future_system_architecture.md`
5b-4〜5b-10）が実装された段階で、本記録をEvidenceの1つとしてCEO Proposalの材料に使うことを想定する。
**本記録の内容を、この記録をもって直ちに正式Ruleとして適用しない。**

以下のRED/YELLOW/GREENは、**Lesson Candidate内で考え方を検証するための仮のトリアージラベル**であり、
現段階では正式なRisk PolicyでもRisk分類体系でもない。将来CEO ProposalでOperationalizeされるまでは、
新しいGate・自動停止Policy・新しいRisk classifier・全Project共通defaultとして実装・適用してはならない。

## 既存Risk分類との違い（混同防止）

`docs/multi_ai_step_review_flow.md` 11章の Low/Medium/High Risk分類は、
**「これから行う変更にどれだけのReview Levelが必要か」を決める分類**（変更前のレビュー深度ルーティング）
であり、本Lesson Candidateとは目的・トリガーが異なる。

本Lesson Candidateが扱うのは、**「既に遭遇している問題を放置して本線を継続してよいか」を判断する
障害トリアージ**である。11章の分類を置き換えるものでも、新しい分類軸を正式に追加するものでもない。

---

## Observation（第1件・2026-08-12: OpenCode Go統合作業）

OpenCode Go（DeepSeek V4 Flash系）をCheap AIとして接続するという比較的小さいMVP作業が、次のように拡大した。

- raw REST API（`https://opencode.ai/zen/go/v1/chat/completions`）が401 Invalid API keyを返す原因調査
- model / hosting policy（China-hosted opt-in等）の切り分け
- secret安全性確認（isolated HOME/workdir、env allowlist、permission:deny設定の検証）
- raw `fetch()`からCLI transportへの切り替え設計・実装・レビュー
- pnpm install環境問題（`allowBuilds`プレースホルダ不正、stale dev-serverプロセスによる長時間ハング）
- better-sqlite3のNODE_MODULE_VERSION不整合によるAPIテスト大量失敗の原因調査
- live smoke test（VPS上でのcold/warm実測）
- timeout値調整（30秒→60秒への変更とその実測根拠収集）

各確認自体には個別の合理性があったが、結果としてMVP本線（Cheap AI接続という本来のTask）の完了までの
所要時間が大幅に伸びた。

## Observation（第2件・2026-08-13: production DB取り違え）

Worker Outbox機能のproduction deploy検証中、production APIから見えるProject/Task/Jobが0件になり、
過去に実在したはずのknown TaskがAPI経由で404となった。調査の結果、API processが誤った空DBファイルを
参照しており、実データは別ファイル（WALサイドカーに実データが残ったまま本体ファイルだけをcpしていた
ための不完全backupを含む）に存在していたことが判明した。

---

## Lesson Candidate: Risk-weighted Progress

### Core idea

問題に遭遇した際、まず**credible worst case**（現在のEvidenceから合理的に想定できる最悪ケース。
理論上あり得る極端な最悪ケースではない）を考える。credible worst caseの深刻さに応じて、
本線を止めるか・時間を区切って調べるか・記録だけして進むかを判断する。

### Evaluation axes（4軸。数値スコア化はしない）

- **Damage Depth / Impact**: 問題が顕在化した場合の被害の深さ（例: LOW=UI崩れ・軽微な性能低下、
  MEDIUM=一部機能停止・Task失敗、HIGH=production機能停止・データ不整合、
  CRITICAL=データ消失・Secret漏洩・権限境界突破・復旧不能級障害）
- **Blast Radius**: 影響範囲（例: 1 operation → 1 Job → 1 Task → 1 Project → 全Project →
  production全体 → 外部ユーザー/外部service）
- **Recovery Cost / Irreversibility**: 元へ戻す難易度（復旧時間・修正難易度・手作業量・rollback可否・
  backup restore要否・復旧方法が既知か未知か。例: LOW=再実行/再起動ですぐ戻る、
  MEDIUM=コード修正・再deploy必要、HIGH=DB restore・多数データの手修正、
  CRITICAL=正本不明・backupなし・完全復旧不能の可能性）
- **Evidence / Decision Confidence**: 「被害量」ではなく、安全に進んでよいと判断できるEvidenceの強さ
  （例: HIGH=test済み・production smoke済み・backupあり・restore方法確認済み・fallback実測済み、
  LOW=原因不明・production状態不明・正本不明・rollback未確認・推測だけで安全判断している）

概念的には次のように**分けて**扱う（固定の数式には落とし込まない）。

```
Consequence         = Impact × Blast Radius × Recovery Cost
Decision Confidence = Evidence
```

Evidenceが弱く、かつConsequenceが大きいほど、慎重側（停止・確認優先）へ倒す。
発生確率は現時点では複雑にスコア化しないが、**発生確率が低くてもcredible worst caseが壊滅的
（全production data消失・Secret公開・権限突破・復旧不能等）であればRED判定を可とする**。

### Candidate triage labels（仮ラベル。正式Policyではない）

- **RED — Stop**: credible worst caseが重大で、安全性・データ完全性・Security・権限・production
  continuityへ深刻な影響を与える可能性がある。本線を停止して確認する。既存Safety Policyの範囲内で
  判断できるなら、CEOへ技術判断を丸投げせずAI側で停止してよい。ただしGoal/Philosophy/Policy変更が
  必要な場合は既存Human Approvalルールに従う。
- **YELLOW — Time-box / Fallback**: 問題は存在するが、safe fallbackが存在する・rollback可能・
  blast radiusが限定的・recovery costが低い等の場合。一定範囲だけ調査し、原因解明できなければ
  安全なfallbackを採用してroot cause investigationはbacklog/lessonへ送り、本線を無期限に止めない。
- **GREEN — Defer**: 失敗しても局所的・可逆・低Recovery Cost・production safetyへ影響しない問題。
  必要なら記録するだけでMVP/current priorityを継続する。

### Examples

**OpenCode raw API 401**:
初期状態はYELLOW（raw APIが使えない原因不明）。その後、公式OpenCode CLI + mimo-v2.5が実環境で
正常動作するsafe fallbackとして実測確認された。この時点で「GREEN寄りのYELLOW」と評価し、
raw API root cause investigationを延期して本線（CLI transportでのCheap AI接続）へ復帰した。

**Production DB取り違え**:
production APIからProject/Task/Jobが0件に見え、過去に存在したknown Taskが404だった。
credible worst caseとして「新旧DBへproduction dataが分裂し、どちらが正本か分からなくなる／
Job/Task state不整合／rollback困難／data lossにつながる可能性」を想定し、**RED**と判定。
本線（Outboxのproduction E2E確認）を停止し、DB identity・backup・continuityの確認を優先した。
この停止判断を、Risk-weighted Progressの正しい適用例として記録する。

### CEOへの表示（将来実装時の表示例。今回は実装しない）

```
Risk: RED

Credible worst case:
Production DBが分裂し、正しいデータを判定できなくなる可能性があります。

Damage Depth: Critical
Blast Radius: All Projects / Production
Recovery Cost: High / Unknown
Evidence: Low

Recommended Action:
自動停止してDB identityを確認。

CEO Decision:
既存Safety Policy内なら不要。Policy/Goal/Design Philosophy変更ならCEO承認。
```

## Exception（RED判定の具体例。安易に後回しにしない対象）

以下に該当する場合は、safe fallbackが存在してもYELLOW/GREEN側へ倒さず、RED（本線停止・確認）を
優先する。

- secret漏洩疑い
- DB破損 / データ喪失 / DB正本不明
- Trust Boundary破綻
- security incident
- 権限境界の異常
- rollback不能なproduction変更
- 高確率で再発する重大障害
- 発生確率が低くても、credible worst caseが壊滅的（全production data消失・Secret公開・権限突破・
  復旧不能等）なもの
- 後回しにすると安全性・品質を維持できない問題

## Status / Governance

これは現時点では**正式な開発Ruleではなく「Lesson Candidate」**である。RED/YELLOW/GREENも同様に、
Lesson Candidate内の仮トリアージラベルであり、正式なRisk Policyや分類体系ではない。

正式Rule化する場合は、将来実装されるSelf Diagnosis / Improvement Planner / Distill等の自己改善ループ
（`Observation → Lesson Candidate → Evidence蓄積 → Improvement Proposal → CEO明示承認 →
Operationalize`）を通じてCEO Proposalとして提示し、CEOの明示承認後にのみOperationalize（Rule /
Prompt / Workflow / Roadmap等への正式反映）する（`specs/13_future_system_architecture.md`
5b-5の改訂内容を参照）。AIがこのLesson Candidateを根拠に自動で正式Ruleへ昇格させてはならない。

Rule / Prompt / Workflow / Roadmap / Constitution / Goal / Design Philosophy / Security Policy /
Approval Policy / Risk Policy / Model・Data Policy / AIの自動実行可能範囲 / 全Project共通defaultの
いずれかを変更する場合は、変更規模にかかわらず**毎回例外なくCEO Proposalとして提示し、CEOの明示
承認を得てから変更する**。本記録自体はConstitutionやWorkflowへ即座に正式Ruleとして追加するもの
ではなく、新しいGate・自動停止Policy・新しいRisk classifierとして実装するものでもない。

---

*Created by: Claude Code — OpenCode Go Cheap AI統合作業の振り返り（CEO指示によるLesson Candidate記録）*
*Updated by: Claude Code — production DB取り違え事例を踏まえ、Risk-weighted Progressへ拡張（CEO指示）*
