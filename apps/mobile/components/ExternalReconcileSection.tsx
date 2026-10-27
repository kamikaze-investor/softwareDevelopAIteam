/**
 * Task 画面の「外部成果を承認して完了登録」（1 画面の external completion reconcile）。
 *
 * 判定と API 呼び出しはすべて `lib/externalReconcile.ts` にあり、ここは表示と確認ダイアログだけを持つ。
 * 承認は承認一覧と同じ human-only PATCH、実行可否の正本は API である。
 */

import type { ApprovalRequest, TaskDetail } from '@ai-team/shared'
import type { ReactElement } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'

import { apiFetch } from '../lib/api'
import {
  RECONCILE_BUTTON_LABEL,
  RECONCILE_CONFIRM_TITLE,
  RECONCILE_PROGRESS_TEXT,
  RECONCILE_SOURCE_LABEL,
  approveReconcileApprovalRequest,
  canShowReconcileUI,
  createOneScreenReconcileRunner,
  createReconcileApprovalRequest,
  fetchReconcilePreview,
  parseReconcilePackage,
  prepareReconcileConfirmation,
  reconcileEvidenceLines,
  submitReconcile,
} from '../lib/externalReconcile'
import type {
  ReconcileConfirmation,
  ReconcileFreshState,
  ReconcilePackage,
  ReconcilePreview,
  ReconcileStage,
} from '../lib/externalReconcile'

const HELP_TEXT =
  'AI開発チームの外（Tier B）で実装・レビュー・本番反映まで終わった成果を、このTaskの完了として登録します。'
  + 'AI から受け取った「取り込みパッケージ」を貼り付けて「内容を確認」を押してください。'
  + 'API が commit・本番反映・変更ファイルを確かめた結果と、AI の申告のままの項目を分けて表示します。'

