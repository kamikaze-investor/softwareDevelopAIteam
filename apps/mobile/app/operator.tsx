/**
 * Operator Chat — PL への質問・依頼と、その結果の確認（`operator-chat-mobile` の MVP）。
 *
 * 共通 Operator Interface（`/api/operator/state`・`/api/operator-requests`）だけを使う。
 * この画面から resume・approval 等の操作 API は呼ばない。依頼を受けて実際に何をするかは、
 * PL が既存の Gate を通して決める（`../lib/operatorChat.ts` を参照）。
 */

import type { ReactElement } from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { OperatorRequest, OperatorRequestKind } from '@ai-team/shared'
import { OPERATOR_REQUEST_MESSAGE_MAX_LENGTH } from '@ai-team/shared'
import { useFocusEffect } from 'expo-router'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

import { apiFetch } from '../lib/api'
import {
  attentionItemKey,
  attentionKindLabel,
  buildOperatorRequestBody,
  createOperatorChatClient,
  hasPendingRequest,
  OperatorChatHttpError,
  plActionLines,
  requesterLabel,
  requestKindLabel,
  requestStatusLabel,
  sendErrorMessage,
  targetFromAttention,
} from '../lib/operatorChat'
import type { OperatorAttentionItem, OperatorStateView } from '../lib/operatorChat'
import { POLLING_INTERVAL_MS, usePolling } from '../lib/usePolling'

const KIND_OPTIONS: ReadonlyArray<{ kind: OperatorRequestKind; label: string; hint: string }> = [
  { kind: 'question', label: '質問', hint: 'PL が状況を調べて答えます（操作はしません）' },
  { kind: 'request', label: '依頼', hint: 'PL が既存の Gate を通して、実行するかを判断します' },
]

