# Codex E2E Recovery — 開発ログ

**日付:** 2026-06-19  
**担当:** Claude Code (CTO/Developer)  
**対象:** `apps/worker/src/aiCli/` — CodexAdapter 実行経路

---

## 1. 背景

### 1-1. Codex CLI フラグ変更（v0.140.0 以降）

codex-cli v0.140.0 で非対話実行の仕様が変更された。

| 旧（廃止） | 新 |
|-----------|-----|
| `--approval-mode` | 廃止 |
| `codex <prompt>` | `codex exec --sandbox <mode> <prompt>` |

`codexAdapter.ts` が旧フラグを使い続けていたため、実行時に unknown flag エラーが発生していた。  
対応: `exec --sandbox workspace-write/read-only` に修正（commit `bf00bae`, `fadc666`）。

### 1-2. Windows `codex.cmd` 実行問題

Windows 環境では `codex` コマンドは `codex.cmd`（npm グローバルインストール版）として解決される。  
`execFileSync('codex.cmd', args, { shell: false })` は Windows で `EINVAL` エラーになる。

**原因:** `.cmd` ファイルは Win32 バイナリではないため `shell: false` では直接実行できない。  
**修正:** `resolveExe()` を `BaseCliAdapter` に追加し、`.cmd` ファイルの場合は `cmd.exe /c codex.cmd` 経由で実行するようにした（commit `213cd64`）。

### 1-3. stdin EOF 待ちによる hung（stdin prompt 対応）

`execFileSync` に `stdio: ['pipe','pipe','pipe']` を指定しつつ `input` オプションを渡さないと、stdin パイプが開いたままになる。  
`codex exec` はパイプされた stdin を検出すると EOF まで待機するため、デッドロック → タイムアウトになっていた。

**修正:** `useStdinPrompt()` フックを `BaseCliAdapter` に追加。  
- `CodexAdapter` は `true` を返し、prompt を argv 末尾ではなく stdin で渡す（argv 末尾は `'-'`）。  
- `execFileSync` に `input: finalPrompt` を渡すことで stdin EOF を即座に通知する。  
- Claude / Gemini など他 Adapter は `false`（デフォルト）のまま影響なし。

### 1-4. Gemini Meta Review 復旧

`geminiRouter.ts` が CLI（`agy`）を優先呼び出しするが、`agy` は `--print` モードで stdout に何も出力せず exit 0 で終了する。  
空文字列 `""` が `null` と区別されないまま成功扱いされ、GEMINI_API_KEY が設定済みにもかかわらず API フォールバックに進まなかった。

**修正:** `callCli` に `!stdout.trim()` チェックを追加（commit `12232ca`）。  
修正後は `agy` の空レスポンス → `null` → API フォールバック → `gemini-3.1-flash-lite` 経由で正常動作。

---

## 2. 実施した E2E テスト

### 2-1. Target Repository

```
C:\workspace\target\
├── .git/
└── README.md   ← テスト対象ファイル
```

テスト用に新規作成した git リポジトリ。本番の Target Repository ではない。  
`TARGET_ROOT = '/workspace/target'` が `path.resolve()` で `C:\workspace\target` に解決される（Node.js の実行 cwd が C: ドライブのとき）。

### 2-2. 実行した内容

```typescript
const request: AiCliRequest = {
  provider: 'codex',
  taskId: 'e2e-test-001',
  workingDir: 'C:\\workspace\\target',
  prompt: 'README.md の末尾に次の1行だけ追加してください:\n<!-- codex e2e test: ok -->',
  contextFiles: [],
  mode: 'implement',
  postLint: false,
  timeoutMs: 120_000,
}
```

実際に呼ばれた CLI コマンド（`resolveExe()` + `buildArgv()` の結果）:

```
cmd.exe /c codex.cmd exec --sandbox workspace-write -C C:\workspace\target --ephemeral -
```

stdin に prompt 文字列が渡された。

