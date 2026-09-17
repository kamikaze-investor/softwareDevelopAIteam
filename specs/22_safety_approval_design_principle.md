# Safety / Approval 設計原則

**採用: 2026-09-17（CEO 指示）。本ドキュメントが本原則の正本である。**

---

# 0. 本ドキュメントの位置づけ（最初に読むこと）

本ドキュメントは、AIteamOS の Safety 機構・Approval 機構を**今後どう設計・変更するか**を定める原則である。

**本ドキュメントは、それ自体では既存の Gate・Approval・Guard・Permission を1つも弱めない。**
`specs/00_constitution.md` 1章の適用範囲注意と同じ扱いとする。既存実装と本原則が矛盾して見える箇所は、
自動的に本原則を優先せず「要調整」として 14 章に列挙し、**個別に CEO 承認を経てから**変更を検討する。

**目的は「CEO 承認を減らすこと」ではない。**
人間の事前承認を Safety の中心に置く代わりに、

- 間違いを起こしにくくする
- 間違っても影響を小さくする
- すぐ異常に気づく
- すぐ安全な状態へ戻す

ことで、**AI が安全に自律実行できる範囲を広げる**ことが目的である。
CEO 承認の回数が減るのは結果であって、目標指標ではない。

---

# 1. Human Approval は最後の Safety Boundary とする

CEO がコードや技術判断を毎回確認することを、通常の Safety mechanism にしない。

CEO が判断すべきなのは、原則として**人間にしか決められない Policy / Value / irreversible decision** に限る。

- Goal の変更
- Design Philosophy の変更
- AI の authority 上限を広げる変更
- Safety Policy そのものを弱める変更
- 大きな金銭・法務・顧客責任を伴う判断
- rollback 不能または重大な不可逆操作
- 複数の Independent Review でも重要な判断が解消しない場合

**単に「protected file だから」「DB migration だから」「Control Repository だから」という理由だけでは
CEO 必須にしない。**

ただし本条は**目指す状態であって、現時点の運用ルールではない**。現行の CEO 必須リスト
（`docs/project_memory/rules/approval_rules.md` の Yellow Zone、`docs/multi_ai_step_review_flow.md` 13章）は
**14 章の手順を経るまで有効**である。

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
| **Class C** | AI だけでは決めるべきでない変更。authority 拡大 / Safety Boundary 弱化 / Goal・Design Philosophy 変更 / 重大かつ rollback 不能な変更 / 法務・金銭・顧客責任上の重大判断 / AI レビューで重要な不一致が解消しない変更 |

**Class B を「CEO Gate を迂回する仕組み」にしてはならない。**
Class B は、**人間承認よりも強い技術的 Safety evidence を揃えることで** AI 完結を可能にする Class である。
evidence が揃わなければ Class B は成立せず、Class C へ倒す。

実装設計・境界表・着手手順は `tasks/roadmap.md` の `review-class-b-enhanced-ai-review` を正本とする。
**同項目の着手手順（境界表を CEO へ提示 → CEO 承認 → `state=planned`）は本原則の採用によって免除されない。**

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
**改善・統合だけで実現できる部分を優先する**。

既存機構で合理的に実現できるなら、新しい Gate / Review / Status / Workflow を追加しない。
（`specs/00_constitution.md` 3.16 Complexity Prevention / State-Space Reduction と同じ方向である。）

**効果検証可能性（Design Philosophy 8）**: 本原則に基づく変更は、既存の `audit_log` /
`data/logs/review_observation.jsonl` へ判定根拠を記録し、後から
「CEO 呼び出しがどう変化したか」「Class C の取りこぼしが出ていないか」を判定できる形にする。
**記録経路を持たない実装で完了にしない。**

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

# 14. 既存ドキュメントとの関係（要調整点。本原則は自動的に上書きしない）

本原則と現行の運用ルールは、次の点で**まだ一致していない**。
いずれも**現行ルールが有効**であり、変更するには 10 章が指す着手手順（境界表の CEO 承認）が要る。

| 現行ルール | 現在の内容 | 本原則との差 | 扱い |
|---|---|---|---|
| `docs/project_memory/rules/approval_rules.md` Yellow Zone | 「セキュリティモデル変更」を無条件に CEO 承認必須 | 本原則 1 章は「Safety Policy を**弱める**変更」に限定したい | **要調整。現行有効** |
| `docs/multi_ai_step_review_flow.md` 13章 CEO 承認必須 | 「DB スキーマ変更」「認証変更」を無条件に CEO 必須 | 本原則 1 章は「rollback 可能な後方互換変更」を除きたい | **要調整。現行有効** |
| `docs/multi_ai_step_review_flow.md` 10章 リスク分類 | 変更内容（ファイルパス・影響範囲）だけで High/Medium/Low を決める | 本原則 3 章は blast radius / detectability / recoverability / irreversibility も見る | **要調整。現行有効** |
| `CLAUDE.md` 4章 Authority Principle | 同上の Yellow Zone 列挙 | 同上 | **要調整。現行有効** |

**この表を根拠に上記ファイルを先回りして書き換えてはならない。**

---

# 15. 関連ドキュメント

- 最上位原則: `specs/00_constitution.md`（特に 3.6 / 3.13 / 3.14 / 3.15 / 3.16）
- Review 経路の正本: `docs/multi_ai_step_review_flow.md`
- 承認運用の正本: `docs/project_memory/rules/approval_rules.md`
- Class A/B/C の実装項目: `tasks/roadmap.md` `review-class-b-enhanced-ai-review`
- 権限モデル: `specs/08_permissions.md`
