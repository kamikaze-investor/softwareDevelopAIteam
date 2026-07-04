# Multi-AI Step Review Flow 仕様書 v1

**作成日**: 2026-07-02
**目的**: AIチームOSにおいて、Claude Sonnetによる実装を安全かつ低コストに進めるためのMulti-AIレビュー運用フローを標準化する。

---

## 1. 目的

危険な変更を早期に検出しつつ、ChatGPTレビューのAPIコストを抑え、Claude Sonnetの実装速度を活かす。Gemini Flashで軽量レビューと重要度判定を行い、コミット直前に必要な情報だけをChatGPTへ渡す。高リスク作業はCEO承認必須、中リスク作業は事後報告で進める。ユーザーを毎回の伝令役から外す方向に進める。

## 2. 基本思想

役割分離:

| 役割 | 責務 | 最終承認権限 |
|---|---|---|
| **Codex** | 通常実装担当。既存実装に沿った小さな変更・軽微修正・テスト修正・型エラー修正・ドキュメント更新。目的外の改善や新機能追加は行わない。DB/認証/権限/外部サービス/課金/本番/package変更/破壊的変更/設計判断が必要な変更を見つけたら無理に進めずClaudeまたはレビューへ上げる | なし |
| **Claude Sonnet** | 設計・進行計画・危険箇所担当。Step単位の実装・テスト・報告・修正案に加え、Codexで処理できる通常実装か自身が扱うべき危険箇所かの分類、Codexへの作業指示作成も担う | なし（自分の変更を最終承認しない） |
| **Mechanical Safety Checks** | 機械的な危険検出（diff・禁止ファイル・AV-001・typecheck・test・Risk Scan・secret漏洩等） | 判断ではなくfactsを出力 |
| **Gemini（低コストなレビュー・監査レイヤー）** | 単一の「判断担当」ではなく、用途に応じて複数の監査機能を担う低コストレイヤー: Risk Review・Alignment Review・Meta Review・preReview・postReview・Report Translation（詳細は2-2章） | なし（安く早く危険なズレを検出するのみ。warning/uncertain/blockedはClaude/ChatGPT/人間へエスカレーション） |
| **ChatGPT** | 重要判断・コミット前判断・人間向け整理担当。コミット直前の判断整理・次工程設計。全Stepの要約パケットを読み、コミット可否・CEO承認要否・次Stepを判断 | 高リスクはCEO承認を要求 |
| **Human / CEO** | Goal/Design Philosophy変更・外部サービス・課金・本番影響・認証権限・破壊的変更・AIレビュー同士の判断が割れた場合の最終判断 | 最終承認者 |

重要な原則:
- Codexは通常実装のみを担当し、危険箇所・設計判断は自己判断で進めずClaudeへ上げる
- 実装者であるClaude Sonnetは、自分の変更を最終承認しない
- Geminiは安価な監査レイヤーであり、最終判断者ではない（「判断レビュー担当」ではなく「低コストなレビュー・監査レイヤー」として扱う）
- ChatGPTは最終判断レビュー担当だが、高リスク案件ではCEO承認を要求する
- 機械チェックでNGが出た場合、AIレビューがOKでも自動進行しない

## 2-2. Gemini（低コストなレビュー・監査レイヤー）と既存実装の対応

Geminiは以下の用途で使われるが、いずれも「安く早く危険なズレを検出する」という同一の役割の応用であり、別々の新規レビュー機構ではない。既存実装との対応は以下の通り（新規追加ではなく既存コンポーネントの呼称整理）。

