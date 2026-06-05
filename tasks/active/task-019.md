# task-019: Mobile — Pending Approval UI

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-012 ✅ task-013 ✅  
**ブランチ**: `ai/task-019`（作成済み・checkout するだけ）  
**コミット形式**: `[codex task-019] feat: ...`

---

## ブランチ

```bash
git checkout ai/task-019
```

---

## タスクスコープ

**pending 状態の Approval（承認待ち事項）を確認・承認・却下できる画面を実装する。**

CEO がスマホから承認操作できることがこのシステムの核心機能。

---

## ファイル構成

```
apps/mobile/app/
  approvals.tsx    ← 新規作成（承認待ち一覧）
  index.tsx        ← 更新（「承認待ち N件」バッジ追加）
```

---

## 実装指示

### `apps/mobile/app/approvals.tsx`（新規作成）

```typescript
import { useEffect, useState, useCallback } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, RefreshControl,
} from 'react-native'
import { router } from 'expo-router'

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

type ApprovalType = 'goal_change'|'philosophy_change'|'external_service'|'billing'|'deployment'|'security'|'dependency_add'
interface Approval { id: string; title: string; reason: string; type: ApprovalType; status: string; createdAt: string }
interface Project { id: string; name: string }

const TYPE_LABEL: Record<ApprovalType, string> = {
  goal_change: 'Goal変更', philosophy_change: '設計思想変更',
  external_service: '外部サービス追加', billing: '課金', deployment: '本番公開',
  security: 'セキュリティ変更', dependency_add: '依存追加',
}

export default function ApprovalsScreen() {
  const [approvals, setApprovals] = useState<Array<Approval & { projectName: string }>>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const projectsRes = await fetch(`${API_BASE}/api/projects`)
      const projects: Project[] = projectsRes.ok ? await projectsRes.json() : []

      const all: Array<Approval & { projectName: string }> = []
      for (const p of projects) {
        const res = await fetch(`${API_BASE}/api/projects/${p.id}/approvals`)
        if (res.ok) {
          const items: Approval[] = await res.json()
          all.push(...items.map(a => ({ ...a, projectName: p.name })))
        }
      }
      setApprovals(all)
    } catch {
      Alert.alert('エラー', 'データの取得に失敗しました')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDecision(approvalId: string, status: 'approved' | 'rejected', note?: string) {
    try {
      const res = await fetch(`${API_BASE}/api/approvals/${approvalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reviewNote: note }),
      })
      if (!res.ok) throw new Error()
      await load()
    } catch {
      Alert.alert('エラー', '操作に失敗しました')
    }
  }

  function confirmApprove(item: Approval & { projectName: string }) {
    Alert.alert('承認', `「${item.title}」を承認しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      { text: '承認', onPress: () => handleDecision(item.id, 'approved') },
    ])
  }

  function confirmReject(item: Approval & { projectName: string }) {
    Alert.alert('却下', `「${item.title}」を却下しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      { text: '却下', style: 'destructive', onPress: () => handleDecision(item.id, 'rejected') },
    ])
  }

  if (loading) return <View style={styles.center}><ActivityIndicator color="#3b82f6" size="large" /></View>

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.title}>承認待ち</Text>
      </View>

      {approvals.length === 0 && (
        <Text style={styles.empty}>承認待ちの事項はありません ✅</Text>
      )}

      {approvals.map(item => (
        <View key={item.id} style={styles.card}>
          <View style={styles.cardTop}>
            <View style={styles.typeBadge}>
              <Text style={styles.typeText}>{TYPE_LABEL[item.type] ?? item.type}</Text>
            </View>
            <Text style={styles.projectName}>{item.projectName}</Text>
          </View>

          <Text style={styles.itemTitle}>{item.title}</Text>
          <Text style={styles.itemReason}>{item.reason}</Text>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.approveBtn} onPress={() => confirmApprove(item)}>
              <Text style={styles.approveBtnText}>✅ 承認</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.rejectBtn} onPress={() => confirmReject(item)}>
              <Text style={styles.rejectBtnText}>❌ 却下</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      <View style={{ height: 40 }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' },
  header:      { flexDirection: 'row', alignItems: 'center', marginTop: 52, marginBottom: 20 },
  back:        { marginRight: 12 },
  backText:    { color: '#3b82f6', fontSize: 15 },
  title:       { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  empty:       { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 16 },
  card:        { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16, marginBottom: 12 },
  cardTop:     { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  typeBadge:   { backgroundColor: '#f59e0b22', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  typeText:    { color: '#f59e0b', fontSize: 11, fontWeight: '600' },
  projectName: { color: '#666', fontSize: 12 },
  itemTitle:   { fontSize: 16, fontWeight: '600', color: '#fff', marginBottom: 6 },
  itemReason:  { fontSize: 14, color: '#999', lineHeight: 20, marginBottom: 14 },
  actions:     { flexDirection: 'row', gap: 10 },
  approveBtn:  { flex: 1, backgroundColor: '#22c55e22', borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#22c55e44' },
  approveBtnText: { color: '#22c55e', fontWeight: '600', fontSize: 14 },
  rejectBtn:   { flex: 1, backgroundColor: '#ef444422', borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#ef444444' },
  rejectBtnText: { color: '#ef4444', fontWeight: '600', fontSize: 14 },
})
```

### `apps/mobile/app/index.tsx`（承認待ちバッジを追加）

Dashboard の refreshButton の上に以下を追加する：

```typescript
// import に追加
import { router } from 'expo-router'

// 既存の refreshButton の上に追加
<TouchableOpacity style={styles.approvalButton} onPress={() => router.push('/approvals')}>
  <Text style={styles.approvalText}>🔔 承認待ち一覧</Text>
</TouchableOpacity>

// styles に追加
approvalButton: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: '#f59e0b44' },
approvalText:   { color: '#f59e0b', fontSize: 15, fontWeight: '500' },
```

---

## 完了チェックリスト

```bash
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/mobile typecheck
```

変更ファイル:
- `apps/mobile/app/approvals.tsx`（新規）
- `apps/mobile/app/index.tsx`（ボタン追加のみ）

---

## 完了後

```bash
git add apps/mobile/app/approvals.tsx apps/mobile/app/index.tsx
git commit -m "[codex task-019] feat: Pending Approval UI（承認待ち一覧・承認/却下操作）"
git push origin ai/task-019
```
