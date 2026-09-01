# Codex Native Runtime 最小検証 — Phase 2 実装+E2E結果

## 1. 実装変更点（ファイル別、diffの要約）

- `apps/worker/src/aiCli/adapter.ts`
  - `provider === 'codex'` かつ `request.expectJson === true` の初回実行だけ、`workingDir` 直下に `.codex-last-message-<taskId>-...json` 形式の一時ファイルパスを生成するようにした。
  - 生成したパスは共有型 `AiCliRequest` には追加せず、adapter 内のローカル拡張プロパティ `codexOutputLastMessagePath` として `buildArgv()` に渡す。
  - CLI 実行後の `finally` で last-message file を読み、`tryParseJson()` に成功した場合は `parsedOutput` として採用する。読み取り後は同じ `finally` 経路で削除する。
  - last-message file が無い、または parse できない場合は、既存の `tryParseJson(stdout)` + `maxRetries` 回の stdout retry にフォールバックする。既存 retry ロジックは削除していない。
  - `changedFiles` 検出より前に一時ファイルを削除するため、正常系では File Guard 対象に一時ファイルが残らない。

- `apps/worker/src/aiCli/codexAdapter.ts`
  - `codexOutputLastMessagePath` が渡された場合のみ、`codex exec ... --ephemeral --output-last-message <tmpfile> -` を組み立てる。
  - 通常の Codex 実行、非 Codex provider、`expectJson` なしの実行には argv 変更が入らない。

- `apps/worker/src/aiCli/adapter.test.ts`
  - `execFileSync` をモックし、Codex+`expectJson` の成功経路とフォールバック経路を追加した。
  - last-message file の JSON parse 成功時に stdout retry がスキップされることを確認した。
  - last-message file の parse 失敗時に stdout retry へ戻ること、かつ一時ファイルが削除されることを確認した。

## 2. 旧方式 vs Native Runtime比較（E2E実測結果の表）

実行環境:

- CLI: `codex-cli 0.146.0`
- workdir: `.e2e-tmp/`
- prompt: `Output only this JSON object and nothing else: {"ok": true, "note": "phase2"}`
- 旧方式: `codex.cmd exec --sandbox read-only -C .e2e-tmp --ephemeral -`
- 新方式: 上記に `--output-last-message <tmpfile>` を追加

| 方式 | 回 | exitCode | 所要時間(ms) | 1回目JSON解析 | stdout | last-message file | 主な stderr |
|---|---:|---:|---:|---:|---|---|---|
| 旧方式 | 1 | 1 | 36,835 | 0 | 空 | なし | `401 Unauthorized` |
| 旧方式 | 2 | 1 | 36,027 | 0 | 空 | なし | `401 Unauthorized` |
| 旧方式 | 3 | 1 | 35,904 | 0 | 空 | なし | `401 Unauthorized` |
| 新方式 | 1 | 1 | 36,349 | 0 | 空 | 作成されず | `401 Unauthorized` |
| 新方式 | 2 | 1 | 35,560 | 0 | 空 | 作成されず | `401 Unauthorized` |
| 新方式 | 3 | 1 | 36,649 | 0 | 空 | 作成されず | `401 Unauthorized` |

集計:

- 旧方式: stdout JSON parse 成功 `0/3`、平均 `36,255ms`
- 新方式: last-message JSON parse 成功 `0/3`、平均 `36,186ms`
- stdout と last-message file の差分: 認証失敗により stdout は全回空、last-message file は新方式でも作成されなかった。
- timeout: なし。全回 `exitCode=1` で終了した。
- process/orphan: `Get-CimInstance Win32_Process` は権限不足で command line 取得不可。`Get-Process` では既存/常駐と思われる Codex 関連プロセスが見えたが、今回の `codex exec` 由来とは断定できない。`.e2e-tmp/last-message-*` の残留はなし。

補助確認:

- `OPENAI_API_KEY` は未設定。
- `codex.cmd doctor --summary --ascii` は `auth: no Codex credentials were found`、`websocket` warning、`reachability` fail を返した。
- よって今回の E2E は「CLI flag の受理と失敗時挙動」は観測できたが、モデル応答後の structured output 安定性比較までは到達していない。

