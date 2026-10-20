# Approval Rules — いつCEOに承認を求めるか

**Importance Level: 1**
**Status: active**

---

## 上位原則（2026-09-17 追記・2026-10-02 改訂）

本ファイルは**承認運用の正本**である。承認の要否は `specs/22_safety_approval_design_principle.md`
（Safety / Approval 設計原則の正本）1章 **Decision Authority Principle** に従う:

- Human Gate の要否は **「その操作によって誰の責務に属する意思決定が発生するか」** で決める。
  操作名・ファイル種別・Risk Level（HIGH / CRITICAL）・「Production だから」「Security 関連だから」だけでは CEO 必須にしない
- 技術的に危険な変更は、CEO 承認ではなく **Safety Evidence を強くして**扱う（同 1-3）
- CEO 承認を挟むこと自体を Safety Evidence として扱わない

**コードが現在強制している Gate は、本ファイルの改訂だけでは外れない。** 下記「2種類の承認」の
`plActionPolicy` 由来 `ceo_approval` や、`git_commit` の一律 Approval Gate は、`specs/22` 14-2 の段階で
外すまで現行どおり効く（外すまではコードが優先する）。

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
| PL Gate名 | `ceo_approval`（**この承認では満たされない**。下記） |

**方針承認は PL action を1つも認可しない（2026-10-20 改訂）。**
旧規則は、`ceo_approval` を `REQUIRED_CEO_APPROVAL_TYPE`（`apps/api/src/pl/actionGate.ts`）による `type` 照合で
満たしていた（`rollback_commit` / `restart_service` / `deploy_production` → `deployment`、`switch_provider` →
`external_service`）。方針承認は Task・Job・commit / diff・Project scope のどれにも束縛されず、TTL も消費も無い
（既知の制約1・2）。そのため「その PL action のために人が出した判断」であることを証明できず、type が合う
無関係な古い承認でも Gate を通ってしまう。新規則は次のとおり。

- `storage.approvals` の行は、状態・`type` を問わず PL の `ceo_approval` evidence にならない。PL Gate は
  `LEGACY_CEO_APPROVAL_NOT_ACCEPTED` で拒否する。行が読めない・照合できない場合も拒否する
- `plActionPolicy` が `ceo_approval` を要求する PL action（`rollback_commit` / `restart_service` /
  `deploy_production` / `switch_provider`）は、**束縛された人専用の仕組みができるまで PL からは実行できない**。
  現時点でこの4つに配線された executor は無いので、動いている経路は失われない
- そうした仕組みを足すことは新しい承認経路の追加なので、その時点で本ファイルを改訂する（CEO code-owner review）
- 方針承認そのもの（作成・決定・Mobile の方針承認セクション）は残る。人が方針を決めたことの記録であり、
  PL action を実行する権限ではない。決定 API（`PATCH /api/approvals/:id`）は人の credential 専用である
- 根拠: 束縛の無い承認を権限として使わないのは、権限を狭める強化である（`specs/22` 1-2 末尾・1-5）
- code: `apps/api/src/pl/actionGate.ts` `checkCeoApproval()`

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
  なお `ceo_approval` は現在 PL からは満たせない（上記 A）ので、これらの操作は PL からは実行できない。

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
   このため 2026-10-20 以後、方針承認は PL action の根拠として受け付けない（上記 A）。
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

## CEO が REJECT した git_commit の解放（2026-10-15 CEO 承認）

git_commit Approval を REJECT すると、その Job は `blocked` のまま残る。PL は CEO の却下を自動 resume しない。
Task を park して Project を解放する経路は **既存の ADMIN manual abort だけ**で、条件は次のとおり。

- **REJECT だけでは何も park しない。** 別の `abort_task` Approval が `APPROVED` であることを要し、解放時に
  `CONSUMED` になる（既存の manual abort と同じ意味）。却下した git_commit Approval は `REJECTED` のまま。
- 対象は「最新 Job が blocked git_commit で、**その Job 自身に直接紐づく** Approval が `REJECTED`」の Task だけ。
  resume を辿って却下を推定しない。同一 Task / Project、Candidate HEAD = Approval の `targetCommit` を要する。
- Worker は観測だけを行い、ファイルを削除しない。Candidate の差分は operator が **復元できることを確認した backup**
  を取ってから戻す（手順: `decisions/p2_technical_recovery_production_e2e.md`）。
- 最終 transaction 内で、最新 Job・直接の却下・HEAD・live Job 不在・他 Project を含む workspace 所有者不在・
  clean 観測と knownGood・abort 認可の種類（manual と technical を混在させない）を再確認し、
  Job の failed 化・park・Approval 消費・監査を atomic に行う。どれかが欠ければ何も変えない。

## 期限切れ git_commit の resume 系譜 — 固定 anchor + generation（2026-10-15 CEO 条件付き承認）

