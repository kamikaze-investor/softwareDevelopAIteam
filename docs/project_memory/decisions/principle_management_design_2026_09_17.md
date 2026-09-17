# Principle 管理の設計決定（Registry / 適用記録 / Review 統合）（2026-09-17）

**Status: active**
**判断者: CEO（2026-09-17 指示）/ 実測・設計整理: Claude（PL Role）**

同日の `safety_approval_design_principle_adoption_2026_09_17.md` とは別件である。
あちらは Safety / Approval の**原則の採用**、こちらは**原則そのものの管理方法**を扱う。

---

## 1. CEO 指示（2026-09-17）

原則数が増えたため、「毎回すべての原則を prompt へ貼る」方式をやめる。

- Task / changedFiles / risk / Roadmap item から**関連原則を機械的に選択**する
- **既存 Review** で遵守確認する（新しい独立 Review workflow を先に作らない）
- 原則本文の正本は **Git**。DB を正本にしない
- 「どの Task にどの原則が適用され、どの Review でどう判定されたか」は **DB へ構造化**して記録する
- 記録は**新しい metrics backend を作らずに**集計可能にする
- 原則自体の品質シグナルから**再Review 候補へ戻す**。**自動書き換えは作らない**

## 2. 最大の発見: contextual principle selection は既に稼働していた

調査前の想定は「これから作る機能」だったが、**実測の結果 prompt 側は既に実装済み**だった
（PR #84 `62cceed`、Roadmap item 無しで入っていたため誰の視界にも無かった）。

- `specs/21_outcome_oriented_generalization_principle.md` が `principle-id` /
  `principle-oneliner` マーカー付きの**機械可読 Registry** になっている
- `packages/shared/src/engineeringPrinciples.ts` が marker で本文を引き、
  `selectPrincipleSlugs({ predictedFocuses, riskLevel })` で**contextual に選択**し、
  `buildDesignContract()` が **one-liner だけ**を prompt へ載せる
- changedFiles → 選択 signal の変換も `mapFileToFocuses()` として既にある
- 読み込み失敗は `ok:false` として表面化し、
  「未取得なのに適用済みに見える」状態を作らない設計になっている

**つまり CEO 指示のうち「毎回全文を貼らない」は、implement prompt 経路では既に達成されている。**
不足は Registry の側ではなく、**Review 側と記録側**だった。

## 3. 実測した欠落（4 つの呼び出し箇所と Review 側をすべて読んだ）

1. **`riskLevel` が production で一度も渡されていない。** `RISK_PRINCIPLE_SLUGS` は
   定義だけあって効いていない。`routes/jobs.ts:314` と `repairPromptBuilder.ts:162` は
   **引数なし**呼び出しで、core 原則しか載らない
2. **Review 側は contextual selection を使っていない。**
   `buildEngineeringPrincipleReviewGuidance()` は 3 件固定で、focus が何であれ同じ
3. **原則単位の判定が無い。** 判定は focus 単位まで。`Pxxx: ALIGNED` は出力契約に無い
4. **適用履歴が残らない。** 集計は現状どう頑張っても不可能
5. **原則が 5 ファイルに散り、機械可読なのは `specs/21` だけ。**
   `specs/00` 3.14〜3.18 は `constitutionPrinciples.ts` が**章まるごと本文を貼る**
   （id も選択も無い = CEO が問題視した方式そのもの）

## 4. 決定: Source of Truth は Git、DB は適用記録のみ

原則本文・定義を DB へ入れない。DB が持つのは `principle_id` と本文 hash だけである。

**これは新方針ではない。** `supervised_runs` schema の D-2 が既に
「判定ロジックは DB に置かない。code 側 registry を引くキーと版だけを保存する」と決めており、
同じ形を踏襲するだけである。

**移設は段階的にする。** `specs/00` / `specs/20` / `specs/22` / Design Philosophy を
いきなり `specs/21` 形式へ移さない。まず既存 11 件で記録が取れることを確かめる。
効果が分からないまま 5 ファイル分の正本を動かすのは、Design Philosophy の二重正本問題
（2026-09-16 に Project レコードへ一本化したばかり）を繰り返す動きである。

## 5. 決定: 適用記録は専用 table 1 枚。`audit_log` に相乗りさせない

