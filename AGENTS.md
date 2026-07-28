# AGENTS.md — AI Development Team OS

Claude Code・Codex 両エージェントが従う共同運用ルール。
**Worker がこのファイルを ContextPack に自動包含する。**
**Claude Code はセッション開始時に自動読み込みする（CLAUDE.md 経由）。**

最終更新: 2026-06-04

---

## 1. ワークツリー境界（最重要）

| エージェント | 作業ディレクトリ | 触れるもの |
|---|---|---|
| **Claude Code** | `/workspace/target` | `target-project/` 配下のみ |
| **Codex** | `/workspace/target` | `target-project/` 配下のみ |

**絶対に触れないもの（どちらのエージェントも）:**
- `/workspace/control` 配下（AI Development Team OS 本体 = Control Repository）
- `.env` / APIキー / 秘密鍵
- `docker-compose.yml` / `Dockerfile` / `sandbox/`
- `git push --force`

**分離の仕組み（手動ではなくDockerが強制）:**
- Control Repository → `:ro`（read-only mount）でコンテナに渡す
- Target Repository → read-write でコンテナに渡す
- エージェントは物理的に Control Repository を書けない

---

## 2. コミットメッセージ規約

```
[claude_code task-xxx] feat: 機能名
[codex task-xxx]       fix: 修正内容
[human]                docs: 人間による変更
```

`git log --oneline` が誰が何をしたかのタイムラインとして読める状態を維持する。

Worker が `agentPrefix` を自動でセットするため、AI 側が手動で付ける必要はない。

---

## 3. 役割分担

| タスク種別 | 担当 | 理由 |
|---|---|---|
| 新機能・ゼロからの実装 | **Claude Code** | 設計判断・複雑な推論が必要 |
| 複雑なアーキテクチャ変更 | **Claude Code** | クロスファイル整合性確認が必要 |
| AI プロンプトチューニング | **Claude Code** | 品質に直結・意図の理解が必要 |
| 設計判断が必要なバグ修正 | **Claude Code** | 根本原因の推論が必要 |
| 共有ドキュメントの更新 | **Claude Code** | 設計意図の把握が必要 |
| 既存コードへの局所的な修正 | **Codex** | 高速実装・パターン踏襲 |
| テンプレート的な繰り返し実装 | **Codex** | コード生成の得意分野 |
| 軽微なバグ修正 | **Codex** | 高速 |
| Claude Code 障害時のフォールバック | **Codex** | API エラー時のみ切り替え可 |

**1タスク = 1プロバイダー原則: 同一タスク内で両方を混在させない。**

### 3-1. レビュー・判断を含めた全体の役割分担

上表はClaude Code/Codexの実装担当振り分けだが、実際の開発フローにはレビュー・判断を行う他のAIも関わる。

| 役割 | 責務 | 最終判断権限 |
|---|---|---|
| **Codex** | 通常実装（上表参照）。危険箇所・設計判断が必要な変更を見つけたらClaude Codeへ上げる | なし |
| **Claude Code** | 設計・進行計画・危険箇所実装（上表参照） | なし（自分の変更を最終承認しない） |
| **Gemini** | 低コストなレビュー・監査レイヤー（Risk Review・Alignment Review・Meta Review・preReview・postReview・Report Translation）。単一の「判断担当」ではない | なし（warning/uncertain/blockedはClaude Code/ChatGPT/Humanへエスカレーション） |
| **ChatGPT** | 重要判断・コミット前判断・人間向け整理（Gemini判断が不確実な場合・高リスク変更・コミット可否判断が必要な場合に使う） | 高リスクはCEO承認を要求 |
| **Human / CEO** | Goal/Design Philosophy・外部サービス・課金・本番環境・認証権限・破壊的変更の最終判断 | 最終承認者 |

**Review Level 0〜3:** 変更内容はLevel 0（軽微・Codexのみ）/ Level 1（通常実装・Codex+Gemini postReview）/
Level 2（中リスク・Claude計画+Gemini pre/postReview、必要ならChatGPT）/ Level 3（高リスク・Claude設計+
Gemini Risk/Alignment Review+ChatGPT判断レビュー+Human/CEO確認）に分類する。
**Levelは「docsかコードか」ではなく影響範囲で判断する** — AI役割分担・レビュー方針・運用ルールに関わる
ドキュメント変更はコード変更を伴わなくてもLevel 1〜2相当として扱う。
詳細は [docs/multi_ai_step_review_flow.md](docs/multi_ai_step_review_flow.md) を参照。

