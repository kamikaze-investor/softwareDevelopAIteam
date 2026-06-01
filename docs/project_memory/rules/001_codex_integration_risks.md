# Rule-001: Codex CLI 併用リスクと対策

**Status: active**
**Date: 2026-05-30**
**Scope: Developer AI（Claude Code + Codex 並用時）**

---

## 洗い出した問題リスト

Claude Code と Codex CLI を同一システムで並用する場合の問題点・リスクを網羅する。

---

### 🔴 HIGH — 今すぐ対処が必要

---

#### H-1: CLAUDE.md が Codex に読まれない

**問題**
Claude Code は `CLAUDE.md` を自動読込する。
Codex は読まない。
ContextPackに含めなければ、Codexはシステムの制約（禁止事項・コーディングルール）を知らずに動作する。

**リスク**
- Control Repository を編集しようとする
- テストなしで実装を完了する
- コミットメッセージが `[task-xxx]` 形式にならない
- Yellow Zoneの操作を無断で実行する

**対策**
```
Context Manager AI の生成ルール:
  provider=codex のとき、ContextPack に以下を必ず含める
  - CLAUDE.md の Authority Principle（Green/Yellow/Red Zone）
  - Repository Boundary（Control/Target）
  - Development Rules（コミットルール・コーディングルール）
  - Escalation Rules（CEOへの通知条件）
```

**実装状況**: ✅ `BaseCliAdapter.run()` で自動注入済み（`injectClaudeMdEssentials()`）
- provider=codex のとき CLAUDE.md を読み込みプロンプト先頭に注入する
- CLAUDE.md が見つからない場合はフォールバック定数（最重要ルール）を使用
- `injectClaudeMd: false` で明示的にスキップ可能（テスト用）

---

#### H-2: Context Pack の鮮度（Staleness）問題

**問題**
Claude Code が機能Aを実装してコミット後、
古いContext PackのままCodexが機能Aを編集しようとする。

**リスク**
- Codexが古い仕様・古いAPIシグネチャで実装する
- Claude Codeの設計判断を上書きする
- 型不整合・バグの混入

**対策**
```
Worker のジョブ実行ルール:
  1つ前のJobがコミットを作成した場合、
  次のJobのContextPackは必ず再生成する（キャッシュ禁止）
```

**実装状況**:
- ✅ `AiCliRequest.requiresFreshContextPack?: boolean` を型に追加済み
- ✅ `AiCliRequest.contextPackGeneratedAt?: string` を型に追加済み
- ⏳ Worker が前Jobのコミット時刻と比較して自動セットする処理は task-009 で実装

---

### 🟡 MEDIUM — 設計時に対処が必要

---

#### M-1: 1タスク内でのプロバイダー混在

**問題**
「タスクの前半はClaudeが設計、後半はCodexが実装」という運用をすると、
Context Pack・設計判断の一貫性が保てない。

**リスク**
- 設計と実装で異なるパターンが混在する
- ロールバックスコープが曖昧になる（どこまで戻す？）
- Meta Reviewer が「誰が書いたコードか」を判断できない

**対策**
```
1タスク = 1プロバイダー原則（厳守）
  - タスク作成時に provider を指定する（Task型に追加）
  - 同一タスクで provider を切り替えない
  - 途中で失敗した場合は別タスクとして再実行する
```

---

#### M-2: フォールバックタイミングの曖昧さ

**問題**
Claude Codeが失敗したとき、いつCodexに切り替えるか？
「品質が悪い」「タイムアウト」「APIエラー」で基準が違う。

**リスク**
- 品質の悪い実装のままCodexに渡してさらに悪化する
- 切り替えを繰り返してコストが増大する
- どちらの結果が正式か曖昧になる

**対策（フォールバック条件を明示）**

| 理由 | 対応 |
|---|---|
| API エラー（5xx・timeout） | Codexに切り替えてリトライ可 |
| 品質問題（Meta Review: changes_requested） | 同じClaudeで修正Jobを作成。Codexへの切り替えは原則禁止 |
| 品質問題（Meta Review: blocked） | CEO承認まで停止。切り替え不可 |
| タスク定義の問題（実装不可） | タスクを分割してCTOAIに差し戻す |