CEO 指示どおり、押し込めるかを先に検討した。**結論は専用 table**。

**採用しなかった理由（クエリ形状と責務。性能ではない）**:

- `audit_log` の索引は `ix_audit_log_entity (entity_type, entity_id, created_at DESC)` **1 つだけ**で、
  安いアクセス経路は「ある 1 entity の履歴」に限られる。
  CEO が要求した集計は `principle_id` / `project_id` / `verdict` / `review_stage` / `reviewer` の
  **多次元 GROUP BY と自己 JOIN**（Reviewer disagreement は同一 (subject, principle) への
  別 reviewer の判定を突き合わせる）であり、1 次元キーでは表現できない。
  `detail` JSON へ入れれば全件 scan + `json_extract` になり、索引を張るには
  `audit_log` へ列を足すことになる — それは**全監査利用者が共有する table の変更**である
- `audit_log.result` は既に operation ごとに語彙が違う（`acted` / `escalated` / `failure` 等）。
  ALIGNED / CONFLICT / UNCERTAIN を足しても壊れはしないが、
  **PL の試行回数計算が `result` 値の集合に依存している**
  （`executionLoop.ts` の `ATTEMPT_RESULTS` / `hasEscalated()`）ため、語彙を増やすほど読みにくくなる
- `review_results` / `design_review_evidence` も検討したが、どちらも **review 実行 1 回 = 1 行**であり、
  原則単位は本質的に子レコードになる。`design_review_run_id` で JOIN する形にする

**性能を理由にしなかったのは、実測して否定されたからである。**
当初は「audit_log が肥大して PL ループが遅くなる」と考えたが、
PL の読みは `findByEntity()` で上記索引に載っており、別 `entity_type` の行を足しても劣化しない。
**測る前に書いていたら、誤った理由で正しい結論を出していた。**

## 6. 決定: 新しい Review workflow を作らず、既存の出力契約 1 箇所へ足す

接続点は `buildFocusedOutputContract()`（`strategicReview.ts:894`）**1 箇所**。
ここは既に focus ごとに ALIGNED / CONFLICT / UNCERTAIN を返させているので、
**判定語彙を新設する必要がない**。同じ呼び出しへ `appliedPrinciples: [{ id, verdict, reason }]`
を足すのが最小変更になる。

**ただし先行条件がある。** `meta-review-structured-output-robustness` と
`review-structured-output-schema-strictness` が未解決のまま出力契約へフィールドを足すと、
**原則判定の追加が false BLOCKED の新しい原因になる**。順序を Roadmap 本文へ明記した。

## 7. 今回追加した Design Principle: `observation-closes-loop`

CEO 指示により、「まず観測して様子を見る」と判断する場合の要件を汎用原則として登録した。

**格納先は `specs/21`**（機械可読 Registry）。理由:

- 唯一 marker 形式で機械が読める場所であり、**追加した瞬間から実際に適用される**
- `CLAUDE.md` §3 Design Philosophy は機械が読まない。
  `docs/project_memory/design_philosophy.md` は Project レコードの View であって
  AIteamOS 汎用原則の置き場ではない（2026-09-16 決定）。
  どちらへ書いても**二重正本か死蔵**になる
- CEO は「AIteamOS 固有ではなく今後の機能・チーム・システム・事業にも適用する」と指示した。
  `specs/21` は汎用エンジニアリング原則の集合であり、性質が一致する

**Design Philosophy #8「効果検証可能性」との関係**: 別の原則にしていない。
`observation-closes-loop` は #8 と `docs/multi_ai_step_review_flow.md` 2-3 章の
**機械化条項**であり、本文にその旨を明記して置き換えではないことを宣言した。
`tasks/roadmap.md` の「効果検証可能性の原則の本格検討」へも同じ趣旨の追記を入れ、
将来この 2 つが別物として分岐しないようにした。

