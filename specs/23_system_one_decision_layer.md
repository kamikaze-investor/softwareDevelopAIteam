# System One Decision Layer 設計原本

---

# 0. 本ドキュメントの位置づけ（最初に読むこと）

本ドキュメントは **System One Decision Layer の恒久的な設計正本**である。
「なぜ作るか・どんな責務境界で作るか・何を作らないか」を定める。

| | 正本 |
|---|---|
| 設計思想・責務境界・Authority 境界・層の分離 | **本ドキュメント** |
| 何をどの順番で実装するか | `tasks/roadmap.md` |
| 最初の実装（Principle 版）の設計判断と経緯 | `docs/project_memory/decisions/principle_management_design_2026_09_17.md` |
| Question ごとの実測精度・閾値・latency 等の運用値 | 実測データと `PRINCIPLE_SENSOR_THRESHOLDS` の doc comment（本ドキュメントへ埋めない） |
| Question（原則）本文・choices・criteria の実体 | Git（`specs/21` の marker）。本ドキュメントは category と設計規則だけを持つ |

**本ドキュメントは既存の Authority / Zone / Gate / Approval / Safety Boundary を1つも緩めない。**
`CLAUDE.md` 4章の Zone 区分、`specs/22_safety_approval_design_principle.md`、
既存 Multi-stage Review、Mandatory Gate はそのまま優先する。

**本ドキュメントは特定の外部 Decision Engine（Jev 等）の採用を承認するものではない。**
外部サービス追加・課金は `CLAUDE.md` 4章の Yellow Zone であり、CEO 承認が別途必要である（4章・15章）。

## 0-1. 最重要の事実: 第一号は既に本番稼働している

**System One は「これから作るもの」ではない。** その最初の実例である
**Principle Compliance は 2026-09-17 に実装・merge され、production で稼働している**
（read-only audit 実施日 2026-09-21、基準 commit `606e5d3`）。

具体的に、本ドキュメントが要求する中核は既に存在する。

| 本ドキュメントの要求 | 既存実装 |
|---|---|
| Question Library（狭く定義された反復判断の集合） | `specs/21` の 11 principles（`principle-id` / `-category` / `-scope` / `-tier` / `-tags` marker） |
| Question version hash | `versionHash`（**本文から算出**。手書き版番号を持たない。CRLF / LF 差では変わらない） |
| SELECT | `selectPrinciples()`（`core` / `contextual` / `risk` / `explicit` の selectionSource と selectionReason と版を返す） |
| NORMALIZE | `normalizeAppliedPrinciples()`。判定語彙は `StrategicDecision` を再利用し第二の enum を作らない |
| MEASURE | `principle_applications` table、`GET /api/principles/stats`、`findDisagreements()`、`countStageComparisons()` |
| Reviewer disagreement | 同一 subject・同一原則に対する **stage 間**（`design` / `independent` / `meta`）の判定差 |
| Non-discriminating question 検出 | sensor `core-principle-never-conflicts`（50件）/ `principle-review-not-discriminating`（200件） |
| 閾値そのものの自己再評価 | sensor `threshold-policy-needs-real-data-review`（100件）+ `thresholdPolicyVersion()` |
| 記録が Gate にならないこと | `recordPrincipleApplications()` は例外を握って warn するだけ。`appliedPrinciples` を required schema に入れない |

したがって本ドキュメントの役割は「新しい Layer を作る根拠」ではなく、
**既に動いている 1 実例を、どの原則に従ってどこまで一般化してよいかを定めること**である。

**2026-09-21 audit の訂正記録**: 初回調査は 118 commit 遅れた作業ツリーに対して行われ、
「`principle_applications` は存在しない / Principle 単位の verdict 記録は無い」と誤って結論した。
`origin/master` で再確認し訂正した。**教訓は本ドキュメントの主張そのものである** —
「無いと思った機能が既にあった」は
`docs/project_memory/decisions/principle_management_design_2026_09_17.md` 14章の Lesson と同じ失敗であり、
**新機構を提案する前に現行実装を実測する**ことを本ドキュメントの前提とする。

