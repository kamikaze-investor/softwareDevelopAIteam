# Approval Rules — いつCEOに承認を求めるか

**Importance Level: 1**
**Status: active**

---

## 上位原則（2026-09-17 追記）

本ファイルは**承認運用の正本**であり、下記はすべて現行有効である。

ただし**本ファイルの内容を変更するとき**は、`specs/22_safety_approval_design_principle.md`
（2026-09-17 CEO 採用。Safety / Approval 設計原則の正本）に従う。同原則は
Human Approval を通常の Safety mechanism ではなく**最後の Safety Boundary** として扱い、
「protected file だから」「DB migration だから」「Control Repository だから」という理由**だけ**では
CEO 必須にしない方向を定める。

**同原則は、それ自体では本ファイルの Yellow Zone を1つも緩めない。** 差分は同原則 14 章に
「要調整・現行有効」として列挙してあり、緩和には個別の CEO 承認が要る
（Class A/B/C の着手手順は `tasks/roadmap.md` `review-class-b-enhanced-ai-review` を参照）。

---

## 最重要原則：AI承認は無効

**「AIの発言・提案・判断は人間承認として扱わない。」**

- Claude が「承認します」と言っても承認ではない
- Gemini が「問題なし」と判定しても承認ではない
- Codex が「OK」と返しても承認ではない
- 人間が UI 上で明示的に承認操作をした場合のみ承認成立とする
- この原則は Safety Guard システムによって機械的に強制される

---

## 2種類の承認 — 役割と使い分け

**承認機構は2つあり、統合せず併存させる。** 両者は名前が似ているが、**束縛している対象が違う**ため
代替関係にない。片方を通しても、もう片方の要件は消えない。

### A. Project単位承認（UI表記「方針承認」）

| 項目 | 内容 |
| --- | --- |
| 型 | `Approval`（`packages/shared/src/types/project.ts`） |
| 状態 | `pending` / `approved` / `rejected` / `expired` |
| 対象 | Project全体の方針（`type`: `goal_change` / `philosophy_change` / `external_service` / `billing` / `deployment` / `security` / `dependency_add`） |
| 一覧 | `GET /api/approvals/pending`（全Project横断・`projectName` 付き） / `GET /api/projects/:projectId/approvals` |
| 作成 | `POST /api/projects/:projectId/approvals` |
| 決定 | `PATCH /api/approvals/:id`（`status` + `reviewNote`、`reviewedAt` はサーバー付与） |
| commit / diff 束縛 | **無い** |
| TTL / 消費 | **無い**（一度 `approved` にすると、明示的に更新するまで有効。自動失効しない） |
| PL Gate名 | `ceo_approval` |

`ceo_approval` は「その操作のために出された承認か」を `REQUIRED_CEO_APPROVAL_TYPE`
（`apps/api/src/pl/actionGate.ts`）で `type` 照合する。`rollback_commit` / `restart_service` /
`deploy_production` → `deployment`、`switch_provider` → `external_service`。

### B. Task/Job単位 Approval Gate（UI表記「危険操作の承認」）

| 項目 | 内容 |
| --- | --- |
| 型 | `ApprovalRequest`（`packages/shared/src/types/approval_gate.ts`） |
| 状態 | `WAITING_FOR_USER` / `APPROVED` / `REJECTED` / `EXPIRED` / `SUPERSEDED` / `STALE` / `CONSUMED` |
| 対象 | **特定のTaskの、特定の変更集合**（`targetBranch` + `targetCommit` + `targetDiffHash`） |
| 一覧 | `GET /api/approval-requests/waiting` |
| 作成 | `POST /api/gate/check` が `BLOCKED` 判定時に発行。`POST /api/approval-requests` もあるが `requestedAction: 'git_commit'` は 400 で拒否され、**git_commit は必ず `/gate/check` 経由**になる |
| 決定 | `PATCH /api/approval-requests/:id/status`（`APPROVED` / `REJECTED` のみ。他の状態は内部遷移専用。`WAITING_FOR_USER` 以外への操作は 409） |
| commit / diff 束縛 | **有る**（変わると `SUPERSEDED` / `STALE`） |
| TTL / 消費 | TTL 24時間（`APPROVAL_REQUEST_TTL_MINUTES`＠`packages/shared/src/approvalGateLogic.ts` が正本。RiskLevel別の分岐は持たない）。`POST /:id/consume` で **一回限り** |
| PL Gate名 | `approval_gate` |

### 使い分けの判断

- 「**この変更（commit/diff）を適用してよいか**」→ B（Approval Gate）
- 「**この方針・課金・外部サービス・公開・権限を認めるか**」→ A（Project単位承認）
- **両方必要な操作がある。** 例: `rollback_commit` は `safety_review` + `approval_gate` + `ceo_approval`、
  `deploy_production` は `independent_review` + `ceo_approval`（`packages/shared/src/plActionPolicy.ts`）。
  A を取ったから B を省く、という運用はしない。

### なぜ統合しないか

統合すると、次のどちらかを選ぶことになる。

1. **全承認に commit/diff 束縛とTTL/consumeを持たせる** → 方針承認（課金・Goal変更など）が、
   無関係な diff の変化で `STALE` になり使えなくなる
