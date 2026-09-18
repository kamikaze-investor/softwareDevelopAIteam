# Human Recovery — 止まった Task を人が安全に再開する手順

**Importance Level: 1**
**Status: active**

---

## この文書の範囲

**AI/自動経路がどれも届かなくなった Task を、CEO が明示操作で既存ループへ戻す手順**である。

`tasks/roadmap.md` の `task-design-review-conflict-has-no-recovery-route` が
「復旧手順が文書化されていない」として残していた未了分がこれに当たる。

**Human Recovery は実装をしない。** Job を作らず、Review を承認せず、Gate を1つも緩めない。
やるのは「止まっている Task を、既存の自動経路が再び見える位置へ戻す」ことだけである。

---

## 権限（CEO 決定・2026-09-18）

> Human Recovery には up-front CEO Approval Gate を課さない。
> 認証済み CEO による明示的な Recovery 操作そのものを human authorization とする。
> Human Recovery は Job 0 件の blocked Task を既存ループへ再投入するだけに限定し、
> Implementation Job を直接生成せず、fresh Design Review および既存の全下流 Gate を必須とする。
> AI/PL による自律呼び出しにはこの例外を適用しない。操作は audit 記録し、試行回数を有界化する。

`abort_task` と違い**事前の ApprovalRequest を要求しない**。理由は `resume_task` と同じで、
「新しい承認サイクルを始めるために既存の承認が要る」循環を作らないためである
（`packages/shared/src/plActionPolicy.ts` の `resume_task` 節を参照）。

**AI/PL はこの経路を使えない。** 3重に閉じている:

1. `PL_ACTION_KINDS` に対応する語彙が無い → `resolvePlActionPolicy()` が未知値として `forbidden`
2. `executeAction()` / `allowedActionsFor()` に配線していない → in-process の PL から到達経路が無い
3. `WORKER_ALLOWLIST` に載せていない → WORKER credential からは Default Deny で 403

---

## どの症状のときに使うか

| 症状 | 使うもの |
|---|---|
| Task が `blocked`、**Job が1件も無い** | **本手順**（`POST /api/tasks/:id/recover`） |
| Task が `blocked`、Job があり最新が `blocked` / `failed` | 既存 `POST /api/tasks/:id/resume` |
| workspace が quarantine | 既存 clear-quarantine 経路（resume では解けない） |
| 承認待ちで止まっている | Mobile の承認画面（`GET /api/approval-requests/waiting`） |
| Task 自体を取り下げたい | `POST /api/tasks/:id/abort`（CEO Approval が要る） |

「Job が1件も無い blocked」は `attention` の **`task_blocked_without_job`** として出る。
PL はこれを notify-only で1回だけ CEO へ通知し、自分では触らない。

### この状態が生まれる経路

`ctoAi/taskContinuation.ts` の `failContinuation()` が、continuation の producer
（`createInitialImplementWorkflow()`）が非 retryable に skip したときに Task を `blocked` にする。
**最も多いのは Design Review が非 ALIGNED（CONFLICT 等）を返した場合**で、このとき Job は作られない。

---

## 手順

### 1. 状態を確認する

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$API/api/state" | jq '.attention'
```

`task_blocked_without_job` があれば `taskId` を控える。PL が送った通知本文には
直近の Design Review の判定（CONFLICT / 理由）も入っている。

### 2. まず「なぜ止まったか」を読む

**ここを飛ばさない。** 再投入しても原因が残っていれば同じ判定でまた止まる。

CONFLICT の原因は経験上2種類ある（`task-design-review-conflict-has-no-recovery-route` の実測）:

- **提案側の問題** — scope 要約の誤記、範囲が曖昧で対象外まで変更しかねない、等
  → 訂正した `implementationScope` / `allowedPaths` で採用し直す（下の 4 へ）
- **Source of Truth 側の問題** — ledger 本文が実仕様に追いついておらず、reviewer 同士が
  要件を逆に読んだ（2026-09-18 の2件目が実例）
  → **先に `tasks/roadmap.md` の当該 item を docs-only で訂正**してから再投入する

### 3. 再投入する（Job 0 件の blocked のとき）

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"ledger 本文を実仕様へ訂正したので再レビューさせる"}' \
  "$API/api/tasks/$TASK_ID/recover"
```

