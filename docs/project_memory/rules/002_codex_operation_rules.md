# Rule-002: Claude Code → Codex 呼び出し運用ルール

**Status: active**
**Date: 2026-06-17**
**Scope: Claude Code が Codex CLI をサブエージェントとして呼び出す場合の全操作**

---

## 前提

- Codex はローカル CLI（`codex exec`）として実行される
- Claude Code が Codex をサブエージェントとして呼ぶ
- 安全性を優先し、無制限の自動実行は禁止する
- このルールは `001_codex_integration_risks.md` の H-1〜M-4 を補完する

---

## 1. CLI パス解決（Rule-001〜003）

### Rule-001: CODEX_CLI_PATH 最優先

```
CODEX_CLI_PATH 環境変数が設定されていれば、それを最優先で使用する。
他の解決方法（PATH 検索・where.exe）より必ず先に評価する。
```

実装: `codexPathResolver.ts > resolveCodexPath()` — 1番目の分岐

### Rule-002: Windows では codex.cmd を優先

```
Windows (process.platform === 'win32') の場合:
  PATH を走査して codex.cmd を探し、見つかればそれを使用する。
  codex.cmd が見つからない場合のみ 'codex' にフォールバックする。
  理由: PowerShell/cmd から .cmd 経由でないと npm global が実行できない場合がある。
```

実装: `codexPathResolver.ts > findNpmGlobalCmd('codex.cmd')`

### Rule-003: WindowsApps / Microsoft WindowsApps 配下は拒否

```
以下のパスプレフィックスを含む codex は実行を拒否し、エラーを throw する:
  - C:\Program Files\WindowsApps\
  - C:\Program Files (x86)\WindowsApps\
  - %LOCALAPPDATA%\Microsoft\WindowsApps\
理由: Windows Store アプリは外部プロセスから直接実行できない（Access Denied）。
エラーメッセージに「npm install -g @openai/codex」の案内を必ず含める。
```

実装: `codexPathResolver.ts > isWindowsAppsPath()` + `throwWindowsAppsError()`

---

## 2. 事前疎通確認（Rule-004）

### Rule-004: codex --version が成功しない場合は実行しない

```
Codex 呼び出しの前に testCodexConnection() を実行する。
ok=false の場合は実行を中止し、エラー内容をログに記録する。
理由: 接続不可の状態で呼び出すとタイムアウトまで待つだけになる。
```

実装: `codexPathResolver.ts > testCodexConnection()`

疎通確認のタイミング:
- Worker 起動時（1回のみ）
- CODEX_CLI_PATH が変更されたとき
- 疎通確認失敗後に自動リトライ（最大1回、30秒後）

---

## 3. 作業ディレクトリ制限（Rule-005〜006）

### Rule-005: workdir は許可済みプロジェクトルート配下に限定する

```
codex exec -C <dir> の <dir> は以下をすべて満たすこと:
  1. 絶対パスであること（相対パス禁止）
  2. ".." を含まないこと
  3. Control Repository（このリポジトリ）を指さないこと
  4. OS 危険パス（C:\Windows, /etc, /usr 等）を指さないこと
拒否した場合は HTTP 400 を返す。
```

実装: `pathGuard.ts > validateTargetRoot()`

### Rule-006: targetProjectRoot / allowedPaths は realpath で正規化し、許可ルート外なら拒否

```
API 受信後、直ちに path.normalize() で正規化する（将来は fs.realpathSync も推奨）。
allowedPaths の各エントリが targetProjectRoot の配下であることを確認する。
絶対パス・相対パスの混在を認めない。
```

実装: `pathGuard.ts > validateAllowedPaths()`

---

## 4. 機密ファイル保護（Rule-007）

### Rule-007: 機密ファイルの読み取り・変更を禁止する

以下のパターンに一致するファイルは Codex のプロンプト・allowedPaths から除外し、
変更対象にも含めてはならない:

```
.env
.env.*          （.env.local, .env.production 等）
*.pem
*.key
*.p12
*.pfx
id_rsa
id_rsa.pub
id_ed25519
id_ed25519.pub
*credential*
*token*
*.db-wal
*.db-shm
```

実装箇所（予定）: `contextManager.ts > buildContextPack()` でファイル収集時に除外フィルタを追加。  
現状: allowedPaths に上記ファイルを含めないことを API 呼び出し側の責任として運用する。

---

## 5. 実行モード制限（Rule-008〜009）

### Rule-008: デフォルト実行モードは review-only（dry-run）

```
Codex の呼び出しデフォルトは必ず codex exec -s read-only とする。
ファイルを実際に変更する操作はデフォルトでは行わない。
review / analyze 目的の呼び出しは常に -s read-only を使う。
```

`codexAdapter.ts` の `buildArgv()` でモードに応じて切り替え:

