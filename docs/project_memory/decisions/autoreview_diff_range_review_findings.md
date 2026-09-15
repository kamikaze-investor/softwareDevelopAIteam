# Task `bd80c4ce`（Meta Reviewer 三点間 diff 修正）の Review finding 統合判断

**Importance Level: 2**
**Status: active**
**Date: 2026-09-15**

---

## 対象

Candidate commit `approval-20260914-8a6938ce`（HEAD `af60412`、変更は
`apps/worker/src/metaReviewer/autoReview.ts` と同 `.test.ts` の2ファイル）。
Independent Review の判定は**承認**、finding は medium 2件・low 3件。

CEO 指示（2026-09-15）に従い、**「Reviewer が言ったから変更する」のではなく**
事実・根拠・Design Philosophy との整合性を PL が確認した結果を残す。
判断ルールの正本は `docs/project_memory/rules/approval_rules.md`「Review finding の扱い」章。

---

## Finding 1（medium）: `.env` ロードの関数化に伴う副作用

**種別: 通常の品質・設計 finding → PL 統合判断の範囲**

### 何が変わったか

module scope の裸ブロック `{ ... }` で行っていた `.env` 読み込みを `loadEnvFile()` に切り出し、
`main()` の先頭で呼ぶようにした。

### 確認した事実

1. **ADR 0002 の順序要件は保たれている。** `main()` は `loadEnvFile()` を呼んだ**後に**
   `await import('./runner.js')` を評価する。`runner.ts` は module-level で `CONTROL_ROOT` を
   確定するが、動的 import なので `.env` ロード後に評価される。
2. **module scope の副作用に依存している呼び出し元は存在しない。** `autoReview.ts` を
   import しているコードはリポジトリ内に無い（参照はすべてコメント・ワークフローからの
   CLI 起動・テストのみ）。実行経路は `.github/workflows/meta-review.yml` の
   `tsx src/metaReviewer/autoReview.ts` だけである。
3. **副作用は増えていない。減っている。** 従来は `buildDiffRangeArgs()` を import するだけの
   テストでも実 `.env` が `process.env` へ流れ込んだ。この変更はそれを止める。
4. entrypoint 判定は `if (process.env.VITEST === undefined) main()` で、**判定できない場合は実行する**
   側に倒してある。逆向きにすると必須チェックが黙って何もせず exit 0 する（fail-open）ため、
   この向きが正しい。

### 判断

**変更不要。** finding が想定する「副作用が変わることによる不整合」は、上記1〜3により発生しない。
Design Philosophy 6（小さく変更）・8（効果検証可能性）にも反しない。

---

## Finding 2（medium）: `CONTROL REPOSITORY` ヘッダとの矛盾

**種別: Safety Boundary に関わる → PL は評価してよいが、単独で解決してはならない**

### 確認した事実

1. `apps/worker/src/metaReviewer/autoReview.ts` は 4 行目に
   `⚠️ CONTROL REPOSITORY — AI編集禁止` と書いている。
2. 同じヘッダは**30以上のファイル**に付いており、`alignmentChecker.test.ts` /
   `safetyAuditor.test.ts` / `geminiRouter.test.ts` のような**純粋なテストファイルにも付いている**。
3. **機械的に強制される**のは `ALWAYS_FORBIDDEN_PATTERNS`（`apps/worker/src/guards/fileChangeGuard.ts`）
   だけで、こちらは guard 群 / `jobRunner` / `safeEnv` / `apiAuth` / `gateClient` / `gatePolicy` /
   `metaReviewer/geminiClient` 等を**1行ごとに日付と根拠コメントを添えて厳選**している。
   `autoReview.ts` はそこに無い。
4. したがって**ヘッダと実強制範囲が一致していない**。finding は事実として正しい。

### 判断

**PL 単独では解決しない。** ヘッダを消す・書き換えるのは
「AI が自分の編集可能範囲を広げる」形になるため、PL の判断範囲外である。

代わりに次を行った:

- Roadmap 項目 `control-repository-header-vs-enforced-guard` として登録し、
  **master への Promotion 前に解消する条件**とした（CEO 指示）
- 今回の Candidate commit 自体は CEO が承認した。commit は `candidate/self-dev` に載るだけで、
  `git_push` に相当する CommandKind が存在しないため master へは届かない。
  master へ行くには外部セッションが PR を開く必要があり、そのとき審査するのは
  **master 側の** `autoReview.ts` である（自己審査の輪にならない）

### 解消時に答えるべき問い（CEO 提示）

- `CONTROL REPOSITORY` の正式な意味は何か
- どのファイルが**本当に** AI 編集禁止なのか
- `ALWAYS_FORBIDDEN_PATTERNS` が正式な強制境界なのか
- `allowedPaths` との関係はどうなるのか
- **コメントと機械強制のどちらを Source of Truth とするのか**

Safety Boundary 変更に当たる場合は CEO へ Escalate する。

---

## low 3件

`combined diff` 形式の稀ケース / tmp リポジトリ関連。いずれも今回の変更が作った問題ではなく、
現行の挙動を変えない。**変更不要**とし、必要になった時点で個別に扱う。
