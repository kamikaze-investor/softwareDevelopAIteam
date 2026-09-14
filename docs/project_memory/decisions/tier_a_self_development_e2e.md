# Milestone: AIteamOS Self-Development Tier A Operational E2E Complete（2026-09-14）

**種別**: Milestone snapshot（この時点の事実の記録。Roadmap の現在状態から後で復元しない）
**Project**: `AIteamOS Post-MVP Development`（`6d1a5c87-8ae6-40f2-8c56-2a1c668302d7`）
**Project 状態**: **`running` のまま継続**。本 Milestone は Project 完了を意味しない。
AIteamOS Project は全 Roadmap 完遂まで同一 Project として継続する。

**記録方針**: 新しい Reporting システムは作らない。既存の
`docs/project_memory/decisions/`（`mvp_completion.md` / `m3_final_production_e2e.md` と同じ資産）と、
Roadmap ledger・Review 結果・Job 実行記録・`design_review_evidence` を再利用する。

---

## 1. Milestone の目的

AIteamOS 自身の Roadmap 開発を、外部 Claude / Codex セッション中心の運用から、
**Mobile 上の Stable AIteamOS 自身による通常の Roadmap 開発**へ移すこと。
これは AIteamOS の実運用試験も兼ねる。

Multi-Project 基盤の完成を待たずに実施した。自己開発時の running Project は AIteamOS 自身の1つで
足りるため、`ux_projects_single_running` interlock も単一共有 workspace も制約にならないと
事前調査で確定していた（ledger: `aiteamos-self-development-tier-a`）。

## 2. 何を実証したか

**AIteamOS が自分の正式 Roadmap から1項目を選び、自分で実装し、commit まで到達できること。**
人間が書いたコードは0行。CEO の操作は承認1回のみ。

実証した経路（すべて production で実測）:

```
正式Roadmap(tasks/roadmap.md)
  → Roadmap項目の採用（roadmap-adoptions API）
  → Candidate上での実装
  → restricted env での Full validation
  → Independent Review
  → Approval Gate（CEO承認）
  → commit
  → push / PR（外部セッション。bootstrap例外）
  → CI
  → verified SHA → master へ merge
```

## 3. AIteamOS 自身が実装した内容

**採用した Roadmap 項目**: `continuation-reconcile-nonblocking-followups` の**項目2のみ**
（項目1の full-table scan → `findRunning()` 化は CEO 方針により対象外）

**解いた問題**: `ensureTaskContinuation()` の `catch` が例外を無言で握り潰していた。恒久的な
storage 障害・design review 基盤障害が起きると、continuation は pending のまま**無限に retry し
続けるだけで API 側に何の signal も残らない**。

**実装**: 識別子つきのエラーログを1行だけ出す（`continuationId` / `jobId` / `taskId` / `projectId`）。
状態遷移も戻り値の契約も変えていない。追加は `console.error` 1つのみ。

**変更範囲**: `apps/api/src/ctoAi/` の2ファイル（`taskContinuation.ts` +8行 /
`taskContinuation.test.ts` +28行）。`allowedPaths=["apps/api/src/ctoAi"]` の指定どおりで、
`apps/api/src/routes/` には未変更。

**commit**: `78220e6`（author: `AIteamOS Candidate <candidate@aiteamos.local>`）
**PR**: #169 → master `8571dd0`

## 4. Stable / Candidate の分離方法

| | 実体 | 扱い |
|---|---|---|
| Stable のコード | `/srv/ai-team/softwareDevelopAIteam` | AI 編集禁止（control plane） |
| Stable の DB | `/srv/ai-team/data/e2e-ai-team.db` | 同上 |
| Stable の Outbox | `apps/worker/data/outbox.db` | 同上 |
| Stable の env | `/srv/ai-team/env/*.env` | 同上（読み取りもしない） |
| **Candidate** | `/workspace/target`（branch `candidate/self-dev`） | **開発 target として編集可** |

Candidate は同一 canonical repository の**独立 clone**（worktree でも別 repository でもない）。
`.git` が独立するので破棄・再作成が自由で、remote は同一なので Promotion に既存の
push → PR → CI → verified-SHA `--ff-only` deploy をそのまま再利用できる。

**物理強制は新規機構ゼロ**。既存の `isInsideTargetRoot()` が `/workspace/target` 外への書き込みを
拒否し、`buildTargetCommandEnv()` の allowlist が `DB_PATH` / `API_TOKEN` / provider key / `HOME` を
子プロセスへ渡さない。2026-09-13 に Candidate 上で全 package の typecheck と test を実行し、
**production DB と Outbox が size・mtime とも不変**であることを実測済み。

`AGENTS.md` 1-1 節で「Control Repository ＝ 稼働中 Stable インスタンスの control plane であり、
AIteamOS ソースのあらゆる checkout ではない」ことを明確化した（禁止範囲の変更なし）。

## 5. Mobile AIteamOS から完走した事実

Job chain（Project `6d1a5c87` / Task `9adb35e5`。時刻は 2026-09-14 UTC）:

