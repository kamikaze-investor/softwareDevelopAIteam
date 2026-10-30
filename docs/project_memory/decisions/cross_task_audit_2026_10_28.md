# Cross-Task Audit 2026-10-28（Production deploy 67f9f351 / #355〜#432）

<!-- cross-task-audit base=112a7a5a72fde4f108c39d3628bb577ce43e2dcb head=67f9f351cc90581b6fceba7f3c6b5519331386d5 -->

**Importance Level: 2**
**Status: active**

手順は `cross_task_drift_audit_design.md`。3 回目の監査なので、設計 7 章どおり **5 章に「仕組みの評価」** を置く。
base は前回記録 `cross_task_audit_2026_10_26b.md` の head（`112a7a5a`）を **`--base` 無しで自動で引き継いだ**（chain issues 0）。

## 1. Window と発火

| 項目 | 値 |
|---|---|
| window | `112a7a5a..67f9f351`（first-parent master、15 変更 = #355・#416・#420・#422・#421・#419・#412・#418・#423・#425・#427・#430・#431・#432・#428。記録だけの #417 と ledger だけの #424 は `windowChanges()` が除外） |
| 境界 | 2026-10-28 の Production deploy（`67f9f351` = #428）。**2026-10-27 の deploy `7fcb93a6`（#412）は監査されないまま、この window に入っている** |
| 発火理由（`evaluateDue()`） | deploy boundary 67f9f351 / fix chain: #432 が #355・#430 を、#430 が #355 を、#412 が #419 を引用 / CODEOWNERS surface を 11 変更が触った |
| churn 上位（lift） | `.github/workflows/meta-review-base.yml` 32.1、`apps/worker/scripts/designMaterialityEval.ts` 24.1、`docs/meta_reviewer/design_materiality_evaluation.md` 16.1、`apps/worker/src/metaReviewer/designMateriality.ts` 12.1、`approval_rules.md` 2.9、`jobRunner.ts` 1.8、`worker/index.ts` 1.6、`routes/jobs.ts` 1.4、`executionLoop.ts` 0.8 |
| packet | 101,406 文字、hotspot 9 ファイル、**切り捨て 0** |
| Production observation | 未提供。`production_divergence` は uncertain（`findings` が機械的に固定） |
| Challenger | 1 回。**local Codex `gpt-5.6-sol`（reasoning high、read-only sandbox、window head の worktree）**。probe OK を確認してから実行。**3 回目で初めて vendor 分離あり**（1・2 回目は別 context の Claude） |

**window の起点について**: 起動元 session の due check は `--base e3677f93`（前回記録 PR #417 の merge commit）で実行されていた。
この window は 3 変更（#431・#432・#428）だけになり、**`112a7a5a..e3677f93` の 12 変更（10/27 deploy `7fcb93a6` を含む）が
どの監査にも入らない**ところだった。script の正本（記録 chain の自動引き継ぎ）に戻して実行した。5 章の観測 4 を参照。

## 2. Finding と処分

| id | 問い | 重大度 | routing（機械） | PL の確認 | 処分 |
|---|---|---|---|---|---|
| `xta-112a7a5-01` | authority_tuple_drift | high | **decision_authority 候補**（evidence が `.github/CODEOWNERS`・`.github/scripts/codeowners.mjs`。問い自体と、claim が approval を語ることも理由） | **実行で再現**: base の CODEOWNERS と review 0 件で `evaluateCodeOwnerApproval()` を呼ぶと、`apps/api/src/reconcile/externalCompletion.ts`・`apps/api/src/routes/tasks.ts`・`apps/api/src/storage/sqlite.ts`・`apps/mobile/components/ExternalReconcileSection.tsx` のどれを変えても `success: no CODEOWNERS-owned file changed`。対照として `apps/api/src/gitCommitEvidence.ts` は `pending` | 採用 → `external-completion-approval-binding-not-codeowned` |

**finding の中身**: #425 は external completion reconcile の承認を **commit + 根拠に束縛**した
（`checkApprovalEvidenceBinding()`、`externalCompletion.ts:274`。呼び出しは `routes/tasks.ts:758`。
Gate は Task・action・期限・人の記録を見るが commit / 根拠は見ない、とコード自身が書いている）。
#418 は Code Owner 承認を **CODEOWNERS 対象 PR だけ**に必須にした。CODEOWNERS 28〜34 行は
「authority / cage を定義・実装する正本」を載せる、という 2026-10-08 CEO 決定の規則で、git_commit 側の同じ意味の正本
`gitCommitEvidence.ts` は載っている。**external completion 側の束縛は載っていない。** どちらの PR も単独では正しい。
組み合わさると、「人の承認が何に効くか」を決める predicate を、後の AI の PR が Code Owner 承認なしで弱められる。

