# Cross-Task Audit 2026-10-30（Production deploy 52e0e779 / 1a8a63c1、#437〜#446）

<!-- cross-task-audit base=67f9f351cc90581b6fceba7f3c6b5519331386d5 head=1a8a63c1cf13c529ec86683ec35166c84f60bb13 -->

**Importance Level: 2**
**Status: active**

手順は `cross_task_drift_audit_design.md`。4 回目の監査。

**base は記録 chain が今出す値（`112a7a5a`）ではなく、`67f9f351` を明示した。** 3 回目の記録
`cross_task_audit_2026_10_28.md`（window `112a7a5a..67f9f351`）は **PR #436 で未 merge** なので、今の master では chain の
最新 head がまだ `112a7a5a` である。同じ 15 変更を二重に監査しないため、#436 の window head `67f9f351` から積んだ。
**この記録は #436 に依存する**（6 章）。

## 1. Window と発火

| 項目 | 値 |
|---|---|
| window | `67f9f351..1a8a63c1`（first-parent master、5 変更 = #437・#441・#440（merge）・#435・#446） |
| 境界 | **deploy 境界が 2 つ**: 2026-10-29 の `52e0e779`（#435 + #437/#440/#441。Worker-only）と、2026-10-30 の `1a8a63c1`（#446。API-only）。**10/29 の deploy の後には due check が実行されていない**（5 章の観測 1） |
| 発火理由（`evaluateDue()`） | deploy boundary 1a8a63c1 / CODEOWNERS surface を 3 変更（#437・#441・#440）が触った。fix chain なし |
| churn 上位（lift） | **なし**（window 内で 2 変更以上が触ったファイルが 0） |
| packet | script 出力は 7,050 文字で **hotspot 0・コード 0**。PL が付録として window の非 test diff 全体と roadmap 差分を足した（計 93,261 文字）。5 章の観測 2 |
| Production observation | **提供した**（2026-10-30 の HTTP 410 incident。2 章末） |
| Challenger | 1 回。local Codex `gpt-5.6-sol`（reasoning high、read-only sandbox、window head の worktree）。probe OK を確認してから実行 |

## 2. Finding と処分

分類: **確認済み欠陥**（再現あり）/ **仮説** / **既知の制約** / **解決済み** / **誤検知**。

| id | 問い | Challenger の重大度 | routing（機械） | PL の確認 | 分類と処分 |
|---|---|---|---|---|---|
| `xta-67f9f35-03` | production_divergence | high | technical | **実行で再現**（下記） | **確認済み欠陥・重大度 medium**。04 と同じ欠陥 → `cheap-ai-provider-error-dropped`（planned） |
| `xta-67f9f35-04` | surviving_failure_class | high | technical | 同上 | 03 と統合 |
| `xta-67f9f35-01` | incidental_representation | medium | technical | **反証**: `output_overflow` を返す箇所は `runInsideCgroup()` の `isContainmentSafe(cleanup.outcome)` の内側 1 箇所だけ（`runContainedCommand.ts:611-625`）。これを AST で全数確認するソース不変条件テストが既にある（`runContainedCommand.test.ts:144`「output_overflow は後始末が安全だった分岐の内側でだけ返る」）。Challenger の反証手順（error を手で組み立てる）は production の経路ではない | **誤検知**（既存の安全装置が既に固定している）。処分なし |
| `xta-67f9f35-02` | duplicate_owner | medium | **decision_authority 候補**（evidence が CODEOWNERS の `docs/meta_reviewer/`。claim が approval / authority を語る） | **反証**: checklist の節は自分を要約と位置づけ、本文は「詳細は `prompt.md`」と prompt を正本として指す。#437 の契約テスト（`promptDecisionAuthorityContract.test.ts` の containment 節）が、prompt の条件 1〜6 の文を 1 つずつ、checklist の対応文も固定しているので、片方だけ変えると CI が落ちる。prompt = 規則、checklist = 確認項目、という既存の分担（DA (2) の節と同じ形） | **誤検知**。処分なし |

