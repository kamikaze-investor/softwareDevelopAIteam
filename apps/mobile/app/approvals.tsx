/**
 * Pending approval list for CEO decisions.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Approval, ApprovalType, Project } from '@ai-team/shared'
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

const TYPE_LABEL: Record<ApprovalType, string> = {
  billing: '課金',
  dependency_add: '依存追加',
  deployment: '本番公開',
  external_service: '外部サービス追加',
  goal_change: 'Goal変更',
  philosophy_change: '設計思想変更',
  security: 'セキュリティ変更',
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

export default function ApprovalsScreen(): ReactElement {
  const [approvals, setApprovals] = useState<ApprovalWithProject[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const pendingApprovals = await fetchPendingApprovals()
      setApprovals(pendingApprovals)
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

      {approvals.length === 0 && (
        <Text style={styles.empty}>承認待ちの事項はありません</Text>
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
