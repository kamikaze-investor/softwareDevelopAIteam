# 複数 Task 連続自律開発の Operational Evidence（2026-09-15）

**Importance Level: 1**
**Status: active**

---

## 何を測ったか

CEO 承認のあと、**外部セッションから次 Task を指定せずに** VPS 単独で

`Approval → git commit → Task 完了 → PL の Roadmap 再評価 → autonomous roadmap adoption → 次 Task 開始`

まで進むか。すべて production（`ai-team-api` / `ai-team-worker`、`PL_LOOP_ENABLED=true`、
tick 間隔 60 秒）で観測した。外部からの介入は CEO の承認操作1回のみ。

---

## 結果: **adoption までは成立。次 Task の着手で停止した。**

### 成立した区間（実ログ）

```
03:16:47  approve              approval-20260914-8a6938ce
          → Job 97b6a6b2 success / commit 6d958c2（candidate/self-dev）
          → Task bd80c4ce → done
03:17:41  pl_loop              adoption=proposal_unusable  ← 1回目は fail-closed で却下
03:18:53  pl_action_authorize  kind=adopt_roadmap_item gates=strategic_alignment_review
03:23:22  pl_loop              adoption=adopted task-allowed-paths-not-normalized
```

確認できたこと:

- **承認だけで blocked Job が queued へ戻った。** 外部からの `POST /api/tasks/:id/resume` は不要だった
  （`approveAndResumeJob()`）。Finding `approval-resume-liveness-dependency`（2026-09-10 時点では
  「承認後も client からの resume が必要」）は**解消済み**である
- **Mandatory Gate を通っている。** `adopt_roadmap_item` は `strategic_alignment_review` を要求し、
  Gate は ledger 本体を読んで照合した（PL の申告ではない）
- **fail-closed が効いている。** 1回目の採用提案は不完全で却下され、2回目で通った
  （`PL_MAX_ADOPTION_ATTEMPTS = 2` の範囲内）
- **次 Task を外部から指定していない。** PL が ledger から `task-allowed-paths-not-normalized` を選んだ

### 停止した箇所

採用した Task `21d69075` の Design Review が **`CONFLICT`** を返し、evidence が登録されず、
実装 Job が作られなかった。

```
finalDecision: "CONFLICT"
integrationReviewResult.summary:
  "The proposed change conflicts with MVP scope discipline and the documented post-MVP
   deferral; it adds complexity to a problem that already has a simpler workaround or
   lighter validation path."
conflictingFocuses: ["strategic_alignment", "scope_simplicity"]
requiresCeoApproval: false
```

**Design Review が止めたこと自体は設計どおりである**（evidence が無ければ Job を作らない）。

---

## 発見した欠陥: 止まったことが誰にも伝わらなかった

`task_ready_without_job` は `ACTIONABLE_ATTENTION_KINDS` にも `ATTENTION_PRIORITY` にも
無かったため、**PL は毎 tick `idle` を返し、通知も起きなかった**。
`maybeAdoptNext()` は `attention.length > 0` で採用を止めるので、次項目にも進まない。

**同日 `job_blocked` で直したのと同じ「静かに止まる」失敗が、別の kind で再発した。**
attention を出しているだけでは足りず、**PL の対象集合に入れて初めて人へ届く**。

修正（master `a71a7e3`）: `task_ready_without_job` を **notify-only** として PL の対象へ入れた。
PL に新しい権限は与えていない（Job 生成は Design Review evidence を要し、その判定を PL は覆せない）。
即通知にすると誤報になるため、既存の `DEFAULT_STALL_HINT_MS`（5分）を閾値にした
（Job 生成前の Design Review に実測 **4分29秒** かかる）。
通知本文には**止めている判定**（`finalDecision` と integration summary）を添える。

production 確認（12:39:06）:

```
[Notifier] ✅ 送信成功: line
plTick status=escalated target.key=task_ready_without_job:21d69075-…
```

---

## 未解決: CONFLICT をどう扱うか

Design Review は **Binding Review** であり、PL は妥当性を評価できても BLOCK を覆せない
（`docs/project_memory/rules/approval_rules.md`「Review finding の扱い」章）。
意見が割れる場合は Second Independent Review → Meta Review → 必要なら CEO Escalation。

判断材料として、CONFLICT の2つの根拠は性質が違う:

1. **「post-MVP へ延期されている」** — 採用元 ledger 項目の本文が
   「**MVP後へ延期** — 回避策は仕様書のパス表記を相対にするだけでコード変更が不要なため」と
   書いている。ただし **MVP は 2026-09-13 に完了**し、`TEMP_MVP_COMPLETION_POLICY` も削除済みである。
   つまり延期条件は**すでに満たされている**。ledger 本文が古いまま残っていることが誤読を招いている
