# 外部ハーネス代替検証：棚卸し・代替可能性・証拠ラダー（Tier 0〜2）・Roadmap 変更（2026-10-28 作成、2026-10-29 CEO 判断）

**状態:** CEO は 2026-10-29 に評価方法を指示した（0 章）。本 PR で行うのは、この記録の追加と、Tier 0 の Roadmap 項目 1 件の追加（4 章）だけである。**`execution-runtime-harness-bakeoff` の CEO HOLD は、本 PR では変更しない**（10 章）。
Goal・Design Philosophy・CEO Decision Authority・安全境界・既存 Gate はどれも変更しない。新しい Gate や安全機構も作らない。

**承認ルールの正本（2026-10-29 CEO 指示）:** 何に人の承認が要るか・誰が承認するか・承認が何を許可するか・いつ失効するかの正本は
`docs/project_memory/rules/approval_rules.md` と `specs/22_safety_approval_design_principle.md` だけである。
**本記録と `tasks/roadmap.md` は、独立した承認ルールを定義しない。** 本記録の Tier ごとの扱いは、既存の
Yellow Zone / Green Zone（`approval_rules.md`「CEOの承認が必要（Yellow Zone）」「承認不要（Green Zone）」）を
この件へ当てはめた結果であり、新しい Approval Tuple ではない。CEO が付した条件は、その個別承認に対する実施前の確認事項である。

- 基準 commit: `origin/master` 8e85f68c。
- 作成者: PL（Claude Opus）。r1〜r20 の draft は採用しない。採用しない理由と、その経緯は 5・6 章に記録した。

---

## 0. CEO 判断（2026-10-29）

1. r1〜r19 の execution-heavy な設計を、**Tier 0〜2 の証拠ラダー**に置き換える。Tier 3 は延期する。これは `execution-runtime-harness-bakeoff` という 1 項目の**評価方法の整理**であり、Goal・Design Philosophy・Constitution・Policy の意味は変えない。
2. **Tier 1 の実施を、個別に承認した（条件付き）。** Tier 1 は既存 `approval_rules.md` Yellow Zone「リポジトリ外への操作 — 新しい外部対象への操作」に当たるため CEO 承認が必要であり、CEO はこの 1 件について承認した。付した条件は「Production の credential がなく、network にも接続しない使い捨て環境」に限ることで、実行前に確認する（3-2）。**これは既存ルールに基づく個別承認の記録であって、承認ルールの変更ではない。** 実施は CEO の指示を受けた外部 session が行う。**bakeoff の HOLD（PL の採用を機械的に止める `state=deferred`）は、本 PR では変更しない**（10 章）。
3. **Tier 2 は、まだ承認していない。** Tier 2 は credential と有料 API を使うため、既存 Yellow Zone「外部サービス追加」「有料API / 課金発生」に当たる。Tier 0〜1 の結果で必要性が示され、共有 quota への影響が評価されてから CEO が判断する。

**合わせて指示された訂正:**
- Claude Code／Codex をすでに使っていることを、それらが本質的に信頼できる根拠にしない。リスクは「信頼できる vendor だから」という前提ではなく、**能力とアクセスを制限することで下げる。**
- Roadmap 項目は、追加する前に既存の Task・項目と照合する。可能なら既存項目を修正する。
- r1〜r19 の findings は、歴史的な evidence として残す。ただし、その中の execution protocol は採用しない。
- 20 ラウンドで収束しなかったことを、横断的なアーキテクチャ・review 責務の監査への evidence として記録する。その際、既存の Design Challenger 原則が実際に適用されたかを調べる。
- quarantine 中の Job は、既存の Lifecycle escalation の経路で解決する。並行する復旧 workflow は作らない。
- Tier 1 は、付された条件の確認を終えるまで実行しない。Tier 2 は、既存 Yellow Zone に基づく CEO 承認を得るまで実行しない。

---

## 1. 現行 AIteamOS の機能棚卸し（2026-10-28 時点。origin/master 67f9f351）

規模は src が約 92.3k LOC、test が約 113.4k LOC。SQLite の table は 27、CI workflow は 7 本ある。
「60日 touch」は、その単位の src パスに触れた commit の数である。パスが複数の単位に重なる場合があるため、単位をまたいで合計してはいけない。

