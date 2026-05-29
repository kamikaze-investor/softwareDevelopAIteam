# Phase 1 レビュー依頼プロンプト
# ↓ここから下をそのままAIに貼り付けてください↓

---

以下のシステムのPhase 1実装をレビューしてください。

## このシステムとは

**AI Development Team OS** — スマホだけでAI開発チームを運営するためのシステム。

- ユーザー（CEO）はGoal設定と方向修正のみ行う
- AIチーム（CTO AI / Developer AI / Reviewer AI / QA AI）が自律的に開発を進める
- スマホのCEOダッシュボードから状況確認・承認を行う

## レビューしてほしい観点

1. **型設計の妥当性** — shared/の型定義はこのシステムの仕様を正しく表現できているか
2. **セキュリティ設計** — Permission Guard / File Change Guard の抜け穴はないか
3. **アーキテクチャ整合性** — 仕様書の思想（Context First / AI Cannot Modify Its Own Cage）が実装に反映されているか
4. **MVP観点** — Phase 1として不足しているものはないか。逆に過剰なものはないか
5. **将来の拡張性** — Phase 2実装時に問題になりそうな設計上の問題はないか

---

## 憲法・行動規範（CLAUDE.md）

```markdown
# CLAUDE.md — AI Development Team OS

## 1. Mission
スマホだけでAI開発チームを運営できる世界を作る。

## 2. Design Philosophy（絶対遵守）
1. スマホ完結 — すべての操作がスマホから完結すること
2. 全自動優先 — 人間の操作を最小化する
3. 承認最小 — 承認を求めるのは絶対に必要な時だけ
4. Rollback重視 — 失敗しても即座に戻せる設計
5. Context重視 — AIには必要な情報だけを渡す
6. 小さく変更 — 1タスク = 最小変更単位
7. 小さくコミット — 1タスク = 1コミット

## 3. Authority Principle
AIが自由にできること（Green Zone）:
  実装 / 修正 / リファクタリング / テスト / ドキュメント更新
  コミット / ブランチ作成 / ロールバック

CEOの承認が必要（Yellow Zone）:
  Goal変更 / Design Philosophy変更
  外部サービス追加 / 課金発生 / 本番公開

## 4. Repository Boundary（最重要）
ai-team-backend/  →  AIが触れない（Control Repository）
target-project/   →  AIが触れる（Target Repository）
```

---

## プロジェクト構造

```
softwareDevelopAIteam/
├── CLAUDE.md
├── specs/              # 仕様書 01〜11
├── docs/project_memory/
├── tasks/
│   ├── roadmap.md
│   └── task_graph.md
├── packages/shared/    # 共有型定義
├── apps/
│   ├── api/            # Backend API (Fastify)
│   ├── worker/         # Worker + Guards
│   └── mobile/         # CEO Dashboard (Expo)
└── sandbox/            # Docker Sandbox
```

---

## 実装コード

### packages/shared/src/types/project.ts
```typescript
export type ProjectStatus = 'draft' | 'running' | 'paused' | 'archived'

export interface Project {
  id: string
  name: string
  goal: string
  designPhilosophy: string[]
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface ProjectSummary {
  project: Pick<Project, 'id' | 'name' | 'goal' | 'designPhilosophy' | 'status'>
  progress: number
  currentWork: string[]
  nextWork: string[]
  risks: Risk[]
  openDecisions: Decision[]
  pendingApprovals: Approval[]
  healthScore: number
}

export interface Risk {
  id: string
  title: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
}

export interface Decision {
  id: string
  title: string
  status: 'ai_thinking' | 'ai_decided' | 'needs_ceo'
  description: string
}

export interface Approval {
  id: string
  title: string
  reason: string
  type: 'goal_change' | 'philosophy_change' | 'external_service' | 'billing' | 'deployment' | 'security'
  createdAt: string
}
```

### packages/shared/src/types/task.ts
```typescript
export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assignee: 'cto_ai' | 'context_manager' | 'developer' | 'reviewer' | 'qa'
  dependencies: string[]
  branchName?: string
  commitHash?: string
  createdAt: string
  updatedAt: string
}
```

### packages/shared/src/types/job.ts
```typescript
export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'blocked'

export interface Job {
  id: string
  taskId: string
  projectId: string
  status: JobStatus
  command: string
  workingDir: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  changedFiles?: string[]
  commitHash?: string
  rollbackInfo?: RollbackInfo
  createdAt: string
}

export interface RollbackInfo {
  previousCommitHash: string
  changedFiles: string[]
  rollbackCommand: string
}
```

