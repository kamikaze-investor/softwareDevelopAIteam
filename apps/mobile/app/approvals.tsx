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
  Project,
  RiskLevel,
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

async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/api/projects`)

  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.status}`)
  }

  return (await response.json()) as Project[]
}

async function fetchProjectApprovals(
  project: Project,
): Promise<ApprovalWithProject[]> {
  const response = await fetch(`${API_BASE}/api/projects/${project.id}/approvals`)

  if (!response.ok) {
    return []
  }

  const approvals = (await response.json()) as Approval[]

  return approvals.map(
    (approval): ApprovalWithProject => ({
      ...approval,
      projectName: project.name,
    }),
  )
}

async function fetchPendingApprovals(): Promise<ApprovalWithProject[]> {
  const projects = await fetchProjects()
  const approvalGroups = await Promise.all(projects.map(fetchProjectApprovals))

  return approvalGroups
    .flatMap((approvals): ApprovalWithProject[] => approvals)
    .sort(
      (left, right): number =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )
}

async function fetchWaitingApprovalRequests(): Promise<ApprovalRequest[]> {
  const response = await fetch(`${API_BASE}/api/approval-requests/waiting`)

  if (!response.ok) {
    throw new Error(`Failed to fetch approval requests: ${response.status}`)
  }

  return (await response.json()) as ApprovalRequest[]
}

function formatDateTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

export default function ApprovalsScreen(): ReactElement {
  const [approvals, setApprovals] = useState<ApprovalWithProject[]>([])
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [pendingApprovals, waitingApprovalRequests] = await Promise.all([
        fetchPendingApprovals(),
        fetchWaitingApprovalRequests(),
      ])
      setApprovals(pendingApprovals)
      setApprovalRequests(waitingApprovalRequests)
    } catch {
      Alert.alert('エラー', 'データの取得に失敗しました')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback((): void => {
    setRefreshing(true)
    void load()
  }, [load])

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

      await load()
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

      await load()

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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⚠️ 危険操作の承認</Text>

        {approvalRequests.length === 0 && (
          <Text style={styles.sectionEmpty}>承認待ちの危険操作はありません</Text>
        )}

        {approvalRequests.map((item) => (
          <View key={item.id} style={styles.card}>
            <View style={styles.cardTop}>
              <View style={[styles.riskBadge, RISK_BADGE_STYLE[item.riskLevel]]}>
                <Text style={[styles.riskText, RISK_TEXT_STYLE[item.riskLevel]]}>
                  {item.riskLevel}
                </Text>
              </View>
              <Text style={styles.projectName} numberOfLines={1}>
                {item.status}
              </Text>
            </View>

            <Text style={styles.itemTitle}>{item.requestedAction}</Text>

            <View style={styles.metaGroup}>
              <Text style={styles.metaText}>Task: {item.taskId}</Text>
              <Text style={styles.metaText}>Status: {item.status}</Text>
              <Text style={styles.metaText}>
                Expires: {formatDateTime(item.expiresAt)}
              </Text>
            </View>

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
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📋 方針承認</Text>

        {approvals.length === 0 && (
          <Text style={styles.sectionEmpty}>承認待ちの事項はありません</Text>
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
  empty: {
    color: '#737373',
    fontSize: 16,
    marginTop: 60,
    textAlign: 'center',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 20,
    marginTop: 52,
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
  metaGroup: {
    gap: 4,
    marginBottom: 14,
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
})
