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

### 6-1. 接続設計（Step R3。設計のみ・未実装）

Step R2までで型・生成関数を用意したFinal Review Packetに続き、Gemini Flash Stepレビューを**いつ・どの情報量で・どの経路で**呼ぶかを設計する。今回はコード変更を行わない。

**既存Gemini呼び出し基盤の再利用（新規実装しない）:** `apps/worker/src/metaReviewer/geminiRouter.ts`が既にCLI（agy）→API自動フォールバック・429/quotaエラー検出を実装済み（AV-001対象・AI編集禁止）。Gemini Flash Stepレビューを実装する際は、この既存基盤（`callGeminiForReview`相当）を呼び出すだけとし、新しいGemini API接続コードを作らない。`preReviewer.ts`/`postReviewer.ts`が使う`reviewerAdapter.ts`とも別モジュール（新しい軽量関数）として実装し、既存の`blocked`概念を持つ型は流用しない（2-1章・6章の役割分離を維持するため）。

**Review Transport Mode（20章）との関係:** 20章は「初期推奨: handoff」としているが、これは主にAPI未接続のChatGPTを想定した推奨である。Gemini Flashは既に`geminiRouter.ts`経由でAPI運用されている実績があり、低コスト（Flashモデル・quota検出済み）のため、**Gemini Flash Stepレビューは初期から`api`モードでよい**。ChatGPTは引き続き`handoff`初期推奨のまま変更しない。AIごとにTransport Modeが異なってよいことを20章に補足する必要がある（次回のドキュメント更新候補。今回はここに設計メモとして記録するに留める）。

**呼び出しタイミング（11-1章のReview Levelと連動）:**
- Level 0: 呼ばない
- Level 1: 呼ばない（原則Gemini不要。11-1章の「Level 1 → Level 2への繰り上げ条件」に該当する場合のみLevel 2として扱いStepレビューを呼ぶ。Gemini Flashは人間向け報告のReport Translationにのみ関与）
- Level 2: 4章のStep単位実装フローの通り、**Mechanical Safety Checks通過後・次Step着手前**に呼ぶ
- Level 3: Gemini Risk Review・Alignment Reviewが優先されるため、Stepレビューは補助的に使う程度に留める

**渡す情報量（11-1章「プロンプト前提量最適化」に従う）:** 今回のStepのdiff要約・目的（purposeSummary相当）・直前のMechanical Safety Checks結果の要約のみを渡す。過去Stepの全文・経緯・関係ない背景は渡さない。既存`ReviewerRequest`（`planText`/`diffText`/`purposeSummary`/`targetFiles`）の構造を参考にしつつ、Gemini Flash Stepレビュー専用の軽量な入力型として別に定義する（`blocked`概念を持たない）。

**Final Review Packetへの格納（既知のギャップ）:** 現在の`FinalReviewPacket`の`GeminiReviewKind`（`risk_review`/`alignment_review`/`meta_review`/`pre_review`/`post_review`）には、Gemini Flash Stepレビュー専用の種別がない。`pre_review`/`post_review`は既存Gemini Reviewer（blocked概念あり）用のkindであり、Stepレビュー（停止権限なし）と混同すると2-1章・6章の役割分離が崩れる。実装時（Step R3実装フェーズ）に`GeminiReviewKind`へ`step_review`を追加する必要がある。**今回はこのギャップを記録するのみで、型は変更しない。**

**エスカレーション導線:** 出力の`routing`が`escalate_to_chatgpt`または`require_ceo`の場合、Claude Codeは次Stepへ進まず、`escalationReason`を添えてChatGPT（Review Transport Mode: handoff）またはHuman/CEOへ報告する。`routing: stop`の場合は即座に作業を止めてCEOへ報告する（Mechanical Safety ChecksのNGと同様、Gemini側の判断だけで自動停止権限を持つわけではないが、Claude Codeが自身の判断で進行を止める運用とする）。

