# Decision-006: AI CLI Adapter — CLIベースの自律開発

**Importance Level: 4**
**Status: active**
**Date: 2026-05-30**

---

## Decision

AI開発チームの実装エンジンとして、**API直叩きではなくAI CLIをWorkerがラップする形**を採用する。

```
CEO Dashboard
  ↓
Backend API
  ↓
Worker（権限管理・実行制御・差分管理）
  ↓
AI CLI Adapter（共通インターフェース）
    ├─ Claude Code CLI  ← Developer AI（実装）
    ├─ Gemini CLI       ← Reviewer AI（レビュー）
    └─ Codex CLI        ← 将来の選択肢
  ↓
/workspace/target（AIが触れる唯一の場所）
```

---

## 確定した役割分担

| AI役割 | プロバイダー | 使用形式 | 使う状況 |
|---|---|---|---|
| **Developer AI（メイン）** | Claude Code | CLI | 新機能・複雑実装・CLAUDE.mdの自律遵守が必要 |
| **Developer AI（サブ）** | Codex | CLI（auto-edit） | 既存コード局所編集・フォールバック |
| **Meta Reviewer AI** | Gemini | **API**（geminiClient.ts） | セキュリティ審査（再現性・温度制御が必要） |
| **Project Reviewer AI** | Gemini | CLI | コード品質レビュー（Phase 3） |
| **CTO AI / Context Manager** | Claude | API（将来） | 設計・推論・ContextPack生成 |

**コンポーネント役割**:
| コンポーネント | 役割 |
|---|---|
| **AI CLI** | 意思決定・実装案・レビュー案を出すエンジン（頭脳） |
| **Worker** | 権限管理・実行管理・差分管理・承認管理をする本体 |
| **Guard** | 絶対ルールを機械的に守る安全装置 |
| **Meta Reviewer AI** | OSの憲法裁判所（Gemini API経由 — autoReview.ts） |

> AI CLIは強力だが、最終権限は持たせない。
> 詳細なリスクと対策: `docs/project_memory/rules/001_codex_integration_risks.md`

---

## Rationale

### なぜAPIではなくCLIか

1. **コスト効率**: CLI版はサブスクリプション課金が多く、個人開発では有利
2. **方向性の合致**: specs/11_runtime_environment.md にもClaude Code中心と記載
3. **実装品質**: Claude Code CLIはcode generation特化で精度が高い

### なぜ「CLIをそのまま自由実行させない」か

```
AI CLIを野放しにすると:
  → Control Repository を書き換えられる（檻を壊す）
  → /workspace/target 外のファイルを読める
  → シェルコマンドを自由実行できる
  → 秘密情報（.env等）にアクセスできる
```

WorkerがCLIをラップすることで:
- `workingDir` を `/workspace/target` 限定に強制
- `shell: false` でインジェクション防止
- `stdin` を閉じて対話入力を防止
- タイムアウトで暴走を防止
- Secret Scanでプロンプトへの秘密混入を防止

---

## 実装

```
packages/shared/src/types/ai_cli.ts
  AiCliProvider / AiCliMode / AiCliRequest / AiCliResult
  AiCliAdapterConfig / CONTEXT_SECRET_PATTERNS / isPromptSafe()

apps/worker/src/aiCli/
├── adapter.ts           ← BaseCliAdapter（セキュリティ強制）+ createAiCliAdapter()
├── claudeCodeAdapter.ts ← Claude Code CLI ラッパー
├── geminiCliAdapter.ts  ← Gemini CLI ラッパー（Reviewer AI用）
└── codexAdapter.ts      ← Codex CLI ラッパー（将来用）
```

---

## 注意事項

### CLI利用規約・自動化制限

各CLIサービスの利用規約・レート制限・自動化ポリシーは変わる可能性がある。

```
AI CLI利用は各サービスの利用規約・レート制限・自動化ポリシーに従う。
違反リスクがある使い方はYellow ZoneとしてCEO承認を必要とする。
```

### CLIの出力不安定性への対策

APIと違いCLIは出力フォーマットが変わることがある。
- stdout / stderr / exitCode / changedFiles / git diff を必ず保存
- JSON parseに失敗した場合は `maxRetries` 回再実行
- 全リトライ失敗時は `blocked` 扱い（安全側に倒す）

### Meta Reviewer AIはAPIを使い続ける

Meta Reviewer AI（Gemini）は、CLIではなくAPIを使う（autoReview.ts の callGeminiForReview()）。

理由:
- 安全審査は結果の再現性・一貫性が最重要
- CLIの出力不安定性をセキュリティ判定に持ち込まない
- temperature=0.1 の固定が必要（APIなら確実に指定できる）

---

*Created by: CTO AI — AI CLI Adapter設計*
