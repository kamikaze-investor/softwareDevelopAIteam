# traversal / loop の停止保証 横断監査（read-only）— 2026-10-16

（2026-10-22 注: 2026-10-16 時点の監査。以後 lifecycle repair #381–#393 で変わった箇所: 本文の行番号は全般にずれている（関数名で引くこと。例: `walkRepairGeneration()` は `repairPolicy.ts:491`、`runPlTick()` は `executionLoop.ts:1738`）。C2 は audit 書き込みが失敗してもプロセス内カウンタ（`handleTargetBounded()`）で同じ上限に打ち切る。P1 は Technical Abort cleanup の配送待ちの間 Job intake を止める分岐が増えた。lifecycle repair 以外では #346 で T8a（git_commit 側の resume 区間）が多段の `resolveGitCommitResumeOrigin()` になり、上限が D1 と同じ `visited.size > maxHops` の形をとる。D1–D5 は 2026-10-22 時点で未解消・Roadmap 未登録。）

対象 Roadmap 項目: **traversal / loop に termination guarantee があるかの横断監査（read-only）**（2026-09-22 登録）。

この記録は監査の結果だけを残す。**見つかった欠陥はここでは直していない。** 各欠陥には、別項目として
登録するための follow-up 案を付けた（§5）。ソース・設定・Roadmap はいずれも変更していない。

---

## 1. 範囲と方法

- **対象**: `apps/api/src` / `apps/worker/src` の production code（`*.test.*` は除く）。
  `apps/mobile`、`apps/worker/scripts`、リポジトリ直下の `scripts/` は対象外。
- **方法**: 静的な読解だけで行った。このセッションにはコマンド実行手段が無いため、**mutation を実際に当ててはいない**。
  「mutation を当てても止まるか」の欄は、「意味側のガードを 1 行無効化したら何が残るか」をコードを読んで推論したものである。
  検証された事実ではないので、§5 の follow-up で既存の harness（`scripts/repairLineageMutationGuard.mjs`）を使って確かめる想定にしてある。
- **列挙の手順**（再現できるように残す）:
  1. `while (` / `do {` / `for (;;` / `for (let x = 0; ; …)` / `setInterval(` を grep する
  2. 環検出・重複検出の痕跡（`seen` / `visited` / `visitState` / `new Set` を使う walk）を grep する
  3. 再帰する helper（`visit*` / `walk*` / `collect*` / `depth + 1` / `再帰`）を grep する
  4. retry 系（`attempt <` / `MAX_*_ATTEMPTS` / `RETRY_DELAYS`）を grep する
  5. 既知の常駐ループ（Worker の poll、watchdog、PL tick、reconcile 系の route）から呼び出し先を手で辿る
- **列挙しないもの（class として扱う）**: 既に実体化された有限の配列や DB の結果に対する素の `for…of` / `.map` / `.filter` / `.some`。
  ただし本体がその集合を変更しない場合に限る。反復はコレクションの長さで抑えられ、mutation で壊れる意味側のガードを持たない
  （下の分類では `bounded-by-monotone-state`）。数百件あり個別に挙げても判断材料にならないので、
  **この class の例外**（本体で集合を伸ばす、反復の中で別の walk を呼ぶ、など）だけを個別に挙げた。

## 2. 分類の定義

各経路は、**意味側のガードを壊したときに残る停止根拠**（load-bearing な保証）で、次のちょうど 1 つに分類する。

| 分類 | 意味 |
|---|---|
| `bounded-by-fixed-step` | ループに入る前に決まる上限を持つ、意味側と独立したカウンタで止まる。上限は定数のことも、データ由来（集合のサイズ）のこともある。どちらかは表に書く |
| `bounded-by-cycle-guard` | 訪問済み集合などの意味側ガード**だけ**が停止を支える（または他の上限がそのガードの状態から導かれている） |
| `bounded-by-monotone-state` | 有限な値域の中で状態が単調に進む（path が短くなる、読んだバイト数が増える、有限の木を下る、snapshot 配列を 1 回なめる） |
| `bounded-by-external-timeout` | wall clock・AbortController・library の既定 timeout で止まる。反復そのものには上限が無い |
| `NO-DETECTED-BOUND` | 上記のどれも見つからなかった |

