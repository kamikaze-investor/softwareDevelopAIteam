# Codex Native Runtime 最小検証 — Phase 2 実E2E追試（直接呼び出し経路）

**背景**: 元のPhase 2 E2E（Codexエージェントへ委任して実行）は、ネストしたCodex→Codex呼び出し経路で
`codex doctor`が`no Codex credentials were found`を返し、モデル応答に到達できなかった。本追試は
そのネスト経路を無理に直さず、**本番のWorkerが行うのと同じ直接呼び出し経路**（PL自身のシェルから
実アダプタコード`CodexAdapter`/`BaseCliAdapter.run()`を直接実行）で再検証した。実装コードの変更は
一切行っていない（`apps/worker/scripts/e2eVerifyCodexNativeRuntime.ts`は未コミットの使い捨て検証
ハーネスで、実アダプタをそのままimportして呼び出すのみ）。

## 0. 事前の切り分け: 元のE2E失敗の真因はネストか、それとも `buildSafeEnv()` の環境変数不足か

Phase 1.5作成時点では「ネストしたCodex呼び出しが原因」と推測していたが、`adapter.ts`の
`buildSafeEnv('codex')`が`PATH`/`HOME`/`LANG`/`TERM`/`NODE_ENV`/`OPENAI_API_KEY`しか子プロセスへ
渡していない点も別の疑いとして浮上した（Windowsのネイティブプロセスでは`process.env.HOME`が
未設定になりうり、`USERPROFILE`/`APPDATA`も渡していないため）。

これを直接検証するため、`buildSafeEnv('codex')`と全く同じ形の env（実測: `HOME`はネイティブ
PowerShellでは空、`USERPROFILE`/`APPDATA`等は一切渡さない）で`cmd.exe /c codex.cmd exec ...`を
直接叩くprobeスクリプトを実行した。

**結果: 成功。** 実モデル応答が正常に返り、認証エラーは一切発生しなかった。

→ **`buildSafeEnv()`の環境変数不足が原因という仮説は棄却**。元のPhase 2失敗は
**ネストしたCodex→Codex実行経路に固有の問題**と結論づけてよい（ユーザーの推測どおり）。
このネスト経路自体の修正はスコープ外のため行わない。

## 1. 検証方法

- `apps\worker\scripts\e2eVerifyCodexNativeRuntime.ts`（未コミット）が`createAiCliAdapter({provider:'codex'})`
  を実際に呼び出し、`C:\workspace\target\verify-repo`（`isInsideTargetRoot()`の実チェックを通すため、
  ハードコードされた`TARGET_ROOT='/workspace/target'`の実解決先に作成した独立git repo）を`workingDir`とした。
- 実行はPL自身のシェル（PowerShell）から直接。Codexをネストして呼んでいない。
- 認証は今回操作していない。このマシンに既存の`codex login`済みアカウントをそのまま使用した
  （＝AIteamOSが本番でWorkerプロセスから直接`codex exec`を呼ぶ場合と同じ認証状態）。

## 2. 結果

