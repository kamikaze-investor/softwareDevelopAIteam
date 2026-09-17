# Safety / Approval 設計原則の採用と、現行実装のギャップ実測（2026-09-17）

**Status: active**
**判断者: CEO（2026-09-17 指示）**

---

## 1. 何が決まったか

AIteamOS の今後の Safety / Approval 設計原則として、CEO が次を採用した。
正本は **`specs/22_safety_approval_design_principle.md`**、`specs/00_constitution.md` 3.18 から参照する。

要点:

- **目的は CEO 承認を減らすことではない。** 間違いを起こしにくくし、起きても影響を小さくし、
  すぐ気づき、すぐ戻せるようにすることで、**AI が安全に自律実行できる範囲を広げる**ことが目的である
- Human Approval は**最後の Safety Boundary**であり、通常の Safety mechanism にしない
- Safety は 8 層の多層防御で作る。どれか1つを単独の根拠にしない
- Risk は変更内容だけでなく **blast radius / detectability / recoverability / irreversibility** も見る
- AI の自己申告した risk level で Gate・Review・Approval・Isolation・Rollout 制限を弱めない
- Recoverability は**実装前に**確認する。Monitoring は**変更後の Review** として扱う
- 実装は既存機構の改善・統合を優先し、**新しい Safety subsystem を先に作らない**

## 2. この採用によって「変えていない」もの（重要）

**Gate・Approval・Guard・Permission のコードは1行も変更していない。**
本件は原則の記録と、現行実装とのギャップの実測のみである。

現行有効のまま維持したもの:

- `docs/project_memory/rules/approval_rules.md` の Yellow Zone（ポインタを足しただけ）
- `docs/multi_ai_step_review_flow.md` 10章 リスク分類 / 13章 CEO 承認必須リスト（無変更）
- `CLAUDE.md` 4章 Authority Principle の Zone 区分（ポインタを足しただけ）
- `tasks/roadmap.md` `review-class-b-enhanced-ai-review` の `state=deferred` と着手手順

**CEO が与えたのは Class A/B/C の定義であって、`review-class-b-enhanced-ai-review` の
着手手順 1 が要求する「具体例つき境界表」とその承認ではない。** よって同項目は `deferred` のままとする。

## 3. 8 層防御の実測結果（2026-09-17）

推測ではなく各ファイルを実際に読んで確認した。Risk 5 次元の 0/4 は
`apps/` + `packages/shared/` 全体への grep が 0 件であることによる。

| 層 | 状態 | 根拠 |
|---|---|---|
| 1 Isolation | 実装済み・配線済み | `runContainedOrThrow`（cgroup v2）/ `isInsideTargetRoot()` / `buildTargetCommandEnv()` |
| 2 Simulation / Preflight | **部分的** | `adapter.ts:420` の `dryRun` は `exitCode:0` / `changedFiles:[]` を即返すだけ。diff を作らず Gate にも当てない |
| 3 Mechanical Validation | 実装済み・配線済み | `runMechanicalGate` / `MECHANICAL_GATE_PATTERNS` / `runPolicyGuard` / `runRiskReview` |
| 4 Independent Multi-Model Review | 実装済み・配線済み | `isGeneratorSeparatedFromFinalReviewer()` / `runIndependentReview`（vendor 分離） |
| 5 Test / E2E | 実装済み（CI 強制は本 checkout では未確認。`.github/workflows/` が無い） | worker の `typecheck` / `test` / `lint` gated command |
| 6 Limited Rollout | **部分的** | `deployCanary.ts` は reviewer 経路の単発チェック。feature flag / 段階配信は無い |
| 7 Runtime Monitoring | 実装済み・配線済み | `startWatchdog()`（30秒周期）/ `checkStall()` / `watchdogEvents` |
| 8 Fast Rollback / Recovery | 実装済み・配線済み | `revertBlockedJobChanges()` / `rollbackInfo.rollbackArgv` / `rollback_commit` は CEO gate |
| 原則 8 章: 実行前の Recoverability 確認 | **無い** | `rollbackInfo` は commit **後**に記録。`authorizePlAction()` は rollback path の有無を入力に持たない |
| 原則 11 章: 事故→Learning | **部分的** | Incident DB と Context Pack 同梱まで。test / prompt / classifier を自動更新する経路は無い |

**Risk 5 次元**: `blast radius` / `detectability` / `recoverability` / `irreversibility` は
**4 つとも実入力として存在しない**（型・フィールド・概念のいずれとしても 0 件）。

- `classifyReviewLoad()` の入力は `{ changedFiles }` のみ
- `resolvePolicy()`（`gatePolicy.ts`）は上流で算出済みの `riskLevel` / `decision` しか見ない
- `analyzeChangeImpact()` は**変更の大きさ**（ファイル数・増減行数）で risk を出す。blast radius ではない
- `runRiskReview` / `RISK_RULES` はファイル**名**への正規表現のみ
- action kind enum（`rollback_commit` / `deploy_production` / `change_safety_boundary`）が
  irreversibility に最も近いが、**入力ではなくハードコードされた対応表**である
- `plRiskOpinion` は `requiredGates` の算出から明示的に除外されている（原則 7 章の不変条件は既に成立）

**つまり、8 層のうち "起きにくくする / 気づく / 戻す" は概ね揃っており、
欠けているのは "リスクを測る次元" と "戻せることを事前に確かめる工程" である。**

## 4. 登録した Roadmap 項目（すべて `deferred`。自動採用されない）

`isRoadmapItemAdoptable()` による `planned` のみの allowlist が3経路すべてに効いているため、
`deferred` 登録は PL の自律採用を機械的に止める（2026-09-17 確認）。

- `recoverability-precheck-before-risky-change` — 実行前の rollback path 確認（原則 8 章）
- `dry-run-does-not-simulate` — dry-run が simulation になっていない（原則 2 章 第2層）
- `staged-rollout-absent` — 段階投入が無い（原則 4 章）。**外部顧客が存在するまで着手しない**

Risk 5 次元の不足は `review-class-b-enhanced-ai-review` の scope に追記した（重複項目を作らない）。
事故→Learning は `project-auto-incident-pattern-improvement`（planned）が担当する（重複登録しない）。

## 5. Lessons

- **8 層の欠落は均等ではなかった。** 事前に予想されたのは「監視と rollback が弱い」だったが、
  実測では監視も rollback も配線済みで、欠けていたのは **risk をどう測るか**の側だった。
  「安全機構が足りない」ではなく「安全機構への入力が貧しい」が実態である
- **`deferred` の強制について、roadmap 内に 2026-09-15 時点の古い記述が残っていた**
  （「`deferred` は採用を止めない」）。2026-09-16 に allowlist 化されて事実でなくなっていたため訂正した。
  実測で更新した記述は、更新日を添えて上書きしないと次の判断を誤らせる