---

# 1. Goal

AIteamOS には「曖昧だが繰り返される意味判断」が多数ある。Design Review / Meta Review /
Roadmap Review / Blocked Triage / Recovery / Context Selection / Completion Verification /
CEO Attention / Incident 分析 などである。

これらを機能ごとに個別の AI prompt として実装すると、判断の**一貫性も精度も測定できない**。
System One Decision Layer の目的は、
**既知・反復・狭く定義可能な意味判断を、測定可能な共通資産として蓄積すること**である。

成功を「どこで使ったか」「何箇所に入れたか」で測らない。9章の指標で測る。

---

# 2. 3層 Decision Architecture

| 層 | 判定の性質 | 現行の実体（2026-09-21 / `606e5d3`） | この層でやってはいけないこと |
|---|---|---|---|
| **Layer 1 — Hard Rule** | コードで決定可能 | `fileChangeGuard` の `ALWAYS_FORBIDDEN_PATTERNS` / `allowedPaths` / `isInsideTargetRoot()` / schema validation / status transition / `resolvePlActionPolicy()` の `ACTION_GATE_TABLE` / `MECHANICAL_GATE_PATTERNS` / credential 存在確認 | **Layer 2 へ移さない。** 機械判定できるものを確率判断へ落とすのは劣化である |
| **Layer 2 — System One** | 既知・反復・狭いが if 文で書けない意味判断 | **Principle Compliance が稼働中**（0-1章）。他の Question category は未着手 | 未知問題の発見・設計・原因分析を担わせない |
| **Layer 3 — System Two** | 未知・深い推論 | Focused / Integration / Strategic Alignment Review（`runStrategicMetaReview()`）、CRITICAL の Independent Review（`runIndependentReview()`）、PL 判断、Design Challenger | 既知の反復判断を毎回ここで作文させ続けない |

**System One の導入によって System Two を廃止しない。**
目的は System Two を「本当に考える必要がある仕事」へ集中させることである。

この3層分離は新しい概念ではない。`tasks/roadmap.md` の `review-class-b-enhanced-ai-review` が
**machine facts と AI semantic judgment の分離**として既に同じ構造を要求している。
本ドキュメントはその分離を Review 以外へも一般化するが、**Gate / Approval Class 判定への適用は
当該項目の責務**であり、本 Layer が先取りしない（8章・16章）。

---

# 3. 責務境界（System One の5責務）

| 責務 | 内容 | してはいけないこと |
|---|---|---|
| **SELECT** | Profile と signals から今回評価する Question を選ぶ | System One 専用の第二の Risk 分類体系を作る（6章） |
| **EXECUTE** | 選ばれた Question を Decision Engine へ渡す | 新しい Review workflow を作る / interface を特定 Engine の API 形式へ固定する（4章） |
| **NORMALIZE** | Engine 固有出力を共通形式へ変換する（`AppliedPrinciple` が現行の形。`principleId` / `versionHash` / `selectionSource` / `selectionReason` / `verdict`） | 自由文 reasoning を判断根拠として扱う |
| **ROUTE** | 結果を**既存の** workflow / System Two / escalation 経路へ返す | Task mutation・Approval・Job 作成・Roadmap 変更・decision 確定を自分で行う |
| **MEASURE** | 判断と後の事実を照合できる記録を残す | 記録経路を持たない実装を完了にする（Design Philosophy 8 / `observation-closes-loop`） |

**ROUTE は「返す」だけである。** System One は既存 authority を一切奪わない。

**選択側と記録側を分けない。** `principleVersionHash` / `selectionSource` / `selectionReason` は
**選択した側**（Review runner）が埋める。Reviewer の自己申告にすると
「prompt に入っていた本文」と「記録された版」が食い違う。

---

# 4. Jev は System One ではない（Engine 交換可能性）