**Codexへの作業指示はLevelに応じて前提量を最適化する**（Level 0-1は軽量、Level 2以上は前提不足/過多を内部チェック、Level 3は安全境界を削らない）。詳細は同ドキュメント11-1章「プロンプト前提量最適化」を参照。

---

## 4. 自律修正ループ（暫定 — task-009実装まで）

> ⚠️ **暫定ルール**: Worker Job実行エンジン（task-009）が実装されたら
> このセクションを削除し、Workerが自動で結果を処理するフローに移行する。

`git push` → PR作成後、**CEOを待たずに自分でCIとMeta Reviewの結果を読んで修正する**。

### ループの流れ

```
1. git push origin ai/task-xxx
2. PR を作成（未作成の場合）
   gh pr create --base master --title "[codex task-xxx] ..." --body "..."
3. CI と Meta Review の完了を待つ
   gh pr checks <PR番号> --watch
4. 結果を読む（後述）
5. 問題があれば修正 → commit → push → 3へ戻る
6. 両方 approved になったら CEO に報告して終了
```

### CI の結果の読み方

```bash
# チェック一覧と状態を確認
gh pr checks <PR番号>

# 失敗したランのログを確認
gh run list --branch ai/task-xxx
gh run view <run-id> --log-failed
```

**CI が失敗した場合 — 複雑度で即分岐:**

まず「単純か複合か」を判定してから動く。修正を試みて失敗を繰り返さない。

```
エラーログを読む
  ↓
【判定】原因が1つで明らか？
  │
  ├─ YES（単純）
  │    → 修正 → commit → push → ループへ
  │    → それでも失敗したら「複合」として扱い直す
  │
  └─ NO（複合 / 原因不明 / 複数ファイル）
       → 修正を一切しない
       → 以下のトリアージを実施してから動く
```

**複合エラー時のトリアージ手順:**

1. `gh run view <run-id> --log-failed` で全エラーを収集する
2. 根本原因（症状ではなく原因）を特定する
3. 前提条件を洗い出してリスト化する
   ```
   例:
   [ ] 1. packages/shared の型エクスポートが不足
   [ ] 2. apps/api のimportパスが古い
   [ ] 3. テストが新しい型を参照していない
   ```
4. 依存順（上流から下流）に並べ替える
5. **1件ずつ修正 → `git commit` → 次の件へ（まとめてpushしない）**
6. 全件完了したら `git push` → ループへ戻る

**なぜ1件1コミットか:**
- Meta Reviewer AI が各修正を独立してレビューできる
- どの修正が問題を引き起こしたか追跡できる
- ロールバックが1コミット単位でできる

**それでも直らない場合:**
- 3件連続でトリアージが失敗したら **CEO に報告して停止**

### Meta Review の結果の読み方

```bash
# PR コメントを取得（Meta Review の JSON 判定が含まれる）
gh pr view <PR番号> --comments
```

出力内の `## ✅/⚠️/🚫 Meta Review` コメントを確認する。

**`approved`（✅）の場合:**
- CI も Pass であれば CEO に報告して終了

**`changes_requested`（⚠️）の場合:**
- コメント内の「検出事項」を全件リストアップする
- 依存順（根本原因が先）に並べ替える
- **1件ずつ修正 → `git commit` → 次の件へ**
- 全件完了したら `git push` → ループへ戻る
- （CIと同様：1件1コミットでMeta Reviewerが追跡できる状態を保つ）

**`blocked`（🚫）の場合:**
- **即座に作業を停止する**
- CEO に報告する（自己判断で「blocked を回避しようとしない」）
- blocked はセキュリティ違反の検出であり、修正方針はCEOが判断する

### 正常終了の条件

以下の両方が揃ったら CEO に報告し、マージを待つ:

```
CI (Typecheck & Test)        → ✅ Pass
Meta Reviewer AI (Gemini)    → ✅ approved
```

マージは **CEO（人間）が行う**。AIはマージしない。

### task-009実装後の自動フロー（本来の姿）

```
approved          → Worker が自動でマージ → 次タスクへ
changes_requested → Worker が修正Jobを自動作成
blocked           → Worker が自動でCEO通知・Job停止
```