## 3. typecheck / test 結果

- `pnpm --filter @ai-team/worker typecheck`
  - PowerShell では `pnpm.ps1` が execution policy で拒否されたため、`pnpm.cmd` を使用した。
  - 依存関係の自動 install が native build に入るため、検証実行は `pnpm.cmd --config.verify-deps-before-run=false --filter @ai-team/worker typecheck` に切り替えた。
  - 結果: PASS。`tsc --noEmit` が exit code 0。

- `pnpm.cmd --config.verify-deps-before-run=false --filter @ai-team/worker exec vitest run src/aiCli/adapter.test.ts`
  - 結果: PASS。`1 passed` file、`22 passed` tests。

- `pnpm.cmd --config.verify-deps-before-run=false --filter @ai-team/worker test`
  - 結果: FAIL。`58` files 中 `54 passed / 4 failed`、`1050` tests 中 `1040 passed / 10 failed`。
  - 今回変更対象の `src/aiCli/adapter.test.ts` は PASS。
  - 失敗内訳:
    - `scripts/delegateWatchdog.test.ts`: `expected recovery_attempt_count '0', got '1'`
    - `src/jobRunnerCleanup.test.ts`: 2 tests が CRLF 差分で失敗。`expected 'baseline\n'` に対し `received 'baseline\r\n'`
    - `src/resumeIntegration.test.ts`: `better-sqlite3` native binding が見つからず失敗。
    - `src/outbox/outboxStore.test.ts`: 6 tests が `better-sqlite3` native binding 不足で失敗。
  - `better-sqlite3` は事前の依存 install 試行でも Python/node-gyp 環境不足で build に失敗しており、今回の adapter 変更による失敗ではない。

## 4. 削除できる/縮小できた自作コード（あれば。無理に作らない）

削除できた自作コードはまだない。

ただし last-message parse 成功時は既存 stdout retry をスキップできる経路を追加したため、実認証環境で成功が確認できれば Codex provider の JSON retry コストを縮小できる可能性がある。Phase 1 の KEEP 判定どおり、schema 違反時や CLI 失敗時の挙動が未検証なので retry ロジック自体は残す。

## 5. リスク・未解決点

- E2E は Codex credentials 不在と reachability fail により、モデル応答後の last-message file 生成までは確認できなかった。
- `--output-last-message` の schema 違反時挙動、timeout 時に file が部分生成されるか、stderr/stdout/exitCode の関係は未検証。
- 一時ファイルは `workingDir` 直下に作る。通常は `finally` で削除されるが、OS レベルでプロセスが強制終了された場合は残留しうる。その場合も既存 File Guard が検出する。
- `summary` 抽出は従来どおり stdout ベースのまま。今回の変更は `parsedOutput` の抽出経路に限定した。
- process 残留の厳密確認は、現環境で Win32 process command line の取得権限がなく未確定。

## 6. rollback手順（このコミットをrevertすれば旧方式に戻ることの確認）

rollback はこの変更コミットを revert すればよい。

revert で戻る差分は以下に閉じている:

- `adapter.ts` の一時ファイルパス生成、last-message 読み取り/cleanup、`parsedOutputFromLastMessage` 優先採用
- `codexAdapter.ts` の `--output-last-message <tmpfile>` argv 追加
- `adapter.test.ts` の追加ユニットテスト
- 本 Phase 2 レポート

既存の `tryParseJson(stdout)` + retry ロジックは削除していないため、revert しなくても last-message file が無い/壊れている場合は旧方式へフォールバックする。

## 7. 結論: ADOPT / ADOPT_WITH_LIMITATIONS / DO_NOT_ADOPT

**ADOPT_WITH_LIMITATIONS**

Codex provider かつ `expectJson` に限定した `--output-last-message` 経路は、実装上 rollback 容易で、既存 stdout retry の安全網も維持できるため採用可能。ただし今回の E2E は Codex credentials / reachability の環境問題でモデル応答まで到達せず、安定性比較は未完了。認証済み環境で再実測し、last-message 成功率、schema 違反時挙動、timeout 時の file 生成有無を確認するまでは、Phase 1 と同じく限定採用に留める。