**実装状況**:
- ✅ `AiCliRequest.fallbackPolicy?: FallbackPolicy` を型に追加済み
- ✅ `shouldFallback()` ヘルパー関数を `@ai-team/shared` に追加済み
- ⏳ Worker が `shouldFallback()` を呼び出して自動切り替えする処理は task-009 で実装

---

#### M-3: Rollback設計の複雑化

**問題**
ClaudeとCodexが順に同じファイルを編集した場合、
ロールバックの粒度が「Codexの変更だけ戻す」「Claudeまで含めて戻す」で変わる。

**リスク**
- 中間状態が残る
- 「Codexの変更は戻したいがClaudeの変更は残したい」が難しくなる

**対策**
```
1タスク = 1コミット原則を厳守
  Codexが編集 → Workerがcommit → 次のタスクへ
  コミットを挟まず連続編集しない
  ロールバックは常に "1コミット単位" で行う
```

---

#### M-4: コーディングスタイルの不一致

**問題**
ClaudeとCodexでは命名規則・コメントスタイル・パターン（class vs function等）が微妙に違う。
同じファイルを複数回にわたって別プロバイダーが編集するとスタイルが混在する。

**リスク**
- コードレビューのコストが増える
- 統一感がなくなりメンテナンス性が落ちる

**対策**
```
Prettier + ESLint を Guard の一部として位置づける
  ContextPackに .eslintrc / .prettierrc の内容を含める
  CLIの実行後、Workerが自動でlint/formatを実行する（SafeCommandのlintを使う）
```

**実装状況**: ✅ `BaseCliAdapter.run()` で provider=codex のとき `pnpm lint --fix` を自動実行済み
- 失敗しても non-fatal（警告のみ）
- 変更ファイルがある場合のみ実行
- `postLint: false` で明示的にスキップ可能

---

### 🟢 LOW — 中長期で対処

---

#### L-1: Meta Review プロンプトのClaude偏り

**問題**
Meta Reviewer AIのプロンプト（`docs/meta_reviewer/prompt.md`）は
Claude Codeが書くコードのパターンを想定している。
Codexが導入する特有のパターン（import順、エラーハンドリングスタイル等）をうまく評価できない可能性。

**対策**
```
Meta Reviewerプロンプトをプロバイダー中立に更新する（Phase 2以降）
セキュリティ判定基準（Cage弱体化）はプロバイダー非依存なので影響は小さい
```

---

#### L-2: レート制限の二重管理

**問題**
AnthropicとOpenAIのレート制限を別々に追跡する必要がある。
一方が制限に達したとき自動的に他方に切り替える仕組みがない。

**対策**
```
Phase 2以降でWorkerにrate limit trackerを追加
  現時点: 手動でAPIキーを確認してフォールバック
```

---

#### L-3: テストコードのスタイル不一致

**問題**
ClaudeとCodexではテストコードのパターンが違う可能性（describe構造・アサーション等）。

**対策**
```
ContextPackにtest/の既存テストファイルを必ず含める
「既存パターンに合わせて書くこと」をプロンプトに明記する
```

---

## まとめ: Worker実装時に対処すべき項目

task-009（Worker Job実行エンジン）の設計で以下を組み込むこと:

```typescript
// Task型に provider を追加（task-009で対応）
interface Task {
  assignee: AgentRole
  provider?: AiCliProvider  // ← 追加（指定なければClaudeCode）
  // ...
}

// Job実行前チェック
// 1. 前Jobがコミットを作成した場合、ContextPackを必ず再生成
// 2. providerごとにContextPackに追加情報を注入
//    - codex: CLAUDE.md要点を追加
// 3. Jobのfallback条件を評価（APIエラーのみCodexへ切り替え可）
```

---

*Created by: CTO AI — Codex CLI 併用設計レビュー*
