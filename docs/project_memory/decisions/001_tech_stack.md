# Decision-001: Tech Stack Selection

**Importance Level: 3**
**Status: active**
**Date: 2026-05-28**

---

## Decision

以下のtech stackを採用する。

| レイヤー | 技術 | 理由 |
|---|---|---|
| Mobile App | React Native / Expo | スマホ完結・クロスプラットフォーム |
| Backend API | Fastify + TypeScript | 高速・型安全・軽量 |
| Worker | TypeScript + Node.js | Backend共通言語 |
| Sandbox | Docker | AIの実行環境を物理的に分離 |
| Storage (MVP) | Markdown Files | DB不要・シンプル・Git管理可能 |
| Repository | GitHub | バージョン管理・Rollback基盤 |
| AI Execution | Claude Code | 中心的な実装AI |
| Monorepo | pnpm workspaces | 共有型・パッケージ管理 |

## Rationale

- MVPはMarkdown Filesのみで開始し、DB不要にすることで複雑性を下げる
- Docker Sandboxでコントロールリポジトリをアプリコードから物理分離
- スマホ完結のためExpoを採用（OTAアップデート対応）

## Trade-offs

- PostgreSQLは将来フェーズで追加予定（Phase 2以降）
- React Nativeの学習コストはExpoで軽減

---

*Created by: CTO AI (initial setup)*