Jev は **System One Decision Layer の Engine 候補の1つ**であり、System One そのものではない。

AIteamOS 側に残る資産は次である。Engine を差し替えてもこれらは失われてはならない。

- Question Library と版（5章）
- Profile / Module 定義（6章）
- Context Selection 方針（10章）
- Question 単位の performance data / disagreement / Benchmark case（9章）
- sensor による再Review候補（12章）

**薄い Engine 境界だけを持つ。** 必要性が確認されていない Provider abstraction /
Provider framework を先に作らない（15章）。
交換可能性は将来 `role-model-registry`（roadmap item）の1エントリとして扱えるようにし、
**経路の種別を Question や Profile 側へ埋め込まない**。

**現行 Engine は既存の Review provider 経路である**（Gemini 系 Focused / Integration、
CRITICAL の Codex Independent Review）。System One 用に別 provider 基盤を新設していない。
安価な structured 呼び出しが必要な場合の既存前例は
`apps/api/src/aiExplain/cheapAiClient.ts`（OpenCode CLI spawn、`requestText()` / `parseJsonObject()`）であり、
`buildSubprocessEnv()` が `process.env` を継承せず専用 HOME・permission deny・key redaction を持つ。

**新しい従量課金 API を標準経路にしない**（`tasks/roadmap.md`「横断制約: 従量課金APIを
新しい標準経路にしない」CEO 指示 2026-09-14）。**Jev の採用は CEO 承認事項**であり、
承認前に credential を設定・生成・配布しない。

**credential を載せてはならない経路（実装時の必須確認）**:
`apps/worker/scripts/designReviewRunner.ts` は `ENV_ALLOWLIST`（`GEMINI_API_KEY` / `GEMINI_MODEL`）
だけを `process.env` へ載せ、**reviewer child プロセスはこの env を継承する**。
新しい Engine credential をこの allowlist へ足すと、Gemini / Codex の reviewer child へそのまま伝播する。

---

# 5. Question Library（中心資産）

System One の中心資産は Engine ではなく Question Library である。
**現在の Library は `specs/21` の 11 principles であり、これが最初の Question category にあたる。**

**将来の category（一度に作らない。実データを見て増やす）**:

```text
CORE        goal-preservation / requirement-preservation / semantic-drift / ambiguity
SCOPE       scope-too-broad / duplicate-responsibility / unnecessary-mechanism /
            existing-mechanism-available / material-change
AUTHORITY   authority-expansion / mutation-authority-expansion / self-approval / gate-bypass
DATA_STATE  irreversible-state-change / migration-risk / stale-state-risk
RECOVERY    retryable / dead-end / human-required / transient-failure / same-input-reroll
REVIEW      reviewer-independence / conflict-washing / evidence-insufficient / review-bypass
CONTEXT     materially-relevant / policy-relevant / implementation-relevant / historical-precedent
COMPLETION  evidence-supports-claim / acceptance-criterion-covered / completion-overstated
REPORTING   human-attention-required / milestone-worthy / reusable-learning
```

**設計規則（いずれも Principle 版で既に成立している。壊さないこと）:**

- **本文の正本は Git。** metadata を本文と同じ marker block へ置き、**metadata 専用の第二の正本を作らない**
- **本文を DB と API へ持ち出さない。** DB が持つのは id と版だけ（`supervised_runs` の D-2 と同じ形）
- **版は本文から算出する。** 手書き版番号は必ず本文と乖離する。
  **意味が変わったら旧版の実績を新版の判断根拠へ混ぜない**
- **毎回 System Two に Question を自由生成させない。** 過去との比較・false negative 計測・
  calibration ができなくなる。基本は「安定した Library ＋ 動的な Module 選択」（6章）
- **聞いたのに答えが返らなかった Question は `UNCERTAIN` として残す。** 黙って消すと適用数が実態より
  少なくなり、「一度も CONFLICT しない Question」という判断が甘く出る
