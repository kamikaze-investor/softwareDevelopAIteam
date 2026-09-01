# Codex Native Runtime 最小検証 — Phase 1 調査レポート

## 1. 現状実装のサマリ（何が自作か、どのファイルで何を担当しているか）

調査対象は Codex プロバイダーのみ。現状の実装は「Codex CLI を Worker が安全な外部プロセスとして呼び、AIteamOS 側で実行前後の安全検査・差分検査・ログ・状態遷移を管理する」構成である。

- `apps/worker/src/aiCli/adapter.ts`
  - `BaseCliAdapter.run()` が共通実行ラッパー。`execFileSync()` で CLI を起動し、`shell:false`、`timeout`、安全な `env`、stdin 入力、stdout/stderr/exitCode 収集を担当する（主に 186-205 行）。
  - 実行前に `isInsideTargetRoot(request.workingDir)` と `isPromptSafe(request.prompt)` を強制する（127-140 行）。
  - Codex の場合は `injectClaudeMdEssentials()` で `CLAUDE.md` / `AGENTS.md` 相当の制約をプロンプトへ注入する（145-147 行、358 行以降）。
  - CLI 終了後に `buildWorktreeManifest()` 由来の changed files を取得し、Codex では変更があれば `pnpm lint --fix` を非致命的に実行する（236-243 行、436 行以降）。
  - `expectJson` 時は `tryParseJson()` で stdout をパースし、失敗時は最大 `maxRetries` 回、JSON 再出力指示を付けて CLI を再実行する（253-280 行）。これは公式Runtimeではなく AIteamOS 自作。
  - timeout は `ETIMEDOUT + status=null + SIGTERM` のとき `providerFailureKind:'provider_timeout'` として分類する（212-216 行）。
  - `fallbackPolicy` がある場合は `shouldFallback()` に従って別 provider へ再実行する実装があるが、既存ルール上 production 呼び出し元は未配線という扱い（222-230 行、AGENTS.md の暫定Role Policy）。

- `apps/worker/src/aiCli/codexAdapter.ts`
  - `CodexAdapter` は `BaseCliAdapter` の Codex 専用 argv ビルダー。
  - `useStdinPrompt()` は `true`。プロンプトは argv ではなく stdin で渡す（53-54 行）。
  - `request.mode === 'implement'` なら `--sandbox workspace-write`、それ以外は `--sandbox read-only` を指定する（73-83 行）。
  - 現在の呼び出しは `codex exec --sandbox <mode> [-m model] -C <workingDir> --ephemeral -`。`--json`、`--output-schema`、`--output-last-message` は未使用。
  - `--ephemeral` により Worker 自動実行では Codex の session file を残さない設計になっている（82 行）。

- `apps/worker/src/aiCli/codexPathResolver.ts`
  - `CODEX_CLI_PATH` を最優先し、Windows では `codex.cmd` を優先探索し、WindowsApps 配下の Codex を拒否する（78-101 行）。
  - `testCodexConnection()` は `codex --version` 相当を 10 秒 timeout で実行し、疎通確認する（113-126 行）。
  - 今回の実測でも PowerShell の `codex` は `codex.ps1` 実行ポリシーで拒否されたが、`codex.cmd` は実行できた。このため既存 Rule-002 の `codex.cmd` 優先は妥当。

- `apps/worker/src/aiCli/factory.ts`
  - `createAiCliAdapter()` が provider ごとに `ClaudeCodeAdapter` / `GeminiCliAdapter` / `CodexAdapter` / `CopilotCliAdapter` を生成する（14-28 行）。
  - Codex だけの変更に閉じるには、この factory の公開契約は維持するのが安全。