| # | 機能単位 | src LOC | 60日 touch | 主目的 | 境界の強制手段 |
|---|---|---|---|---|---|
| 1 | Job 実行・cgroup containment | 7.2k | 56 | G3,G4 | **OS**（cgroup v2、env scrub） |
| 2 | Safety guards（Permission／File Change Guard） | 2.8k | 4 | G4 | **git＋Worker による事後の diff 検査**（fail-closed、CODEOWNERS で保護） |
| 3 | Approval Gate | 2.7k | 64 | G4 | コード＋credential |
| 4 | 承認・失敗の AI 説明 | 1.7k | 11 | G4,G6 | credential（説明は advisory） |
| 5 | Approval Level／Codex Independent Review | 4.7k | 17 | G4,G1 | commit gate はコード、verdict は LLM |
| 6 | AI CLI adapter | 1.8k | 10 | G5 | **CLI の sandbox flag** |
| 7 | Meta Review CI | 3.2k | 22 | G4,G1 | **GitHub の required check**。判断は LLM |
| 8 | Strategic review／materiality | 3.4k | 19 | G4,G1 | prompt／LLM |
| 9 | Design Review・repair | 5.3k | 94 | G3,G1 | アプリ内の状態機械 |
| 10 | PL 実行ループ | 4.7k | 74 | G3 | アプリ内 policy |
| 11 | Adoption・conflict・commit evidence | 3.8k | 39 | G3 | git evidence |
| 12 | Independent remediation | 2.2k | 13 | G3 | アプリ内 policy |
| 13 | Recovery | 5.1k | 89 | G3,G4 | アプリ内 admission |
| 14 | Operator request／chat | 1.2k | 3 | G4,G3 | credential allowlist |
| 15 | Roadmap ledger・sync | 3.1k | 26 | G3,G2 | コードによる検証＋規約（CI では roadmap:check を実行しない） |
| 16 | CTO AI・Context Pack・continuation | 2.8k | 33 | G2,G3 | prompt（Context Pack は CLI まで届いていない） |
| 17 | Project Memory・knowledge graph・principle ledger | 3.2k | 15 | G1,G2 | prompt（ledger は Gate ではなく測定） |
| 18 | Supervised delegation | 1.6k | 2 | G3,G5 | process（本番には未配線。respawn の欠陥あり） |
| 19 | Watchdog | 0.4k | 2 | G3 | process |
| 20 | 通知・outbox | 0.6k | 4 | G4 | — |
| 21 | External completion reconcile | 1.2k | 5 | G3,G5 | コード |
| 22 | Auth・credential class | 0.5k | 9 | G4 | **credential** |
| 23 | Storage（`sqlite.ts` が 8k LOC） | 10.5k | 127 | G6 | — |
| 24 | Core API・system state | 4.0k | 109 | G3,G4 | credential |
| 25 | Cross-task audit・deploy canary | 1.5k | 6 | G4,G1 | 決定的なスクリプト |
| 26 | MCP gateway | 0.5k | 2 | G5,G4 | credential |
| 27 | Mobile UI（Expo） | 10.2k | 41 | G4 | 人間の操作経路 |
| 28 | GitHub governance | 0.6k | 2 | G4 | **GitHub のサーバ側** |
| 29 | Lifecycle E2E harness | 1.4k | 11 | G6 | — |

**読み取り:**

1. 変更頻度が高いのは、自前で実装した状態機械（9・10・13・23・24）である。unique commit 単位の比率は Tier 0 で算出する（git 履歴だけで足りる）。
2. 境界の強制手段は 4 種類に分かれる。

   | 種類 | 単位 | 外部で代替できる可能性 |
   |---|---|---|
   | (a) OS／process による封じ込め | 1、6 | 候補の sandbox で代替できる可能性がある。Tier 1 の比較対象 |
   | (a′) Task 単位の path policy | 2 | **policy と、その正本である allowed／forbidden の定義は AIteamOS 側に残す。** 比較するのは強制の backend だけ。workspace 単位の sandbox は Task 単位の policy と等価ではない |
   | (b) API の認可 | 22、24、14、26、3 | 代替は検討しない |
   | (c) サーバ側の merge／deploy の強制 | 28、7、5 | 強制の仕組みは維持する。判断する主体（LLM）だけを比較対象にする |
   | (d) アプリ内 policy と LLM の判断 | 8〜13、15〜17 | 境界ではなく判断である |

### 1-1. 推奨分類（暫定）

この表は Tier 0 の出発点にすぎない。根拠・削減効果・難易度は Tier 0 で repo の根拠をもとに確定させる。

**目的:** 自前開発と保守の負担を減らす。ただし、自律開発・原則遵守・安全性・スマホ管理は維持する（2026-10-29 CEO）。

**分類:**
- **維持**: 自前で持ち続ける
- **置換候補**: 外部へ置き換えられる可能性がある
- **廃止候補**: 不要なので、なくせる可能性がある
- **保留**: 現時点では判断できない

**削減効果の見方:** 削減効果は「その単位をすべて外した場合の上限」として、src の LOC と 60 日間の touch 数で示す。touch 数は単位をまたいで重複して数えているので、合計しない。

**移行・廃止の判断:** 実際に移行するか、廃止するかは CEO が別途判断する。