成功すると `blocked` → `pending` に戻り、`nextDriver` が返る:

- `pl_independent_remediation` … PR #255 の Independent Remediation が提案を作り直し、
  **まっさらな Design Review** へ掛ける。CEO は待つだけでよい
- `attention_only` … 自動で進める経路が無い。`task_ready_without_job` が立ち、
  PL は通知するだけ。roadmap 由来でない Task や、Remediation 予算を使い切った Task がこれ

**Job は作られない。** 実装 Job は fresh Design Review が ALIGNED になって初めて作られる。

主な拒否理由:

| code | 意味 |
|---|---|
| `TASK_HAS_JOBS` | Job があるので既存 `/resume` の担当。こちらでは受けない |
| `TASK_NOT_BLOCKED` | 既に再投入済みか、そもそも止まっていない |
| `TASK_PARKED` | `abort_task` で park 済み。復旧の副作用で park を取り消さない |
| `RECOVERY_BUDGET_EXHAUSTED` | 3回再投入しても通らなかった。**同じものを押し直さず 4 へ** |

### 4. 訂正して採用し直す（再投入で通らないとき）

`RECOVERY_BUDGET_EXHAUSTED` になった場合や、提案側の scope が明らかに誤っている場合は、
**既存の採用 API を訂正済みの内容で叩き直す**。これが 2026-09-18 に production で実際に使われた
（が文書化されていなかった）手順である。

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "roadmapId": "<ledger の item id>",
        "implementationScope": "<訂正した実装範囲>",
        "allowedPaths": ["apps/api/src/..."],
        "acceptanceCriteria": ["..."]
      }' \
  "$API/api/projects/$PROJECT_ID/roadmap-adoptions"
```

**成立条件**: 対象 Task が **Job を1件も持たない**こと。`syncRoadmapTasks()` は Job を持たない
Task を可変として扱うため spec が更新され、**fresh Design Review が走る**。
Job を持つ Task は `ALREADY_EXECUTED` で拒否される（既存の二重実行防御。これは正しい挙動）。

`allowedPaths` は repository-relative でなければならない（絶対パスは
File Change Guard が最初の implement Job を止める）。

### 5. それでも解決しないとき

- ledger 本文の訂正で解ける見込みがあるなら 2 へ戻る
- この Task をいま進めないと決めるなら `POST /api/tasks/:id/abort`（CEO Approval が要る）で park する。
  Roadmap 項目の残作業は消えず、後から follow-up 採用で別 Task identity として再開できる

---

## 効果検証（Design Philosophy 8）

新しいテーブルを足していないので、集計は既存 `audit_log` から取る。

```sql
-- Human Recovery の実施件数と理由
SELECT entity_id, detail, created_at
FROM audit_log
WHERE entity_type = 'task' AND operation = 'task_human_recovered'
ORDER BY created_at DESC;
```

後から見たいのは次の3つである:

1. **件数が減っているか** — 減らないなら、CONFLICT の作り込み側（提案 or ledger）が直っていない
2. **再投入が効いたか** — `task_human_recovered` の後にその Task の Job が作られたか
3. **同じ Task を何度も押していないか** — `RECOVERY_BUDGET_EXHAUSTED` が出るなら手順 4 へ進むべきだった

---

## 関連

- `tasks/roadmap.md` … `task-design-review-conflict-has-no-recovery-route`
- `apps/api/src/humanRecovery/recoverBlockedTask.ts` … 実装と、境界の根拠
- `docs/project_memory/rules/approval_rules.md` … 「resume は Gate を代替しない」章
- `specs/22_safety_approval_design_principle.md` … Human Approval を最後の Safety Boundary として扱う原則