/** 実行直前に Task と承認依頼を読み直す（画面の古い表示で再利用を判断しない）。 */
async function loadFreshState(taskId: string): Promise<ReconcileFreshState | null> {
  try {
    const [taskResponse, requestsResponse] = await Promise.all([
      apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`),
      apiFetch(`/api/approval-requests?taskId=${encodeURIComponent(taskId)}`),
    ])
    if (!taskResponse.ok || !requestsResponse.ok) return null
    const task = (await taskResponse.json()) as TaskDetail
    const approvalRequests = (await requestsResponse.json()) as ApprovalRequest[]
    return { approvalRequests, humanTaskDecisions: task.humanTaskDecisions, taskStatus: task.status }
  } catch {
    return null
  }
}

interface Props {
  task: TaskDetail
  /** 実行後に Task 画面を読み直す */
  onFinished: () => Promise<void>
}

export function ExternalReconcileSection({ task, onFinished }: Props): ReactElement | null {
  const [packageText, setPackageText] = useState('')
  const [confirmed, setConfirmed] = useState<{ pkg: ReconcilePackage; preview: ReconcilePreview } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [progress, setProgress] = useState<ReconcileStage | null>(null)

  const runner = useMemo(() => createOneScreenReconcileRunner({
    approveRequest: approveReconcileApprovalRequest,
    createRequest: createReconcileApprovalRequest,
    execute: submitReconcile,
    loadState: loadFreshState,
    onProgress: setProgress,
  }), [])

  const handleCheck = useCallback(async (): Promise<void> => {
    setConfirmed(null)
    setMessage(null)
    const parsed = parseReconcilePackage(packageText, task.id)
    if (!parsed.ok) {
      setMessage(parsed.message)
      return
    }
    setIsChecking(true)
    try {
      const result = await fetchReconcilePreview(parsed.value)
      if (!result.ok) {
        setMessage(result.message)
        return
      }
      setConfirmed({ pkg: parsed.value, preview: result.preview })
    } finally {
      setIsChecking(false)
    }
  }, [packageText, task.id])

  const submit = useCallback(async (confirmation: ReconcileConfirmation): Promise<void> => {
    setIsSubmitting(true)
    try {
      const result = await runner.run(confirmation)
      if (result === null) return
      setMessage(result.message)
      Alert.alert(result.ok ? '完了登録' : '完了登録できませんでした', result.message)
      if (result.ok) {
        setPackageText('')
        setConfirmed(null)
      }
    } finally {
      setProgress(null)
      await onFinished()
      setIsSubmitting(false)
    }
  }, [onFinished, runner])

  // 押した時点で preview と Task を読み直し、その結果から確認ダイアログを作る（古い表示のまま承認させない）。
  const handlePress = useCallback(async (): Promise<void> => {
    if (confirmed === null || isSubmitting || isChecking || runner.isRunning()) return
    setIsChecking(true)
    let prepared: Awaited<ReturnType<typeof prepareReconcileConfirmation>>
    try {
      prepared = await prepareReconcileConfirmation(confirmed.pkg, confirmed.preview, {
        loadState: loadFreshState,
        preview: fetchReconcilePreview,
      })
    } finally {
      setIsChecking(false)
    }
    if (prepared.kind === 'changed') {
      setConfirmed({ pkg: confirmed.pkg, preview: prepared.preview })
      setMessage(prepared.message)
      return
    }
    if (prepared.kind !== 'confirm') {
      setMessage(prepared.message)
      if (prepared.kind === 'already_done') await onFinished()
      return
    }
    const { confirmation } = prepared
    Alert.alert(RECONCILE_CONFIRM_TITLE, confirmation.message, [
      { style: 'cancel', text: 'キャンセル' },
      { onPress: () => { void submit(confirmation) }, style: 'destructive', text: '承認して完了登録' },
    ])
  }, [confirmed, isChecking, isSubmitting, onFinished, runner, submit])

  if (!canShowReconcileUI(task)) return null
  const lines = confirmed === null ? [] : reconcileEvidenceLines(confirmed.pkg, confirmed.preview)
  const canSubmit = confirmed !== null && confirmed.preview.eligible && !isSubmitting && !isChecking

  return (
    <View style={styles.section}>
      <Text style={styles.title}>外部成果の完了登録</Text>
      <View style={styles.box}>
        <Text style={styles.help}>{HELP_TEXT}</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          multiline
          onChangeText={(text) => { setPackageText(text); setConfirmed(null) }}
          placeholder="取り込みパッケージ（JSON）を貼り付け"
          placeholderTextColor="#737373"
          style={styles.input}
          textAlignVertical="top"
          value={packageText}
        />
        <TouchableOpacity
          disabled={isChecking || isSubmitting || packageText.trim() === ''}
          onPress={() => { void handleCheck() }}
          style={[styles.secondaryButton, (isChecking || isSubmitting || packageText.trim() === '') && styles.disabled]}
        >
          {isChecking && <ActivityIndicator color="#fff" size="small" />}
          <Text style={styles.buttonText}>内容を確認</Text>
        </TouchableOpacity>

        {lines.map((line, index) => (
          <View key={`${line.label}-${index}`} style={styles.line}>
            <Text style={styles.lineLabel}>
              {line.label}
              <Text style={line.source === 'verified' ? styles.verified : line.source === 'claimed' ? styles.claimed : styles.problem}>
                {`  ${RECONCILE_SOURCE_LABEL[line.source]}`}
              </Text>
            </Text>
            <Text selectable style={styles.lineValue}>{line.value}</Text>
          </View>
        ))}

        {confirmed !== null && (
          <TouchableOpacity
            disabled={!canSubmit}
            onPress={() => { void handlePress() }}
            style={[styles.primaryButton, !canSubmit && styles.disabled]}
          >
            {isSubmitting && <ActivityIndicator color="#fff" size="small" />}
            <Text style={styles.buttonText}>{RECONCILE_BUTTON_LABEL}</Text>
          </TouchableOpacity>
        )}
        {confirmed !== null && !confirmed.preview.eligible && (
          <Text style={[styles.help, styles.problem]}>上の「未確認・不備」を解消するまで完了登録はできません。</Text>
        )}
        {progress !== null && <Text style={styles.help}>{RECONCILE_PROGRESS_TEXT[progress]}</Text>}
        {message !== null && <Text style={styles.help}>{message}</Text>}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { backgroundColor: '#141414', borderColor: '#2a2a2a', borderRadius: 8, borderWidth: 1, padding: 14 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  claimed: { color: '#fbbf24', fontWeight: '400' },
  disabled: { opacity: 0.5 },
  help: { color: '#d4d4d4', fontSize: 13, lineHeight: 19, marginBottom: 10 },
  input: {
    backgroundColor: '#0f0f0f', borderColor: '#333', borderRadius: 8, borderWidth: 1, color: '#fff',
    fontSize: 13, lineHeight: 18, marginBottom: 10, minHeight: 100, padding: 10,
  },
  line: { borderTopColor: '#2a2a2a', borderTopWidth: 1, paddingVertical: 8 },
  lineLabel: { color: '#a3a3a3', fontSize: 12, fontWeight: '700', marginBottom: 2 },
  lineValue: { color: '#fff', fontSize: 13, lineHeight: 19 },
  primaryButton: {
    alignItems: 'center', backgroundColor: '#16a34a', borderRadius: 8, flexDirection: 'row', gap: 8,
    justifyContent: 'center', marginBottom: 10, marginTop: 6, minHeight: 44, paddingHorizontal: 14,
  },
  problem: { color: '#f87171', fontWeight: '400' },
  secondaryButton: {
    alignItems: 'center', backgroundColor: '#2563eb', borderRadius: 8, flexDirection: 'row', gap: 8,
    justifyContent: 'center', marginBottom: 10, minHeight: 44, paddingHorizontal: 14,
  },
  section: { marginBottom: 20 },
  title: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  verified: { color: '#4ade80', fontWeight: '400' },
})