| # | 機能単位 | 推奨（暫定） | 根拠 | 削減効果の上限 | 移行の難易度・リスク | 判断できない事項 |
|---|---|---|---|---|---|---|
| 1 | Job 実行・cgroup containment | 保留 | OS による強制で、descendant を確実に回収できる。候補の sandbox が同等かは実証されていない | 7.2k／56 | 高い。Worker の中核で、Production の封じ込めに当たる | Tier 1 の結果 |
| 2 | Safety guards | **維持**（policy の正本） | Task 単位の path policy は workspace 単位の sandbox と等価ではない | 2.8k／4（小さい） | — | 強制の backend を替えるべきか（Tier 1） |
| 3 | Approval Gate | **維持** | API の認可（境界の種類 b）。承認の正本である | — | — | — |
| 4 | 承認・失敗の AI 説明 | 保留 | 外部のチャット UI で代替できる可能性はあるが、Explainer の動作実績を確認していない | 1.7k／11 | 低い | 現在動作しているか |
| 5 | Approval Level／Independent Review | **維持**（commit gate） | 判定の強制はコードが担う。判断する主体だけは差し替えられる | — | — | 判断主体を差し替えるか（Tier 2） |
| 6 | AI CLI adapter | **維持** | 薄い差し替え点で、harness を交換できるようにする要（G5）である | 1.8k／10 | — | — |
| 7 | Meta Review CI | 置換候補（判断主体のみ） | 同一 SHA で verdict が反転した実績がある。強制の仕組み（required check）は GitHub 側にあり、維持する | 3.2k／22 | 中程度。reviewer の独立性と base 実行を保つ必要がある | Tier 2 の比較 |
| 8 | Strategic review／materiality | 一部は廃止候補 | materiality detector は observe-only で、CI に配線されておらず、M4 も未承認 | 3.4k／19 | 低い（配線されていないため） | strategic review 本体を残す価値 |
| 9 | Design Review・repair | **維持**（簡素化の対象） | 外部に同等品が見つからない。churn が最大で、保守負担の中心である | 5.3k／94 | — | 外部化ではなく簡素化で負担を減らせるか |
| 10 | PL 実行ループ | **維持** | 同等品が見つからない | 4.7k／74 | — | H-E（Tier 3） |
| 11 | Adoption・commit evidence | **維持** | git evidence と Roadmap の正本に直結する | 3.8k／39 | — | — |
| 12 | Independent remediation | 保留 | 9 と一体で評価する | 2.2k／13 | — | 9 の簡素化の結果 |
| 13 | Recovery | **維持**（簡素化の対象） | 同等品が見つからない。churn は 2 番目に大きい | 5.1k／89 | — | 同上 |
| 14 | Operator request／chat | 保留 | スマホから PL へ問い合わせる経路。外部アプリで代替できる可能性はあるが、credential の境界（種類 b）が関わる | 1.2k／3 | 中程度 | 外部アプリの権限制限 |
| 15 | Roadmap ledger・sync | **維持** | 正本である（G2・G3） | — | — | — |
| 16 | CTO AI・Context Pack | Context Pack は置換候補 | Context Pack は CLI まで届いていない。repo-native の注入方式（H-C）で代替できる可能性がある | 2.8k／33 の一部 | 低〜中 | 原則遵守を下げずに済むか（Tier 2） |
| 17 | Project Memory・knowledge graph | 正本は**維持**、一部は保留 | 正本は外へ移さない。knowledge graph 系の table が実際に読まれているか確認していない | 3.2k／15 | — | table が読まれている経路（Tier 0 でコードを確認） |
| 18 | Supervised delegation | 廃止候補 | 本番に配線されていない。`supervised_runs` は 0 件で、delegate.sh は Windows で壊れている | 1.6k／2 | 低い | `pl-review-process-supervision` と `deleg-001-watchdog-respawn` との関係（C-1〜C-13 の契約の扱い） |
| 19 | Watchdog | 保留 | 小さく、動いている | 0.4k／2 | — | — |
| 20 | 通知・outbox（LINE） | **維持** | 小さく、動いている。スマホ管理を担う | 0.6k／4 | — | — |
| 21 | External completion reconcile | **維持** | — | 1.2k／5 | — | — |
| 22 | Auth・credential class | **維持** | 境界（種類 b） | — | — | — |
| 23 | Storage | **維持**（簡素化の対象） | DB が正本である。`sqlite.ts` は 8k LOC で、churn が最大 | 10.5k／127 | — | 外部化ではなく分割・簡素化で負担を減らせるか |
| 24 | Core API・system state | **維持** | 境界（種類 b） | 4.0k／109 | — | — |
| 25 | Cross-task audit・canary | **維持** | — | 1.5k／6 | — | — |
| 26 | MCP gateway | **維持** | 小さい。外部 harness から読み取りで参照する経路になる（G5） | 0.5k／2 | — | — |
| 27 | Mobile UI | 保留 | merge／deploy の承認は GitHub Mobile へ寄せられる可能性がある（H-D）。job 内の承認は残る | 10.2k／41 の一部 | 中程度 | GitHub Mobile で environment を承認できるか |
| 28 | GitHub governance | **維持**（すでに外部） | — | — | — | — |
| 29 | Lifecycle E2E harness | **維持** | — | 1.4k／11 | — | — |

**暫定の見立て:**
1. 外部へ置き換えるだけで減る保守負担は、限られている（7・8 の一部・16 の一部・18）。
2. 保守負担の大半は、外部に同等品のない自前の状態機械（9・13・23・24）にある。負担を減らす主な手段は、外部化ではなく**簡素化**である可能性が高い。Tier 0 でこの点を churn の実数で確認する。
3. 安全境界（境界の種類 b、(a′) の path policy の正本、GitHub 側の強制）は、どの分類でも維持する。

---

## 2. 外部ハーネス・ツールの代替可能性一覧（2026-10-28 調査）

