/**
 * Pending approval list for CEO decisions.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type {
  ApprovalExplanationResponse,
  ApprovalGateStatus,
  ApprovalQuestionResponse,
  ApprovalQuestionTurn,
  ApprovalRequest,
  ApprovalType,
  RiskLevel,
  Task,
} from '@ai-team/shared'
import { router } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  Modal,
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
  fetchPendingApprovals,
  fetchWaitingApprovalRequests,
  getApprovalsCache,
  setCachedApprovalRequests,
  setCachedApprovals,
} from '../lib/approvalsCache'
import type { ApprovalWithProject } from '../lib/approvalsCache'
import { POLLING_INTERVAL_MS, usePolling } from '../lib/usePolling'

type DecisionStatus = 'approved' | 'rejected'
type ApprovalGateDecisionStatus = Extract<
  ApprovalGateStatus,
  'APPROVED' | 'REJECTED'
>

type RejectTarget =
  | { type: 'policy'; item: ApprovalWithProject }
  | { type: 'gate'; item: ApprovalRequest }

interface ExplanationLoadState {
  loading: boolean
  result?: ApprovalExplanationResponse
}

const TYPE_LABEL: Record<ApprovalType, string> = {
  billing: '課金',
  dependency_add: '依存追加',
  deployment: '本番公開',
  external_service: '外部サービス追加',
  goal_change: 'Goal変更',
  philosophy_change: '設計思想変更',
  security: 'セキュリティ変更',
}

const RISK_BADGE_STYLE: Record<
  RiskLevel,
  { backgroundColor: string; borderColor: string }
> = {
  CRITICAL: { backgroundColor: '#ef444422', borderColor: '#ef444466' },
  HIGH: { backgroundColor: '#f9731622', borderColor: '#f9731666' },
  LOW: { backgroundColor: '#22c55e22', borderColor: '#22c55e44' },
  MEDIUM: { backgroundColor: '#f59e0b22', borderColor: '#f59e0b55' },
}

const RISK_TEXT_STYLE: Record<RiskLevel, { color: string }> = {
  CRITICAL: { color: '#ef4444' },
  HIGH: { color: '#fb923c' },
  LOW: { color: '#22c55e' },
  MEDIUM: { color: '#f59e0b' },
}

async function fetchApprovalExplanation(
  requestId: string,
): Promise<ApprovalExplanationResponse> {
  try {
    const response = await apiFetch(
      `/api/approval-requests/${requestId}/explanation`,
      { method: 'POST' },
    )
    if (!response.ok) {
      throw new Error(`Failed to fetch approval explanation: ${response.status}`)
    }
    return (await response.json()) as ApprovalExplanationResponse
  } catch {
    return {
      ok: false,
      error: 'AIによる説明を生成できませんでした',
      diffStatus: 'unavailable',
    }
  }
}

async function askApprovalQuestion(
  requestId: string,
  question: string,
  history: ApprovalQuestionTurn[],
): Promise<ApprovalQuestionResponse> {
  try {
    const response = await apiFetch(`/api/approval-requests/${requestId}/ask`, {
      body: JSON.stringify({ history: history.slice(-20), question }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (!response.ok) {
      throw new Error(`Failed to ask approval question: ${response.status}`)
    }
    return (await response.json()) as ApprovalQuestionResponse
  } catch {
    return {
      ok: false,
      error: 'AIから回答を取得できませんでした',
      diffStatus: 'unavailable',
    }
  }
}

/** タップして詳細を開いた時だけ呼ぶ。404/失敗時はnullを返し、UI側で目的説明を省略する */
async function fetchTaskInfo(taskId: string): Promise<Task | null> {
  try {
    const response = await apiFetch(`/api/tasks/${taskId}`)
    if (!response.ok) {
      return null
    }
    return (await response.json()) as Task
  } catch {
    return null
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function formatRiskLevel(riskLevel: string): string {
  switch (riskLevel) {
    case 'CRITICAL':
      return '危険度: 最重要'
    case 'HIGH':
      return '危険度: 高'
    case 'MEDIUM':
      return '危険度: 中'
    case 'LOW':
      return '危険度: 低'
    default:
      return `危険度: ${riskLevel}`
  }
}

function formatApprovalGateStatus(status: string): string {
  switch (status) {
    case 'WAITING_FOR_USER':
      return 'ステータス: CEOの承認待ち'
    case 'APPROVED':
      return 'ステータス: 承認済み'
    case 'REJECTED':
      return 'ステータス: 却下済み'
    case 'CONSUMED':
      return 'ステータス: 反映済み'
    case 'EXPIRED':
      return 'ステータス: 期限切れ'
    default:
      return `ステータス: ${status}`
  }
}

/** 代表的なrequestedActionをCEO向けの平易な説明に変換する。未知の文言はfallbackする */
const REQUESTED_ACTION_LABEL: Record<string, string> = {
  'merge feature branch': '作業中の変更を本体に取り込もうとしています',
}

function formatRequestedActionSummary(requestedAction: string): string {
  return (
    REQUESTED_ACTION_LABEL[requestedAction] ??
    '技術的な操作内容のため、詳細確認が必要です'
  )
}

const UNKNOWN_REQUESTED_ACTION_NOTE =
  '内容が分からない場合は承認せず、ChatGPT/Claudeに説明を依頼してください。'

function formatJudgmentGuide(riskLevel: string): string {
  switch (riskLevel) {
    case 'CRITICAL':
      return '最重要リスクです。内容に確信がない場合は承認しないでください。'
    case 'HIGH':
      return '高リスク操作です。問題ないと分かる場合だけ承認してください。'
    default:
      return 'この操作を進めてよいか分からない場合は、承認せずに詳細確認してください。'
  }
}

/** ApprovalRequest.triggeredRules（保存値）→ CEO向け日本語説明 */
const TRIGGERED_RULE_LABEL: Record<string, string> = {
  'AI instruction file': 'AIの行動ルールを定めるファイルの変更です',
  'CI/CD workflow change': '自動テスト・自動デプロイの仕組みに関わります',
  'DB migration / schema': 'データベース構造の変更に関わります',
  'alignment / gate change': '安全チェックの仕組み自体に関わります',
  'auth / permission guard': '認証・権限まわりの変更に関わります',
  'destructive operation': 'データを削除・破棄する可能性があります',
  'docker / sandbox config': '実行環境の設定に関わります',
  'other risk factor detected': 'その他のリスク要因が検出されました',
  'payment / billing': '課金・支払いに関わる変更です',
  'secret suspected in diff': '秘密情報が含まれている可能性がある変更です',
  'secrets / env / token': '秘密情報（APIキー等）の扱いに関わります',
}

const UNKNOWN_TRIGGERED_RULE_LABEL = '未分類のリスク要因が検出されました'

function formatTriggeredRule(rule: string): string {
  return TRIGGERED_RULE_LABEL[rule] ?? UNKNOWN_TRIGGERED_RULE_LABEL
}

function formatChangedFilesDetail(changedFiles: string[]): string {
  if (changedFiles.length === 0) return ''
  const head = changedFiles.slice(0, 8)
  const rest = changedFiles.length - head.length
  return rest > 0 ? `${head.join('\n')}\n他${rest}件` : head.join('\n')
}

function formatFindingLocation(file?: string, line?: number): string {
  if (!file) return ''
  return line === undefined ? file : `${file}:${line}`
}

const NO_DETAIL_INFO_WARNING =
  'この古い承認リクエストには、変更ファイルや危険理由の詳細情報が保存されていません。内容が分からない場合は承認しないでください。'

function RejectReasonModal({
  onCancel,
  onConfirm,
  visible,
}: {
  onCancel: () => void
  onConfirm: (reason: string) => void
  visible: boolean
}): ReactElement {
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (visible) {
      setReason('')
    }
  }, [visible])

  const trimmedReason = reason.trim()
  const canConfirm = trimmedReason.length > 0

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <Text style={styles.modalTitle}>却下理由</Text>
          <TextInput
            maxLength={500}
            multiline
            onChangeText={setReason}
            placeholder="却下理由を入力してください"
            placeholderTextColor="#555"
            style={styles.modalInput}
            textAlignVertical="top"
            value={reason}
          />
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onCancel} style={styles.modalCancelButton}>
              <Text style={styles.modalCancelButtonText}>キャンセル</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!canConfirm}
              onPress={() => onConfirm(trimmedReason)}
              style={[
                styles.modalConfirmButton,
                !canConfirm && styles.modalConfirmButtonDisabled,
              ]}
            >
              <Text style={styles.modalConfirmButtonText}>却下する</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function ApprovalQuestionModal({
  error,
  loading,
  onCancel,
  onChangeQuestion,
  onSubmit,
  question,
  turns,
  visible,
}: {
  error: string | null
  loading: boolean
  onCancel: () => void
  onChangeQuestion: (value: string) => void
  onSubmit: () => void
  question: string
  turns: ApprovalQuestionTurn[]
  visible: boolean
}): ReactElement {
  const trimmedQuestion = question.trim()
  const canSubmit = trimmedQuestion.length > 0 && !loading

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, styles.questionModalBox]}>
          <Text style={styles.modalTitle}>AIに質問する</Text>
          <Text style={styles.questionHelpText}>
            この画面を閉じるまでのやり取りだけを使って回答します。
          </Text>

          {turns.length > 0 && (
            <ScrollView style={styles.questionHistory}>
              {turns.map((turn, index) => (
                <View
                  key={`${turn.role}-${index}`}
                  style={[
                    styles.questionTurn,
                    turn.role === 'user'
                      ? styles.questionTurnUser
                      : styles.questionTurnAssistant,
                  ]}
                >
                  <Text style={styles.questionTurnLabel}>
                    {turn.role === 'user' ? 'CEO' : 'AI'}
                  </Text>
                  <Text style={styles.questionTurnText}>{turn.content}</Text>
                </View>
              ))}
            </ScrollView>
          )}

          {error !== null && <Text style={styles.warningText}>{error}</Text>}

          <TextInput
            editable={!loading}
            maxLength={2_000}
            multiline
            onChangeText={onChangeQuestion}
            placeholder="例: 失敗した場合、元に戻せますか？"
            placeholderTextColor="#555"
            style={styles.modalInput}
            textAlignVertical="top"
            value={question}
          />
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onCancel} style={styles.modalCancelButton}>
              <Text style={styles.modalCancelButtonText}>閉じる</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!canSubmit}
              onPress={onSubmit}
              style={[
                styles.questionSubmitButton,
                !canSubmit && styles.modalConfirmButtonDisabled,
              ]}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.questionSubmitButtonText}>質問する</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

