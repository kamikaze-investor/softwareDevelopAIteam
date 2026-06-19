# ADR-0002: process.env トップレベル評価ルール

**ステータス:** Accepted  
**日付:** 2026-06-19  
**決定者:** CEO  
**調査担当:** Claude Code (CTO/Developer)

---

## 背景と課題

`apps/worker/src/metaReviewer/runner.ts` のモジュールトップレベルに

```typescript
const CONTROL_ROOT = process.env.CONTROL_ROOT ?? '/workspace/control'
```

があり、`autoReview.ts` から静的 import される際に ESM ホイスト（静的 import はモジュール本体より先に評価される）により、`.env` ロード前に `CONTROL_ROOT` が確定してしまう問題が発生した。

ローカル Windows 環境では `CONTROL_ROOT` が未設定のため `/workspace/control` にフォールバックし、`C:\workspace\control\docs\meta_reviewer\prompt.md` の ENOENT で Meta Review が実行不能になった。

この問題を機に、リポジトリ全体の `process.env` トップレベル評価の設計ルールを定める。

---

## 調査結果: 各エントリポイントの `.env` ロード方式

| エントリポイント | ロード方式 | 根拠 |
|--------------|----------|------|
| `apps/worker/src/index.ts` | **外部注入前提** | `.env` ロードコードなし。起動前にシェルや Docker/CI が環境変数を注入 |
| `apps/api/src/index.ts` | **外部注入前提** | 同上 |
| `apps/worker/src/metaReviewer/autoReview.ts` | **プロセス内ロード** | `__dirname` ベースの `.env` ブロック（2026-06-19 追加） |
| `apps/worker/scripts/alignmentCheck.ts` | **プロセス内ロード** | `import.meta.url` ベースの `.env` ブロック（既存） |

worker/api 系は `.env` をプロセス内でロードしない外部注入前提のため、
ESM の静的 import 評価順によって `.env` ロードが間に合わない、という種類の問題は発生しない。
ただし、外部環境変数注入が失敗した場合はデフォルト値が使われる。

Docker 本番環境は `sandbox/docker-compose.yml` で `environment:` に個別キーを明示注入しており、`.env` ファイルをコンテナに渡さない設計。
CI (`meta-review.yml`) も `env:` ブロックで Secrets から個別注入。

---

## ESM における静的 import の評価順

ESM（NodeNext モード）では、静的 import はモジュール本体より**必ず先に**評価される。

```
// autoReview.ts で起きていた問題の再現
tsx autoReview.ts を実行
  ↓
1. runner.ts が評価される（静的 import のため）
   → const CONTROL_ROOT = process.env.CONTROL_ROOT ?? '/workspace/control'
   → process.env.CONTROL_ROOT が未設定 → '/workspace/control' で確定
  ↓
2. autoReview.ts 本体が実行される
   → .env ロードブロックが走る（遅い！CONTROL_ROOT はもう確定済み）
```

**対処:** `runner.ts` / `geminiRouter.ts` を `main()` 内で動的 import することで、
`.env` ロード後に評価させる。

---

## 設計ルール

### ルール1: トップレベル `process.env` は「外部注入前提」か「内部ロード保証後」のみ許可

```typescript
// ✅ OK: 外部注入前提のエントリポイント（起動前に env が確定している）
// apps/worker/src/index.ts
const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000'

// ✅ OK: 関数内評価（呼び出し時に読む）
function getApiKey() {
  const key = process.env.GEMINI_API_KEY   // 毎回読む
  if (!key) throw new Error('...')
  return key
}

// ❌ NG: デフォルト値が環境依存のパス + 単体実行される可能性があるファイル
// apps/worker/src/metaReviewer/runner.ts (修正済み)
const CONTROL_ROOT = process.env.CONTROL_ROOT ?? '/workspace/control'  // 危険
```

### ルール2: 危険度の判定チェックリスト