「mutation に耐えるか」の欄の意味は次のとおり。**yes** は、意味側ガードを 1 つ壊しても別の根拠で有限時間内に止まることを指す。
**fragile** は、ガードを壊す、または設定値が非有限になると停止根拠が消えることを指す。

## 3. 経路一覧

### 3-1. lineage / dependency / filesystem の traversal・再帰 walk

| # | 場所 | 関数 | 停止の根拠 | 分類 | mutation に耐えるか |
|---|---|---|---|---|---|
| T1 | `apps/api/src/designReview/repairPolicy.ts:472` | `walkRepairGeneration()` | `seen`（環検出）＋歩数上限 `step <= byId.size`（この Task の Job 件数。データ由来）。上限に達したら `ok:false` の fail-closed | `bounded-by-fixed-step`（データ由来） | **yes**。上限は `seen` と独立したカウンタなので、`seen` を潰しても `byId.size + 1` 歩で止まる。2026-09-22 の hang（§4）を受けて直した状態 |
| T2 | `apps/api/src/designReview/repairPolicy.ts:290` | `resolveReviewedImplementationFrom()` | `visited`（環検出）＋ `visited.size > maxHops`（`maxHops` = 同じ Task の Job 件数） | `bounded-by-cycle-guard` | **fragile（D1）**。上限が `visited.size`、つまり意味側ガード自身の状態から導かれている。`visited.add(sourceId)` を無効化すると、環検出と歩数上限が**同時に**消える |
| T3 | `apps/api/src/storage/roadmapTaskValidation.ts:152` | `buildCircularDependencyIssues()` 内の `visit()`（再帰 DFS） | `visitState`（`visiting` は環、`visited` は済み） | `bounded-by-cycle-guard` | **fragile（D4。低）**。`visiting` 判定を壊すと無限再帰になるが、JS のスタック上限で `RangeError` が投げられる（hang ではなく大きな音を立てて失敗する）。`visited` の早期 return だけを壊すと、diamond 状の DAG で訪問回数が経路数ぶん（指数的）に増える。有限だが実質的な上限は無い |
| T4 | `apps/api/src/ctoAi/contextManager.ts:179` | `collectFiles()`（再帰） | `visited`（realpath 単位）＋ `depth > MAX_DIRECTORY_DEPTH (12)` ＋ `result.length >= limit` | `bounded-by-fixed-step`（定数。`visited` は補助） | **yes**。`visited` を壊しても深さ 12 の固定上限が残る（§2 の規則により、残る停止根拠＝固定上限で分類する。T1 と同じ扱い）。symlink の自己参照があると訪問数は fan-out の 12 乗まで増えうるが有限で、ファイル数が `limit` に達した時点でも止まる |
| T5 | `apps/worker/src/guards/gitOperationState.ts:83` | `findRefLockFiles()`（明示的な stack を使う DFS） | `Dirent.isDirectory()` は symlink に対して false を返すので、symlink を辿らない。有限の木を下るだけ | `bounded-by-monotone-state` | **yes**。壊せる意味側ガードが無い。bind mount で自己を含めた木を作れば別だが、それは Worker の権限外 |
| T6 | `apps/worker/src/aiCli/adapter.ts:109` | `isInside()`（`for (;;)` で祖先を辿る） | `path.dirname` は root で不動点になる（`next === current`）。path は単調に短くなる | `bounded-by-monotone-state` | **yes** |
| T7 | `apps/api/src/designReview/repairPolicy.ts:568` | `jobsSupersededByHumanResume()` | `priorJobs` を 1 回なめ、各行で T1 を呼ぶ（O(n²)） | `bounded-by-monotone-state` | **yes**（T1 が耐える限り） |
| T8a | `apps/api/src/storage/sqlite.ts:1539-1584` | `resolveSourceImplementJobForRejectedGitCommit()` の git_commit 側区間（`resume:` の 1 ホップ正規化） | 最大 1 ホップで、ループしない。歩数は定数 1 | `bounded-by-fixed-step`（定数 1） | yes。この区間自体には壊せる意味側ガードが無い |
| T8b | `apps/api/src/storage/sqlite.ts:1592` / `apps/api/src/designReview/repairFlow.ts:516` | `resolveSourceImplementJobForRejectedGitCommit()` / `resolveReviewedImplementation()` の review→implement 区間（どちらも `resolveReviewedImplementationFrom()` を呼ぶ） | T2 そのもの | `bounded-by-cycle-guard` | **fragile（D1）**。T2 と同じで、**D1 の影響範囲**になる |

