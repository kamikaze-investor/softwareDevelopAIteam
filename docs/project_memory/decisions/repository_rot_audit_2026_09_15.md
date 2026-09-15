# Repository 腐敗監査（2026-09-15）と Finding の採用判定

**Importance Level: 2**
**Status: active**

---

## 何をしたか

repository 全体（465 files / 約 132k lines）に対する read-only の
「情報腐敗・陳腐化・不整合監査」を実施し、**92 Finding** を得た。
本記録は、その Finding を PL としてどう採用・却下し、Roadmap へどう統合したかの判断記録である。

**統合は最新 master（`9426ba8`）を正本として行った。**
監査時点（`5db47cc`）の commit をそのまま cherry-pick していない。
監査と統合の間に他セッションが 5 commit を master へ入れており、
そのうち 3 件が監査 Finding と直接重なっていたためである。

---

## 採用判定サマリ

| 区分 | 件数 |
|---|---|
| **総 Finding** | **92** |
| 採用（Roadmap へ反映） | **80** |
| ├ 既存 item の scope 拡張で吸収 | 8 |
| ├ 新規 item（11 item へ集約） | 68 |
| └ 直接 state 修正 | 4 |
| **master 側で解決済み / 他セッション担当（取り下げ）** | **4** |
| false positive | 1 |
| 追加調査（item 化しない） | 5 |
| 対応不要 / historical | 2 |

**新規 Roadmap item は 11 件。** 92 Finding を機械的に 92 item へ変換していない。

---

## 1. master 側で既に解決済み / 他セッションが担当しており、監査側を取り下げたもの

統合前に最新 master と open PR を確認した結果、以下は**追加しないと判断した**。

| Finding | 理由 |
|---|---|
| ledger の「MVP後へ延期」表記の棚卸し（7 箇所）と CEO 判断の提起 | **#211 が方針で解決済み。** 「現在の可否は `state=` が正本」を本文冒頭へ加え、延期表記を「書かれた時点の記録」と位置づけた。監査が用意していた個別棚卸しは不要になった。`adopted-item-blocked-by-stale-deferral-text` は他セッション進行中のため**触っていない** |
| `task-allowed-paths-not-normalized` の延期表記 | **#212 が `state=done` で close 済み**（PR #144 で既に実装されていたことを再評価で確認したため）。監査の関連 Finding（空配列）は**失敗方向が逆の別問題**なので独立 item として登録した |
| 憲法の共通行動原則の範囲表記（3.14〜3.15 / 3.16 / 3.17 の不一致） | **PR #85「docs: update constitution reference range to 3.14〜3.17」と PR #87 が扱っている。** 他セッションの担当領域なので本統合では対象外とした |
| PL Escalation の品質 | **#214 が `pl-escalation-blames-the-wrong-cause`（本文の原因誤認）を登録済み。** 監査の Finding は**配達結果と記録の整合**という別責務なので、責務分離を明記したうえで独立 item にした |

**#214 との関係の再検証**: #214 は `collectSystemEvidence()` が**最古の** ALIGNED evidence を
Gate へ出していた問題を修正した。監査の `pl-resume-task-design-review-evidence-mismatch` は
「どの evidence を選ぶか」ではなく「**resume 用 prompt の hash がそもそも一致しない**」という
別の層の問題であり、#214 の修正では解消しないことをコードで確認した。

---

## 2. 既存 item で吸収したもの（新規 item を作らなかった）

**原則**: 同じ問いを扱う item が既にあるなら、そこへ寄せる。別 item に切ると正本が再び分裂する。

### `control-repository-header-vs-enforced-guard` ← 6 Finding

この item は既に「`CONTROL REPOSITORY` の正式な意味を決める」「コメントと機械強制のどちらを
Source of Truth とするのか」「**2つの正本を残さない**」を acceptance criteria に持っていた。