| 候補 | 置換しうる機能単位 | 強制手段 | 主なリスク |
|---|---|---|---|
| **Codex CLI**（exec／hooks／requirements.toml） | 1・5・6・18 | **OS sandbox**（Linux では bwrap＋seccomp）、approval policy、managed hooks [E1][E2] | リリースが週次で、モデルの退役も速い。VPS では AppArmor に阻止された実績がある [R1]。hooks は公式に「完全な境界ではない」とされている [E2] |
| **Claude Code**（-p／SDK／hooks） | 6・7・8・16・17 | PreToolUse hook による deny [E4]、bash に限った sandbox [E5] | Windows では sandbox が使えない [E5] |
| **GitHub ネイティブ**（Ruleset／Environments） | 3・27 の merge／deploy 承認、28 | **サーバ側の強制**、self-approval の禁止 [E10] | Mobile から承認できるかは [未検証] |
| **OpenCode** | 4・6・18 | tool／pattern 単位の permission だけで、**OS sandbox はない** [E13] | Go プランは beta [E15] |
| **Gemini CLI／agy／Jules** | 7 | 主に vendor 側 | 無料枠の縮小、hang、drift [未検証] |
| **OpenHands／Goose** | 1 | Docker（OpenHands）[未検証] | CLI 群を束ねる orchestrator ではない |
| **managed Agent Platform** | 1 | vendor 側 | Yellow Zone（外部サービス・課金） |
| **Repo-native knowledge**（AGENTS.md／Skills＋hook） | 16・17 の注入 | hook による注入 [E4][E2] | 遵守できているかは別途検証が必要 |

**仮説:**
- H-A 実行層は sandbox と hooks で代替できる。
- H-B review 層は base-branch で実行する review で代替できる。
- H-C 知識の注入は repo-native の仕組みと hook で代替できる。
- H-D merge／deploy の承認は GitHub で代替できる。
- H-E ループ全体を GitHub ネイティブで代替できる。

評価した候補の中には、既存の CLI 群を束ね、サーバ側の Gate とスマホ操作の両方を備える orchestrator は見つからなかった（評価対象外の候補は調べていない）。
正本を外部へ移さない方針は、既存の「Execution Runtime Boundary」節に従う。

**Evidence（参照日 2026-10-28。調査サブエージェントが一次資料を読んだもの。版は、手元で確認した codex-cli 0.146.0 以外は未観測）:**
- E1 https://learn.chatgpt.com/docs/changelog
- E2 https://learn.chatgpt.com/docs/hooks
- E3 https://learn.chatgpt.com/docs/pricing
- E4 https://code.claude.com/docs/en/hooks
- E5 https://code.claude.com/docs/en/sandboxing
- E9 https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- E10 https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments
- E13 https://opencode.ai/docs/permissions/
- E15 https://docs.opencode.ai/docs/go
- R1 `tasks/roadmap.md` の `codex-sandbox-off-deprecated-landlock`（2026-09-07 実測）

**版を観測していない主張と、[未検証] の主張は、選定の根拠に使わない。**

---

## 3. 証拠ラダー（Tier 0〜2）

方針: **小さく試してから進む。** 各 Tier の結果を見て、次の Tier が必要か、実施してよいかを判断する。

| Tier | 内容 | 状態 | 実施する主体 | 安全の担保 |
|---|---|---|---|---|
| **0** 文書評価 | repo と記録だけで行う評価（下記） | **承認不要**（既存 Green Zone「ドキュメント更新」「Task作成・更新」） | PL が自律採用する（通常の Tier A 項目。docs のみ） | 既存の Gate と Tier A の境界 |
| **1** credential を使わない機構 PoC | 封じ込めの障害を、モデルを呼ばずに再現する | **CEO が個別に承認済み（条件付き）**。該当する既存ルールは Yellow Zone「リポジトリ外への操作」。HOLD は変更していない（10 章）。実行前に条件を確認する（3-2） | 外部 session | 使い捨て環境に Production の credential がなく、network にも接続しない |
| **2** credential を使う比較 | review 層と原則伝達の比較 | **未承認**（該当する既存ルールは Yellow Zone「外部サービス追加」「有料API / 課金発生」） | — | Tier 0〜1 の結果と quota 評価を踏まえて CEO が判断する |
| 3 | 外部へ書き込む agent を使う PoC | **延期** | — | — |

### 3-1. Tier 0（文書評価）の範囲

repo・記録・git 履歴だけを使う。外部への接続も Production への接続も行わない。

1. **機能単位ごとの代替可能性と推奨分類の表。** 1-1 の暫定表を出発点にして、各単位について次の項目を repo の根拠で確定させる。
   - どの候補が何を代替しうるか
   - 等価であることを示す既存のテストと、その責務の owner
   - 代替した場合に失う責務
   - 推奨分類と、その根拠
   - 保守負担の削減効果
   - 移行の難易度とリスク
   - 現時点では判断できない事項