### 3-2. retry / recovery loop

| # | 場所 | 関数 | 停止の根拠 | 分類 | mutation に耐えるか |
|---|---|---|---|---|---|
| R1 | `apps/worker/src/index.ts:410` | `patchJobWithRetry()` | `attempt < 3`。試行ごとに AbortController timeout | `bounded-by-fixed-step` | yes |
| R2 | `apps/worker/src/aiCli/adapter.ts:544` | JSON 再出力 retry（`BaseCliAdapter` 内） | `retryCount < maxRetries`（既定 2。constructor の config で上書きできる）。試行ごとに contained command の timeout | `bounded-by-fixed-step` | yes。`maxRetries` に `Infinity` を渡す呼び出し元は見当たらなかった |
| R3 | `apps/worker/src/execution/runContainedCommand.ts:739` | `removeCgroupWithRetry()`（`for (let attempt = 0; ; …)`） | `attempt >= CLEANUP_RETRY_DELAYS_MS.length` で break | `bounded-by-fixed-step` | yes |
| R4 | `apps/worker/src/notifier/notifier.ts:94` | `sendWithRetry()` | `MAX_SEND_ATTEMPTS = 3` | `bounded-by-fixed-step` | yes |
| R5 | `apps/worker/src/metaReviewer/geminiRouter.ts:505` / `:595` | `callCliDetailed()` / `callApiDetailed()` | `attempt < TRANSIENT_MAX_ATTEMPTS` | `bounded-by-fixed-step` | yes |
| R6 | `apps/worker/src/metaReviewer/copilotRouter.ts:229` | `callCopilotForMetaReview()`（各試行は `attemptCopilotCall()`） | `attempt <= MAX_ATTEMPTS` | `bounded-by-fixed-step` | yes |
| R7 | `apps/api/src/aiExplain/cheapAiClient.ts:434` | `requestText()` | 2 回を展開して書いたもので、ループではない | `bounded-by-fixed-step` | yes |
| R8 | `apps/api/src/ctoAi/specAnalyzer.ts:219` | `analyzeSpec()` | `SPEC_ANALYSIS_MAX_ATTEMPTS = 3` | `bounded-by-fixed-step` | yes |
| R9 | `apps/api/src/ctoAi/projectInitialization.ts:279` | `initializeApprovedProject()`（Roadmap 再生成 loop） | `ROADMAP_CONFLICT_RECOVERY_MAX_ATTEMPTS = 3` | `bounded-by-fixed-step` | yes |
| R10 | `apps/api/src/routes/tasks.ts:269` | `POST /:id/failure-explanation` の再読込 loop | `attempt < 2` | `bounded-by-fixed-step` | yes |
| R11 | `apps/api/src/storage/sqlite.ts:4441` / `:4507` | `designReviewRuns.claim()` / `recoverStaleRunningAtStartup()`（process をまたぐ design review run の再試行） | DB の `attempt_count >= maxAttempts`（`DESIGN_REVIEW_MAX_ATTEMPTS = 3`）で終端させる。永続状態の単調増加 | `bounded-by-monotone-state` | yes |
| R12 | `apps/api/src/supervision/delegationSupervisor.ts:338` | `diagnoseAndRecover()`（process をまたぐ supervised run の recovery） | `MAX_SUPERVISED_RUN_RECOVERY_ATTEMPTS = 3`（`sqlite.ts:450`） | `bounded-by-fixed-step` | yes |

### 3-3. continuation chain（Job・tick をまたぐ連鎖）