- **複数の focus が同じ Question を判定したら強い方を残す**（`CONFLICT` > `UNCERTAIN` > `ALIGNED`）。
  先勝ちは衝突を見逃す方向へ倒れる
- **Question の判定を required schema へ入れない。** 判定が返らないことを review の失敗にしない
  （`meta-review-structured-output-robustness` が扱う false BLOCKED の新しい原因を作らない）。
  これは暫定ではなく恒久方針である

---

# 6. Profile / Module 方式

Profile は Question の組み合わせ定義であり、Question のコピーを持たない。

```text
DESIGN_REVIEW           CORE + SCOPE + applicable principles + risk 依存 Module
BLOCKED_TRIAGE          RECOVERY + failure 系
CONTEXT_SELECTION       CONTEXT
COMPLETION_VERIFICATION COMPLETION
```

risk に応じた Module 追加の例: DB 変更 → `DATA_STATE` / Approval・Permission 変更 → `AUTHORITY` /
Recovery 変更 → `RECOVERY` / Critical → CRITICAL SAFETY。

**既存の分類・選択機構を再利用する。System One 専用の第二の Risk 体系を作らない。**

| 必要なもの | 再利用する既存機構 |
|---|---|
| review load | `classifyReviewLoad()`（`apps/worker/src/approvalLevel/reviewLoadClassifier.ts`） |
| focus 選択 | `selectFocuses()` / `selectRoadmapReviewFocuses()`（`apps/worker/src/approvalLevel/focusSelector.ts`） |
| Question 選択 | `selectPrinciples()` / `corePrincipleSlugs()`（`packages/shared/src/engineeringPrinciples.ts`） |
| 判定語彙 | `StrategicDecision`（ALIGNED / CONFLICT / UNCERTAIN）と `REVIEW_UNAVAILABLE` |
| 安全側集約 | `resolveFinalDecision()` / `applyIndependentReviewOverride()`（`packages/shared/src/strategicDecision.ts`） |
| prompt への載せ方 | `buildApplicablePrinciplesSection()` / `buildFocusedOutputContract(selection)` |

**`core` を安易に増やさない。** `principle-tier: core` の Question は全 prompt へ入るため、
core 化は「毎回全文を貼る」方式への逆行になる。Task に応じて選べるものは `contextual` を優先する。

---

# 7. Critical Policy

1. **既存の deterministic な Critical 判定を最低ラインとして維持する。**
   System One に Critical を**下げる**権限を与えない。初期は **upgrade-only** とする。

   ```text
   existing classifier = critical, System One = low                    →  critical のまま
   existing classifier = medium,  System One が authority risk 検出    →  review 強度を上げる候補
   ```

   これは `specs/22_safety_approval_design_principle.md` 7章
   「AI 自身に Safety Level を下げさせない」と同じ要求である。

2. **Critical では `Hard Rules + System One + System Two formal review` を維持する。**
   Engine が全 PASS したことを理由に Critical Review を省略しない。
   個別 Question 単位で大量の実績が出た場合にのみ移管可否を評価し、**Critical カテゴリを一括置換しない。**

3. **Critical の評価指標は Accuracy ではなく False Negative を最優先する。**
   「本当は CONFLICT なのに ALIGNED」を最も危険な failure として測る（9章）。

4. **Engine unavailable を PASS として扱わない。** 既存の `REVIEW_UNAVAILABLE` と同じ意味論に従う。

   ```text
   通常:     unavailable → 代替 engine → それも不可なら既存 System Two
   Critical: unavailable → System One unavailable として記録 → 既存 formal review
   ```

   **System One の availability を AIteamOS の availability 要件にしない。**
   現行 Principle 版はこの条件を満たしている（判定が返らなくても review は失敗せず、
   欠けた Question は `UNCERTAIN` として残る）。

---

# 8. Authority Boundary