2. **churn の再集計。** unique commit 単位で行う（パスと単位の対応表と、使った git コマンドを添える）。
3. **Tier 1 の fixture 一覧。** `execution-runtime-harness-bakeoff` の障害再現リストから、モデルを呼ばずに再現できる項目を選び出す。各項目について、AIteamOS で実際に起きた障害（decision record・roadmap の記録）との対応を示す。さらに、Tier 1 の環境条件（Production の credential なし・network なし）で実行できるかを判定する。
4. **Tier 2 の必要性と quota 影響の見積り。** Tier 1 では答えられない問いを列挙し、Tier 2 で必要になる呼び出しの回数と量を見積もる。見積りは、Production の Codex／Claude の利用と共有する quota への影響として示す。**この項目は、CEO が Tier 2 を判断するための材料である。** Tier 2 の実施を前提にしない。

### 3-2. Tier 1 の個別承認に付された条件と、実行前の確認

**該当する既存ルール:** `approval_rules.md` Yellow Zone「リポジトリ外への操作 — 新しい外部対象への操作」。
Tier 1 はこれに当たるため CEO 承認を要する。**本節は、その個別承認に CEO が付した条件の記録であり、
新しい承認ルールではない**（承認ルールの正本は冒頭に記したとおり `approval_rules.md` / `specs/22`）。

**条件（CEO 2026-10-29、この 1 件に対して）:** 使い捨て環境であること、Production の credential がないこと、network に接続しないこと。

**実行前の確認**（既存のツールで確認し、結果を記録に残す。新しい安全機構は作らない）:
- 環境が使い捨てであること。作成と破棄の手順を、結果の記録に書く。
- **Production の credential がないこと。** 環境内に、VPS への ssh 鍵、gh／AIteamOS-bot の token、Production の env、provider（Claude／OpenAI）の認証情報のどれもないこと。host のファイルシステム（PC の profile を含む）が環境内から見えないこと。
- **network に接続していないこと。** 環境内から外部へ到達できないこと（実際に接続を試して失敗することを確認する）。必要なツールは、network を切る前の build 段階で入れる。この段階でも secret は使わない。
- どれか 1 つでも確認できない場合は、実行しない。

**既知の制限:** PC 上の使い捨て環境は、Production の kernel・cgroup delegation・AppArmor の設定と一致しない。Tier 1 の結果は「機構として、その挙動を持つかどうか」の証拠であり、Production 上で同じ挙動になることの証拠ではない。

### 3-3. 信頼についての訂正（CEO 指摘）

r20 の再評価では「Claude Code／Codex は既に Production で使っているから、信頼できない候補として扱う必要はない」と書いた。**これは誤りであり、撤回する。**
過去に使ってきたことは、信頼できる根拠にならない。リスクは**能力とアクセスを制限することで**下げる。
- Tier 1 では、候補に credential も network も与えない。だから、候補が何をしても届く範囲がない。
- Tier 2 を実施する場合も同じ考え方をとる。vendor が誰であっても、Production の credential に届かないこと、外部へ書き込めないこと、quota を使える量に上限があることを、アクセスの制限で保証する。具体的な方式は、Tier 2 を判断する時点で決める。
- 同じ指摘は現行の構成にも当てはまる。Production の Worker は、Claude と Codex の認証情報を `HOME` 経由で渡している。この状態は「既に使っているから」安全なのではない。現行の封じ込め（cgroup・env scrub・File Change Guard）が実際にどこまで制限できているかの問題である。**この観点は 6 章の監査入力に含める**（新しい項目は作らない）。

---

## 4. Roadmap 変更（既存の Task・項目との照合結果）

### 4-1. 照合

- **Production の Task**（2026-10-28 07:40Z の read-only 照会で、archived ではない Project の未完了 Task は 8 件）: 外部ハーネスの評価に当たるものはない。
- **Roadmap 項目**: 関連する既存項目は次のとおり。

| 提案（r20 の再評価時点） | 既存の項目 | 扱い |
|---|---|---|
| Tier 1（機構 PoC） | `execution-runtime-harness-bakeoff`（deferred、CEO HOLD）。評価の方法（実際の障害を再現して比較する）と障害再現リストを、そのまま含んでいる | **既存項目で扱う。新しい項目は作らない。** 本 PR では変更しない。HOLD の解除をどう記録するかは 10 章で判断する |
| Tier 0（文書評価） | 実行層については、bakeoff の評価方法の前段に当たる。review 層・知識層・承認 UI には、それぞれ部分的に重なる項目がある（`pl-console-candidate-evaluation`：PL Console の UI のみ。`system-one-decision-layer-generalization`：判断 engine のみ。`opencode-feasibility-reviewer`：OpenCode のみ）。どれも deferred で、範囲が狭い | **新規 1 件**（`harness-pivot-desk-evaluation`、planned）。全層を横断する文書評価は既存のどの項目の範囲にも入らないため。重なる 3 項目は変更せず、本文で参照するだけにする |
| Tier 0 の fixture／比較表の雛形 | 同上 | 新規項目に統合する（r20 で提案した 2 件目は作らない） |
| Tier 2 | `independent-review-verdict-instability`、`opencode-feasibility-reviewer`、`project-auto-gemini-worker-eligibility`（いずれも deferred） | **項目は作らない**（CEO が未承認のため）。必要性は Tier 0 の 4 番目の成果物で示す |

