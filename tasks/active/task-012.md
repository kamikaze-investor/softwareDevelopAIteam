# task-012: Mobile — Dashboard 基本画面

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-005 ✅ task-006 ✅ task-009 ✅  
**ブランチ**: `ai/task-012`（作成済み・checkout するだけ）  
**コミット形式**: `[codex task-012] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md`
2. `CLAUDE.md`
3. `apps/mobile/app/index.tsx` — 現在の骨格
4. `apps/mobile/package.json` — 利用可能なパッケージ確認
5. `specs/07_dashboard.md` — Dashboard 仕様

---

## ブランチ

```bash
git checkout ai/task-012
```

---

## タスクスコープ

**CEO が 30 秒で現在地を把握できる Dashboard 画面を実装する。**

API から Projects・Tasks・Jobs を取得して表示する。UI はシンプルに徹する。

**スマホ完結が最優先。複雑な UI は不要。**

---

## API エンドポイント（既に実装済み）

```
GET /api/projects               → Project 一覧
GET /api/tasks?projectId=xxx    → Task 一覧
GET /api/jobs?taskId=xxx        → Job 一覧
```

API_BASE_URL は `EXPO_PUBLIC_API_URL` 環境変数で設定（デフォルト: `http://localhost:3000`）

---

## 画面構成

```
Dashboard
  ┌─────────────────────────┐
  │ AI Development Team OS  │  ← タイトル
  │ CEO Dashboard           │
  ├─────────────────────────┤
  │ 📊 Projects (N件)        │  ← プロジェクト数
  │                         │
  │ [Project Name]          │  ← プロジェクトカード（繰り返し）
  │  Goal: ...              │
  │  Status: running        │
  │  Tasks: 完了/全体        │
  │                         │
  │  最近のジョブ            │
  │  [success] git_commit   │
  │  [running] typecheck    │
  ├─────────────────────────┤
  │ 🔄 Refresh              │  ← 更新ボタン
  └─────────────────────────┘
```

---

## 実装指示

### `apps/mobile/app/index.tsx`（既存を完全に置き換え）

```typescript
/**
 * CEO Dashboard — ホーム画面
 * 30 Second Rule: 30秒以内に現在地を把握できること
 */

import { useEffect, useState, useCallback } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StyleSheet,
} from 'react-native'

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

// --- 型定義 ---
type ProjectStatus = 'draft' | 'running' | 'paused' | 'archived'
type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked'
type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'blocked'

interface Project { id: string; name: string; goal: string; status: ProjectStatus }
interface Task { id: string; title: string; status: TaskStatus; projectId: string }
interface Job { id: string; status: JobStatus; safeCommand: { kind: string }; completedAt?: string }

// --- API ---
async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/api/projects`)
  if (!res.ok) throw new Error('Failed to fetch projects')
  return res.json()
}