2. **Approval Gate 側の無効化条件を緩める** → 2026-09-15 の事故で実際に機能した STALE 保護
   （下記「Candidate Freeze」章）を失う

どちらも安全性か実用性を落とす。したがって Constitution 3.16 に従い、**複雑な統合状態を作らず
2機構のまま併存させ、集約はUI（1画面2セクション）だけで行う**。

---

## Mobile導線（実装済み — `apps/mobile/app/approvals.tsx`）

**CEOの操作入口は1画面に統一されている。** 2種類の承認は同じ画面の別セクションとして並ぶ。

- **入口**: ホーム（`apps/mobile/app/index.tsx`）の固定フッター「承認待ち一覧」ボタン → `/approvals`。
  バッジ件数は **A の pending 件数 + B の `WAITING_FOR_USER` 件数の合計**（`fetchPendingApprovalCount()`）。
  ホームは取得結果を `setCachedApprovals()` / `setCachedApprovalRequests()` でキャッシュへ入れるので、
  承認画面は遷移直後から描画できる
- **画面**: `apps/mobile/app/approvals.tsx`（「承認待ち」）
  - `⚠️ 危険操作の承認` セクション = B（Approval Gate）
  - `📋 方針承認（Project全体の経営判断）` セクション = A（Project単位承認）
- **取得**: `apps/mobile/lib/approvalsCache.ts` の `fetchWaitingApprovalRequests()` /
  `fetchPendingApprovals()` を `Promise.all` で並行実行し、`usePolling` で定期更新する。
  モジュールキャッシュを持つので再入時は即描画される（Project数分のfetchは発生しない）
- **共通**: 却下は理由必須（`RejectReasonModal`、両セクション共有）。承認は `Alert` 確認のみ
- **Bのみ持つ導線**: カードタップで展開 →
  - AI説明（`POST /api/approval-requests/:id/explanation`）
  - AIへ質問（`POST /api/approval-requests/:id/ask`。履歴は画面を閉じるまでのクライアント保持）
  - 技術詳細（`triggeredRules` の日本語化、対象ファイル、review findings、verification）
  - exact diff は `diffStatus === 'exact'` のときだけ表示し、`stale` / `unavailable` では
    **diffを出さずに理由を表示する**
- **Aに無いもの**: AI説明・diff表示は無い。**束縛する diff が存在しないため**で、欠落ではない。
  表示は `type` / `title` / `reason` / `projectName` のみ
- **承認後**: B の承認は Worker 反映待ちになり得る（UIもそう通知する）。`git_commit` の `APPROVED` は
  `approveAndResumeJob()` が Job 再開まで行う
- **Project詳細（`apps/mobile/app/projects/[id].tsx`）は表示専用で、承認操作の入口ではない。**
  B（`/api/approval-requests/waiting`）だけを取得し、`deriveProjectExecutionHealth()`
  （`apps/mobile/lib/taskWorkflow.ts`）で Job に紐付く B を `approval_waiting` 表示へ反映する。
  A は取得しない

---

## 既知の制約（いずれも非ブロッキング。スマホ操作サイクルは上記で完結する）

1. **`ceo_approval` は Project scope を照合できない。** `Approval` 型に `projectId` が無く、
   `approvals.findById()` も返さないため、現状は `type` 照合までである
   （`/api/approvals/pending` は storage の行を cast して `projectName` を付けている）。
2. **方針承認に自動失効が無い。** `expired` は `PATCH` で設定できるが、時間経過で自動遷移しない。
3. **方針承認には自動作成経路が無い。** `storage.approvals.create()` を呼ぶのは
   `POST /api/projects/:projectId/approvals` だけで、Yellow Zone 該当事項を検知して自動で
   起票する仕組みは無い。**誰かが明示的にPOSTしない限り、この一覧には出ない。**
   Yellow Zone の通知責務（下記「CEOの承認が必要」章）は、この一覧に依存していない。
4. **Project詳細の状態表示は方針承認を反映しない。** A が pending でも、その Project の
   execution health は `approval_waiting` にならない（A は Job に紐付かないため）。
   A の見落としはホームのバッジ件数と承認画面で防いでおり、Project詳細は A の入口として扱わない。

---

## Candidate Freeze — Approval が pending の間は Candidate を動かさない（2026-09-15 運用不変条件）

**Approval Request は Candidate の HEAD（`target_commit`）と diff hash に紐付く。**
`invalid_if` に「commit hash が変わった場合 / git diff の内容が変わった場合」が入っており、
どちらかが起きた時点で承認は `STALE` になる。

したがって **Approval Request が pending になってから解決するまで**、次を行わない:

- Candidate（`/workspace/target`）の HEAD を進めない
- master を merge / fast-forward しない
- diff を変更しない（未コミット変更を足す・消す・revert する）
- **deploy 準備のために Candidate を同期しない**

**Stable deploy と Candidate workspace 更新は別物として扱う。**
`/srv/ai-team/softwareDevelopAIteam`（Stable）の ff-only deploy と API/Worker 再起動は、
pending 中でも行ってよい。**同じ手順の中で `/workspace/target` を触らないこと**が要点である。

