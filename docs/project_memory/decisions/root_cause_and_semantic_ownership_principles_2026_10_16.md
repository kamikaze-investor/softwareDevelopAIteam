# Root Cause Generalization / Canonical Semantic Ownership の原則統合（2026-10-16）

Lifecycle 横断監査の教訓を受け、CEO 指示で既存原則を強化した。新しい原則・Gate・Review 工程・
Status・finding category は追加していない。正本は `specs/21`。

## 何をどこへ入れたか

- **Root Cause Generalization** → core 原則 `evidence-not-spec` の拡張
  （「現在の実装は仕様ではなく evidence」と同じ考え方で「報告された不具合は原因の evidence であり、
  修正範囲の境界ではない」）。core なので、実装・repair・remediation・review の全 prompt へ
  one-liner で届く。prompt に載るのは one-liner だけなので、**範囲の上限（risk 相応・Task scope 内・
  残りは報告）も one-liner に入れた**
- 横断探索は PL / triage が Task を切る段で行い、実装者に bounded Task の外を探させない
  （AGENTS.md 9章 014 / 015 と整合。共通原因そのものを 1 Finding として 1 bounded Task にする）
- Reviewer 向け: verdict 側は `buildApplicablePrinciplesSection`（verdict を集計する Design Review /
  focused review の全経路）、finding 側は `buildEngineeringPrincipleReviewGuidance`（PR Meta Review を含む）に
  各 1 行。material に同原因箇所が見えるときだけ CONFLICT / 指摘、先頭に `[root_cause]`
- **Canonical Semantic Ownership** → `canonical-domain-meaning` と `semantic_integrity.md` の拡張
  （one owner per meaning / 意味が異なる fact を統合しない / owner 配置は最小の構造変更で直す）

## 置き場所を選んだ理由

- 新原則にすると「fix である」ことを示す signal が無いため core にするしかなく、全 review の
  verdict が 1 つ増える。`standard-design-frame` は one-liner が over_constraint の説明に使われており
  混線する。`evidence-not-spec` が最も自然で負荷が増えない
- 代償: `evidence-not-spec` / `canonical-domain-meaning` の versionHash が変わり、ledger の実績は
  両原則とも新しい版で 0 から数え直しになる（設計どおりの安全側）。`principle-registry-coverage-and-threshold-review`
  の「coverage 拡張のためだけに本文を変えない」制約には当たらない（原則の意味の変更であり、CEO 指示）。
  RCG 由来の判定は記録される reason の先頭 `[root_cause]` で検索して区別できる（ledger 自体は接頭辞を解析しない）

## 既知の gap（本変更前から存在）

**2026-10-16 追記（適用監査で一部解消）**: POST /jobs と repair の欠落は、原則選択の owner を
`buildTaskDesignContract()` 1 箇所へ寄せて解消した（Roadmap 項目は done）。残る selection coverage の欠落
（例えば lifecycle / API 側 approval・git_commit / target app の path では全経路で選ばれない）は `principle-registry-coverage-and-threshold-review`
Task A へ移した。以下は当初の記録。

`canonical-domain-meaning` は contextual で、`appendImplementContracts()` と
`buildRepairPrompt()` は signal 無し（core のみ）で原則を選ぶため、初回実装 prompt と repair prompt には
載らない（Meta Review では focus 経由で載る）。`remediationStep.ts` と同じく `allowedPaths` から focus を
渡せば解消するが、repair prompt は Design Review で hash される canonical 文字列であり、進行中の
Lifecycle 修復と並行して変えない。後続 Task として Roadmap
`canonical-domain-meaning-missing-from-implement-and-repair-prompts`（planned）で追跡する。

## 検証