| # | 場所 | 関数 | 停止の根拠 | 分類 | mutation に耐えるか |
|---|---|---|---|---|---|
| C1 | `apps/api/src/designReview/repairPolicy.ts:633` | `decideRepairAction()`（repair → review → repair … の連鎖） | 1 generation あたり `MAX_REPAIR_ATTEMPTS = 3`。depth は T1 の lineage から復元する。walk が失敗したら escalate（fail-closed）。generation の reset は human authority（`human_resume` / `human_recovery`）に限られる | `bounded-by-fixed-step` | yes（T1 が耐え、walk の失敗が予算満額へ倒れないため） |
| C2 | `apps/api/src/pl/executionLoop.ts:119` / `adoptionStep.ts:105` / `remediationStep.ts:103` | PL の対象ごとの試行（tick をまたぐ） | `PL_MAX_ATTEMPTS_PER_TARGET = 2` / `PL_MAX_ADOPTION_ATTEMPTS = 2` / `PL_MAX_REMEDIATION_ATTEMPTS = 2` | `bounded-by-fixed-step` | yes |
| C3 | `apps/api/src/ctoAi/taskContinuation.ts:122` | `reconcileTaskContinuations()` | `findAll()` / `findPendingByProjectId()` の snapshot を 1 回なめるだけ | `bounded-by-monotone-state` | yes |
| C4 | `apps/api/src/designReview/queuedRunDispatch.ts:114` | `recoverAndRekickAtStartup()` | `findQueued()` の snapshot を 1 回なめる。`executeQueuedRun()` は module を分けたので自己再帰しない（同ファイル冒頭のコメント） | `bounded-by-monotone-state` | yes |

### 3-4. polling / reconcile loop（常駐。意図的に止まらない）

常駐ループは**止まらないことが仕様**である。ここで問うのは、**1 周が有限時間で終わり、次の周に進めるか**である。

| # | 場所 | 関数 | 1 周を抑えている根拠 | 分類 | mutation に耐えるか |
|---|---|---|---|---|---|
| P1 | `apps/worker/src/index.ts:910` | `pollJobs()`（`while (true)`） | 周の中で `fetchJson()`（`:645`）、`reconcileSupervisedRuns()` / `reconcileTaskContinuations()`（`:876` / `:890`）を await する。**どれもコードで timeout を指定していない**。効いているのは Node の global fetch（undici）の既定値だけ（headers 300 秒、body はチャンク間の無通信 300 秒）。`processQueuedWork()` は contained command の timeout を持つ | `bounded-by-external-timeout`（暗黙） | **fragile（D3）** |
| P2 | `apps/worker/src/index.ts:336` / `:1003` | `fetchQueuedJob()` / `reportAbortCleanupObservations()` | Project × Task × `fetchJson` の入れ子。反復は API 応答の配列の長さで抑えられるが、各 fetch には P1 と同じく timeout が無い | `bounded-by-external-timeout`（暗黙） | **fragile（D3）** |
| P3 | `apps/worker/src/outbox/outboxStore.ts:69` | `resendPending()` | SQLite の snapshot を 1 回なめる。各行は R1 | `bounded-by-monotone-state` | yes |
| P4 | `apps/worker/src/watchdog/watchdog.ts:21` | `startWatchdog()`（`while (true)`）→ `checkRunningJobs()` / `cleanupAlertedJobs()` | `fetchJson` / `postJson` / `patchJson`（`:230-264`）に timeout が無い（undici の既定値だけ）。`WATCHDOG_INTERVAL_MS = Number(env)` は有限かどうかを検査していない | `bounded-by-external-timeout`（暗黙） | **fragile（D3 / D5）** |
| P5 | `apps/api/src/index.ts:157` | `setInterval(runPlTick)` → `apps/api/src/pl/executionLoop.ts:1403` `runPlTick()` | `inFlight` latch で重複実行を防いでいる。tick 自体の終了は、await する呼び出し先（provider CLI の kill timer 等）の timeout に推移的に依存する。**latch そのものに期限は無い** | `bounded-by-external-timeout`（推移的） | **fragile（D2）** |
| P6 | `apps/api/src/supervision/reconcile.ts:57` | `reconcileSupervisedDelegations()` | `findActiveRuns()` の snapshot を 1 回なめる。recovery は R12 | `bounded-by-monotone-state` | yes |

