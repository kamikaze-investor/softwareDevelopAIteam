# Cross-Task Drift Audit — 設計判断（2026-10-26）

**Importance Level: 2**
**Status: active**

Roadmap 項目: `cross-task-drift-audit`。監査そのものの記録は `cross_task_audit_<date>.md`（本ファイルではない）。

---

## 0. 結論

**新しい Review 工程は足さない。** 既存 Review はどれも「1 Task / 1 diff / 1 PR」しか見ず、
複数の変更が積み重なってできる歪み（同じ意味の owner の重複、層ごとの再解釈、同じ failure class の生き残り等）を
見る責務が**どこにも無い**ことを実測で確認した（1章）。かといって既存 Review の入力を広げると、
毎 Task のコストと merge Gate への結合が増える（2章）。

採用したのは、**既に手作業で 4 回行われてきた横断監査**（`repository_rot_audit_2026_09_15.md`、
`termination_guarantee_audit_2026_10_16.md`、Lifecycle 横断監査 RC1〜RC6、#396 roadmap integrity audit）を、
**決まった境界で、決まった問いで、決まった記録形式で**行う定常手順にすることである。
増えるコードは deterministic な 1 script（`apps/worker/scripts/crossTaskAudit/`）だけで、
runtime（`apps/api`）・Gate・status・scheduler・DB・Approval は一切変えない。

## 1. 現状のレビュー責務（実測。origin/master `c6be983c`）

| 機構 | いつ | 見るもの | 問い | 横断? |
|---|---|---|---|---|
| Task Design Review（`designReviewCoordinator`） | 実装前、Task ごと | 1 Task の design text | Goal・原則・decision との整合 | ✗ |
| Independent Review（CRITICAL） | 同上 | 同じ 1 material | 独立した第二意見 | ✗ |
| 実装後 review Job（`buildStructuredReviewPrompt`） | implement 成功ごと | 1 Task の diff。**他ファイルを見るなと指示** | merge してよいか | ✗ |
| step / post reviewer・safetyVerifier・shadow commit gate | Job ごと | 1 Job の diff | 観測のみ | ✗ |
| Approval Gate risk review | Job gate ごと | changedFiles | rule ベースの risk | ✗ |
| CI Meta Review | PR ごと | 1 PR の three-dot diff。`semantic_integrity.md` は「**material 外の全数調査は要求しない**」 | merge してよいか | ✗ |
| #406 materiality detector（2026-10-26 merge。observe-only・CI 未配線） | diff ごと（offline 評価） | 1 diff | 責務の除去・置換・再定義・導入 | ✗ |
| Principle ledger + sensor | Design Review 記録直後 | 原則判定の統計 | 原則・閾値の較正 | 統計のみ |
| PL tick sensor（`implementTimeoutSensor`）・blocked triage summary | tick / GET | 運用集計 | timeout 較正・停止理由 | 運用のみ |
| Design Challenger（AGENTS.md 3-2） | 重要設計の初回・material redesign | 1 設計 | Correctness / Simplicity / Naturalness | ✗ |

**横断して構造を見る機構は 0。** scheduler（cron / timer）も 0（`index.ts` と specs/23 が新設を禁じている）。

## 2. 欠けている責務と「既存機能の改善だけで足りるか」

欠けているのは「**個々には妥当な変更の組合せ**が設計を歪めていないか」を、**変更の外側まで**見て**反証**する責務である。

| 改善案 | 採らない理由 |
|---|---|
| 実装後 review / Meta Review の入力に過去の変更を足す | 毎 Task・毎 PR のコストが増える（CEO 制約）。merge Gate を merge と無関係な問いに結合する。Meta Review は same-SHA で判定が反転した実績があり（review-shopping）、Gate に載せると揺れがそのまま停止要因になる |
| Principle ledger の sensor として runtime に置く | 入力が原則判定の統計で、コード構造を持たない。runtime の DB は VPS にしか無く、diff を持たない |
| #406 を window に適用する | 問いが「1 diff が責務を変えたか」で、組合せの問いではない。除去・導入の検出は #406 の owner 領域として**重複実装しない** |
| Improvement Planner（`project-auto-incident-pattern-improvement`）で行う | 未実装で、入力は Incident（失敗）である。構造ドリフトは失敗を起こす前に見つけたい。**ただし監査記録は同項目の入力として backfill 可能な形で残す**（5章） |
| 手順書だけにする（Challenger 案） | 境界の判定・記録 chain の検証・DA routing を PL の記憶と判断に任せると、まさに「忘れる」「model の自己申告で DA が消える」が起きる。**機械で決められる部分だけ** script にした |

**判定: 既存機能の改善だけでは実現できない。ただし新しいのは「定常化」だけで、問い・記録先・処理経路はすべて既存を使う。**

