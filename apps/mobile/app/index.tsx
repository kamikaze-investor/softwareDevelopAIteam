/**
 * CEO Dashboard — ホーム画面
 *
 * 仕様: specs/07_dashboard.md
 * 表示: Goal / Progress / Current Work / Next Work / Risks
 *
 * 30 Second Rule: 30秒以内に現在地を把握できること
 */

import { View, Text, StyleSheet, ScrollView } from 'react-native'

export default function Dashboard() {
  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>AI Development Team OS</Text>
      <Text style={styles.subtitle}>CEO Dashboard</Text>

      {/* Phase 1で実装予定 */}
      {/* <GoalSection /> */}
      {/* <ProgressSection /> */}
      {/* <CurrentWorkSection /> */}
      {/* <NextWorkSection /> */}
      {/* <RisksSection /> */}
      {/* <PendingApprovalsSection /> */}

      <Text style={styles.placeholder}>
        Phase 1 — 基盤構築中
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', marginTop: 48 },
  subtitle: { fontSize: 14, color: '#888', marginTop: 4 },
  placeholder: { fontSize: 16, color: '#444', marginTop: 40, textAlign: 'center' },
})
