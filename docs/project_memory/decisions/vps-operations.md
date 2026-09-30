# VPS 運用手順 — Current Truth（2026-09-30 時点）

Roadmap 項目 `vps-operation-docs-current-truth` の **(1) 起動 env allowlist** と
**(2) CEO Escalation の到達経路** について、コードが実際に読んでいるものを記録する。

**このファイルの位置づけ。** 今回の allowedPaths は本ファイル1つだけである。したがって
`tasks/roadmap.md`「VPS常駐運用化」節の「正式Production起動方式の確定」に書かれた canonical な
allowlist 列挙と、`specs/11_runtime_environment.md` 3章末尾の後続タスク一覧は**今回変更していない**。
**両者と本ファイルが食い違う場合、本ファイルが Current Truth である**（根拠は各行の `file:line`）。
同じ訂正を当該2ファイルへ反映する作業は未実施であり、末尾「本ファイルで直していない drift」に残す。

**production への操作（再起動・env 変更）は本記録の範囲外**である。本ファイルは「文書どおりに
再起動すると Escalation が届かなくなる」状態を止めるための記述修正のみで、
実際の再起動は別途 CEO 承認のうえ既存 deploy 手順で行う。

---

## 1. API プロセスが実際に読む env（allowlist の Current Truth）

### 1-1. 維持する原則（変更なし）

- **`set -a; . .env` で API を起動することは引き続き禁止**（2026-08-18 確定）。`.env` 全体を source すると
  API が本来持たない `CLAUDE_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` / `GITHUB_TOKEN` まで
  process env へ載り、Secret boundary が黙って広がる。禁止理由は今も有効。
- **API と Worker の allowlist を共用・混同しない。** 必要 credential が違う
  （例: LINE の2行は `api.env` にあるが `worker.env` には意図的に未設定 —
  `docs/project_memory/decisions/vps_pl_execution_loop_operational_verification.md`）。
- **値は環境変数として渡し、argv へ載せない**（`ps` 露出防止）。

### 1-2. 現在の与え方は `env -i` ではなく systemd EnvironmentFile

現行 production は systemd user units（`ai-team-api.service` / `ai-team-worker.service`）で常駐しており、
env は `/srv/ai-team/env/api.env`（`mode=600 owner=ai-team`）と systemd drop-in
（`~/.config/systemd/user/ai-team-api.service.d/pl-loop.conf`）から与えられている。
`env -i` ＋明示 allowlist は**手動起動時の形**であり、systemd 経路では
「**`api.env` に何を書くか**」が allowlist の実体になる。systemd はシェル env を継承しないので、
`env -i` と同じ効果は systemd 側で既に得られている。**allowlist が意味を持つのは `api.env` の中身だけ**。

### 1-3. API プロセスが読む env の一覧

「必須」= 欠けると production で起動できない／機能が落ちるもの。