| 用途 | 対応する既存実装 | 層 |
|---|---|---|
| Meta Review | `docs/meta_reviewer/prompt.md` + `apps/worker/src/metaReviewer/runner.ts`（憲法裁判所。Cage弱体化・権限境界変更を検出） | Safety Gate / Risk Control |
| Risk Review | `apps/worker/src/approvalLevel/targetProjectRiskScan.ts`（severity付きリスク検出） | Safety Gate / Risk Control |
| Alignment Review | `apps/worker/scripts/alignmentCheck.ts`（設計思想との整合性確認。未コミット・CEO判断待ち） | Safety Gate / Risk Control |
| preReview / postReview | `apps/worker/src/approvalLevel/preReviewer.ts` / `postReviewer.ts`（blocked:trueを返す権限を持つ既存Gemini Reviewer） | Safety Gate / Risk Control |
| Gemini Flash Stepレビュー | 6章参照（停止権限なしの重要度判定） | Review Orchestration / Decision Routing |
| Report Translation | 未実装（新規・低リスク）。技術ログ・変更内容・テスト結果・安全チェックリストを非エンジニア向けに翻訳する用途に限定し、コミット可否等の最終判断には使わない | Review Orchestration / Decision Routing |

**重要:** Meta Review・Risk Review・Alignment Reviewは全てSafety Gate / Risk Control層に属し、本仕様書が新設する層ではない。本仕様書が新設するのはGemini Flash StepレビューとReport Translationのみであり、いずれも停止権限を持たない。

## 2-1. レイヤー構造: Safety Gate/Risk Control と Review Orchestration/Decision Routing

本仕様書を正しく位置づけるため、AIチームOSには性質の異なる2つの層が存在することを明確にする。

| 層 | 目的 | 構成要素（既存実装） | 停止権限 |
|---|---|---|---|
| **Safety Gate / Risk Control**<br>（危険変更を検出・停止する安全チェック層） | 機械的・決定的に危険な変更を検出し、必要なら実行を止める | Mechanical Safety Checks（`safetyVerifier.ts`）、Mechanical Gate（`approvalLevelClassifier.ts`）、Risk Scan（`targetProjectRiskScan.ts`）、commitGate（`commitGate.ts`）、AV-001検出、secret scan、test/typecheck | あり（factsに基づき機械的にblock） |
| **Review Orchestration / Decision Routing**<br>（実装報告を読み、重要度・次工程・ChatGPTレビュー要否・CEO承認要否を整理する判断レビュー層） | Safety Gate層が出したfactsと実装報告を読み、重要度判定・次工程設計・エスカレーション要否・CEO承認要否を「整理」する | Gemini Flash Stepレビュー（新規概念）、Final Review Packet（新規概念）、ChatGPT最終判断レビュー（新規概念）、次Stepプロンプト生成（新規概念） | なし（提案・整理のみ。最終停止権限はSafety Gate層とCEOに残る） |

**本仕様書（Multi-AI Step Review Flow v1）が主に対象とするのは Review Orchestration / Decision Routing 層である。** Safety Gate / Risk Control層はレビューの「材料（facts）」を提供する既存コンポーネントであり、本仕様書によって変更・拡張されるものではない。

**既存の`preReviewer.ts` / `postReviewer.ts`について:** これらはGemini経由のレビューアダプターだが、`blocked: true`を返すことで実行をブロックする権限を持つ、Safety Gate / Risk Control寄りの既存コンポーネントである。本仕様書が新たに定義する「Gemini Flash Stepレビュー」（停止権限を持たず、重要度・ルーティングを提案するのみ）とは役割が異なるため、**同一視しない**。両者は名称が似ているが別物として扱う。

## 3. 全体フロー

```
1. Claude SonnetがStep単位で実装する
2. Mechanical Safety Checksを実行する
3. Gemini Flashが軽量レビュー・重要度判定を行う
4. SonnetがGeminiの指摘を受けて修正する
5. 次Stepへ進む
6. 全Step完了後、SonnetがFinal Review Packetを作成する
7. Gemini FlashがFinal Review Packetの抜け漏れを確認する
8. ChatGPTがFinal Review Packetをレビューする
9. 必要ならCEO承認
10. コミット
```

## 4. Step単位の実装フロー

1 Stepの理想範囲: 変更対象ファイルが少ない・目的が明確・テスト可能・失敗時に戻しやすい・AV-001や認証・DB・workerなど危険領域に触る場合は事前承認済み。

