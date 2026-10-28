# MG-D11 のコメント起因 false positive — 既知の制約（2026-10-27）

対象ルール: Mechanical Gate **MG-D11**（`packages/shared/src/approvalLevelClassifier.ts`、
`/^\+.*(payment|billing|stripe|課金)/im`）。

この記録は**既知の制約として受け入れた判断**を残す。MG-D11 は変更していない。
fail-closed の挙動、Approval Gate、Approval レコードはいずれもそのままである。

---

## 1. 何が起きたか

- Task `31a01411`（Roadmap `role-model-registry`、risk LOW）の git_commit Job `4503faf2` が
  Git_commit Safety Evidence で `insufficient_safety_evidence`（`failed=mechanical_gate_hit`）になり、
  Approval `approval-20261027-d88ee26d`（git_commit、LOW）が作られた。
- MG-D11 に当たったのは**コメント1行だけ**だった。「Registry の1行を書き換えただけで、従量課金 API など
  新しい実行経路が標準経路として使われ始める」ことを**防ぐ**、という説明の JSDoc である。
- 実行されるコードの変更は課金とは無関係だった。新規ファイルは型と検証だけで、import は
  `./types/ai_cli` の型だけ、network / env / fs の利用なし、package.json・lockfile の変更なし。
  `ROLE_MODEL_EXECUTION_KINDS = ['ai_cli']` は従量課金 API 経路を**拒否する**側の制約である。
- したがってこの承認要求は Human Decision Authority ではなく、**証拠不足による fail-closed** である。
- CEO が既存の Approval 経路で承認し（2026-10-27T08:26Z、`approval_actor=human`）、
  通常の git_commit（Candidate `0a6385b2`、親 `5d73130c` = 承認時の target_commit、承認時と同じ diff hash）、
  Task done、continuation completed、次の Roadmap 項目の採用まで進んだ。

## 2. 検討して採らなかった変更: コードコメントを MG-D11 の対象から外す

最小の変更として、JS/TS ファイルの行頭 `//` コメントと完結した JSDoc ブロックだけを MG-D11 の評価から外す
プロトタイプを作った（push していない）。テストと typecheck は通った。

独立レビュー（Codex）は **changes_requested** で、見逃し（false negative）を2つ示した:

1. **肯定側のコメント + 中立な名前のコード**。`/** Creates a Stripe charge */` の直後が
   `provider.post('/v1/charges', …)` のような場合、現行は検出するが、変更後は課金語がコメントにしか無いため検出しなくなる。
2. **テンプレートリテラル内の `//` 行**（例: 複数行文字列の中の `//billing.example.com`）がコメントとして落ちる。

2 は直せるが、1 は直せない。キーワード規則は「課金を**禁じる**説明」と「課金を**追加する**説明」を区別できず、
コメントは後者の検出信号でもあるからである。よって**コメント除外・キーワード絞り込みは採らない。**

## 3. 受け入れる制約

- MG-D11 は、課金語を含む説明コメントでも当たる。その場合、LOW / MEDIUM の git_commit でも
  既存の人間承認が1回必要になる。これは安全側の誤りとして受け入れる。
- 頻度（実測）: Git_commit Safety Evidence が記録され始めた 2026-10-15 から 2026-10-27 までの評価 13 件のうち、
  `mechanical_gate_hit` が唯一の失敗理由だったのはこの Task だけだった（同じ Job の再評価を含め 2 行）。
  1 件あたりのコストは承認 1 回である。

## 4. 今後の扱い

- **新しい Gate・追加の承認機構・重複する分類器は作らない。**
- 実装 AI に「コメントで課金語を避けさせる」指示も**しない**。肯定側のコメントという検出信号まで消えるため、
  MG-D11 の検出力が落ちる。
- false positive を減らす方向は、課金・有料サービスの**本物の**変更を検出できる場合に限って検討する。
  候補は、変更の方向（追加か禁止か）を証拠つきで判定する意味的な Safety 判断である
  （`specs/22_safety_approval_design_principle.md` の多層防御の方向）。採るときは同 spec に沿った個別の設計と
  CEO 判断を経る。
- 現状、Safety Evidence の audit 行には `mechanical_gate_hit` としか残らず、**どのルールが当たったか**は残らない
  （今回は diff を手で再評価して MG-D11 と特定した）。今後の頻度をルール別に測るには、
  当たったパターン ID を audit に残すのが前提になる（挙動は変えない観測だけの変更）。