承認期限切れで git_commit を resume するたびに `resume:<直前Job>:1` が入れ子になり、1ホップしか辿らない
REJECT → 再実装の解決が届かなくなった。新しい resume は元の git_commit Job（`review:<id>:git-commit`）を
anchor として `resume:<anchor>:<n>` を振る。条件は次のとおり。

- **承認の意味は変えない。** 各 generation は新しい Approval と Gate 評価を受け、HEAD / diff が変われば
  既存の規則どおり無効になる（承認待ちは SUPERSEDED、承認済みは STALE）。Stage 1 自動通過の対象外
  （`resume:` は対象外のまま）。既存 Job の workflowStepKey は書き換えない（resume が直前 Job を
  blocked → failed にする既存の handoff は従来どおり）。
- anchor は同一 Task / Project の canonical git_commit Job に限る。参照は1回だけで、再帰・多段探索をしない。
- **Job 自身に直接紐づく Approval を最初に見る。** 直結の REJECTED は常に CEO の却下として扱う。
  anchor 経由で引き継いだ却下は triage には効くが、manual abort（直結のみ）の根拠にはならない。
- 旧形式（key 無し・入れ子の `resume:<prev>:1`）は自動移行しない。REJECT 後の Human Resume が修正へ戻る
  source の特定に限り、旧形式の入れ子は git_commit の段だけを遡る（次節、2026-10-15 CEO 承認 Option A）。
  それ以外の旧形式の扱いは従来どおり。
- 新方式の系譜が壊れている（重複・欠番・不正 anchor）場合は resume を 409 で拒否して何も作らない。
  これは Decision Authority の問題ではないので CEO へ上げず、既存の technical budget で止める。

## CEO が REJECT した git_commit から修正へ戻る経路 — 旧形式の入れ子（2026-10-15 CEO 承認 Option A）

REJECT 後の Human Resume（修正指示つき）は、却下された git_commit を作り直さず、元の implement Job へ
修正指示を載せて戻す。元の implement の特定は `workflowStepKey` の lineage だけで行う。新方式の generation は
前節の fixed anchor を1回だけ参照する（変更なし）。本節は **#348 以前に作られた旧形式の入れ子**だけを扱う。

- **旧形式の git_commit 側 `resume:<prev>:1` は段数を固定せず遡る。** 2026-09-23 の「最大 1 ホップ」では、
  PL の daily resume で日数分入れ子になった旧形式から REJECT 後に修正へ戻れない（Task b6d4097a で 6 段を実測）。
- 遡る各段は**同一 Task / Project の git_commit** に限る。キーが名指す 1 件だけを読み、候補探索をしない。
  欠損・循環・Task の Job 数を超える段数・git_commit 以外の段は fail-closed（Job を作らない）。
  新方式の generation（`:2` 以降）に当たった段も、端が `review:<id>:git-commit` でないため fail-closed。
- git_commit の段と review の段を 1 つの walk で混ぜない。端は `review:<id>:git-commit` に限り、
  review → implement の区間と Design Review evidence の門は従来どおり。
- **REJECT を AI が自動再開しない**不変条件は変えない（PL triage は `ceo_escalation`）。Human Resume は
  人の明示操作のまま。Candidate の差分は破棄しない（修正 implement がそのまま引き継ぐ）。
- 「CEO が REJECT した git_commit の解放」（manual abort で park、直結の却下のみ）とは別の経路であり、
  どちらを使うかは CEO が選ぶ。

## Lifecycle 一括修復による承認の意味の変更（2026-10-20 起案・CEO code-owner review 対象）

Lifecycle 一括修復（stack 01〜13）は、承認の **誰が（a）・何を要するか／何が止めるか（b）・何に束縛されるか（c）・
何を生むか（d: 認可範囲・回数・期限・無効化・置換・予算 reset・どの判断に答えるか）** を変えた。Meta Review の
DA trigger (2) により、その変更は本節で旧→新を明示し、CEO が code-owner review で一度だけ決める。
**本節が承認された後は、本節どおりに実装したコードは正本の規則の強制（Class B）である。** 本節と食い違う
コードはコード側を直す。

**読み方**: 各規則は「要素 / 旧 / 新 / 不明時 / 根拠 / code」で書く。`[Lxx-n]` は修復の棚卸し（stack 層・項番）。
**共通の不明時既定**: 事実が読めない・矛盾する・証明できないときは、承認として数えない・操作を拒否する・
何も変えない（fail closed）。以下の「不明時」はこの既定の具体形である。

### 0. 変えないもの

- **Gate の risk 分類は、下記 0-1 の2件を除き origin/master のまま。** 修復が一時広げた HIGH の一覧
  （`RISK_RULES` [L06-7]・`GATE_CHANGE_EXACT_FILES` [L11-1]・追加 HIGH files と authority-coverage CI guard [L12-1]）は
  戻した。Risk は必要な Evidence の強さを決め、誰が決めるかは決めない（`specs/22` 14-3）
