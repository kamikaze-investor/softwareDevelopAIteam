# Windows CLI 実行安定化 — 開発ログ

**日付:** 2026-06-19  
**担当:** Claude Code (CTO/Developer)  
**対象:** `apps/worker/src/aiCli/adapter.ts`  
**コミット:** `531e8a6`

---

## 1. 背景

### 問題の発端

Codex E2E テスト（[2026-06-19-codex-e2e-recovery.md](./2026-06-19-codex-e2e-recovery.md)）で
`postLint: true` を検証したところ、3シナリオ全てで同一の warning が出た。

```
[AiCliAdapter] post-lint failed (non-fatal). File Change Guard will check the diff.
```

lint スクリプトが `echo lint-ok`（必ず成功する）であっても同じ warning が出ることから、
スクリプト内容の問題ではなく実行経路の問題と判断した。

### 根本原因

Windows では多くの CLI ツールが `.cmd` ファイルとして提供される。
Node.js の `execFileSync` に `shell: false` を指定した場合、`.cmd` ファイルを直接実行できず、
`EINVAL` または `ENOENT` エラーが発生する。

| CLI | Windows での実体 | `shell:false` での挙動 |
|-----|----------------|----------------------|
| `codex` | `codex.cmd` | `EINVAL` |
| `pnpm` | `pnpm.cmd` | `EINVAL`（インストール済みの場合）/ `ENOENT`（未インストールの場合） |

`codex.cmd` については前回の修正（`213cd64`）で `BaseCliAdapter.resolveExe()` により
`cmd.exe /c codex.cmd` 経由での実行に対応済みだった。
しかし `resolveExe()` は `BaseCliAdapter` の **private インスタンスメソッド** だったため、
module-level 関数の `runPostLint()` からは利用できない設計になっていた。

---

## 2. 対応内容

### 設計方針

`resolveExe()` のロジックを module-level の **純粋関数** `resolveWindowsExe()` に昇格させ、
Codex 実行と `runPostLint` の両方から共通利用できる設計にした。

### 追加・変更した関数

#### `resolveWindowsExe(cliPath: string)` — 新規（共通ユーティリティ）

```typescript
function resolveWindowsExe(cliPath: string): { exe: string; prefixArgs: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    return { exe: 'cmd.exe', prefixArgs: ['/c', cliPath] }
  }
  return { exe: cliPath, prefixArgs: [] }
}
```

- `.cmd` / `.bat`（大文字小文字不問）を `cmd.exe /c` でラップ
- Linux / Mac では `{ exe: cliPath, prefixArgs: [] }` をそのまま返す（影響なし）
- AI CLI 実行と postLint の両方で使用する共通実装

#### `resolvePnpmPath()` — 新規（postLint 専用）

```typescript
function resolvePnpmPath(): string {
  if (process.platform !== 'win32') return 'pnpm'
  for (const dir of (process.env.PATH ?? '').split(';')) {
    const candidate = path.join(dir.trim(), 'pnpm.cmd')
    if (existsSync(candidate)) return candidate
  }
  return 'pnpm'  // 見つからなければ 'pnpm' のまま（ENOENT は catch で non-fatal）
}
```

- Windows の PATH を走査して `pnpm.cmd` の絶対パスを解決する
- 見つからなければ `'pnpm'` を返し、呼び出し元の catch で non-fatal 処理させる

#### `BaseCliAdapter.resolveExe()` — 変更（ラッパー化）

```typescript
// 変更前: ロジックをインスタンスメソッドに直接持っていた
private resolveExe(): { exe: string; prefixArgs: string[] } {
  const p = this.config.cliPath
  if (process.platform === 'win32' && p.toLowerCase().endsWith('.cmd')) {
    return { exe: 'cmd.exe', prefixArgs: ['/c', p] }
  }
  return { exe: p, prefixArgs: [] }
}

// 変更後: module-level 関数への委譲（動作は同一）
private resolveExe(): { exe: string; prefixArgs: string[] } {
  return resolveWindowsExe(this.config.cliPath)
}
```

Codex 実行の動作は変わらない。ロジックが共通化されただけ。

#### `runPostLint()` — 変更

```typescript
// 変更前
execFileSync('pnpm', ['lint', '--fix'], { shell: false, ... })

// 変更後
const pnpmPath = resolvePnpmPath()
const { exe, prefixArgs } = resolveWindowsExe(pnpmPath)
execFileSync(exe, [...prefixArgs, 'lint', '--fix'], { shell: false, ... })
```

- `'pnpm'` ハードコードをなくし、PATH 解決 + `.cmd` ラップを適用
- エラー catch にエラーコードを追加: `code=ENOENT` / `code=EINVAL` が warning に出るようになった

