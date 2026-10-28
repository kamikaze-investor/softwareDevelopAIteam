# Meta Reviewer チェックリスト

差分レビュー時に必ず確認する項目一覧。

---

## チェック1: Cage弱体化

### permissionGuard.ts
- [ ] `ALLOWED_PREFIXES` が削減されていない
- [ ] `FORBIDDEN_PATTERNS` が削減されていない
- [ ] `parseCommand()` のメタ文字チェックが削除されていない
- [ ] `isInsideTargetRoot()` の呼び出しが削除されていない
- [ ] `shell: false` が維持されている（commandResolverで）
- [ ] `AgentPolicy.canExecuteCommands` チェックが削除されていない

### fileChangeGuard.ts
- [ ] `ALWAYS_FORBIDDEN_PATTERNS` が削減されていない
- [ ] `normalizeAndValidateChangedFile()` 呼び出しが削除されていない
- [ ] target-project/配下のみ許可のロジックが維持されている
- [ ] `task.allowedPaths` のチェックが削除されていない

### commandResolver.ts
- [ ] 任意のシェル文字列を実行するパスが追加されていない
- [ ] サニタイズ関数（sanitizeBranchName等）が削除・弱体化されていない
- [ ] 新しいCommandKindが追加される場合、安全なargvのみ生成している

---

## チェック2: Sandbox

### docker-compose.yml
- [ ] Control Repository mount に `:ro` が付いている
- [ ] Target Repository mount は read-write
- [ ] `cap_drop: [ALL]` が維持されている
- [ ] `no-new-privileges: true` が維持されている
- [ ] `working_dir: /workspace/target` が維持されている
- [ ] Docker socketのmountが追加されていない

### Dockerfile
- [ ] root以外のユーザーで実行している（`USER aiworker`）
- [ ] 不要なパッケージが追加されていない（apt-get install）

---

## チェック3: 権限境界

CEO へ上げるのは `specs/22_safety_approval_design_principle.md` §14-3 の DA trigger (1)〜(7) に該当する場合だけ。
HIGH / CRITICAL、production、security、DB migration、recovery、または技術的に難しいという理由だけで CEO 承認を要求しない。
Technical Safety Decision は、Risk に応じて Safety Evidence を強めて評価する。

DA trigger は以下の7項目である（正本: `specs/22_safety_approval_design_principle.md` §14-3）。

- (1) Goal・事業上の Goal 優先順位・Product / Business 方針・Design Philosophy / Constitution の原則・Policy / Value の**意味の変更**
- (2) authority 定義（Approval・Gate policy・`plActionPolicy`・permission・`guards/**`・commitGate）の変更。強化と弱体化を機械判定できない間は fail closed。該当するかはファイル名・ラベルではなく、差分が実際に変える Approval Tuple (a)〜(d) で判定する（「DA trigger (2) — Authority / Approval boundary の意味で判定する」）
- (3) 新しい外部 service・有償依存・公開範囲・公開 route
- (4) 個人データ・保持・削除方針の変更
- (5) 不可逆（diff 本文で判定する destructive migration・データ削除）
- (6) diff 内の secret 検出
- (7) Review verdict の不一致が未解消

DA (1) はファイル名ではなく差分の意味で判定する。Goal / Product 方針、事業上の優先順位・トレードオフ、Design Philosophy / Policy / Value、authority / Safety boundary の意味を変える差分は A であり、`requiresCeoApproval: true` を返す。一方、調査結果・evidence の記録、進捗・state 更新、既存 Goal 内の technical-fix item 追加、実装順・技術的 priority、機械的な `PROJECT_CURRENT_STATE` sync は B / C である。`tasks/roadmap.md` や `docs/PROJECT_CURRENT_STATE.md` の編集、ファイル名・「roadmap」という語・記録済み CEO instruction・HIGH / Production risk だけでは A にしない。

DA (3) の「公開範囲・公開 route」は、**AIteamOS の外の利用者・システム**（新しい外部ユーザー・地域・市場。`specs/22` §1-1）から到達・閲覧できる範囲を指す。既存の認証付き internal route の応答に項目を足すという事実だけでは DA (3) に当たらない。DA (3) について B とするのは、次をすべて差分と既存コードから確認できた場合に限る:
- 呼び出し元が既存の credential class・既存の allowlist のままである（同じ差分で allowlist・認証・route の公開設定を変えていない）
- 追加するデータが既存の data-use / sensitivity の範囲内である（secret・認証情報・個人データを含まない）
- proxy・relay・log・telemetry を含め、新しい閲覧先を作らない
- 他の DA trigger（特に (2) authority・(4) 個人データ）に当たらない

