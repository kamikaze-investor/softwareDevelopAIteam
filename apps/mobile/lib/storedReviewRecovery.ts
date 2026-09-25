/**
 * 保存済み `changes_requested` を、既存の canonical repair 経路へ戻す操作。
 *
 * 新しい backend route は使わない。既存の
 *   - `POST /api/qa`（検証事実の登録）
 *   - `POST /api/tasks/:id/repair-from-stored-review`（再投入）
 * を、既存 `apiFetch()` 経由でこの順に呼ぶだけである。
 *
 * **token に触れない。** `apiFetch()` が Secure Storage から読んで Authorization を付ける。
 * ここで token を読む・持つ・記録する・引数で受け取ることはしない。
 *
 * **Approval は自動化しない。** 202 を受けたら承認待ちである事実を返すだけで、
 * 承認そのものは CEO が既存 Approval UI で行う。
 *
 * 判断ロジックを UI から切り出す方針（`taskWorkflow.ts` と同じ）に沿い、
 * 画面はこの関数の戻り値を表示するだけにする。
 */

import { apiFetch } from './api'
import type { DerivedQaEvidence } from './taskWorkflow'

/** backend の戻り値をそのまま運ぶ。Mobile 側で解釈し直したり、成功へ倒したりしない。 */
export type StoredReviewRecoveryResult =
  | { ok: true; status: 'awaiting_approval'; requestedAction: string }
  | { ok: true; status: 'queued' | 'escalated' | 'skipped'; detail: string }
  | { ok: false; message: string }

/**
 * @param evidence 登録対象の QA 事実。**既に登録済みのものは呼び出し側で除いておく**
 *   （`qaEvidenceToRegister()`）。空配列なら QA 登録は行わず再投入だけを行う。
 */
export async function submitStoredReviewRecovery(
  taskId: string,
  reviewJobId: string,
  evidence: DerivedQaEvidence[],
): Promise<StoredReviewRecoveryResult> {
  try {
    // **QA が1件でも登録に失敗したら再投入しない。** 証跡が欠けたまま repair を始めると、
    // 直そうとしている「証拠が届かない」状態を別の形で作り直すことになる。
    for (const qa of evidence) {
      const response = await apiFetch('/api/qa', {
        body: JSON.stringify({
          details: qa.details,
          jobId: qa.jobId,
          status: qa.status,
          summary: qa.summary,
          taskId,
          type: qa.type,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        return {
          message: `検証事実の登録に失敗しました（QA ${qa.type}: HTTP ${response.status}）`,
          ok: false,
        }
      }
    }

    const response = await apiFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/repair-from-stored-review`,
      {
        body: JSON.stringify({ reviewJobId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    )
    const payload = (await response.json().catch(() => null)) as
      | { status?: string; requestedAction?: string; reason?: string; error?: string }
      | null

    if (response.status === 202 && payload?.status === 'awaiting_approval') {
      return {
        ok: true,
        requestedAction: payload.requestedAction ?? '',
        status: 'awaiting_approval',
      }
    }
    if (!response.ok) {
      return {
        message: payload?.error ?? `修正の起票に失敗しました（HTTP ${response.status}）`,
        ok: false,
      }
    }
    // queued / escalated / skipped。**自動で再試行しない。** 事実をそのまま返す。
    const status = payload?.status
    if (status === 'queued' || status === 'escalated' || status === 'skipped') {
      return { detail: payload?.reason ?? '', ok: true, status }
    }
    return { message: '修正の起票結果を解釈できませんでした', ok: false }
  } catch {
    return { message: '修正の起票に失敗しました（API通信エラー）', ok: false }
  }
}
