# VPS PL 基盤 Operational Verification — 横断状態読み出し API (`GET /api/state`)

- 日付: 2026-09-14
- 対象 ledger: `cross-project-state-api`
- Production Stable SHA: `bb46910`（`24c41b8` からの delta は `apps/api/**` のみ）
- 位置づけ: **基盤導入時の一度きりの運用検証**。恒久的な Gate プロセスを新設するものではない。

## 目的

PL（Project Lead）が VPS 上で判断する前に、「PL の目」が production の**実際の停止状態**を
正しく観測できることを確認する。観測できないものの上に判断を載せない。

## 検証手順（すべて production）

1. 事前 preflight（read-only）: `jobs_running=0` / `reviews_inflight=0` /
   `jobs_queued=3`（全て archived Project 配下＝claim 不能）/ `projects_running=1`
2. 既存 backup service で DB backup（`backup-2026-09-14T07-03-02.764Z-...db`）
3. `git merge --ff-only origin/master` → `bb46910`。lockfile 変更なし、worker delta なし
4. API のみ再起動。`storage initialized` → `Server listening` → reconcile 200/202、起動エラーなし
5. 呼び出し前の DB snapshot（10 テーブルの件数＋内容 hash）
6. `GET /api/state` を実行（token は `systemd-run --property=EnvironmentFile=` で注入。読み出し・表示はしない）
7. 呼び出し後の DB snapshot

## 結果

**停止状態の検出（期待どおり）** — `attention` は2件、いずれも実際に止まっている Task
`76ea5ff3`（Project #1「AIteamOS」）のもの。

| kind | detail | stuckFor |
|---|---|---|
| `design_review_failed` | `design review failed after 3 attempt(s): runner timed out after 120000ms` | 約 33 分 |
| `task_ready_without_job` | `task is roadmap-active and pending but has no job; nothing will start it on its own` | 約 68 分 |

**誤検出ゼロ** — archived 57 Project、および archived 配下の queued Job 3件は `attention` に出ない。
`totals` は `{"running":1,"archived":57}`。

**副作用ゼロ（実測）** — 呼び出し前後で以下が完全一致。

```
counts={"projects":58,"tasks":199,"jobs":164,"design_review_runs":199,"design_review_evidence":78,
        "approval_requests":33,"approvals":0,"audit_log":23,"task_continuations":16,"supervised_runs":0}
hash=40c4879f044dd12f
```

**`attention` は観測事実のみ** — 対処方法・優先度・権限判断を含まない。行動選択は PL、実行可否は Gate。

## この検証で見つかった欠落と修正

初回 deploy（`24c41b8`）時点では `design_review_failed` が**出なかった**。

原因: `storage.designReviewRuns.findActiveByTaskId()` は `queued` / `running` しか返さない。
Design Review が `failed` で終端すると「アクティブでない」ため観測対象から外れる。しかし
**failed で終端した review こそが Job が作られない理由**であり、停止理由そのものが欠落していた。

修正: read-only の導出 `findLatestByTaskId(taskId)` を追加（PR #175 / `bb46910`）。
Design Review の実行・再試行・判定ロジックには触れていない。

## 検証できていないこと（正直に記録する）

`design_review_idle` は、現時点の production に `queued` / `running` の review が存在しないため
**実機では観測できていない**。検出経路は unit test で固定済みだが、production 実測ではない。

## 帰結

- 本項目は VPS PL 基盤の Observe 入口として実運用で機能することを確認した
- 残作業: `audit_log.project_id` の追加（additive）。PL ループには必須でないため後続
- 最初に検出した停止理由がそのまま open Finding `design-review-runner-production-timeout` を
  指している。これは PL 実行ループ完成後の**最初の実戦対象**になる
- 次: `mandatory-gate-policy`（PL に判断を任せる前に強制境界を確定させる）