```
// 変更前
[AiCliAdapter] post-lint failed (non-fatal). File Change Guard will check the diff.

// 変更後（例）
[AiCliAdapter] post-lint failed (non-fatal, code=ENOENT). File Change Guard will check the diff.
```

---

## 3. 追加テスト

### `adapter.windowsExe.test.ts`（新規、7件）

`node:child_process` を `vi.mock` でホイストしてモック化し、
`execFileSync` の呼び出し引数を検査する専用ファイル。
`adapter.test.ts` では ESM 制約により `vi.spyOn` が使えないため分離した。

| テストケース | 検証内容 |
|-------------|---------|
| Windows `.cmd` → `cmd.exe /c` | `exe === 'cmd.exe'` かつ `prefixArgs = ['/c', 'codex.cmd']` |
| Linux 絶対パス → そのまま | `exe === '/usr/local/bin/codex'`、`cmd.exe` 不使用 |
| `.bat` パスも対象 | `cmd.exe /c` でラップされる |
| 大文字 `.CMD` も対象 | 大文字小文字不問でラップ |
| pnpm `ENOENT` → non-fatal 継続 | warn に `code=ENOENT` が含まれ、exitCode は Codex の結果 |
| pnpm `EINVAL` → non-fatal 継続 | warn に `code=EINVAL` が含まれる |
| `postLint: false` → pnpm 呼び出しなし | pnpm 系の execFileSync 呼び出しが 0件 |

---

## 4. 検証結果

| 項目 | 結果 |
|------|------|
| typecheck | ✅ パス |
| test | ✅ 148件パス（+7件） |
| Meta Review（Gemini） | ✅ ALIGNED —「Windows環境におけるCLI実行の互換性向上を目的とした実装であり、設計思想および承認ルールに違反する箇所はありません」 |
| Linux/Docker 本番環境への影響 | なし（`process.platform === 'win32'` でガード済み） |

---

## 4-補足. `caaffb0`（feat: dev-log 基盤追加）の Meta Review ステータス

**Meta Review: 未実行（手動評価による代替）**

コミット `caaffb0` の Meta Review は `autoReview.ts` 経由での実行を試みたが、以下の理由で失敗した。

**原因:**
- `autoReview.ts` は `.env` を読み込まない（`alignmentCheck.ts` と異なる設計）
- `runner.ts` の `CONTROL_ROOT` がデフォルト値 `/workspace/control` にフォールバック
- `C:\workspace\control\docs\meta_reviewer\prompt.md` が存在しないため ENOENT で終了

**正しいパス:** `C:\Users\honka\softwareDevelopAIteam\docs\meta_reviewer\prompt.md` は存在する。環境変数 `CONTROL_ROOT` を渡せば解決する。

**手動評価結果:**
- 変更内容: 型定義（`dev_log.ts`）・ADR・開発ログ・`.gitignore` のみ
- Control Layer（adapter / guard / permission / sandbox）への変更: **なし**
- DB schema・env・secrets 変更: **なし**
- 判定: **ALIGNED**（手動）

**対応:**
CEO承認のもと `autoReview.ts` に `.env` ロード + 動的 import を追加（コミット後述）。

---

## 8. Meta Review 実行パス修正（autoReview.ts .env ロード追加）

**日付:** 2026-06-19  
**コミット:** 後述  
**対象:** `apps/worker/src/metaReviewer/autoReview.ts`

### 原因

`autoReview.ts` に `.env` ロードコードが存在しなかったため、
`runner.ts` の module-level 定数 `CONTROL_ROOT` がデフォルト値 `/workspace/control` に
フォールバックし、`C:\workspace\control\docs\meta_reviewer\prompt.md` で ENOENT が発生した。

`.env` には正しく `CONTROL_ROOT=C:\Users\honka\softwareDevelopAIteam` が設定されていた。

### 追加した実装

**`.env` ロードブロック（module-level）:**

```typescript
{
  const envPath = resolve(__dirname, '../../../../.env')
  if (existsSync(envPath)) { /* ... key=val パース */ }
}
```

**動的 import（main() 冒頭）:**

```typescript
const { buildMetaReviewRequest, buildMetaReviewPrompt, parseMetaReviewResult } =
  await import('./runner.js')
const { callGeminiWithFallback } = await import('./geminiRouter.js')
```

ESM では静的 import はモジュール本体より先に評価されるため、`.env` ブロックを
静的 import の前に書いても `runner.ts` の module-level 評価に間に合わない。
そのため `runner.ts` / `geminiRouter.ts` を `main()` 内で動的 import することで、
`.env` ロード後に評価させる設計とした。

### 検証結果