| `request.mode` | Codex sandbox | 説明 |
|---|---|---|
| `review` | `read-only` | レビュー専用（デフォルト） |
| `implement` | `workspace-write` | ファイル変更あり（要明示指定） |

### Rule-009: 実ファイル変更は patch-only モードが明示された場合のみ

```
ファイル変更を伴う実行は以下の条件をすべて満たす場合のみ許可する:
  1. mode: 'implement' が明示的に指定されていること
  2. approved: true が設定されていること（developerAi.ts の承認ゲート）
  3. mockRun: false が設定されていること
3条件のうち1つでも欠ければ read-only で実行するか、403 を返す。
```

---

## 6. Git 操作禁止（Rule-010）

### Rule-010: 以下の Git/GitHub 操作は自動実行禁止

```
禁止する操作（Codex から自動で実行してはならない）:
  - git push（force push は絶対禁止）
  - gh pr create / gh pr merge / gh pr approve
  - git branch --delete / git branch -D
  - git rebase -i（インタラクティブ）
  - GitHub branch protection 設定の変更
  - .github/workflows/ の変更（Red Zone — 下記 Rule-013）
  - CODEOWNERS の変更（Red Zone — 下記 Rule-013）

許可する操作（読み取りのみ）:
  - git status / git diff / git log
  - gh pr view / gh pr checks
  - gh run view / gh run list
```

Worker が自動的に上記の禁止操作を `SafeCommand` allowlist から除外していること。

---

## 7. mock 完了扱い禁止（Rule-011）

### Rule-011: mock 実行を完了扱いにしない

```
DeveloperAiResult.status === 'mock' の場合:
  - task_graph.md のステータスを [x] にしない
  - docs/dashboard.md への記録は行う（ステータス: mock で明示）
  - Summary Engine はダッシュボード更新のみ行い、タスクグラフを更新しない

status === 'success' のみ [x] にする（summaryEngine.ts の現行実装）。
```

実装: `summaryEngine.ts > updateDashboard()` — 現行実装で対応済み

---

## 8. 呼び出しログ（Rule-012）

### Rule-012: Codex 呼び出しごとに以下をログ保存する

```typescript
interface CodexInvocationLog {
  taskId: string           // タスク ID
  cliPath: string          // 解決された codex の実パス
  workdir: string          // -C オプションに渡した作業ディレクトリ
  promptPath: string       // プロンプトファイルのパス（stdin の場合は "<stdin>"）
  mode: string             // 'review' | 'implement'
  sandboxMode: string      // 'read-only' | 'workspace-write'
  changedFiles: string[]   // Codex が変更したファイル一覧
  exitCode: number         // プロセス終了コード
  stdout: string           // 標準出力（末尾 2000 文字まで）
  stderr: string           // 標準エラー（末尾 2000 文字まで）
  startedAt: string        // ISO 8601
  completedAt: string      // ISO 8601
  durationMs: number
}
```

保存先: `docs/codex_invocation_log/YYYY-MM-DD_<taskId>.json`  
保存タイミング: Codex プロセス終了後（成功・失敗問わず）

---

## 9. Red Zone（Rule-013）

### Rule-013: 以下のファイル変更は人間承認必須（Red Zone）

```
Red Zone ファイルパターン（Worker の FileChangeGuard で検出）:
  .github/workflows/**
  .github/CODEOWNERS
  sandbox/**
  apps/api/src/auth/**
  apps/worker/src/guards/**
  CLAUDE.md
  AGENTS.md
  docs/project_memory/rules/**
  *.env*
  *.pem / *.key / *.p12 / *.pfx / id_rsa* / id_ed25519*

Red Zone 検出時の動作:
  1. Codex の変更を適用しない（git add しない）
  2. CEO（人間）へ通知する
  3. Job ステータスを 'blocked' にする
  4. Codex に自己判断での修正を求めない
```

実装: `apps/worker/src/guards/fileChangeGuard.ts` に Red Zone パターンを追加（現行は guards/ のみ）

---

## チェックリスト（Codex 呼び出し前）

```
[ ] CODEX_CLI_PATH または codex.cmd が有効か確認（testCodexConnection()）
[ ] workdir が targetProjectRoot 配下か確認（validateTargetRoot()）
[ ] allowedPaths に機密ファイルが含まれていないか確認
[ ] mode が明示されているか（未指定 → 'review' として read-only で実行）
[ ] approved フラグの確認（implement の場合）
[ ] ログ出力先ディレクトリが存在するか確認
```

---

*Created by: CEO + Claude Code (claude-sonnet-4-6)*  
*関連: [001_codex_integration_risks.md](001_codex_integration_risks.md) / [AGENTS.md](../../../AGENTS.md) section 9*