- `apps/worker/src/jobRunner.ts`
  - Job 実行の上位制御。Permission Guard、Approval Gate、AI CLI 実行、Stage A 差分検査、SafeCommand 実行、Final 差分検査、ログ保存、結果ステータス決定を順に行う（285 行以降）。
  - AI CLI は SafeCommand 前のサブステップとして実行される。`adapter.run()` に `taskId`、`provider`、`workingDir`、`prompt`、`mode`、`dryRun`、`expectJson` を渡す（661-674 行）。
  - AI CLI が throw / blocked / 非0終了した場合でも、`inspectAfterAiFailure()` で最終差分、File Guard、Risk Scan、必要時の局所 cleanup を行う（675-716 行、1497-1560 行）。
  - AI CLI 実行後の Stage A で `buildFinalInspection()` と `fileChangeGuard()` を実行し、違反時は `revertBlockedJobChanges()` でこの Job が作ったパスだけを戻す（786-850 行、1238-1315 行）。
  - SafeCommand 側は `execFileSync()` で実行し、非 atomic command には `JOB_TIMEOUT_MS = 120_000` を適用する（74 行、1057-1063 行）。これは Codex CLI ではなく Worker のコマンド実行。
  - Final でも `fileChangeGuard()`、Risk Scan、ログ保存、status 決定を行う（1107-1209 行）。
  - `Job` 型には PID / processId の保存フィールドは見当たらない。現状の Codex プロセス管理は、永続 PID 管理ではなく同期起動・timeout・結果収集中心。

- `apps/worker/src/watchdog/watchdog.ts`
  - API から running Job を定期取得し、`job.safeCommand.kind` と `startedAt` を `checkStall()` に渡して閾値超過を検出する（20-64 行）。
  - stall 検出時は WatchdogEvent を作り、Gemini で分析し、必要なら alert する（75-144 行）。
  - PID 監視や CLI kill は実装されていない。provider 内部の進捗イベントも現状は見ていない。

- `apps/worker/src/watchdog/stallDetector.ts`
  - CommandKind ごとに固定閾値を持つ。例: `git_status` 30 秒、`typecheck` 5 分、`test/build` 10 分、`lint` 2 分（4-16 行）。

- `apps/worker/src/guards/fileChangeGuard.ts`
  - Red Zone / secret / guard 系ファイル / `jobRunner` / `adapter.ts` などの常時禁止パターンを `ALWAYS_FORBIDDEN_PATTERNS` で定義する（38-66 行）。
  - `RuntimeTaskPolicy` で task 単位の `allowedPaths` / `forbiddenPaths` を freeze する（88-110 行）。
  - `fileChangeGuard()` は path traversal、target 外、symlink/gitlink、常時禁止、task forbidden/allowed を検査する（157-244 行）。

- `docs/project_memory/decisions/006_ai_cli_adapter.md`
  - AI CLI は「頭脳」、Worker は「権限管理・実行管理・差分管理」、Guard は「絶対ルールを機械的に守る装置」という分担。
  - CLI を直接自由実行させず Worker がラップする理由は、workingDir 制限、`shell:false`、stdin、timeout、Secret Scan、差分保存を強制するため。

- `docs/project_memory/rules/002_codex_operation_rules.md`
  - Rule-001〜004: Codex CLI path 解決と `codex --version` 疎通確認。
  - Rule-005〜006: workdir / targetProjectRoot / allowedPaths の正規化と範囲検証。
  - Rule-007: secret file を prompt / allowedPaths / 変更対象から除外。
  - Rule-008〜009: default は read-only、実変更は implement + approved + mockRun=false が前提。
  - Rule-010: `git push` / `gh pr` / merge / branch protection / workflows / CODEOWNERS 等は禁止。
  - Rule-011〜013: mock 完了扱い禁止、呼び出しログ、Red Zone 検出時の blocked 相当処理。

- `docs/project_memory/rules/001_codex_integration_risks.md`
  - Codex が `CLAUDE.md` を自動読込しない H-1 リスク、Context Pack staleness、provider 混在、fallback 条件、style 差分などを整理している。

## 2. Codex公式Runtimeの機能サマリ（確認したコマンド・出力の要約、experimentalは明記）

確認環境:

- `codex.cmd --version`: `codex-cli 0.146.0`
- PowerShell で `codex --version` を直接実行すると `C:\Users\honka\AppData\Roaming\npm\codex.ps1` が実行ポリシーにより拒否された。
- `Get-Command codex.cmd` では `C:\Users\honka\AppData\Roaming\npm\codex.cmd` を確認。
- `codex.cmd doctor --summary --ascii` は、auth 未設定、WebSocket / reachability 失敗により fail。したがって実モデル呼び出しの E2E は未実測。本レポートでは CLI help を正とする。

確認した command:

- `codex.cmd --help`
- `codex.cmd exec --help`
- `codex.cmd exec resume --help`
- `codex.cmd exec review --help`
- `codex.cmd features --help`
- `codex.cmd features list`
- `codex.cmd doctor --help`
- `codex.cmd doctor --summary --ascii`
- `codex.cmd app-server --help`
- `codex.cmd mcp-server --help`
- `codex.cmd exec-server --help`
- 補助確認: `codex.cmd resume --help` / `archive --help` / `delete --help` / `fork --help`