- **CODEOWNERS は広げない。**
- **Gate の技術停止（`risk_rule_skew` / `approval_contract_violation` / 承認済み commit の Gate 段階拒否）は CEO escalation ではない。**
  見える技術停止（`technical_exhausted`）として扱う（下記 T-3）
- 最重要原則（AI承認は無効）・TTL 24時間・Candidate Freeze・「resume は Gate を代替しない」の6点・Yellow Zone の列挙は変えない

### 0-1. Risk 分類で変えるもの（何が承認を要するか (b) の拡大）

**K-1 `docs/project_memory/rules/` 配下をすべて HIGH にする**（(b)）
- 旧: この配下で HIGH（decision authority / safety policy doc）は `rules/approval_rules.md` 1ファイルだけ
- 新: `docs/project_memory/rules/` 配下の**全ファイル**が HIGH。したがって、これらに触れる Tier A の git_commit は人の承認（Approval Gate B）を要する
- 不明時: パスが配下に当たるか判定できなければ HIGH 側に倒す（パターン照合は大文字小文字を区別しない）
- 根拠: rules/ は承認ルール以外も運用ルールの正本（CLAUDE.md 7 章の Operational Knowledge）であり、`specs/22` 14-3 DA trigger (1) の Policy 文書に当たる。
  Policy 文書の変更は人の判断（同 1-2）。risk を上げる理由は Decision Authority であって「危険だから」ではない
- code: `packages/shared/src/approvalGateLogic.ts` `RISK_RULES`（label `decision authority / safety policy doc`）

**K-2 commitGate の実ファイルを HIGH にする**（(b)）
- 旧: `apps/worker/src/approvalLevel/commitGate.ts` は HIGH の対象外
- 新: その production ファイル（exact path。隣のテストは含まない）を HIGH にする
- 根拠: `evaluateCommitGate()` は `specs/22` 14-3 DA trigger (2) が名指しする authority 定義である
- code: `approvalGateLogic.ts` `RISK_RULES`（label `alignment / gate change`）

### 1. 人の authority の証拠

**H-1 ADMIN credential を「人が決めた」証拠にする**（(a)、[L06-1, L01-9, L09-2 の対応付け]）
- 旧: 承認の決定（`PATCH /api/approval-requests/:id/status`）は決定者の種類を記録せず、APPROVED の行はそれだけで人の判断として数えた
- 新: 決定と同じ transaction で `approval_actor` を記録する。値は呼び出しの credential 区分から機械的に決め、
  **split-credential の ADMIN = human**、Worker / legacy / 不明 = human ではない
- 不明時: 記録が無い・読めない・矛盾 → human ではない
- 根拠: 最重要原則を自己申告ではなく credential の事実で強制する。ADMIN は「誰が押したか」の証拠に使うだけで、
  その判断を CEO の Decision Authority にするものではない（`specs/22` 1-8）
- code: `apps/api/src/designReview/resumeActor.ts` `recordApprovalActor()` / `readApprovalActorClass()` / `resumeActorClassForCredential()`、storage `approveAndResumeJob()`

**H-2 Task 単位の承認は `approval_actor=human` のときだけ効く**（(a)(d)、[L01-9, L06-1, L09-3]）
- 旧: `abort_task` / `reconcile_external_completion` / `repair_from_stored_review:*` の APPROVED は状態だけで有効
- 新: human の行だけが、数える・consume する・生きた人の判断として表示する対象。human でない APPROVED は
  SUPERSEDED（`approval_actor_not_human`）にして、新しい承認を求め直す
- 不明時: human ではない扱い（数えず、置き換える）
- 根拠: 同上（最重要原則）
- code: `packages/shared/src/approvalLiveness.ts` `isLiveTaskScopedDecision()`、`resumeActor.ts` `humanTaskDecisionFacts()`、storage `verifyAndConsumeForTaskAction`

### 2. 承認の束縛

