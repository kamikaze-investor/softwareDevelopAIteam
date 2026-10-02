# Safety / Approval 設計原則

**採用: 2026-09-17（CEO 指示）。本ドキュメントが本原則の正本である。**
**改訂: 2026-10-02（CEO 指示）— Decision Authority Principle を 1 章へ統合し、14 章の要調整点を解消した。**

---

# 0. 本ドキュメントの位置づけ（最初に読むこと）

本ドキュメントは、AIteamOS の Safety 機構・Approval 機構・Human Gate・CEO Escalation を
**どう設計し、どう判断するか**を定める原則である。Promotion / Deploy だけの局所ルールではなく、
AIteamOS 全体で Human Gate の要否を判断する共通原則として適用する。

**2026-10-02 以降、1 章（Decision Authority Principle）は文書上の運用ルールである。**
2026-09-17 の採用時に「要調整・現行有効」として 14 章に挙げた差分は、2026-10-02 の CEO 判断で解消した
（14 章参照）。

**ただし、コードが現在強制している Gate は、文書の改訂だけでは外れない。** 1 章と矛盾する Gate が
コードに残っている間は**コードの Gate が優先する**（fail closed）。それらの Gate を外すのは、
14 章に挙げた段階ごとの実装変更であり、各段階は既存の Review / CI / Gate を通常どおり通す。

**目的は「CEO 承認を減らすこと」そのものではない。**
人間の事前承認を Safety の中心に置く代わりに、

- 間違いを起こしにくくする
- 間違っても影響を小さくする
- すぐ異常に気づく
- すぐ安全な状態へ戻す

ことで、**AI が安全に自律実行できる範囲を広げる**ことが目的である。
**CEO 承認を挟むこと自体を Safety Evidence として扱わない。** CEO はコードレベルの技術的安全性を判断できない。

---

# 1. Decision Authority Principle — Human Gate は「誰の責務か」で決める

**「リスクが高いから人間に聞く」のではなく、「その判断を誰がする責務なのか」で Human Gate の要否を決める。**

Human Approval は通常の Safety mechanism ではなく、**最後の Safety Boundary** である。
技術的に危険な変更は、人間へ投げるのではなく、2 章の多層防御で Safety Evidence を強くして AIteamOS 側で判断・実行する。

## 1-1. 判定は操作名ではなく「意味・影響」で行う

**「何をする操作か」ではなく、「その操作によって誰の責務に属する意思決定が発生するか」で判定する。**
`deploy_production` / `security` / `migration` のような**操作名・ファイル種別で Human Gate を固定しない**。

例: 同じ deploy でも、

| 判定 | 条件 |
|---|---|
| **Human Decision ではない**（技術判断） | 既存サービス・既存の公開範囲・既存の権限範囲・既存のデータ利用方針・既存のコスト上限・既存の Product / Goal の中で行う通常 deploy |
| **Human Decision** | 新しい外部ユーザー・地域・市場への公開 / 新しい課金・料金体系の開始 / 個人情報・データ利用方針の変更 / AI authority の拡大 / CEO が決めるべき Product・Policy・Value の変更を**その deploy が伴う**場合 |

同じ考え方を migration・security 変更・dependency 更新・infrastructure 変更・recovery 機構変更等にも適用する。

## 1-2. Human Decision Authority（Human Gate を残す範囲。必要最小限）

- Goal / Goal の優先順位 / Product / Business 方針（新規事業・撤退等の経営判断、事業上のトレードオフを含む）
- Design Philosophy / Constitution の意味・原則そのものの変更
- Policy / Value 判断（法務・規制・ブランド上の価値判断を含む）
- 法務・契約・大きな支出・課金など、**人間主体でなければ成立しない**判断（新しい外部サービスとの契約・採用を含む）
- **AI authority の拡大**（人間と AI の authority boundary そのものの変更）
- **Safety boundary を弱める変更**
- **新しい不可逆な外部 commitment**、およびデータ消失等の不可逆な結果を「事業として許容するか」の判断
- 技術的には複数案が成立し、どちらを選ぶかが事業方針・Goal に依存する場合
- CEO が明示的に Human-only と指定した事項

