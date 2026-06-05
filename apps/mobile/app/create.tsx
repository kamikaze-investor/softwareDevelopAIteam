/**
 * Project 作成画面
 * POST /api/projects でプロジェクトを作成して Dashboard に戻る
 */

import type { ReactElement } from 'react'
import { useState } from 'react'
import { router } from 'expo-router'
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

declare const process: {
  env: {
    EXPO_PUBLIC_API_URL?: string
  }
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

export default function CreateProject(): ReactElement {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [philosophy, setPhilosophy] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleCreate(): Promise<void> {
    if (!name.trim() || !goal.trim()) {
      Alert.alert('入力エラー', 'プロジェクト名と Goal は必須です')
      return
    }

    setLoading(true)

    try {
      const designPhilosophy = philosophy
        .split('\n')
        .map((line: string): string => line.trim())
        .filter((line: string): boolean => line.length > 0)

      const response = await fetch(`${API_BASE}/api/projects`, {
        body: JSON.stringify({
          designPhilosophy,
          goal: goal.trim(),
          name: name.trim(),
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      Alert.alert('作成完了', `${name.trim()} を作成しました`, [
        { onPress: () => router.back(), text: 'OK' },
      ])
    } catch {
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
        maxLength={100}
        onChangeText={setName}
        placeholder="例: EC サイト開発"
        placeholderTextColor="#555"
        style={styles.input}
        value={name}
      />

      <Text style={styles.label}>Goal（目的）*</Text>
      <TextInput
        maxLength={500}
        multiline
        numberOfLines={4}
        onChangeText={setGoal}
        placeholder="このプロジェクトで達成したいことを書いてください"
        placeholderTextColor="#555"
        style={[styles.input, styles.multiline]}
        value={goal}
      />

      <Text style={styles.label}>Design Philosophy（任意）</Text>
      <Text style={styles.hint}>1行に1つ入力してください</Text>
      <TextInput
        multiline
        numberOfLines={4}
        onChangeText={setPhilosophy}
        placeholder={'スマホ完結\n全自動優先\nRollback重視'}
        placeholderTextColor="#555"
        style={[styles.input, styles.multiline]}
        value={philosophy}
      />

      <TouchableOpacity
        disabled={loading}
        onPress={handleCreate}
        style={[styles.button, loading && styles.buttonDisabled]}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>作成する</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => router.back()}
        style={styles.cancelButton}
      >
        <Text style={styles.cancelText}>キャンセル</Text>
      </TouchableOpacity>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  bottomSpacer: {
    height: 40,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    marginTop: 28,
    padding: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    alignItems: 'center',
    marginTop: 8,
    padding: 14,
  },
  cancelText: {
    color: '#666',
    fontSize: 15,
  },
  container: {
    backgroundColor: '#0a0a0a',
    flex: 1,
    padding: 16,
  },
  hint: {
    color: '#555',
    fontSize: 12,
    marginBottom: 6,
    marginTop: -4,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    color: '#fff',
    fontSize: 15,
    padding: 14,
  },
  label: {
    color: '#aaa',
    fontSize: 14,
    marginBottom: 6,
    marginTop: 16,
  },
  multiline: {
    height: 100,
    textAlignVertical: 'top',
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 28,
    marginTop: 52,
  },
})
