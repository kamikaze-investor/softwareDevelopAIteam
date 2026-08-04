/**
 * Task 作成画面
 * POST /api/tasks で既存Projectへ自然文の開発指示を追加する
 */

import type { ReactElement } from 'react'
import { useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { apiFetch } from '../../lib/api'

function normalizeProjectId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return value ?? null
}

export default function CreateTask(): ReactElement {
  const params = useLocalSearchParams()
  const projectId = normalizeProjectId(params.projectId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleCreate(): Promise<void> {
    if (projectId === null || projectId.length === 0) {
      Alert.alert('エラー', 'Projectが指定されていません')
      return
    }
    if (!title.trim() || !description.trim()) {
      Alert.alert('入力エラー', 'タイトルと開発指示は必須です')
      return
    }

    setLoading(true)

    try {
      const response = await apiFetch('/api/tasks', {
        body: JSON.stringify({
          assignee: 'developer_ai',
          description: description.trim(),
          projectId,
          title: title.trim(),
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const task = (await response.json()) as { id: string }

      Alert.alert('作成完了', 'Taskを作成しました', [
        {
          onPress: () => router.replace(`/tasks/${task.id}`),
          text: 'OK',
        },
      ])
    } catch {
      Alert.alert('エラー', 'Taskの作成に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={() => router.back()} style={styles.back}>
        <Text style={styles.backText}>← 戻る</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Taskを追加</Text>

      <Text style={styles.label}>タイトル *</Text>
      <TextInput
        maxLength={200}
        onChangeText={setTitle}
        placeholder="例: ログイン画面のバリデーション修正"
        placeholderTextColor="#555"
        style={styles.input}
        value={title}
      />

      <Text style={styles.label}>開発指示（自然文）*</Text>
      <TextInput
        maxLength={4000}
        multiline
        numberOfLines={8}
        onChangeText={setDescription}
        placeholder="AIに実装してほしい内容を自然文で入力してください"
        placeholderTextColor="#555"
        style={[styles.input, styles.textArea]}
        textAlignVertical="top"
        value={description}
      />

      <TouchableOpacity
        disabled={loading}
        onPress={() => void handleCreate()}
        style={[styles.submitButton, loading && styles.submitButtonDisabled]}
      >
        {loading && <ActivityIndicator color="#fff" size="small" />}
        <Text style={styles.submitButtonText}>Taskを作成</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  back: {
    marginBottom: 12,
    marginTop: 52,
  },
  backText: {
    color: '#3b82f6',
    fontSize: 15,
  },
  container: {
    backgroundColor: '#0a0a0a',
    flex: 1,
    padding: 16,
  },
  input: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    color: '#fff',
    fontSize: 15,
    marginBottom: 20,
    padding: 12,
  },
  label: {
    color: '#a3a3a3',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginBottom: 40,
    padding: 14,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  textArea: {
    minHeight: 140,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 20,
  },
})
