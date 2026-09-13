# M3 最終 Production E2E — PASS（2026-09-13）

**Project**: `ec7d5e1f-4c19-45b1-af30-78400b394880`「M3 Final Production E2E」
**結論**: **PASS。** 要件6項目すべてを Production で実測した。

---

## 1. 要件と実測

| 要件 | 結果 | 証拠 |
|---|---|---|
| 実アプリから新規 Project Start | ✅ | `POST /api/projects` → `PATCH status=running` |
| **Roadmap Generator 自身が 2 Task + dependency を生成** | ✅ | 下記 2 節 |
| Task の手動追加なし | ✅ | 両 Task とも `roadmap_task_key` を持つ（generator 生成） |
| CEO 操作は Approval のみ | ✅ | `audit_log` の当 Project 分は `approve` 1件のみ |
| **手動 resume なし** | ✅ | `resume:` Job **0件**、`repair:`/`retry:` Job **0件**、`/resume` リクエスト **0件** |
| Task 1 commit → continuation → Task 2 implement/review → Task 2 Approval Gate | ✅ | 下記 3 節 |

## 2. Generator が生成した 2 Task

```
cc440183  done     roadmap_active=1  key=task-001  phase=1  deps=[]            allowed=["checks.js"]
343a2437  pending  roadmap_active=1  key=task-002  phase=2  deps=[cc440183]    allowed=["test.js"]
```

Task 1「package.json検証関数を追加」、Task 2「package.json検証を実行フローへ追加」。
`allowedPaths` はどちらもリポジトリ相対で、依存は Generator が張った。

## 3. CEO 承認後のチェーン（すべて backend 駆動）

CEO が `approval-20260912-1958c3e1` を Mobile から承認。以降、人手の介入はゼロ。

```
07:30:32 JST  Job aa0d9d93 (git_commit) を実行します        ← Task 1
07:30:33      Shadow Commit Gate: decision=ALLOW → call_consume
07:30:35      Job aa0d9d93: success                          ← commit 8dfaf33 着地・Task 1 done
07:30:34.093  task_continuation 7ae7d9e0 作成
07:30:51.383  continuation completed / next_task_id=343a2437 ← backend continuation
07:30:58      Job 76a36cc6 (test) を実行します               ← Task 2 initial-implement
07:31:44      Job 76a36cc6: success
07:31:49      Job 546cda4b (git_status) を実行します          ← Task 2 review
07:32:07      Job 546cda4b: success
07:32:13      Job b97165ae (git_commit) を実行します          ← Task 2 git_commit
07:32:13      Job b97165ae: blocked                           ← Task 2 Approval Gate 到達
```

**Task 1 commit 成功から Task 2 Approval Gate 到達まで 101 秒。** その間の client 操作は 0。

新しい Approval Request `approval-20260912-cf65df28` が `WAITING_FOR_USER` で発行され、
`GET /api/approval-requests/waiting` に出る = Mobile から次の承認ができる状態で停止した。
これが M3 の終端条件である。

## 4. 手動 resume が無かったことの証拠

- 当 Project の Job に `workflow_step_key LIKE 'resume:%'` は **0件**
- `repair:` / `retry:` も **0件**（= 失敗からの復旧も起きていない。一発で通った）
- API ログ（直近6時間）に `/resume` を含むリクエストは **0件**
- `audit_log` の当 Project 分は `approve`（`approval-20260912-1958c3e1`）のみ

## 5. この run に至るまでに修正した MVP-BLOCKING

M3 を成立させるために、直前の run で発覚した2件を修正・deploy した。

1. **`approval-expired-waiting-blocks-resume`**（PR #156）
   期限切れ `WAITING_FOR_USER` が `findWaiting()` から除外されて Mobile に出ず、かつ
   `resumeBlockedTask()` が status だけを見て resume を拒否するため、Task がスマホから復旧不能だった。

2. **`done-task-stale-blocked-job-owns-workspace`**（PR #158）
   resume 経路が残す旧 blocked 行が Task 完了後も workspace 所有権を握り続け、
   解放手段が archive / pause しか無かった。独立レビュー6 round を経て、解放判定を
   durable state ではなく **admission と同じ clean 定義での workspace 実観測**に置いた。

## 6. 位置づけ

- 2026-09-12〜13 の前 run（`6d1173f6`）は **PASS に数えない**。Task 2 を手動追加していたため。
  記録: `approval_to_commit_happy_path_regression.md`。
- 本 run の PASS をもって `TEMP_MVP_COMPLETION_POLICY` cleanup へ進む
  （`specs/10_mvp_scope.md` 12章の手順に従う）。