---

## 5. Worker が管理するセッションライフサイクル

Worker が自動的に実行する（手動操作不要）:

**Job 開始前:**
1. 最新コミットを取得（`git pull`）
2. ContextPack を生成（前 Job がコミットを作成した場合は必ず再生成）
3. provider=codex の場合: CLAUDE.md + AGENTS.md をプロンプト先頭に注入

**Job 終了後:**
1. File Change Guard で変更ファイルを検査
2. provider=codex の場合: `pnpm lint --fix` を自動実行
3. `docs/session-log.md` にハンドオフエントリを追記
4. Meta Reviewer AI (Gemini) でレビュー
5. `approved` → commit & push → 次 Job へ
6. `blocked` → CEO 通知・停止

---

## 6. TypeScript 品質ルール（AIの悪い癖を先回りで潰す）

### Q1. 型をサボらない

- 関数の引数・戻り値には必ず型を書く
- `any` を使う場合はコメントで理由を明記
- `@ts-ignore` は原則禁止

```typescript
// NG
function process(data) { ... }

// OK
function process(data: TaskInput): Promise<TaskResult> { ... }
```

### Q2. 型定義は packages/shared のみ

- ビジネスの型（Project / Task / Job 等）は `packages/shared/src/types/` だけで定義する
- アプリ内でローカル型を再定義しない
- `apps/api/` や `apps/worker/` で同じ構造を別途 `interface` しない

### Q3. UIにビジネスロジックを書かない

- `apps/mobile/` は表示のみ。API呼び出しと画面描画に徹する
- 計算・判断・変換ロジックは `apps/api/src/core/` または `apps/worker/src/` に書く
- 1関数が80行を超えたら分割する

### Q4. スコープを勝手に拡張しない

- タスクで指定されたファイル以外は触らない
- 新規ライブラリの追加は Yellow Zone（CEO承認必要）
- 「ついでに○○も改善しました」は禁止。気づいた問題は報告するだけ

### Q5. テストなしで完了しない

- `apps/worker/src/` の新規関数は必ずユニットテストを追加する
- `assert result !== undefined` だけのテストは禁止
- テストが壊れたとき、テストを変えるのではなく実装を直す

### Q6. エラーハンドリングをサボらない

- `catch` ブロックで `console.error` だけで終わらせない
- エラーをログに記録し、適切な型で上に伝播させる
- Promiseの未処理rejectionを放置しない

```typescript
// NG
try { ... } catch (e) { console.error(e) }

// OK
try { ... } catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  throw new AppError(`git_commit failed: ${msg}`, { cause: e })
}
```

### Q7. 環境変数を追加したら .env.example も更新する

- 新しい環境変数を追加したら必ず `.env.example` にキー名だけ（値は空）追記する
- `.env` は絶対にコミットしない（`.gitignore` で除外済み）
- APIキー・パスワードをコードにハードコード禁止

### Q8. Git 運用を丁寧に

- 1コミット = 1タスク（複数機能を詰め込まない）
- コミットメッセージは `[claude_code task-xxx] feat: ...` 形式（Worker が自動付与）
- `main` / `master` への直接コミット禁止 → `ai/task-xxx` ブランチで作業
- `git push --force` 絶対禁止
- 他エージェントが担当するファイルへの変更は引き継ぎ依頼として報告する

### Q9. 担当領域を侵犯しない

| 担当 | 触っていいファイル |
|---|---|
| Claude Code | 新機能・複雑実装・アーキテクチャ変更 |
| Codex | 既存コードへの局所修正・パターン的実装 |

担当外の変更が必要になったら作業を止めて引き継ぎ依頼を出す。

### Q10. 動作確認なしで「完了」と言わない

- TypeScript ファイルを変更したら `pnpm typecheck` でエラーがないことを確認する
- ロジック変更を伴う場合は `pnpm test` を実行する
- エラーが3回連続で直らない場合は作業を止めてCEOに報告する（無限ループ防止）

### Q11. 秘密情報をコミットしない

- `.env` は絶対にコミットしない
- APIキー・DBパスワードをコードにハードコード禁止
- 新しい環境変数を追加したら `.env.example` にキー名だけ追記する
- ContextPack にシークレットが含まれていないか `isPromptSafe()` で確認済みのはず