主要機能:

- `codex exec`
  - 非対話実行用。prompt は引数、または `-` / piped stdin から読む。prompt と stdin が両方ある場合、stdin は `<stdin>` block として追記される。
  - 主要 flag: `--model`、`--sandbox read-only|workspace-write|danger-full-access`、`-C/--cd`、`--add-dir`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`--output-schema <FILE>`、`--json`、`--output-last-message <FILE>`。
  - `--json` は stdout に JSONL event を出力する。
  - `--output-schema` は最終応答 shape の JSON Schema を指定する。
  - `--output-last-message` は agent の last message をファイルに書き出す。
  - help 上、timeout / retry / cancel / interrupt 専用 flag は確認できない。

- `codex exec resume`
  - session id または thread name、あるいは `--last` で過去 session を再開する。
  - prompt は引数または `-` stdin。
  - `--all` は cwd filtering を無効化する。
  - `--ephemeral`、`--output-schema`、`--json`、`--output-last-message` はある。
  - 観測した help には `-C/--cd` と `--sandbox` が出ていない。再開時の working root / sandbox の扱いは不明。

- `codex exec review`
  - current repository の code review 用。
  - `--uncommitted`、`--base <BRANCH>`、`--commit <SHA>`、`--title <TITLE>` を持つ。
  - `--output-schema`、`--json`、`--output-last-message` も利用可能。
  - AIteamOS の structured review は独自 schema と workflow に結びついているため、そのまま全面置換するより、出力整形部分だけの利用候補。

- session 系 top-level command
  - `codex resume`: interactive session 再開。`--include-non-interactive` があり、非対話 session も picker / `--last` 対象に含められる。
  - `codex fork`: 過去 session の fork。
  - `codex archive` / `codex delete`: session の保存状態管理。`delete --force` は UUID 指定時に prompt なしで削除。
  - top-level `resume/fork/archive/delete` は `-C` / `--sandbox` を持つものがあるが、TUI/interactive 側の操作であり、Worker の非対話実行には `codex exec` 系を優先すべき。

- `codex doctor`
  - local Codex installation、config、auth、runtime health を診断する。
  - `--json` で redacted machine-readable report を出せる。
  - 今回の環境では auth / reachability が失敗。導入判断ではなく「E2E 未実測」の根拠として扱う。

- `codex features`
  - feature flag の stage と effective state を確認できる。
  - 今回の `features list` では `unified_exec` は `stable false`、`network_proxy` と `prevent_idle_sleep` は `experimental false`。
  - feature flag は環境依存なので、Phase 2 で依存しない前提にする。

- `codex mcp-server`
  - Codex を MCP server (stdio) として起動する。help では experimental とは表示されていない。
  - 今回の Codex provider 置換対象ではない。

- experimental と明記されたもの
  - `codex app-server`: `[experimental] Run the app server or related tooling`
  - `codex app-server generate-ts`: `[experimental]`
  - `codex app-server generate-json-schema`: `[experimental]`
  - `codex exec-server`: `[EXPERIMENTAL] Run the standalone exec-server service`
  - `codex cloud`: root help で `[EXPERIMENTAL]`
  - `codex remote-control`: root help で `[experimental]`
  - これらは今回の最小検証では採用対象外。

## 3. 項目別 KEEP / REPLACE / REDUCE 判定

