# task-013: Mobile — Project 作成画面

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-005 ✅ task-006 ✅  
**ブランチ**: `ai/task-013`（作成済み・checkout するだけ）  
**コミット形式**: `[codex task-013] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md`
2. `CLAUDE.md`
3. `apps/mobile/app/index.tsx` — Dashboard 画面（参考）
4. `apps/mobile/package.json` — 利用可能なパッケージ確認

---

## ブランチ

```bash
git checkout ai/task-013
```

---

## タスクスコープ

**新規プロジェクトを作成できるシンプルなフォーム画面を実装する。**

Expo Router を使用。`/create` ルートに新規ファイルを作成する。

---

## ファイル構成

```
apps/mobile/app/
  index.tsx          ← 既存（変更なし）
  create.tsx         ← 新規作成（Project作成画面）
```

---

## 実装指示

### `apps/mobile/app/create.tsx`（新規作成）

```typescript
/**
 * Project 作成画面
 * POST /api/projects でプロジェクトを作成して Dashboard に戻る
 */

import { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, Alert, ActivityIndicator,
} from 'react-native'
import { router } from 'expo-router'

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

export default function CreateProject() {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [philosophy, setPhilosophy] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleCreate() {
    if (!name.trim() || !goal.trim()) {
      Alert.alert('入力エラー', 'プロジェクト名と Goal は必須です')
      return
    }

    setLoading(true)
    try {
      const designPhilosophy = philosophy
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)

      const res = await fetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), goal: goal.trim(), designPhilosophy }),
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      Alert.alert('作成完了', `${name} を作成しました`, [
        { text: 'OK', onPress: () => router.back() },
      ])
    } catch (e) {
      Alert.alert('エラー', 'プロジェクトの作成に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>新規プロジェクト</Text>

      <Text style={styles.label}>プロジェクト名 *</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="例: EC サイト開発"
        placeholderTextColor="#555"
        maxLength={100}
      />

      <Text style={styles.label}>Goal（目的）*</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={goal}
        onChangeText={setGoal}
        placeholder="このプロジェクトで達成したいことを書いてください"
        placeholderTextColor="#555"
        multiline
        numberOfLines={4}
        maxLength={500}
      />

      <Text style={styles.label}>Design Philosophy（任意）</Text>
      <Text style={styles.hint}>1行に1つ入力してください</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={philosophy}
        onChangeText={setPhilosophy}
        placeholder={'スマホ完結\n全自動優先\nRollback重視'}
        placeholderTextColor="#555"
        multiline
        numberOfLines={4}
      />

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleCreate}
        disabled={loading}
      >
        {loading
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>作成する</Text>
        }
      </TouchableOpacity>

      <TouchableOpacity style={styles.cancelButton} onPress={() => router.back()}>
        <Text style={styles.cancelText}>キャンセル</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  title:          { fontSize: 22, fontWeight: 'bold', color: '#fff', marginTop: 52, marginBottom: 28 },
  label:          { fontSize: 14, color: '#aaa', marginBottom: 6, marginTop: 16 },
  hint:           { fontSize: 12, color: '#555', marginBottom: 6, marginTop: -4 },
  input:          { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 14, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2a2a2a' },
  multiline:      { height: 100, textAlignVertical: 'top' },
  button:         { backgroundColor: '#3b82f6', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 28 },
  buttonDisabled: { opacity: 0.5 },
  buttonText:     { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelButton:   { padding: 14, alignItems: 'center', marginTop: 8 },
  cancelText:     { color: '#666', fontSize: 15 },
})
```

### `apps/mobile/app/index.tsx`（軽微な更新）

Dashboard 画面に「＋ 新規プロジェクト」ボタンを追加する。

```typescript
// import に追加
import { router } from 'expo-router'

// 既存の refreshButton の上に追加:
<TouchableOpacity style={styles.createButton} onPress={() => router.push('/create')}>
  <Text style={styles.createText}>＋ 新規プロジェクト</Text>
</TouchableOpacity>

// styles に追加:
createButton: { backgroundColor: '#3b82f6', borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 12, marginTop: 8 },
createText:   { color: '#fff', fontSize: 15, fontWeight: '600' },
```

---

## 完了チェックリスト

```bash
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/mobile typecheck
```

変更ファイル:
- `apps/mobile/app/create.tsx`（新規）
- `apps/mobile/app/index.tsx`（ボタン追加のみ）

---

## 完了後

```bash
git add apps/mobile/app/create.tsx apps/mobile/app/index.tsx
git commit -m "[codex task-013] feat: Project作成画面を実装"
git push origin ai/task-013
```