**今回時点の結論:** 上記はすべて設計・既存基盤の再利用方針であり、コード変更は不要。実装（Step R3実装フェーズ）では、(1) 軽量な入力/出力型の新規定義、(2) `geminiRouter.ts`呼び出しのラッパー関数作成、(3) `GeminiReviewKind`への`step_review`追加、(4) jobRunnerへの接続（Level 2のStep単位フロー内）が対象になる。いずれも新しいレビュー機構ではなく、既存基盤への薄い接続レイヤーとして実装する。

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

**2段階構成（通常時は軽量・必要時だけ詳細）:** 毎回15項目すべてを長く書くと、正常系でもCEOが読む負担・トークン消費が大きい。そのため報告は「通常報告（5項目）」を基本とし、下記の詳細化条件に該当する場合のみFinal Review Packet（9章）に沿って詳細化する。

**通常報告（5項目・基本形）:**
```
1. 結論（変更不要 / 変更必要 / コミット可 / 判断待ち / 停止すべき、を先に書く）
2. CEO判断が必要か（不要なら「不要。理由：〜」の一言でよい）
3. 要点（今回分かったこと・変更したことを短く。技術詳細・経緯はCEO判断に関係する場合だけ）
4. リスク・注意点（問題なければ「重大なリスクなし。理由：〜」でよい。DB/認証/権限/外部サービス/
   課金/本番環境/破壊的変更/Goal・Design Philosophyに関わる場合だけ詳しく書く）
5. 次の最小アクション（何もしなくてよい / コミットする / 次のStepに進む / 人間判断が必要、など具体的に）
```

**詳細化する条件（いずれか該当する場合、9章のFinal Review Packet形式に寄せて詳細化する）:**
```
- コード変更あり
- コミット前判断
- Review Level 2以上
- DB変更 / 認証・権限変更 / セキュリティ変更 / 外部サービス追加 / 課金影響 / 本番環境影響 / 破壊的変更
- Goal / Design Philosophyに近い変更
- Gemini / ChatGPT / Human判断が必要
- warning / uncertain / blocked が出た
- 複数案からCEO判断が必要
- 既存方針とのズレが疑われる
```

**正常系で個別項目として長く書かなくてよいもの（該当なしの場合）:** Geminiレビュー要否・ChatGPTレビュー要否・Human/CEO判断要否・コード変更有無・安全面・検証結果・変更ファイル詳細・長い技術ログ・過去経緯。ただし問題・例外・判断が必要な点があれば必ず明記する（例:「CEO判断不要。理由：調査のみでコード・Gate・権限・本番影響なし」「重大なリスクなし。理由：ドキュメント修正のみで既存挙動に影響しない」「ChatGPT確認推奨。理由：Review Level 2以上で運用ルールに影響するため」）。

**Review Notes（判断レビューAI向け補足。CEO向け本文とは分ける）:** ChatGPT/Gemini/Claudeのレビュー判断に役立つが、CEO判断には不要な情報がある場合のみ、本文の末尾に短い`Review Notes`として付記する。CEO判断や方針判断に役立たない技術ログ・長い経緯・重複説明はここにも書かない（Review Notesは「レビューAI向けの短い補足」であり、省略した技術詳細の避難場所ではない）。

**Final Review Packetとの関係（廃止しない）:** Final Review Packet（9章）は詳細報告時の形式として維持する。通常報告（5項目）は「Packetの結論ブロックを含む軽量版」、詳細報告は「Packet全体（1〜15項目）」という位置づけであり、新しい別機構ではない。Report Translationも、通常時は5項目に圧縮するが、リスクや判断が必要な情報（詳細化条件に該当する部分）は削らない。

## 11-1. Review Level（実行主体ルーティング）

11章のリスク分類（Low/Medium/High）に、実行主体（Codex/Claude）と関与するAIレビューの組み合わせを対応付けたものが以下のReview Levelである。**11章の分類を置き換える新しい機構ではなく、実行主体をどう振り分けるかの運用ルール**として位置づける。

