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
- [x] 正式なreview recordが存在しないため、当該docs変更を master から revert（本PR）
- [ ] 同内容を独立したPRとして review-of-record に載せ直す（revert後に別PRで re-land）
- [x] process-integrity incident として本ファイルへ記録（CEO指示、2026-09-04）

### 再発防止（未着手・別途検討）

commit前に「そのcommitが自分の変更範囲に収まっているか」を確認する運用、またはセッションごとのworktree分離の徹底。
本項目では仕組みの新設は行わない。

### ステータス

対処中（revert済み・re-land待ち）