| 変数 | 読み取り箇所 | 欠けたときの挙動 | 区分 |
|---|---|---|---|
| `PATH` / `HOME` | `apps/api/src/aiExplain/cheapAiClient.ts:145-152`、`apps/api/src/designReview/designReviewCoordinator.ts:103-107,798-808`、`apps/api/src/ctoAi/roadmapGenerator.ts:284-294` | 子プロセス（OpenCode CLI / Design Review runner）が起動できない | 必須 |
| `NODE_ENV` | `apps/api/src/storage/index.ts:11-17,37-44`、`apps/api/src/routes/health.ts:46`、`apps/api/src/designReview/designReviewCoordinator.ts:107` | `production` でないと DB_PATH の fail-closed 検査が効かない | 必須 |
| `HOST` / `PORT` | `apps/api/src/index.ts:97,125` | 既定 `0.0.0.0:3000` で listen | 任意 |
| `DB_PATH` | `apps/api/src/storage/index.ts:10-25`（`resolveStorageDbPath()`） | `NODE_ENV=production` では未設定・ファイル不在のいずれでも **throw して起動失敗** | 必須 |
| `ADMIN_TOKEN_SHA256` / `WORKER_TOKEN_SHA256` | `apps/api/src/auth/apiToken.ts:36-47,71-88` | 片方だけ設定は設定ミスとして**全 request 503**（fail closed）。両方未設定は legacy mode へ落ちる | 必須 |
| **`ACTIONS_READONLY_TOKEN_SHA256`** | `apps/api/src/auth/apiToken.ts:50-54,71-74,109-119` | **第3 credential class が存在しない扱いになり**、`.github/workflows/gate-evidence-check.yml:45-71` の `verify-commit` が認証できず fail closed で FAIL（ADMIN/WORKER への fallback は無い） | 必須（旧記述に欠けていた） |
| **`OPERATOR_GATEWAY_TOKEN_SHA256`** | `apps/api/src/auth/apiToken.ts:56-60,71-74,122-132` | 未設定なら外部 Operator 用の第4 credential class が存在せず、ChatGPT MCP adapter 等から safe read / Operator Request を利用できない。他 credential と同値なら全 request 503 | 外部 Operator 利用時は必須 |
| `API_TOKEN` | `apps/api/src/auth/apiToken.ts:39-40,62,212` | legacy mode でのみ使われる。split credential mode では env に残っていても認証に使えない | split では不要 |
| `OPENCODE_GO_API_KEY` | `apps/api/src/aiExplain/cheapAiClient.ts:338-340` | `requestText()` が throw。PL の Diagnose（`executionLoop.ts` の `defaultDiagnose`）と AI 説明が動かない | 必須 |
| **`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID`** | `apps/worker/src/notifier/notifier.ts:120-141` を **API プロセスが dynamic import**（`apps/api/src/pl/executionLoop.ts:1236-1249`、`apps/api/src/index.ts:113-114`） | **CEO Escalation が誰にも届かず journal（コンソール）にしか出ない。** 2つのうち片方だけでは LINE チャネルは有効にならない | 必須（旧記述に欠けていた。2章参照） |
| **`SLACK_WEBHOOK_URL`** | 同上（`notifier.ts:131`） | Slack チャネルが無効。LINE も無い場合は通知チャネル 0 本 | 任意（旧記述に欠けていた） |
| `PL_LOOP_ENABLED` / `PL_LOOP_INTERVAL_MS` | `apps/api/src/index.ts:47-48` | 既定は**無効**。現行 production は drop-in `pl-loop.conf` で `true` / `60000` を与えて有効化している。落とすと VPS 上の PL tick が止まる | 現行 production では必須 |
| `TARGET_ROOT` | `apps/api/src/pl/actionGate.ts:485`、`apps/api/src/routes/ctoAi.ts:19`、`apps/api/src/pl/adoptionStep.ts:325`、`apps/api/src/ctoAi/roadmapAdoption.ts:133`、`apps/api/src/ctoAi/projectStartWorkflow.ts:56`、`apps/api/src/ctoAi/roadmapGenerator.ts:326` | Target Repository の位置が既定値へずれる。CTO AI 経路は `targetProjectRoot` と設定値の一致を要求するため 400 になる | 必須 |
| `DESIGN_REVIEW_REPO_ROOT` / `DESIGN_REVIEW_RUNNER_COMMAND` / `DESIGN_REVIEW_CONTROL_CONTEXT_DIR` | `apps/api/src/designReview/designReviewCoordinator.ts:798-808`、`apps/api/src/ctoAi/roadmapGenerator.ts:284-292`、`apps/api/src/reconcile/externalCompletion.ts:69-72` | Design Review runner の起動先・実行コマンドが既定へずれる | 現行 production では必須 |
| `SUPERVISED_RUN_ROOT` | `apps/api/src/supervision/runDirectory.ts:25-28` | 既定は OS 一時領域配下（`os.tmpdir()/ai-team-supervised-runs`）。実運用では明示する | 任意（明示推奨） |
| `CONTROL_ROOT` | `apps/api/src/utils/pathGuard.ts:19-21` | 既定は `__dirname` から解決。Control Repository を指す禁止 prefix が実際の配置とずれる場合のみ明示が必要 | 任意 |
| `LANG` | `apps/api/src/aiExplain/cheapAiClient.ts:145-152`、`apps/api/src/designReview/designReviewCoordinator.ts:103-107` | 既定 `C.UTF-8` で子プロセスへ渡る | 任意 |