**`ApprovalLevel`（`packages/shared`）との違い（数値が同じ0〜3のため混同注意）:** `ApprovalLevel`は`determineApprovalLevel()`が出力するcontrol repo基準のMechanical Gate分類器の値であり、Step6-B0の結論により「jobRunner経由のJobは常にtarget_project scopeであり、control repo基準のパターンはほぼ一致しない」ことが判明している。本章のReview Levelは、11章のリスク分類（target_projectはRisk Scan severity、control repoは影響範囲による例示）から導く独立した実行ルーティングであり、`ApprovalLevel`の値をそのまま使うものではない。

### プロンプト前提量最適化（Codexへの作業指示作成時）

ClaudeがCodexへ作業指示を書く前に、内部で以下を自問する（**出力項目を増やすものではなく、Claudeの内部判断として使う**。報告に出すのは必要な場合のみ）:

```
このタスクに必要な前提は何か？
削っても判断が変わらない情報は何か？
削ると危険な制約は何か？
このタスクのReview Levelなら、どこまで前提を渡すべきか？
```

**Levelごとの扱い:**
- **Level 0〜1**: 軽量に扱う。前提は最小限（対象ファイル・目的・完了条件程度）でよい。毎回この4問を文章化しない。
- **Level 2以上**: 前提不足（危険な制約が漏れていないか）と前提過多（判断に無関係な背景・過去経緯が混入していないか）を内部でチェックしてから渡す。
- **Level 3**: トークン削減より安全性を優先する。DB/認証/権限/外部サービス/課金/本番/破壊的変更に関する禁止事項・制約は、必要であれば重複してでも渡す（削って安全境界が消えるくらいなら冗長な方がよい）。

**削ってよいもの（例）:** このタスクに直接関係しない過去の経緯・既に解決済みの議論の全文・重複する背景説明。
**削ってはいけないもの（例）:** AV-001/Repository Boundary/禁止コマンド等の安全境界、DB・認証・権限・外部サービス・課金・本番・破壊的変更に関わる制約、Review Levelに応じたエスカレーション条件。

この最適化は`AGENTS.md`3-1章から参照される。新しいレビュー機構や新しい出力項目を追加するものではない。

| Level | 対応するリスク分類 | 実行主体 | 関与するレビュー | 人間確認 |
|---|---|---|---|---|
| **Level 0**（軽微） | Lowのうちtypo/コメント/README軽微修正など | Codex実装のみ | Gemini不要（Mechanical Safety Checksのみ） | 不要 |
| **Level 1**（通常実装） | Low | Codex実装 | **原則Gemini不要**（既存のtest/typecheck等の検証で担保）。人間向け報告が必要な場合のみGemini Flashで報告（Report Translation） | 原則不要 |
| **Level 2**（中リスク） | Medium | Claudeが計画、CodexまたはClaudeが実装 | Gemini preReview/postReview（既存`preReviewer.ts`/`postReviewer.ts`）+ Gemini Flash Stepレビュー（6-1章）。warning/uncertainならChatGPTレビュー | 原則不要 |
| **Level 3**（高リスク） | High | Claudeが設計 | Gemini Risk Review（`targetProjectRiskScan.ts`）+ Alignment Review（`alignmentCheck.ts`）+ ChatGPT判断レビュー | Human/CEO確認必須（承認後に実装） |

**Level 1 → Level 2への繰り上げ条件（いずれか該当する場合、Level 1のままにせずLevel 2として扱う）:**
```
- 差分の拡大（当初想定より変更範囲が広がった）
- 実装内容に不確実性がある（判断に迷う点がある）
- 複数ファイルにまたがる変更
- レビュー運用・AI役割分担に関わるdocs変更（本ドキュメント・AGENTS.md・CLAUDE.md等）
- 安全境界に近い変更（DB/認証/権限/外部サービス/課金/本番/破壊的変更に近い・隣接する変更）
```
上記に該当しない通常のLevel 1（typo修正に次ぐ程度の小さな変更・軽微なUI改善・テスト追加等）は、Gemini postReviewを都度実行する必要はなく、既存の検証（test/typecheck）で担保してよい。

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