2. **「より軽い代替がある」** — 絶対パスを警告する / guard のメッセージに `allowedPaths` を書く、
   といった軽い選択肢に比べて path 正規化層は複雑すぎる、という指摘。**これは (1) と独立に成立する**

**外部セッションはここを解決しない。** ledger 本文を書き換えれば CONFLICT は消えるが、それは
Binding Review の入力を外から操作して判定を覆すことに等しい。CEO 判断へ渡す。

---

## 到達点の評価

| 区間 | 結果 |
|---|---|
| Approval → git commit | **成立**（外部 resume 不要） |
| commit → Task 完了 | **成立** |
| Task 完了 → PL の Roadmap 再評価 | **成立** |
| Roadmap 再評価 → autonomous adoption | **成立**（Gate 通過・fail-closed 込み） |
| adoption → 次 Task 着手 | **未成立**（Design Review CONFLICT） |
| 停止の可視化 | **修正後に成立**（`a71a7e3`） |

**「複数 Task 連続自律開発」は未達。** 2件目の Task が着手に至っていない。
ただし**停止の原因は自律機構ではなく Review 判定**であり、自律ループ側（観測・判断・Gate・採用・
通知）は最後まで設計どおり動いた。次の検証は CONFLICT の扱いが決まったあとに行う。

---

# 第2ラウンド（同日 13:00〜14:10, CEO 判断反映後）

CEO が (1) MVP 延期文言の時点整合、(2) 軽い代替案の再評価、を指示。以後も**外部から次 Task を
一切指定していない**。

## 到達: **3件目の Task まで自律で進んだ**

```
（1件目 = bd80c4ce: CEO 承認 → commit 6d958c2 → done）
（2件目 = 21d69075: 自律採用 → Design Review CONFLICT → 実装不要と判明し close）
13:54:53  adoption=adopted  guard-block-message-omits-allowed-paths   ← 3件目を自律採用
          Design Review ALIGNED → implement Job 作成
13:59〜   implement Job 失敗 → PL 診断 → escalate_to_ceo（LINE 送信成功）
14:08〜   後続 Job が blocked → PL が resume_task を2回提案 → Gate が却下 → Escalation（LINE 送信成功）
```

**LINE は3通とも配信成功**（13:09:55 / 14:01:13 / 14:10:10）。

## 3ラウンドで見つかった「静かに止まる / 構造的に止まる」欠陥

いずれも**自律で回して初めて出た**もので、単体テストでは出なかった。

| 欠陥 | 症状 | 修正 |
|---|---|---|
| `task_ready_without_job` が PL の対象外 | 採用直後に止まっても**誰にも通知されない** | `a71a7e3` |
| 採用の attempt 予算が成功後もリセットされない | 対象キーが `adopt:<projectId>` で恒久のため、**1 Project あたり生涯2件しか採用できない** | `15aca53` |
| PL が**最も古い** Design Review evidence を Gate へ出す | `findByTaskId()` は新しい順なのに `.pop()` していた。**evidence が1件だと偶然通り、2件目から必ず落ちる** | `eaebf37` |
| `deferred` が採用を止めていない | 「現在も実装禁止」を表す手段が事実上無かった | `df9bfa9` |

## 現在の停止点: **protected file を要する項目に当たった（設計どおり）**

3件目の項目 `guard-block-message-omits-allowed-paths` は `jobRunner.ts` / `fileChangeGuard.ts` を
必要とする。これらは `ALWAYS_FORBIDDEN_PATTERNS` の protected file であり、
**Candidate の AI は変更できない**。

implement Job は `implementation produced no file changes`（exit 0 / `changedFiles: []` /
`workspaceState: unchanged`）で失敗した。**File Change Guard は発動していない**
（`fileChangeAllowed: true`）— そもそも allowedPaths（`apps/api/src/ctoAi`, `packages/shared/src`）に
対象が無く、何も書けずに終わった。

**権限は一切拡大されていない。** PL は Escalation へ倒れ、CEO 判断待ちで停止している。
CEO 指示（2026-09-15）「protected file や Safety Boundary を必要とする場合は PL 自身で権限を
拡大せず、既存 Gate に従って Tier B / CEO Escalation」に一致する。

## 評価

| 区間 | 第1ラウンド | 第2ラウンド |
|---|---|---|
| Approval → commit → Task 完了 | 成立 | — |
| Roadmap 再評価 → autonomous adoption | 成立（1件） | **成立（さらに2件）** |
| adoption → 次 Task 着手 | 未成立 | **成立**（Design Review ALIGNED → implement Job 作成） |
| 実装完了 | — | **未成立**（protected file が要る項目に当たった） |
| 停止の可視化 | 修正後に成立 | **成立**（3通とも LINE 配信） |