| 規則 | 旧 | 新 |
| --- | --- | --- |
| B-1 PL の `approval_gate` evidence（(c)、[L06-2]） | requestedAction の完全一致は `abort_task` だけ | **全 PL action** で `requiredApprovalRequestAction()` と完全一致 |
| B-2 git_commit 以外の `/consume`（(c)、[L06-4]） | jobId 不要。Task 単位の承認も消費できた | jobId 必須。Job 実在・同一 Task・command kind = requestedAction・APPROVED・未失効・commit / diff 一致を 1 transaction で確認。Task 単位の承認は `/consume` では消費できない |
| B-3 jobId 無しの `/gate/check`（(c)、[L06-5]） | 既存承認を読み、起票し得た | **評価だけ**（`gate_evaluations` だけを残す）。active な承認を読まない・作らない・`call_consume` を返さない。REJECTED の参照は実行を許さない側の情報なので従来どおり行う |
| B-4 git_commit 以外の `/gate/check` の再利用（(c)、[L06-3]） | Task の最新の WAITING / APPROVED 1件を requestedAction を問わず再利用した（別 action への承認でも通り得た） | 同じ requestedAction の active 行だけを新しい順に見て再利用する。git_commit は従来どおり Job に紐づく承認だけ |
| B-5 Task あたり WAITING は1件（(d)、[L06-9, L02-1]） | 新しい要求が他の WAITING を残した | 起票（`/gate/check` の BLOCKED・`POST /approval-requests`・Stored Review Recovery）は1 transaction で Task の WAITING を action・期限を問わず全部 SUPERSEDED、同 action の APPROVED も置換。**別 action の APPROVED（人の判断）は残す** |
| B-6 git_commit の起票（(c)(d)、[L02-2]） | 他の WAITING を残した | Job への紐付けと同時に Task の他の WAITING を SUPERSEDED（APPROVED は残す）。Job が running / blocked でなければ `JOB_NOT_ACTIVE` で拒否 |
| B-7 HIGH の safe work（(b)(d)、[L06-6, L06-10]） | 承認要求を起票し、誰も待たない WAITING が残った | `git_status` / `diff` / `log` / `typecheck` / `test` / `lint` の HIGH 判定は起票しない。残っている HIGH の safe-work WAITING は SUPERSEDED（`safe_work_no_waiter`）。**CRITICAL の行には触れない** |
| B-8 git_commit 以外の REJECTED（(d)、[L06-8]） | 他の action も止めた | 同じ requestedAction だけを止める |
| B-9 provider timeout 失敗後の自動 retry を止める承認（(b)、[L02-5]） | Task の**最新行**が WAITING（期限切れを含む）か REJECTED なら止めた | Task の**全行**のうち生きた（未失効の）WAITING があるか、最新行が REJECTED（期限を問わない）なら止める。期限切れの WAITING は止めない。新しい行の陰にある古い生きた WAITING は止める側に数える |

- 不明時: 一致・実在・状態を確認できなければ evidence 不足として拒否し、消費しない（期限切れ → EXPIRED、
  commit / diff 不一致 → STALE）。safe work と確定できなければ従来どおり起票する。transaction が完了しなければ何も起票しない
- 根拠: 承認を「その操作・その Job・その時点の人の判断」へ狭く束縛する強化であり、技術判断（`specs/22` 1-2 末尾）。
  B-7 は読み取り・検証だけで人の判断が発生しない（同 1-2・14-3）。Risk 分類自体は変えない
- code: `apps/api/src/pl/actionGate.ts` `checkApprovalGate()` / `requiredApprovalRequestAction()`、
  `apps/api/src/routes/approvalGate.ts` `approvalGateRoutes()`（`/gate/check`・`/consume`・`findActiveRequestForAction()`・`findRelevantRejectedRequest()`）、
  storage `replaceActiveAndCreate()` / `createForJob()` / `consumeForCommandJob()` / `supersedeUnwaitedSafeWorkRequests()` / `persistProviderTimeoutFailure()`（B-9）

### 3. 置換・無効化

| 規則 | 旧 | 新 |
| --- | --- | --- |
| S-1 park / abort 成功（(d)、[L02-3]） | 使った承認だけが変わった | Task の WAITING / APPROVED を action を問わず全部 STALE |
| S-2 人の resume / recover（(d)、[L09-4]） | Task 単位の承認は残った | 生きた Task 単位の WAITING / APPROVED を全部 SUPERSEDED（`superseded_by_resume` / `superseded_by_recover`）。**PL の resume は置換しない**（human でない APPROVED を除く。下記 9 章） |
| S-3 clean な完了（(d)、[L07-1]） | 残った blocked Job の承認は残った | 完了が blocked Job を終端にするとき、その Job に紐づく WAITING / APPROVED を SUPERSEDED（`linked_job_terminal`） |
| S-4 期限切れの WAITING（(d)、[L02-6]） | resume 済みの source Job を blocked に留めた | 留めない |

- 不明時: 置換の transaction が完了しなければ元の操作ごと rollback する（承認だけ残して操作が進むことはない）
- 根拠: Task の前提が変わった後、または同じ Task に人が新しく操作した後は、古い判断を使わない（新しい判断が正）。権限を狭める側の変更
- code: storage `parkTask()` / `releaseBlockedJobAndParkTask()` / `resumeBlockedTask()` / `recoverFromBlocked()`、clean completion の `jobs.update` と起動時の `reconcileResumedBlockedSourceJobs()`（`apps/api/src/storage/sqlite.ts`、`linked_job_terminal`）

### 4. 復旧の authority