**次の理由だけでは Human Decision Authority にしない:**
「HIGH / CRITICAL だから」「Production だから」「Security 関連だから」「protected file だから」
「DB migration だから」「Control Repository だから」「現在人間が操作しているから」。

**Safety を強化する技術変更は原則 Human Decision ではない。** ただし、強化か弱体化かを
**信頼できる形で機械判定できない場合は Human Decision 側へ倒してよい**（fail closed）。
AI の自己申告で「強化である」と判定しない（7 章）。

## 1-3. 技術判断は CEO へ上げない

Production deploy / DB migration / infrastructure 変更 / Worker・API の大規模変更 / recovery 機構変更 /
refactor / performance / concurrency / lifecycle 修正 / rollback / dependency 更新 /
deployment procedure 変更 / technical security hardening は、1-1 の意味で Human Decision を伴わない限り、
HIGH / CRITICAL であっても CEO 判断へ上げない。

**技術的に危険なほど、CEO 承認ではなく Safety Evidence を強くする。** 選ぶ Evidence は
blast radius・可逆性・データ損失可能性・停止影響に応じて**既存機構から必要なものだけ**を選ぶ
（Design Review / Independent Review / Meta Review / typecheck・test・CI / File Change Guard / allowedPaths /
Acceptance Criteria / backup / restore verification / rollback rehearsal / failure injection /
migration rehearsal / isolated・disposable 環境 / Production 相当 clone / staged deploy / preflight /
health check / invariant verification / post-deploy observation / automatic rollback / fail-closed /
quarantine / recovery）。**「HIGH だから全部要求する」巨大 workflow を作らない。**

Production 停止・データ破損の blast radius が大きく通常の CI / Review では Evidence が不足する場合は、
**Production を可能な限り忠実に複製した隔離環境で実際の変更を通す**
（Production clone → migration → service startup → representative workload → failure injection →
rollback → restore → invariant verification のうち必要な部分）。新しい常設環境を前提にせず、
既存の backup / clone / deploy / test 機構で実現できる方法を優先する。
目的は、CEO に「たぶん大丈夫ですか？」と聞く代わりに、**AIteamOS 自身が「壊れても戻せる」ことを証明する**ことである。

## 1-4. Human Gate・Approval・Escalation の 3 分類

AIteamOS の Human Gate / Approval / Escalation は、次の 3 つのどれかとして扱う。
**新しい分類体系ではなく、10 章の Class との対応で読む。**

| 分類 | 意味 | 扱い | 10 章との対応 |
|---|---|---|---|
| **Human Decision Authority** | 1-2 に該当し、人間にしか決められない | Human Gate を維持する | Class C |
| **Technical Safety Decision** | 技術的 Safety Evidence で判断できる | Human Gate を外し、Evidence による自動判断へ寄せる | Class A / Class B |
| **Mechanical Operation** | 判断を伴わない操作 | 自動化候補 | Class の対象外（判断ではない） |

**現在の手順が歴史的に人間操作になっているだけ、という可能性を常に疑う。** 人間が操作している事実は
Human Decision の根拠にならない。

**「人間しか実行できない Mechanical Operation」を区別する。** GitHub / VPS 等の制約で secret の設定などを
人間しか行えない場合、それは**人間の判断ではなく、人間が実行する Mechanical Operation** として記録する。
承認 Gate として扱わない。

## 1-5. Credential は物ではなく authority の増減で判定する

| 変化 | 分類 |
|---|---|
| 新しい authority の付与・scope の拡大 | Human Decision Authority |
| 同一 authority の credential rotation / renewal / replacement | Mechanical Operation |
| credential の縮小・失効 | 原則 Technical Safety Decision |

**credential という物そのものを Human Gate にしない。**

## 1-6. Human Decision 待ちで会社全体を止めない

Human Decision Authority が必要な Task が発生しても、**その Task / Project だけを待機させ、
独立した安全な仕事は継続する**。1 件の CEO 承認待ち・Escalation 待ちが、他 Project・無関係な Roadmap item・
独立した検証・安全な低リスク Task を止める設計へ戻さない
（`tasks/roadmap.md` `pl-adoption-stalled-by-escalated-attention` と同じ考え方）。

単一 running Project 内での待ち局所化は、Post-MVP の Project workspace isolation が担う。
**本原則の適用はそれを前提条件にしない。**

