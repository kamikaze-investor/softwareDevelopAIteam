# Rule-003: Codex Usage Saving Policy

**Status: active**
**Date: 2026-09-02**
**Scope: Codex CLI を独立検証・難問Root Cause分析・重要diff reviewとして呼び出す全セッション（Claude Code / OpenCode Go / Worker 経由すべて）**

---

## 前提

- Codexの利用枠は特定タスク専有ではなく、**全セッションで共有される資源**として扱う
- 目的は品質を落とすことではなく、**同じ品質をより少ないCodex利用量で達成すること**
- このルールは `001_codex_integration_risks.md` / `002_codex_operation_rules.md` を補完する（置き換えない）

---

## 1. タスク境界（Rule-014）

### Rule-014: 1 Finding = 1 bounded task

```
Codexへ依頼する単位は「1つの特定されたFinding」に限定する。
複数Findingを1つの長大なCodexセッションへまとめない（Rule-021と対）。
```

---

## 2. 探索範囲の限定（Rule-015〜017）

### Rule-015: Codexへrepository全体の再調査をさせない

```
呼び出し元（Claude Code / OpenCode Go等）が既に得たEvidence・対象ファイルパス・
Root Cause候補をCodexへ渡し、Codexの探索範囲をそれらへ限定する。
Codexを「ゼロから調べ直す」用途で使わない。
```

### Rule-016: Codexは結論の独立検証を行うが、同じ情報収集を最初から繰り返さない

```
Codexの役割は「渡された結論・diffを独立した視点で検証すること」であり、
「同じ情報を独自にもう一度集め直すこと」ではない。
Context Pack / prompt には検証対象の結論とその根拠（ファイル・行・diff）を明示する。
```

### Rule-017: 必要なファイルだけ読む

```
無関係な履歴（広範囲のgit log）・無関係なPR・無関係なtestファイルを
広範囲に読み込ませない。読ませる範囲はFindingに直接関係するファイルに絞る。
```

---

## 3. モデル階層の選択（Rule-018〜020）

### Rule-018: 通常作業は軽量モデル優先、複雑domainのみ上位モデル

```
通常のCodex作業は利用可能な軽量モデルを優先して使う。
複雑なworkflow / concurrency / recovery等、明らかに難度の高いdomainのときだけ
上位モデルへ上げる。
```

### Rule-019: 最初から複雑と分かっている場合、軽量モデルで無駄に失敗させてから上げない

```
Findingの内容から見て最初から複雑さが明らかな場合は、
軽量モデルを経由させて失敗させてから上位モデルへ上げる、という消費をしない。
最初から適切なモデル階層を選ぶ。
```

### Rule-020: 無意味な連続retry禁止・provider error誤認防止

```
同じprompt・同じモデルへの無意味な連続retryは禁止する。
provider error / quota超過 / auth failureは「モデルの能力不足」と誤認して
再実行しない（原因が別なら再実行しても直らず、利用枠だけ消費する）。
```

---

## 4. ツール間の分業（Rule-021〜022）

### Rule-021: コード検索・広範囲Bug HuntingはOpenCode優先

```
コード検索や広範囲のBug HuntingはOpenCode（Go）を優先して使う。
明確な実装・test追加で、OpenCode/Copilot等の軽量経路が安全に処理できる場合も
そちらを優先する。
```

### Rule-022: Codexは「Codexを使う価値が高い部分」に集中させる

```
Codexは以下に集中させる（探索・実装の反復には使わない）:
  - 結論の独立検証
  - 難しいRoot Cause分析
  - 重要diffのreview
```

---

## 5. Quota制約下のfail-safe（Rule-023）

### Rule-023: Codex usage limit時も品質Gateは飛ばさない

```
Codexの利用枠上限に達した場合でも、既存の品質Gate（Independent Review等）を
スキップして先へ進めない。Codexが必須の作業だけを保留し、
それ以外の進行可能な作業は通常どおり続ける。
```

---

## チェックリスト（Codex呼び出し前）

```
[ ] このFindingは1件に絞られているか（複数Findingを混ぜていないか）
[ ] Evidence・対象ファイル・Root Cause候補を渡しているか（ゼロから調査させていないか）
[ ] 渡す範囲は関係ファイルのみか（無関係な履歴・PR・testを含めていないか）
[ ] モデル階層はFindingの難度に見合っているか
[ ] 直前に同じprompt・同じモデルで失敗していないか（provider error起因なら再実行しない）
[ ] OpenCode/Copilotで足りる作業をCodexへ回していないか
```

---

*Created by: CEO（Codex Usage Saving Policy指示） + Claude Code*
*関連: [001_codex_integration_risks.md](001_codex_integration_risks.md) / [002_codex_operation_rules.md](002_codex_operation_rules.md) / [AGENTS.md](../../../AGENTS.md) section 9*