**結果: 新規は 1 件。既存項目は 1 件も変更しない。** r1〜r19 で提案した延期・統合の分類（新規 14〜16 件と、延期 2〜6 件）は、すべて取り下げる。

### 4-2. 実際の変更（本 PR）

1. `harness-pivot-desk-evaluation`（新規、planned）: 3-1 にある 4 つの成果物を作る。docs だけを扱う項目である。
2. `docs/PROJECT_CURRENT_STATE.md` を再生成する（`roadmap:sync`）。

---

## 5. r1〜r19 の findings（歴史的 evidence。execution protocol は採用しない）

Codex gpt-5.6-sol による独立レビューは、r1〜r19 がすべて changes_requested だった（r20 はセッション終了で verdict が出ていない）。指摘は合計で約 72 件ある。
**今後の作業でも有効な findings** を次に残す。それ以外の findings は、採用しない execution protocol の内部の整合に関するものなので、ここには残さない。

| round | finding | 今後の扱い |
|---|---|---|
| r1 | 解決済みとした `design-review-runner-production-timeout` には、まだ作業が残っていた（deadline で retry を縛る部分） | 訂正済み。項目は planned のまま |
| r1 | Tier A の Job は、外部のアカウントや外部の実行に届かない。検証の実行を PL の 1 Task にまとめると、完了できない | Tier 0 は repo 内で完結させ、Tier 1 は外部 session が行う（3 章） |
| r1・r2 | CEO が決めた項目や、live な欠陥を、検証項目へ吸収・延期してはいけない（`principle-registry-coverage-and-threshold-review`、`aiteamos-self-development-tier-b`、`project-workspace-isolation`、`project-auto-recovery-e2e` など） | 既存項目の state は変えない（4 章） |
| r1 | bakeoff には、CEO が定めた評価条件（障害再現リスト・候補・Phase）がある。これを統合して範囲を狭めてはいけない | 既存項目を修正し、評価条件はそのまま残す |
| r2 | 対照群を置かずに、過去 30 日の集計と比べても、同一条件の比較にならない | Tier 1 は、同じ fixture を現行の機構と候補の両方に適用する。統計的な厳密さが必要かは Tier 2 で判断する |
| r4 | `failure-explanation-pregeneration` の延期案では、代替の Explainer が実際に動くかを確かめていなかった | 延期しない |
| r5 | PC には VPS への ssh 鍵と bot の token がある。PC 上で候補を直接動かすと、Production に届いてしまう | Tier 1 に付された条件（Production の credential なし）として実行前に確認する |
| r6〜r8 | 認証された環境の中では、候補が provider の credential を読める | Tier 1 は credential なしで行う。Tier 2 を判断するときの論点として残す |
| r9 | 共有 quota を使い切ると、Production の review や Job を止めうる | Tier 2 の判断材料（Tier 0 の 4 番目の成果物） |
| r17 | hosted 候補（GitHub 上の agent、managed Platform）では、ローカル側の制御を適用できない | 本計画の対象外（Tier 3 以降） |
| r19 | 現行の ssh は書き込みも service 操作もできる。V0 の抽出に使うのは不適切である | Tier 0 は git 履歴と記録だけを使い、Production へ接続しない |
| r19 | PL の採用は決定的でない。また、quarantine された Job が project を占有している間は、何も採用されない | 7 章（前提条件として扱う） |

---

## 6. 20 ラウンドで収束しなかったことの分析（横断監査への evidence）

**この記録の位置づけ:** 次回の Cross-Task Drift Audit（`cross_task_drift_audit_design.md`）への入力である。
同監査の 1 章「現状のレビュー責務」には、Design Challenger が機構の 1 つとして載っている。7 章で定めた「3 回目の監査記録での仕組みの評価」の材料にする。

### 6-1. findings の分類（概数）

| 分類 | 件数 | 内容 |
|---|---|---|
| 本物の欠陥 | 約 12 | 5 章の表 |
| 範囲の拡大 | 約 15 | 統計の厳密さ、Goal の網羅、portfolio 比較、hosted 候補 |
| 要件どうしの衝突 | 約 8 | 「新しい subsystem を作らない」と「信頼しない候補を実行権限で封じる」の衝突。「bakeoff の範囲を維持する」と「adapter を作らない」の衝突。「自律採用」と「外部アカウント」の衝突 |
| review が生んだ複雑さ | 約 35 | PL が追加した機構（run record、preflight、manifest、publisher、scorer の分離など）に対する、次のラウンドの指摘 |

### 6-2. 既存原則は実際に適用されたか

