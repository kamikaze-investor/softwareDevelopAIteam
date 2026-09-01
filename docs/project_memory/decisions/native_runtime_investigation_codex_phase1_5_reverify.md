# Codex Native Runtime 最小検証 — Phase 1.5 再検証（session/resume・cancel・streaming・provider内部retry）

**目的**: Phase 1 の「app-serverはexperimentalなのでKEEP」という判定根拠を、最新の公式一次情報
（openai/codex リポジトリのプロトコル文書・app-server README・公式SDK配布状況）でゼロベースに
再検証する。目的は公式Runtime採用そのものではなく、AIteamOS安定版完成までの最短化である。

**手法**: Codex CLI (`codex exec`) のサンドボックスはネットワークアクセスが前提できない
（Phase 1でもCLI --help止まりだった）ため、この再検証は PL(Claude) が直接 WebSearch / WebFetch で
一次情報を取得し、Evidence統合として整理した。取得元はすべて `github.com/openai/codex` 本体の
ドキュメント、または OpenAI 公式 SDK 配布ページ・npm/PyPI レジストリである。

---

## 1. 「experimental」の適用範囲 — 単一のラベルではなく、文書ごとに粒度が異なる

公式ソースには少なくとも2つの異なる粒度の記述があり、**互いに完全には一致しない**。これ自体が
今回の重要な発見である。

### (a) プロトコル仕様文書: `codex-rs/docs/codex_mcp_interface.md`
> "Status: experimental and subject to change without notice."
> "This interface is experimental. Method names, fields, and event shapes may evolve."

→ **v2プロトコル全体（thread/start, thread/resume, thread/fork, thread/read, thread/list,
turn/start, turn/steer, turn/interrupt を含む全メソッド・全イベント形状）に対する包括的な
「将来変更されうる」宣言**。個別メソッド単位の安定/非安定の区別はこの文書にはない。

出典: https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md

### (b) 実装運用文書: `codex-rs/app-server/README.md`
> stdio transport は production-ready（推奨・唯一の本番サポート対象）
> "Websocket transport is currently experimental and unsupported. Do not rely on it for
> production workloads."（Unix socketはローカル制御プレーン専用）
> `thread/start` / `thread/resume` / `thread/fork` / `turn/interrupt` は「標準操作」として
> experimentalマークなしで記載される一方、`thread/goal/set` / `thread/queue/add` /
> `thread/timeline/list` や multi-agent/plugin/marketplace系の一部機能には個別に
> `(experimental)` マークが付く。
> JSON-RPC `-32001`（"Server overloaded; retry later"）は明示的に retryable として
> exponential backoff + jitter を推奨。
> スキーマはCodexのバージョンごとに生成され、"guaranteed to match that version" —
> つまり **semver的な後方互換保証はない**（バージョン間の破壊的変更を明示的に許容する設計）。

出典: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

### 結論（この節）

ユーザーが提起した「experimentalなのはapp-server全体か、WebSocket transportや一部APIだけか」
という問いには、**両方が部分的に正しい**という答えになる:

- **transport単位**では明確に区別がある: stdio=本番利用可、WebSocket=明示的に experimental/unsupported。
- **メソッド単位**でも区別がある: thread/turn のコアライフサイクル操作（start/resume/fork/interrupt）は
  個別のexperimentalマークが付いていない一方、multi-agent/plugin系の応用機能は個別にマークされる。
- しかし**プロトコル文書側は依然として全体に「変更されうる」包括的注意書きを付けている**ため、
  「コア操作は安定版として保証されている」とまでは言えない。実態は「semverの保証はないが、
  コア操作は運用ドキュメント上は非推奨/実験扱いではない」という中間的な位置づけ。

---

## 2. 公式SDKの存在 — Phase 1で把握していなかった重要な事実

Phase 1 レポートは `app-server` / `exec-server` / `cloud` / `remote-control` を CLIの `--help` の
`[experimental]` 表示のみで判定していたが、**OpenAIはapp-server(JSON-RPC)を直接叩くのではなく
公式SDK経由で使うことを推奨している**ことが分かった。

- **Python SDK**: PyPI `openai-codex`。公式ドキュメントで **"available as a stable release"**
  と明記。`codex mcp-server` は **deprecated** と明記されている。
- **TypeScript SDK**: npm `@openai/codex-sdk`。dist-tag `latest` = `0.152.0`（alphaではない
  正式リリースタグ）。Apache-2.0。OpenAI社員複数名がmaintainer。AIteamOS Worker と同じ
  Node.js/TypeScript ランタイム上で利用可能。
- 両SDKとも thread の start / resume / continue（run()の再呼び出し）をラップし、TypeScript側は
  `.run()` / `.resumeThread()` を提供。

出典:
- https://learn.chatgpt.com/docs/codex-sdk （developers.openai.com/codex/sdk からのリダイレクト先）
- npm registry (`npm view @openai/codex-sdk`)

### この発見の意味