### 3-5. その他の内側のループ

| # | 場所 | 関数 | 停止の根拠 | 分類 | mutation に耐えるか |
|---|---|---|---|---|---|
| I1 | `apps/worker/src/execution/runContainedCommand.ts:659` | `terminateAndCleanup()` の drain loop | wall clock `Date.now() - started >= drainLimitMs`（既定 `DEFAULT_DRAIN_MS = 10_000`） | `bounded-by-external-timeout` | **fragile（D5。低）**。`drainLimitMs` が NaN だと比較が常に false になり、上限が効かない。値は `options.drainMs` から来る |
| I2 | `apps/worker/src/jobLogger.ts:257` | `readJobLogFile()` の読込 loop | `read` が増え続ける＋ `chunk === 0` で break。上限は `stat.size`（`EVIDENCE_MAX_FILE_BYTES` 以下） | `bounded-by-monotone-state` | yes |
| I3 | `apps/api/src/ctoAi/contextManager.ts:159` | `readContainedFile()` の読込 loop | `length` が増え続ける。上限は `buffer.length`（`MAX_FILE_SIZE_BYTES + 1`）。`bytesRead === 0` で break | `bounded-by-monotone-state` | yes |

### 3-6. `Set` / `Map` を使うが、環検出ではないもの（誤読防止のため）

次の箇所は名前が `seen` だが、**重複除去・集計に使っているだけ**で、停止保証は担っていない。
いずれも有限の配列を 1 回なめるだけ（`bounded-by-monotone-state`）なので、mutation しても停止性は変わらない。

- `apps/api/src/pl/blockedTriage.ts:1223` `summarizeBlockedTriage()`（再発件数の集計）
- `apps/api/src/routes/knowledgeGraph.ts:467`（node id の重複除去）
- `apps/worker/src/metaReviewer/strategicReview.ts:1110` / `apps/worker/src/metaReviewer/runner.ts:425`（文字列の重複除去）
- `apps/api/src/principles/ledger.ts:537` / `apps/api/src/designReview/resumeActor.ts:211`（集合演算）

## 4. 観測済みの defect class（D0）: 歩数上限を外した直後に、意味側の cycle guard を壊すと停止保証がゼロになる

- **関数**: `walkRepairGeneration()`（`apps/api/src/designReview/repairPolicy.ts`）
- **何が起きたか（2026-09-22 実測）**: 固定の歩数上限 `MAX_ANCESTRY_STEPS = 64` を外した直後だった。lineage walk の停止は
  意味側の `seen` だけが支えていた。mutation harness の `G7-cycle-detection-removed` で
  `if (seen.has(cursor)) { … }` を `if (false) { … }` に置き換えると、環を含む fixture（例: Job A の stepKey が `repair:B:…`、B の stepKey が `repair:A:…`）で
  `cursor` が A↔B を永久に往復した。vitest worker は 1 コアを 100% 使ったまま RSS 約 1GB まで伸び、**82 分止まらなかった**。
  同じ mutated source を読んだ別枠の `vitest run src` も同時に hang した。
- **再現の手順（概略。いまの source では再現しない）**:
  1. `walkRepairGeneration()` の `for (let step = 0; step <= byId.size; step += 1)` を `for (;;)` に戻す（データ由来の上限を外す）
  2. `scripts/repairLineageMutationGuard.mjs` の `G7` と同じく、`seen.has(cursor)` の分岐を `if (false)` で無効化する
  3. `apps/api/src/designReview/repairPolicy.test.ts` の cycle fixture を単独で実行する → 終わらない（harness では `TIMEOUT` と記録される）
- **解消済み**: `repair-budget-counted-per-task-not-per-chain` で、データ由来の上限（`byId.size`）を**`seen` と独立したカウンタ**として入れた（T1）。
  いまは G7 を当てても walk は有限歩で `ok:false` を返し、テストは「cycle と報告されない」ことで普通に落ちる（KILLED）。
- **この class の一般形**: 「止まるかどうかを、意味側のガード 1 つだけが決めている」。
  あるいは「停止側の上限が、意味側ガードの状態から導かれている」。T2（D1）は後者の形である。