**R-1 最新の初回 implement を修復の source として認める条件**（(b)(d)、[L01-1]）
- 旧: 実装由来の eligible refusal で止まった review の Human / PL Technical Resume があるときだけ
- 新: 加えて、(i) この実装に解決される CONSUMED の `repair_from_stored_review:<review>` 承認（H-2 により human）、
  または (ii) 引き金の review の resume lineage 上に human と証明された Human Resume があり、**その review の保存 verdict が
  `changes_requested`**（R-2 で採る厳しい側）。どれも無ければ `recovery_authority_required` で skip。
  Stored Review Recovery が承認を求めるのはこの code のときだけ
- 不明時: lineage を再構築できない・actor を human と証明できない → 認めない
- 根拠: 修復の実行は技術判断（`specs/22` 14-3 Repair admission = B）。ただし blocked を越えて自律実行を再開させる根拠は、人の操作の事実からだけ導く
- code: `apps/api/src/designReview/repairFlow.ts` `repairableBlockedReviewRequest()` / `readImplementationAuthorities()` / `humanResumesOf()`、`repairFromStoredReview.ts` `repairFromStoredReview()`

**R-2 修復予算の reset（human generation root）**（(d)、[L01-2, L06-11]）
- 旧: 予算を reset する根は、implement lineage 上の human と証明された resume successor、または consume 済み Stored Review Recovery 承認（human recovery epoch）だけ
- 新: R-1 で認めた実装は human generation root（`human_recovery` / `human_resume`、audit に `budget_reset=yes`）になる。
  `human_resume` の根は、**保存 verdict が `changes_requested` の review** の resume lineage 上の Human Resume があるとき、
  その review が見た実装（初回・repair successor・resume successor を問わない）に置く。複数あれば最も近い根が勝ち、
  同じ実装に両方あれば `human_recovery` を優先する。`human_recovery` generation 内の後続 Stored Review Recovery は新しい承認を求めない
- 不明時: verdict が `changes_requested` と読めない・actor 不明 → 根にしない（予算は reset しない）
- 根拠: 予算 reset は「人がこの実装の修正要求を見て続けさせた」事実の効果に限る。PL Technical Resume は reset しない（1-2: AI 自身に予算＝Safety Level を戻させない、7 章）
- code: `repairFlow.ts` `readImplementationAuthorities()`、`repairPolicy.ts` `walkRepairGeneration()`、`resumeActor.ts` `recordRepairGeneration()`
- 注: 修復の途中では、予算 authority だけが `changes_requested` を要求し、R-1 (ii) の admission は要求していなかった。
  本規則は厳しい側を採り、最終コードは両方で要求する（`repairFlow.ts` `coveredByHumanResume`）

**R-3 Stored Review Recovery の承認の効果**（(d)、[L04-4]）
- 新: consume 済みの承認でも、handoff が拒否される（Task done / parked・Project not running）と修復は作られない。承認は再利用しない。再度必要なら新しい承認を求める
- 不明時: handoff の成否が確定しなければ修復 Job を作らない
- 根拠: 承認は1回限りの効果であり、拒否された handoff を後から黙って再試行しない
- code: `repairFromStoredReview.ts` `repairFromStoredReview()`、`repairFlow.ts` `completeRepairHandoff()`

**R-4 人の resume が Design Review の CONFLICT に答える範囲**（(d)、[L01-3]）
- 旧: review lineage 上の resume だけが、しかも source がこの implement の repair run にだけ答えた
- 新: implement lineage 上の human と証明された resume で、その run の完了**より後**に作られたものは、その run（Task-design run を含む）に答える。修復は新しい Design Review を必ず起票する
- 不明時: 作成順を比較できない・actor 不明 → 答えていない（止める）
- 根拠: CONFLICT は Review 判断の不一致（DA 7）だが、人がそれを見た後に明示的に再開した事実は人の判断である。PL の resume は答えない
- code: `repairFlow.ts` `blockingDesignReviewRun()`

**R-5 複数 run の扱い**（(b)、[L01-5]）
- 新: 同じ `repairSourceJobId` の、より新しい succeeded ALIGNED は古い CONFLICT を置き換える。lineage 外の repair run は数えない。
  残る run は全部調べる（無関係な新しい ALIGNED が古い CONFLICT を隠さない。**強化**）
- 不明時: run の帰属を決められなければ数える側（止める側）へ倒す
- code: `repairFlow.ts` `blockingDesignReviewRun()`

**R-6 Design Review の判定による ALIGNED evidence の置換**（(b)、[L04-1]）
- 旧: ALIGNED evidence があれば、同じ設計への新しい CONFLICT があっても使えた
- 新: 同じ subject・同じ design hash で、evidence より新しい active run、または succeeded の CONFLICT / UNCERTAIN がある間は、
  その ALIGNED evidence を使わない（順序は run の挿入順）。implement Gate（Human Resume を含む）・roadmap freshness・PL action gate・remediation・adoption・triage の全部に適用。**強化**
