# VPS App Runtime Standard v1

**目的**: 今後AIチームOSが作る自作アプリ（Next.jsサイト、bot、自動投稿ツール、監視ワーカー等）に、共通の稼働確認エンドポイントを持たせる。VPS Doctor Lite / VPS Keeper FXが、各アプリの状態（起動しているか・最後にheartbeatがあったか・最後に成功した処理はいつか・最後にエラーが出たのはいつか・今の状態が正常か）を確認できるようにするための標準仕様。

---

## 1. 非エンジニア向け要約

今後作るアプリに、共通の「生存確認窓口」を必ず作ります。この窓口にアクセスするだけで、VPS Doctor Liteが「このアプリは動いているか」「最後に正常に仕事をしたのはいつか」「最近エラーが出ていないか」を一目で確認できます。この窓口は診断ツールではなく、あくまで軽い健康チェック（体温計）です。重い処理・秘密情報の開示・危険な操作は一切行いません。

---

## 2. 標準エンドポイント

**`/api/health` を標準とする。**

理由:
- Next.js（App Router / Pages Router 両方）では`/api/`配下がAPI Routesの標準的な置き場所であり、静的アセット・ページルーティングと衝突しない
- Node worker系アプリ（Express/Fastify等）でも`/api/health`は一般的な慣習であり、リバースプロキシ（nginx等）で`/api/*`をアプリにルーティングする構成と親和性が高い

**`/health` は例外的に許容する**（アプリがAPIサーバーとしての性質を持たない純粋な静的サイト等）が、**Next.jsアプリ・Node workerアプリでは`/api/health`を標準とする**。

health endpointは**診断機能ではなく、稼働確認のための軽量エンドポイント**である。詳細診断・重い処理は行わない。

---

## 3. 標準レスポンスJSON

```json
{
  "ok": true,
  "appName": "example-app",
  "appType": "web-worker",
  "version": "0.1.0",
  "environment": "production",
  "startedAt": "2026-07-02T16:00:00+09:00",
  "lastHeartbeatAt": "2026-07-02T16:58:00+09:00",
  "lastSuccessAt": "2026-07-02T16:57:30+09:00",
  "lastErrorAt": null,
  "status": "running",
  "message": "running"
}
```

---

## 4. フィールド定義

### 必須フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | boolean | 稼働正常か。`status`から機械的に導出（下記5参照） |
| `appName` | string | アプリ識別名（例: `example-app`） |
| `appType` | string | アプリ種別（`web`/`web-worker`/`worker`/`bot`等、自由記述の分類ラベル） |
| `version` | string | アプリのバージョン（`package.json`の`version`を流用） |
| `environment` | string | `production`/`staging`/`development`等 |
| `startedAt` | string (ISO8601) | プロセス起動時刻（プロセス起動時に1度だけ記録） |
| `lastHeartbeatAt` | string (ISO8601) | 最終heartbeat時刻 |
| `status` | `'running' \| 'degraded' \| 'error' \| 'stopped'` | 現在の稼働状態 |
| `message` | string | 人間向けの短い状態説明（例: `"running"` / `"last job failed 3 times"`） |

### 任意フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| `lastSuccessAt` | string (ISO8601) \| null | アプリの主要処理が最後に成功した時刻。**主要処理を持つアプリ（bot・worker・定期処理系）で使う。** まだ一度も実行していない場合は`null` |
| `lastErrorAt` | string (ISO8601) \| null | アプリの主要処理が最後に失敗した時刻。**主要処理を持つアプリで使う。** エラーがなければ`null` |
| `uptimeSeconds` | number | `startedAt`から計算可能なため冗長だが、監視側の利便性のために許容 |
| `lastSuccessCount` / `lastErrorCount` | number | 直近N件のカウント。詳細診断にならない範囲で |