独立レビュー（Codex CLI はこの環境に無く、別コンテキストの agent で代替）: 初回 CHANGES_REQUESTED
（one-liner に上限が無い / verdict の混線 / AGENTS.md 014・015 との緊張 / checklist 重複 /
既存コードへの遡及 / lifecycle 例への偏り）→ 反映。再レビューで focused review の verdict 経路に
上限が届いていない blocker → `buildApplicablePrinciplesSection` へ移して解消。上の gap のみ記録に留めた。
最終修正に対する別 agent の再レビュー: PASS_WITH_NITS（blocker 解消を確認）。minor 1 件（実装者の「確認」も
Task scope 内に限定する）と文言 nit 2 件を反映。reviewerAdapter で verdict と issue が別々に出る点は仕様上許容し、変更しない。

## 追補（2026-10-28）: 修正範囲の選択と過剰汎用化の防止

CEO 指示「改善案を作る前に根本原因と適切な修正範囲を判断する」を受け、**同じ `evidence-not-spec` を拡張した**。
新しい原則・Gate・Review 工程・finding category は追加していない。

- **何が足りなかったか**: 既存の RCG は「同原因箇所を探して共通原因を直す」方向だけで、
  (1) 局所 / 共通機構 / 横断のどれを選ぶか、(2) 証拠の無い汎用化を防ぐ側、(3) 根拠不足時は推測せず調査、
  (4) 修正後に再発したら原因の命名が誤り＝範囲を広げる、が one-liner に無かった。Reviewer 側も
  対症療法だけを CONFLICT にでき、過剰な汎用化は principle verdict で捕まらなかった
- **入れたもの**: one-liner に (1)〜(4)。全文に 6 つの判断基準・既存機構改善の優先・「両側とも defect」・
  3 回連続失敗との接続（AGENTS.md Q10 / OpenCode 3-failure を停止点とし、同じ修正を繰り返さず 1 段広げる。
  CEO escalation は Constitution 3.15 のまま）・既存の review finding / decision の再利用。
  Reviewer の verdict 行・finding 行に「同原因の第 2 箇所が material に無い汎用化」を `[root_cause]` +
  over_constraint として追加（category は増やさない）
- **AGENTS.md Q10**: 「3 回で止めて CEO へ報告」→「3 回で止め、原因を命名し直して 1 段広げ、
  それでも根拠が無ければ CEO へ報告」。CEO への報告経路は残している（弱めていない）
- **「既存の 3 回連続で調査範囲を拡大する原則」について**: その文言の原則はリポジトリに無かった。
  最も近いのは AGENTS.md Q10（3 回で停止・CEO 報告）と OpenCode の 3 回連続失敗で戦略変更。これらへ接続した
- **届け先**: one-liner は core なので、`buildTaskDesignContract()`（初回実装・POST /jobs・repair・
  PL remediation・resume）と全 reviewer（Design Review / focused review / Meta Review / step review）へ
  既存経路のまま届く。blocked triage は決定論コードで prompt を持たないため対象外
- **代償**: `evidence-not-spec` の versionHash が変わり、ledger 実績はこの原則だけ 0 から数え直し（前回と同じ扱い）

### 検証

- 単体: 実装側 Design Contract・verdict 行・finding 行それぞれに新しい節が載ることを
  `engineeringPrinciples.test.ts` で固定。api / worker の prompt・ledger 系テストは通過
  （reviewerAdapter の symlink 2 件は Windows の EPERM で、変更前から失敗）
- 行動評価（blind・sonnet 1 サンプルずつ・新旧の配信テキストのみを与える）: 局所 / 共通 / 横断 /
  汎用化の罠 / 根拠不足 / 修正後再発の実装側 6 件は**新旧とも期待どおり**（旧文言でも既に機能していた）。
  差が出たのは reviewer の過剰汎用化ケース: 旧 = 原則 verdict ALIGNED（別の over_constraint finding のみ）、
  新 = CONFLICT `[root_cause]`。サンプル数 1 なので効果の大きさは主張しない。継続観測は既存 ledger の
  `[root_cause]` reason 検索で行う
