# PR #435 の DA (7) 判断: 出力超過の分類変更は Class B（2026-10-29 CEO）

## 判断

CEO は `specs/22` §14-3 の DA trigger (7)（Review verdict の不一致が未解消）について次を決定した。

- 対象: PR #435（`[safe-command-output-overflow] …`）の **HEAD `46c3685c9ac410171e6714f79733144280e290a6`**。
  その base は master `8e85f68c`、差分は次の7ファイルである:
  - `apps/worker/src/execution/runContainedCommand.ts`
  - `apps/worker/src/execution/runContainedCommand.test.ts`
  - `apps/worker/src/execution/containedCommandTestBridge.ts`
  - `apps/worker/src/jobRunner.ts`
  - `apps/worker/src/jobRunner.test.ts`
  - `apps/worker/src/index.test.ts`
  - `docs/project_memory/decisions/safe_command_output_overflow_2026_10_28.md`
- 判断: この範囲の変更は **Class B（技術的な enforcement correction）** であり、containment の Safety boundary を弱めない。
- 範囲外: 無関係な containment の変更の承認ではない。技術的な安全確認を迂回してよいという許可でもない。
  HEAD が変わった場合（base の更新を含む）、この判断はその新しい HEAD へ自動では引き継がれない。

## 判断の条件（CEO が付けた不変条件）と、#435 での根拠

| # | 条件 | #435 の根拠 |
|---|---|---|
| 1 | 後始末の成功を独立に確認できた SafeCommand の出力超過だけが、通常の失敗へ移る | `isOutputOverflowAfterSafeCleanup()`（`runContainedCommand.ts`）が判定し、`jobRunner.ts` の SafeCommand の catch だけで使う。<br>`output_overflow` の生成箇所は1つで、`runInsideCgroup()` の `if (isContainmentSafe(cleanup.outcome))` の then 側にしか無い。これを AST の不変条件テストが固定している（5種の改変で落ちることを確認済み）。<br>Linux の実 cgroup テストでは、超過後に cgroup が削除済みであることを確認している |
| 2 | 失敗・未完了・不明・確認できない後始末は quarantine のまま | drain_timeout / cleanup_failed / kill_failed / events_failed / placement_failed / spawn_failed / unavailable / 未知の結果は、それぞれ throw（quarantine）のまま。<br>`jobRunner.test.ts` と `runContainedCommand.test.ts` のテストで確認している |
| 3 | workspace の整合検査は必須のままで、その失敗は quarantine のまま | 超過の後も最終 workspace 検査（git 操作マーカー）を通る。マーカーが残れば throw する（`jobRunner.test.ts`）。<br>production entrypoint では、`processQueuedWork` で `WorkspaceReconciliationError` が blocked + quarantined と記録される（`index.test.ts`） |
| 4 | 切れた・不完全な検証出力を成功扱いしない | 超過は exit code 不明の失敗（exitCode 1・`safe_command_failed`）になる。子が exit 0 でも failed のまま（`jobRunner.test.ts`） |
| 5 | AI CLI など他の containment 呼び出し元は fail closed のまま | AI CLI・review・post-lint の経路は変えていない（差分ファイルに無い）。<br>AI CLI 経路の超過は従来どおり throw する（`jobRunner.test.ts`） |
| 6 | quarantine の解除条件と workspace 所有権の保護は変えない | `jobStateManager.ts`（startup recovery）、API の clear-quarantine、Human Resume / abort / Human Recovery は差分に無い |

## 判断に使った材料

- Meta Review（同じ HEAD `46c3685c`、2026-10-29）:
  - `Meta Review (base)`（default branch の reviewer）は APPROVED で、CEO 承認は不要（Class B）とした。
  - required check の `Meta Reviewer AI (Gemini)`（PR-run）は BLOCKED。理由は DA (1) で、技術的な欠陥は指摘していない。
  - どちらの記録も PR #435 にそのまま残してある。再実行も、PR 本文の編集もしていない。
- 独立 Challenger（Codex gpt-5.6-sol、3回）: #437 の分類 clause の条件 1〜6 に照らして、#435 は Class B にあたり、別の Class A 判断を要する変更は無い。
- 実装の独立レビュー（Codex、最終実装に対して）: approved。

## この判断を formal に反映する方法（現行ルール上の制約）

- 現行の Ruleset の required check は `Typecheck & Test` / `Meta Reviewer AI (Gemini)` / `Code Owner Approval` である。
  `Meta Reviewer AI (Gemini)` は FAILURE のまま。この check は Meta Review の判定から機械的に作られ、CEO の判断を受け取る入口が無い。
- そのため、この記録だけでは #435 は merge できない。Ruleset を PR ごとに変える例外や、判定を出し直すことは行わない。
- 既に承認済みの一般的な変更である Stage 0b（`tasks/roadmap.md` `meta-review-base-run`、2026-10-27 CEO 承認）を済ませると、
  required check は `Meta Review (base)` になり、`46c3685c` の上の success がそのまま有効になる。Stage 0b には前提条件があり、
  bot の credential を Actions 書き込み権限の無い fine-grained token へ替えてからでなければ実施しない。
  あわせて CEO の Code Owner 承認が要る。
- Stage 0b は、PR が自分の reviewer を書き換えられる問題を直すための変更であり、判定の不一致を裁く仕組みではない。
  不一致そのものを裁いたのは、この CEO の DA (7) 判断である。
