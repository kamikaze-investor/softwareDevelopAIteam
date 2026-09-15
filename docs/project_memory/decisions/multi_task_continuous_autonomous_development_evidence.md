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
