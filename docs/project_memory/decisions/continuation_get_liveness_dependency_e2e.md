# continuation-get-liveness-dependency: Production E2E 記録と GET 副作用除去の判断

日付: 2026-09-11
対象: PR #136（Worker poll cycle からの Task continuation reconcile）とその follow-up

---

## 1. 何を確認したか（Production E2E, Production E2E test 5）

実アプリから新規 Project を作成・開始し、2 Task（依存あり）で最後まで通した。

| 項目 | 結果 |
|---|---|
| Roadmap 生成（Codex `gpt-5.6-sol`/`xhigh`） | Task 数 2 / `task-002` が `task-001` に依存 / `allowedPaths` は両方 `test.js` / 絶対パス 0 件 |
| Task 1 implement → review → commit | PASS（commit `c7a08f8`） |
| Task 1 → Task 2 の continuation | 成立 |
| Task 2 implement → review → commit | PASS（commit `2e6dfe6`） |
| Goal（`node verify.js` exit 0） | 達成 |
| target repo | clean、`pnpm test` PASS |

継続を進めた経路は Worker のログで特定できている:

```
10:45:56 [Worker] Job a9e3b4f0 terminal update PATCH failed after retries,
                  but the result is persisted in the local Outbox.
10:46:01 [Worker] Pending Outbox events remain; skipping queued Job fetch for this poll cycle.
10:46:07 [Worker] Pending Outbox events remain; skipping queued Job fetch for this poll cycle.
10:46:12 [Worker] Job 50a32a09 (test) を実行します          ← Task 2 implement
```

commit の PATCH が（continuation が pending のため）非 2xx を受け、Worker が Outbox
イベントを保持し、poll cycle ごとに再送して Task 2 へ進んだ。**既存の PATCH / Outbox 経路が
backend だけで continuation を成立させることは Production で確認できた。**

---

## 2. 何を確認できていないか（重要）

- **新しい Worker reconcile sweep が Production で実際に pending を回収した事例は未取得。**
  今回の run では sweep は一度もログを出していない（回収すべき pending が発生しなかったため）。
  sweep は fallback であり、他の経路が先に成立すれば出番が無い。
- この run では **Mobile アプリが開いたままで、承認後も `GET /api/projects` が 20 回呼ばれていた**。
  当時の GET には continuation retry の副作用があったため、
  「continuation row が pending → completed になった瞬間」の実行主体を
  PATCH 由来か GET 由来か一意に特定できない。
  よってこの run を `continuation-get-liveness-dependency` の最終 PASS とはしない。

**証拠が無い限り「Worker sweep が Production で実際に回収した」とは主張しない。**
sweep 自体の回収能力は deterministic test で確認済み（下記 4）。

---

## 3. なぜ Production で sweep を強制発火させないのか

- commit Job の実行時間は実測 **1.2〜2.6 秒**（`started_at` → `completed_at`）。
  「commit 完了時点で paused」を狙うには 1.2 秒の窓を当てる必要があり、タイミング勝負になる。
  さらに `fetchQueuedJob()` は `status !== 'running'` の Project を skip するため、
  早く pause すると commit 自体が実行されない。
- 仮に pending を作れても、`PATCH /api/projects/:id` で running へ戻すと
  **その PATCH 自身が continuation retry を起動する**（`routes/projects.ts`）。
  これは T+0 に走り、Worker sweep は 5 秒 poll なので常に PATCH 側が先行する。
  sweep が主体になるのは「resume 時の retry が失敗したとき」だけで、
  それを Production で意図的に作るには fault injection が要る。

**CEO 判断: API restart 等の人為的障害を MVP の PASS gate にしない。**

---

## 4. sweep の回収能力の根拠（deterministic tests）

- running Project の pending continuation から次 Task の初回 Job を作る（GET を一切呼ばない）
- paused は走査対象にせず、continuation も failed にしない
- dependency 未達は進めず pending のまま次 cycle へ残す
- design review evidence 未成立なら Job を作らない（gate を迂回しない）
- sweep 反復・並行実行で duplicate Job なし
- API restart 後も同じ durable state から回収できる
- Outbox pending 中でも reconcile は止まらない
- reconcile が失敗しても poll cycle と Job intake は継続する

Production endpoint 自体も、実 credential で
`POST /api/task-continuations/reconcile` → **202 / 41ms** を確認済み。

---

## 5. 判断: GET の副作用を除去する

`GET /api/projects` と `GET /api/projects/:id` から
`retryPendingContinuationsForProject()` の fire-and-forget 呼び出しを削除し、
**GET を純粋 read-only にする。**

理由:

1. 読み取りに副作用があると、Mobile の poll が continuation の liveness driver になりうる。
   これが `continuation-get-liveness-dependency` の実体だった。
2. 副作用が残っている限り、E2E で「backend だけで進んだ」ことを一意に主張できない
   （上記 2 の問題）。除去すれば、Mobile polling が混ざっても liveness driver になりえない。
3. 除去後も continuation を進める経路は 3 つ残り、いずれも backend で完結する:
   - commit 成功時の `PATCH /api/jobs/:id`（+ 非 2xx なら Worker Outbox 再送）
   - `PATCH /api/projects/:id` で running へ戻したときの retry（CEO 操作）
   - Worker poll cycle の `POST /api/task-continuations/reconcile`（fallback）

**変更しないもの**: 上記 3 経路はいずれもそのまま維持する。新しい仕組みは追加しない。

---

## 6. 付随して記録した Finding（本 PR には混ぜない）

`tasks/roadmap.md` へ登録済み:

- `resolveFinalDecision` が未知 decision 値を ALIGNED へ fall-through する（fail-open）
- approval 後に blocked git_commit Job が自動 resume せず client の `/resume` が要る
- `POST /api/supervised-runs/reconcile` が `WORKER_ALLOWLIST` に無い（**潜在**欠陥。
  本番は credential split 未有効のため現時点では 403 にならない）
- continuation reconcile の NON-BLOCKING 指摘 2 件（full-table 走査 / エラーの握り潰し）
- task の `allowedPaths` が正規化・検証されず、絶対パスだと必ず Guard で落ちる
  （Production E2E test 4 で実際に 1 サイクル失った。原因は仕様書側の絶対パス表記）