**03・04 の中身（確認済み欠陥）**: OpenCode CLI は provider のエラーを **stdout の JSON event** として出し、stderr を空のまま exit 1 する
（#446 の commit message にある Production 実測）。`runOpenCodeCli()` は exit≠0 のとき **stderr だけ**から message を作る
（`cheapAiClient.ts:380-384`）。**再現**（2026-10-30、window head、既存テストと同じ spawn mock、使い捨てのテストファイル。commit していない）:
stdout に 410 の error event・stderr 空で

- exit 1 → `OpenCode CLI failed with exit code 1`
- exit 0 → `OpenCode CLI response did not contain text`（`parseOpenCodeOutput()` も error event を読まない）

どちらも 410 が消える。Production の audit_log に原因が無かったこと、2026-10-23 の 10 件が同じ見え方だったことと一致する。

**組合せとして**: 「provider の原文を失敗理由に残す」扱いは Design Review 経路には `ce9df9b`（#186、stderr 保持）で入っており、
`provider-outage-burns-attempt-budget` の実測はそれで原因が残った。cheap AI 経路には乗っていない。#446 は model id だけを直したので
（それ自体は正しい最小修正）、次に provider がエラーを返したときも同じく原因が見えない。

**重大度を medium にした理由**: Safety・整合性への影響は無い（fail closed で Task / Job を作らず、通知も 1 通、復旧後は自動再開。4 章）。
影響は、自律運転が止まったときに原因が分かるまでの時間（2 回とも人が CLI を手で実行するまで不明）。24h 自律の KPI（CEO 介入回数・
無人時間）に直接効くので low ではない。

**最小の修正**: `cheapAiClient.ts` の中だけで、stdout の error event の本文を既存の `redactApiKey()` を通して長さを切り、message に足す。
retry 分類・通知・fingerprint は変えない（通知へ自由文を流さない既存の規則 `executionLoop.ts:777` はそのまま。原文は audit にだけ残る）。
`cheap-ai-provider-error-dropped`（planned）として登録した。

**DA 候補の処分（specs/22 1-2 に照らして）**: `xta-67f9f35-02` は機械で格上げされたが、誤検知であり、内容も Meta Review の文書の
重複有無という technical な問い。Goal・Design Philosophy・AI authority の拡大・Safety boundary の弱化・不可逆な外部 commitment の
どれにも当たらない。`cheap-ai-provider-error-dropped` も technical（診断情報を audit に残すだけ）。**CEO へ承認を求めるものは無い。**

- **checkedClean**: cross_layer_reinterpretation / unnecessary_mechanism / principle_contradiction / authority_tuple_drift / complexity_growth
- **uncertain**: なし（Production observation を渡したので production_divergence も答えた）
- **false positive**: 2 件（01・02）

## 3. 前回 finding の追跡 / escaped

| 前回 id | 状態 |
|---|---|
| `xta-d7b3ee1-01`〜`04` | `conflict-recovery-judgment-owner-split`（planned）。未着手。この window は触っていない |
| `xta-97567fd-01`・`02` | `materiality-parser-greedy-json-reintroduced`（planned）。未着手。この window は `designMateriality.ts` を触っていない |
| `xta-112a7a5-01` | `external-completion-approval-binding-not-codeowned`（#436 で planned 登録。#436 未 merge のため master にはまだ無い）。この window は `externalCompletion.ts`・`routes/tasks.ts` を触っていない |

**escaped: 0 件**（#436 の window に属するドリフトが、その監査の外で見つかった件数）。

## 4. 既存の安全装置は効いたか（10/30 incident）