### 1-4. 未解決の衝突: `ANTHROPIC_API_KEY`（本ファイルでは決めない）

`apps/api/src/ctoAi/specAnalyzer.ts:209-215` は `ANTHROPIC_API_KEY` を**直接**読み、
未設定なら throw する。**`CLAUDE_API_KEY` へ fallback しない。**
Worker 側にも橋渡しは無い。#258 / `6d3626f` 後の `apps/worker/src/aiCli/adapter.ts:752-788` は
Claude Code 子プロセスへ `PATH` / `HOME` 等だけを渡し、`CLAUDE_API_KEY` も
`ANTHROPIC_API_KEY` も渡さない（subscription 認証を使う）。API プロセスはこれとは別で、
`ANTHROPIC_API_KEY` を直接必要とする。影響するのは `POST /api/cto/...` の仕様解析経路
（`apps/api/src/routes/ctoAi.ts:90`、`apps/api/src/ctoAi/projectDefinitionAnalysis.ts:188`）。

ここは「API に provider key を載せない」という 1-1 の禁止理由と正面から衝突するため、
**本ファイルでは allowlist へ入れる／入れないを決めない。** Secret boundary の変更に当たるので、
`.env.example` の整備（下記 drift）と併せて別途判断する。現状の事実だけを記録する:
**`api.env` に `ANTHROPIC_API_KEY` が無い限り、spec 解析は 500 で失敗する。**

---

## 2. CEO Escalation の到達経路（この手順どおりなら届く）

### 2-1. 送信主体は API プロセス自身

PL の CEO Escalation は Worker 経由ではない。`apps/api/src/pl/executionLoop.ts:1236-1249` の
`defaultEscalate()` が `@ai-team/worker/src/notifier/notifier.js` を dynamic import して
`sendAlert()` を呼ぶ（委任 continuation も `apps/api/src/index.ts:113-114` で同じ関数を注入する）。
**したがって LINE / Slack の credential は `api.env` 側に必要である**（`worker.env` にあっても届かない）。

`sendAlert()`（`apps/worker/src/notifier/notifier.ts:120-141`）の条件:

- LINE は `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_USER_ID` の**両方**が必要
- Slack は `SLACK_WEBHOOK_URL`
- **1本も設定が無ければ console へ warn を出して正常 resolve する**（例外にならない）。
  つまり「送信した」と「届いた」は別物であり、env の欠落は静かに通る

### 2-2. 手順（この順序でなければ反映されない）

1. `/srv/ai-team/env/api.env` に `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_USER_ID` を置く。
   **設定は CEO が行い、AI は env ファイルを読み書きしない。** 権限は `mode=600 owner=ai-team` を維持する。
2. **`ai-team-api.service` を再起動する。** systemd は `EnvironmentFile` を**起動時にしか読まない**ため、
   編集だけでは反映されない（2026-09-15 の有効化は「env 更新 01:29:21 → API 起動 01:31:13」の
   前後関係を有効化の証拠として記録している）。
3. 再起動後の確認は **configured / not configured のみ**とする。値・長さ・形式を出力しない
   （CEO 指示・2026-09-15）。LINE User ID は表示名や `@` 付き LINE ID の取り違えを防ぐため
   形式の妥当性だけを確認してよい。
4. `api.env` を作り直す・別ホストへ移す場合は、**1-3 の表を allowlist として使う。**
   旧記述（`PATH`/`HOME`/`NODE_ENV`/`HOST`/`PORT`/`DB_PATH`/`API_TOKEN`/`ADMIN_TOKEN_SHA256`/
   `WORKER_TOKEN_SHA256`/`OPENCODE_GO_API_KEY` の10個）だけで作ると、LINE の2行と
   `ACTIONS_READONLY_TOKEN_SHA256` / `OPERATOR_GATEWAY_TOKEN_SHA256` / `PL_LOOP_*` が落ちる。
   **これが「文書どおり再起動すると Escalation が届かなくなる」経路そのものである。**