## 1-7. 「失敗しない」ではなく「失敗しても大丈夫」を重視する

AI が絶対に間違えないことを前提にしない。代わりに次を重視する。

- 間違えても Production data を失わない
- deploy・migration が失敗しても戻せる / 復元できる
- process が停止しても再起動できる
- workspace 汚染が別 Task へ伝播しない
- 1 Task / 1 Project の停止が会社全体を止めない
- 復旧不能になる前に fail closed する

## 1-8. Technical Admin Capability — ADMIN API であることと CEO Decision Authority を分ける（2026-10-02 CEO 指示）

**「ADMIN 権限が必要な API だから CEO 操作」としない。** ADMIN credential は「誰が呼べるか」の技術的な区分であり、
「誰の責務の判断か」（1-1・1-2）とは別物である。

純粋な Technical Decision の管理 Action は、AIteamOS が必要な Safety Evidence を揃えた場合、
**人間の ADMIN token 操作なしで**実行できる方向へ寄せる。ただし:

- **Worker / PL / model へ汎用 ADMIN token を渡さない。**
  「AI に ADMIN token を持たせる」のではなく、**AI が証拠付きで限定 Action を要求し、信頼された既存 Policy 層が実行可否を決める**
- 第一候補は **Action-specific capability + evidence verification** である:
  ```
  AI / PL が管理 Action を要求
  → 既存 Policy / Gate が Decision Authority を分類（事実から機械的に。PL の自己申告では決めない。7 章）
  → その Action に必要な Safety Evidence を検証
  → 条件を満たした Technical Action だけを限定的に実行
  ```
- Capability は可能な限り **action 限定 / Task・Project 限定 / commit・diff 限定 / expiry 付き / one-shot / audit 必須 / fail-closed** にする
- **新しい汎用 ADMIN subsystem を第一案にしない。** 既存の Approval Gate・`plActionPolicy`・`authorizePlAction()`・
  risk classification・Design Review・Independent Review・Task Contract・workspace ownership / knownGood・
  File Change Guard・audit・Worker credential separation の再利用を先に確認する
- **Evidence による実行は「AI による承認」ではない。** 「AI の発言は人間承認として扱わない」
  （`approval_rules.md` 最重要原則）は維持する。Evidence を満たした Action は、人間承認を偽装せず、
  **決定的なコードが事実を検証した結果**として、承認とは別種の記録で audit に残す

**1-2 の CEO Decision Authority は Technical Admin へ移さない。** Safety Evidence が揃っても CEO 判断を維持する。
---

# 2. Safety は多層防御で作る

AI の判断が 100% 正しいことを前提にしない。Safety の中心は次の 8 層である。

1. **Isolation** — 触れられる範囲を物理的に制限する
2. **Simulation / Preflight** — 適用せずに試す
3. **Mechanical Validation** — LLM を介さない決定的な検証
4. **Independent Multi-Model Review** — 実装者と分離された独立レビュー
5. **Automated Test / E2E**
6. **Limited Rollout** — 一度に全体へ反映しない
7. **Runtime Monitoring** — 変更後に異常を検知する
8. **Fast Rollback / Recovery** — すぐ安全な状態へ戻す

**Human Approval はこの上に置く最後の層である。**

**どれか1つだけを Safety の根拠にしない。** 「Review が PASS した」「test が通った」「CEO が承認した」の
いずれか単独を、高リスク変更を通す理由にしない。

---

# 3. Risk は「変更内容」だけで判定しない

Risk 評価では最低限、次の 5 次元を考慮する。

| 次元 | 問い |
|---|---|
| **Failure probability** | 間違える可能性はどれくらいか |
| **Blast radius** | 間違った場合にどこまで影響するか |
| **Detectability** | 異常をどれだけ早く検知できるか |
| **Recoverability** | どれだけ早く・確実に元へ戻せるか |
| **Irreversibility** | 元に戻せない影響があるか |

概念的には次のように扱う。

```
Risk ≒ Failure Probability × Blast Radius × Detection Delay × Recovery Difficulty
```

**失敗確率だけを下げる設計にしない。** 失敗確率が同じでも、blast radius が小さく検知が速く復旧が確実なら
リスクは低い。逆に失敗確率が低くても不可逆なら高リスクである。