**連続自律採用は成立した。** 止まっているのは**能力ではなく権限**であり、それは設計どおりである。
次の検証は、protected file を要さない項目を PL が選んだときに実装完走するかで行う。

---

# 第3ラウンド（同日 14:40〜15:40, Tier B ハンドオフ）

CEO が `guard-block-message-omits-allowed-paths` を **Tier B（外部セッション実装）** として承認。
「この Task に限る」承認であり、権限拡大・`ALWAYS_FORBIDDEN_PATTERNS` 緩和・protected 指定の解除・
Safety Guard 迂回・`allowedPaths` 拡張・他 Tier B への包括承認は**含まれない**。

## Safety Boundary は実際に機能した（訂正を含む）

**訂正**: 第2ラウンドの記録で「File Change Guard は発動していない」と書いたが、**正確には
Job ごとに違う**。

| Job | 何が起きたか |
|---|---|
| `c640473c`（initial-implement） | 何も書けず `implementation produced no file changes`。Guard は未発動（`fileChangeAllowed: true`） |
| `e8f04766`（repair） | **Candidate AI が `apps/worker/src/guards/fileGuardBlockMessage.ts` と同 `.test.ts` を新規作成した**。`allowedPaths`（`apps/api/src/ctoAi` / `packages/shared/src`）の外なので **File Change Guard が発動して blocked**（`fileChangeAllowed: false`, `fileViolations` に両ファイル） |

つまり Candidate AI は **protected file を避けて guards/ 配下に新しいファイルを置く**という
回避を試み、**Guard がそれを止めた**。権限は一切拡大されず、境界は設計どおり働いた。
これは「何もできなかった」より強い証拠である。

## Tier B の実施

隔離 worktree（`ai/tierb-guard-block-message`）で実装。**`fileChangeGuard.ts` は変更していない** —
判定基準・許可範囲は不変で、変えたのは表示だけである。

**Independent Review（Codex `gpt-5.6-sol`）は3ラウンド**。`changes_requested` 2回は
いずれも実欠陥だった:

1. **High** 末尾追記だと `saveJobLogs()` のプレビュー切り詰め（4000字）で診断ごと消える
   → 既存 `withLeadingNote()` で先頭へ
2. **High** path と reason を連結してから切ると、長いファイル名が理由を食い潰す
   → 別々に切る。予算固定で最悪 280 字、理由1件と許可パス2件が必ず残る
3. **Medium** **こちらが書いたテストの1件が vacuous だった**（20,000字の変数を `runJob` へ渡しておらず、
   何も検証していなかった）→ 最終段の実経路で駆動する形に書き直し
4. **Low** 制御文字注入で偽の診断行が作れる / 「only these are permitted」は言い過ぎ

master `40bfed1` として merge・production 反映済み。

## 未解決: 外部 Tier B 完了を Task へ reconcile する既存経路が無い

実装は production に入ったが、**Task `7bd4a65a` を正しく終端させる手段が無い**:

- Task が自動で `done` になるのは `applyCommitResult`（**Candidate 自身の** git_commit 成功）だけ
- 受入条件の機械検証は存在しない（`implement-acceptance-criteria-not-mechanically-verified`）
- Candidate を同期して resume しても「既に実装済み」で `no file changes` になる
- 残るのは `PATCH` で `done` を直書きすることだけで、**CEO が明示的に禁じた未検証 done**

**したがって Task は `pending` のまま残した。** 未検証 done も DB 直書きもしていない。
`no-status-for-closing-a-task-without-implementing` へ統合して報告した。

**この Task が `currentTask` を占有している間、`maybeAdoptNext()` は動かない**
（`currentTask === undefined` が条件）。よって **VPS 自律運転への復帰は、この reconcile 方法が
決まるまで保留**である。これは自律機構の欠陥ではなく、外部ハンドオフの戻り口が未設計なだけである。

## PL の再試行は既存機構で settled

`hasEscalated()` が escalation 済みの対象を actionable から外すため、PL は
`job_blocked:e8f04766` に対して **70分以上まったく動いていない**（実測）。
**新しい特殊ケース処理は追加していない** — existing blocked state + existing escalation dedup で足りた。
attention には残るので CEO / Mobile からは見え続ける。

## この3ラウンドで到達したこと

| CEO が求めた観測項目 | 結果 |
|---|---|
| 3件連続で autonomous adoption できた | **成立**（`task-allowed-paths-not-normalized` → `guard-block-message-omits-allowed-paths` ほか） |
| protected boundary で fail-closed した | **成立**（repair Job が guards/ へ回避を試み、Guard が blocked） |
| PL が CEO へ Escalate した | **成立**（LINE 3通、いずれも配信成功） |
| Tier B だけ外部へ安全に handoff した | **成立**（`fileChangeGuard.ts` 不変・権限拡大なし・Independent Review 3ラウンド） |
| 完了後に VPS 自律運転へ復帰できた | **未成立** — 外部完了を Task へ reconcile する既存経路が無いため |