「app-serverはexperimentalだから触らない」という Phase 1 の一段階の判断は粗すぎた。正確には
「**生のJSON-RPCプロトコルはexperimental/no-semver-guaranteeだが、それをラップする公式SDKは
stable-releaseとして配布されている**」。これは多くのSDK設計で見られるパターン（内部プロトコルは
変わりうるが、SDKの公開APIはOpenAI側が追従してメンテする）であり、Phase 1 の一律 KEEP 判定は
再考の余地がある。

---

## 3. 実運用上の既知の粗さ（GitHub Issue調査）

一方で、stable-release と謳われていても実運用上の課題が公開Issueで複数確認できた:

- WebSocketストリーム切断後にターンが "Thinking" のまま止まる（#32555）
- thread/resume 後に stream が再アタッチされず、永続化されたセッション状態とライブのランタイムが
  ズレるケースがある
- interrupt→retry を繰り返すと同じスレッドが繰り返しエラー状態に入り、再開しても確実に回復しない
  という報告がある
- `turn/interrupt` は「作業を中断する」ものであり、「一時停止して後で再開する」ことと同義ではない
  （公式ドキュメントに明記）

出典: https://github.com/openai/codex/issues/32555 、関連Issue検索（stream disconnect /
thread resume 関連の複数Issue）

これらは「動く場合は動くが、境界ケースでの回復性はまだ発展途上」であることを示しており、
「stable release」というラベルは**SDKの公開API形状の安定**を意味するのであって、
**プロトコルの動作の信頼性**まで保証するものではない。

---

## 4. バージョン整合性の懸念（環境固有の事実）

- このリポジトリの実行環境にインストール済みの `codex-cli` は **0.146.0**（`codex.cmd --version` 実測）。
- npm の `@openai/codex-sdk` 最新版（`0.152.0`）は `@openai/codex` **0.152.0** に依存する。
- つまり現環境でSDKを導入する場合、**まずCLI/コアバイナリのアップグレードが前提になる**可能性が高い。
  これは「まずCodex 1本だけ検証する」「全面移行しない」という今回の方針に対して、
  検証の前提条件自体を変える環境変更であり、最小検証のスコープを超える。

---

## 5. 項目別 再判定（KEEP / REPLACE / REDUCE）

Phase 2 の structured-output 実測結果（`native_runtime_verification_codex_phase2.md`、CLIの
`--output-last-message` を使った検証）はそのまま baseline として維持し、覆さない。
以下は今回追加で再検証した4項目のみ。

**判定ラベルについて**: session/resume・cancel/interrupt・streaming livenessの3項目は、単純な
`KEEP`ではなく **`KEEP_FOR_NOW / NATIVE_RUNTIME_FOLLOWUP_CANDIDATE`** とする。これは
「公式Runtimeで技術的に代替不能」という判定ではなく、「技術的な代替候補は具体的に存在するが、
AIteamOS安定版完成を優先するため今回は移行しない」という**優先順位上の先送り**であることを
明示するためのラベルである。安定版完成後に独立タスクとして再検証すべき候補として記録する。
provider内部retryは代替候補としての具体性が薄いため、従来通り単純な`KEEP`のままとする。

| # | 項目 | Phase1判定 | Phase1.5再判定 | 再判定の根拠 |
|---|---|---|---|---|
| 5 | session/resume | KEEP | **KEEP_FOR_NOW / NATIVE_RUNTIME_FOLLOWUP_CANDIDATE** | `thread/resume` はコア操作としてexperimentalマークなし、SDKもstable-release。技術的な置換可能性は Phase1想定より高い。しかし (a) SDK採用は execFileSync ベースの現行アダプタ境界を越える構成変更になる、(b) 実運用でresume後のstate不整合が複数報告されている、(c) AIteamOSのTask/Job resumeとCodexのthread resumeは別責務のまま、(d) 環境のcodex-cliバージョンがSDKの前提より古い。「代替不可能だからKEEP」ではなく、「代替候補は具体的に存在するが、安定版完成を優先し今回は移行しない」という優先順位判断としてKEEP_FOR_NOWとする。安定版完成後の独立フォローアップ候補。 |
| 6 | cancel/interrupt | KEEP | **KEEP_FOR_NOW / NATIVE_RUNTIME_FOLLOWUP_CANDIDATE** | `turn/interrupt` は実在し、全threadタイプで使えると記載がある。現状AIteamOSにはNode timeoutのSIGTERM以外に明示cancelがなく、ここは公式Runtimeが本当に穴を埋めうる領域として技術的代替可能性が高い。ただし同期`execFileSync()`中心の現行実行モデルでは`turn/interrupt`を使えず、SDK/非同期実行モデルへの変更が前提になるため、「今回の最小実装」の範囲を超える。技術的代替不能ではなく、安定版完成優先による先送り。安定版完成後の独立フォローアップ候補として最有力。 |
| 7 | streamingによるliveness把握 | （Watchdog責務としてREDUCE寄りだったが対象外） | **KEEP_FOR_NOW / NATIVE_RUNTIME_FOLLOWUP_CANDIDATE** | `codex/event` 通知や `_meta.requestId` 相関があり、Watchdogのstall検出をprovider内部イベントで補強できる可能性はある。ただしイベント順序・配信保証は文書化されておらず、現行Watchdogの「Job単位のstartedAt閾値」を置き換えるには不十分。技術的に不可能というより、公式イベント仕様の成熟待ち・現行アダプタの非同期化待ちという意味でKEEP_FOR_NOW。Job-level livenessはWatchdogに当面残す。安定版完成後の独立フォローアップ候補。 |
| 8 | provider内部retry | KEEP | **KEEP（据え置き）** | JSON-RPC `-32001`（overload）はretryable/backoff推奨と明記されている。これはAIteamOS側の`provider_timeout`分類や1回retryの粒度とは別軸（サーバ過負荷 vs タイムアウト/JSONパース失敗）であり、置き換えではなく将来的な追加シグナルとしての価値がある程度に留まる。他3項目ほど具体的な代替候補ではないため、KEEP_FOR_NOWへの格上げはせず単純なKEEPのままとする。 |