- **follow-up（D0 として残すもの）**: G7 は harness に残し続ける（TIMEOUT になったら停止保証が消えた合図）。
  新しい行動の追加は不要である。D1 の follow-up で、同じ当て方を T2 に広げる。

## 5. 欠陥と follow-up 案

各項目は **1 件ずつ別の Roadmap 項目として登録する**想定である（本 Task の allowedPaths は
`docs/project_memory/decisions` だけなので、`tasks/roadmap.md` への登録はしていない。§6 を参照）。

### D1（中）`resolveReviewedImplementationFrom()` の歩数上限が cycle guard 自身の状態から導かれている

- **場所**: `apps/api/src/designReview/repairPolicy.ts:286-307`
- **形**: 上限判定が `visited.size > maxHops` である。`visited` は環検出の集合そのものなので、
  `visited.add(sourceId)` を無効化する mutation（または集合を毎周新しく作り直す改変）で、**環検出と停止保証が同時に消える**。
  D0 と同じ class で、harness にこの関数の mutation は無い（`repairLineageMutationGuard.mjs` に `visited` / `maxHops` への言及が無い）。
- **起きた場合の影響**: `jobs.findById()` は同期 API（better-sqlite3）なので、`resume:` の環に入ると **API process の event loop 全体**が止まる。
  呼び出し元は `repairFlow.ts:516`（D1 repair）と `sqlite.ts:1592` 付近（git_commit 側の review→implement 解決）で、HTTP route・PL tick・reconcile のすべてが巻き込まれる。
  いまの production data で `resume:` に環ができる経路は確認していない（mutation と破損データでだけ起きる）。
- **follow-up**: 上限を `visited` と独立したカウンタにする（`for (let hop = 0; hop <= maxHops; hop += 1)`。T1 と同じ形）。
  そのうえで harness に「`visited.add(sourceId)` を無効化」と「`visited.has(sourceId)` を無効化」の 2 件を追加し、
  どちらも TIMEOUT ではなく KILLED になることを確かめる。

### D2（中）PL tick の `inFlight` latch に期限が無く、詰まっても誰にも見えない

- **場所**: `apps/api/src/pl/executionLoop.ts:338` / `:1403-1489`、`apps/api/src/index.ts:157-166`
- **形**: tick の終了は、await する呼び出し先が全部 timeout を持つことに推移的に依存している（今回、`handleTarget()` 配下の await を全件は確認していない）。
  1 件でも timeout の無い await が混ざると `inFlight` が true のまま残り、以後の tick はすべて `skipped_in_flight` で即座に返る。
  しかも `index.ts:161` が `skipped_in_flight` をログから除外しているので、**PL loop が黙って止まった状態**になる。
- **責務の広さ**: API process は生きているので health check は通る。止まるのは PL の自律処理（attention 処理・採用・Operator Request）全体である。
- **follow-up**: (a) `handleTarget()` / `runOperatorRequestStep()` / `maybeAdoptNext()` 配下の await を列挙し、それぞれの timeout の根拠を確かめる。これは read-only でできる。
  (b) latch を立てた時刻を持たせ、`skipped_in_flight` が tick 間隔の N 倍を超えて続いたら一度だけ warn と alert を出す（latch を強制解除はしない。解除すると二重実行になる）。
  `pl-review-process-supervision`（別 process の監視）とは重ならない。こちらは同じ process 内の latch である。

### D3（中）Worker と watchdog の常駐ループの 1 周が、timeout の無い fetch を await している

- **場所**: `apps/worker/src/index.ts:645`（`fetchJson`）、`:876` / `:890`（reconcile 2 本）、`apps/worker/src/watchdog/watchdog.ts:230-264`（`fetchJson` / `postJson` / `patchJson`）
- **形**: 同じファイルの `patchJobWithRetry()` や、`gateClient.ts` / `permissionGuard.ts` / notifier の各 adapter は AbortController の timeout を持つ。
  一方、上の fetch には timeout が無い。効いているのは undici の既定値だけで、body の既定値はチャンク間の無通信時間なので、少しずつ流し続ける応答なら上限が無い。