- 不明時: 順序を決められない legacy 行（同 ms）は覆さない —— 既知の弱さとして明記する
- code: `apps/api/src/designReviewEvidencePolicy.ts` `findSupersedingRun()` / `isUsableAlignedEvidence()`

**R-7 判定の無い run は止めない**（(b)、[L01-4]。L04-2 は 9 章）
- 旧: 終端した run も、判定が無くても修復を止めた
- 新: failed・結果なし・`REVIEW_UNAVAILABLE` の終端 run は止めない。queued / running の run は従来どおり止める
- 根拠: 判定が無いことは Review の不一致ではない（`specs/22` 14-3 DA 7 は「不一致が未解消」）
- code: `repairFlow.ts` `blockingDesignReviewRun()`

**R-8 Design Review 進行中の resume**（(b)(d)、[L04-3, L10-3]）
- 新: Design Review 待ちの間の Human Resume は `RESUME_DESIGN_REVIEW_PENDING`（503・再試行可）を返し、同じ run を使い回す。
  repair の Design Review run が queued / running の間は Human / PL Resume とも `REPAIR_REVIEW_IN_FLIGHT` で拒否。
  Design Review run か pending continuation がある間は archive / draft も拒否
- 根拠: 判定の出る前に別の判断で上書きしない
- code: `apps/api/src/designReview/resumeBlockedTask.ts` `resumeBlockedTaskWithDesignReview()`、`packages/shared/src/resumeAdmission.ts` `evaluateResumeAdmission()`、`apps/api/src/routes/tasks.ts`

**R-9 Human Resume / Recover を拒否する条件**（(b)(d)、[L01-6, L01-7, L09-6]）
- 旧: Task 単位の承認待ちも含め、承認待ちの扱いが経路ごとに揃っていなかった
- 新: Human Resume は `TASK_DONE`・`PROJECT_NOT_RUNNING`・Job に紐づく（command kind の）生きた WAITING があると `APPROVAL_WAITING` で拒否。
  Human Recovery は `PROJECT_NOT_RUNNING` と、全行を見た承認待ち判定で拒否。**Task 単位の生きた WAITING は人の resume / recover を止めない**（S-2 で置き換わる）
- 不明時: Task / Project / 承認の状態が読めなければ拒否
- code: `resumeAdmission.ts` `evaluateResumeAdmission()`、`packages/shared/src/recoverAdmission.ts`、storage `resumeBlockedTask()` / `recoverFromBlocked()`

**R-10 PL の resume は人の判断を待つ**（(b)、[L09-5]）
- 新: 生きた Task 単位の WAITING、または人が実行する種類の生きた（human の）APPROVED がある間、PL の resume は `HUMAN_DECISION_PENDING` で拒否。
  systemState は `job_blocked` ではなく `approval_waiting` を見せる
- 根拠: 人の判断待ちを AI が先回りして消さない（最重要原則）
- code: `apps/api/src/pl/executionLoop.ts`、`approvalLiveness.ts` `isHumanExecutedTaskDecision()` / `liveTaskDecisionState()`、`apps/api/src/state/systemState.ts` `buildSystemState()`

**R-11 escalate と quarantine**（(b)(d)、[L01-8, L07-2]）
- 新: `escalateTaskToHuman` は done の Task を動かさない。quarantine の行は Human Resume があっても workspace を保持し続け、解放は clear-quarantine だけ
- 根拠: 完了と隔離は人の resume で上書きされる種類の判断ではない（汚染を他 Task へ広げない、`specs/22` 1-7）
- code: `repairFlow.ts` `escalateTaskToHuman()` / `isWorkspaceQuarantined()`、`apps/api/src/state/blockedRowOwnership.ts`

### 5. Technical Abort / park / abort

**T-1 Technical Abort を止める人の判断**（(b)、[L02-4]）
- 旧: 期限切れの WAITING も Technical Abort を止めた
- 新: 生きた APPROVED・生きた WAITING・cleanup 要求後に CONSUMED になった行のどれかがあれば `HUMAN_DECISION_CONFLICT` で拒否。
  期限切れの行は止めない。cleanup generation に束縛する
- 不明時: 状態・期限が読めなければ拒否（期限が読めない行は生きているものとして扱う）
- 根拠: 人の判断が生きている間は AI の技術判断で park しない
- code: `apps/api/src/pl/abortTask.ts` `requestTechnicalAbort()` / `completeAbortCleanup()`、`apps/worker/src/index.ts` `reportAbortCleanupObservationsOnce()`

**T-2 帰属不明の dirty workspace は park しない**（(b)(d)、[L11-5]）
- 新: 承認済みの `abort_task` でも、workspace の終了時 fingerprint が dirty で所有者を特定できなければ park しない。
  Task は Human Resume 用に blocked へ上げ、承認は consume しない（`UNATTRIBUTED_DIRTY_WORKSPACE` / `TASK_STATE_CHANGED`）