| 原則 | 適用されたか | 実態 |
|---|---|---|
| AGENTS.md 3-2 Design Challenger「Correctness／Simplicity／Naturalness の 3 観点」 | **されなかった** | review prompt は Correctness・Safety・既存仕様との整合しか問うていない。Simplicity は r1 で「より簡単な案はないか」と 1 項目問うただけで、r2 以降は一度も問うていない。Naturalness は一度も問うていない |
| 同「複雑な解決策を評価する前に、複雑な状態そのものを消せないかを確認する」 | **されなかった** | PL は findings の大半に対して機構を足すことで応じた。状態を消す判断（agent を外部へ書き込ませない、credential を渡さない、など）をしたのは r17・r18 になってからで、それも findings に押されて部分的に行っただけだった |
| 同「『非自明なら毎回』実行しない。反証の期待価値が高い場合に限る」 | **されなかった** | material redesign があるたびに、機械的に再 review を回した。期待価値は評価していない |
| 同「PL の詳細な推論過程は渡さず、問題・制約・Evidence・提案設計だけを渡す」 | **一部だけ** | r2 以降は、前回の findings と PL の対応の主張を渡した。r7 では PL の反論を渡し、r16 以降は「実装詳細は prep の範囲」と review の範囲を誘導した。独立性と範囲の両方が揺らいでいる |
| 同「既存の Multi-stage Review と同じ論点を、理由なく重複確認しない」 | 部分的 | 同じ reviewer・同じ文書・「新しい問題を探せ」という指示が続き、指摘が途切れなかった |
| Constitution 3.14「blocker の修正 → 修正箇所を中心に再 review → blocker 0 で終了。理由なく同じ結論の review を繰り返さない」 | **形骸化した** | 修正のたびに文書の面積が増え、「修正箇所」が毎回新しい blocker の供給源になった。停止条件がなかった |
| Constitution 3.16「複雑な状態を処理する仕組みを足す前に、その状態を発生させない設計を検討する」 | **されなかった** | 6 つのチェックのうち、1（そのケースを許可しない）と 6（過剰設計をしていないか）を最初に適用していれば、r3 以降の構造は不要だった |
| rules/003 Codex Usage Saving Policy | **違反** | 共有 quota で 20 ラウンド回した（1 ラウンドの transcript は 0.3〜1.4 MB） |

### 6-3. 根本原因（PL の責任）

1. **階層の取り違え。** 方針を判断するための文書に、run 時の安全仕様を書き込んだ。その結果、reviewer は文書を「実行される安全仕様」として審査した。
2. **threat model がなかった。** 何を守るのか、何を守らなくてよいのかを書かなかった。そのため、あらゆる能力が findings の対象になった。
3. **停止条件と収束の指標がなかった。** 範囲の拡大と、review が生んだ複雑さを区別しないまま、指摘をすべて同じ重みで受け入れた。

### 6-4. 監査で確認してほしい問い（提案。新しい Gate や工程は作らない）

- Design Challenger の 3 観点は、実際の prompt に含まれているか（今回は含まれていなかった）。
- material redesign による再 review に、期待価値の判断と停止条件はあるか。
- PL が findings をどう処理したかを「状態を消した／機構を足した」で分けて記録すれば、過剰設計を早く検出できるか。

---

## 7. 進行中の状態と quarantine

- Job `71538c24`（Task `ffd63184`）の `output_overflow` による quarantine は、**既存の Lifecycle escalation の経路で、別の session が対応している**（#435 を修正中で、PR 実行の Meta Review で blocked。#437 は merge 済み）。本作業ではこれに関与せず、並行する復旧 workflow も作らない。
- この quarantine が解けるまで、PL は唯一の running Project で何も採用できない。したがって、本 PR を merge しても、`harness-pivot-desk-evaluation` はすぐには採用されない。

---

## 8. やらないこと・未確定事項

- **やらないこと:**
  - Tier 1・2 の実行（Tier 1 は付された条件の確認を終えるまで、Tier 2 は CEO 承認を得るまで行わない）
  - 新しい Gate や安全機構の追加
  - 再 review の繰り返し
  - Production の変更
  - 既存項目の state 変更
  - 外部ハーネスの導入
- **未確定（Tier 0 で整理する）:**
  - Tier 1 の環境の具体的な方式（network を切った container か、network adapter を持たない VM か）
  - cgroup containment を Tier 1 の環境で再現できるか
  - 各候補の機構試験（`codex sandbox -- <cmd>` など）が、モデルを呼ばずに成立するか

## 9. 作業上の逸脱の記録

- **AGENTS.md 3-2:**
  - 調査は OpenCode Go にも Codex Sol にも委任せず、Claude サブエージェントに行わせた。OpenCode Go はモデルが 0 件で、委任を試していない。
  - 承認された例外ではない。今後は 3-2 に従う。
- **rules/003:** Codex の review を 20 ラウンド回した（6-2）。

**いずれも終了している（未解決の例外を残さない）。** 逸脱していた作業は r20 で終了し、本 PR では
サブエージェント調査も Codex ラウンドも行っていない。**既存ルール（AGENTS.md 3-2・`rules/003`）は
そのまま有効で、本記録はそこに例外・免除・新しい上限を一切作らない。** 以後は既存ルールどおりに委任する。
なぜ原則が効かなかったかの分析は 6 章にあり、横断監査の入力として
`cross_task_drift_audit_design.md` 7 章から参照する（新しい Gate や工程は作らない）。

## 10. 残る CEO 判断事項

### 10-1. HOLD と承認の owner（2026-10-29 CEO 判断で決着。未解決事項ではない）

