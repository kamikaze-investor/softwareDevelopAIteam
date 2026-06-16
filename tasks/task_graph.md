# Task Graph

**Phase**: 2 — MVP実装（進行中）

---

## 凡例

- ステータス: `[ ]` 未着手 / `[>]` 進行中 / `[x]` 完了 / `[!]` ブロック

---

## Task一覧

| ID | タイトル | ステータス | 依存 | 担当 |
|---|---|---|---|---|
| task-001 | 共有型定義 (packages/shared) 骨格 | [x] | — | Developer AI |
| task-002 | Backend API 骨格 | [x] | task-001 | Developer AI |
| task-003 | Worker 骨格 | [x] | task-001 | Developer AI |
| task-004 | Docker Sandbox 設定 | [x] | task-003 | Developer AI |
| task-005 | Mobile App 骨格 (Expo) | [x] | task-001 | Developer AI |
| task-006 | Backend: Project CRUD API | [x] | task-002 | Codex |
| task-007 | Backend: Task CRUD API | [x] | task-002 | Codex |
| task-008 | Backend: Job Queue API | [x] | task-002 task-003 | Developer AI |
| task-009 | Worker: Job実行エンジン | [x] | task-003 task-004 | Developer AI |
| task-010 | Worker: CommandResolver実装 | [x] | task-003 | Developer AI |
| task-011 | Worker: File Change Guard完成 | [x] | task-009 | Developer AI |
| task-012 | Mobile: Dashboard画面 | [x] | task-005 task-006 | Developer AI |
| task-013 | Mobile: Project作成画面 | [x] | task-005 task-006 | Developer AI |
| task-014 | 簡易認証追加 (API token) | [x] | task-002 | Developer AI |
| task-015 | ReviewResult / QAResult型 + API | [x] | task-007 | Developer AI |
| task-016 | Job状態遷移ルール + 復旧ロジック | [x] | task-008 task-009 | Developer AI |
| task-017 | Jobログ分離保存 (stdout/stderrファイル) | [x] | task-009 | Developer AI |
| task-018 | Backend Storage SQLite完全実装 | [x] | task-002 | Codex |
| task-019 | Dashboard: Pending Approval UI | [x] | task-012 | Developer AI |
| task-020 | Meta Review 自動実行（GitHub Actions + pre-push） | [x] | — | Developer AI |
| task-021 | AI CLI Adapter基盤（型定義 + BaseCliAdapter + 各Provider） | [x] | task-003 | Developer AI |
| task-022 | CLI実行ログ保存（stdout/stderr/changedFiles永続化） | [x] | task-021 task-017 | Developer AI |
| task-023 | CLI出力パーサー + JSONリトライ機構（失敗→blocked） | [x] | task-021 | Developer AI |
| task-024 | CLI timeout / cancel 設計（暴走防止） | [x] | task-021 | Developer AI |

---

## レビュー対応済み（Phase 1）

| 対応 | 内容 |
|---|---|
| ✅ | Permission Guard → SafeCommand/CommandKind方式 |
| ✅ | File Change Guard → realpath正規化 + task.allowedPaths |
| ✅ | workingDir → isInsideTargetRoot()で検証 |
| ✅ | Control/Target Docker物理分離 (read-only/read-write) |
| ✅ | Approval.status追加 / ApprovalType.dependency_add追加 |
| ✅ | AgentPolicy型追加（Reviewer/QA AIは実装変更不可） |
| ✅ | Task.allowedPaths / acceptanceCriteria追加 |
| ✅ | Job.agentRole / guardResult追加（監査ログ） |
| ✅ | ReviewResult / QAResult型追加 |
| ✅ | SQLite + Repository Pattern（Race Condition対策） |
| ✅ | Decision-003〜005記録済み（Meta Reviewer / Gemini担当） |
| ✅ | Meta Review 自動化（GitHub Actions + pre-push hook） |
| ✅ | AI CLI Adapter設計（Decision-006: CLIをWorkerがラップ） |
| ✅ | BaseCliAdapter: workingDir検証・SecretScan・shell:false・timeout |

---

---

## Phase 2 タスク（MVP実装）

**Target Project**: `ai-distribution-engine`
**場所**: `C:\Users\honka\ai-distribution-engine\`
**GitHub**: https://github.com/kamikaze-investor/ai-distribution-engine

| ID | タイトル | ステータス | 依存 | 担当 |
|---|---|---|---|---|
| task-101 | CTO AI: 仕様書解析 → Project Memory生成 | [x] | — | Developer AI |
| task-102 | CTO AI: Project Memory → Roadmap + Task一覧生成 | [x] | task-101 | Developer AI |
| task-103 | Context Manager AI: Task → Context Pack生成 | [ ] | task-102 | Developer AI |
| task-104 | Worker: AI CLI を target-project で実行するエンドツーエンド接続 | [ ] | task-103 | Developer AI |
| task-105 | Summary Engine: 実行結果 → Dashboard自動更新 | [ ] | task-104 | Developer AI |

---

*Updated: 2026-06-06 (Phase 1 全完了 → Phase 2 開始・ai-distribution-engine をターゲットに設定)*
