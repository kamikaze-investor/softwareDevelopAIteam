# Development Rules

**Importance Level: 1**
**Status: active**

---

## Safety Audit Gate（最重要 — AI開発者必須）

> **Claude Code はこのリポジトリへのコミット前に必ず Safety Audit を実行すること。**

```powershell
# PATH をセットしてから実行
$env:PATH = "C:\Program Files\nodejs\geminiCLI\node_modules\corepack\shims;" + $env:PATH
cd C:\Users\honka\softwareDevelopAIteam
pnpm --filter @ai-team/worker audit:gate
```

### 判定ルール

| 結果 | 終了コード | Claude Code の行動 |
|------|-----------|-------------------|
| `ALLOW` | 0 | そのままコミット可 |
| `DEEP_REVIEW` | 1 | ユーザーに内容を報告し、確認を取ってからコミット |
| `BLOCK_CEO_REQUIRED` | 2 | コミット禁止。ユーザー（CEO）の明示的な承認なしに進めない |

- Gemini API が一時的に失敗した場合、Alignment Check をスキップして静的解析（Policy Guard）だけで Gate 判定する
- DEEP_REVIEW / BLOCK の場合は必ずユーザーに判定理由を見せること

---

## コミットルール

- 1タスク = 1コミット
- 大きいタスクは 1サブタスク = 1コミット
- コミットメッセージ形式: `[task-xxx] 変更内容の要約`
- mainブランチへ直接pushしない
- 作業ブランチ: `ai/task-xxx`

## 実装ルール

- UIにビジネスロジックを書かない（coreレイヤーに集約）
- テストなしで完了とみなさない
- `.env.example` は更新するが `.env` は触らない
- 型定義は `packages/shared` に集約する

## Context Packルール

- Developer AIはProject Memoryを直接読まない
- Context Pack経由でのみ情報を参照する
- Context Packは `POST /api/context-pack`（`apps/api/src/routes/contextPack.ts`）のレスポンスとして
  返される（ファイルとして `docs/context/` へ保存する実装ではない）

## Document Rot防止ルール

- **Current Truth優先**: Constitution / Architecture / Current State / Roadmap / 現行Feature仕様など、
  「現在有効な仕様・計画・状態」を示すDocでは、仕様変更時に古い記述へ「ただし現在は〜」を
  追記して両方残すのではなく、該当箇所そのものを現在の結論へ更新する
- **履歴はDecision/ADR/Lessonへ分離**: なぜその判断をしたか・以前の設計・却下案・失敗からの学びなど
  過去の判断経緯は、必要な場合に限り`docs/project_memory/decisions/`等の履歴用Docへ記録する。
  既存Decision/Lessonに同内容が既にあれば重複追加しない
- **重複コピー禁止**: 同じTruthを複数Docへ独立コピーしない。別Docが正本の場合は「短い説明＋
  正本への参照」を優先する
- **新しい設計判断の記録先**: 新規ADR/Decisionは `docs/project_memory/decisions/`
  （コードから実際に参照される現行の正本）へ記録する。`docs/adr/`（0001・0002のみ）は
  過去記録であり新規追加先ではない
- **Roadmap（`tasks/roadmap.md`）固有ルール**: Roadmapは「現在有効な計画・確定事項・未解決事項」を
  保持するDoc。後続調査で結論が変わった場合、古い結論への訂正追記を積み重ねず該当箇所を
  現在の結論へ更新する。各項目冒頭へ「現在の結論サマリー」を機械的に追加する運用は、
  本文との二重Truthを生むため採用しない

## 調査前チェック: checkout が Current Truth か（CEO 指示・2026-09-21）

**「この機能は存在しない」と結論する前に、作業ツリーが最新かを確認する。**

```bash
git fetch origin && git rev-list --count HEAD..origin/master
```

- 0 でなければ、判断の根拠を作業ツリーから取らず **`origin/master` から取る**
  （`git show origin/master:<path>` / `git ls-tree -r --name-only origin/master`）
- **「無い」と結論する前に未 merge の実装も見る**: `git log --all --grep=<topic> -i` と
  `git show --stat <commit>`。実装が別 branch にあるだけのことがある
- 遅れを解消するとき、`master` が他 worktree に checkout されていると main checkout では
  `master` を checkout できない（`git worktree list` で確認）。その場合は現 branch を
  `git merge --ff-only origin/master` で進めるだけにし、
  **他 worktree の branch を奪ったり worktree を削除したりしない**
- 未保存変更・local-only commit・stash がある場合は**破棄せず停止**して報告する

**実測（2026-09-21）**: main checkout が `origin/master` より **118 commit 遅れ**、branch は
merge 済みの feature branch のままだった。その状態で System One の設計 audit を行い
「`principle_applications` は存在しない / Principle 単位の verdict 記録は無い」と誤結論した。
実際には 2026-09-17 に実装・merge され production で稼働しており、**CEO 側の前提が正しかった**。
訂正の経緯は `specs/23_system_one_decision_layer.md` 0-1章。

本ルールは上記「Document Rot防止ルール」の Current Truth 原則を**コード側へ適用**したものであり、
新しい仕組み・新しい Roadmap item を追加するものではない。

## Secret の確認結果の出し方（CEO 指示・2026-09-15）

credential が設定されているかを確認したとき、AI が出力してよいのは
**`configured` / `not configured` まで**である。

- **値を出さないのは当然として、長さ・接頭辞・文字種・形式の妥当性も出さない。**
  いずれも secret に関する情報であり、確認報告に載せる必要が無い
- 形式検査が機能上必要な場合（例: LINE の User ID を入れるべき場所に表示名が入っている取り違えの検出）は、
  **検査は行ってよいが、出力するのは判定結果だけ**にする（「形式は妥当」/「形式が違う」）
- この規則は chat 出力だけでなく、**commit する ledger・決定記録にも同じく適用する**

実例（是正済み）: `LINE_CHANNEL_ACCESS_TOKEN=SET(len=172)` のような長さ付きの報告を行い、
CEO から中止の指示を受けた。該当箇所は `configured` 表記へ書き換えた。

## 禁止事項

- Control Repository (`apps/api/`, `apps/worker/`, `sandbox/`) の改変
- `.env` / secret filesの読み書き
- secret の値・長さ・形式を AI 出力へ載せること（上記参照）
- `sudo`, `rm -rf /`, `curl | sh` などの危険コマンド
- mainへの直接push

---

*Created: 2026-05-28*
