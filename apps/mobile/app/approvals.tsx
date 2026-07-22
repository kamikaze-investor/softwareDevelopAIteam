/**
 * Pending approval list for CEO decisions.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type {
  Approval,
  ApprovalGateStatus,
  ApprovalRequest,
  ApprovalType,
  RiskLevel,
  Task,
} from '@ai-team/shared'
import { router } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'

declare const process: {
  env: {
    EXPO_PUBLIC_API_URL?: string
  }
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

type ApprovalWithProject = Approval & { projectName: string }
type DecisionStatus = 'approved' | 'rejected'
type ApprovalGateDecisionStatus = Extract<
  ApprovalGateStatus,
  'APPROVED' | 'REJECTED'
>

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

/** 全Project横断でpending状態の方針承認だけを1回のfetchで取得する（Project数分fetchしない） */
async function fetchPendingApprovals(): Promise<ApprovalWithProject[]> {
  const response = await fetch(`${API_BASE}/api/approvals/pending`)

  if (!response.ok) {
    throw new Error(`Failed to fetch pending approvals: ${response.status}`)
  }

  return (await response.json()) as ApprovalWithProject[]
}

async function fetchWaitingApprovalRequests(): Promise<ApprovalRequest[]> {
  const response = await fetch(`${API_BASE}/api/approval-requests/waiting`)

  if (!response.ok) {
    throw new Error(`Failed to fetch approval requests: ${response.status}`)
  }

  return (await response.json()) as ApprovalRequest[]
}

/** タップして詳細を開いた時だけ呼ぶ。404/失敗時はnullを返し、UI側で目的説明を省略する */
async function fetchTaskInfo(taskId: string): Promise<Task | null> {
  try {
    const response = await fetch(`${API_BASE}/api/tasks/${taskId}`)
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

const NO_DETAIL_INFO_WARNING =
  'この古い承認リクエストには、変更ファイルや危険理由の詳細情報が保存されていません。内容が分からない場合は承認しないでください。'

export default function ApprovalsScreen(): ReactElement {
  const [approvals, setApprovals] = useState<ApprovalWithProject[]>([])
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([])
  const [expandedApprovalRequestId, setExpandedApprovalRequestId] = useState<
    string | null
  >(null)
  const [taskInfoByTaskId, setTaskInfoByTaskId] = useState<
    Record<string, Task | null>
  >({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadApprovalRequests = useCallback(async (): Promise<void> => {
    try {
      const waitingApprovalRequests = await fetchWaitingApprovalRequests()
      setApprovalRequests(waitingApprovalRequests)
    } catch {
      Alert.alert('エラー', '危険操作承認の取得に失敗しました')
    }
  }, [])

  /** 方針承認（Project単位承認）を1回のfetchで取得する。Project数分のfetchは発生しない */
  const loadPolicyApprovals = useCallback(async (): Promise<void> => {
    try {
      const pendingApprovals = await fetchPendingApprovals()
      setApprovals(pendingApprovals)
    } catch {
      Alert.alert('エラー', '方針承認の取得に失敗しました')
    }
  }, [])

  const loadAll = useCallback(async (): Promise<void> => {
    await Promise.all([loadApprovalRequests(), loadPolicyApprovals()])
    setLoading(false)
    setRefreshing(false)
  }, [loadApprovalRequests, loadPolicyApprovals])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

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
      const response = await fetch(`${API_BASE}/api/approvals/${approvalId}`, {
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
  ): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE}/api/approval-requests/${requestId}/status`,
        {
          body: JSON.stringify({ status }),
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
        Alert.alert('却下済み', '危険操作の承認リクエストを却下しました')
      }
    } catch {
      Alert.alert('エラー', '操作に失敗しました')
    }
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
    Alert.alert('却下', `「${item.title}」を却下しますか？`, [
      { style: 'cancel', text: 'キャンセル' },
      {
        onPress: () => {
          void handleDecision(item.id, 'rejected')
        },
        style: 'destructive',
        text: '却下',
      },
    ])
  }

  function toggleApprovalRequestDetail(item: ApprovalRequest): void {
    setExpandedApprovalRequestId((current) => {
      const willExpand = current !== item.id
      if (willExpand && !(item.taskId in taskInfoByTaskId)) {
        void fetchTaskInfo(item.taskId).then((task) => {
          setTaskInfoByTaskId((prev) => ({ ...prev, [item.taskId]: task }))
        })
      }
      return willExpand ? item.id : null
    })
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
    Alert.alert(
      '危険操作の却下',
      `Task ${item.taskId} の「${item.requestedAction}」を却下しますか？`,
      [
        { style: 'cancel', text: 'キャンセル' },
        {
          onPress: () => {
            void handleApprovalGateDecision(item.id, 'REJECTED')
          },
          style: 'destructive',
          text: '却下',
        },
      ],
    )
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    )
  }

  return (
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
                  {!hasDetailInfo && (
                    <Text style={styles.warningText}>{NO_DETAIL_INFO_WARNING}</Text>
                  )}

                  {triggeredRules.length > 0 && (
                    <>
                      <Text style={styles.detailLabel}>なぜ危険と判定されたか</Text>
                      {triggeredRules.map((rule, index) => (
                        <Text key={`${rule}-${index}`} style={styles.metaText}>
                          ・{formatTriggeredRule(rule)}
                        </Text>
                      ))}
                    </>
                  )}

                  {changedFiles.length > 0 && (
                    <>
                      <Text style={styles.detailLabel}>変更されるファイル</Text>
                      <Text style={styles.metaText}>
                        {formatChangedFilesDetail(changedFiles)}
                      </Text>
                    </>
                  )}

                  {taskInfo && (
                    <>
                      <Text style={styles.detailLabel}>この変更の目的</Text>
                      <Text style={styles.metaText}>元タスク: {taskInfo.title}</Text>
                      {taskInfo.description.length > 0 && (
                        <Text style={styles.metaText}>{taskInfo.description}</Text>
                      )}
                    </>
                  )}

                  <Text style={styles.detailLabel}>技術的な操作名</Text>
                  <Text style={styles.metaText}>{item.requestedAction}</Text>
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
                  <Text style={styles.metaHelpText}>
                    開発チームがこの承認を特定するための番号です。
                  </Text>

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
  )
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    gap: 10,
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
  warningText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
    marginBottom: 6,
  },
})