- 憲法（`CLAUDE.md` §5「最重要」/ `AGENTS.md` §1 / `specs/11`）が実在しないディレクトリ名
  （`ai-team-backend/` / `target-project/`）で境界を定義している。**同一境界に 5 つの呼び名**
- `docs/meta_reviewer/` が存在しないロジック（`target-project/` 限定）を恒久的にチェック項目にしている
- `AGENTS.md` §1 の「Docker が物理的に強制する」が `specs/11` の Current Truth と、
  かつ `AGENTS.md` 自身の §1-1 と矛盾
- `development_rules.md`（Status: active、**alignmentChecker が読む正本**）が
  CEO 承認済みの Tier A 自己開発を禁止している
- CODEOWNERS が 2026-05/06 の構造のままで、`packages/shared` と `apps/api` へ移った
  承認・権限ロジックと `AGENTS.md` 自身を保護していない
- `TARGET_ROOT` に 3 つの解決方式が並存（うち 1 つだけが実際に強制される）

### `project-auto-context-pack-wiring` ← 2 Finding

- Context Pack が production の implement 経路へ未接続（この item が既に扱っている）
- その結果として **Design Philosophy が実行中の Developer AI へ届く経路が 1 本も無い**。
  接続時の受入条件へ `buildInstruction()` のレンダリング漏れと writer/reader の形式不一致を含めた

---

## 3. 直接 state 修正（4 件。すべて最新 master で事実を再確認した）

- **task-023 / task-024** が `[ ]` だが実装済み（`adapter.ts` の JSON retry と timeout → cgroup SIGKILL、
  専用テストあり）。`tasks/task_graph.md` は既に `[x]` で、**2 つの台帳が矛盾していた**
- **`codex-last-message-temp-file-in-target-repo`** が `state=planned` だが修正は着地済み。
  `createCodexOutputCapture()` が実在し、**実装コード自身が本 roadmap id を過去の動機として引用**している
- **`cheap-ai-latency-and-timeout-contract`** が本文で open と宣言されながら `roadmap:id` を持たず、
  **PL が構造的に採用できなかった**（`adopt_roadmap_item` は ledger 上の id 実在を検証する）
- **置換済みの優先順位表**が置換後の表より下に supersede マーカー無しで残っていた

---

## 4. 新規 item（11 件）と優先度

優先度は Severity だけでなく**実際の影響範囲と到達可能性**で決めた。

**優先度 1: 実動作上の安全性・Approval / Gate 境界**
1. `safe-work-only-not-applied-to-ai-cli` — `continue_safe_work_only` が `safeCommand.kind` にしか
   適用されず、implement Job は `kind: 'test'` なので通過して AI CLI がコードを書く。
   `REJECTED` も `policyMap` 経由で `continue_safe_work_only` へ落ちる
2. `review-gate-layers-implemented-but-unwired` — Alignment Checker / Safety Auditor / `processGate` が
   Job 経路で一度も走らず `alignmentRiskLevel` は固定値。Secret Scan は `diffText` を受け取らない。
   `safetyVerifier.overallPassed` は構造的に常に false で、**その迂回のために commit gate から
   必須成果物が外された**。Shadow Commit Gate は観測記録を残さない
3. `allowed-paths-empty-disables-file-change-guard` — 空配列で範囲チェックが消える

**優先度 2: Escalation / recovery / resume**
4. `pl-escalation-recorded-without-delivery` — 未配達でも `escalated` と記録し恒久除外する
5. `pl-resume-task-design-review-evidence-mismatch` — 復旧経路の 2 重実装
6. `cheap-ai-latency-and-timeout-contract` — 上記のとおり正式登録

**優先度 3: AI へ注入される Current Truth の誤情報**
7. `vps-operation-docs-current-truth` — **文書どおりに API を再起動すると CEO Escalation が届かなくなる**
8. `current-truth-dual-record-prevention` — 下記 5 章

