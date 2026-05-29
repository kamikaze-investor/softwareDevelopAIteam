# Task Graph

**Phase**: 1 — 基盤構築

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
| task-006 | Backend: Project CRUD API | [ ] | task-002 | Developer AI |
| task-007 | Backend: Task CRUD API | [ ] | task-002 | Developer AI |
| task-008 | Backend: Job Queue API | [ ] | task-002 task-003 | Developer AI |
| task-009 | Worker: Job実行エンジン | [ ] | task-003 task-004 | Developer AI |
| task-010 | Worker: CommandResolver実装 | [x] | task-003 | Developer AI |
| task-011 | Worker: File Change Guard完成 | [x] | task-009 | Developer AI |
| task-012 | Mobile: Dashboard画面 | [ ] | task-005 task-006 | Developer AI |
| task-013 | Mobile: Project作成画面 | [ ] | task-005 task-006 | Developer AI |
| task-014 | 簡易認証追加 (API token) | [ ] | task-002 | Developer AI |
| task-015 | ReviewResult / QAResult型 + API | [ ] | task-007 | Developer AI |
| task-016 | Job状態遷移ルール + 復旧ロジック | [ ] | task-008 task-009 | Developer AI |
| task-017 | Jobログ分離保存 (stdout/stderrファイル) | [ ] | task-009 | Developer AI |
| task-018 | Backend Storage SQLite完全実装 | [ ] | task-002 | Developer AI |
| task-019 | Dashboard: Pending Approval UI | [ ] | task-012 | Developer AI |
| task-020 | Meta Review 自動実行（GitHub Actions + pre-push） | [x] | — | Developer AI |
| task-021 | AI CLI Adapter基盤（型定義 + BaseCliAdapter + 各Provider） | [x] | task-003 | Developer AI |
| task-022 | CLI実行ログ保存（stdout/stderr/changedFiles永続化） | [ ] | task-021 task-017 | Developer AI |
| task-023 | CLI出力パーサー + JSONリトライ機構（失敗→blocked） | [ ] | task-021 | Developer AI |
| task-024 | CLI timeout / cancel 設計（暴走防止） | [ ] | task-021 | Developer AI |

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

*Updated: 2026-05-30 (AI CLI Adapter追加)*