| # | 項目 | 判定 | 根拠 |
|---|---|---|---|
| 1 | process/PID管理 | REDUCE | Codex 内部の実行過程は `codex exec` と `--json` event に寄せる余地がある。一方で AIteamOS は top-level `codex.cmd` process の起動、cwd、env、exitCode、stdout/stderr、timeout を保持する必要がある。現状の `Job` 型に PID 永続化はなく、`BaseCliAdapter` は `execFileSync()` 中心なので、置換対象は「provider 内部 PID 推測」相当がある場合に限定される。`exec-server` は experimental なので使わない。 |
| 2 | timeout | KEEP | `codex exec --help` に timeout flag は確認できない。現状は `BaseCliAdapter` の `timeout` と `provider_timeout` 分類が Stage 1 retry / failure metadata の根拠になる（`adapter.ts` 186-216 行）。Codex 内部 timeout の有無は不明なので、Worker 側 timeout は残す。 |
| 3 | retry | KEEP | `codex exec` help に retry policy は確認できない。AIteamOS には JSON parse retry（`adapter.ts` 253-280 行）、fallbackPolicy（222-230 行）、API 側の provider_timeout 1回 retry（`apps/api/src/routes/jobs.ts` 355-377 行、`storage/interface.ts` 203-207 行）がある。公式Runtimeへ一般 retry を任せる根拠はない。 |
| 4 | session/resume | KEEP | Codex は `exec resume` を持つが、現行 CodexAdapter は `--ephemeral` で session file を残さない設計。AIteamOS の `resumeBlockedTask()` は Codex session ではなく Task/Job workflow の再開であり別責務。さらに `codex exec resume --help` には `-C/--cd` と `--sandbox` が見えず、再開時の安全境界が不明。Phase 1 時点では採用しない。 |
| 5 | cancel/interrupt | KEEP | 現状の Codex 実行は同期 `execFileSync()` で、明示 cancel / interrupt API はない。Node timeout による SIGTERM 相当の停止だけがある。`codex exec --help` に cancel / interrupt flag は確認できない。`app-server` / `exec-server` / `remote-control` は experimental なので、cancel 目的で採用しない。 |
| 6 | structured output（JSON parse失敗時のretry含む） | REDUCE | `codex exec` / `exec review` / `exec resume` は `--output-schema`、`--json`、`--output-last-message` を持つ。これにより Codex provider の最終応答抽出と JSON 再出力 retry は縮小できる可能性が高い。ただし schema 違反時の exitCode / last-message / JSONL event 仕様は未実測なので、`jobRunner.ts` の Zod strict validation（93-128 行、745-764 行）は KEEP。全面 REPLACE はまだ不可。 |
| 7 | Watchdog責務（PID監視・CLI kill・provider内部stall推測など） | REDUCE | 現状 Watchdog は PID や CLI kill ではなく、running Job の `startedAt` と CommandKind 閾値で stall を検出し、Gemini 分析と alert を行う（`watchdog.ts` 20-64 行、`stallDetector.ts` 4-16 行）。Codex `--json` event を使えば provider 内部の最終 activity 推定は改善できる可能性があるが、Job-level watchdog と alert は AIteamOS の責務として残す。 |
| 8 | File Guard / Secret Scan / Gate等のAIteamOS独自安全機構 | KEEP | Codex の `--sandbox` は粗い filesystem sandbox であり、AIteamOS の task-specific `allowedPaths` / `forbiddenPaths`、Red Zone、secret baseline、Gate、post-failure inspection を代替しない。`fileChangeGuard.ts`、`jobRunner.ts` の Stage A / Final Guard、`adapter.ts` の prompt Secret Scan は KEEP。`--sandbox` は defense in depth として使う。 |

## 4. 置き換え可能と判断した場合の最小実装方針（Codexプロバイダーのみ。他providerには触れない）

Phase 2 で試すなら、対象は Codex provider の structured output と進捗ログの縮小に限定する。

1. `codex exec` は継続使用する。`app-server`、`exec-server`、`cloud`、`remote-control` は experimental のため使わない。
2. `CodexAdapter` の既存安全 flag は維持する。つまり `--sandbox read-only|workspace-write`、`-C <workingDir>`、`--ephemeral`、stdin `-` は残す。
3. Codex review / `expectJson` 系に限り、`--output-schema <FILE>` と `--output-last-message <FILE>` を追加する候補にする。
4. `--json` はまずログ・診断用途で採用候補にする。stdout JSONL を最終 verdict として直接信頼せず、last-message と既存 Zod schema validation を通す。
5. `BaseCliAdapter` の timeout、safe env、Secret Scan、changedFiles、postLint、ログ保存は残す。
6. Codex だけ last-message file を parse target にできるようにし、既存の fuzzy `tryParseJson()` retry は Codex provider では縮小候補にする。ただし schema 違反時の CLI 挙動を E2E で確認するまでは削除しない。
7. `codex exec resume` は Phase 2 の main path に入れない。別検証で `-C` / sandbox / session cleanup / cwd filtering の安全性が確認できるまで、AIteamOS の Job resume と混ぜない。
8. `jobRunner`、Roadmap、Review、Approval、Recovery など上位 workflow の変更は提案しない。`adapter.run()` の戻り値契約を維持する範囲に閉じる。