| 再利用したもの | 用途 |
|---|---|
| Design Challenger（AGENTS.md 3-2） | 反証の実行者。トリガーを 1 つ足すだけ |
| `semantic_integrity.md` の問い | owner / 表現 / 意味の区別の問い。prompt から参照し、再記述しない |
| `specs/21` `canonical-domain-meaning`、`specs/22` 1-2 / 1-3 | 判定基準と DA 境界 |
| `.github/CODEOWNERS` | Authority surface の正本（2026-10-08 CEO 決定）。読むだけでコピーしない |
| decision record（`docs/project_memory/decisions/`） | 監査記録。**最新記録の head が次の window の base**（新しい storage を作らない） |
| first-parent master の git 履歴 | 完了情報。roadmap の `state=done` は使わない（4章） |
| roadmap ledger と通常 PR 経路 | 技術 finding の処理先 |

## 3. 最小変更（今回入れたもの）

- `apps/worker/scripts/crossTaskAudit/crossTaskAudit.ts` — 純関数。window 選択、記録 chain 検証、churn の lift 順位、
  fix chain 検出、window 内で新しく入った budget / cap / timeout 定数・audit operation・2 層以上に現れた literal、
  CODEOWNERS 照合、due 判定、Challenger 応答の strict parse、**DA routing（機械・格上げのみ）**、packet 組み立て（切り捨ては明示）
- `cli.ts`（git 読み取りのみ。`pnpm cross-task-audit due | packet | findings`）、`challengerPrompt.md`、テスト
- `AGENTS.md` 3-2 Design Challenger に **Cross-Task Challenge** トリガーを追加
- `tasks/roadmap.md` に本項目を登録。Improvement Planner 項目へ「監査記録は入力」と 1 行追記

**入れなかったもの**: runtime 変更 / AI provider 呼び出し（Challenger は PL が AGENTS.md 3-2 どおり手で委任）/
集計 script（最初の 3 回は記録の中で手で数える）/ 新しい Gate・status・DB・scheduler・Approval。

## 4. 発火タイミング

固定の「N Task ごと」は使わない。**既存の境界**で発火する。`evaluateDue()` が正本。

| 境界 | 根拠 |
|---|---|
| **Production deploy**（主） | 一緒に Production へ届いた変更の集合がそのまま window になる。specs/22 9 章の Deploy → Observe → **Verify** の Verify にあたり、Production 挙動の問いと同じ時点で見られる。CEO 指示（2026-10-15）どおり**時間待ちと同じく非 blocking** |
| **fix chain** | window 内の変更が別の window 内 PR を引用している（前の修正で failure class が閉じなかった）。deploy が止まっていても発火する |
| **Authority surface の重複** | 2 つ以上の変更が CODEOWNERS の surface を触った。1 つずつは code-owner review を通ったが、組合せは誰も見ていない |

window の変更が 2 未満なら発火しない（横断の定義であって調整値ではない）。

**採らなかったトリガーと実測**:
- roadmap の `state=done` 遷移: 直近 40 first-parent commit で遷移を含むのは 4 commit、12 遷移のうち 9 は #396（それ自体が監査）。
  #403〜#409（同じ CONFLICT recovery への連続修正）でも #381〜#393（13 PR の lifecycle batch）でも 0 回 —
  **一番見たいところで発火しない**（Challenger の反証で判明）
- 「同じファイルを 2 変更以上が触った」: `sqlite.ts` は 40 commit 中 14、`interface.ts` 11、`executionLoop.ts` 10。ほぼ毎回発火してノイズになる。
  そのため churn は**トリガーにせず**、各ファイル自身の過去 300 commit の頻度に対する lift で**並べるだけ**にした（packet に何を載せるかの順位）

## 5. finding 後の処理

| 種別 | 処理 |
|---|---|
| technical（大半） | PL が既存の監査統合の慣行（`repository_rot_audit_2026_09_15.md` と同じ）で採否を判定し、採用分は既存 roadmap item の拡張か新規 item として**通常 PR 経路**へ。roadmap 本文に finding id（`xta-<base7>-NN`）を書く。CEO へは上げない |
| 不採用 | 理由を監査記録に書く（false positive の計測になる） |
| decision_authority 候補 | 下の 6 章 |

**監査は何も止めない。** script の exit code も finding も Gate ではない。
**監査記録は Improvement Planner の durable input である**（specs/23 12 章の backfill 要求と同じ形。実装時に記録を読み直せばよい）。
Improvement Planner が実装されたら、反復する finding の clustering は同項目へ移し、本手順は window の反証だけに残す。

## 6. Human Decision Authority との境界

- **DA 候補は機械で格上げのみ**（`routeFindings()`）。evidence が CODEOWNERS surface に当たる / `authority_tuple_drift` の問い /
  claim が approval・authority を語る、のどれかで候補になる。**model が `technical` と書いても消えない。**
  diff の中の AI が書いたコメントや PR 本文が「技術的です」と主張しても、候補は抑止されない