```
Step N:
Claude Sonnetが実装
↓
typecheck / test / diff / Risk Scan / secret scan 等を実行
↓
Claudeが実装報告を出す
↓
Gemini Flashが軽量レビュー
↓
Gemini判定が low なら次Step候補
Gemini判定が medium なら必要修正・事後報告候補
Gemini判定が high ならChatGPTまたはCEOへエスカレーション候補
↓
Sonnetが必要修正
↓
次Stepへ
```

## 5. Mechanical Safety Checks

機械的に事実を検出する層。判断ではなくfactsとして扱う。

対象:
```
- git diff --name-only
- git status --short
- 禁止ファイルチェック
- AV-001対象ファイル検出
- typecheck結果
- test結果
- Risk Scan結果
- secret漏洩チェック
- package.json / lockfile変更検出
- DBスキーマ変更検出
- worker / jobRunner / commitGate / safetyVerification変更検出
- リポジトリ外操作検出
```

出力例:
```
changedFiles:
- apps/api/src/index.ts
- apps/api/src/routes/health.ts

av001Touched: true
tests: PASS
riskScan: medium
secretLeakDetected: false
```

**重要:** Mechanical Safety ChecksでNGが出た場合、Gemini FlashやChatGPTがOKと言っても自動進行しない。

## 6. Gemini Flash 軽量レビュー

**役割定義（Review Orchestration / Decision Routing層）:** Gemini Flash Stepレビューは、Safety Gate層ではない。危険変更の最終判断者でも停止権限を持つ機構でもなく、**Stepごとの軽量な判断レビュー・重要度判定**を行うのが役割である。危険検出そのものはMechanical Safety Checks（Safety Gate層）が担い、Gemini Flashはその結果と実装報告を読んで「重要度」と「次に何をすべきか」を整理する。

**既存の`preReviewer.ts`/`postReviewer.ts`との違い:** 既存実装はblocked:trueで実行を止める権限を持つSafety Gate寄りのコンポーネントであるのに対し、本仕様書のGemini Flash Stepレビューは停止権限を持たない一次判定・提案のみのコンポーネントである（詳細は2-1章）。

目的: Claude実装報告の妥当性確認・機械チェック結果の読み取り・重要度の一次判定・修正が必要な点の指摘・ChatGPTへ上げるべきか判定・CEO承認が必要そうか判定。

出力形式:
```json
{
  "importance": "low | medium | high",
  "routing": "proceed_candidate | fix_required | escalate_to_chatgpt | require_ceo | stop",
  "summary": "短い要約",
  "concerns": ["懸念点"],
  "requiredFixes": ["必要修正"],
  "escalationReason": "ChatGPT/CEOへ上げる理由。不要ならnull",
  "confidence": "low | medium | high"
}
```

**できる:** 重要度判定・修正提案・ChatGPTへのエスカレーション提案・CEO承認が必要そうな点の指摘
**できない:** コミット承認・CEO承認の代替・high riskの解除・Mechanical Safety ChecksのNG上書き・Claudeへ自動で次実装を指示する

## 7. Sonnetの役割と制約

**できること:** Step単位の実装・テスト追加・typecheck/test実行・差分報告・Gemini指摘への修正・次Step案の提案・Final Review Packetの作成

**できないこと:** 自分の変更を最終承認する・high riskを自己判断で解除する・CEO承認が必要な変更を承認済み扱いにする・GeminiやChatGPTレビューを省略する判断を単独で行う・AV-001/認証/DB/外部公開/自動停止などを承認なしで変更する

Sonnetは「提案」はできるが、「承認」はできない。

## 8. ChatGPT 最終判断レビュー

**役割定義（Review Orchestration / Decision Routing層）:** ChatGPT最終判断レビューは「コードレビュー」ではない。役割は**コミット前の判断整理・次工程設計・CEO承認要否判定**である。コードの正しさそのものはSafety Gate層（typecheck/test/Mechanical Safety Checks）とGemini Flash Stepレビューが既に確認済みという前提のもと、ChatGPTはFinal Review Packet（低コスト圧縮資料）を読んで「このまま進めてよいか」「CEO承認が必要か」「次に何をすべきか」を判断する、意思決定支援の役割に限定される。

