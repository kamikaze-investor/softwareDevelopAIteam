# 原則強化: Root Cause Generalization / Canonical Semantic Ownership（2026-10-16）

**Status: active**
**判断者: CEO（2026-10-16 指示。開始時・途中の技術的承認は不要と明示）/ 設計・実装: Claude（PL Role）**

Lifecycle 横断監査で、同じ原因（domain fact を owner の外で表現から再推論する／判定を複数箇所が
独立に持つ）が別の機能・状態遷移で別の症状として繰り返し出たことを受けた原則強化である。
**原則本文は個別 incident（Lifecycle・resume 等）の語彙を持たない汎用原則として書いた。**

## 1. 既存原則との差分（重複追加をしない）

| 指示 | 既存でカバー済み | 不足していて足したもの |
|---|---|---|
| Canonical Semantic Ownership | `canonical-domain-meaning`: 1 fact 1 owner、表現（命名・ID 形式・prefix・順序・時刻・message）からの再推論禁止、contractual / incidental の区別、fail closed、双方向テスト | 第二の正本を**新たに足さない**（今一致していても）、owner 欠落・分裂・誤配置時の**最小の構造的リファクタリング**、**意味が違うものを表現の類似で統合しない**（正当な違いは両方の定義箇所に書く）、再推論 1 件を原因の兆候として扱う接続 |
| Root Cause Generalization | AGENTS.md CI トリアージの「根本原因（症状ではなく原因）を特定」、`scale-to-risk`、`existing-code-grandfather` | 修正の Required Outcome は「原因が再発しない」こと、原因を機構の単位で抽象化、同じ原因の**別症状・未発生箇所**の探索、risk 比例の探索範囲（毎回の全体監査ではない）、共通原因の修正優先、類似ではなく原因で束ねる、権限範囲外の同型箇所は黙って直さず既存経路へ記録 |

`canonical-domain-meaning` は**既存原則の拡張**で表現できたので新規原則にしていない。
one-liner は「第二の owner を足さない」を含む形へ改めた（prompt に載るのは one-liner だけのため）。

## 2. Root Cause Generalization を新規原則にした理由

既存原則のどれに足しても意味が混ざる:

- `evidence-not-spec`（最上位原則）に入れると、修正に固有の探索範囲・報告内容が最上位原則の
  文面を薄める。新原則は「`evidence-not-spec` を修正へ適用したもの」と本文で明示し、別物に分岐させない
- `standard-design-frame` は「制約を足す前にそれが防ぐ失敗を名指す」原則で、修正範囲の原則ではない
- `existing-code-grandfather` は**広げない側**の原則で、逆向きの力を同居させると両方の判定が曖昧になる。
  新原則は grandfather を明示的に維持する（incident が開くのはその原因の箇所だけ）

## 3. tier を core にした理由（適用経路）

「これは修正である」という signal は**提案の中身**にあり、changedFiles / focus / riskLevel からは
決められない。`observation-closes-loop` を core にした判断（2026-09-17）と同じ理由である。
contextual にして PR title prefix 等から修正を推定すると、それ自体が `canonical-domain-meaning` 違反になる。

core にしたことで、**コード配線の追加なしに**次の既存経路へ one-liner が載る:

- 自動修復: `buildRepairPrompt()`（Design Review repair。core 選択）
- PL technical recovery / CEO resume: `buildResumeAiCliPrompt()`（core + focus）
- PL Independent Remediation: `buildRemediationDesignContract()`（core + focus）
- 通常実装: `appendImplementContracts()` / initial implement workflow
- Design Review（focused）/ Approval-level reviewer: `selectPrinciples()` は core を必ず含むので、
  原則ごとの verdict（ALIGNED / CONFLICT / UNCERTAIN）が返り `principle_applications` に記録される
- Meta Review（PR。原則ごとの verdict は持たない）: 固定の `buildEngineeringPrincipleReviewGuidance()` に
  1 行足した（core なので常時注入が tier の意味と一致する。contextual の `canonical-domain-meaning` を
  ここへ常時注入しない既存方針は維持）。Design Review も同じ guidance を読む

人・外部セッション（Claude Code / Codex）の修正作業は `AGENTS.md` の CI トリアージと
Meta Review `changes_requested` 対応手順から参照させた。

**新しい Gate / Review 工程 / Status / Workflow / finding category は追加していない。**
違反は既存 category `unverifiable_assumption`（sub-kind `unexamined_root_cause`）、
再推論は従来どおり `implementation_coupling`（`semantic_reinference`）で報告する。

## 4. Review 負荷の抑え方

- reviewer は探索をやり直さない。原因が失敗を説明しているか・範囲が risk に対して妥当か・
  **見えている**同型箇所を放置していないかだけを確認する
- 局所的な原因（typo 等）は「原因が局所である理由」の 1 文で足りる
- 同じ原因の箇所は finding を量産せず原因 1 件にまとめる（checklist にも明記）
- 増えるのは prompt の one-liner 1 行と、review ごとの原則 verdict 1 件である

## 5. 再評価条件（`observation-closes-loop` を自分に適用）

既存センサー `core-principle-never-conflicts`（core 原則が 50 件適用で CONFLICT / UNCERTAIN 0 件なら
contextual 降格を再Review候補にする。`PRINCIPLE_SENSOR_THRESHOLDS`）がそのまま
`root-cause-generalization` にも効く。修正以外の変更では ALIGNED になりやすいため、
**このセンサーの発火は「core が過剰か」を見直す正規の契機**として扱う。
`canonical-domain-meaning` は本文が変わったため版 hash が更新され、実績は新版でゼロから数え直される
（`engineeringPrinciples.ts` の版の設計どおり）。