| # | ケース | 結果 | 詳細 |
|---|---|---|---|
| A | 正常系（expectJson、JSON準拠プロンプト） | **PASS（実モデル応答で確認）** | `exitCode=0`, `parsedOutput={"ok":true,"case":"A"}`, `blocked=false`, `retryCount=0`。stdout自体も同一JSONだったため、last-message経由かstdout経由かは本テストでは判別不能（どちらでも正しい結果になるケース）。ユニットテスト（Phase 2、22件PASS）側で経路の優先順位は別途検証済み。 |
| B | フォールバック（非JSON応答→retry→それでも非JSON→blocked） | **PASS（実モデル応答で確認）** | `exitCode=0`, `parsedOutput=undefined`, `blocked=true`, `retryCount=1`（`maxRetries=1`どおり）。stdout retryが正しく発火し、それでも失敗したら安全にblocked扱いになることを実モデルで確認。 |
| C | timeout（`timeoutMs=100`） | **PASS（実モデル応答で確認）** | `exitCode=1`, `providerFailureKind='provider_timeout'`, `blocked=true`, `retryCount=1`。timeout後も既存のretryループが（同じ短すぎるtimeoutで）1回動作し、最終的に安全側でblockedになる。**一時ファイルのcleanupは正常時・timeout時とも確認できた（leftoverファイルなし）**。 |
| D | エラー（不正な`--model`指定） | **不確定** | `exitCode=1`, `blocked=true`, `retryCount=1`まで確認したが、stderrの実内容を取得しておらず、「不正モデル名によるCLI拒否」なのか「後述の使用量上限」なのかを区別できていない。 |
| E | 回帰確認（`expectJson=false`の素のプロンプト） | **未実施（ブロック）** | 実行時に `ERROR: You've hit your usage limit. ... try again at Sep 2nd, 2026 2:05 AM.` を受け取り、モデル応答に到達しなかった。**本セッションでここまでに行った実モデル呼び出し（A〜Dの計7回）で、このマシンのCodexアカウントの使用量上限に達したことが原因**であり、`--output-last-message`変更やコード側の不具合ではない（`expectJson=false`のときは`buildCodexOutputLastMessagePath()`が即座に`undefined`を返し、`--output-last-message`は一切argvに追加されないため、この経路は旧方式と完全に同一のコードパスを通る）。 |
| F | orphanファイル検出（`buildWorktreeManifest()`直接呼び出し） | **PASS（実測・モデル呼び出し不要）** | `.codex-last-message-orphan-test-999.json`を`workingDir`直下に手動配置し、`buildWorktreeManifest()`を直接呼んだところ `{path: '...', kind: 'added', afterType: 'regular'}` として検出された。**「OS強制kill等で一時ファイルが残ってもFile Guardが検出する」という従来の記述は、推測ではなく実測で正しいことを確認した。** 一時ファイルは`workingDir`（targetのgitリポジトリルート）配下に作られ、OS temp領域ではないため、File Guard管理外にはならない。`buildWorktreeManifest()`は`git status --porcelain=v2 --untracked-files=all`ベースでuntrackedファイルも捕捉する実装になっている（`changeManifest.ts`）。 |

## 3. 現時点で確定していること

- ネストしたCodex→Codex経路を避けて直接呼び出せば、実モデル応答を伴うE2Eが実行できることを確認した。
- 正常系（A）・フォールバック系（B）・timeout系（C）・一時ファイルcleanup・File Guard検出（F）は
  実モデル応答/実測で確認済み。
- `--output-last-message`変更そのものに起因する不具合・クラッシュ・安全機構の後退は、確認できた範囲では
  見つかっていない。

## 4. 未確定・要再検証（使用量上限のため中断）

- **D**: 不正モデル名時の失敗原因の切り分け（CLI拒否 vs 使用量上限）。stderrを記録した上で再実行が必要。
- **E**: 「旧方式と比べて既存workflowに回帰がない」の直接確認が未実施。ユーザー指定の必須確認項目のうち
  最も基本的なものであり、これが通るまでADOPT判定はできない。
- 使用量上限のエラーメッセージによれば、`Sep 2nd, 2026 2:05 AM`（このマシンのタイムゾーンでの表示）以降に
  再度実モデル呼び出しが可能になる見込み。

## 5. 結論（このドキュメント時点）

**PENDING_VERIFICATION（維持）。**

DとEの再実行（使用量上限解除後）が完了し、Eが旧方式と同等に成功することを確認できて初めて
`ADOPT_WITH_LIMITATIONS`への格上げとPR化を検討する。現時点でADOPT_WITH_LIMITATIONSとしてPR化を
進めることはしない。

## 6. 再実行手順（quota解除後）

未コミットのまま残してある検証ハーネスをそのまま使う:

```
apps/worker/scripts/e2eVerifyCaseEOnly.ts   — ケースEのみ、stderrも出力
apps/worker/scripts/e2eVerifyCodexNativeRuntime.ts — A〜F一式
```

`C:\workspace\target\verify-repo` は再利用可能な状態でそのまま残している。
