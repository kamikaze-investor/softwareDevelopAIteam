# VPS PL Execution Loop — Operational Verification（2026-09-14）

`vps-pl-execution-loop` の production 実測記録。**本項目はまだ完了ではない**（末尾の「未実証」参照）。

## 環境

- production VPS、systemd user units（`ai-team-api.service` / `ai-team-worker.service`）
- deploy: master `d06436d` → 修正後 `df2d71a`。いずれも DB backup → preflight → 両サービス停止 →
  `--ff-only` → API 起動・健全性確認 → Worker 起動 の順（delta が `apps/api` と `packages/shared` に
  跨るため Worker のみの再起動はしていない）
- **`/srv/ai-team/env/*.env` は読み書きしていない。** Phase 2 の有効化は systemd drop-in
  （`~/.config/systemd/user/ai-team-api.service.d/pl-loop.conf`）で行った。無効化は当該ファイルの削除のみ

## Phase 1: 手動 single tick（`PL_LOOP_ENABLED=false` のまま）

対象は実在の停止状態: Project `bb509fee` / Task `76ea5ff3` /
`design_review_failed`「runner timed out after 120000ms」（約2.6時間停止、run `060b8c66`、
`attempt_count=3` = 上限到達）。`POST /api/pl/tick` を1回だけ実行（HTTP 200、**25.3 秒**）。

| 検査項目 | 実測 |
|---|---|
| 対象 Task / Review の特定 | `design_review_failed:76ea5ff3…` を選択。同 Project の他対象へは触れず |
| PL の判断根拠 | 「複数回の timeout 失敗は systemic な問題を示し、retry では安全に解決できない」 |
| 提案 action | `escalate_to_ceo`。**`rekick_design_review` を含む想定外操作は行っていない** |
| Mandatory Gate 通過 | `audit_log`: `pl_action_authorize / authorized / kind=escalate_to_ceo gates=none policy=pl-action-policy-v1`（09:11:36.915Z） |
| workspace 変更 | **ゼロ**。`/workspace/target` は HEAD `5079a2f`・dirty 0・branch `candidate/self-dev` が前後で一致 |
| attempt 上限 | run `060b8c66` は `attempt_count=3 / failed` のまま。**再kickしていない**（不変条件6） |
| 結果確認 | `GET /api/state` を再取得し、attention 不変 = 正常化していないと判定 |
| 盲目的 retry | 無し。1 tick で Escalation へ倒れた |
| 監査 | Gate 行（`pl_action_authorize`）と判断・結果行（`pl_loop / escalated` + 根拠文）の2行 |

**判定: PASS**（想定外 action・Gate bypass・別対象への操作・無限 retry のいずれも観測されず）。

## Phase 1 で判明した欠陥（修正済み・PR #182）

escalation は attempt として数えないため、**Escalation 済みの対象を選択段階で外さないと、
CEO の判断待ちの間ずっと tick ごとに Diagnose（provider CLI、実測 25.3 秒）を走らせて捨てる**。
60 秒 interval ではモデル枠を焼き続ける挙動であり、本項目の目的に反する。
`hasEscalated()` を選択段階へ移して修正し、回帰テストで固定した。

## Phase 2: interval 有効化後の観測

`PL_LOOP_ENABLED=true` / `PL_LOOP_INTERVAL_MS=60000`。起動ログ
`PL execution loop enabled (intervalMs=60000)` を確認。約8分（≒8 tick）観測:

- 非 idle の tick ログ **0 件**（idle は意図的に記録しない）
- 新規 `audit_log` 行 **0 件**（Escalation 済み対象を Diagnose 前に外しているため）
- Escalation 通知の再送 **0 件**（同一対象へ重複通知しない）
- `PL tick failed` **0 件**、API / Worker とも `active`

つまり **ローカル PC 無しで VPS 上の PL が回り続け、既に CEO へ上げた案件については
何もしない**（provider も消費しない）ことを実測した。

## Phase 3: 実復旧の Operational E2E（VPS 単独・無人）— 完走

**安全なケースの作り方**: 障害を人工的に作らず、**既存の採用 API を同一スコープで呼び直した**
（`POST /api/projects/:id/roadmap-adoptions` へ DB 上の現行 `allowedPaths` / `acceptanceCriteria` を
そのまま渡す）。停止中 Task を進めるための正規操作であり、結果として新しい Design Review run が
作られ、既知の 120s timeout により **requeue → idle**（`attempt_count=1/3`、残2）になった。
以降は**手動 tick を使わず 60 秒 interval に任せた**。

| 時刻 (UTC) | 監査 / 実測 |
|---|---|
| 09:52:59.054 | `pl_action_authorize / authorized` — `kind=rekick_design_review gates=none policy=pl-action-policy-v1` |
| 09:52:59.058 | run `944ce2e0` が `queued → running`、`attempt_count` 1→2、`started_at` 設定（**実際に再実行された**） |
| 09:55:04.078 | `pl_loop / acted` — `kind=rekick_design_review exec_ok=true verify=unchanged`（runner がまた 120s timeout → requeue） |
| 09:55:50.112 | `pl_action_authorize / authorized` — `kind=escalate_to_ceo` |
| 09:55:50.125 | `pl_loop / escalated` — 「2回 timeout で失敗しており systemic な問題。上位の介入が要る」 |

- PL は attempt 上限（3）を待たず **2回目で自ら Escalation を選択**（run は残1で停止）
- 既に escalate 済みの `design_review_failed` キーへは**重複通知なし**
- Job は1件も作られず（`jobs created today: 0`）、`/workspace/target` は HEAD `5079a2f`・dirty 0・branch 不変
- 検証用の使い捨て Project は archived 済み。running Project は本番の1件のみ

**正常化はしていない。** 再実行そのものは成功したが、`design-review-runner-production-timeout`
が未解決のため review はまた timeout した。**PL ループの欠陥ではなく、当該 Finding が実復旧の
成立を塞いでいる。**

（付随観測: paused な Project では `createInitialImplementWorkflow()` が
`project is not running` で skip するため、使い捨ての paused Project では Design Review run を
作れない。安全な検証ケースを作る際の制約として記録する。）

## 未実証（本項目を完了にしない理由）

1. **Escalation の到達経路が未設定**。`sendAlert()` は LINE（`LINE_CHANNEL_ACCESS_TOKEN` +
   `LINE_USER_ID`）か Slack（`SLACK_WEBHOOK_URL`）が無いとコンソールへ落ちる。API・Worker とも
   未設定であることを journal で確認済み。**新しい通知基盤は不要で既存 notifier の設定だけで足りる**が、
   外部サービス選定・credential 取得・production env への書き込みは CEO 判断・CEO 操作である
   （AI は `/srv/ai-team/env/*.env` を読み書きしない）。設定後はコード変更なしで次の Escalation が届く。
2. **正常化を伴う実復旧は未達**。`design-review-runner-production-timeout` の解決が前提になる。
3. 対象の attention 種別は `design_review_idle` / `design_review_failed` の2つだけである。
   他の停止形態（quarantine・blocked Job 等）に executor は無く、PL は放置する
   （既に `GET /api/state` に出ており、二重通知しない設計）。