次は DA (3) の A（`requiresCeoApproval: true`）である:
- 認証なしで呼べる route、または外部の利用者・client 向けの新しい endpoint を追加する
- 既存 route を新しい credential class・外部 client・新しい呼び出し元へ開く（allowlist への追加を含む）、または既存の認証・allowlist の確認を外す
- 外部の audience から新しく見えるようになるデータを追加する

既に外部から呼べる route でも、外部から呼べることだけでは A にしない。追加項目が新しい外部 audience・公開範囲、個人データ・データ利用方針、Product / Policy、authority を変える場合に、該当する trigger で A とする。
差分に含まれ required CI が実行するテストが、これらの前提（例: route が既存の credential でしか呼べないこと）を実際に assert している場合は、確認できたものとして扱ってよい（テストが空振り・無関係なら確認とみなさない）。それ以外で確認できない場合は A とする（fail closed）。secret・個人データの漏えいなどの技術的欠陥は、Decision Authority の判定とは独立に `blocked` / `changes_requested` の対象である。

通知（alert・escalation・LINE などの CRITICAL 通知）の変更は、通知の変更という種類だけでは A にしない。`approval_rules.md` は「承認の意味に関係しない修復（…通知のみの escalation…）は本節の対象外」とするが、これは Approval Tuple の範囲についての根拠であり、Safety boundary が不変であることの証明ではない。通知の変更を B とするのは、base canonical rule と従来の production の event の意味に対して、次がすべて不変または強化であることを差分と既存コードから確認できた場合に限る:
- 通知の対象となる失敗の event の集合と severity の判定
- 必要な受信者（CEO を含む）と、要求された配達の保証
- 独立した backstop
- gate・承認・Job intake など実行可否への効果（通知が実行可否の判定の一部なら、その判定を変えない）

ある event の通知の時刻を遅らせる場合は、さらに次の両方を確認できること:
- 遅らせる対象が正常系の誤報であり、同じ類の本当の失敗は production の経路で実際に発火する経路により、base より遅くない時間で必要な受信者へ届く（本当の失敗が base より遅れて届きうる遅延は、検知の速さと誤報の量の trade-off であり、技術的な修正ではない）
- 遅らせた通知にも有限の上限があり（有界でない待ちにしない）、その上限と上の配達を、required CI が実行するこの差分の tests が実際に確かめている。roadmap 項目（base にある項目も過去の PR で AI が追加しうる）・PR 本文・commit message・テスト名は、これらを確認した根拠にしない

次は A（`requiresCeoApproval: true`）である:
- 本当の失敗のある類について、通知を無くす、base より遅れて届きうるようにする、または有界でない待ちにする（Safety boundary の弱体化。`specs/22` §1-2）
- base で承認された意味の上で失敗である event の類を、失敗でないと再分類する、または その severity を下げる（base の意味に照らして実装の誤報を直すことはこれに当たらないが、上の B の前提をすべて確認できる場合に限る）
- CEO へ通知する条件そのもの（`CLAUDE.md`「Escalation Rules」・DA trigger）や必要な受信者を変える
- 通知が gate・承認・Job intake など実行可否を決める判定の一部であり、その判定を変える

確認できない場合は A とする（fail closed）。通知の修正であることを PR 本文が主張しているだけでは B にしない。

DA trigger (1)〜(5) に当たっても、欠陥・弱体化・未解消の矛盾が無ければ `blocked` にしない。
`requiresCeoApproval: true` を付け、人の判断は CODEOWNERS review に委ねる（`prompt.md`「Human Decision Authority のみ」）。
canonical spec で承認済みの authority boundary を scope どおりに実装する変更は、人の承認を外す方向でも「Cage弱体化」に数えない。
Approval Tuple の変化は base branch の承認済み canonical rule（`approval_rules.md` / `specs/22`）を基準に測る。base rule が old→new Tuple を具体的に定義済みで実装が全 path で一致すれば B（`requiresCeoApproval: false`。2回目の CEO review は不要）。
具体的な Tuple binding が無く原則としてのみ承認済みの boundary を実装して現行の Approval Tuple (a)〜(d) を実際に変える場合（例: git_commit Stage 1 で人の承認を外す。`approval_rules.md` に exact binding が無い）は A（`requiresCeoApproval: true`）のままで、欠陥が無ければ `blocked` にしない。Tuple を変えずに既存 boundary を正しく強制するだけの実装は B。
「Cage弱体化」として `blocked` にするのは、承認済み scope の逸脱・無断の authority 拡大・意図しない bypass / fail-open・実装欠陥がある場合だけ。