export default function ApprovalsScreen(): ReactElement {
  const [initialCache] = useState(() => getApprovalsCache())
  const [approvals, setApprovals] = useState<ApprovalWithProject[]>(
    initialCache.approvals ?? [],
  )
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>(
    initialCache.approvalRequests ?? [],
  )
  const [expandedApprovalRequestId, setExpandedApprovalRequestId] = useState<
    string | null
  >(null)
  const [taskInfoByTaskId, setTaskInfoByTaskId] = useState<
    Record<string, Task | null>
  >({})
  const [explanationByRequestId, setExplanationByRequestId] = useState<
    Record<string, ExplanationLoadState>
  >({})
  const [expandedTechnicalRequestId, setExpandedTechnicalRequestId] = useState<
    string | null
  >(null)
  const [questionTarget, setQuestionTarget] = useState<ApprovalRequest | null>(null)
  const [questionText, setQuestionText] = useState('')
  const [questionLoading, setQuestionLoading] = useState(false)
  const [questionError, setQuestionError] = useState<string | null>(null)
  const [questionHistoryByRequestId, setQuestionHistoryByRequestId] = useState<
    Record<string, ApprovalQuestionTurn[]>
  >({})
  const [loading, setLoading] = useState(
    initialCache.approvals === null && initialCache.approvalRequests === null,
  )
  const [refreshing, setRefreshing] = useState(false)
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null)

  const loadApprovalRequests = useCallback(async (): Promise<void> => {
    try {
      const waitingApprovalRequests = await fetchWaitingApprovalRequests()
      setApprovalRequests(waitingApprovalRequests)
      setCachedApprovalRequests(waitingApprovalRequests)
    } catch {
      Alert.alert('エラー', '危険操作承認の取得に失敗しました')
    }
  }, [])

  /** 方針承認（Project単位承認）を1回のfetchで取得する。Project数分のfetchは発生しない */
  const loadPolicyApprovals = useCallback(async (): Promise<void> => {
    try {
      const pendingApprovals = await fetchPendingApprovals()
      setApprovals(pendingApprovals)
      setCachedApprovals(pendingApprovals)
    } catch {
      Alert.alert('エラー', '方針承認の取得に失敗しました')
    }
  }, [])

  const loadAll = useCallback(async (): Promise<void> => {
    await Promise.all([loadApprovalRequests(), loadPolicyApprovals()])
    setLoading(false)
    setRefreshing(false)
  }, [loadApprovalRequests, loadPolicyApprovals])

  usePolling(loadAll, { intervalMs: POLLING_INTERVAL_MS, enabled: true })

  const refresh = useCallback((): void => {
    setRefreshing(true)
    void loadAll()
  }, [loadAll])

  async function handleDecision(
    approvalId: string,
    status: DecisionStatus,
    note?: string,
  ): Promise<void> {
    try {
      const response = await apiFetch(`/api/approvals/${approvalId}`, {
        body: JSON.stringify({ reviewNote: note, status }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      })

      if (!response.ok) {
        throw new Error(`Failed to update approval: ${response.status}`)
      }

      await loadPolicyApprovals()
    } catch {
      Alert.alert('エラー', '操作に失敗しました')
    }
  }

  async function handleApprovalGateDecision(
    requestId: string,
    status: ApprovalGateDecisionStatus,
    reason?: string,
  ): Promise<void> {
    try {
      const response = await apiFetch(
        `/api/approval-requests/${requestId}/status`,
        {
          body: JSON.stringify({ reason, status }),
          headers: { 'Content-Type': 'application/json' },
          method: 'PATCH',
        },
      )

      if (!response.ok) {
        throw new Error(`Failed to update approval request: ${response.status}`)
      }

      await loadApprovalRequests()

      if (status === 'APPROVED') {
        Alert.alert(
          '承認済み',
          '承認済み。Worker反映待ちになる場合があります。',
        )
      } else {
        Alert.alert('却下済み', 'この危険操作は却下されました。作業を続けるには追加指示が必要です。')
      }
    } catch {
      Alert.alert('エラー', '操作に失敗しました')
    }
  }

  async function loadApprovalExplanation(requestId: string): Promise<void> {
    setExplanationByRequestId((current) => ({
      ...current,
      [requestId]: { loading: true, result: current[requestId]?.result },
    }))
    const result = await fetchApprovalExplanation(requestId)
    setExplanationByRequestId((current) => ({
      ...current,
      [requestId]: { loading: false, result },
    }))
  }

  function openQuestionModal(item: ApprovalRequest): void {
    setQuestionTarget(item)
    setQuestionText('')
    setQuestionError(null)
  }

  function closeQuestionModal(): void {
    if (questionLoading) return
    setQuestionTarget(null)
    setQuestionText('')
    setQuestionError(null)
  }

  async function submitApprovalQuestion(): Promise<void> {
    const target = questionTarget
    const question = questionText.trim()
    if (target === null || question.length === 0 || questionLoading) return

    const history = questionHistoryByRequestId[target.id] ?? []
    setQuestionLoading(true)
    setQuestionError(null)
    const result = await askApprovalQuestion(target.id, question, history)
    setQuestionLoading(false)

    if (!result.ok) {
      setQuestionError('AIから回答を取得できませんでした')
      return
    }

    setQuestionHistoryByRequestId((current) => ({
      ...current,
      [target.id]: [
        ...(current[target.id] ?? []),
        { role: 'user', content: question },
        { role: 'assistant', content: result.answer },
      ],
    }))
    setQuestionText('')
  }

  function confirmApprove(item: ApprovalWithProject): void {
    Alert.alert('承認', `「${item.title}」を承認しますか？`, [
      { style: 'cancel', text: 'キャンセル' },
      {
        onPress: () => {
          void handleDecision(item.id, 'approved')
        },
        text: '承認',
      },
    ])
  }

  function confirmReject(item: ApprovalWithProject): void {
    setRejectTarget({ item, type: 'policy' })
  }

  function toggleApprovalRequestDetail(item: ApprovalRequest): void {
    const willExpand = expandedApprovalRequestId !== item.id
    setExpandedApprovalRequestId(willExpand ? item.id : null)

    if (willExpand && !(item.taskId in taskInfoByTaskId)) {
      void fetchTaskInfo(item.taskId).then((task) => {
        setTaskInfoByTaskId((prev) => ({ ...prev, [item.taskId]: task }))
      })
    }
    if (willExpand && explanationByRequestId[item.id] === undefined) {
      void loadApprovalExplanation(item.id)
    }
  }

  function confirmApproveApprovalRequest(item: ApprovalRequest): void {
    Alert.alert(
      '危険操作の承認',
      `Task ${item.taskId} の「${item.requestedAction}」を承認しますか？`,
      [
        { style: 'cancel', text: 'キャンセル' },
        {
          onPress: () => {
            void handleApprovalGateDecision(item.id, 'APPROVED')
          },
          text: '承認',
        },
      ],
    )
  }

  function confirmRejectApprovalRequest(item: ApprovalRequest): void {
    setRejectTarget({ item, type: 'gate' })
  }

  function handleConfirmReject(reason: string): void {
    const target = rejectTarget
    if (target === null) {
      return
    }
    setRejectTarget(null)

    if (target.type === 'policy') {
      void handleDecision(target.item.id, 'rejected', reason)
    } else {
      void handleApprovalGateDecision(target.item.id, 'REJECTED', reason)
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    )
  }

  return (
    <>
    <ScrollView
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} />
      }
      style={styles.container}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.title}>承認待ち</Text>
      </View>

      <View style={styles.introBox}>
        <Text style={styles.introText}>
          この画面では、AI開発チームが作業を進めるためにCEO判断が必要な項目を確認できます。
        </Text>
        <Text style={styles.introItemText}>
          判断に迷う場合は承認しないでください。承認するまで、対象の処理は実行されません。
        </Text>
        <Text style={styles.introItemText}>
          ⚠️ 危険操作の承認: AIが高リスクな変更を行おうとして停止している項目です。
        </Text>
        <Text style={styles.introItemText}>
          📋 方針承認: 課金・外部サービス追加・Goal変更など、Project全体に関わる経営判断です。
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⚠️ 危険操作の承認</Text>
        <Text style={styles.sectionDescription}>
          AIが作業中に危険度の高い変更を行おうとして停止している項目です。内容を確認し、問題なければ承認してください。
          危険操作については、承認するまでWorkerはその操作を進めません。
        </Text>

        {approvalRequests.length === 0 && (
          <Text style={styles.sectionEmpty}>承認待ちの危険操作はありません</Text>
        )}

        {approvalRequests.map((item) => {
          const isExpanded = expandedApprovalRequestId === item.id
          const isKnownAction = item.requestedAction in REQUESTED_ACTION_LABEL
          const changedFiles = item.changedFiles ?? []
          const triggeredRules = item.triggeredRules ?? []
          const hasDetailInfo = changedFiles.length > 0 || triggeredRules.length > 0
          const riskSummary = triggeredRules.slice(0, 2).map(formatTriggeredRule)
          const taskInfo = taskInfoByTaskId[item.taskId]
          const explanationState = explanationByRequestId[item.id]
          const explanationResult = explanationState?.result
          const explanation = explanationResult?.ok === true
            ? explanationResult.explanation
            : null
          const isTechnicalExpanded = expandedTechnicalRequestId === item.id

          return (
            <TouchableOpacity
              key={item.id}
              activeOpacity={0.8}
              onPress={() => toggleApprovalRequestDetail(item)}
              style={styles.card}
            >
              <View style={styles.cardTop}>
                <View style={[styles.riskBadge, RISK_BADGE_STYLE[item.riskLevel]]}>
                  <Text style={[styles.riskText, RISK_TEXT_STYLE[item.riskLevel]]}>
                    {formatRiskLevel(item.riskLevel)}
                  </Text>
                </View>
              </View>

              <Text style={styles.itemTitle}>
                AIがしようとしていること: {formatRequestedActionSummary(item.requestedAction)}
              </Text>

              {riskSummary.map((label) => (
                <Text key={label} style={styles.metaText}>
                  ・{label}
                </Text>
              ))}

              <Text style={styles.judgmentGuideText}>
                {formatJudgmentGuide(item.riskLevel)}
              </Text>

              {!isExpanded && (
                <Text style={styles.expandHintText}>タップして詳細を確認</Text>
              )}

              {isExpanded && (
                <View style={styles.detailArea}>
                  <View style={styles.explanationArea}>
                    <Text style={styles.explanationTitle}>承認内容の分かりやすい説明</Text>

                    {explanationState?.loading === true && (
                      <View style={styles.explanationLoadingRow}>
                        <ActivityIndicator color="#60a5fa" size="small" />
                        <Text style={styles.metaText}>AIが説明を生成しています...</Text>
                      </View>
                    )}

                    {explanationState?.loading !== true && explanationResult?.ok === false && (
                      <>
                        <Text style={styles.warningText}>
                          AIによる説明を生成できませんでした
                        </Text>
                        <TouchableOpacity
                          onPress={(event) => {
                            event.stopPropagation()
                            void loadApprovalExplanation(item.id)
                          }}
                          style={styles.retryButton}
                        >
                          <Text style={styles.retryButtonText}>説明を再取得</Text>
                        </TouchableOpacity>
                      </>
                    )}

                    {explanation !== null && (
                      <>
                        <Text style={styles.explanationLabel}>何をする承認か</Text>
                        <Text style={styles.explanationText}>{explanation.whatWasDone}</Text>
                        <Text style={styles.explanationLabel}>なぜ必要か</Text>
                        <Text style={styles.explanationText}>{explanation.whyNeeded}</Text>
                        <Text style={styles.explanationLabel}>Productionへの影響</Text>
                        <Text style={styles.explanationText}>{explanation.productionImpact}</Text>
                        <Text style={styles.explanationLabel}>リスク</Text>
                        <Text style={styles.explanationText}>{explanation.riskSummary}</Text>
                        <Text style={styles.explanationLabel}>失敗した場合どうなるか</Text>
                        <Text style={styles.explanationText}>{explanation.failureImpact}</Text>
                        <Text style={styles.explanationLabel}>test・QA結果</Text>
                        <Text style={styles.explanationText}>{explanation.verificationSummary}</Text>
                        <Text style={styles.explanationLabel}>review結果</Text>
                        <Text style={styles.explanationText}>{explanation.reviewSummary}</Text>
                        <Text style={styles.explanationLabel}>変更範囲</Text>
                        <Text style={styles.explanationText}>{explanation.scope}</Text>
                        <Text style={styles.explanationLabel}>変えていない重要部分</Text>
                        <Text style={styles.explanationText}>{explanation.notChanged}</Text>
                      </>
                    )}
                  </View>

                  <TouchableOpacity
                    onPress={(event) => {
                      event.stopPropagation()
                      openQuestionModal(item)
                    }}
                    style={styles.askButton}
                  >
                    <Text style={styles.askButtonText}>AIに質問する</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={(event) => {
                      event.stopPropagation()
                      setExpandedTechnicalRequestId((current) =>
                        current === item.id ? null : item.id,
                      )
                    }}
                    style={styles.technicalToggle}
                  >
                    <Text style={styles.technicalToggleText}>
                      {isTechnicalExpanded ? '技術詳細を閉じる' : '技術詳細を表示'}
                    </Text>
                  </TouchableOpacity>

                  {isTechnicalExpanded && (
                    <View style={styles.technicalArea}>
                      {!hasDetailInfo && explanation === null && (
                        <Text style={styles.warningText}>{NO_DETAIL_INFO_WARNING}</Text>
                      )}

                      {triggeredRules.length > 0 && (
                        <>
                          <Text style={styles.detailLabel}>既存Gateが検出した危険理由</Text>
                          {triggeredRules.map((rule, index) => (
                            <Text key={`${rule}-${index}`} style={styles.metaText}>
                              ・{formatTriggeredRule(rule)}
                            </Text>
                          ))}
                        </>
                      )}

                      {(explanation?.targetFiles.length ?? changedFiles.length) > 0 && (
                        <>
                          <Text style={styles.detailLabel}>対象ファイル</Text>
                          <Text selectable style={styles.codeText}>
                            {formatChangedFilesDetail(explanation?.targetFiles ?? changedFiles)}
                          </Text>
                        </>
                      )}

                      {explanationResult?.ok === true && explanationResult.diffStatus === 'exact' && (
                        <>
                          <Text style={styles.detailLabel}>Approval対象のexact diff</Text>
                          <ScrollView horizontal style={styles.diffScrollArea}>
                            <Text selectable style={styles.diffText}>
                              {explanationResult.exactDiff ?? ''}
                            </Text>
                          </ScrollView>
                        </>
                      )}

                      {explanationResult?.diffStatus === 'stale' && (
                        <Text style={styles.warningText}>
                          Approval作成後にHEADまたはdiffが変わったため、diffは表示しません。
                        </Text>
                      )}

                      {explanationResult?.diffStatus === 'unavailable' && (
                        <Text style={styles.metaHelpText}>
                          現在、Approval対象diffを安全に取得できません。
                        </Text>
                      )}

                      {explanation !== null && explanation.reviewFindings.length > 0 && (
                        <>
                          <Text style={styles.detailLabel}>review findings詳細</Text>
                          {explanation.reviewFindings.map((finding, index) => (
                            <View key={`${finding.message}-${index}`} style={styles.findingItem}>
                              <Text style={styles.findingSeverity}>{finding.severity.toUpperCase()}</Text>
                              {formatFindingLocation(finding.file, finding.line).length > 0 && (
                                <Text selectable style={styles.codeText}>
                                  {formatFindingLocation(finding.file, finding.line)}
                                </Text>
                              )}
                              <Text style={styles.metaText}>{finding.message}</Text>
                            </View>
                          ))}
                        </>
                      )}

                      {explanation !== null && explanation.verificationResults.length > 0 && (
                        <>
                          <Text style={styles.detailLabel}>verification詳細</Text>
                          {explanation.verificationResults.map((verification, index) => (
                            <View key={`${verification.kind}-${index}`} style={styles.verificationItem}>
                              <Text style={styles.metaText}>
                                {verification.kind}: {verification.status}
                              </Text>
                              <Text style={styles.metaHelpText}>{verification.detail}</Text>
                            </View>
                          ))}
                        </>
                      )}

                      {taskInfo && (
                        <>
                          <Text style={styles.detailLabel}>元タスク</Text>
                          <Text style={styles.metaText}>{taskInfo.title}</Text>
                          {taskInfo.description.length > 0 && (
                            <Text style={styles.metaText}>{taskInfo.description}</Text>
                          )}
                        </>
                      )}

                      <Text style={styles.detailLabel}>技術的な操作名</Text>
                      <Text selectable style={styles.codeText}>{item.requestedAction}</Text>
                      {!isKnownAction && (
                        <Text style={styles.metaHelpText}>
                          {UNKNOWN_REQUESTED_ACTION_NOTE}
                        </Text>
                      )}

                      <Text style={styles.metaText}>
                        {formatApprovalGateStatus(item.status)}
                      </Text>
                      <Text style={styles.metaText}>
                        承認期限: {formatDateTime(item.expiresAt)}
                      </Text>
                      <Text style={styles.metaText}>管理用ID: {item.taskId}</Text>
                    </View>
                  )}

                  <Text style={styles.expandHintText}>タップして詳細を閉じる</Text>

                  <View style={styles.actions}>
                    <TouchableOpacity
                      onPress={() => confirmApproveApprovalRequest(item)}
                      style={styles.approveButton}
                    >
                      <Text style={styles.approveButtonText}>承認</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => confirmRejectApprovalRequest(item)}
                      style={styles.rejectButton}
                    >
                      <Text style={styles.rejectButtonText}>却下</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </TouchableOpacity>
          )
        })}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📋 方針承認（Project全体の経営判断）</Text>
        <Text style={styles.sectionDescription}>
          課金・外部サービス追加・Goal変更・設計思想変更など、Project全体に関わるCEO判断です。
        </Text>

        {approvals.length === 0 && (
          <Text style={styles.sectionEmpty}>現在、方針承認はありません</Text>
        )}

        {approvals.map((item) => (
          <View key={item.id} style={styles.card}>
            <View style={styles.cardTop}>
              <View style={styles.typeBadge}>
                <Text style={styles.typeText}>{TYPE_LABEL[item.type]}</Text>
              </View>
              <Text style={styles.projectName} numberOfLines={1}>
                {item.projectName}
              </Text>
            </View>

            <Text style={styles.itemTitle}>{item.title}</Text>
            <Text style={styles.itemReason}>{item.reason}</Text>

            <View style={styles.actions}>
              <TouchableOpacity
                onPress={() => confirmApprove(item)}
                style={styles.approveButton}
              >
                <Text style={styles.approveButtonText}>承認</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => confirmReject(item)}
                style={styles.rejectButton}
              >
                <Text style={styles.rejectButtonText}>却下</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.bottomSpacer} />
    </ScrollView>
    <RejectReasonModal
      onCancel={() => setRejectTarget(null)}
      onConfirm={handleConfirmReject}
      visible={rejectTarget !== null}
    />
    <ApprovalQuestionModal
      error={questionError}
      loading={questionLoading}
      onCancel={closeQuestionModal}
      onChangeQuestion={setQuestionText}
      onSubmit={() => {
        void submitApprovalQuestion()
      }}
      question={questionText}
      turns={questionTarget === null ? [] : (questionHistoryByRequestId[questionTarget.id] ?? [])}
      visible={questionTarget !== null}
    />
    </>
  )
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    gap: 10,
  },
  askButton: {
    alignItems: 'center',
    backgroundColor: '#3b82f622',
    borderColor: '#3b82f666',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 11,
  },
  askButtonText: {
    color: '#60a5fa',
    fontSize: 14,
    fontWeight: '700',
  },
  modalOverlay: {
    alignItems: 'center',
    backgroundColor: '#000000aa',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalBox: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    width: '100%',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  modalInput: {
    backgroundColor: '#0f0f0f',
    borderColor: '#333',
    borderRadius: 8,
    borderWidth: 1,
    color: '#fff',
    fontSize: 14,
    minHeight: 90,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  modalCancelButton: {
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalCancelButtonText: {
    color: '#a3a3a3',
    fontSize: 14,
    fontWeight: '600',
  },
  modalConfirmButton: {
    alignItems: 'center',
    backgroundColor: '#ef4444',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalConfirmButtonDisabled: {
    backgroundColor: '#262626',
    opacity: 0.6,
  },
  modalConfirmButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  approveButton: {
    alignItems: 'center',
    backgroundColor: '#22c55e22',
    borderColor: '#22c55e44',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 12,
  },
  approveButtonText: {
    color: '#22c55e',
    fontSize: 14,
    fontWeight: '600',
  },
  back: {
    marginRight: 12,
  },
  backText: {
    color: '#3b82f6',
    fontSize: 15,
  },
  bottomSpacer: {
    height: 40,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginBottom: 12,
    padding: 16,
  },
  cardTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  center: {
    alignItems: 'center',
    backgroundColor: '#0a0a0a',
    flex: 1,
    justifyContent: 'center',
  },
  container: {
    backgroundColor: '#0a0a0a',
    flex: 1,
    padding: 16,
  },
  codeText: {
    color: '#d4d4d4',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  detailArea: {
    borderColor: '#2a2a2a',
    borderTopWidth: 1,
    gap: 6,
    marginTop: 10,
    paddingTop: 10,
  },
  detailLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 8,
  },
  diffScrollArea: {
    backgroundColor: '#0a0a0a',
    borderColor: '#2a2a2a',
    borderRadius: 6,
    borderWidth: 1,
    maxHeight: 320,
    padding: 10,
  },
  diffText: {
    color: '#d4d4d4',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  empty: {
    color: '#737373',
    fontSize: 16,
    marginTop: 60,
    textAlign: 'center',
  },
  expandHintText: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  explanationArea: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  explanationLabel: {
    color: '#93c5fd',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 9,
  },
  explanationLoadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 10,
  },
  explanationText: {
    color: '#e5e5e5',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 2,
  },
  explanationTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  findingItem: {
    backgroundColor: '#141414',
    borderRadius: 6,
    gap: 3,
    padding: 8,
  },
  findingSeverity: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '800',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 20,
    marginTop: 52,
  },
  introBox: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    marginBottom: 20,
    padding: 14,
  },
  introItemText: {
    color: '#a3a3a3',
    fontSize: 13,
    lineHeight: 19,
  },
  introText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  itemReason: {
    color: '#a3a3a3',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 14,
  },
  itemTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  judgmentGuideText: {
    color: '#fbbf24',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    marginBottom: 14,
    marginTop: 4,
  },
  metaHelpText: {
    color: '#737373',
    fontSize: 12,
    lineHeight: 17,
  },
  metaText: {
    color: '#a3a3a3',
    fontSize: 13,
    lineHeight: 18,
  },
  projectName: {
    color: '#737373',
    flex: 1,
    fontSize: 12,
  },
  questionHelpText: {
    color: '#a3a3a3',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  questionHistory: {
    marginBottom: 12,
    maxHeight: 300,
  },
  questionModalBox: {
    maxHeight: '85%',
  },
  questionSubmitButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 8,
    minWidth: 92,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  questionSubmitButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  questionTurn: {
    borderRadius: 8,
    marginBottom: 8,
    padding: 10,
  },
  questionTurnAssistant: {
    backgroundColor: '#172554',
  },
  questionTurnLabel: {
    color: '#93c5fd',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 3,
  },
  questionTurnText: {
    color: '#e5e5e5',
    fontSize: 13,
    lineHeight: 19,
  },
  questionTurnUser: {
    backgroundColor: '#262626',
  },
  rejectButton: {
    alignItems: 'center',
    backgroundColor: '#ef444422',
    borderColor: '#ef444444',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 12,
  },
  rejectButtonText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  riskBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  riskText: {
    fontSize: 11,
    fontWeight: '700',
  },
  retryButton: {
    alignItems: 'center',
    borderColor: '#ef444466',
    borderRadius: 7,
    borderWidth: 1,
    padding: 9,
  },
  retryButtonText: {
    color: '#fca5a5',
    fontSize: 13,
    fontWeight: '700',
  },
  section: {
    marginBottom: 20,
  },
  sectionDescription: {
    color: '#a3a3a3',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  sectionEmpty: {
    color: '#737373',
    fontSize: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  technicalArea: {
    backgroundColor: '#101010',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
    padding: 12,
  },
  technicalToggle: {
    alignItems: 'center',
    padding: 9,
  },
  technicalToggleText: {
    color: '#a3a3a3',
    fontSize: 13,
    fontWeight: '600',
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
  },
  typeBadge: {
    backgroundColor: '#f59e0b22',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeText: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '600',
  },
  verificationItem: {
    backgroundColor: '#141414',
    borderRadius: 6,
    gap: 3,
    padding: 8,
  },
  warningText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
    marginBottom: 6,
  },
})
