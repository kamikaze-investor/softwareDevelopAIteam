# Alignment Violations ログ

## [AV-001] scripts/metaReview.ts — Control Layer 迂回

- **日時**: 2026-06-19
- **重大度**: critical
- **カテゴリ**: approval_bypass / philosophy_drift
- **検出者**: ユーザー（CEO）レビュー

### 問題の説明

`apps/worker/scripts/metaReview.ts` を作成し、Meta Review を Gemini に直接投げる実装を行った。

`apps/worker/src/metaReviewer/runner.ts` が `CONTROL_ROOT = '/workspace/control'` とハードコードされており
Windows ローカルで動作しないことへの回避策として作成されたが、これは正規の Runner / Audit Gate / Permission Guard を**完全に迂回**する実装である。

### 何が問題か

| 正規経路 | 実装した経路 |
|---|---|
| `runner.ts` → Audit Gate → Permission Guard → Gemini | `scripts/metaReview.ts` → Gemini（直接） |

Control Layer が存在する理由（承認フロー・役割分担の強制）を無効化している。ルール遵守ではなく実質的な迂回。

### 根本原因

`runner.ts` 内の `CONTROL_ROOT` がハードコードされており、Windows ローカル環境で動作しない。
→ これは **Control Repository 側の修正課題**であり、Target Repo 側で同等処理を複製して解決するものではない。

### 対処

- [x] Alignment Violation として記録（本ファイル）
- [ ] `scripts/metaReview.ts` を削除（CEO承認後）
- [ ] `scripts/postTestHook.ps1` の metaReview 呼び出し部分を無効化（CEO承認後）
- [x] Control Repository の `runner.ts` 修正（CEO承認・実装済み 2026-06-19）
  - `CONTROL_ROOT = process.env.CONTROL_ROOT ?? '/workspace/control'` に変更
  - `.env` に `CONTROL_ROOT=C:\Users\honka\softwareDevelopAIteam` を追加することで正式経路が動作可能

### ステータス

**解決済み（Control Layer 修正完了）**

残作業:
- [x] `scripts/metaReview.ts` の削除（2026-06-19 完了）
- [ ] `postTestHook.ps1` のクリーンアップ（Meta Review 自動実行フック設計を正式経路で再設計する際に対処）

---

## [AV-002] 共有worktreeから無関係commitがPR #90へ混入

- **日時**: 2026-09-04
- **重大度**: medium
- **カテゴリ**: process_integrity / review_bypass
- **検出者**: Claude（PR #90 のproduction deploy前、`git diff --name-only HEAD origin/master` の差分に想定外の `tasks/roadmap.md` を発見）

### 何が起きたか

`b2e48d3 docs(roadmap): add low-priority PL Console (vendor-neutral PL UI) item`（`tasks/roadmap.md` +63行、
PL Console 関連の roadmap item 4件を `state=deferred` で登録）が、agy model 互換性修正のために作成された
ブランチ `fix/agy-cli-model-effort-drift` 上に作成され、squash merge によって PR #90 の一部として master へ入った。

reflog 上、このcommitは 17:56:33 に**メインworktree**（`C:/Users/honka/softwareDevelopAIteam`）で作成されている。
同時刻、当該ブランチをcheckoutしたまま別の作業（テスト実行）が進行しており、並行して動作していた別セッションが
同じ作業ディレクトリでcommitしたものと考えられる（同時間帯に別セッションが PR #91 を進行させていた）。
author/committer はリポジトリ共通の git user のため、どのセッションかはcommit metadataからは特定できない。

### 何が問題か

内容は docs のみ・全項目 `state=deferred`・runtime影響ゼロだが、**review-of-record を素通りした**点が問題である。

| 本来 | 実際 |
|---|---|
| 変更はそれ自体のPR説明・独立レビューの対象になる | PR #90 の説明に一切記載がなく、Codex独立レビューにも diff として提示していない |

PR #90 の説明文・独立レビュー依頼はいずれも agy model 互換性修正のみを対象としており、この docs 変更は
「誰もレビューしていないが master に入っている」状態になった。内容の是非とは無関係に、レビュー記録の
正確性が壊れている。

### 根本原因

複数のAIセッションが**同一のメイン作業ディレクトリを共有**しており、あるセッションがブランチをcheckoutして
作業している最中に、別セッションが同じHEADへcommitできてしまう。`.claude/worktrees/` の仕組みは存在するが、
すべてのセッションがそれを使っているわけではない。

### 対処

- [x] read-only調査: `b2e48d3` を含む他のbranch/PRは存在しない（`git branch -a --contains`、`gh pr list`・`gh search prs` で "PL Console"/"LibreChat" は 0件）。他worktreeにも当該変更の未コミット作業はなく、進行中作業を破壊しないことを確認済み
- [x] 正式なreview recordが存在しないため、当該docs変更を master から revert（PR #92、commit `6e0609f`）
- [x] 同内容を独立したPRとして review-of-record に載せ直した（PR #93、commit `df34750`。内容は原文のまま、レビュー経路のみ変更）
- [x] process-integrity incident として本ファイルへ記録（CEO指示、2026-09-04）

