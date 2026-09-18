/**
 * Blocked Resolution Triage の **read-only** 再生。Operational E2E をやり直すための入口である。
 *
 * DB スナップショットを開き、`buildSystemState()` が実際に出す attention に対して
 * `triageBlocked()` を回して、どの原因分類・どのレーン・どの候補集合になるかを表示する。
 *
 * **何も書き込まない。** `runPlTick()` は呼ばない（呼ぶと状態が変わる）。再生するのは
 * Observe → Triage までで、そこから先（Gate → 実行 / Escalation）は tick の責務である。
 *
 * production の DB を直接開かないこと。`scp` で取ったスナップショットの複製に対して使う。
 *
 * 使い方: `pnpm exec tsx scripts/blockedTriageReplay.ts <path-to-db-snapshot>`
 */

import { createSQLiteStorage } from '../src/storage/sqlite'
import { buildSystemState } from '../src/state/systemState'
import { allowedActionsFor } from '../src/pl/executionLoop'
import {
  formatTriageAuditDetail,
  needsProviderDiagnosis,
  summarizeBlockedTriage,
  triageAllowedActions,
  triageBlocked,
} from '../src/pl/blockedTriage'

const dbPath = process.argv[2]
if (dbPath === undefined) {
  console.error('usage: tsx scripts/blockedTriageReplay.ts <path-to-db-snapshot>')
  process.exit(1)
}

const storage = createSQLiteStorage(dbPath)
const state = buildSystemState(storage)

console.log(`attention items: ${state.attention.length}`)
for (const item of state.attention) {
  const diagnosis = triageBlocked(storage, item)
  // **候補集合は tick と同じ関数から取る。** ここで一覧を書き写すと必ずずれる。
  const allowed = triageAllowedActions(diagnosis, allowedActionsFor(item.kind))

  console.log('---')
  console.log(`attention : ${item.kind} task=${item.taskId ?? '-'} job=${item.jobId ?? '-'}`)
  console.log(`audit     : ${formatTriageAuditDetail(diagnosis)}`)
  console.log(`allowed   : ${allowed.join(', ')}`)
  console.log(`diagnose? : ${needsProviderDiagnosis(allowed)}`)
  console.log(`evidence  : ${diagnosis.evidence.map((e) => `${e.fact}=${e.value}`).join(' | ')}`)
  console.log(`summary   : ${diagnosis.summary}`)
}

console.log('\n===== triage summary derived from audit_log =====')
console.log(JSON.stringify(summarizeBlockedTriage(storage.auditLog.findAll()), null, 1))