| 安全装置 | 結果 |
|---|---|
| 採用失敗で Task / Job を作らない（fail closed） | **効いた**。障害中に Task / Job は 0 件 |
| 採用の attempt 予算（`PL_MAX_ADOPTION_ATTEMPTS = 2`）と escalation | **効いた**。2 回で escalation、窓が切り替わり約 3 分ごとに再試行。復旧後は人手なしで再開（07:08Z、Task ab2b2bcc） |
| 通知の incident 単位の重複抑止（`adoptionFailureFingerprint()`） | **効いた**。LINE は 1 通だけ。ただし fingerprint は `30|diagnosis_failed` で原因が載らない（2 章） |
| 通知へ外部由来の自由文を流さない（`executionLoop.ts` の `STRUCTURED_AUDIT_FIELDS`） | **意図どおり**。provider 文面は通知に出ない。原文は audit に残る前提だが、その audit に原因が無かった |
| 承認説明の失敗は承認を止めない（`generateApprovalExplanation()` は `{ ok: false }`） | **効いた** |
| deploy canary | 対象外。canary は Gemini / Codex の経路だけで、cheap AI（OpenCode）経路を見ない。また model の廃止は deploy 後に起きたので、canary があっても検出できない（known limitation。常時 probe は新しい監視で、この監査の範囲外） |
| 修正 #446 | **最小で正しい**。model id 1 行だけ。repository に `mimo-v2.5` を参照するコードは残っていない（`git grep`、docs と roadmap の文中 5 件のみ） |

## 5. 観測（次回の材料）

1. **10/29 の deploy `52e0e779` の後、due check が走っていない。** 10/27 の `7fcb93a6` に続き 2 回目。
   その deploy の変更はこの window に入り、監査されたので抜けは無い。原因は前回と同じく、手順が文書（AGENTS.md 3-2・
   deploy 手順メモ）にだけあり、実行を何も強制しないこと。設計上「何も止めない」ので Gate にはしない。
   次回の deploy でも抜けたら、`cross-task-audit-trigger-revision` の評価で扱う
2. **小さい window では packet にコードが 1 行も載らない。** hotspot は「window 内の 2 変更以上が触った」ファイルだけで、
   5 変更がすべて別ファイルを触ったこの window では 0 件だった。今回は PL が diff を足したが、script の出力だけを渡すと
   Challenger は commit 名とファイル名だけで判断することになる。`cross-task-audit-trigger-revision` の作業で、
   hotspot が 0 のときの packet の中身（例: window の非 test diff を budget 内で載せる）を合わせて決める
   （新しい roadmap 項目は作らない）
3. **採用 finding の形は 4 回とも同じ**: 「ある経路で直した失敗の扱い・規則が、隣の経路に乗っていない」。
4. **false positive が初めて出た**（2 件）。どちらも「既存のテストがその不変条件を既に固定している」ことを Challenger が
   見なかったもの。累計は 11 件中 確認 7・未検証 1・誤検知 2・統合 1。コストは Codex 1 回（約 144k tokens、数分）
5. **Production observation を渡すと、production_divergence が初めて答えられた**（1〜3 回目は uncertain 固定）。今回の確認済み欠陥は
   この観測から出た。incident があった window では、観測を渡す方が効く
6. 採用済み finding の roadmap 項目は、今回の分を含めて 4 件とも planned のまま（3 章）

## 6. #436 への依存と chain

- この記録の base `67f9f351` は、#436 の記録の head である。**#436 とこの PR の両方が merge された後**、chain は
  `…→97567fd1→112a7a5a→67f9f351→1a8a63c1` の 1 本になり、次回の `due` は `--base` 無しで `1a8a63c1` から始まる
  （**実測**: この PR の commit と #436 の head `9c00cb26` を `git merge-tree` で合わせると衝突 0。その tree の一時 merge commit で
  `due --head <それ>` を `--base` 無しで実行すると、chain issues 0・base `1a8a63c1`・変更 0 で due false）
- **この PR が #436 より先に merge された場合**、chain の起点が 2 つになり（`112a7a5a` で止まる鎖と、`67f9f351` から始まる鎖）、
  `due` は "expected exactly one chain start, found 2" / "expected exactly one latest record, found 2" で fail closed し
  `--base` を要求する（この PR の HEAD で実測）。#436 が merge されれば直る。**順序は #436 → この PR が望ましい**
- #436 は 2026-10-30 時点で OPEN・BEHIND master。この PR は #436 を変えていない