| System One ができること | System One ができないこと |
|---|---|
| Question を評価し結果を返す | Task / Job / Approval / Roadmap を変更する |
| 既存 System Two・既存 escalation 経路へ route する | final decision を確定する |
| 観測・disagreement・再Review候補を記録する | Job Gate / Commit Gate / Approval Level の判定を変える |
| review 強度の**引き上げ**候補を出す（7章） | Risk / Critical を引き下げる |
| sensor で「Question 自体を見直す候補」を発火する | **Question 本文・tier・閾値を自動で書き換える** |
| Improvement Proposal の材料を供給する | Goal / Design Philosophy / Constitution / Safety Rule / Authority Rule / Approval Gate を変更する |

**System One 専用の Gate / Approval 経路を新設しない。** 正式 Operationalize は既存 authority /
Design Review / Approval Policy を通す。

**記録・計測は Gate ではない。** 計測を足したことが新しい停止要因になってはならない。

---

# 9. Measurement（効果検証可能性）

**記録経路を持たない実装を完了にしない**（Design Philosophy 8 / `specs/21` の
`observation-closes-loop`: 「様子を見る」と判断したら観測対象・閾値・再評価先まで同じ変更の中で書く）。

これは既存の失敗例がある要求である。`tasks/roadmap.md` の
`review-gate-layers-implemented-but-unwired` (4) は、
「観測してから Gate にする」ことが唯一の目的の Shadow Commit Gate が
**一致率を後から問い合わせられる記録を残していない**状態を Finding として記録している。

| 区分 | 指標 |
|---|---|
| **Quality** | stage 間 disagreement / **Critical false negative** / escaped incident / false positive / `UNCERTAIN` 率 / semantic drift 検出 |
| **Efficiency** | 不要な System Two 呼び出し削減 / input token 削減 / latency / review cost / 不要な CEO attention 削減 |
| **Learning** | repeated finding → Question 化 / Question 別 performance / reviewer drift 検知 |

集計の最低項目（現行 `principle_applications` の形）: `principleId` / `principleVersionHash` /
`selectionSource` / `selectionReason` / `reviewStage` / `verdict` / `reviewRunId` /
`projectId` / `taskId` / `roadmapItemId`。
**reviewer / provider / model / cost / prompt 全文をこの記録へ複製しない**
（`reviewRunId` から既存 review レコードを引ける）。

**閾値は暫定値である。** 変更するときは値だけでなく「どの実測を見てそう決めたか」を併記する。
閾値の値から `thresholdPolicyVersion()` が導出され、版が変わったときだけ再評価が1回発火する。

**Benchmark / Reviewer Drift**: 固定 Benchmark case（期待 verdict つき）を保存し、Engine 更新・
model 更新・Question 変更後に replay して判定 drift を観測する。これは System One だけでなく
Gemini / Claude / Codex の安定性比較にも使える。**現に必要である**:
`independent-review-verdict-instability`（PR #181 実測）は、Gate 差分が一字も変わっていない
再実行で critical な Authority 指摘が消えた事象を記録している。

**Synthetic / Mutation Dataset**（将来）: 正常運用だけでは Critical CONFLICT 事例が不足する。
既存 Design を安全に mutate（gate 削除 / authority 拡張 / fail-closed→fail-open /
reviewer separation 破壊 / rollback 削除 / self-approval 追加）した dataset で false negative を測る。
**初回実装で大規模 generator を作らない。**

---

# 10. Context Selection

Context を3層に分ける。**Semantic Selection だけに依存させない。**

| 層 | 内容 | 現状（2026-09-21） |
|---|---|---|
| **Mandatory** | Goal / Design Philosophy / Constitution / Task design / applicable principles。Critical では Safety・Authority context を追加 | **存在する**（`loadConstitutionPrinciples()`、`REQUIRED_TARGET_STRATEGIC_DOCS`、`buildDesignContract()`、`buildApplicablePrinciplesSection()`） |
| **Deterministic** | changedFiles / allowedPaths のファイル内容 / checklist 対応 / keyword による decision 記録抽出 | **存在する**（`ContextPack`、`selectChecklistFilesForFocus()`、`buildDecisionContext()`） |
| **Semantic** | 候補群から material relevance を判定 | **未実装**（将来用途） |