「主要処理」の定義はアプリごとに異なる。Next.jsサイトの場合は「リクエスト処理そのもの」、botの場合は「投稿処理」、workerの場合は「ジョブ処理」を指す。各アプリの実装時に何を「主要処理」とするか明記すること。

---

## 5. status / ok / HTTPステータスコードの関係（MVP確定仕様）

| `status` | `ok` | HTTPステータス | 意味 |
|---|---|---|---|
| `running` | `true` | `200` | 正常稼働中 |
| `degraded` | `true` | `200` | 完全停止ではないが注意が必要な状態（例: 直近エラーあり・一部機能不全） |
| `error` | `false` | `503` | エラー状態 |
| `stopped` | `false` | `503` | 停止状態 |

**`degraded`は「完全停止ではないが注意が必要」という状態として扱う。** `ok:true`かつHTTP 200を返すため、単純な死活監視では「生きている」と判定されるが、`status`フィールドを見ることで注意状態であることが分かる。VPS Doctor Lite側では将来`degraded`をwarning扱いにする想定。

---

## 6. 更新タイミング

| フィールド | 更新タイミング |
|---|---|
| `startedAt` | プロセス起動時に1度だけ記録し、以降固定 |
| `lastHeartbeatAt` | ①`/api/health`が呼ばれるたびに更新する方式、または②アプリ内部の定期処理（cron/setInterval）が独自に更新する方式のいずれか。**bot/worker系はアプリ内部の定期処理で更新することを推奨**（外部から呼ばれなくても内部生存を示せるため）。Next.jsのようなリクエスト駆動型は①で十分 |
| `lastSuccessAt` | アプリの「主要処理」が成功した直後に更新 |
| `lastErrorAt` | アプリの「主要処理」が失敗した直後に更新 |
| `status` | 上記イベント発生時に導出ロジックで再計算 |

---

## 7. セキュリティ制約

**やってはいけないこと（実装時に必ず守る）:**

- 秘密情報を返さない
- APIキー・トークン・DB接続文字列・環境変数の値を一切含めない
- `/api/health`から重い外部API呼び出し（DB接続確認・外部サービスping等）を行わない（レスポンス遅延・監視系への負荷波及を防ぐため）
- SSH実行、VPS再起動、プロセス再起動をしない（操作機能を一切持たせない）
- 詳細スタックトレース・内部エラーメッセージの生データを含めない（`message`は人間向けの要約に留める）
- 認証なしで公開されることを前提に、**情報漏洩リスクがないことを最優先**に設計する

**推奨（MVPでは必須要件にしない）:**
- `/api/health`はVPS内部ネットワークまたは監視ツールのIPのみアクセス可能にする（nginx等でのIP制限）ことが望ましい

---

## 8. Next.js実装案

**App Router（`app/api/health/route.ts`）:**

```typescript
const startedAt = new Date().toISOString()
let lastHeartbeatAt = startedAt

export async function GET() {
  lastHeartbeatAt = new Date().toISOString()

  return Response.json({
    ok: true,
    appName: process.env.APP_NAME ?? 'unknown',
    appType: 'web',
    version: process.env.npm_package_version ?? '0.0.0',
    environment: process.env.NODE_ENV ?? 'development',
    startedAt,
    lastHeartbeatAt,
    lastSuccessAt: null,
    lastErrorAt: null,
    status: 'running',
    message: 'running',
  })
}
```

Next.jsの場合、`lastSuccessAt`/`lastErrorAt`は「主要処理」が明確でない（各リクエストが独立しているため）ケースが多く、MVPでは`null`固定でも許容する。

---

## 9. Node worker実装案

