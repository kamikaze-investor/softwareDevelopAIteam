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