| 項目 | 結果 |
|------|------|
| typecheck | ✅ パス |
| test (148件) | ✅ 全パス |
| `autoReview.ts` 実行時の CONTROL_ROOT | ✅ `.env` から正しく解決 |
| `runner.ts` が `docs/meta_reviewer/prompt.md` を参照 | ✅ ENOENT なし |
| Gemini 呼び出しまで到達 | ✅ quota exhausted エラー（経路は正常） |
| `alignmentCheck.ts` 経由の Meta Review | ✅ ALIGNED（caaffb0 を正式確認） |

### caaffb0 Meta Review 最終ステータス

**Gemini ALIGNED（alignmentCheck.ts 経由で正式確認済み）**

> 開発ログシステムの導入は、AIの判断の系譜を可視化し、Context重視および透明性を高める設計思想に合致しています。Git管理対象の選別もリスク管理として適切です。

---

## 5. 現環境での制限

**この Windows 開発環境では `pnpm` がグローバルインストールされていない。**

`C:\Users\honka\AppData\Local\pnpm\` に `store/` ディレクトリは存在するが、
`pnpm.cmd` バイナリが PATH 上に存在しないため、`resolvePnpmPath()` は `'pnpm'` を返す。
結果として postLint は `ENOENT` で non-fatal fail のままとなる。

```
[AiCliAdapter] post-lint failed (non-fatal, code=ENOENT). File Change Guard will check the diff.
```

この状態は今回の修正で「`.cmd` + `shell:false` = EINVAL」が解消され、
「pnpm 未インストール = ENOENT」という別の原因に変わっただけであり、
エラーの種類がより正確になった（退行ではない）。

---

## 6. 次に確認すべきこと

### pnpm インストール後の再 E2E 確認

```powershell
npm install -g pnpm   # または winget install pnpm.pnpm
```

インストール後に以下を確認:

| 確認項目 | 期待値 |
|----------|--------|
| `resolvePnpmPath()` が `pnpm.cmd` の絶対パスを返す | PATH から解決される |
| `pnpm lint --fix` が `EINVAL` ではなく実行される | postLint warning が出ない |
| lint スクリプト失敗時のエラーコードが `code=1` になる | `code=1` が warning に含まれる |
| Codex 実行 + postLint の両方が同一コミットで動作する | E2E 全パス |

### Docker 環境での確認

本番（Docker Linux）では `pnpm` はバイナリとして存在するため、
`resolveWindowsExe` の Windows 分岐は通らず従来通り動作する。
ただし Docker 環境での実際の lint 実行は未確認。

---

## 7. pnpm v11.8.0 インストール後の再 E2E 確認結果

**確認日:** 2026-06-19  
**pnpm バージョン:** 11.8.0（グローバルインストール済み）

### 確認結果サマリー

| 確認項目 | 結果 |
|----------|------|
| ENOENT / EINVAL エラー | ✅ 解消 |
| `resolvePnpmPath()` が `pnpm.cmd` を解決 | ✅ PATH から解決 |
| `pnpm lint --fix` が実行経路に乗った | ✅ 確認 |
| シナリオ3（lint success）: postLint warning なし | ✅ 確認 |
| Codex 実行・changedFiles 検出・ログ保存 | ✅ 継続して正常 |
| FileChangeGuard | ✅ 継続して正常 |

### 副作用として確認された事象

`pnpm lint --fix` が Target Repository 内で実行されると、以下が生成される場合がある:

- `node_modules/` — Target Repository に `package.json` がある場合、pnpm が依存をインストールする可能性
- `pnpm-lock.yaml` — Target Repository に lockfile が存在しない場合、新規生成される可能性

これらは FileChangeGuard の changedFiles 検出に含まれるため、
**意図しないファイル変更として誤検知される可能性がある**。

### 今後の検討事項（postLint ルール設計）

以下は現在未実装。設計メモとして残す（実装時は CEO 承認・Meta Review 必要）:

1. **node_modules/ を変更対象から常に除外**
   - FileChangeGuard / changedFiles 集計から `node_modules/` を除外するフィルタを追加

2. **pnpm-lock.yaml の新規生成を警告対象とする**
   - Target Repository に既存 lockfile が存在する場合のみ更新を許可
   - 新規生成時は warning を出して CEO 確認を促す

3. **package.json が存在しない場合の postLint は non-fatal**
   - 現在も non-fatal だが、エラーコードで区別できるとより明確になる

4. **lint スクリプトが存在しない場合も non-fatal**
   - `pnpm lint` が `ERR_PNPM_NO_SCRIPT` を返す場合のエラーコード識別を追加

5. **lint スクリプトがあるのに失敗した場合は warning としてログに残す**
   - 現在は全 postLint 失敗を同一の warning にまとめている
   - 「スクリプト未定義」と「スクリプト実行失敗」を区別して出力する

6. **postLint 結果をログファイルに保存する**
   - lint stdout/stderr を `logs/implementation/` 以下に保存
   - ImplementationLog の `postLintStatus` フィールドと紐付ける（Dev Log Phase 5 で実装予定）