**CEO 判断（2026-10-29）:** 承認の owner は**既存の Decision Authority の正規ルール側**に置く。
`approval_rules.md` と `specs/22` を正本とし、**Roadmap や decision record に独立した承認ルールを作らない。**
今回の CEO 判断は既存ルールの範囲内なので、**正規ルール自体は変更しない。**
新しい承認機構も、重複した authority 定義も追加しない。

**したがって、初版で挙げた選択肢のうち (a) は採らない。** `tasks/roadmap.md` と
`docs/project_memory/decisions/` を CODEOWNERS へ加えることはしない。CODEOWNERS は 2026-10-08 の
CEO 決定により「authority / cage を定義・実装する正本だけを載せる」面であり（`.github/CODEOWNERS` の
当該節）、記録・台帳はそこに載らない。Human Gate を得ることだけを目的にした保護対象ファイルの追加は
`docs/meta_reviewer/prompt.md` が manipulation として禁じている。

**正規の経路は、すでに 2 つある（どちらも既存のもの。新設しない）:**

1. **承認ルール自体を変える場合** — `docs/project_memory/rules/approval_rules.md` または
   `specs/22_safety_approval_design_principle.md` を、実装・記録と同じ PR で変更する。
   両ファイルは CODEOWNERS 対象なので、**code-owner review が必ず要る**（`prompt.md` の
   「Approval Tuple を実際に変える変更（A）の出し方」に一致する）。
2. **ルールを変えない個別承認・HOLD の解除** — CEO が GitHub 上で行う（初版の (b)）。
   AI が代わりに書き換えない。

**「正規の経路がない」という初版の見立ては撤回する。** AI が CEO HOLD を解除しようとした場合、
変更ファイルが CODEOWNERS 外である限り Meta Review が fail closed で止める。これは 2026-10-08 の
設計どおりで、初版 `1ff0bc31` の BLOCKED がその実証である。CEO 自身は GitHub 上でいつでも変更できる。
よって enforcement の欠落ではなく、**未解消の矛盾でもない。**

**Tier 1 に HOLD の解除は要らない。** `state=deferred` は PL の自律採用を機械的に止めるためのもので
（`apps/api/src/pl/adoptionStep.ts` の allowlist）、CEO が承認した外部 session の実施を妨げない。
PL が Tier 1 を採用する必要が生じたときに、初めて上記 2 の経路で CEO が state を変更する。

**本 PR が authority に対して行っていないこと:** Approval Tuple (a)〜(d) の変更／canonical rule
（`approval_rules.md`・`specs/22`）の変更／CODEOWNERS・Ruleset・保護設定の変更／既存 Gate・
Safety boundary の変更／既存項目の state 変更。記録しているのは、既存 Yellow / Green Zone を
この件へ当てはめた結果と、CEO の個別承認 1 件である。

### 10-1-1. 初版（`1ff0bc31`）で何が起きたか（経緯の記録）

**初版の結果:** PR #440 の初版（`1ff0bc31`）には、bakeoff の HOLD を条件付きで解除する記述が入っていた。これに対し、Meta Review（PR 実行側と base 側の両方）は BLOCKED を返した。
- 判定は DA (1)／(2) で、欠陥の指摘はなかった。
- BLOCKED の理由は、Human Decision Authority が必要と判定されたのに、変更されたファイルがどれも CODEOWNERS の対象ではなかったことである。

**照合の結果:**
- 判定の中身は妥当である。CEO 自身がかけた HOLD を解除することは、`specs/22` §1-2 の「CEO が明示的に Human-only と指定した事項」にあたり、A に該当する。
- fail closed になるのは、2026-10-08 の CEO 決定どおりの設計である。Human Decision Authority は CODEOWNERS と code-owner review に委ねられている（`autoReview.ts`）。
- Roadmap の HOLD（`tasks/roadmap.md`）も decision record（`docs/project_memory/decisions/`）も CODEOWNERS の対象ではない。初版ではこれを「正規の経路がない」と読んだが、**その読みは誤りだった**。正しい経路は 10-1 の 1・2 であり、AI による HOLD 解除が fail closed で止まること自体が設計どおりの enforcement である。

**本 PR の対応:**
- HOLD の変更を本 PR から外し、Tier 0 の文書評価だけを残した。Tier 1 は Tier 0 の成果物（fixture と環境の判定）が揃うまで実行しないので、今の時点で HOLD を解除しておく必要はない。
- CEO が個別承認に付した条件は 0 章と 3-2 に残した。ただし、repo 上の HOLD は変えていない。
- Human Gate を通すためだけに、保護対象のファイルを編集したり、CODEOWNERS を追加したりはしていない（`docs/meta_reviewer/prompt.md` の manipulation 規定に従う）。

**初版が CEO へ出した問い（HOLD 解除をどう記録するか）は、2026-10-29 の CEO 判断で決着した。** 内容は 10-1 のとおり。
(a)（Roadmap・decision record を CODEOWNERS へ加える）は採らない。既存の 2 経路に従う。

### 10-2. 引き続き未決のもの

- Tier 2 の承認（Tier 0 の 4 番目の成果物を見てから判断する）
- 1-1 で廃止候補・置換候補とした単位について、実際に移行・廃止するか（Tier 0 の確定版を見てから判断する）