## 5. リスク（rollback容易性・failure mode・既存Rule-001〜013との整合性への影響）

- rollback 容易性
  - CodexAdapter の argv 追加と parse target 切替だけなら rollback は容易。`codex exec --json/--output-schema/--output-last-message` を使わない旧 argv に戻せばよい。
  - `exec-server` / daemon / queue を入れると rollback と運用状態が複雑になるため採用しない。

- failure mode
  - `--output-schema` が schema 違反時にどう失敗するかは未実測。exitCode、stderr、last-message file、JSONL event の関係は不明。
  - `--json` は JSONL event であり、AIteamOS の review verdict JSON と同一ではない。event stream を final output と誤認すると壊れる。
  - `--output-last-message` file が非0終了時や timeout 時に作成されるかは不明。
  - `codex exec resume` の `-C` / sandbox 表示が help にないため、session resume 採用は Rule-005 / Rule-008 との整合性リスクがある。
  - PowerShell の `codex` は `codex.ps1` 拒否になりうる。Rule-002 どおり `codex.cmd` 優先は維持する。
  - `codex doctor` は今回 auth / reachability で fail しており、実モデル実行の安定性は未検証。

- Rule-001〜013 との整合性
  - Rule-001〜004: path resolver と `testCodexConnection()` は KEEP。`codex.cmd` 優先を維持する。
  - Rule-005〜006: `workingDir` 検証と `-C` は KEEP。`--add-dir` は default で使わない。
  - Rule-007: prompt Secret Scan と secret file 除外は KEEP。Codex Runtime に置換しない。
  - Rule-008〜009: `read-only` / `workspace-write` mapping は KEEP。`danger-full-access` と `--dangerously-bypass-approvals-and-sandbox` は使わない。
  - Rule-010: Git/GitHub 禁止操作の安全性は Codex Runtime では担保されない。Worker の SafeCommand allowlist、prompt policy、post diff guard を維持する。
  - Rule-011: mock 完了扱い禁止は上位 workflow の責務であり変更しない。
  - Rule-012: `--json` と `--output-last-message` は呼び出しログの品質改善には使えるが、既存 `saveJobLogs()` を代替しない。
  - Rule-013: Red Zone 検出は `fileChangeGuard()` を KEEP。公式 sandbox は Red Zone semantic を知らない。

## 6. 次フェーズ（実装+E2E比較）で何を検証すべきか（比較項目案）

Codex provider のみ、既存 argv と native structured-output argv を同じ prompt / 同じ target worktree で比較する。

- `codex exec --ephemeral -` と `codex exec --ephemeral --json --output-schema <schema> --output-last-message <file> -` の exitCode / duration / stdout / stderr / changedFiles 差分。
- schema 適合時に last-message file が valid JSON だけを含むか。
- schema 違反を誘発したときの exitCode、stderr、JSONL event、last-message file の有無。
- `--json` JSONL の event type、session id、last activity time として使える field の有無。
- timeout 時に Node 側 `provider_timeout` 分類が維持されるか。timeout 後に orphan process や残存 file lock がないか。
- `--ephemeral` が session file を残さないこと。必要なら一時 `CODEX_HOME` で session file 差分を比較する。
- `codex exec resume` は別枠で、`-C` / sandbox / cwd filtering / `--all` / session cleanup の挙動を確認する。安全境界が不明なら採用しない。
- File Guard が引き続き Stage A / Final で同じ違反を検出すること。
- `codex.cmd` resolver が PowerShell execution policy の影響を受けずに実行できること。
- `doctor --json` を preflight 情報として使えるか。ただし auth / reachability fail を Job retry と混同しないこと。

## 7. 現時点の暫定結論: ADOPT / ADOPT_WITH_LIMITATIONS / DO_NOT_ADOPT のいずれかと1-2行の理由

**ADOPT_WITH_LIMITATIONS**

Codex 公式Runtimeの `--output-schema` / `--output-last-message` / `--json` は、Codex provider の structured output 周辺を縮小する候補になる。一方で timeout、retry、AIteamOS の Task resume、Watchdog、File Guard / Secret Scan / Gate は公式Runtimeで代替できないため KEEP する。experimental な `app-server` / `exec-server` / `cloud` / `remote-control` は採用しない。