原則としてコミット直前にまとめてレビューする。目的: 全Stepが完了扱いでよいか判断・コミットしてよいか判断・CEO承認が必要か判断・Geminiがmedium/highにした懸念が解消されたか確認・機械チェック結果に問題がないか確認・次にやるべき作業を整理・Claudeへの次プロンプトを必要に応じて作成。

生ログ全文ではなくFinal Review Packetを基本とする（APIコスト抑制・判断対象の明確化・重要な懸念の埋没防止・レビュー品質の安定化）。

## 9. Final Review Packet

**役割定義（Review Orchestration / Decision Routing層）:** Final Review Packetは、**既存のレビュー結果・安全確認・報告を1つにまとめる「受け皿」**であり、新しい判断者ではない。ChatGPTに全ログ・全diffを渡さずに低コストかつ的確に最終判断させるための圧縮資料であると同時に、Gemini Flash（Report Translation）で非エンジニア向けに翻訳する際の元データにもなる、共通フォーマットである。

Final Review PacketはSafety Gate層（Mechanical Safety Checks・Risk Scan・commitGate等）とGemini Flash Stepレビューが既に出した結果を**集約するだけ**であり、Packet自体が新たにリスク判定やコミット可否を発明することはない。全Step完了後、SonnetがPacketを作成し、Sonnetが自分に都合よく要約するリスクがあるため、Gemini Flashが抜け漏れ確認を行う。

**設計方針:**
- 結論を先頭に出し、技術ログをそのまま貼らない（非エンジニアが読んで判断できる形式）
- Review Level（0〜3）は11-1章の実行ルーティングをそのまま転記する。Packet内で新たにLow/Medium/High判定をやり直さない（11章のリスク分類との重複を避ける）
- Level 3相当の場合は「Human / CEO確認が必要」であることを結論部分に明記する
- Geminiレビュー結果は用途別（Risk Review / Alignment Review / Meta Review / preReview・postReview）に分けて記載し、未実施の場合は理由を書く（実施していないことを隠さない）

標準形式:

```md
# Final Review Packet

## 結論（必ず先頭に記載）
- コミットしてよいか: OK / 修正後再レビュー / 判断保留 / 停止すべき
- ChatGPTレビューが必要か: 要 / 不要（理由）
- Human / CEO判断が必要か: 要 / 不要（理由。Level 3相当なら必ず「要」）

## 1. 今回やったこと
## 2. なぜ必要だったか
## 3. どこまで変えたか
## 4. 変えていない重要部分
## 5. Review Level（0〜3。11-1章のルーティングをそのまま転記）
## 6. 安全面チェック
  - DB変更 / 認証・権限変更 / セキュリティ変更 / 外部サービス追加 / 課金影響 /
    本番環境影響 / package.json・lockfile変更 / 破壊的変更（各項目: 有無と概要）
## 7. 検証結果（test / typecheck / build / lint。未実行の場合は理由）
## 8. Geminiレビュー結果（Risk Review / Alignment Review / Meta Review / preReview・postReview。未実施の場合は理由）
## 9. ChatGPTレビューが必要か（結論の詳細・根拠）
## 10. Human / CEO判断が必要か（結論の詳細・根拠）
## 11. コミットしてよいか（結論の詳細・根拠）
## 12. 対象ファイル
## 13. コミットメッセージ案
## 14. 未追跡ファイル・対象外ファイルの扱い
## 15. 次にやるべき最小アクション
```

**旧形式（Task Goal/Scope/Step Summary/Changed Files/Mechanical Safety Results/Gemini Escalation Items/...）との関係:** 上記15項目は旧形式の情報を包含しつつ、結論先出し・非エンジニア可読性・Review Levelとの整合を追加したもの。旧形式を別途維持する必要はない。

## 10. ChatGPTへ生ログを渡す条件

