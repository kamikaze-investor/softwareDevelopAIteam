# Task Graph

**Phase**: 1 — 基盤構築

---

## 凡例

- ステータス: `[ ]` 未着手 / `[>]` 進行中 / `[x]` 完了 / `[!]` ブロック

---

## Task一覧

| ID | タイトル | ステータス | 依存 | 担当 |
|---|---|---|---|---|
| task-001 | 共有型定義 (packages/shared) | [ ] | — | Developer AI |
| task-002 | Backend API 骨格 | [ ] | task-001 | Developer AI |
| task-003 | Worker 骨格 | [ ] | task-001 | Developer AI |
| task-004 | Docker Sandbox 設定 | [ ] | task-003 | Developer AI |
| task-005 | Mobile App 骨格 (Expo) | [ ] | task-001 | Developer AI |
| task-006 | Backend: Project CRUD API | [ ] | task-002 | Developer AI |
| task-007 | Backend: Task CRUD API | [ ] | task-002 | Developer AI |
| task-008 | Backend: Job Queue API | [ ] | task-002 task-003 | Developer AI |
| task-009 | Worker: Job実行エンジン | [ ] | task-003 task-004 | Developer AI |
| task-010 | Worker: Command Allowlist Guard | [ ] | task-009 | Developer AI |
| task-011 | Worker: File Change Guard | [ ] | task-009 | Developer AI |
| task-012 | Mobile: Dashboard画面 | [ ] | task-005 task-006 | Developer AI |
| task-013 | Mobile: Project作成画面 | [ ] | task-005 task-006 | Developer AI |

---

*Updated: 2026-05-28*