**DA 候補の処分（specs/22 1-2 に照らして）**: **technical**。直す方向は既存規則（CODEOWNERS 28〜34 行）を、
#425 が新しく作った正本に当てはめることで、規則の意味は変えない。Safety を強める技術変更なので 1-3 に当たる
（1-2 末尾: 「Security 関連だから」「protected file だから」は Human Decision の理由にならない）。
Goal・Design Philosophy・AI authority の拡大・Safety boundary の弱化・不可逆な外部 commitment は、どれも変わらない。
**CEO へ承認を求めるものは無い。** 修正 PR は CODEOWNERS を変えるので、いつもどおり code-owner review を通る。
最終報告には事実として載せる（承認依頼にしない）。

- **checkedClean**: duplicate_owner / cross_layer_reinterpretation / incidental_representation / unnecessary_mechanism /
  principle_contradiction / surviving_failure_class / complexity_growth
- **uncertain**: production_divergence
- **false positive**: 0 件

**PL の補足（checkedClean への注記）**: Challenger は `surviving_failure_class` を clean としたが、前回の
`xta-97567fd-01`（greedy JSON）は window head でも閉じていない（3 章）。前回登録済みの finding は再掲しない規則なので
finding にはせず、3 章の追跡に書く。

## 3. 前回 finding の追跡 / escaped

| 前回 id | 状態 |
|---|---|
| `xta-d7b3ee1-01`〜`04` | `conflict-recovery-judgment-owner-split`（planned）。未着手 |
| `xta-97567fd-01`・`02` | `materiality-parser-greedy-json-reintroduced`（planned）。**未着手のまま、この window の 3 PR（#416・#420・#421）が同じ `designMateriality.ts` を変えた。** window head でも `extractJsonObject()` は `indexOf('{')`〜`lastIndexOf('}')`（`designMateriality.ts:509-513`）で、`operatorRequestStep.ts:208-212` も同じ。3 PR の M5 trial 結果はこの parser のまま出ている。同項目の Acceptance Criteria「M5 の結果に parse 修正前後の差を記録する」の比較対象が、この 3 PR 分だけ増えた |

**escaped: 1 件**（前回 window の変更に属するドリフトが、監査の外で見つかった件数）。
- 前回 window（`97567fd1..112a7a5a`）の #413 は Meta Review の DA routing を code-owner review に委ねたが、master Ruleset が
  `required_approving_review_count=0` のため、code-owner review は強制されていなかった（#413 は review 0 件で CLEAN）。
  前回の Challenger は `authority_tuple_drift` を checkedClean とした。**見つけた経路**: 前回監査の作業中に PL が GitHub の
  Ruleset を読んで見つけた（Challenger ではない）。CEO が Option B を選び、#418 で対処した。
  **なぜ見落としたか**: 原因は **repository の外の状態（GitHub Ruleset）**で、packet にも Challenger が読める tree にも無い。
  問いや packet を直しても届かないので、5 章の観測 5 で扱う。

## 4. 起動元への補足（window 起点の扱い）

起動元が渡した `--base e3677f93` は、前回記録の head（`112a7a5a`）ではなく、その記録 PR の merge commit だった。
CLI は `--base` を明示されると chain の head を使わず、警告も出さない（`cli.ts:139-140`）。ずれは
**次の監査で chain の genesis が 2 つ（"expected exactly one chain start, found 2"）として fail closed する**ので、
永久に黙って抜けるわけではない。ただし、抜けた window はその時点では監査されない。5 章の判断 3 で直す。

## 5. 仕組みの評価（3 回目。設計 7 章 / `observation-closes-loop`）

### 5-1. 3 回分の実測