function formatStuckFor(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}時間` : `${Math.floor(hours / 24)}日`
}

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ja-JP')
}

function StateCard({ state }: { state: OperatorStateView | null }): ReactElement {
  const cells: Array<{ label: string; value: number | undefined; alert: boolean }> = [
    { label: '実行中', value: state?.running, alert: false },
    { label: '要対応', value: state?.attention.length, alert: (state?.attention.length ?? 0) > 0 },
    { label: '承認待ち', value: state?.approvalsWaiting, alert: (state?.approvalsWaiting ?? 0) > 0 },
    { label: 'blocked', value: state?.blocked, alert: (state?.blocked ?? 0) > 0 },
  ]
  return (
    <View style={styles.stateRow}>
      {cells.map((cell) => (
        <View key={cell.label} style={styles.stateCell}>
          <Text style={[styles.stateValue, cell.alert && styles.stateValueAlert]}>
            {cell.value === undefined ? '—' : cell.value}
          </Text>
          <Text style={styles.stateLabel}>{cell.label}</Text>
        </View>
      ))}
    </View>
  )
}

function AttentionRow({
  item,
  selected,
  onPress,
}: {
  item: OperatorAttentionItem
  selected: boolean
  onPress: () => void
}): ReactElement {
  const stuckFor = formatStuckFor(item.stuckForMs)
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.attentionRow, selected && styles.attentionRowSelected]}
    >
      <Text style={styles.attentionKind}>
        {attentionKindLabel(item.kind)}
        {stuckFor !== undefined ? `（${stuckFor}）` : ''}
      </Text>
      <Text style={styles.attentionProject}>{item.projectName ?? item.projectId}</Text>
      {item.detail !== undefined ? (
        <Text numberOfLines={3} style={styles.attentionDetail}>
          {item.detail}
        </Text>
      ) : null}
      {selected ? <Text style={styles.attentionSelectedMark}>✓ この項目を対象にする</Text> : null}
    </TouchableOpacity>
  )
}

function RequestCard({ request }: { request: OperatorRequest }): ReactElement {
  return (
    <View style={styles.requestCard}>
      <View style={styles.requestHeader}>
        <Text style={styles.requestKind}>
          {requestKindLabel(request.kind)} · {requesterLabel(request.requesterClass)}
        </Text>
        <Text
          style={[
            styles.requestStatus,
            request.status === 'pending' && styles.requestStatusPending,
            request.status === 'failed' && styles.requestStatusFailed,
          ]}
        >
          {requestStatusLabel(request)}
        </Text>
      </View>
      <Text style={styles.requestTime}>{formatTime(request.createdAt)}</Text>
      <Text selectable style={styles.requestMessage}>
        {request.message}
      </Text>
      {request.response !== undefined ? (
        <View style={styles.responseBox}>
          <Text style={styles.responseLabel}>PL の回答</Text>
          <Text selectable style={styles.responseText}>
            {request.response}
          </Text>
        </View>
      ) : null}
      {request.plAction !== undefined ? (
        <View style={styles.plActionBox}>
          <Text style={styles.responseLabel}>実行の記録（plAction）</Text>
          {plActionLines(request.plAction).map((line) => (
            <Text key={line} selectable style={styles.plActionLine}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {request.status === 'failed' && request.error !== undefined ? (
        <Text style={styles.requestError}>{request.error}</Text>
      ) : null}
    </View>
  )
}

export default function OperatorChatScreen(): ReactElement {
  const client = useMemo(() => createOperatorChatClient(apiFetch), [])

  const [state, setState] = useState<OperatorStateView | null>(null)
  const [requests, setRequests] = useState<OperatorRequest[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [kind, setKind] = useState<OperatorRequestKind | null>(null)
  const [message, setMessage] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [stateResult, requestsResult] = await Promise.allSettled([client.getState(), client.listRecent()])
    if (stateResult.status === 'fulfilled') setState(stateResult.value)
    if (requestsResult.status === 'fulfilled') setRequests(requestsResult.value)
    const failed = [stateResult, requestsResult].find((result) => result.status === 'rejected')
    if (failed === undefined) {
      setLoadError(null)
    } else {
      const reason = (failed as PromiseRejectedResult).reason
      setLoadError(
        reason instanceof OperatorChatHttpError
          ? `読み込みに失敗しました（HTTP ${reason.status}）`
          : '読み込みに失敗しました（通信エラー）',
      )
    }
  }, [client])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  // PL の回答待ちがある間だけ更新する。
  usePolling(load, { intervalMs: POLLING_INTERVAL_MS, enabled: hasPendingRequest(requests) })

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const attention = state?.attention ?? []
  // 選んだ項目が次の読み込みで解消されていたら、対象なしに戻す（古い対象を送らない）。
  const selectedItem = attention.find((item) => attentionItemKey(item) === selectedKey)
  const draft = buildOperatorRequestBody({
    kind,
    message,
    target: selectedItem !== undefined ? targetFromAttention(selectedItem) : null,
  })

  const send = useCallback(async (): Promise<void> => {
    if (!draft.ok || sending) return
    setSending(true)
    setSendError(null)
    try {
      const created = await client.create(draft.body)
      setRequests((current) => [created, ...current.filter((item) => item.id !== created.id)])
      // 次の送信でも種別を明示的に選ばせる（既定値を置かない）。
      setKind(null)
      setMessage('')
      setSelectedKey(null)
    } catch (error) {
      setSendError(
        error instanceof OperatorChatHttpError ? sendErrorMessage(error.status) : '送信に失敗しました（通信エラー）',
      )
    } finally {
      setSending(false)
    }
  }, [client, draft, sending])

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <Text style={styles.title}>PL に質問・依頼</Text>
        {loadError !== null ? <Text style={styles.errorText}>{loadError}</Text> : null}

        <Text style={styles.sectionLabel}>1. 現在の状態</Text>
        <StateCard state={state} />

        <Text style={styles.sectionLabel}>2. 要対応（押すと対象に指定）</Text>
        {attention.length === 0 ? (
          <Text style={styles.emptyText}>{state === null ? '読み込み中…' : '要対応の項目はありません'}</Text>
        ) : (
          attention.map((item) => {
            const key = attentionItemKey(item)
            const selected = key === selectedKey
            return (
              <AttentionRow
                key={key}
                item={item}
                onPress={() => setSelectedKey(selected ? null : key)}
                selected={selected}
              />
            )
          })
        )}
        <Text style={styles.targetText}>
          対象: {selectedItem !== undefined
            ? `${attentionKindLabel(selectedItem.kind)} / ${selectedItem.projectName ?? selectedItem.projectId}`
            : 'なし（全体について）'}
        </Text>

        <Text style={styles.sectionLabel}>3. 種別</Text>
        <View style={styles.kindRow}>
          {KIND_OPTIONS.map((option) => {
            const selected = kind === option.kind
            return (
              <TouchableOpacity
                key={option.kind}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => setKind(option.kind)}
                style={[styles.kindButton, selected && styles.kindButtonSelected]}
              >
                <Text style={[styles.kindButtonText, selected && styles.kindButtonTextSelected]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
        <Text style={styles.hintText}>
          {kind === null ? '「質問」か「依頼」を選んでください' : KIND_OPTIONS.find((o) => o.kind === kind)?.hint}
        </Text>

        <Text style={styles.sectionLabel}>4. 内容</Text>
        <TextInput
          multiline
          onChangeText={setMessage}
          placeholder="例: なぜ止まっている？ / 安全なら再開して"
          placeholderTextColor="#555"
          style={styles.messageInput}
          value={message}
        />
        <Text
          style={[
            styles.counterText,
            message.trim().length > OPERATOR_REQUEST_MESSAGE_MAX_LENGTH && styles.counterTextOver,
          ]}
        >
          {message.trim().length} / {OPERATOR_REQUEST_MESSAGE_MAX_LENGTH}
        </Text>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: !draft.ok || sending }}
          disabled={!draft.ok || sending}
          onPress={() => void send()}
          style={[styles.sendButton, (!draft.ok || sending) && styles.sendButtonDisabled]}
        >
          {sending ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendButtonText}>5. 送信</Text>}
        </TouchableOpacity>
        {!draft.ok && (kind !== null || message !== '') ? <Text style={styles.hintText}>{draft.error}</Text> : null}
        {sendError !== null ? <Text style={styles.errorText}>{sendError}</Text> : null}

        <Text style={styles.sectionLabel}>6. 最近の依頼と結果</Text>
        {requests.length === 0 ? (
          <Text style={styles.emptyText}>まだ依頼はありません</Text>
        ) : (
          requests.map((request) => <RequestCard key={request.id} request={request} />)
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  attentionDetail: { color: '#a3a3a3', fontSize: 12, marginTop: 4 },
  attentionKind: { color: '#fbbf24', fontSize: 13, fontWeight: '700' },
  attentionProject: { color: '#d4d4d4', fontSize: 13, marginTop: 2 },
  attentionRow: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
    padding: 12,
  },
  attentionRowSelected: { borderColor: '#3b82f6' },
  attentionSelectedMark: { color: '#60a5fa', fontSize: 12, fontWeight: '600', marginTop: 6 },
  container: { backgroundColor: '#0a0a0a', flex: 1 },
  content: { padding: 16, paddingBottom: 48 },
  counterText: { color: '#737373', fontSize: 12, marginTop: 4, textAlign: 'right' },
  counterTextOver: { color: '#f87171' },
  emptyText: { color: '#737373', fontSize: 13, marginBottom: 8 },
  errorText: { color: '#f87171', fontSize: 13, marginTop: 8 },
  hintText: { color: '#8a8a8a', fontSize: 12, marginTop: 6 },
  kindButton: {
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 14,
  },
  kindButtonSelected: { backgroundColor: '#1e3a8a', borderColor: '#3b82f6' },
  kindButtonText: { color: '#d4d4d4', fontSize: 16, fontWeight: '600' },
  kindButtonTextSelected: { color: '#fff' },
  kindRow: { flexDirection: 'row', gap: 8 },
  messageInput: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    color: '#fff',
    fontSize: 15,
    minHeight: 110,
    padding: 12,
    textAlignVertical: 'top',
  },
  plActionBox: { borderTopColor: '#2a2a2a', borderTopWidth: 1, marginTop: 8, paddingTop: 8 },
  plActionLine: { color: '#a3a3a3', fontSize: 12, marginTop: 2 },
  requestCard: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
  },
  requestError: { color: '#f87171', fontSize: 12, marginTop: 6 },
  requestHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  requestKind: { color: '#d4d4d4', fontSize: 13, fontWeight: '700' },
  requestMessage: { color: '#e5e5e5', fontSize: 14, marginTop: 6 },
  requestStatus: { color: '#4ade80', fontSize: 13, fontWeight: '700' },
  requestStatusFailed: { color: '#f87171' },
  requestStatusPending: { color: '#fbbf24' },
  requestTime: { color: '#737373', fontSize: 11, marginTop: 2 },
  responseBox: { borderTopColor: '#2a2a2a', borderTopWidth: 1, marginTop: 8, paddingTop: 8 },
  responseLabel: { color: '#737373', fontSize: 11, fontWeight: '700', marginBottom: 4 },
  responseText: { color: '#fff', fontSize: 14, lineHeight: 20 },
  sectionLabel: { color: '#737373', fontSize: 12, fontWeight: '700', marginBottom: 8, marginTop: 20 },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 8,
    marginTop: 12,
    padding: 16,
  },
  sendButtonDisabled: { backgroundColor: '#1e293b' },
  sendButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  stateCell: {
    alignItems: 'center',
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 10,
  },
  stateLabel: { color: '#8a8a8a', fontSize: 11, marginTop: 2 },
  stateRow: { flexDirection: 'row', gap: 6 },
  stateValue: { color: '#fff', fontSize: 20, fontWeight: '700' },
  stateValueAlert: { color: '#fbbf24' },
  targetText: { color: '#60a5fa', fontSize: 13, marginTop: 4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 52 },
})