---

# 第4ラウンド: Tier B 往復の 1本の E2E（同日 16:00〜17:15）

CEO 指示により、**「Candidate 自律 → protected boundary 停止 → CEO Escalation → Tier B 外部
handoff → external 実装/Review/merge/deploy → formal reconcile → VPS 自律復帰」までを1本の
Operational Evidence として記録する**。

## 通し記録（すべて production、時刻は UTC）

| 段階 | 記録 |
|---|---|
| **Candidate 自律開発** | `04:54:53 adoption=adopted guard-block-message-omits-allowed-paths` → Design Review **ALIGNED** → implement Job 作成 |
| **protected boundary で停止** | `c640473c` は何も書けず失敗。`e8f04766`（repair）は **`apps/worker/src/guards/fileGuardBlockMessage.ts` を新規作成して protected file を迂回しようとし、File Change Guard が blocked**（`fileChangeAllowed: false`） |
| **CEO Escalation** | `05:01:13` job_failed → escalate_to_ceo、`05:10:10` job_blocked → Escalation。**LINE 配信成功** |
| **Tier B 外部 handoff** | CEO が「この Task に限る」protected file 変更を承認。隔離 worktree で実装 |
| **external 実装 / Review** | **Independent Review（Codex `gpt-5.6-sol`）3ラウンド**。`changes_requested` 2回はいずれも実欠陥（切り詰めで診断消失 / path と reason の連結で理由が消える / **こちらのテスト1件が vacuous**）。最終 `approved` |
| **merge / deploy** | PR #216 → master `40bfed1` → Stable へ deploy。`fileChangeGuard.ts` は不変 |
| **formal reconcile** | `07:43:43` CEO が UI で承認 → `07:44:19 pl_action_authorize kind=reconcile_external_completion gates=approval_gate` → `07:44:20 reconcile_external_completion` |
| **Task 終端** | Task `7bd4a65a` → **done**、`currentTask` 解放、failed/blocked Job は履歴として保持、**DB 直書きなし** |
| **VPS 自律復帰** | `08:10:59 adoption=adopted mobile-approval-role-docs` → Design Review **succeeded**（4分12秒）→ implement Job `8664cddc` **running**。**外部から次 Task を指定していない** |

## 復帰の途中で見つけた欠陥（同じ circular fail-closed の3例目）

reconcile 直後、PL は採用を再開したが**完了したばかりの項目を選び直して2回却下され、
Escalation して二度と採用しなくなった**:

```
07:45:25 blocked   adoption_rejected "guard-block-message-omits-allowed-paths" already has an executed Task
07:46:17 blocked   同上
07:47:01 escalated 予算切れ → 以後 hasEscalated が永久に真
```

原因は2つ重なっていた:

1. **Candidate の ledger が master に遅れる。** 採用候補の正本は Candidate 側の
   `tasks/roadmap.md` だが、master で done にしても自動では追従しない
2. **予算切れ Escalation から戻る道が無い。** 区切りが「直近の成功」だけなので、
   成功するには採用が要り、採用するには予算が要る、という循環

修正（master `5174482`）: 実行済み項目を候補から除く（DB は ledger より新しい事実）／
予算の窓を Escalation でも区切る。**どちらも新しい state を持たない。**

修正後の実測が上表の「VPS 自律復帰」行である。`08:05:28` に1回
`strategic_alignment_review` 不足で fail-closed 却下され（＝窓が開いた証拠）、
次の試行で採用が成立した。

## 残した後続確認事項（CEO 指示・reconcile のブロッカーではない）

`reconcile-evidence-not-fully-machine-verified`:

1. **canonical master 包含と running Stable 包含を分けていない。**
   現状は `git merge-base --is-ancestor <sha> HEAD`（Stable HEAD に対する祖先判定）のみ。
   Stable が `origin/master` からしか ff されない運用のもとでは master 包含も含意するが、
   **運用上の不変条件であって独立した証明ではない**
2. **Independent Review の `approved` は caller の自己申告である。**
   保存済み Review record とは照合していない。**追加実装が要る**
   （CEO 確認事項2への回答は「既にそうなっている」ではない）

## この E2E が示したこと

**権限境界を保ったまま、Candidate の能力を超える作業を外部へ出し、正式な経路で戻して、
自律運転を再開できた。** 途中で AI が protected file を迂回しようとしたが Guard が止め、
権限は一切拡大されなかった。人が介在したのは **CEO の承認操作2回だけ**（Tier B 許可と
reconcile 承認）で、次 Task の選択は外部から与えていない。