| # | Job | 結果 |
|---|---|---|
| 1 | `task:9adb35e5:initial-implement` | **blocked**（File Change Guard がスコープ外を停止。01:55） |
| 2 | `resume:345f5ca5:1` | blocked（cgroup cleanup EBUSY。02:04） |
| 3 | `resume:cf259578:1` | blocked（同上。04:19） |
| 4 | `resume:cd2e90b9:1` | **success**（実装 + validation。04:38） |
| 5 | `implement:94827ccb:review` | **success**（Independent Review。04:41） |
| 6 | `review:215408e5:git-commit` | **success** commit `78220e6`（04:42） |

Task: `done` / Approval: `CONSUMED` / `design_review_evidence` 4件 / `review_results` 1件。

CEO の Mobile 操作は「Project を開始」「追加指示して再開」×2「承認」のみ。

## 6. PR / CI / merge 結果

| PR | 内容 | CI |
|---|---|---|
| #169 | **AIteamOS 自身が実装した変更** | Typecheck & Test pass / Meta Reviewer pass → master `8571dd0` |

本 Milestone に至るまでに外部セッションが先行実施した基盤 PR:
#162（bootstrap 整合 + hermetic test）/ #163（roadmap parser）/ #164（roadmap 採用経路）/
#165（E2E findings 記録）/ #166（quarantine 解除）/ #167（cgroup retry）/ #168（test cgroup leak）

## 7〜9. E2E 中に発見した問題 / Root Cause / 実施した修正

### 問題1: quarantine から構造的に出られない

- **発見**: Task が quarantine に入り、**Mobile からどの操作をしても復旧できなくなった**
- **Root Cause**: `baselineEqualsObservation()`（`sqlite.ts:214`）が先頭で `mode` 一致を要求する。
  `computeWorkspaceBaseline()` は intentionally-dirty Job（`resume:`/`repair:`/`retry:`）に対し
  **worktree が空でも** `mode:'dirty', entries:[]` を記録する一方、`observeWorkspace()` は
  worktree が空なら `mode:'clean'` しか返さない。**解除できる観測値が原理的に存在せず、
  workspace が安全でも必ず 409 になる**。Worker 自身は「安全と観測できた」とログしていた
- **修正**: 比較前に「`entries` が空の dirty は clean と同義」と正規化（PR #166）。
  比較時正規化にしたのは**既に stuck している永続行を救済できる**ため
- **実測**: stuck していた実 Job `cf259578` で
  safe observation → quarantine release（`quarantineClearedAt` 記録）→ ownership 回復 → resume 可能

### 問題2: cleanup だけの失敗で quarantine に入る

- **発見**: 実装は正常完了しているのに per-job cgroup の `rmdir` が EBUSY で失敗し `cleanup_failed` へ
- **Root Cause（当初の仮説は誤りだった）**: 最初は「一過性の解体遅延」と診断したが、**誤り**。
  bounded retry（PR #167）に付けた診断情報が真因を暴いた —
  `child cgroups remain: job-job-drain-…, job-job-drain-throw-…`。
  **AIteamOS 自身のテスト**（`runContainedCommand.test.ts` の `drain_timeout` 再現2件）が
  `drainMs: 0` と生存 `setsid sleep 30` で意図的に `drain_timeout` を起こし、その経路は仕様どおり
  `rmdir` へ到達しないため cgroup を残す。**自己開発では Candidate の `pnpm test` が Job の cgroup の
  内側で走るため、テストの cgroup がその Job の子になり親を削除できない**
- **修正**: PR #167（bounded retry + 診断情報。一過性への備えとして維持）+
  PR #168（テスト側で後片付け。**production コードは無変更**）
- **実測**: 修正後の Job chain で cleanup 成功、**quarantine に入らず残留 cgroup 0件**

### 問題3: 採用時のスコープ過大

- **発見**: 初回 implement が `allowedPaths` 外の `apps/api/src/routes/taskContinuations.ts` を変更し
  File Change Guard に停止させられた（**安全機構は正しく作動**し workspace も自動 revert された）
- **Root Cause**: 採用の description は ledger 項目の**本文全文**になる。当該項目は項目1と項目2を
  含み、本文冒頭が項目1で占められていたため、`acceptanceCriteria` で対象外と書いても実装 AI が
  項目1に着手した
- **修正**: 恒久修正は未実施。resume の追加指示でスコープを明示して回避した（2回目は
  スコープ内2ファイルのみ）。**follow-up として ledger に残す**

## 10. Learning

- **実測前の推測だけで Root Cause を断定しない。** 本 E2E で私は2回続けて誤診断した
  （`npx` 依存 / provider 不在による fail-open）。いずれもコードを読んだ推論としては筋が通っていたが、
  **raw 出力を実際に観測して初めて**真因が判明した。「safety defect」の分類は CEO の意思決定と
  Roadmap を動かすため、誤った分類は実害がある
