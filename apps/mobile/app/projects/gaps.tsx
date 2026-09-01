/**
 * Interactive Project Definition / Readiness — Gap回答画面
 *
 * 通常のProject開始フローで「重要なGap」（severity: must_resolve）が見つかった場合だけ
 * 遷移してくる画面。曖昧でないGapは自動確定されここには来ない（通常のProject作成体験は
 * 変えない）。回答は自由記述で、空欄のまま送信すればそのGapへの回答は「skip」扱いになる。
 */

import type { ReactElement } from 'react'
import { useCallback, useMemo, useState } from 'react'
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
import type { ProjectDefinitionGap } from '../index'

function parseGapsParam(raw: string | string[] | undefined): ProjectDefinitionGap[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ProjectDefinitionGap[]) : []
  } catch {
    return []
  }
}

function parseTextParam(raw: string | string[] | undefined): string {
  return typeof raw === 'string' ? raw : ''
}

export default function ProjectDefinitionGaps(): ReactElement {
  const params = useLocalSearchParams<{ id: string; gaps: string; readinessReason?: string }>()
  const projectId = params.id
  const [gaps, setGaps] = useState<ProjectDefinitionGap[]>(() => parseGapsParam(params.gaps))
  const [readinessReason, setReadinessReason] = useState(() => parseTextParam(params.readinessReason))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = useMemo(() => typeof projectId === 'string' && projectId.length > 0, [projectId])

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const gapAnswers = Object.fromEntries(
        Object.entries(answers).filter(([, value]) => value.trim().length > 0),
      )
      const response = await apiFetch(`/api/projects/${projectId}`, {
        body: JSON.stringify({ gapAnswers, status: 'running' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      })

      if (response.ok) {
        router.replace({ params: { id: projectId }, pathname: '/projects/[id]' })
        return
      }

      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
          gaps?: ProjectDefinitionGap[]
          readinessReason?: string
        }
        if (body.error === 'Project Definition has unresolved gaps' && Array.isArray(body.gaps)) {
          // まだ重要なGapが残っている（回答が不十分だった等）。同じ画面で続けて聞く。
          setGaps(body.gaps)
          setReadinessReason(body.readinessReason ?? '')
          setAnswers({})
          Alert.alert('まだ確認が必要です', 'いくつかの項目についてもう少し詳しく教えてください。')
          return
        }
        Alert.alert('開始できません', body.error ?? 'このProjectを開始できませんでした')
        return
      }

      Alert.alert('開始できません', `開始に失敗しました（HTTP ${response.status}）`)
    } catch {
      Alert.alert('開始できません', 'APIに接続できませんでした')
    } finally {
      setSubmitting(false)
    }
  }, [answers, canSubmit, projectId])

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>開始する前にいくつか教えてください</Text>
      <Text style={styles.intro}>
        Goal / Design Philosophyの内容から、開発を始める前に確認しておきたい点が見つかりました。
        分かる範囲で回答してください。空欄のまま送信すると、その項目はスキップされます。
      </Text>

      {readinessReason.length > 0 && (
        <View style={styles.readinessBox}>
          <Text style={styles.readinessText}>{readinessReason}</Text>
        </View>
      )}

      {gaps.map((gap) => (
        <View key={gap.description} style={styles.gapCard}>
          <Text style={styles.gapCategory}>{gap.category}</Text>
          <Text style={styles.gapDescription}>{gap.description}</Text>
          {gap.suggestion.length > 0 && <Text style={styles.gapSuggestion}>ヒント: {gap.suggestion}</Text>}
          <TextInput
            multiline
            numberOfLines={3}
            onChangeText={(text) => setAnswers((prev) => ({ ...prev, [gap.description]: text }))}
            placeholder="回答（空欄でスキップ）"
            placeholderTextColor="#555"
            style={[styles.input, styles.multiline]}
            value={answers[gap.description] ?? ''}
          />
        </View>
      ))}

      <TouchableOpacity
        disabled={submitting || !canSubmit}
        onPress={() => void handleSubmit()}
        style={[styles.button, (submitting || !canSubmit) && styles.buttonDisabled]}
      >
        {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>回答して開始する</Text>}
      </TouchableOpacity>

      <TouchableOpacity onPress={() => router.back()} style={styles.cancelButton}>
        <Text style={styles.cancelText}>あとで（開始しない）</Text>
      </TouchableOpacity>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  bottomSpacer: { height: 40 },
  button: {
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    marginTop: 24,
    padding: 16,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelButton: { alignItems: 'center', marginTop: 8, padding: 14 },
  cancelText: { color: '#666', fontSize: 15 },
  container: { backgroundColor: '#0a0a0a', flex: 1, padding: 16 },
  gapCard: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 14,
    padding: 14,
  },
  gapCategory: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  gapDescription: { color: '#fff', fontSize: 15, marginBottom: 6 },
  gapSuggestion: { color: '#888', fontSize: 12, marginBottom: 10 },
  input: {
    backgroundColor: '#1a1a1a',
    borderColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    color: '#fff',
    fontSize: 15,
    padding: 12,
  },
  intro: { color: '#aaa', fontSize: 14, lineHeight: 20, marginBottom: 24 },
  multiline: { height: 80, textAlignVertical: 'top' },
  readinessBox: {
    backgroundColor: '#171717',
    borderColor: '#3b82f655',
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 14,
    padding: 12,
  },
  readinessText: { color: '#d4d4d4', fontSize: 13, lineHeight: 18 },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
    marginTop: 52,
  },
})