通常はFinal Review Packetのみ。以下の場合は該当ログ抜粋を添付:
```
- GeminiとSonnetの判断が食い違った
- Geminiがhigh判定を出した
- AV-001に触った
- 認証・外部公開endpointに触った
- DBスキーマに触った
- worker/jobRunner/commitGate/safetyVerificationに触った
- テスト失敗から復旧した
- Claudeが禁止事項に触れかけた
- 仕様解釈が曖昧だった
- CEO承認が必要な可能性がある
```

危険度が高い場合: Final Review Packet + 関連ログ抜粋 + CEO承認

## 11. リスク分類

**このリスク分類は「危険度」を表す軸であり、実行主体やレビュー経路を決める軸（11-1章のReview Level）とは別物である。11章＝何がどれだけ危ないか、11-1章＝それをどう振り分けて実行するか、という役割分担で読むこと。**

**2つの適用範囲（重複ではなく対象範囲の違い）:**
- **target_project（jobRunner経由のJob）向けの判定**: `apps/worker/src/approvalLevel/targetProjectRiskScan.ts`が実際に検出する`RiskScanSeverity`（`'high' | 'medium' | 'low'`）が、この章のHigh/Medium/Lowにそのまま対応する。ここで新しい判定基準を作らない。AV-001・jobRunner/commitGate/safetyVerification自体の変更は、Step6-B0の結論（jobRunner経由のJobは常にtarget_project scope）によりtarget_projectのdiffには含まれ得ないため、target_project向けの判定には含まれない。
- **control repo（Claude Codeが直接このリポジトリを編集するセッション。今回のようなdocs/CLAUDE.md/AGENTS.md編集や、AV-001対象ファイルの編集を含む）向けの判定**: コード化された分類器は存在せず、本章の例示（AV-001変更・認証変更・DBスキーマ変更・自動停止条件・CEO通知条件・package.json/lockfile変更等）がそのままHighの目安になる。ここは「docsか実装か」ではなく影響範囲で判断する原則（[[feedback_meta_review_warnings]]相当の運用ルール）に従う。

| Risk | 例（target_project: Risk Scanの検出／control repo: 影響範囲による例示） | 扱い |
|---|---|---|
| **Low** | ドキュメント更新・テスト追加・小さな型修正・UI文言修正・既存仕様内の軽微な修正・禁止ファイルなし・AV-001なし・test/typecheck PASS・Risk Scan low or none | Gemini Flashレビューのみで次Step候補。コミット直前にChatGPTまとめレビュー。CEO承認不要 |
| **Medium** | 複数ファイル変更・軽微なAPI追加・既存ロジック変更・テスト修正を伴う変更・Risk Scan medium・影響範囲が限定的だが判断が必要（AI役割分担・レビュー方針に関わるdocs変更もここに含む） | Gemini Flashでmedium判定。必要ならSonnet修正。コミット前にChatGPTレビュー。CEOへ事後報告でも可 |
| **High** | AV-001変更・認証変更・DBスキーマ変更・外部公開endpoint・worker/jobRunner変更・commitGate変更・safetyVerification変更・自動停止条件・CEO通知条件・package.json/lockfile変更・secretや.envに関係する変更・リポジトリ外操作・Goal/Design Philosophyに関わるdocs変更 | Geminiがlowと言ってもChatGPTへエスカレーション。原則CEO承認必須。コミット直前だけでなく実装前レビューも必要 |

## 10-1. 人間向け報告フォーマット（Report Translation）

人間への報告は、**Final Review Packet（9章）をGemini Flash（Report Translation）で非エンジニア向けに翻訳したもの**とする。人間向け報告専用の別テンプレートは作らない（9章のPacketと重複する新しい項目一覧を持たない）。ただし、Gemini Flashは翻訳係であり最終判断者ではない。コミット可否・設計判断・Goal/Design Philosophyに関わる判断・DB/認証/権限/外部サービス/本番影響の判断・warning/uncertain/blockedが出たケースは、Gemini Flash単独で完結させず、ChatGPTまたはHuman/CEOの判断に委ねる。