- **Designer と Reviewer を完全に同一の Context Selection へ依存させない。**
  Reviewer は独立に追加 context を取得できる余地を残す（独立性の要件）
- **Context Manifest**: mandatory / selected / excluded / selection method / content hash を
  可能な範囲で記録する。目的は「Reviewer が間違えたのか、必要情報を渡していなかったのか」を
  後から区別することである。**全文複製を正本にしない。**
- **原則全文の prompt 注入は縮小方向である。** `constitutionPrinciples.ts` は今も章まるごと貼っている。
  これを Registry からの選択方式へ置き換える作業は
  `principle-registry-coverage-and-threshold-review` の Task A が owner であり、本 Layer から重複着手しない

---

# 11. Semantic Invariant（将来用途）

工程間で意味が保存されているかを見る用途。System One を AIteamOS の Semantic Checksum として使う。

```text
Goal ↕ Roadmap ↕ Task ↕ Remediation ↕ Implementation ↕ Completion Report
```

例: Roadmap→Task で要求を落としていないか / Remediation が CONFLICT 原因ではなく
**Requirement 自体を消していない**か / Implementation で scope が変質していないか /
Completion Report が Evidence 以上の成功を主張していないか。

将来候補: Goal↔Roadmap / Task↔Implementation / AC↔Evidence / Claim↔Facts / Policy↔Code /
Documentation↔Behavior / Role↔Authority / Decision↔Precedent / Finding↔Existing Roadmap。

**System One 中心にしないもの**: 新規 Architecture 設計 / Roadmap 生成 / Strategy 生成 /
Root Cause Analysis 本体 / 未知 Bug・未知 Security vulnerability 探索 / 全体設計 trade-off /
最終 Critical Safety authority。

---

# 12. Self-Evolution

**System One 専用の自己改善 Framework を作らない。**

**現行 Principle 版が既に閉ループの最小形を持っている**: 記録直後に sensor を評価し、
`audit_log` へ1回だけ発火し、**原則本文は自動で書き換えず「再Review候補」を出すところまで**で止まる。
新しい scheduler / cron / persistent state を増やしていない。この形を壊さずに広げること。

将来的な接続先は `specs/13_future_system_architecture.md` の設計である
（5b-8 Self Diagnosis = 検出 / 5b-9 Improvement Planner = 優先順位付け / 5b-4 Investigate = 原因分析 /
Experiment = 実行 / 5b-5 Distill = Knowledge 更新 / 5b-10 Problem-driven Learning = 起点順序）。
**これらはいずれも未実装の将来構想である**（2026-09-21 実測: 対応する実装ファイルは無い）。
接続先が無い段階で代替実装を作らない。

Evolution trigger: stage 間 disagreement / escaped incident / repeated formal finding /
`UNCERTAIN` 率上昇 / non-discriminating question / redundant question / engine drift /
閾値が実態と合っていない疑い。

Candidate Question Lifecycle（概念）:

```text
candidate → experimental → offline replay → live shadow → validated → active → retired
```

**この lifecycle を新 DB schema として先に作らない。** コード registry / marker metadata /
既存 sensor + `audit_log` で表現できる最も単純な形を選ぶ。
**Candidate は直ちに active にならない**（8章）。

---

# 13. Storage 方針

**新しい storage を先に作らない。既存の3面を使い分ける。**

| 用途 | 使うもの | 理由 |
|---|---|---|
| Question 適用と判定の記録（高頻度・多次元集計） | **`principle_applications`**（既存） | `audit_log` の索引は `(entity_type, entity_id)` 1本で、多次元 GROUP BY と stage 間の自己 JOIN を表現できない。**性能ではなくクエリ形状**が理由 |
| sensor 発火（低頻度・「発火済みか」の1 entity 問い合わせ） | **`audit_log`**（既存） | 既存索引にそのまま載る |
| append-only な軽量観測 | `data/logs/review_observation.jsonl`（`observationLog.ts`） | 要約・enum・件数のみ。raw 応答・diff 本文・prompt 全文を保存しない。書き込み失敗は内部 catch |
| 判断対象と formal verdict の紐付け | `design_review_runs`（`review_run_id`） | `design_text` / `design_text_hash` / `changed_files` / `result_json` が永続化済み |

