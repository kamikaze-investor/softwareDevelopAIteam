# SafeCommand の出力超過で workspace を quarantine しない（2026-10-28）

## 何が起きたか

2026-10-28 07:31:48Z、Task `ffd63184`（`design-review-runner-production-timeout`）の implement Job `71538c24` が
`containment failed: output_overflow (output exceeded 1048576 bytes per stream)` で quarantine（blocked・所有権保持）になり、
自律実行が止まって CEO へ escalate された。

Production で read-only に確かめた事実:

- AI CLI は 07:28:35Z に成功し、3ファイルを変更した。超過したのはその後の SafeCommand
  `pnpm run verify:implement`（全パッケージ typecheck → test。#355）の stdout である。
- Worker cgroup 配下に job cgroup は残っていない。残っているのは Worker 自身の 5 PID だけで、vitest や tsc のプロセスも無い。
- workspace の HEAD は Job 開始時の baseline（`0630101f`、clean）と同じで、変更は AI が書いた3ファイルだけである
  （mtime 07:26:43Z〜07:28:19Z）。07:29:44Z 以降、gitignore 対象のテストログ以外は何も書かれていない。`.git/*.lock` も無い。
- 直近の成功した implement Job 5件では verify:implement の stdout が 805〜822 KB あり、上限 1 MiB の約 78% を占めていた。
  そのうち約 458 KB は `apps/worker/src/jobRunner.test.ts` の1テストが入れる「6000字の例外を投げる `saveJobLogs` mock」が
  後続テストへ漏れ、`Job result log could not be saved: yyyy…` を 76 行出していたものである。
  Task 側の差分が design review の attempt ごとに `console.info` を足したことで、上限を超えた。
- `output_overflow` による quarantine は Production では初めてである。過去の containment quarantine 2件
  （2026-09-14、`cleanup_failed` EBUSY）は本当に後始末が失敗したものだった。

## なぜ quarantine になったか（分類の食い違い）

`runContainedCommand()` が `output_overflow` を返すのは、後始末（`cgroup.kill` → `populated 0` → rmdir）が
成功した場合だけである（`isContainmentSafe(cleanup.outcome)` の内側）。後始末が失敗すれば、その失敗
（`drain_timeout` / `cleanup_failed` など）が結果になる。つまり `output_overflow` は timeout による `killed` と
**同じ静止の証拠**を持つ。

それにもかかわらず:

- timeout（`killed`）→ 通常の SafeCommand 失敗 → 最終 workspace 検査 → Job failed → 既存の repair
- 出力超過 → `runContainedOrThrow()` が `ContainmentInfrastructureError` を投げる → `quarantineRunningJob()`

と分かれていた。quarantine の解除は Worker 起動時の再検証（workspace が baseline と完全一致）だけなので、
AI がファイルを書いた後に quarantine されると、作業を捨てない限り戻れない。

## 修正 B: テストの mock 漏れを止める（出力そのものを減らす）

- `jobRunner.test.ts` の top-level `beforeEach` で `saveJobLogs` mock の既定実装を毎回入れ直す。
  `vi.clearAllMocks()` は呼び出し履歴しか消さず、`mockImplementation` は残るためである。
- T6 の例外文字列を 6000 字から「注記上限 `LEADING_NOTE_MAX_LENGTH`（300字）を少し超える長さ」へ縮める。
  T6 が確かめたいのは「上限を超える長さでも注記2件が残る」ことであり、6000 字である必要は無い。

これでテスト・検証の内容は変わらず、出力だけが減る。`--silent` は失敗テストのログまで消すため使わない。
SafeCommand のコマンドや 1 MiB の上限は変えない。

## 修正 A: 後始末が成功した出力超過は、通常の SafeCommand 失敗として扱う

- `runContainedCommand.ts` に `isOutputOverflowAfterSafeCleanup(err)` を置く。
  「`output_overflow` は後始末が成功した場合にだけ返る」という不変条件の持ち主（同じファイル）が判定する。
- `jobRunner.ts` の **SafeCommand 実行箇所だけ**で、この例外を「exit code 不明の失敗」に変換する。
  stdout / stderr は上限で切られた範囲を保持し、固定の注記（出力が上限を超えたため打ち切った・検証結果は不明）を先頭に置く。
  その後は timeout と同じく最終 workspace 検査（git 操作マーカー確認を含む）を通る。
  検査が失敗すれば、従来どおり `WorkspaceReconciliationError` で quarantine になる。
- 子プロセスが exit 0 で終わっていても、出力超過なら成功にしない（切られた出力は検証の証拠にならない）。
- 他の containment 失敗（`drain_timeout` / `cleanup_failed` / `kill_failed` / `events_failed` / `placement_failed` /
  `spawn_failed` / `unavailable`）は従来どおり投げ、quarantine する。
- AI CLI・review・post-lint の呼び出しは変えない。独立レビュー（Codex 2026-10-28）の指摘により、
  一律に `SAFE_OUTCOMES` へ加えると、JSON retry が切れた stdout を parse する・post-lint が結果を見ない・
  exit 0 の超過を成功扱いする、という false success が生じるためである。
- 新しい Gate・Status・回復機構は足さない。出力超過の Job は既存の failed → repair（#431 で失敗した SafeCommand の
  証跡を repair へ渡す）に乗る。

## 現在の Task `ffd63184` への影響

この修正は既存の quarantine を遡って解除しない。保存されているのは理由の文字列だけで、後始末の結果は構造化されていないため、
理由文字列に一致させて遡及解除するのは安全でない（Codex 同意見）。現在の Job の回復方法は別途 CEO へ提示する。
AI が書いた3ファイルは、Production の workspace にそのまま残っている（ローカルに diff の控えもある。sha256 `7db3087b…`）。