### packages/shared/src/types/memory.ts
```typescript
export type MemoryType =
  | 'goal' | 'design_philosophy' | 'decision'
  | 'feature' | 'rule' | 'lesson'

export type MemoryStatus = 'active' | 'archived'

export interface Memory {
  id: string
  type: MemoryType
  title: string
  summary: string
  content: string
  importance: 1 | 2 | 3 | 4 | 5
  status: MemoryStatus
  createdAt: string
  updatedAt: string
  tags: string[]
  references: string[]
}

export interface ContextPack {
  taskId: string
  generatedAt: string
  tokenEstimate: number
  goal: string
  designPhilosophy: string[]
  taskSummary: string
  relevantDecisions: Memory[]
  relevantFeatures: Memory[]
  relevantRules: Memory[]
  lessonsLearned: Memory[]
  relatedCode: string[]
  relatedTasks: string[]
}
```

### apps/worker/src/guards/permissionGuard.ts
```typescript
const ALLOWED_COMMANDS = [
  'git status', 'git diff', 'git checkout', 'git commit', 'git revert',
  'npm install', 'npm test', 'npm run build', 'npm run typecheck',
  'pnpm test', 'python -m pytest', 'claude', 'codex', 'gemini',
]

const FORBIDDEN_PATTERNS = [
  /^sudo/, /^su\s/, /rm\s+-rf\s+\//,
  /curl.*\|\s*sh/, /wget.*\|\s*sh/,
  /chmod\s+777/, /^chown/,
  /^ssh\s/, /^scp\s/, /^rsync\s/,
  /docker\s+run/, /docker\s+compose/,
  /^systemctl/, /^ufw/,
  /apt\s+install/, /brew\s+install/,
]

export interface GuardResult {
  allowed: boolean
  reason?: string
}

export function permissionGuard(command: string, workingDir: string): GuardResult {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Forbidden command pattern: ${pattern}` }
    }
  }
  if (!workingDir.startsWith('/workspace/project')) {
    return { allowed: false, reason: `Invalid working directory: ${workingDir}` }
  }
  return { allowed: true }
}
```

### apps/worker/src/guards/fileChangeGuard.ts
```typescript
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env$/, /^\.env\./,
  /\.pem$/, /\.key$/,
  /^id_rsa/, /^id_ed25519/,
  /service-account\.json$/,
  /docker-compose\.prod\.yml$/,
  /^apps\/api\//,
  /^apps\/worker\//,
  /^sandbox\//,
]

export interface FileGuardResult {
  allowed: boolean
  violations: string[]
}

export function fileChangeGuard(changedFiles: string[]): FileGuardResult {
  const violations: string[] = []
  for (const file of changedFiles) {
    for (const pattern of FORBIDDEN_FILE_PATTERNS) {
      if (pattern.test(file)) {
        violations.push(file)
        break
      }
    }
  }
  return { allowed: violations.length === 0, violations }
}
```

### sandbox/Dockerfile
```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /workspace/project

RUN useradd -m -u 1001 aiworker
USER aiworker

CMD ["sh"]
```

---

## タスク一覧（Phase 1）

| ID | タイトル | 依存 |
|---|---|---|
| task-001 | 共有型定義 (packages/shared) | — |
| task-002 | Backend API 骨格 | task-001 |
| task-003 | Worker 骨格 | task-001 |
| task-004 | Docker Sandbox 設定 | task-003 |
| task-005 | Mobile App 骨格 (Expo) | task-001 |
| task-006 | Backend: Project CRUD API | task-002 |
| task-007 | Backend: Task CRUD API | task-002 |
| task-008 | Backend: Job Queue API | task-002, task-003 |
| task-009 | Worker: Job実行エンジン | task-003, task-004 |
| task-010 | Worker: Command Allowlist Guard | task-009 |
| task-011 | Worker: File Change Guard | task-009 |
| task-012 | Mobile: Dashboard画面 | task-005, task-006 |
| task-013 | Mobile: Project作成画面 | task-005, task-006 |

---

## 補足情報

- MVP Storage: Markdown Files のみ（DBなし）
- AI実行: Claude Code 中心
- ターゲット: 非エンジニア個人開発者がスマホからAI開発チームを運営

以上をレビューして、問題点・改善提案・不足点を教えてください。