**同じ判断基準から逆の結論が出ることがある。** 「`audit_log` を使わない」を一般則として覚えない
（`principle_management_design_2026_09_17.md` 14章の Lesson）。

**専用 storage を新たに足してよい条件**: 9章の記録項目を**実際に**横断集計する必要が出て、
既存3面では不自然・非効率だと**実測で**確認できたとき。「将来必要そう」だけでは追加しない。

---

# 14. 段階導入方針

詳細タスクは `tasks/roadmap.md` が正本。ここは**順序と各段の禁止事項**、および現在地だけを固定する。

| Phase | 内容 | 現在地（2026-09-21） | その段で禁止 |
|---|---|---|---|
| **0** | Read-only Design Audit | **完了** | 実装 |
| **1** | 最初の Question category を既存 Review の出力契約へ載せる | **完了**（Principle 版・2026-09-17 merge） | 新しい Review workflow を作る |
| **2** | 判定の記録と比較（stage 間 disagreement）を成立させる | **完了**（`principle_applications` / `/api/principles/stats`。production 稼働） | decision / Gate / Remediation / escalation への影響 |
| **3** | Calibration。閾値と Question 自体を実データで再評価する | **閉ループは実装済み**（50 / 100 / 200 の sensor）。**実データの蓄積待ち** | 実測なしに閾値を動かす / 実測なしの advisory 化 |
| **4** | Question Library の適用範囲拡張（`specs/00` / `20` / `22` / Design Philosophy） | 既存 planned item `principle-registry-coverage-and-threshold-review` の Task A が owner | 原則の**意味**を coverage 拡張のついでに変更する |
| **5** | Question category を Principle 以外へ広げる（SCOPE / AUTHORITY / RECOVERY 等） | 未着手。Phase 3 の実データを見て判断する | 大量の Question を一度に作る |
| **6** | Advisory / Selective Routing（System Two 呼び出しの削減） | 未着手 | **Critical の一括置換** |
| **7** | Cross-System 展開（Blocked Triage / Context Selection / Attention）と Evolution 統合 | 未着手 | 将来機能の先行実装 / System One 専用 Gate の新設 |

**Phase 5 以降は Phase 3 の実データに依存する。** 現時点で詳細タスクへ過剰分解しない。

## 14-1. 既存の統合点（新しい統合点を作らない）

現行 Principle 版が使っている統合点は次の1系統だけである。**System One を広げるときもここへ足す。**

```text
既存 formal Design Review
  selectPrinciples()                      ← SELECT（選択理由と版を返す）
    → buildApplicablePrinciplesSection()  ← prompt へ載せる
    → buildFocusedOutputContract(selection) / reviewerAdapter
                                          ← EXECUTE（既存の出力契約 1 箇所に足すだけ）
    → normalizeAppliedPrinciples()        ← NORMALIZE（無回答は UNCERTAIN、強い判定を残す）
    → recordPrincipleApplications()       ← MEASURE（例外を握る。Gate にしない）
    → evaluateAndPersistSensors()         ← 記録直後に評価。新しい scheduler を作らない
```

**別経路の shadow runner を新設しない。** 「formal decision へ影響させない」は
**別プロセスで並走させること**ではなく、
(a) 判定を required schema から外す (b) 記録を Gate にしない (c) 例外を握る
という3点で既に成立している。並走型 shadow を足すと、同責務の第二機構になる。

---

# 15. 今回作らないもの（Non-goals）

