# AIteamOS 開発本線のローカル → VPS 移管（2026-09-15）

CEO 指示により、通常 Roadmap 開発の本線をローカル PC のセッションから **VPS 上の AIteamOS / VPS PL**
へ移した記録。**新しい Handoff 用の仕組みは作っていない**（既存の Project / Roadmap / Task / audit /
Decision 記録へ必要な事実を残しただけ）。

## 移管時点の production

- master / 本番 deploy: `cce92c3`、Candidate clone `/workspace/target`（`candidate/self-dev`）も同一・dirty 0
- API / Worker / PL loop（`PL_LOOP_ENABLED=true`, 60s）すべて active
- 正式 Project #1 `AIteamOS`（`bb509fee…`）が **running な唯一の Project**
- `GET /api/state` の `attention` は **空**
- CEO Escalation は LINE へ実到達（configured・CEO 受信確認済み）

## ローカルで最後に完了した作業

1. `roadmap-adoption-followups` サブ項目(1) — 採用時に `implementationScope` を指定できるようにした
   （PR #189）。Task はこれで `done`
2. 移管前の state 整合で見つけた2件を修正:
   - done な Task の blocked Job が `attention` に残り続ける（PR #190）
   - **done な Task の blocked Job が以後の Roadmap 採用を恒久的に詰まらせる**（PR #191）。
     実際にこれで次項目の採用が 409 になり、VPS が次へ進めない状態だった
3. `design-review-runner-production-timeout` の Root Cause 特定・修正（PR #186、master `ce9df9b`）

## VPS 側が自力で始めたこと

PL（ローカルセッションが Role として）次項目に `meta-review-structured-output-robustness` を選び、
**事象2（二点間 diff による phantom deletion）のみ**に絞って採用した（`implementationScope` の初実戦）。
design review は「スコープが厳密に絞られている」と評価して ALIGNED。
その後 **VPS が implement Job を自分で実行開始**した（`claude_code`、allowedPaths は
`apps/worker/src/metaReviewer` のみ）。

### その過程で VPS PL が無人で復旧を1件成功させた

| 時刻 (UTC) | 監査 |
|---|---|
| 17:24:02.419 | `pl_action_authorize / authorized` — `kind=rekick_design_review gates=none` |
| 17:26:34.093 | `pl_loop / acted` — `exec_ok=true verify=different_anomaly design review rekick: evidence_registered` |

採用時の design review attempt 1 が失敗 → requeue → `design_review_idle` になったものを PL が拾い、
Gate を通して再kickし、**ALIGNED で evidence 登録まで到達**した（人工注入なしの自然発生事象）。
verdict が `normalized` でない理由と done 判定の扱いは `tasks/roadmap.md` の
`vps-pl-execution-loop` を参照。

## VPS 側が既存 Source of Truth から取得できること

| 必要な情報 | 取得元 |
|---|---|
| 今どこまで終わったか | `GET /api/state`（Project / Task / Job / Review / Approval / continuation）、`audit_log` |
| 現在の Project 状態 | 同上。running は Project #1 のみ |
| 未完了 Roadmap 項目 | `tasks/roadmap.md`（`state=planned` / `in_progress`）。`pnpm roadmap:check` で整合を検査できる |
| Known Finding / Limitation | 同 ledger の各項目本文（Finding も同じ場所に書く運用） |
| 現在の CEO 方針 | ledger「CEO優先方針の統合とPL優先順位決定（2026-09-14）」節、および各項目の CEO 判断追記 |
| Tier A / Tier B の境界 | `AGENTS.md` 1-1、ledger `aiteamos-self-development-tier-a` / `-tier-b` |
| PL 自身が扱える操作 | `packages/shared/src/plActionPolicy.ts`（`PL_ACTION_KINDS` と `ACTION_GATE_TABLE`）、`apps/api/src/pl/actionGate.ts` |
| CEO 判断待ち事項 | ledger の該当項目（`rollback_commit` の Gate、`pl-autonomous-roadmap-adoption`、`vps-pl-execution-loop` の done 判定） |

**ローカルセッション固有の情報に依存していない。**

## 残る外部依存（VPS だけでは閉じない）

1. **次 Roadmap 項目の採用** — PL は採用できない（`pl-autonomous-roadmap-adoption` を新規登録）。
   1 Task 終わるごとに外部から採用 API を叩く必要がある
2. **retryable skip の再拾い上げ** — design review が requeue すると初回 Job が作られないまま止まる
   （`roadmap-adoption-followups` (2) の範囲を実測で拡張して記録）
3. **push / PR** — Worker に `git_push` CommandKind が無く、promotion は外部セッションが行う
   （`worker-restricted-remote-publish`）
4. **production deploy**、**Tier B**、**CEO 判断**（Design Philosophy / Goal / Safety boundary）、**独立監査**

## 以後ローカル / 外部セッションを使う場合

VPS PL 自身が復旧不能 / PL・Mandatory Gate・State API 自体の故障 / Tier B / production deploy /
CEO 判断 / 独立監査。それ以外は VPS AIteamOS を第一選択とする。
