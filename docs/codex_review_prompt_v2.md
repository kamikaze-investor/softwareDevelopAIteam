# AI Distribution Engine — Phase 2 実装レビュー v2（Codex レビュー指摘対応後）

あなたはシニアソフトウェアエンジニアです。
前回レビューから以下の修正を行いました。前回の指摘事項が正しく対応されているか確認し、新たな問題があれば指摘してください。

---

## 前回からの変更点

### [P1] Fix 1: Developer AI の実行パスを修正
- `developerAiOrchestrator.ts` の壊れた動的 import（`../../worker/src/...`）を削除
- 代わりに「`mockRun=false` は Job Queue 経由を使え」という明確な Error を throw
- テスト追加: `mockRun=false` で throw することを検証

### [P1] Fix 2: パス境界検証を追加
- `apps/api/src/utils/pathGuard.ts` を新設
- `validateTargetRoot()`: `..` 含む・相対パス・Control Repository・危険OS パスを 400 拒否
- `validateAllowedPaths()`: `..` 含む・targetRoot 外の絶対パスを拒否
- `/api/cto/analyze`, `/api/cto/generate-roadmap`, `/api/context-pack`, `/api/developer-ai/run`, `/api/summary/update` 全ルートに組み込み済み

### [P2] Fix 3: mock は task_graph を完了にしない
- `summaryEngine.ts` を修正
- `status === 'success'` のみ `[x]` に更新
- `mock` は task_graph を変更しない（ダッシュボードへの記録は行う）
- テスト追加・修正済み

### [P2] Fix 4: 手動承認ゲートを追加
- `developerAi.ts` に `approved: boolean`（デフォルト `false`）フィールドを追加
- `mockRun=false && approved=false` の場合 403 を返す
- エラーメッセージに仕様「手動確認あり」の旨を明記

### [新規] Fix 5: Codex CLI Windows パス解決を修正
- `apps/worker/src/aiCli/codexPathResolver.ts` を新設
- 解決順序: `CODEX_CLI_PATH` 環境変数 → `codex.cmd`（Windows npm global）→ `codex`
- WindowsApps / AppData\Local\Microsoft\WindowsApps 配下は実行拒否
  → `npm install -g @openai/codex` を案内するエラーを出す
- `testCodexConnection()`: 実際に `codex --version` を呼ぶ疎通テスト
- `CodexAdapter` が constructor で `resolveCodexPath()` を使うよう更新

---

## 主要ファイル構成（現在）

```
apps/api/src/
  ctoAi/
    specAnalyzer.ts          # 仕様書 → SpecAnalysis（Claude API）
    projectMemoryWriter.ts   # SpecAnalysis → docs/project_memory/*.md
    roadmapGenerator.ts      # SpecAnalysis → Roadmap JSON（Claude API）
    roadmapWriter.ts         # Roadmap → docs/roadmap.md + tasks/task_graph.md
    contextManager.ts        # Task → Context Pack（ファイル収集 + instruction）
    developerAiOrchestrator.ts  # mockRun=true → mock実行 / false → Job Queue案内エラー
    summaryEngine.ts         # 実行結果 → docs/dashboard.md（success のみ task_graph 更新）
  utils/
    pathGuard.ts             # targetRoot/allowedPaths 境界検証
  routes/
    ctoAi.ts                 # POST /api/cto/analyze, /api/cto/generate-roadmap
    contextPack.ts           # POST /api/context-pack
    developerAi.ts           # POST /api/developer-ai/run（approved ゲート付き）
    summaryEngine.ts         # POST /api/summary/update

apps/worker/src/aiCli/
  codexPathResolver.ts       # Codex CLI パス解決（WindowsApps 拒否・npm global 優先）
  codexAdapter.ts            # resolveCodexPath() を使うよう更新
```

**テスト**: 189 テスト（Worker 50 + API 139）全通過

---

## レビュー依頼事項

### 1. 前回指摘の対応漏れ・不十分な点
- 上記 Fix 1〜5 で前回のP1/P2指摘は適切に対応できているか？
- 対応方針・実装内容に問題はないか？

### 2. Fix 5（Codex パス解決）の追加確認
- `codexPathResolver.ts` の解決ロジックに抜け穴がないか？
- `testCodexConnection()` の疎通テストアプローチは適切か？
- `codex.cmd` が npm global にない場合のフォールバック（`codex` を使う）で問題はないか？

### 3. 残存リスク
- 今回の修正で新たに生まれたリスクはあるか？
- P2「Context Pack に依存タスクの実体コンテキストがない」は依然として未対応だが、現時点での影響度は？

### 4. 次の実装フェーズ（ai-distribution-engine 本体）への提言
- 前回提案の「Core Content DB + Raw Input Layer」「AI Editor/CMO パイプライン」「Manual Approval + Platform Publisher」を実装する際に、今回の Control OS 実装から引き継ぐべき設計パターンがあれば挙げてください

レビュー結果は日本語・箇条書きでお願いします。