### 2-3. 届いたかどうかの確認点

`audit_log` の `pl_loop / escalated` 行の detail **先頭**に配達結果が載る
（`apps/api/src/pl/executionLoop.ts:946-959,971-988,1926-1967`）:

- `delivery=delivered via=line` — 1本以上のチャネルが受け取った
- `delivery=undelivered tried=none` — **障害**。チャネル未設定（= 2-2 の手順漏れ）。
  `tried=line` 等なら送信は試みて失敗している
- `delivery=suppressed` — 重複として意図的に送っていない。**正常**

`suppressed` と `undelivered` はどちらも「届いていない」が、取り違えてはならない。
なお `deliverEscalation()` は**記録するだけで再送しない**。通知の仕組み自体が壊れて `escalate` が
throw した場合も `delivery=undelivered tried=unknown` として `escalated` を必ず記録する。

**注意:** この配達欄は本リポジトリのコードの現状である。production に当該版が deploy 済みかは
本ファイルでは確認していない。配達欄の無い古い `escalated` 行は「判らない」であって
`delivered` ではない。

### 2-4. なぜ「届かないまま記録される」と重いのか

`hasEscalated()` は escalate 済みの対象を選択段階で外す（tick ごとに Diagnose を走らせて
モデル枠を焼かないための設計）。このため **届いていない Escalation が `escalated` として記録されると、
その対象は以後 PL の対象から外れ、出口が CEO の `abort_task` だけになる。**
2-2 の手順漏れ（LINE 2行の欠落）と組み合わさると、CEO は通知を受け取らないまま対象が停止する。

### 2-5. 既知の限界（意図的にそのまま）

- `worker.env` には LINE を設定していないため、**Worker 由来の CRITICAL 通知**（Outbox 滞留等）は
  引き続き console のみ。届けたい場合は同じ2行を `worker.env` へ追加する
- `MAX_SEND_ATTEMPTS = 3`（`notifier.ts:61`）。LINE 側が連続失敗すると通知は失われる
- 将来の正式第一チャネルは Mobile Push であり、LINE はそこへ至るまでの bootstrap 通知
  （CEO 方針・2026-09-14）

---

## 3. 本ファイルで直していない drift（allowedPaths 外・別途対応が必要）

いずれも**記述側の修正で足りる**（新しい仕組みは要らない）。今回は allowedPaths が本ファイル1つのため
手を付けていない。

1. `tasks/roadmap.md`「VPS常駐運用化」節の canonical な allowlist 列挙（10変数）が 1-3 と食い違う
2. 同節と `specs/11_runtime_environment.md` 3章末尾の後続タスク一覧で、
   HTTPS化・ヘルスチェック（`apps/api/src/routes/health.ts` は実装済みで `apps/api/src/index.ts:95` で登録済み）・
   再起動耐性（systemd user units）が**未着手として並んでいる**。実際に open なのは Docker化と
   ログ保存 / rotation 方針
3. `.env.example` が production コードの読む変数を欠く（特に `ANTHROPIC_API_KEY`・
   `ACTIONS_READONLY_TOKEN_SHA256`・`DB_PATH`）。逆に `CONTROL_REPO_PATH` / `TARGET_REPO_PATH` /
   `GIT_USER_NAME` / `GIT_USER_EMAIL` はどのコードも読まない
4. `sandbox/hooks/pre-push` は成功しえないのに `sandbox/hooks/setup-hooks.sh` が VPS への設置を指示している
5. `.github/workflows/meta-review.yml` の `GEMINI_MODEL` がコード既定と違う
6. DB backup の復元手順が文書化されていない（`apps/api/scripts/dbRestoreTest.ts` は存在する）
7. **CEO 判断事項**: production を生かしている systemd unit（`PL_LOOP_*` drop-in と
   `flock` 単一インスタンス強制を含む）は **repository に存在せず VPS 上にしかない。**
   version 管理下へ置くかは production 設定の扱いに関わるため CEO 判断とする
