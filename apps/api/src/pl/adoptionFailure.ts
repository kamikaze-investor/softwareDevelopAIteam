/**
 * 採用失敗の「いま起きている障害」を、既存 `audit_log` の行から導く。
 *
 * **CEO への通知（`executionLoop`）と Mobile への表示（`systemState`）が同じ定義を使う。**
 * 別々に書くと、通知されている障害と画面に出ている障害がずれる。
 *
 * ここに state は持たない。材料は `pl_loop_target:adopt:<projectId>` の audit 行だけである。
 */

import type { AuditLogEntry } from '@ai-team/shared'

/** 1回の採用試行として数える audit 結果。 */
export const ATTEMPT_RESULTS: readonly string[] = [
  'acted',
  'blocked',
  'diagnosis_unusable',
  'diagnosis_failed',
]

/**
 * 直近の採用成功（`acted`）より後の行だけを、新しい順で返す。
 *
 * 成功は「そこまでの障害は終わった」という区切りである。
 */
export function entriesSinceLastAdoption(
  entries: readonly AuditLogEntry[],
): AuditLogEntry[] {
  const since: AuditLogEntry[] = []
  for (const entry of entries) {
    if (entry.result === 'acted') break
    since.push(entry)
  }
  return since
}

/**
 * 失敗の分類。**自由文からは作らない。**
 *
 * 材料は audit の `result` と、detail 先頭の `adoption=<status> code=<code> target=<roadmapId>`。
 * いずれも列挙値か識別子であって散文ではない（`reason` は人が読むためのもので、ここでは使わない）。
 *
 * `target` まで含めるのは、同じ原因コードでも**対象の Roadmap 項目が変われば別の障害**だからである
 * （独立レビュー: `adoption_rejected/ALREADY_EXECUTED` が item A と item B で同一視されていた）。
 */
export function adoptionFailureClasses(entries: readonly AuditLogEntry[]): string[] {
  const classes = new Set<string>()
  for (const entry of entries) {
    if (!ATTEMPT_RESULTS.includes(entry.result)) continue
    const detail = entry.detail ?? ''
    const status = /^adoption=([a-z_]+)/.exec(detail)?.[1]
    if (status === undefined) {
      classes.add(entry.result)
      continue
    }
    const code = /\bcode=([^\s]+)/.exec(detail)?.[1]
    const target = /\btarget=([^\s]+)/.exec(detail)?.[1]
    classes.add([
      status,
      code === undefined || code === '-' ? undefined : code,
      target === undefined || target === '-' ? undefined : target,
    ].filter((part) => part !== undefined).join('/'))
  }
  return [...classes].sort()
}

/**
 * 通知の重複判定に使う指紋。
 *
 * **採用成功の回数を先頭に含める。** これで「前回の成功より後に知らせたか」を
 * 時刻の比較なしに表せる。audit の並び順は `created_at DESC, rowid DESC` であり、
 * 同一ミリ秒の行は時刻比較では正しく順序づけられない（独立レビュー指摘）。
 * 成功するたびに指紋が変わるので、再発は自動的に新しい incident になる。
 */
export function adoptionFailureFingerprint(
  adoptionSuccessCount: number,
  entriesSinceSuccess: readonly AuditLogEntry[],
): string {
  return `${adoptionSuccessCount}|${adoptionFailureClasses(entriesSinceSuccess).join(',')}`
}

export interface AdoptionFailureSummary {
  /** いま続いている失敗の分類（複数種あればすべて）。 */
  failureClass: string
  /** この障害で CEO へ上げた回数。 */
  escalations: number
  /** この分類の失敗が始まった時刻。 */
  since: string
  /** 直近に失敗した時刻。 */
  lastAt: string
}

/**
 * いま採用が失敗し続けているか。失敗していなければ `undefined`。
 *
 * `since` と `escalations` は**現在の分類が始まった時点から**数える。
 * 直近の成功からの全期間で数えると、既に終わった別種の失敗まで混ざり、
 * 画面上の「いつから / 何回」が実際の障害とずれる（独立レビュー指摘）。
 */
export function summarizeAdoptionFailure(
  entries: readonly AuditLogEntry[],
): AdoptionFailureSummary | undefined {
  const since = entriesSinceLastAdoption(entries)
  const escalations = since.filter((entry) => entry.result === 'escalated')
  if (escalations.length === 0) return undefined

  // 直近の失敗の分類。ここを起点に「同じ分類が続いている範囲」だけを数える。
  const failures = since.filter((entry) => ATTEMPT_RESULTS.includes(entry.result))
  const currentClasses = adoptionFailureClasses(failures.slice(0, 1))
  const currentClass = currentClasses[0] ?? failures[0]?.result ?? 'unknown'

  // 新しい順に遡り、**現在の分類の最も古い試行**がどこかを探す。
  //
  // 分類が変わった行で切るのではなく、その手前の「現分類の試行」で切ること。
  // 分類が変わった行の後ろには**前の障害の escalation** が残っており、
  // そこまで含めると「いつから / 何回」が前の障害ぶんだけ水増しされる。
  let oldestOfCurrent = -1
  for (let i = 0; i < since.length; i += 1) {
    const entry = since[i]!
    if (!ATTEMPT_RESULTS.includes(entry.result)) continue
    if (adoptionFailureClasses([entry])[0] !== currentClass) break
    oldestOfCurrent = i
  }
  const current = since.slice(0, oldestOfCurrent + 1)
  const currentEscalations = current.filter((entry) => entry.result === 'escalated')

  return {
    failureClass: currentClass,
    // まだ escalate していない分類なら 0 になる。**障害が出ていないことにはしない**
    // （escalation が1件も無い場合は上で undefined を返している）。
    escalations: currentEscalations.length,
    since: (current[current.length - 1] ?? since[since.length - 1])!.createdAt,
    lastAt: (currentEscalations[0] ?? escalations[0])!.createdAt,
  }
}