| 回 | window | 発火理由 | finding（採用 / FP） | escaped（次回判明） | Challenger | packet |
|---|---|---|---|---|---|---|
| 1（10/26） | 12 変更 | deploy / fix chain / authority 2 変更 | 4（3 確認・1 未検証 / 0） | 0 | Claude 別 context | 89k |
| 2（10/26b） | 6 変更 | fix chain（誤検知）/ authority 5 変更 | 2（2 / 0） | **1**（Ruleset。repository 外） | Claude 別 context | 47k |
| 3（10/28） | 15 変更 | deploy / fix chain 3 / authority 11 変更 | 1（1 / 0） | —（次回） | **Codex gpt-5.6-sol**、160k tokens | 101k |

- **採用率**: 7 件中 6 件をコードまたは実行で確認、1 件は未検証、false positive は 0。採用 finding の roadmap item は
  **3 件とも planned のまま未着手**
- **発火条件の選別力**:
  - **authority surface**: 2/12 → 5/6 → 11/15 変更で成立。Meta Review・Code Owner 系の作業が続くと、ほぼ常に真になる
  - **引用ベースの fix chain**: 2 回目は誤検知 1・見逃し 2。今回の 3 件は、どれも前の PR の不具合修正ではなかった
    （#412→#419 は依存、#430→#355 は新しい owner への参照、#432→#430 はドキュメント）。
    同じ塊は churn（同じファイルに 3 変更、lift 上位）が毎回拾っている
  - **deploy 境界**: 1・3 回目の主発火。window の定義として機能している
- **finding はすべて、「新しい正本が既存の規則に乗っていない」形の組合せだった**:
  1 回目は判定 owner が 2 つ、2 回目は parser の再導入、3 回目は束縛 predicate が CODEOWNERS に無い
  （1 Task Review の「この PR は正しいか」には出ない）
- **コスト**: 毎回 Challenger 1 回。手での集計は、3 回分の表を作るのに記録 3 つを読むだけで足りた

### 5-2. 判断

**効力の範囲**: 以下は設計 7 章が 3 回目の記録に求める「仕組みの評価」であり、**この記録で発効するものは無い。**
`evaluateDue()` の発火条件・`--base` の扱い・設計記録 `cross_task_drift_audit_design.md` は、この PR の後も現行のままである。
2・3・5 は `cross-task-audit-trigger-revision`（planned）の提案で、効力はその実装 PR が通常の review（CI・Meta Review・該当すれば Code Owner）を
通ったときにだけ生じる。この監査は何も止めない仕組みで（設計 4・6 章）、Gate policy・Approval Tuple・Decision Authority のどれも変えない。

1. **継続する。** 3 回とも、per-Task review を通った変更の組合せから、確認できる欠陥が出た。false positive は 0、コストは 1 回あたり 1 呼び出し
2. **発火条件を変える**:
   - authority surface の重複は**発火条件から外し**、packet の情報（authority surface changes 節）としてだけ残す
   - 引用ベースの fix chain は **「同じファイルを window 内の 3 変更以上が触った」**（churn）に置き換える。
     既存の lift 順位とは別に、件数だけで判定する
   - deploy 境界はそのまま
3. **`--base` が chain head と違うときは、`due` / `packet` の出力に明示する**（抜ける変更の数と、chain head を出す）。止めはしない（Gate にしない）
4. **集計 script は作らない。** 3 回分の手集計で手間は小さかった。Improvement Planner が実装されたら、反復 finding の clustering は同項目へ移す（設計 5 章のまま）
5. **repository 外の authority 状態（Ruleset・branch protection）は、この監査の範囲外として明記する**。packet に載せる手段（read-only の GitHub API 読み取り）は新しい外部読み取りなので、本判断では入れない。escaped 1 件の原因として記録に残す

2・3 は `cross-task-audit-trigger-revision`（planned）として登録した。5 は設計記録の範囲を明記するだけなので、同項目の作業に含める。

## 6. 観測（次回の材料）

- **vendor 分離の初回**: Codex は 3 分ほどで 1 件だけ返した。claim・evidence・反証手順の形は Claude の 2 回と同じだった。
  1 件しかないので、vendor による差はまだ判断できない
- **未着手 finding が溜まり始めている**: 3 件とも planned。同じファイルを変える PR（#416・#420・#421）が先に入った。
  次回、採用 finding が実際に閉じたかを最初に見る
- **10/27 deploy `7fcb93a6` で監査が走らなかった件**: その deploy の変更は今回の window に入り、監査された。
  deploy 手順に due check を入れた後の最初の deploy（今回）では、check が実行された。起点の指定ミスは 4 章のとおり