翻訳時は、Packetの「結論」ブロックを冒頭にそのまま出し、技術用語を並べずに1〜15項目を平易な文章に置き換える。報告の最後には必ず結論を書く（例: 「このままコミットして問題ありません」「修正後に再レビューが必要です」「人間判断が必要です」「危険なため停止すべきです」）。

## 11-1. Review Level（実行主体ルーティング）

11章のリスク分類（Low/Medium/High）に、実行主体（Codex/Claude）と関与するAIレビューの組み合わせを対応付けたものが以下のReview Levelである。**11章の分類を置き換える新しい機構ではなく、実行主体をどう振り分けるかの運用ルール**として位置づける。

**`ApprovalLevel`（`packages/shared`）との違い（数値が同じ0〜3のため混同注意）:** `ApprovalLevel`は`determineApprovalLevel()`が出力するcontrol repo基準のMechanical Gate分類器の値であり、Step6-B0の結論により「jobRunner経由のJobは常にtarget_project scopeであり、control repo基準のパターンはほぼ一致しない」ことが判明している。本章のReview Levelは、11章のリスク分類（target_projectはRisk Scan severity、control repoは影響範囲による例示）から導く独立した実行ルーティングであり、`ApprovalLevel`の値をそのまま使うものではない。

| Level | 対応するリスク分類 | 実行主体 | 関与するレビュー | 人間確認 |
|---|---|---|---|---|
| **Level 0**（軽微） | Lowのうちtypo/コメント/README軽微修正など | Codex実装のみ | Gemini不要（Mechanical Safety Checksのみ） | 不要 |
| **Level 1**（通常実装） | Low | Codex実装 | Gemini postReview（既存`postReviewer.ts`）+ 必要ならGemini Flashで人間向け報告（Report Translation） | 原則不要 |
| **Level 2**（中リスク） | Medium | Claudeが計画、CodexまたはClaudeが実装 | Gemini preReview/postReview（既存`preReviewer.ts`/`postReviewer.ts`）。warning/uncertainならChatGPTレビュー | 原則不要 |
| **Level 3**（高リスク） | High | Claudeが設計 | Gemini Risk Review（`targetProjectRiskScan.ts`）+ Alignment Review（`alignmentCheck.ts`）+ ChatGPT判断レビュー | Human/CEO確認必須（承認後に実装） |

**Codex/Claudeの振り分け基準:** Codexは既存実装に沿った小さな変更・軽微修正・テスト修正・型エラー修正・ドキュメント更新を担当する（Level 0-1が基本、Level 2でも定型的な修正はCodexが担当してよい）。DB・認証・権限・外部サービス・課金・本番環境・package変更・破壊的変更・設計判断が必要な変更（Level 2の一部〜Level 3）はClaudeが担当し、Codexは自己判断で進めずClaudeへ上げる。

## 12. エスカレーションルール

Gemini Flashの判定に関係なくChatGPTへエスカレーション:
```
- Mechanical Safety Checksで重要領域に触れた
- AV-001対象ファイルが変更された
- 認証・外部公開・DB・worker・commitGate・safetyVerificationが変更された
- テスト失敗が発生した
- Risk Scan high
- secret scanが警告を出した
- Geminiがmedium/high判定を出した
- SonnetとGeminiの判断が食い違った
```

CEO承認必須:
```
- high risk変更
- 方針変更
- 外部公開endpoint
- 認証変更
- DBスキーマ変更
- 自動停止条件
- CEO通知条件
- 予算・課金・外部API追加
- リポジトリ外操作
```

## 13. コスト最適化方針

```
各Step:      Gemini Flashで軽量レビュー
コミット直前: ChatGPTでFinal Review Packetをレビュー
高リスク:    必要に応じて実装前からChatGPT/Opusレビュー
```

## 14. 推奨運用

```
Claude Sonnet: Step実装
Mechanical Safety Checks: Stepごとに実行
Gemini Flash: Stepごとに軽量レビュー
Sonnet: Gemini指摘を修正
Final: SonnetがFinal Review Packet作成
Gemini Flash: Packetの抜け漏れ確認
ChatGPT: コミット前レビュー
CEO: 必要な場合のみ承認
Commit: 承認後に実行
```