**core（毎回適用）にした理由**: この原則を発動させる signal は
「様子を見よう」という**提案の中身**にあり、changedFiles や riskLevel からは検出できない。
現在の選択器で contextual にマッピングすると**当て推量**になる。
one-liner 1 行（約 20 token）なので core に置くほうが正直である。
**この判断自体に再評価条件を付けた**（原則を自分に適用した）:
50 件の適用で CONFLICT / UNCERTAIN が 1 件も出なければ contextual への降格を再Review候補にする。
この条件は**文章ではなく実行されるセンサー**として実装してある
（`core-principle-never-conflicts`。定義は `PRINCIPLE_SENSOR_THRESHOLDS`、
発動は `evaluateAndPersistSensors()`）。下記 8 章のとおり、初回はここを TODO に置いていて CEO に指摘された。

## 8. CEO 修正指示（同日）と、そこで直した設計の誤り

初回の整理では、`observation-closes-loop` に
「50 件適用して CONFLICT / UNCERTAIN が 0 なら core → contextual 降格を再評価する」
という条件を付けたうえで、履歴・センサーの実装を `deferred` の Roadmap item にしていた。

**CEO 指摘: 適用履歴が保存されないので 50 件到達を検出できない。
これは今回採用した原則そのものに反する。**

これは正しい。「観測対象・閾値・再評価条件を書いたが、それを検出する手段が無い」状態は、
`observation-closes-loop` が禁じている「忘却可能な TODO」そのものである。
**原則を追加した同じ変更の中で、その原則に違反していた。**

よって履歴・センサー部分を将来 TODO にせず、Step 1 と同時に実装した。

## 9. 実装した範囲（2026-09-17）

- **Registry metadata の一般化**: 既存 marker 方式を拡張（`principle-category` / `principle-scope` /
  `principle-tier` / `principle-tags`）。**新しい Registry ファイルは作っていない。**
  metadata を本文と同じ marker block に置くので、metadata 専用の第二の正本ができない
- **core の二重正本を解消**: `BASE_PRINCIPLE_SLUGS`（TS のハードコード配列）を廃止し、
  `corePrincipleSlugs()` が `principle-tier: core` marker から導出する
- **版**: `versionHash` を本文から算出。手書きの版番号は持たせない（必ず本文と乖離するため）。
  CRLF / LF のチェックアウト差では変わらない
- **Review 統合**: `buildFocusedOutputContract(selection)` と `reviewerAdapter` の prompt / parse を拡張。
  判定語彙は既存の `StrategicDecision` を再利用し、第二の enum を作っていない。
  **新しい Review workflow は作っていない**
- **`principle_applications` table**: CEO 指定の最小形。`reviewer` / provider / model / cost /
  prompt 全文は持たない（`review_run_id` から既存 review レコードを引ける）
- **集計**: `GET /api/principles/stats`。既存 SQLite の集計 SQL のみ。
  新しい metrics backend も Dashboard も無い
- **センサー 2 件**: core 降格候補（50 件）と、機構そのものの再Review候補（200 件）。
  評価は**記録直後**に行い、新しい scheduler / cron を増やしていない。
  発火は `audit_log` へ 1 回だけ記録する。**原則は自動で書き換えない**

**`audit_log` の使い分けについて**: 適用記録（高頻度・多次元集計）は専用 table、
センサー発火（低頻度・「発火済みか」という 1 entity の問い合わせ）は `audit_log`。
**同じ判断基準（クエリ形状）から出た別の結論**であり、前言撤回ではない。

## 10. 設計上の不変条件（変更するときはここを読むこと）

- **記録は Gate ではない。** `recordPrincipleApplications()` は例外を握って warn するだけで、
  Review の判定を変えない。**計測を足したことが新しい停止要因になってはならない**
- **`appliedPrinciples` は required schema に入れない。** 原則判定が返らないことを review の失敗にしない。
  これは `meta-review-structured-output-robustness` が解消するまでの暫定ではなく恒久方針である
- **聞いたのに答えなかった原則は UNCERTAIN として残す。** 消すと適用数が実態より少なくなり、
  「一度も CONFLICT しない原則」という判断が甘く出る。安全側は UNCERTAIN を残すこと
- **複数 focus が同じ原則を判定したら強い方（CONFLICT > UNCERTAIN > ALIGNED）を残す。**
  先勝ちにすると衝突を見逃す方向へ倒れる
- **原則本文を API から返さない。** 正本は Git であり、API で本文を配ると第二の正本になる

## 11. 閾値は暫定値である