- System One 独立 service / daemon / scheduler / queue / 専用 DB の追加
- 並走型 shadow runner（14-1章）
- 新しい Task Status / 新しい Approval Gate / System One 専用 Gate
- System One 専用 Principle Registry / 専用 Risk taxonomy / 専用 Recovery workflow
- System One 専用 Self Improvement Framework
- Engine を final authority にする仕組み / Critical Review の置換
- Question 本文・tier・閾値の自動書き換え / Question Candidate の自動 Operationalize
- 必要性が確認されていない Provider abstraction / 新しい従量課金 API 経路
- 将来用途（10章 Semantic / 11章）の先行実装
- 既定オフの dispatch hook を「将来用の seam」として先に置くこと
  （既存 Gate の迂回口になる。**データ形だけを用意し、dispatch は必要になった段で追加する**）
- **外部 Decision Engine の credential 設定・課金発生（CEO 承認事項）**

---

# 16. 既存ドキュメントとの関係（本ドキュメントは自動的に上書きしない）

| 既存 | 関係 |
|---|---|
| `CLAUDE.md` 4章 Authority Principle | **変更しない。** Zone 区分がそのまま優先する |
| `specs/00_constitution.md` 3.14〜3.16 | 上位。本 Layer は最小検証・複雑性防止の原則に従う |
| `specs/22_safety_approval_design_principle.md` | 上位。7章（Safety Level を下げさせない）・2章（多層防御）・9章（Monitoring は変更後の Review）と整合する |
| `specs/20_token_efficient_intelligence_policy.md` | 上位。9章 Deterministic Evaluation（機械計測できる指標に AI を使わない）は本 2章 Layer 1 と同じ要求。System One は「AI 呼び出しを増やす仕組み」ではない |
| `specs/21_outcome_oriented_generalization_principle.md` | **Question Library の実体。** `principle-*` marker を壊さない。第二の Registry を作らない |
| `specs/13_future_system_architecture.md` | Self-Evolution の将来接続先（12章）。Core / Extension 構造の定義は当該ファイルが正本 |
| `docs/project_memory/decisions/principle_management_design_2026_09_17.md` | **第一号実装の設計判断・不変条件・意図的な未実装の正本。** 本ドキュメントと食い違ったら実装に近い側（当該 decision record）を事実として扱い、本ドキュメントを訂正する |
| `docs/multi_ai_step_review_flow.md` | 現行 Review 運用の正本。**Review topology を本 Layer が変更しない** |
| `tasks/roadmap.md` `principle-registry-coverage-and-threshold-review`（planned / high） | **Phase 4 の owner。** 本 Layer から重複着手しない |
| `tasks/roadmap.md` `review-class-b-enhanced-ai-review`（deferred） | Gate / Approval Class への適用は当該項目の責務。本 Layer は測定基盤を供給するが、当該項目の CEO 承認手順（境界表の提示と承認）を迂回しない |
| `tasks/roadmap.md` `independent-review-verdict-instability`（planned） | 本 Layer が測定対象とする実問題。**新しい分類器を作る前に既存再利用を確認する**という当該項目の方針に従う |
| `tasks/roadmap.md` `meta-review-structured-output-robustness`（planned） | parse 失敗による false BLOCKED。Question 判定を required schema へ入れない理由（5章）と直結する |

---

# 17. 関連ドキュメント

- 最上位思想: `specs/00_constitution.md`
- Safety / Approval 設計原則: `specs/22_safety_approval_design_principle.md`
- AI 利用量抑制方針: `specs/20_token_efficient_intelligence_policy.md`
- Question Library（Principle）の実体: `specs/21_outcome_oriented_generalization_principle.md`
- 第一号実装の設計決定: `docs/project_memory/decisions/principle_management_design_2026_09_17.md`
- 将来 Core / Extension 構造・Self Diagnosis / Improvement Planner: `specs/13_future_system_architecture.md`
- 現行 Review 運用: `docs/multi_ai_step_review_flow.md`
- 実装順序: `tasks/roadmap.md`