これは既存の Risk Level（LOW / MEDIUM / HIGH / CRITICAL）・Review Level 0〜3・`ReviewLoad`・
`ApprovalLevel` を**置き換える新しい分類軸ではない**。既存分類器が何を入力として見るべきかを定めるものである。

---

# 4. 高リスク変更ほど「小さく試す」

顧客・production へ影響する変更は、可能な限り一度に 100% へ反映しない。

**利用可能な既存機構を優先する**（Candidate / sandbox / shadow execution / dry-run / feature flag /
canary / internal users / small customer cohort / staged rollout）。

```
Candidate → internal/test users → 1% → 5% → 20% → 50% → 100%
```

各段階で正常性を確認してから拡大する。異常があれば拡大を停止し、可能なら自動 rollback する。

**段階が存在しない変更を「段階投入した」と report しない。** 段階が無いなら、無いと書く。

---

# 5. 顧客影響は技術指標だけで判断しない

顧客向け rollout では、technical health（error rate / latency / availability / data consistency /
task success rate）だけでなく、**実際の顧客影響**（conversion / revenue / churn signal /
support・contact 増加 / user-facing failure / 想定外の挙動変化）も監視対象に含められる設計を目指す。

**Technical health が正常でも、Business / User impact が悪化していれば安全とみなさない。**

現時点の AIteamOS には外部顧客が存在しないため、本条は
**「顧客影響指標を後から追加できる設計にしておく」という設計制約**であり、
今すぐ計測機構を作れという指示ではない。

---

# 6. Review は独立性を重視する

重要変更を単一 AI の判断だけで通さない。高リスクだが AI 完結可能な変更では次を基本とする。

```
Implementation AI
→ Independent Reviewer A
→ 必要に応じて Independent Reviewer B
→ CI / E2E
→ Gate
→ 実行
```

Reviewer 間で Safety / Authority / Irreversibility について重要な意見が割れた場合:

```
Second Independent Review → Meta Review → それでも解消しなければ CEO
```

**単純多数決にしない。** Reviewer の独立性と、実装者との provider / vendor 分離を可能な範囲で維持する。
（既存の `isGeneratorSeparatedFromFinalReviewer()` / `resolveFinalDecision()` /
`applyIndependentReviewOverride()` がこの原則の現行実装にあたる。）

---

# 7. AI 自身に Safety Level を下げさせない

PL や実装 AI が「これは LOW risk」「これは安全」と**自己申告しただけ**で、
Gate / Review / Approval / Isolation / Rollout 制限を弱めてはならない。

実際の diff / changed files / operation / DB change / permission change / production impact /
rollback capability などから、**システム側で再評価する**。

本条は現行の不変条件でもある（`resolvePlActionPolicy()` は `plRiskOpinion` を `requiredGates` の算出に
使わない）。この不変条件は本原則の採用後も**回帰テストで固定し続ける**。

---

# 8. Recoverability を実装前に確認する

**「問題が起きたら rollback できます」だけでは不十分である。**

高リスク変更では実行前に、可能な範囲で次を確認する。

1. rollback path が存在する
2. previous stable state が分かる
3. rollback に必要な artifact / backup が存在する
4. rollback 操作自体が壊れていない
5. rollback 後の整合性確認方法がある

必要なら rollback rehearsal / restore test も行う。
**復旧不能な変更は一段高い Class として扱う。**

---

# 9. Monitoring は変更後の Review である

**Deploy 成功を完了条件にしない。** 重要変更では次までを1つの変更ライフサイクルとして扱う。

```
Deploy → Observe → Verify → Stable 判定
```

異常検知には Watchdog / runtime invariant / error spike / business KPI anomaly /
data integrity failure / customer impact を用い、異常時は次へ進める。

```
Stop rollout → rollback / isolate → diagnose → evidence 保存 → retry / fix / escalate
```

---

# 10. Class A / B / C はこの原則で設計する