## 15. 実装初期段階の制約

```
- Gemini Flashは提案のみ
- ChatGPTは判断整理のみ
- Claude Sonnetは実装と修正のみ
- 自動コミットはしない
- high riskは必ずCEO承認
- medium riskは事後報告候補
- low riskでも機械チェックNGなら止める
```

## 16. 将来拡張

```
- Gemini Flashレビューの自動API化
- ChatGPTレビューのAPI化
- Final Review Packet自動生成
- GeminiによるPacket整合性チェック
- low riskの自動継続
- medium riskの事後報告自動化
- high riskのCEO承認UI
- スマホUIでの承認フロー
- モデルルーティング
- APIコスト上限管理
- レビュー履歴DB
- 過去判断の検索
```

## 17. 重要な禁止事項

```
- Claude Sonnetが自分の実装を最終承認すること
- Gemini Flashがhigh riskを解除すること
- ChatGPT判断レビューがMechanical Safety ChecksのNGを上書きすること
- CEO承認必須領域をAIだけで通すこと
- Final Review PacketからGeminiのmedium/high懸念を省略すること
- 機械チェック結果を要約だけにして原情報を失うこと
- コミット直前レビューなしでコミットすること
```

## 18. 最終まとめ

```
Sonnetが細かくStep実装
↓
Stepごとに機械チェック
↓
StepごとにGemini Flashが軽量レビュー・重要度判定
↓
Sonnetが修正して次Stepへ
↓
全Step完了後にFinal Review Packet作成
↓
GeminiがPacket抜け漏れ確認
↓
ChatGPTがコミット前レビュー
↓
必要ならCEO承認
↓
コミット
```

---

## 19. 既存実装との関係（AIチームOSへの組み込み時の前提）

このMulti-AI Step Review Flowは、AIチームOSに既に部分実装されている既存コンポーネントを土台としつつ、**Review Orchestration / Decision Routing層を新規に整備するもの**である。2-1章で定義した層分離に沿って、既存実装との関係を2つの表に分けて整理する。

### 19-1. Safety Gate / Risk Control層（既存の安全チェック機構。本仕様書の対象外）

危険変更を検出・停止する機構であり、本仕様書によって変更・拡張されるものではない。本仕様書はこれらが出力するfactsを「読む側」である。

| 仕様書上の位置づけ | 対応する既存実装 | 状態 |
|---|---|---|
| Mechanical Safety Checks | `apps/worker/src/approvalLevel/safetyVerifier.ts`（12項目チェック）、`packages/shared/src/approvalLevelClassifier.ts`（Mechanical Gate） | 実装済み（Step1-2, Step3。コミット b159d73, 3b3d1fb） |
| Risk Scan | `apps/worker/src/approvalLevel/targetProjectRiskScan.ts`（severity付きリスク検出） | 実装済み・観察モードでjobRunner接続済み（コミット d16a709〜afab85c）。現在ログ観察期間中 |
| commitGate（成果物確認） | `apps/worker/src/approvalLevel/commitGate.ts`（reviewPolicy別必須成果物チェック） | 実装済み・未接続（Step5完了、コミット 351840f） |
| 既存Gemini Reviewer（実行ブロック権限あり） | `apps/worker/src/approvalLevel/preReviewer.ts` / `postReviewer.ts` / `reviewerAdapter.ts` | 実装済み・未接続（Step4完了、コミット a7d3f81）。**2-1章の通り、本仕様書のGemini Flash Stepレビューとは別物として扱う** |
| control repo vs target_project スコープ分離 | Step6-B0（コミット334732a）でjobRunner経由のJobは常にtarget_project前提であることを確認済み | 実装済み（前提の明文化のみ、コード変更なし） |

### 19-2. Review Orchestration / Decision Routing層（本仕様書が中心的に扱う対象）

