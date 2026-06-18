---

## Codex 実行環境の注意事項（必読）

### pnpm の PATH について

このプロジェクトの pnpm は以下のパスにある。PowerShell でコマンドを実行する場合は必ず PATH を設定すること:

```powershell
$env:PATH = "C:\Program Files\nodejs\geminiCLI\node_modules\corepack\shims;" + $env:PATH
```

### テスト・型チェックの実行方法

以下のコマンドで実行すること（ルートディレクトリで実行）:

```powershell
# PATH設定 + テスト
$env:PATH = "C:\Program Files\nodejs\geminiCLI\node_modules\corepack\shims;" + $env:PATH
pnpm test

# PATH設定 + 型チェック
$env:PATH = "C:\Program Files\nodejs\geminiCLI\node_modules\corepack\shims;" + $env:PATH
pnpm typecheck
```

### pnpm install について

- 新しい依存パッケージを追加した場合は `pnpm install --no-frozen-lockfile` を実行する
- **その際に `.pnpm-store/` ディレクトリがプロジェクト内に作成された場合は必ず削除すること**:
  ```powershell
  Remove-Item -Recurse -Force .pnpm-store
  ```
- `.pnpm-store/` は `.gitignore` に追加すること

### 失敗した場合

pnpm コマンドが通らない場合は、以下で直接 vitest を実行できる:

```powershell
# apps/engine ディレクトリで実行
Set-Location apps/engine
node "../../node_modules/.pnpm/vitest@3.2.6_@types+node@22.19.21/node_modules/vitest/vitest.mjs" run
```