---

## 6. 実装拡大の是非（今回の最小検証での判断）

**今回のPhase 2実装範囲を広げない。** 理由:

1. session/resume・cancel・streaming liveness をSDK経由で試すには、`execFileSync()`による
   同期CLI実行という現行 `BaseCliAdapter` の実行モデルそのものを非同期・プロセス常駐型に
   変える必要があり、「既存aiCli Adapter境界をできるだけ維持する」「新しいRuntime Manager等を
   作らない」という制約と衝突する規模になる。
2. 環境のcodex-cliバージョン(0.146.0)がSDKの前提(0.152.0)より古く、検証のためにまずランタイムの
   アップグレードという別種の変更が必要になる。「全面移行しない」「まずCodex 1本だけ」の方針から
   見て、このタイミングで持ち込むスコープではない。
3. 実運用Issue（resume後のstate不整合、interrupt後の回復不安定）が複数存在し、「安定版完成の
   最短化」という目的に対してはリスクの上振れが大きい。
4. Phase 2で既に実測した structured-output の縮小（`--output-last-message`）は、現行アーキテクチャに
   閉じたまま安全にrollbackできる変更であり、これ単体でも「自作コードの純減」という採用条件を
   部分的に満たしている。

したがって、cancel/interrupt と session/resume の公式SDK活用は
**「DO_NOT_ADOPT」ではなく「具体的候補として記録し、別タスクとして分離検証する」**。
今回の実装はPhase 2の範囲（structured output）に留める。

---

## 7. 安定版完成後の独立フォローアップ候補（記録）

以下は **`NATIVE_RUNTIME_FOLLOWUP_CANDIDATE`** として、AIteamOS安定版完成後に
「現在の自作CLI/Watchdog責務をどこまで削減できるか」を検証する**独立タスク**の候補として
明示的に記録する。今回の判断はこれらの技術的実現可能性を否定するものではない。

| 候補 | 現在AIteamOSが自作している責務 | 検証すべき問い | 前提条件（先に解決が必要） |
|---|---|---|---|
| session/resume | `resumeBlockedTask()` によるTask/Job再開（Codexプロセスとは別レイヤー） | 公式SDKの`thread.resume()`を使って、Codex内部の会話文脈保持部分だけでもAIteamOS側の再構築コストを削減できるか | `BaseCliAdapter`の非同期実行モデルへの移行方針、codex-cliバージョンのアップグレード方針 |
| cancel/interrupt | Node `timeout` によるSIGTERM一本槍（明示cancel APIなし） | `turn/interrupt`を使い、Job cancel要求からCodexプロセスへ安全に中断を伝搬できるか。中断時のFile Guard/差分整合性は保てるか | 同上。加えてinterrupt後のロールバック手順の実測 |
| streamingによるliveness把握 | Watchdogの`startedAt`＋固定閾値によるstall検出 | `codex/event`をWatchdogの補助シグナルとして使い、閾値ベース検出の誤検知/見逃しを減らせるか | イベント順序・配信保証の追加調査、Watchdog側の受信経路設計 |

これらはPhase 1.5時点では**着手しない**。安定版完成後、別タスクとして起票し、本文書と
`native_runtime_verification_codex_phase2.md`（baseline実測）を出発点として再検証すること。

---

## 8. 暫定結論（Phase 1.5時点）

**ADOPT_WITH_LIMITATIONS（Phase 1と同じ結論を維持、ただし理由を精緻化）**

- Codexプロバイダーの structured output 縮小（`--output-schema` / `--output-last-message` /
  `--json`）: Phase 2実測をもってADOPT。
- session/resume・cancel/interrupt・streaming liveness: **KEEP_FOR_NOW /
  NATIVE_RUNTIME_FOLLOWUP_CANDIDATE**。「技術的に代替不能」ではなく「技術的代替候補は具体的に
  存在するが、安定版完成を優先し今回は移行しない」という優先順位判断。上表を安定版完成後の
  独立検証タスクの出発点として残す。
- provider内部retry: 引き続き単純なKEEP。`-32001`情報は将来の補助シグナルとして記録のみ。

---

## 参考リンク（一次情報）

- https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://learn.chatgpt.com/docs/codex-sdk
- https://github.com/openai/codex/issues/32555
- https://github.com/openai/codex/issues/34809
- https://github.com/openai/codex/issues/19045