```typescript
interface AppHealthState {
  startedAt: string
  lastHeartbeatAt: string
  lastSuccessAt: string | null
  lastErrorAt: string | null
  status: 'running' | 'degraded' | 'error' | 'stopped'
}

const healthState: AppHealthState = {
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
  lastSuccessAt: null,
  lastErrorAt: null,
  status: 'running',
}

// 主要処理（例: cronジョブ）の成功/失敗時に呼ぶ
function recordSuccess(): void {
  healthState.lastSuccessAt = new Date().toISOString()
  healthState.status = 'running'
}

function recordError(): void {
  healthState.lastErrorAt = new Date().toISOString()
  healthState.status = 'degraded'
}

// 定期的に自己heartbeatを更新（外部呼び出しなしでも生存を示せる）
setInterval(() => {
  healthState.lastHeartbeatAt = new Date().toISOString()
}, 60_000)

function isOk(status: AppHealthState['status']): boolean {
  return status === 'running' || status === 'degraded'
}

app.get('/api/health', (req, res) => {
  const ok = isOk(healthState.status)
  res.status(ok ? 200 : 503).json({
    ok,
    appName: process.env.APP_NAME ?? 'unknown',
    appType: 'worker',
    version: process.env.npm_package_version ?? '0.0.0',
    environment: process.env.NODE_ENV ?? 'development',
    ...healthState,
    message: healthState.status,
  })
})
```

---

## 10. VPS Doctor Lite連携イメージ

VPS Doctor Lite側（別プロジェクト）は、登録された各アプリの`/api/health`に定期的にHTTP GETを行い、以下を判定する想定:

1. HTTPステータスコードが200か → アプリプロセス自体の生存確認
2. `ok:true`か → アプリ内部の稼働状態確認
3. `lastHeartbeatAt`が現在時刻からN分以内か → フリーズ検知（応答はあるが内部が固まっている場合の検知）
4. `lastSuccessAt`が期待される頻度で更新されているか → 定期処理の正常性確認（例: 1時間ごとの投稿botなら1時間以内に`lastSuccessAt`が更新されているべき）
5. `lastErrorAt`が直近で頻発していないか → 異常検知
6. `status:'degraded'`を検知した場合はwarning扱い（将来実装。停止扱いにはしない）

VPS Doctor Lite側の実装自体は本仕様書の範囲外（別プロジェクト・別タスク）。

---

## 11. MVPでやること

```
- /api/health エンドポイントの実装
- ok / appName / appType / version / environment / startedAt / lastHeartbeatAt / status / message の実装
- lastSuccessAt / lastErrorAt はアプリが「主要処理」を持つ場合のみ実装（静的サイト等では省略可）
- インメモリでの状態保持（プロセス内の変数。DB永続化は不要）
```

## 12. MVPでまだやらないこと

```
- IPアクセス制限の実装（nginx側の設定は別タスク）
- 認証機構の追加
- lastSuccessCount / lastErrorCount 等の詳細カウント
- 複数インスタンス間での状態集約（クラスタ構成時の考慮）
- VPS Doctor Lite側の実装（別プロジェクト・別タスク）
- app manifest（アプリ一覧管理ファイル）の実装
- ヘルスチェック結果の永続化・履歴保存
- target-project側への実際の実装
- AIチームOSのContext Manager / Developer AIへの組み込み
```

---

## 13. Sonnetで実装可能な範囲 / Opusレビューが必要な境界

**Sonnetで実装可能:**
- 本仕様書に基づく個別target-projectへの`/api/health`実装（Next.js/Node worker実装案の適用）
- 仕様書自体のドキュメント更新・軽微な修正

**Opusレビューが必要になる境界:**
- 複数アプリ共通仕様として、`/api/health`のレスポンス形式に**破壊的変更**（既存フィールドの削除・型変更）を加える場合
- VPS Doctor Lite側との**実際の通信プロトコル**（認証方式、IPホワイトリスト運用等）を確定させる場合
- 標準仕様を**AIチームOSのContext Manager AI/Developer AIのプロンプトテンプレートに組み込む**（AIが自動でこの標準に従ってコードを生成するようにする）場合——これはAIの振る舞いに関わる変更のため、より慎重なレビューが必要

---

*Updated: 2026-07-02*