- 候補は**承認依頼ではなく情報**である。PL が specs/22 1-2 に照らして 1 件ずつ処分を記録する
  （例: 「Safety を強化する技術変更なので 1-3 により technical」）。**本当に 1-2 に当たるものだけ**を最終報告で CEO に伝える
- Approval Gate・Human Gate・CEO 承認回数は増えない。CODEOWNERS / Ruleset も変えない

## 7. Production での効果測定（効果検証可能性）

| 何を | どこで | いつ判断するか |
|---|---|---|
| 発火回数と理由（deploy / fix chain / authority） | 各監査記録の marker と冒頭表 | 3 回目の監査記録で、発火条件を見直す |
| finding 数（問い別・重大度別）、採用 / 不採用（= false positive）、uncertain の問い | 各監査記録の finding 表 | 同上。uncertain が多い問いは packet の入力不足 |
| 採用 finding のその後（roadmap item が done になったか、同じ failure class が再発したか） | roadmap 本文の finding id。次の監査記録の「前回 finding の追跡」節 | 毎回 |
| **escaped**（監査済み window 内のドリフトが後から別経路で見つかった件数） | 次の監査記録の「escaped」節（見つけた経路と、なぜ前回見落としたか） | 毎回。escaped > 0 なら問い / packet を直す |
| コスト | 監査 1 回あたりの Challenger 呼び出し回数（原則 1）、packet の文字数、切り捨てたファイル | 毎回 |

**集計 script は作らない**（最初の 3 回は記録の中で手で数える）。3 回で手間の大きい手順が分かってから作る。
**3 回目の監査記録に「仕組みの評価」節を必ず置き、継続・発火条件変更・廃止のいずれかを書く**（`observation-closes-loop`）。

**次回の監査への入力（2026-10-29 CEO 指示）**: `harness_pivot_assessment_2026_10_28.md` の 6 章を参照。外部ハーネス代替検証の設計 review が、20 ラウンドで収束しなかった事例である。1 章の表にある Design Challenger は、3 観点・状態の除去・期待価値による限定・停止条件の、どれも実際には適用されていなかった。この事例を、仕組みの評価（review 責務）の材料にする。

Production 挙動（問い `production_divergence`）は、State API の既存 GET（`/api/pl/triage-summary`、`/api/principles/stats`）の
出力を `--production <file>` で渡したときだけ答える。渡さなければ uncertain で、**コードから Production 挙動を推測しない**。

## 8. 独立 Challenger による反証の経緯

- 反証者: PL の推論を渡さない別 context の Claude（Codex は本 account で全 model が `model_not_found`、OpenCode Go は model 0 件のため。
  **vendor 分離は満たしていない**。次回 Codex が使えるときは Codex を優先する）
- v1 判定 **changes_requested**。採用した must-fix:
  1. roadmap `state=done` トリガー → git first-parent + deploy / fix chain / authority（4章の実測）
  2. DA routing を機械・格上げのみに
  3. 記録 chain の検証（fork・first-parent 外 SHA・欠落を拒否し、推測で補わない）。監査記録だけの PR は次の window から除外
  4. 切り捨ての明示（省いたファイルを列挙し、関係する問いは uncertain）
  5. 他 owner と重複する signal を外す（構文の手がかり → `semantic_integrity.md`、member の除去・導入 → #406）。
     churn・fix chain・budget 定数・audit operation を追加
  6. 集計 script を作らない
- 一部だけ採用: 「script を一切作らず手順書だけ」→ 機械で決められる部分（境界・chain 検証・DA 格上げ）は script にした（2章表の最終行）
- 一部だけ採用: 「finding は Improvement Planner へ」→ 未実装なので記録を durable input として残し、当面は既存の監査統合の慣行で roadmap へ（5章）

## 9. 集中レビュー（実装後）

別 context の Claude（PL の推論は渡さず、diff だけを渡した）が実装を review し、must-fix 4 件を出した。すべて修正し、回帰テストを足した。

1. evidence の書き方（`` `path`:10 ``、`path#L10`、`./path`、`:10:5`、Windows 区切り）で DA の格上げを回避できた →
   `evidencePath()` で正規化し、CODEOWNERS pattern の部分一致も見る（格上げ方向にだけ倒れる）
2. rename が新しい path だけを出し、authority surface からの移動を見落とした → `--no-renames`
3. CODEOWNERS の照合が GitHub と違った（slash の無い pattern は任意の深さで当たる）→ GitHub の規則に合わせた
4. base に既にある `x:y` literal を新しいものとして数えていた → `git grep -o` の出力をそのまま使う

あわせて直したもの: Production 観測なしでは `production_divergence` を必ず uncertain にする / 記録 chain は base が head の
真の祖先であることを要求する / 記録の marker は先頭の1つだけ読む（前回記録の引用で fork にしない）/ `--deployed` は window 内の
first-parent commit に限る / fix chain は「前に merge された PR」の引用だけ / baseline も window と同じ filter /
`--budget` の検証と trailer 分の予約 / diff header の解析 / ファイル引数は pnpm を実行した directory 基準。