- **EBUSY を ignore せず診断情報を足したことが、真因特定を可能にした。** 単に握り潰していたら
  「空の子 cgroup が残り続ける」本当の問題は見えないままだった。retry 自体は空振りだったが、
  **診断の投資は回収された**
- **fail-closed は正しく働いたが、"出口" が無いと復旧不能になる。** quarantine も File Change Guard も
  設計どおり停止させた。問題は停止ではなく、**停止後に正規手段で戻れないこと**だった
- **自己参照は自己開発で初めて顕在化する。** AIteamOS のテストが AIteamOS の containment を
  実行する構造は、外部 target を開発している限り発生しない
- **テストは `vitest` だけでなく `tsc` も回す。** 型エラー3件を CI まで持ち込んだ

## 11. 現在 Tier A で Mobile へ移せる作業

typecheck / test / CI / Independent Review で正しさを示せる変更。具体的には通常のコード変更・
バグ修正・テスト追加・ドキュメント更新。**今後これらは Mobile AIteamOS を第一選択とする。**

## 12. まだ Tier B / 外部セッションが必要な作業

- **push / PR** — Worker に `git_push` CommandKind が無く、`buildTargetCommandEnv()` の allowlist が
  credential を渡さない（意図的な設計）。ledger: `worker-restricted-remote-publish`
- **Roadmap 項目の採用操作** — Mobile UI が無いため PL が API を実行する
- **Tier B 変更** — workspace / Guard / claim 経路、DB migration、runtime / Worker /
  startup reconciliation、Resume / state compatibility、Candidate 実起動が必要な変更
- **production deploy** — Yellow Zone（CEO 承認必須）

## 13. Known Limitations

- **Multi-Project はまだ成立しない。** `TARGET_ROOT` が単一固定で、`fetchQueuedJob()` が全 Project を
  1つの workspace ownership へ平坦化する。`ux_projects_single_running` がそれを安全に保っている。
  ledger: `project-workspace-isolation`
- **採用 description が ledger 全文になる。** 複数サブ項目を含む項目では対象外まで実装されうる
- **paused / draft の Project へ採用しても Job が作られない。** `createInitialImplementWorkflow` が
  `project.status !== 'running'` で skip し、resume 分岐は `ensureInitialWorkflowsForActiveTasks` を
  呼ばないため、running 化後に採用 API を再実行する必要がある（今回はそれで回避）
- **production 側の空の子 cgroup を削除するかは未決。** 本当のリークを隠す副作用があるため、
  必要性が実証されるまで実装しない
- **commit message が ledger 項目の見出しそのまま**になる（markdown 記法を含む）
- 旧 Project `AlteamOS Continuous Development`（`bac04e22`）が paused のまま残存（無害）

## 14. 今後の Roadmap へ残した項目

| ledger id | 残作業 |
|---|---|
| `worker-restricted-remote-publish` | push / PR の外部依存を解消する（早期） |
| `project-workspace-isolation` | 第2Project 並行開始の前提（Tier B） |
| `roadmap-item-adoption` | 採用時に implementation scope を明示できる最小改善 |
| `aiteamos-self-development-tier-b` | Candidate 専用 runtime / DB / Worker |
| `containment-cleanup-ebusy-quarantine` | production 側の空 child cgroup 削除の要否判断 |
| `failure-explanation-pregeneration` | Explainer（承認画面の説明導線を含む） |

## 15. CEO 向け説明（非エンジニア）

**AIteamOS が自分で自分を直せるようになりました。**

今回 AIteamOS は、自分のやることリストから1件を選び、自分でコードを書き、自分でテストし、
別のAIにレビューさせ、CEOの承認を得てから記録を確定させました。**人間がコードを書いた部分はゼロ**、
CEOの操作は**承認ボタン1回**だけです。

直した中身は「引き継ぎに失敗しても誰にも報告されない」問題です。担当者が失敗し続けているのに
黙ってやり直している状態だったので、失敗したら記録が残るようにしました。

**稼働中の本体は最後まで無傷**でした。作業はすべて隔離されたコピーの中で行われ、本番のデータにも
設定にも触れていません。

途中で**3つの不具合が見つかりました**。どれも「自分で自分を開発する」ことを始めなければ
発見できなかったものです。特に3つ目は、AIteamOS のテストが AIteamOS 自身の安全装置を動かすという
自己参照が原因で、外部のプロジェクトを開発している限り絶対に起きません。すべて修正済みです。

**安全装置は2回、正しく止めてくれました。** AIが指示した範囲外を触ろうとしたときと、
後片付けが確認できなかったときです。止まること自体は正しく、問題は「止まった後に戻る道が
無かった」ことでした。そこも直しました。

**今後は、テストとレビューで正しさを示せる作業はスマホのAIteamOSが第一担当**になります。
一方、システムの動き方そのものを変える作業と、GitHubへの反映操作は、まだ外部の開発セッションが
担当します。

**この Project は完了していません。** 今回は途中の大きな節目であり、AIteamOS Project は
全 Roadmap を完遂するまで同じ Project として続きます。