async function fetchTasks(projectId: string): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/api/tasks?projectId=${projectId}`)
  if (!res.ok) return []
  return res.json()
}

async function fetchRecentJobs(taskIds: string[]): Promise<Job[]> {
  const jobs: Job[] = []
  for (const taskId of taskIds.slice(0, 3)) {  // 最大3タスク分
    const res = await fetch(`${API_BASE}/api/jobs?taskId=${taskId}`)
    if (res.ok) {
      const taskJobs: Job[] = await res.json()
      jobs.push(...taskJobs.slice(0, 2))  // 各タスク最大2件
    }
  }
  return jobs.slice(0, 5)  // 合計最大5件
}

// --- ステータスカラー ---
const STATUS_COLOR: Record<string, string> = {
  success: '#22c55e', running: '#3b82f6', failed: '#ef4444',
  blocked: '#f59e0b', queued: '#6b7280', done: '#22c55e',
  in_progress: '#3b82f6', pending: '#6b7280', review: '#a855f7',
  draft: '#6b7280', paused: '#f59e0b', archived: '#374151',
}

// --- ProjectCard ---
function ProjectCard({ project }: { project: Project }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [jobs, setJobs] = useState<Job[]>([])

  useEffect(() => {
    fetchTasks(project.id).then(t => {
      setTasks(t)
      return fetchRecentJobs(t.map(x => x.id))
    }).then(setJobs).catch(() => {})
  }, [project.id])

  const doneTasks = tasks.filter(t => t.status === 'done').length

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{project.name}</Text>
        <View style={[styles.badge, { backgroundColor: STATUS_COLOR[project.status] ?? '#6b7280' }]}>
          <Text style={styles.badgeText}>{project.status}</Text>
        </View>
      </View>

      <Text style={styles.goalText} numberOfLines={2}>{project.goal}</Text>

      {tasks.length > 0 && (
        <Text style={styles.progressText}>
          Tasks: {doneTasks}/{tasks.length} 完了
        </Text>
      )}

      {jobs.length > 0 && (
        <View style={styles.jobsSection}>
          <Text style={styles.sectionLabel}>最近のJob</Text>
          {jobs.map(job => (
            <View key={job.id} style={styles.jobRow}>
              <View style={[styles.jobDot, { backgroundColor: STATUS_COLOR[job.status] ?? '#6b7280' }]} />
              <Text style={styles.jobText}>{job.safeCommand?.kind ?? '—'}</Text>
              <Text style={[styles.jobStatus, { color: STATUS_COLOR[job.status] ?? '#6b7280' }]}>
                {job.status}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

// --- Dashboard ---
export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      const data = await fetchProjects()
      setProjects(data)
    } catch (e) {
      setError('API に接続できません')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />}
    >
      <Text style={styles.title}>AI Development Team OS</Text>
      <Text style={styles.subtitle}>CEO Dashboard</Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {projects.length === 0 && !error && (
        <Text style={styles.empty}>プロジェクトがありません</Text>
      )}

      {projects.map(p => <ProjectCard key={p.id} project={p} />)}

      <TouchableOpacity style={styles.refreshButton} onPress={load}>
        <Text style={styles.refreshText}>🔄 更新</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  )
}

// --- スタイル ---
const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  center:       { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' },
  title:        { fontSize: 22, fontWeight: 'bold', color: '#fff', marginTop: 52 },
  subtitle:     { fontSize: 13, color: '#666', marginTop: 2, marginBottom: 20 },
  card:         { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16, marginBottom: 12 },
  cardHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitle:    { fontSize: 16, fontWeight: '600', color: '#fff', flex: 1, marginRight: 8 },
  badge:        { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  badgeText:    { fontSize: 11, color: '#fff', fontWeight: '500' },
  goalText:     { fontSize: 13, color: '#999', marginBottom: 8, lineHeight: 18 },
  progressText: { fontSize: 13, color: '#60a5fa', marginBottom: 8 },
  jobsSection:  { borderTopWidth: 1, borderTopColor: '#2a2a2a', paddingTop: 8, marginTop: 4 },
  sectionLabel: { fontSize: 11, color: '#555', marginBottom: 6, textTransform: 'uppercase' },
  jobRow:       { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  jobDot:       { width: 6, height: 6, borderRadius: 3, marginRight: 8 },
  jobText:      { fontSize: 13, color: '#ccc', flex: 1 },
  jobStatus:    { fontSize: 12, fontWeight: '500' },
  errorBox:     { backgroundColor: '#2a1515', borderRadius: 8, padding: 12, marginBottom: 12 },
  errorText:    { color: '#ef4444', fontSize: 14 },
  empty:        { color: '#555', textAlign: 'center', marginTop: 40, fontSize: 15 },
  refreshButton:{ marginTop: 8, padding: 14, backgroundColor: '#1a1a1a', borderRadius: 10, alignItems: 'center' },
  refreshText:  { color: '#3b82f6', fontSize: 15, fontWeight: '500' },
})
```

---

## `.env.example` への追記

```
# Mobile アプリが接続する API の URL
EXPO_PUBLIC_API_URL=http://localhost:3000
```

---

## 完了チェックリスト

```bash
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/mobile typecheck
```

（mobile のテストは UI コンポーネントのため今回は typecheck のみ）

変更ファイル:
- `apps/mobile/app/index.tsx`（既存を置き換え）
- `.env.example`（EXPO_PUBLIC_API_URL 追記）

---

## 完了後

```bash
git add apps/mobile/app/index.tsx .env.example
git commit -m "[codex task-012] feat: CEO Dashboard 基本画面を実装（プロジェクト/タスク/ジョブ一覧）"
git push origin ai/task-012
```