実装報告とSafety Gate層のfactsを読み、重要度・次工程・エスカレーション要否・CEO承認要否を整理する判断レビュー層。ほとんどが新規概念であり、既存実装との単純な1:1対応はない。

| 仕様書の概念 | 役割 | 対応する既存実装 | 状態 |
|---|---|---|---|
| Gemini Flash Stepレビュー | Stepごとの軽量判断レビュー・重要度判定（停止権限なし） | 既存の`preReviewer.ts`/`postReviewer.ts`とは別物（2-1章参照）。新規に整理・実装が必要 | 未実装（新規概念） |
| Final Review Packet | ChatGPTに全ログを渡さず低コストに最終判断させるための圧縮レビュー資料 | 既存の`ApprovalLevelResult` / `PreReviewResult` / `PostReviewResult` / `SafetyVerificationResult` / `TargetProjectRiskScanResult`を集約する生成関数が必要 | 未実装（新規概念） |
| ChatGPT最終判断レビュー | コミット前の判断整理・次工程設計・CEO承認要否判定（コードレビューではない） | `reviewerAdapter.ts`内の`shouldEscalateToChatGpt()`（プレースホルダー、常にfalse） | 未実装（将来のCost-aware Review Router用の拡張ポイントのみ存在） |
| 次Stepプロンプト生成 | ChatGPTの判断整理結果をもとに、Claude Sonnetへの次Stepプロンプトを生成する | — | 未実装（新規概念） |
| リスク分類（Low/Medium/High） | Review Orchestration層内での重要度判定の共通基準 | `packages/shared/src/types/approvalLevel.ts`の`ReviewPolicy`（mechanical_only/light_ai_post_review/full_pre_post_review/ceo_required）は名称・粒度が異なるため直接転用しない | 概念のみ。`targetProjectRiskScanResult.highestSeverity`（high/medium/low、コミット1040090）ベースで再設計するのが自然 |

**重要な整理:** 既存の`ReviewPolicy`はcontrol repo基準の分類器（`determineApprovalLevel()`）の出力であり、Step6-B0の結論により「jobRunner経由のJobは基本的にtarget_project」であることが判明している。一方、本仕様書のLow/Medium/High分類は「変更内容の性質」に基づく分類であり、`targetProjectRiskScanResult.highestSeverity`の方が親和性が高い。**したがって、本仕様書のリスク分類は`ReviewPolicy`ではなく`targetProjectRiskScanResult.highestSeverity`をベースに再設計するのが自然。**

## 20. Review Transport Mode（レビュー伝送モード）

外部AI（Gemini Flash / ChatGPT）へレビュー用ペイロードをどう届けるかを定義する。2モード構成（当初のmanual/assisted/apiの3モード案から、manualとassistedを統合し2モードに簡素化した最終仕様）。

| モード | 内容 |
|---|---|
| **handoff** | 人間がClaude / Gemini / ChatGPT間の受け渡しを行う。ChatGPT判断レビューは手動で利用する。AIチームOSは必要に応じてFinal Review Packet、貼り付け用プロンプト、次Stepプロンプトを生成する。APIコストを最小化できるため、初期推奨モードとする。 |
| **api** | AIチームOSがGemini / ChatGPT APIへ自動送信する。低リスク・中リスクの効率化に使う。高リスクはCEO承認必須。 |

**初期推奨:** `handoff`
**将来拡張:** `api`

## 21. Quota Policy（クォータポリシー）

無料枠のAPI利用上限に達した場合の挙動を定義する。

```
quotaPolicy:
- wait
- handoff_fallback
- paid_api_fallback
```

| ポリシー | 内容 |
|---|---|
| **wait** | 無料枠が回復するまで待つ。 |
| **handoff_fallback** | 無料枠が切れたら、人間の手渡し運用（Review Transport Mode: handoff）に切り替える。 |
| **paid_api_fallback** | 有料APIで続行する。明示承認時のみ。 |

**無料枠切れ時の初期推奨:** `handoff_fallback` または `wait`
**paid_api_fallbackは原則OFF**。高リスクレビューや緊急時のみ明示承認でON。