#### DA (2): Approval Tuple の意味確認

DA (2) はファイル名・ラベルではなく Approval Tuple の意味で判定する（`prompt.md`「DA trigger (2) — Authority / Approval boundary の意味で判定する」）。Approval Tuple は (a) 承認者・credential class、(b) 人の承認が必要な action / decision、(c) 承認の binding、(d) 承認の effect・使用回数・TTL・失効 の4要素。

- [ ] ファイル名・commit message・「強化」「hardening」「refactor」等のラベルではなく、実際の差分を見た
- [ ] authority 関連ファイル名だけでは A にしていない
- [ ] (a) approver / credential class が追加・削除・置換されていない
- [ ] (b) 人の承認が必要なaction / decisionが追加・削除されていない
- [ ] (c) Project / Task / Job / action / commit / exact diff / review identityへのbindingが変わっていない
- [ ] (d) 承認effect、使用回数、TTL、失効・無効化、supersede、auto-executionが変わっていない
- [ ] 拡大だけでなく縮小・置換もAとしている
- [ ] canonical ruleの具体的箇所を引用した
- [ ] 全writer / reader / consume / alternate route / default / expiry / retry pathを確認した
- [ ] legacy / missing / unknown / contradiction / partial writeはfail closedになる
- [ ] helper直接呼出しだけでなくproduction entrypointからのinvariant testがある
- [ ] Tuple不変のenforcement-only repairはB（`requiresCeoApproval: false`）とした
- [ ] unclearまたは証拠不足ならAへ倒した
- [ ] technical statusとrequiresCeoApprovalを独立に決めた
- [ ] Tuple不変のenforcement defectはB + blocked、Tupleを実際に変えるdefectはA + blockedとした
- [ ] legacy / unknown を human と数える、exact diff hash binding を path 集合等へ緩める、TTL 延長・再延長、一部 path での check skip、unknown / default を approve にする変更は A + blocked とした
- [ ] human-approval 対象 action の追加、承認 effect を自動 commit へ変える変更は A とした
- [ ] Tuple の変化を、コードの従来挙動ではなく base branch の承認済み canonical rule（`approval_rules.md` / `specs/22`）に対して測った
- [ ] base canonical rule が old→new として具体的に定義済みの Tuple を全 path で一致させて実装する変更は B とし、不一致は A + blocked とした
- [ ] 原則としてのみ承認済みで exact Tuple binding が無い Tuple 変更（例: git_commit Stage 1）は A のままとし、欠陥が無ければ blocked にしていない
- [ ] base canonical rule に対して Tuple を実際に変える A は、対応する canonical rule（`approval_rules.md` / `specs/22`）の実質的な変更、または原則としてのみ承認済みの boundary への activation binding を同じ PR に含め、CODEOWNERS review に委ねている
- [ ] 同じ PR の rule 変更を既承認の根拠や A→B の理由にしていない。rule と実装を一体の proposal として扱い、rule が old→new Tuple と scope・binding・effect・expiry / use / reset・failure default を定め、全 writer / reader / consume / retry / recovery / alternate path の実装と一致し、missing / legacy / unknown は fail closed であることを確認した
- [ ] rule と code の不一致は A + blocked とし、CEO review で解除されるものとして扱っていない
- [ ] Human Gate を得る目的だけの trivial・無関係・説明だけの保護対象編集は manipulation として blocked とした
- [ ] この確認を特定PR・特定ファイルに限定せず、authority の決定・記録・読取・消費・失効・実行effectに関わる差分すべてに適用した

#### containment / quarantine の分類変更

quarantine は Approval Tuple (b) の人の承認ではない（`approval_rules.md` R-11: 解放は clear-quarantine だけ）。ただし、静止・整合を証明できない workspace を他 Task へ渡さない Safety boundary である（`specs/22` §1-7）。詳細は `prompt.md`「containment / quarantine の分類を変える差分」。