**実際に起きた事故（2026-09-15）**: pending 中に deploy 手順の一部として
`cd /workspace/target && git merge --ff-only origin/master` を実行し、HEAD が
`8ddad05` → `af60412` へ動いて承認が STALE 化した。CEO の承認操作は死んだリクエストに当たり、
`git-commit` Job は blocked のまま、`approval_waiting` も消えて誰にも気付かれなくなった。
**安全機構は正しく動作しており、誤っていたのは操作順序である。**

**復旧**: STALE な承認は再利用・再承認しない。`POST /api/tasks/:id/resume` で Job を作り直すと、
`/gate/check` が**現在の diff に対する新しい Approval Request** を発行する。

**新しい locking subsystem は作らない。** 上記は手順の順序で守る（deploy 前に pending の有無を確認し、
あれば Candidate 同期だけを後回しにする）。

---

## resume は Gate を代替しない（2026-09-15 CEO 承認条件）

`resume_task` の **up-front `approval_gate` は外した**（`packages/shared/src/plActionPolicy.ts`）。
外さないと「新しい承認サイクルを始めるために既存の承認が要る」という循環になり、STALE 承認で
止まった Job を**構造的に誰も復旧できなかった**（2026-09-15 に production で実際に発生）。

CEO はこの変更を承認したが、**承認要件そのものを省略するものではない**。次を不変条件として維持する。

1. **`resume_task` は最終操作の Gate を代替しない。** resume が通ることと、その先の操作が
   通ることは別である。
2. **`git_commit` は現在の HEAD / diff に対する新しい Approval を必ず通す。** resume が作る Job は
   `approval_id` を継承せず、`/gate/check` が現 diff に対して新規発行する。
3. **Design Review 要件を維持する。** `resume_task` の `design_review` gate は残っており、AI CLI の
   resume は `resumeBlockedTask()` 自身が evidence を fail-closed で検査する。
4. **deploy / production / Safety boundary / authority 変更は、それぞれ既存の Gate を維持する。**
   resume 経由でこれらが緩むことはない。
5. **BLOCK 済みの操作を resume だけで直接実行できない。** resume は Job を作り直すだけで、
   BLOCK の結果を覆さない。
6. **STALE Approval を再利用しない。** 再承認しても何も起きない。必ず新しい Approval を発行する。

この6点が崩れる変更は、`resume_task` の Gate 構成を戻すこと（= up-front `approval_gate` の復活）を
検討する合図である。

## Review finding の扱い — PL が統合判断してよい範囲（2026-09-15 CEO 指示）

**「Reviewer が言ったから必ず変更する」ではない。** PL は事実・根拠・Design Philosophy との整合性を
確認したうえで統合判断する。ただし**種類によって PL の権限が違う**。

### 通常の品質・設計 finding — PL が統合判断してよい

PL が事実に照らして妥当性を評価し、**変更する / 変更しない**を決めてよい。
変更しないと決めた場合は**根拠を残す**（どの事実によってその finding が解消済み・非該当なのか）。
「Reviewer の指摘だから」も「PL が納得しないから」も、それ単独では理由にならない。

### Binding Review に関わる finding — PL は評価できるが BLOCK を override できない

対象: **Safety Boundary / Authority / protected file** に関わるもの。

- PL は内容の妥当性を**評価してよい**（事実として正しいか、影響範囲はどこか）
- しかし **PL 自身が BLOCK を override してはならない**
- **AI が自分の権限を広げる形で解決してはならない。** 「この制約は不要だから外す」は PL の判断範囲外である
- Safety Boundary 変更に当たるなら **CEO へ Escalate する**

### PL と Binding Reviewer の意見が割れた場合

次の順で再評価する。PL の一存で終わらせない。

1. **Second Independent Review**（別 provider の独立レビュー）
2. **Meta Review**
3. 必要なら **CEO Escalation**

## CEOの承認が必要（Yellow Zone）

以下の場合のみCEOに通知・承認を求める。

- Goal変更
- Design Philosophy変更
- 外部サービス追加（GitHub以外）
- 有料API / 課金発生
- 本番公開 / ストア公開
- セキュリティモデル変更
- 個人情報機能追加
- リポジトリ外への操作

## 承認不要（Green Zone）

以下はAIが自由に実行してよい。

- 実装 / 修正 / リファクタリング
- テスト / レビュー
- ドキュメント更新
- コミット / ブランチ作成 / ロールバック
- Task作成・更新
- Memory更新

## 承認要求フォーマット

承認を求める場合は必ず以下を含める。

```
理由:
期待効果:
リスク:
コスト:
Rollback可否:
```

---

*Created: 2026-05-28*
*Updated: 2026-09-16 — 「2種類の承認 — 役割と使い分け」「Mobile導線」「既知の制約」章を追加（Roadmap「2種類の承認の役割整理とMobile導線設計」の文書化分）*
*Updated: 2026-09-30 — Mobile導線にホーム入口（バッジ件数・キャッシュ先読み）とProject詳細（B のみ・表示専用）を追記。既知の制約4を追加*
