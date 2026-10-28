# Cross-Task Audit 2026-10-26b（#409・#411・#406・#414・#415・#413）

<!-- cross-task-audit base=97567fd1b4883ecf81dd07bfbf1bc364c705d335 head=112a7a5a72fde4f108c39d3628bb577ce43e2dcb -->

**Importance Level: 2**
**Status: active**

手順は `cross_task_drift_audit_design.md`。2 回目の監査。前回記録 `cross_task_audit_2026_10_26.md` の head（`97567fd1`）を
**`--base` 無しで自動で引き継いだ**（chain issues 0）。

## 1. Window と発火

| 項目 | 値 |
|---|---|
| window | `97567fd1..112a7a5a`（first-parent master、6 変更 = #409・#411・#406・#414・#415・#413） |
| 境界 | deploy 境界ではない（この window は未 deploy） |
| 発火理由（`evaluateDue()`） | fix chain: #413 が #406 を引用 / CODEOWNERS surface を 5 変更が触った |
| churn 上位（lift） | `apps/worker/src/metaReviewer/designMateriality.ts` 3 window / 0 baseline・lift 119、`docs/meta_reviewer/design_materiality_detection.md` 同 |
| packet | 46,857 文字、hotspot 2 ファイル、**切り捨て 0** |
| Production observation | 未提供。`production_divergence` は uncertain（`findings` が機械的に固定） |
| Challenger | 1 回。PL の推論を渡さない別 context の Claude（vendor 分離なし。前回と同じ理由） |

## 2. Finding と処分

| id | 問い | 重大度 | routing（機械） | PL の確認 | 処分 |
|---|---|---|---|---|---|
| `xta-97567fd-01` | surviving_failure_class | medium | **decision_authority 候補**（evidence が CODEOWNERS の `apps/worker/src/metaReviewer/`） | **実行で再現**: 正しい detection JSON の後ろに `}` を1つ付けると `parseDetection()` が `no_json` を返す（`#409` の commit message にある Production 2026-10-26 の応答形そのもの） | 採用 → `materiality-parser-greedy-json-reintroduced` |
| `xta-97567fd-02` | duplicate_owner | low | **decision_authority 候補**（同上） | 確認（worker は既に `@ai-team/shared` に依存している） | 採用 → 同上 |

**DA 候補の処分（specs/22 1-2 に照らして）**: 2 件とも **technical**。parser の正しさの修正であり、
Goal・Design Philosophy・AI authority・Safety boundary のどれも変えない（1-3）。evidence が Meta Review のコード
（CODEOWNERS 対象）にあるので候補になったが、CODEOWNERS 対象であること自体は Human Decision の理由にならない（1-2 末尾）。
**CEO へ上げるものは無い。** 修正 PR はいつもどおり code-owner review を通る。

- **checkedClean**: cross_layer_reinterpretation / incidental_representation / unnecessary_mechanism / principle_contradiction /
  authority_tuple_drift / complexity_growth（#413 自身の DA routing も「格上げのみ・承認依頼にしない」として確認された）
- **uncertain**: production_divergence
- **false positive**: 0 件

**所見**: #409 が CONFLICT 経路の 3 parser から「最初の `{` から最後の `}`」を取り除いた約 1 時間後に、
#406 が同じ形の parser を Meta Review 側に新設し、#414・#415 がその parser を 2 度直しながら形を残した。
**parse 失敗は `unavailable` になり、M5 評価ではそれが「検出しなかった」として数えられる**ので、
この欠陥は M5 が測ろうとしている recall を黙って下げる。どの PR も単独では正しく、組合せでだけ見える。

## 3. 前回 finding の追跡 / escaped

| 前回 id | 状態 |
|---|---|
| `xta-d7b3ee1-01`〜`04` | `conflict-recovery-judgment-owner-split`（planned）。未着手 |

**escaped**: 前回 window（#395〜#408）に属するドリフトが今回別経路で見つかった件数は **0**。
ただし今回の 01 と同じ class（greedy JSON）は前回 window にも `operatorRequestStep.ts` に存在しており、
前回の packet の hotspot に入っていなかったため Challenger の material に無かった（前回の問いの範囲外として escaped には数えないが、
「hotspot 外の同 class」は packet の構造的な死角として 4 章に記録する）。

## 4. 仕組みについての観測（3 回目の評価の材料）

- **記録 chain の自動引き継ぎ: 成功**（`--base` 無しで前回 head を base にし、chain issues 0）。#413 の squash commit は window に
  通常の変更として入った（記録だけの PR ではないため。設計どおり）
- **fix chain の誤検知 1 / 見逃し 2**: 「#413 cites #406」は修正ではなく重複回避の言及（誤検知）。逆に #414・#415 は #406 の
  follow-up なのに引用が無く、fix chain として拾えなかった（見逃し）。**引用ベースの fix chain は精度が低い。** ただし同じ塊は
  churn（`designMateriality.ts` 3 変更・lift 119）が正しく最上位に出した。3 回目の評価で「fix chain を発火条件から外し churn の
  同一ファイル 3 変更以上で代替するか」を判断する
- **authority surface 条件は 6 変更中 5 で成立**（Meta Review 系の連続作業）。この window ではほぼ常時真で、選別力が低い
- **DA の機械格上げ: 2 件とも model の `technical` を格上げし、PL が書面で technical に処分した**（初の実例。CEO 負荷 0）
- **packet の死角**: hotspot に入らないファイルの同 class（今回は `operatorRequestStep.ts:212` の greedy JSON）は Challenger の
  material に入らない。Challenger は repository を読めるので今回は自力で見つけた
- **Meta Review の判定揺れ（本監査の外で観測）**: #413 は PR diff が byte 単位で同一の 3 回の run で、verdict は 3 回とも approved だが
  risk が high → medium → critical と変わった（`independent-review-verdict-instability` と同じ現象）
- コスト: Challenger 1 回、packet 47k 文字