実データ 0 件の状態で決めた値であり、分布からの導出ではない。

- `50`（core 降格候補）: CEO が 2026-09-17 に指定
- `200`（機構の再Review候補）: 上の 4 倍。core 原則が 4 件あるため、
  「core 全件がそれぞれ降格閾値に達した規模」を機構全体の評価開始点にした

**変更するときは、変更後の値だけでなく「どの実測を見てそう決めたか」を併記すること。**
定義と根拠の正本は `PRINCIPLE_SENSOR_THRESHOLDS` の doc comment。

## 12. Safety / Authority の確認（CEO 指示 7 に対する回答）

- **Gate / Approval / Guard の判定ロジックは 1 行も変えていない。** `recomputeDecision()` /
  `resolvePlActionPolicy()` / `authorizePlAction()` / `MECHANICAL_GATE_PATTERNS` は無変更
- **新しい route は read-only** で、既存の `apiTokenAuth` preHandler 配下に入る。
  秘密情報も原則本文も返さない
- **本変更自体が Mechanical Gate で Level 3 になる。** `MG-F02`
  （`apps/worker/src/metaReviewer/` はレビュー信頼境界のため Level3 固定）に該当する。
  CEO の本指示がその事前承認にあたる
- **DB migration に code 側の gate は存在しない。** `apps/api/src/storage/schema.ts` は
  `MECHANICAL_GATE_PATTERNS` に無く、`PlActionKind` にも migration 種別は無い。
  schema は `CREATE TABLE IF NOT EXISTS` + index 追加なので、
  **merge して API が再起動した時点で適用される**。
  したがって「Class C として CEO Gate を通す」は**merge / deploy の判断そのもの**が担う。
  本指示は DB migration 一般の Class B 化を意味しない

## 13. 意図的に実装しなかったもの

- **`specs/00` 3.14〜3.18 / `specs/20` / `specs/22` / Design Philosophy の移設。**
  `specs/21` の 11 件だけで通し、記録が実際に取れることを確かめてから範囲を広げる。
  `constitutionPrinciples.ts` は今も章まるごと本文を貼っている（CEO が問題視した方式が 1 箇所残る）
- **`riskLevel` の Review 経路への配線。** Review が持つのは `reviewLoad`（レビューの認知負荷）で
  あって `MetaRiskLevel`（変更のリスク）ではない。**別物なので読み替えなかった。**
  埋めるなら `review-class-b-enhanced-ai-review` の Risk 5 次元と一緒に設計する
- **`review_stage='meta'` の配線。** enum には入れたが `autoReview.ts` は DB を持たない
- **Dashboard**（CEO が今回不要と明示）

## 14. Lessons

- **「無い」と思った機能が既にあった。** contextual principle selection は 2 か月前に入っていたが、
  Roadmap item が無かったため誰の視界にも無かった。
  **Roadmap へ登録されていない実装は、存在しないのと同じ扱いになる。**
  `specs/21` 自身が末尾に完了条件を書いていたのに、追跡先が無く誰も評価していなかった
- **不採用の理由を測らずに書きかけた。** `audit_log` を避ける理由として最初に「性能劣化」を
  考えたが、索引を確認したら成立しなかった。結論（専用 table）は変わらなかったが、
  **理由が間違ったまま記録されていれば、次に読む人が誤った一般則を学ぶ**
- **原則の格納先が 5 つに分かれていること自体が、CEO が問題視した症状の原因だった。**
  「毎回全文を貼る」のは `specs/00` 3.14〜3.18 の読み方であり、
  `specs/21` は既にそうなっていない。**問題は方式ではなく、方式が 1 ファイルにしか適用されていないこと**
- **原則を追加した同じ変更の中で、その原則に違反していた。** 観測条件（50 件）を書きながら、
  それを検出する手段を `deferred` の item に置いた。CEO の指摘で気づいた。
  **「原則を書くこと」と「原則が機械的に効くこと」は別の作業であり、後者を省くと前者は装飾になる**
- **同じ判断基準から逆の結論が出ることがある。** `audit_log` は適用記録には不適（多次元集計）だが、
  センサー発火には適する（1 entity の問い合わせ）。
  「audit_log を使わない」を一般則として覚えると、次に誤る
