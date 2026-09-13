# CEO approval → Task 1 commit の happy-path regression（Production 実測）

**日付**: 2026-09-12 〜 2026-09-13
**Project**: `6d1173f6-d6d2-4ee1-b4de-254f00f08e8e`「M3 Production E2E」
**結論**: **これは M3 最終 PASS ではない。** Task 2 を手動 `POST /api/tasks` で追加した run であり、
CEO 判断により「限定用途の happy-path regression 証拠」として記録する。

---

## 1. 何を証明したか

**CEO が Approval Gate を承認してから、手動 resume なしで Task 1 の commit が着地し、
Task が `done` になり、task continuation が評価されるところまで**を Production で実測した。

| 段階 | 証拠 |
|---|---|
| Approval Gate 到達 | `approval-20260912-b4ad58ef` が `WAITING_FOR_USER` で発行され、`GET /api/approval-requests/waiting` に出た |
| CEO 承認 | Mobile から承認。`approveAndResumeJob()` が同一 Job 行を `blocked → queued` へ UPDATE |
| Worker が再開 | `[Worker] Job 92098110… (git_commit) を実行します`（2026-09-13 02:19:43 JST） |
| Gate 再評価 | `gate_check result=ALLOW` → `consume_approval result=consumed` |
| commit 着地 | Job `92098110` が `success`、`commit_hash=cf53e84`。target repo に `cf53e84 READMEチェックをchecks.jsへ分離` |
| Task 完了 | Task `ecde0a43` が `done` |
| continuation 評価 | `task_continuations` に `6f4c1c2a…` が作られた |

**手動 resume は一度も行っていない。** `POST /api/tasks/:id/resume` の呼び出しは 0 件。

## 2. 何を証明していないか（重要）

**Task 2 の implement / review へは進んでいない。** continuation は
`next_task_id: null` / `status: 'completed'` で終了した。

理由は判明済みで、欠陥ではない: `selectNextContinuableTask()`（`apps/api/src/storage/sqlite.ts`）は
`task.roadmapActive` を要求する。手動 `POST /api/tasks` で作った Task 2 は
`roadmap_active = 0` であり（`CreateTaskBody` に `roadmapActive` が無い）、
**continuation の対象に入らない**。実測値:

```
ecde0a43  status=done     roadmap_active=1  roadmap_task_key=task-001  phase=1
5c6c8570  status=pending  roadmap_active=0  roadmap_task_key=null      phase=null
```

したがって本 run は **「Task 1 commit → backend continuation → Task 2 implement/review」の
後半を証明していない**。その主張はしてはならない。

## 3. なぜ手動 Task 追加になったか

Roadmap Generator が与えた goal に対して **Task を1件しか生成しなかった**。
multi-Task の継続を見るために Mobile と同じ `POST /api/tasks` で依存付きの Task 2 を追加した。
この時点で本 run は M3 の要件（Generator 自身が 2 Task + dependency を生成する）を満たさない。

## 4. 途中で発覚し、この run 中に修正した2件

本 run は結果的に2つの MVP-BLOCKING を掘り当てた。どちらも Production 実測が発見契機である。

1. **`approval-expired-waiting-blocks-resume`**（PR #156）
   期限切れ `WAITING_FOR_USER` が `findWaiting()` から除外されて Mobile に出ず、かつ
   `resumeBlockedTask()` が status だけを見て resume を拒否するため、Task がスマホから
   一切復旧できなかった。実測: 承認一覧 0 件・Job は blocked。

2. **`done-task-stale-blocked-job-owns-workspace`**（PR #158）
   resume 経路が残す旧 blocked 行が、Task が `done` になった後も workspace 所有権を握り続けた。
   解放手段が archive / pause しか無く「スマホ完結の復旧」を満たさなかった。
   Production に同一形状が4件あり、いずれも archived/paused でしか解放されていなかった。

## 5. 最終 M3 の要件（未実施）

本 run では満たしていない。新規 Project でやり直す。

- 実アプリから新規 Project Start
- **Roadmap Generator 自身が 2 Task + dependency を生成する**
- Task の手動追加なし
- CEO 操作は Approval のみ
- 手動 resume なし
- Task 1 commit → backend continuation → Task 2 implement/review → Task 2 Approval Gate まで到達

`TEMP_MVP_COMPLETION_POLICY` は最終 M3 が PASS するまで削除しない。