**優先度 4: implementation ↔ docs 不一致**
9. `governance-and-spec-docs-current-truth-sweep` — **実装は変更しない**
10. `project-completion-badge-wording-correction` — `done` item の後ろに追記された訂正が 3 件とも未実施

**優先度 5-6: dead / orphan / obsolete と単純 cleanup**
11. `audit-2026-09-15-low-priority-cleanup` — **単独で着手せず、近くを触る通常開発のついでに**

---

## 5. 根本原因への対応方針（新しい Gate を作らない）

92 Finding の相当数が**1 つのパターン**から来ている。

> **新しい Current Truth を追記する一方で、同じファイル内の古い記述を残し、
> 1 ファイルに 2 つの真実が同居する。**

**重要な観察**: repository には**既に正しいルールがある**
（`development_rules.md` の「Current Truth優先 — 該当箇所そのものを現在の結論へ更新する」）。
足りないのはルールではなく、**置換できない場合（履歴を残す必要がある場合）の扱い**である。
そのため実務では追記が選ばれてきた。

**#211 が ledger についてはこれを解決した**（`state=` を正本とする）。
本項目はその方針を前提に、**ledger 以外の surface と機械側の 2 点だけ**を扱う。

**したがって新しい Review / Gate / Workflow / doc-lint 基盤は追加しない。**
「文書更新を強制する新しいゲート」を作れば、それ自体が次の二重正本になる。

- **(A)** `development_rules.md` に「追記を選ぶときは旧記述側に supersede マーカーと日付を付ける」を
  1 段落追加。`docs/adr/0001` / `0002` が既にこの形を実践しており、**手本が repository 内にある**
- **(B)** 既存の `pnpm roadmap:check` を既存 `ci.yml` に 1 step 追加
  （現在 CI は `typecheck` と `test` しか実行していない）
- **(C)** `extractTitle()` の破損修正（生成ブロックに `**` 不整合が 18 件残っている）

---

## 6. false positive

**「`cheapAiClient` が Linux production で Windows バイナリを解決する」→ false positive。**

VPS へ SSH せず、npm registry の実配布物で確定した:

- `opencode-ai@1.18.16` の `package.json` は `bin = {"opencode": "bin/opencode.exe"}` を
  `os: ["darwin","linux","win32"]` すべてに対して宣言している
- tarball に含まれる bin ファイルは `package/bin/opencode.exe` の**1 つだけ**
- `postinstall.mjs` は `sourceBinary = platform === "windows" ? "opencode.exe" : "opencode"` を
  **全 platform で `targetBinary = bin/opencode.exe` へコピーする**

すなわち Linux 上でも `bin/opencode.exe` が正規パスであり、中身は Linux バイナリである。
production で PL adoption がこの経路を通って成功している観測とも整合する。

**教訓**: 「`.exe` は Windows 専用」という命名からの推測が誤りだった。
監査時点でこれを Candidate に留め Confirmed と断定しなかったのは正しかった
（production ログの反証と突き合わせていたため）。
**不正確なのはコードではなく `tasks/roadmap.md` の記述**（`bin/opencode`）の方である。

---

## 7. 今回やらなかったこと（明記）

- **実装修正には着手していない。** Roadmap への反映で停止した
- **`9157afb`（監査時点の commit）を blind cherry-pick していない。**
  参照資料として意図と差分を読み、最新 master を正本として必要な変更だけを再適用した
- **他セッションの branch / WIP に一切触れていない。** 最新 `origin/master` から専用 branch を作った
- **他セッションが担当中の item（`adopted-item-blocked-by-stale-deferral-text`、
  PR #85 / #87 の憲法範囲表記）の scope・priority・state を変更していない**
- **`tasks/task_graph.md` / `tasks/active/` を変更していない**
  （`CLAUDE.md` §8 を実態へ合わせるかは判断事項として cleanup item に残した）
- **production への操作を一切行っていない**
- **新しい Gate / Review / Workflow / telemetry 基盤を 1 つも追加していない**
- **監査目的以外の Roadmap 整理をしていない**