- **責務の広さ**: P1 が止まると Job intake・Outbox 再送・supervised run と continuation の reconcile がまとめて止まる。
  watchdog（P4）も同じ形なので、**止まったことを検知する側が同時に止まりうる**。
- **follow-up**: 既存の `patchJobWithRetry()` と同じ AbortController パターンを、これらの fetch に揃えて入れる（新しい機構は作らない）。
  テストは「resolve しない `fetchImpl` を注入しても 1 周が有限時間で返る」ことを見る。

### D4（低）`buildCircularDependencyIssues()` の `visited` を壊すと指数的に遅くなる

- **場所**: `apps/api/src/storage/roadmapTaskValidation.ts:152-169`
- **形**: `visiting` 側を壊すとスタック溢れの `RangeError` になる（hang ではなく失敗が見える）。`visited` 側だけを壊すと、
  diamond 状の依存（A→B, A→C, B→D, C→D … の繰り返し）で訪問回数が経路数ぶんに増える。有限だが、実質的には止まらないのと同じになる。
- **follow-up**: 優先度は低い。harness に `visited` の早期 return を無効化する mutation を足し、
  diamond を何段か重ねた fixture に test 側の timeout を付けて、TIMEOUT ではなく通常の failure になるかを測る。測れなければ記録だけで止める。

### D5（低）設定由来の上限が有限かどうかを検査していない

- **場所**: `apps/worker/src/execution/runContainedCommand.ts:285` / `:660`（`drainLimitMs = options.drainMs ?? DEFAULT_DRAIN_MS`）、`apps/worker/src/watchdog/watchdog.ts:14`（`WATCHDOG_INTERVAL_MS = Number(env)`）
- **形**: `drainMs` が NaN だと drain loop の wall clock 上限が永久に成立しない（I1）。`WATCHDOG_INTERVAL_MS` が NaN だと、`setTimeout` がほぼ遅延 0 で走り、
  watchdog が API を tight loop で叩き続ける（停止の問題ではなく暴走の問題）。
  対照的に、`readPollInterval()`（`index.ts:1100`）は `Number.isFinite` と正値を検査している。
- **follow-up**: `readPollInterval()` と同じ検査（有限・正値でなければ既定値）を、この 2 箇所の入口に揃える。

### 欠陥なしとした経路の根拠のまとめ

- **retry 系（R1-R12）**: すべて意味側と独立した定数上限、または永続化された attempt_count の単調増加で止まる。
- **snapshot をなめる reconcile（C3 / C4 / P3 / P6）**: 反復中に対象集合を伸ばさないので、データ由来の自然な上限（行数）がある。
- **filesystem / path の walk（T4-T6）**: 深さの固定上限、symlink を辿らないこと、path が単調に短くなることのどれかが、意味側ガードと独立に効いている。
  T4 の固定上限（深さ 12）は正当な入力を弾きうる閾値だが、Context Pack に入れるファイルの選択であって、正当性の判定ではない。弾いた場合の帰結は「深いファイルが Context に入らない」だけである。

## 6. 本 Task の範囲外で必要な対応

- Roadmap 項目の本文は「記録先は `tasks/roadmap.md`」「concrete defect は 1 件ずつ別項目として登録」としている。
  一方、本 Task の allowedPaths は `docs/project_memory/decisions` だけで、Roadmap の変更は明示的に対象外である。
  **D1-D5 の Roadmap 登録は行っていない。** PL 側で登録するか判断する必要がある。
- §1 のとおり、mutation の結果は推論であり、実行による証跡は無い。D1 / D4 の follow-up で harness に mutation を追加して実測するまでは、
  「推論上 fragile」として扱うこと。
- **未監査の範囲（PL loop 経路）**: P5（`runPlTick()`）と D2 は、`handleTarget()` / `runOperatorRequestStep()` / `maybeAdoptNext()`
  配下の await がすべて timeout を持つことを前提にしている。**この配下の await は全件を確認していない。**
  そのため、PL loop 経路では「全経路を列挙した」とは言えない。D2 の follow-up (a) で列挙するまでは未監査として扱い、本 Task が done になっても監査済みとは数えないこと。