以下を**全て**満たす場合は getter 化または動的 import を検討する：

- [ ] デフォルト値が「特定環境専用のパス/アドレス」（`/workspace/...`, `http://prod-server/` 等）
- [ ] `.env` ロードなし/外部注入なしで単体実行または import される可能性がある
- [ ] 値が間違ったまま実行されると実害が出る（ENOENT、接続失敗等）

単一条件では危険ではない：
- デフォルト値が安全な値（`localhost:3000`, `30000`, CWD 相対パス）→ 問題なし
- 外部注入が確実に行われる起動フロー → 問題なし
- 遅延初期化（関数呼び出し時に初めて使われる） → 問題なし

### ルール3: スクリプト・CLI直接実行ファイルは `.env` を自己ロードする

`npx tsx` や `node` で直接実行されるスクリプト（`scripts/`, `src/metaReviewer/autoReview.ts` 等）は、
環境変数に依存する処理がある場合、ファイル自身が `.env` をロードする責任を持つ。

```typescript
// パターン A: scripts/ 配下（ESM, import.meta.url が使える）
{
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env')
  if (existsSync(envPath)) { /* ... */ }
}

// パターン B: src/ 配下（CJS コンテキスト, __dirname が使える）
// かつ、依存モジュールがモジュールトップレベルで process.env を読む場合は動的 import を使う
{
  const envPath = resolve(__dirname, '../../../../.env')
  if (existsSync(envPath)) { /* ... */ }
}
// その後、影響を受けるモジュールを動的 import する
const { something } = await import('./affected-module.js')
```

### ルール4: 既存のトップレベル `process.env` 変数に getter 化が必要な条件

以下のいずれかに該当する場合のみ getter 関数化を行う（それ以外は現状維持）：

1. デフォルト値が環境専用パスで、CLI 単体実行のリスクが確認された
2. テストで `process.env` を書き換えてから import するパターンが必要になった
3. 実際に間違った値で動いてしまうバグが発生した

---

## 現在のトップレベル `process.env` 一覧と状態

| ファイル | 変数 | デフォルト値 | 状態 |
|---------|------|------------|------|
| `runner.ts:31` | `CONTROL_ROOT` | `/workspace/control` | ✅ 対処済み（autoReview.ts を動的 import 化） |
| `worker/src/index.ts:20` | `API_BASE` | `http://localhost:3000` | ✅ 安全（外部注入前提・デフォルト安全） |
| `worker/src/index.ts:22` | `API_TOKEN` | `undefined` | ✅ 安全（外部注入前提） |
| `worker/src/jobRunner.ts:18` | `API_BASE_URL` | `http://localhost:3000` | ✅ 安全（外部注入前提・デフォルト安全） |
| `watchdog/watchdog.ts:13` | `WATCHDOG_INTERVAL_MS` | `30_000` | ✅ 安全（デフォルトが安全な数値） |
| `api/src/index.ts:59` | `PORT` | `3000` | ✅ 安全（外部注入前提・デフォルト安全） |
| `api/src/storage/index.ts:6` | `DB_PATH` | `cwd()/data/ai-team.db` | ✅ 安全（遅延初期化・デフォルト安全） |
| `aiCli/codexPathResolver.ts:34` | `localAppData` | `''` | ✅ 安全（OS 環境変数・`.env` 不要） |

---

## 採用しなかった案

- **全モジュールを getter 関数化する**: 過剰対応。安全なデフォルト値を持つ変数や外部注入前提のエントリポイントまで変更する必要はない
- **dotenv パッケージを導入する**: 既存の `.env` パーサーコードで十分。新たな依存追加は不要
- **config モジュールを一本化する**: 将来の選択肢。現状の規模では複雑さが増すだけ

---

## 影響範囲

- 今後 `scripts/` や直接実行スクリプトを追加する際は本 ADR を参照する
- `runner.ts` を import する新しいスクリプトを追加する場合は動的 import を使う