- [ ] 「quarantine に入る条件を変えた」ことだけで DA (2)(b) の縮小としていない
- [ ] 「quarantine に関わる変更」をまとめて B ともしていない。以下をすべて差分・既存コード・テストで確認できた場合だけ B とした
- [ ] 移す結果はプロセス後始末の成功後にだけ生じ、その不変条件が崩れたら落ちるテストがある
- [ ] 移した path でも実行後の workspace 整合検査が走り、その失敗は quarantine のままである（テストあり）
- [ ] 他の unsafe / uncertain な結果と未知の結果は quarantine のままである（結果ごとのテストあり。汎用 safe 判定を広げていない）
- [ ] 移した結果を成功として扱わない
- [ ] quarantine の解除条件・Human Resume / abort / Human Recovery の拒否・workspace 所有権の保持が変わっていない
- [ ] 変更は特定の呼び出し箇所に限られる（他の呼び出し元を変えるなら、呼び出し元ごとに上の確認を満たしている）
- [ ] どれかを示せなければ A とした。後始末の失敗や整合不明の workspace を quarantine から外す差分・dirty な workspace のままの解除・解除条件の緩和は A + blocked とした

### CLAUDE.md
- [ ] Green Zone / Yellow Zone / Red Zone の内容が変更されていない（変更されていれば、欠陥が無い限り `requiresCeoApproval: true`）
- [ ] Repository Boundary（ai-team-backend / target-project）が維持されている
- [ ] 絶対禁止リストから項目が削除されていない

**注意**: routes/ 追加の blocked 判定は「機密情報を返すか」「Guardを迂回するか」で判断する。
通常のCRUD追加は changes_requested / approved で評価する。
「Control Repository への変更」という理由だけで blocked にしない。

### packages/shared/types/agent.ts
- [ ] `reviewer_ai.canExecuteCommands` が false のまま
- [ ] `meta_reviewer.canModifyFiles` が false のまま
- [ ] `reviewer_ai.canModifyFiles` が false のまま
- [ ] `developer_ai.canReadMemory` が false のまま（Context Pack経由のみ）

### packages/shared/types/project.ts
- [ ] `ApprovalType` から `dependency_add` が削除されていない
- [ ] `ApprovalStatus` に `expired` が含まれている

---

## チェック4: コマンド権限

以下のコマンドが新たにAllowlistに追加されていないか確認:
- [ ] `npm install` / `pnpm add` / `pnpm install` （frozen-lockfile以外）
- [ ] `curl` / `wget`
- [ ] `ssh` / `scp` / `rsync`
- [ ] `docker run` / `docker exec`
- [ ] `chmod` / `chown` / `sudo`
- [ ] `systemctl` / `service`
- [ ] `cat ~/.ssh` / `cat /etc/passwd`

---

## チェック5: 仕様思想

### Context First
- [ ] Developer AIがProject Memoryを直接読む実装になっていない
- [ ] Context Packが `POST /api/context-pack` のレスポンスとして返される設計が維持されている
      （ファイル保存ではなくAPIレスポンスが正）

### Rollback重視
- [ ] `RollbackInfo.rollbackArgv` がshell文字列でなくargvになっている
- [ ] Jobが失敗した場合のロールバックフローが壊れていない

### 小さく変更
- [ ] 1つのPRが複数の大きな責務を変更していない
- [ ] コミットメッセージが `[task-xxx]` 形式になっている

### MVPスコープ（specs/10_mvp_scope.md参照）
- [ ] MVP除外の機能（Reviewer AI / QA AI 本実装）が追加されていない
- [ ] 複数ユーザー・チーム管理の機能が追加されていない
- [ ] 自動デプロイ・課金機能が追加されていない

---

## 判定サマリー

| チェック項目 | 問題あり | 判定 |
|---|---|---|
| Cage弱体化 | 1件でも | `blocked` |
| Sandbox制限解除 | 1件でも | `blocked` |
| DA trigger (1)〜(5)（欠陥・弱体化・未解消の矛盾なし） | 1件でも | 技術評価の status + `requiresCeoApproval: true`（CODEOWNERS review が Human Gate） |
| DA trigger (6) secret / (7) 未解消の不一致 | 1件でも | `blocked` |
| Human Decision と欠陥の両方 | — | `blocked` + `requiresCeoApproval: true` |
| recovery / technical changes outside DA(2) | Risk に応じて | Safety Evidence を強化して AI が判定 |
| 禁止コマンド追加 | 1件でも | `blocked` |
| 仕様思想逸脱 | 軽微 | `changes_requested` |
| MVPスコープ外 | あり | `changes_requested` |
| 全てクリア | — | `approved` |