| Class | 定義 |
|---|---|
| **Class A** | 通常変更。既存 validation / test / review で自動進行可能 |
| **Class B** | 潜在的には高リスクだが、isolation・simulation・independent review・test・blast radius 制限・monitoring・rollback が**すべて可能**であるため、強化された AI Safety Process を通せば CEO なしで進められる変更 |
| **Class C** | AI だけでは決めるべきでない変更。1-2 の Human Decision Authority に該当する変更（authority 拡大 / Safety Boundary 弱化 / Goal・Design Philosophy 変更 / 不可逆な外部 commitment・不可逆な結果の事業的許容 / 法務・金銭・顧客責任上の判断）と、AI レビューで重要な不一致が解消しない変更 |

Class は 1-1 のとおり**操作名ではなく意味・影響で決める**。HIGH / CRITICAL・Production・Security 関連であることは
Class C の理由にならない。

**Class B を「CEO Gate を迂回する仕組み」にしてはならない。**
Class B は、**人間承認よりも強い技術的 Safety evidence を揃えることで** AI 完結を可能にする Class である。
evidence が揃わなければ Class B は成立せず、Class C へ倒す。

汎用の Class B 判定機構（machine facts による境界判定）の実装設計・着手手順は `tasks/roadmap.md` の
`review-class-b-enhanced-ai-review` を正本とし、同項目の着手手順は同項目の機構について引き続き有効である。
**個別の Human Gate を Evidence へ置き換える変更（14 章の段階）は、その段階で必要な Evidence を
その段階の中で定め、汎用 Class B 機構の完成を前提にしない。**

---

# 11. 事故は Learning へ戻す

rollback したら終わりにしない。事故・near miss・false positive / false negative から、
test 不足 / simulation 不足 / monitoring 不足 / rollback 不足 / reviewer 見落とし /
classifier 誤判定 / rollout 範囲が大きすぎた、のどれだったかを分析する。

分析結果は、既存の test / prompt / classifier / review criteria / monitoring / rollout policy へ
**最小変更で反映する**。

**同じ事故を防ぐために、毎回新しい Gate や workflow を増やさない。**

---

# 12. 実装原則（新しい Safety subsystem を先に作らない）

本原則を実装する際、**新しい Safety subsystem を先に作らない。**

まず既存の Mandatory Gate / Review Load Classifier / Independent Review / Meta Review /
Candidate・Stable / E2E / Watchdog / State API / Recovery / Rollback / audit log を調査し、
**改善・統合だけで実現できる部分を優先する**。既存経路への薄い orchestration で済むなら、それを優先する。

既存機構で合理的に実現できるなら、新しい Gate / Review / Status / Workflow を追加しない。
（`specs/00_constitution.md` 3.16 Complexity Prevention / State-Space Reduction と同じ方向である。）

**効果検証可能性（Design Philosophy 8）**: 本原則に基づく変更は、既存の `audit_log` /
`data/logs/review_observation.jsonl` へ判定根拠（どの分類で、どの Evidence によって通したか）を記録し、
後から判定できる形にする。**記録経路を持たない実装で完了にしない。**

## 12-1. 自律化の評価基準

最重要 KPI は「何個 Finding を直したか」「何個 Roadmap item を消化したか」ではない。優先して見るのは次である。

- Human intervention なしの連続稼働時間
- Human intervention なしで Production まで完了した Task 数
- Task あたり Human Gate 回数
- Human Decision Authority 以外で停止した回数
- CEO 待ちが他 Task へ波及した回数
- 自動 rollback / recovery の成功率

目標は「1 Task 無人完了 → 3 Task 連続 → 半日 → 24 時間」と、実際の無人運転時間を伸ばすことである。

**Human Gate 回数の減少は、Class C の取りこぼし（Human Decision を AI が通した件数）が 0 であることと
組で見る。** 取りこぼしを伴う減少は改善ではない。上記の計測は既存の `audit_log` / State API から導出し、
計測のための新しい subsystem は作らない。

---

# 13. 最終的な目標

CEO に毎回「このコード変更を承認しますか？」と聞くシステムではなく、AIteamOS 自身が

```
安全に試す → 独立検証する → 小さく投入する → 監視する → 問題なら即戻す → 学習する
```

まで自律で行い、CEO には次だけが届く状態を目標とする。

- 何を目指すか
- どこまでのリスクを許容するか
- AI にどこまでの authority を与えるか
- 不可逆な重大判断を行うか

---