- 根拠: 誰の変更か分からない差分を承認1つで捨てない（データ消失の防止、`specs/22` 1-7）
- code: `abortTask.ts` `abortTask()`

**T-3 Gate の技術停止は CEO escalation ではない**（(b)、[L13-4]）
- 旧: triage rule 6.8（Gate の技術停止）と 6.9（承認済み git_commit を Worker が拒否）は CEO escalation で、6.9 は `requiresAuthorityChange` を立てた
- 新: どちらも技術レーン（`auto_recovery`）のまま `technicalStop`（6.8 は `risk_rule_skew` / `approval_contract_violation`、
  6.9 は `approved_commit_gate_refusal`）を立てる。効果は次のとおり:
  - 自動 recovery の budget は最初から 0。最初の観測で対象単位の `technical_exhausted` audit を1回だけ残す（`limit=0`・`stop=<code>`）
  - escalation 行を作らず、通知もしない。`requiresAuthorityChange=false`
  - `job_blocked` は attention に残る（見える停止）。結び付いた WAITING があっても systemState は `approval_waiting` ではなく `job_blocked` を出す
  - 原因を直した後の明示 resume は従来どおり admit される（新しい Job なので上の audit に縛られない。git_commit なら新しい承認）。
    生きた WAITING がある間は resume は admit されず、出口はその WAITING を承認すること
- 不明時: 停止理由が技術停止と確定できなければ（stderr 先頭の理由コード・コマンド未実行・Worker の証拠が Gate 段階の拒否を示す、のどれかが欠ける）
  `technicalStop` を立てず、既存の rule（却下・guard・quarantine 等）へ回す。CEO が却下した git_commit は却下の扱いを優先する
- 根拠: 版ずれ・契約外の応答・consume の想定外の拒否は技術判断であり CEO へ上げない（`specs/22` 1-3・14-3「停止回数は CEO escalation 条件にしない」）
- code: `apps/api/src/pl/blockedTriage.ts` `triageBlocked()`（rule 6.8 / 6.9、`BlockedDiagnosis.technicalStop`）、
  `apps/api/src/pl/executionLoop.ts` `technicalRecoveryExhaustion()` / `recordTechnicalRecoveryExhaustion()`、`systemState.ts` `buildSystemState()`

### 6. git_commit 承認の効果と Worker の技術停止

**G-1 承認済みの HIGH / CRITICAL commit は atomic consume の後に実行される**（(d)、[L13-1]。D2）
- 旧: API が ALLOW + `call_consume` を返しても、Worker がローカルの risk で再び止めた
- 新: Worker は API の ALLOW + `call_consume` に従う。承認（Job・commit・diff に束縛）を1回だけ atomic に consume できたときだけ実行する
- 不明時: consume できなければ実行しない
- 根拠: 承認の効果は既存規則どおり（Approval Gate B）。Worker 側の再判定は Decision Authority ではない
- code: `apps/worker/src/guards/gatePolicy.ts` `resolvePolicy()`、`apps/worker/src/jobRunner.ts` `runJob()`、storage `consumeForJob()`

**G-2 Gate 応答の技術停止**（(b)、[L13-2]）
- 新: 組が整合しない応答・MEDIUM を超える ALLOW + proceed → `re_check approval_contract_violation`。ローカル risk > API risk → `re_check risk_rule_skew`。
  consume id は承認 id と一致しなければならない。これらは承認の判断ではなく停止であり、扱いは T-3
- code: `gatePolicy.ts` `resolvePolicy()`、`packages/shared/src/approvalGateLogic.ts` `findGateTechnicalStopCode()`

**G-3 Worker が拒否した承認済み git_commit**（(b)、[L09-7]）
- 新: 拒否は保存し、承認は APPROVED のまま残す（消費も無効化もしない）。扱いは T-3
- code: `apps/api/src/approvedRunBlock.ts` `classifyApprovedRunBlock()`（storage `jobs.update` の停止理由と共有）、`blockedTriage.ts` rule 6.9

### 7. Capability の制限

**C-1 Job の `success` は Worker の結果だけ**（(a)(d)、[L12-3]）
- 旧: ADMIN credential で Job を直接 `success` にできた
- 新: `success` は Worker Outbox の配送（Worker / legacy credential）からだけ受け付ける。直接の success は `409 JOB_SUCCESS_REQUIRES_WORKER_RESULT`。人の credential から権限を1つ減らす
- 根拠: 権限の縮小は技術判断（`specs/22` 1-5）。実行していない Job の完了を手で作らせない
- code: `apps/api/src/routes/jobs.ts` `jobRoutes()`