### 2-3. Codex が変更したファイル

```diff
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Codex E2E Test Sandbox
 
 This directory is used for end-to-end testing of the CodexAdapter.
+<!-- codex e2e test: ok -->
```

指示通り末尾に1行追加。他は変更なし。

### 2-4. changedFiles 検出結果

```
changedFiles: ['README.md']
```

`getChangedFiles(workingDir)` が `git diff --name-only` で正常に検出した。

### 2-5. ログ保存先

```
data/logs/cli-e2e-test-001/stdout.txt
```

`stdoutPath` として返却された。`data/logs/` 配下にタスク ID 別で保存される。

### 2-6. FileChangeGuard 結果

`blocked: undefined`（ブロックなし）。  
変更ファイルが `C:\workspace\target` 配下のみであり、Guard を通過した。

### 2-7. postLint について

今回は `postLint: false` を明示的に指定した。  
理由: テスト用リポジトリに lint 設定（ESLint / package.json 等）がなく、lint 実行が失敗するため。  
`postLint` のデフォルト動作（`provider === 'codex'` のとき自動実行）は未確認。

---

## 3. 結果

### 成功したこと

| 項目 | 結果 |
|------|------|
| `codex exec` 正常終了 | ✅ exitCode 0（45.5s） |
| Windows `.cmd` 実行（`cmd.exe /c` 経由） | ✅ |
| stdin prompt 渡し（`input: finalPrompt`） | ✅ |
| changedFiles 検出 | ✅ `['README.md']` |
| ログ保存 | ✅ `data/logs/cli-e2e-test-001/stdout.txt` |
| FileChangeGuard 通過 | ✅ `blocked: undefined` |
| テスト後の変更破棄 | ✅ `git checkout .` で復元確認 |
| Gemini Meta Review（変更後コミットに対して） | ✅ ALIGNED |

### まだ未確認のこと

| 項目 | 備考 |
|------|------|
| `postLint: true` の動作 | lint 設定ありのリポジトリで確認が必要 |
| API → Worker → Codex 全経路 | HTTP API 経由（JobRunner 経由）での実行は未確認 |
| 失敗時ログ保存 | exitCode 1 / タイムアウト時にログが正しく残るか未確認 |
| Guard によるブロック動作 | TARGET_ROOT 外の変更を Codex が試みた場合のブロック未確認 |
| retry 経路（`expectJson: true` 時） | JSON 要求 + パース失敗時のリトライブロック未確認 |
| `buildSafeEnv()` の Windows 対応 | `USERPROFILE`/`APPDATA` が正しく渡るか未確認 |

---

## 4. 次に確認すべきこと

### 優先度: 高

1. **`postLint: true` 確認**  
   lint 設定（ESLint + TypeScript）が整ったリポジトリで `postLint: false` を外して実行する。  
   Codex の出力がスタイル違反を起こした場合に lint が自動修正または検出するか確認。

2. **API → Worker → Codex 全経路**  
   現在の E2E はスクリプトから `CodexAdapter.run()` を直接呼んでいる。  
   実際の Worker ジョブとして HTTP API 経由（`POST /jobs` → `jobRunner.ts` → `CodexAdapter`）で動くか確認が必要。

### 優先度: 中

3. **失敗時ログ確認**  
   意図的に失敗させた場合（タイムアウト、コンパイルエラー等）に `stderr` と `exitCode` がログに残るか確認する。

4. **Guard によるブロック動作**  
   Codex が TARGET_ROOT 外のファイルを変更しようとしたとき（`--sandbox workspace-write` 違反等）に FileChangeGuard が `blocked: true` を返すか確認する。

### 優先度: 低

5. **Docker 環境での動作確認**  
   本番想定の Docker コンテナ内で `codex.cmd` ではなく Linux バイナリとして動くか確認する。  
   `resolveExe()` の Linux パスが正しく動作するか（Windows 固有の `.cmd` 分岐が邪魔しないか）。