# 14. 既存ドキュメント・既存 Gate との関係

## 14-1. 2026-09-17 時点の要調整点（2026-10-02 CEO 判断で解消）

2026-10-02 に CEO は次の方向を承認した。

1. 通常の既存サービス deploy は Human Decision Authority ではない
2. Security 関連というだけでは Human Decision Authority にしない
3. `git_commit` の一律 CEO approval を廃止し、Safety Evidence に置き換える
4. AI に merge / deploy authority を持たせることを許可する。ただし authority scope の拡大は Human Decision Authority とする

| 旧・要調整点 | 解消のしかた |
|---|---|
| `docs/project_memory/rules/approval_rules.md` Yellow Zone「セキュリティモデル変更」 | 1-2 の意味（authority 拡大・Safety boundary 弱化）で解釈する注記を同ファイルへ追加 |
| `docs/multi_ai_step_review_flow.md` 13章「DB スキーマ変更」「認証変更」等の CEO 必須 | 同章を「Evidence 強化 + 1-2 に該当する場合のみ CEO」へ改訂 |
| `docs/multi_ai_step_review_flow.md` 10章 リスク分類の High「原則 CEO 承認必須」 | 同章の扱い欄を Evidence 強化へ改訂。分類自体は 3 章の 5 次元を入力にする方向のまま |
| `CLAUDE.md` 4章 / `AGENTS.md` | AGENTS.md の規定（AGENTS.md 自体の変更は CEO が具体的 diff を明示承認した場合に限る）どおり、具体的な diff を CEO へ提示してから適用する |

**Yellow Zone の列挙**（`approval_rules.md` / `CLAUDE.md` 4章 / `specs/04_ai_organization.md` 13章 /
`specs/07_dashboard.md` / `specs/08_permissions.md`）**の各項目は、1-1・1-2 の意味で解釈する。**
例:「本番公開」は新しい外部ユーザー・地域・市場への公開を指し、既存の公開範囲内での通常 deploy を含まない。
「セキュリティモデル変更」は authority の拡大・Safety boundary の弱化を指し、hardening を含まない。

## 14-2. コードに残っている、1 章と矛盾する Gate（各段階で外す。外すまではコードが優先）

| Gate（2026-10-02 時点の `master`） | 内容 | 外す段階 |
|---|---|---|
| `apps/api/src/routes/approvalGate.ts` MVP-A（`requiresApprovalByPolicy = requestedAction === 'git_commit'`） | 全 `git_commit` に人間承認 | 1. git_commit Evidence 化（`evaluateCommitGate()` の shadow から実施への昇格を最初に検討） |
| `packages/shared/src/approvalGateLogic.ts` / `plActionPolicy.ts` の file-risk 由来 `ceo_approval` | ファイルパスが CRITICAL・Mechanical Gate に該当すると CEO 必須 | 1. と同時に、意味（1-2）で判定できる入力へ寄せる。判定できない範囲は fail closed |
| promotion / push / PR / merge の外部セッション依存 | AI 外の手作業 | 2. remote publish / merge（`worker-restricted-remote-publish`） |
| `plActionPolicy.ts` `deploy_production` / `restart_service` / `rollback_commit` の `ceo_approval` | 運用操作に CEO 必須 | 3. deploy（既存の deploy 手順・Operational E2E・backup・health check・rollback の組合せを先に検討） |
| deploy 後の Candidate sync の手作業 | 手作業 | 4. Candidate sync（Candidate Freeze・依存 install を前提条件として機械照合） |

各段階は**既存機能の改善だけで達成できるかを最初に確認し**、不要な新機能・Gate・workflow を追加しない。
authority scope を広げる credential の付与は 1-5 により Human Decision Authority のまま残る。

---

# 15. 関連ドキュメント

- 最上位原則: `specs/00_constitution.md`（特に 3.1 / 3.6 / 3.13 / 3.14 / 3.15 / 3.16 / 3.18）
- Review 経路の正本: `docs/multi_ai_step_review_flow.md`
- 承認運用の正本: `docs/project_memory/rules/approval_rules.md`
- Class A/B/C の実装項目: `tasks/roadmap.md` `review-class-b-enhanced-ai-review`
- 権限モデル: `specs/08_permissions.md`