### Q12. ドキュメントを同時に更新する

- 新機能追加・型定義変更時は同じコミット内で以下を更新する:
  - `tasks/task_graph.md`（target-project側のタスク状態・依存関係。CTO AI / `roadmapWriter.ts`が
    生成・更新する対象）
  - `docs/project_memory/` （設計判断があれば）
  - `docs/session-log.md`（ハンドオフエントリ）
- Control Repository自身の開発タスクについて:
  - タスク開始時に、既存`tasks/roadmap.md`項目への影響・新しい追跡対象の発生・影響なしの
    いずれかを確認する
  - 進捗状態が変化した場合や記載漏れを発見した場合は`tasks/roadmap.md`を更新する
    （`tasks/task_graph.md`とは別ファイル・別スコープであり、同じ状態を両方へ重複記録しない）
  - 状態変更には可能な限り`pnpm roadmap:update` / `pnpm roadmap:sync`を使う
  - 完了報告前に`pnpm verify`を実行する
  - 完了報告には対象ロードマップ項目と最終stateを記載する
  - 進捗に影響しない小規模修正では`tasks/roadmap.md`の更新は不要
- `AGENTS.md` 自体の変更は、CEOが具体的diffを明示承認した場合に限り実施する。AIによる
  無承認変更は禁止する。Goal・Design Philosophy・権限・安全方針に影響する変更は必ずCEO承認を得る

---

## 7. ハンドオフログ（docs/session-log.md）

Worker が各 Job 完了時に自動追記する。フォーマット:

```
YYYY-MM-DD HH:MM JST [provider task-xxx] 何をしたか / 何が残っているか
```

エントリは追記のみ。過去エントリは絶対に編集しない。

---

## 8. BLOCKED セクションの使い方

一方のエージェントの作業完了待ちになったとき、`docs/session-log.md` の末尾に追記:

```
BLOCKED [claude_code → codex task-xxx] 何が必要か (YYYY-MM-DD)
```

解決したら `RESOLVED` エントリを追加する（既存エントリは消さない）。

---

## 9. Codex 固有の注意事項

- **CLAUDE.md / AGENTS.md を自動読込しない** → Worker が ContextPack に自動注入
- **コマンド実行できない**（`--approval-mode auto-edit`）→ Worker が別途コマンドを実行
- **1タスク = 1プロバイダー**：Claude Code と同一タスクで混在させない
- Context Pack が古い場合（前 Job のコミット後）は実行前に再生成される

### Codex 呼び出し運用ルール（詳細: `docs/project_memory/rules/002_codex_operation_rules.md`）

| # | ルール | 要点 |
|---|---|---|
| 001 | CLI パス解決 — CODEX_CLI_PATH 最優先 | 環境変数 > codex.cmd > codex |
| 002 | Windows では codex.cmd を優先 | npm global の .cmd を PATH 走査で探す |
| 003 | WindowsApps 配下の codex は拒否 | Access Denied 回避。npm install -g @openai/codex を案内 |
| 004 | 事前疎通確認（codex --version） | ok=false なら実行しない |
| 005 | workdir は許可済みルート配下のみ | validateTargetRoot() で強制 |
| 006 | targetProjectRoot/allowedPaths は正規化・範囲検証 | validateAllowedPaths() で強制 |
| 007 | 機密ファイル（.env/*.pem/*.key/id_rsa 等）は読み取り・変更禁止 | allowedPaths から除外 |
| 008 | デフォルト実行モードは review-only（-s read-only） | ファイル変更はデフォルト無効 |
| 009 | 実ファイル変更は mode=implement + approved=true + mockRun=false の三点揃いのみ | 1つでも欠けたら 403 |
| 010 | git push / PR approve / merge / branch protection / workflows / CODEOWNERS は自動実行禁止 | SafeCommand allowlist で除外 |
| 011 | mock 実行を完了扱いにしない | status='mock' では task_graph を [x] にしない |
| 012 | 呼び出しごとにログ保存（taskId/cliPath/workdir/promptPath/changedFiles/exitCode/stdout/stderr） | `docs/codex_invocation_log/` に保存 |
| 013 | guards/workflows/CODEOWNERS/security 関連ファイルの変更は Red Zone — 人間承認必須 | FileChangeGuard で検出 → blocked |