**C-2 汎用 Task CRUD は lifecycle 状態に入れない**（(b)(d)、[L10-4]）
- 旧: 汎用 PATCH で `in_progress` / `review` / `blocked` に変えられた
- 新: 汎用 Task CRUD は `in_progress` / `review` / `blocked` に入れない。`in_progress` / `review` → `pending` は、同じ transaction で stranded と確認できたときだけ
- 不明時: stranded と確認できなければ拒否
- 根拠: lifecycle 状態は Job と承認の事実から決まる。手の状態変更で Gate を迂回させない（縮小）
- code: `apps/api/src/routes/tasks.ts`（`TASK_LIFECYCLE_STATE_OWNED_REFUSAL`）、`apps/api/src/state/strandedTask.ts`

### 8. 方針承認と PL action

[L11-2]。規則本文は上記「2種類の承認」A を改訂した。要点: 方針承認は PL action を1つも認可しない。
`ceo_approval` を要求する PL action は、束縛された人専用の仕組みができるまで PL から実行できない（現時点で配線された executor は無い）。

### 9. 既存原則の機械的強制（新しい規則ではない）

次は既存の正本（最重要原則・TTL・resume の不変条件・期限切れ resume の規則・`specs/22` 14-3）をコードで強制したもので、承認の意味は変えていない。

| 項目 | 強制している既存原則 |
| --- | --- |
| 承認の決定 PATCH は人（split-credential ADMIN）専用 [L09-1]・`PATCH /api/approvals/:id` も同じ [L11-3] | 最重要原則 |
| Task 単位の承認は human のときだけ数える [L09-2]・systemState / stranded 判定 / Mobile でも同じ [L10-1] | 最重要原則（ADMIN = human の対応付けは H-1 で正本化） |
| PL の resume は human でない APPROVED も置き換える [L10-2] | 最重要原則 |
| Technical Abort を止める APPROVED は未失効のものだけ [L09-8]・期限切れの WAITING の決定は EXPIRED へ進めて `409 APPROVAL_EXPIRED` [L12-2] | TTL 24時間 |
| consume の強化（期限が読めない → 期限切れ・human でない APPROVED は置換・新規 consume は running Job が必要）[L13-3] | TTL・最重要原則・一回限り |
| 承認を使い切った git_commit は STALE で blocked、resume が新しい承認を発行 [L11-4] | 期限切れ resume の規則・resume 不変条件 2 / 6 |
| Human Resume は Design Review が見た Job に束縛（`RESUME_TARGET_CHANGED`）[L11-6] | resume 不変条件 3 |
| 「まだ判定が無い」ことだけでは escalate も block もしない [L04-2] | `specs/22` 1-3・14-3 |

承認の意味に関係しない修復（lifecycle 修正・通知のみの escalation [L03]・Mobile / Recover の述語共有 [L05]・テスト [L08]・retry cooldown [L11-7]）は本節の対象外。

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
- Safety Boundary を**弱める**、または AI の authority を**広げる**変更に当たるなら **CEO へ Escalate する**（強化・縮小は技術判断。強化か弱化かを機械判定できない場合は Escalate 側へ倒す）

### PL と Binding Reviewer の意見が割れた場合

次の順で再評価する。PL の一存で終わらせない。

1. **Second Independent Review**（別 provider の独立レビュー）
2. **Meta Review**
3. 必要なら **CEO Escalation**

## CEOの承認が必要（Yellow Zone）

以下の**意思決定が発生する**場合のみCEOに通知・承認を求める。各項目は操作名ではなく意味で判定する（`specs/22` 1-1・1-2）。

- Goal変更
- Design Philosophy変更
- 外部サービス追加（GitHub以外）
- 有料API / 課金発生
- 本番公開 / ストア公開 — **新しい**外部ユーザー・地域・市場への公開を指す。既存サービスの既存公開範囲内での通常 deploy は含まない
- セキュリティモデル変更 — AI authority の拡大・Safety boundary の弱化を指す。technical security hardening・credential の rotation / 縮小は含まない（`specs/22` 1-5）
- 個人情報機能追加
- リポジトリ外への操作 — 新しい外部対象への操作、または既存 authority を超える操作を指す。既存の運用対象（Production VPS・既存 GitHub repository）への既存 authority 範囲内の通常運用は含まない

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
*Updated: 2026-10-02 — 上位原則を Decision Authority Principle（`specs/22` 1章）へ改訂。Yellow Zone の各項目に意味ベースの解釈を付記。Binding Review の Escalate 条件を「弱化・拡大」に限定*
*Updated: 2026-10-20 — 「Lifecycle 一括修復による承認の意味の変更」章を追加（Approval Tuple の旧→新。CEO code-owner review 対象）。2種類の承認 A を改訂し、方針承認は PL action を認可しないとした。`docs/project_memory/rules/` 配下と commitGate を HIGH にする規則（0-1）を明記*