### 再発防止（未着手・別途検討）

commit前に「そのcommitが自分の変更範囲に収まっているか」を確認する運用、またはセッションごとのworktree分離の徹底。
本項目では仕組みの新設は行わない。

### ステータス

対処済み（PR #92 で revert・記録、PR #93 で正式に re-land）。再発防止のみ未着手

---

## [AV-003] deploy対象serviceとrestart順序を「前回のdeploy手順」から推定していた（near-miss）

- **日時**: 2026-09-07
- **重大度**: medium（near-miss。production incidentには至っていない）
- **カテゴリ**: deploy_safety / process_integrity
- **検出者**: Claude（PR-C（PR #98）のproduction deploy中、Worker restart直前の確認で検出）

### 何が起きたか

直前のdeploy（PR #89、gemini `--effort`）がWorker側のみのdeltaだったため、その際の
「**Worker-only restart**」手順をPR-Cにもそのまま適用しかけた。

しかしPR-Cのdeltaは以下を**同時に**含んでいた:

| 変更 | 実体 |
|---|---|
| API request schema | `UpdateJobBody` / `FailIfRunningJobBody` に `workspaceBaseline`・quarantine系フィールドを追加 |
| shared contract | `packages/shared/src/types/job.ts` に `JobWorkspaceBaseline` 等を追加 |
| DB migration | `jobs.workspace_baseline TEXT`（additive） |
| Worker payload | `queued -> running` claim のPATCHに `workspaceBaseline` を同梱 |

Workerだけを先にrestartしていた場合の実際の挙動:

1. 新Workerが `PATCH /api/jobs/:id` に `workspaceBaseline` を載せて送る
2. 稼働中の**旧API**の `UpdateJobBody` は `.strict()` であり `workspaceBaseline` を知らない
3. strict zodは未知キーを**拒否**するため **400 Validation failed**
4. `confirmRunningTransition` が false を返し、**すべてのJob claimがfail closed**
5. 設計上fail-closedなので、大きなエラーではなく「静かにJobが動かなくなる」形で現れる

さらに `runMigrations()`（`apps/api/src/storage/sqlite.ts`）はstorage生成時、すなわち
**API起動時**に実行されるため、Worker-only restartでは `workspace_baseline` カラム自体が
追加されない（実測: restart前は26カラム、API restart後に27カラム）。

deploy前確認で検出したためproductionへの影響は無く、実際のdeployは
**API restart → migration確認 → health確認 → Worker restart** の順で完了した（CEO承認済み）。

### 何が問題か

「前回のdeploy手順を再利用したこと」そのものではない。

**root cause**: 今回のdeltaが**どのruntime / schema / protocol boundaryを変更しているか**を見て、
restart対象serviceとrestart順序を決定する、という判断ステップが既存のdeploy手順に不足していた。
そのため「前回はWorkerだけ再起動した」という**先例**が、今回のdeltaの実態を確認しないまま
そのまま適用されようとした。

deployの正しさは「どのファイルを触ったか」ではなく「**どのruntimeが、どの契約で、いつ入れ替わるか**」で
決まる。API↔Worker間はversion skewが起こり得る2プロセス構成であり、片側だけを進めると
protocol互換性が壊れる。

### 改善方向（未着手・記録のみ）

**新しいdeploy gateを追加する前に、既存のdeploy workflow / prompt / checklistの改善で解決できるかを
優先する。** 最低限、deploy前に当該deltaから次を判定すること:

- API runtime変更の有無
- Worker runtime変更の有無
- shared contract（`packages/shared`）変更の有無
- DB migrationの有無
- API↔Worker protocol互換性（skew時にどちらが先だと壊れるか）
- restart対象service
- restart順序
- migration適用タイミング（本system ではAPI起動時）

**やらないこと（明記）**: `apps/api/** を触ったら必ずAPI restart` のような
**path-basedの固定ルールにはしない**。目的はパスの機械的判定ではなく、
「変更内容から必要なruntime restart / migration / deploy orderを導出する」ことである。
path-based ruleは、pathが変わっていなくても契約が変わる場合（shared type経由など）を取りこぼし、
逆に無害な変更で不要なrestartを強制する。

関連する既存項目: `tasks/roadmap.md`「VPS常駐運用化」節の「正式Production起動方式の確定」
（起動**方式**の確定であり、本項目の「restart**対象と順序**の導出」とは別責務）。同節へ統合するか
独立させるかは、改善に着手する時点で判断する。**本項目では仕組みの新設は行わない。**

### ステータス

**記録のみ**（near-miss、production影響なし）。改善は未着手。P1 Phase 2（async per-job containment）
とは分離して扱う。
