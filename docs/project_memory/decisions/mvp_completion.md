# MVP 完成記録（2026-09-13）

**判定根拠**: `specs/10_mvp_scope.md` 12章「MVP Exit Criteria」のみ
（roadmap の `state=planned` Finding は Exit gate ではなく延期 backlog。判定方法は
`tasks/roadmap.md` の「MVP判定（既存 `specs/10_mvp_scope.md` のみで判定）」に従う）。

---

## 1. Exit Criteria の充足

| Exit Criteria | 実測証拠 |
|---|---|
| 仕様書からプロジェクト生成できる | M3（Project `ec7d5e1f`）: goal 文だけを与えて `POST /api/projects` → `PATCH status=running` で Project が立ち上がり、Roadmap が生成された |
| AIがタスク生成できる | 同 M3: **Roadmap Generator 自身が** `task-001`（phase 1 / `allowedPaths=["checks.js"]`）と `task-002`（phase 2 / `deps=[task-001]` / `allowedPaths=["test.js"]`）を生成。手動 Task 追加は無い |
| AIが実装できる | 同 M3: Task 1・Task 2 の initial-implement がいずれも success。Task 1 は review を通り commit `8dfaf33` が着地 |
| Dashboardで状況確認できる | Mobile の Task 一覧・詳細（Job 履歴・承認履歴）、承認画面、追加指示して再開が実装済み（`mobile-task-job-detail-ui` / `mobile-approval-gate-ui` / `mobile-task-create` / `mobile-task-resume-ui` いずれも done）。本セッションでは承認画面が読む `GET /api/approval-requests/waiting` が待機中の承認を返すことを Production で実測し、CEO が実際に Mobile から承認して commit が着地した |
| Goal変更以外で開発が止まらない | 同 M3: CEO 操作は承認 **1回のみ**。手動 resume **0**（`resume:`/`repair:`/`retry:` Job 0件、`/resume` リクエスト 0件）。Task 1 commit 成功から Task 2 Approval Gate 到達まで **101 秒**を backend 駆動で通過 |
| TEMP_MVP_COMPLETION_POLICY cleanup | 完了（PR #160）。手順は `specs/10_mvp_scope.md` 12章、実施記録は同章 |

M3 の詳細: `docs/project_memory/decisions/m3_final_production_e2e.md`

## 2. 最終 CI

権威ある実行は PR #160（`01bfbc8`）の GitHub Actions。
CI は `pnpm -r typecheck` と `pnpm -r test` を実行する（`.github/workflows/ci.yml`）。

- **Typecheck & Test: success** — https://github.com/kamikaze-investor/softwareDevelopAIteam/actions/runs/34723875886
- Meta Reviewer AI (Gemini): pass

ローカル（Windows）での内訳:

| package | 結果 |
|---|---|
| `packages/shared` | 8 files passed |
| `apps/mobile` | 1 file passed |
| `apps/api` | 1215 passed / 7 skipped / **0 failed** |
| `apps/worker` | 1288 passed / 13 skipped / 3 failed |

`apps/worker` の 3 件は **Windows ローカル環境固有の失敗**で、リポジトリの欠陥ではない。
`revertBlockedJobChanges` ×2 は `expected 'baseline\r\n' to be 'baseline\n'` という
**CRLF 由来**、`delegation watchdog shell flow` ×1 は shell 依存。CI は同じ
`pnpm -r test` を Ubuntu で実行して **success** しており、master 上でも同じ 3 件が
ローカルでのみ再現する。

## 3. MVP 完成までの最終盤で修正した MVP-BLOCKING

| ID | 内容 | PR |
|---|---|---|
| `review-failure-escalation` | review が structured result を返せない時に Task を quarantine させず blocked へ escalate | #150 |
| `workspace-ownership-content-identity`（M1-a） | blocked Task の dirty が継承可能な間は owner を維持し、他 Task が共有 worktree で死なないようにする | #154 |
| `approval-expired-waiting-blocks-resume` | 期限切れ `WAITING_FOR_USER` が Mobile からも resume からも触れず、Task が復旧不能になる | #156 |
| `done-task-stale-blocked-job-owns-workspace` | commit 成功後も滞留 blocked 行が workspace 所有権を握り、archive/pause でしか解放できない | #158 |

後半2件は M3 の準備中に Production で実際に踏んで発覚した。
#158 は独立レビュー **6 round** を要し、durable な自己申告（`task.status` /
`job.commitHash` / `createdAt`）はいずれも「次の Task を始められる」証明にならないと判明したため、
最終的に **admission（`computeWorkspaceBaseline()`）と同じ clean 定義での workspace 実観測**へ
判定を移した。

## 4. 受容済みの既知制約（MVP 完成は「既知問題ゼロ」を意味しない）

- `workspace-ownership-content-identity`: fallback ownership は content identity を証明しない。
  **MVP 運用境界として、active / blocked な target workspace を人間が直接編集しない**（CEO 受容）。
- `implement-acceptance-criteria-not-mechanically-verified`: implement Job は
  `acceptanceCriteria` を機械的に検証しない。最後の砦は review。高優先度・MVP後。
- `quarantined-dirty-task-generic-recovery`: quarantine 済みで dirty な Task の汎用復旧手段が無い。
  発生時は人手介入を許容（CEO 判断）。
- `orphan-dirty-workspace-no-owner`（M1-b）: どの Task にも帰属できない dirty の復旧手段が無い。
- その他の `state=planned` Finding は `tasks/roadmap.md` に残っている延期 backlog である。

これらは Exit Criteria を構成しないため MVP 完成の判定には用いない。
削除せず既存 backlog に残し、MVP 後に順次扱う。

## 5. 記録しないこと

一時ポリシー `TEMP_MVP_COMPLETION_POLICY` の内容は Design Philosophy・一般開発原則へ
転記していない（`specs/10_mvp_scope.md` 12章が明示的に禁じている）。
MVP 後に残すべき原則がある場合は、一時ポリシーとは切り離して別途判断する。
