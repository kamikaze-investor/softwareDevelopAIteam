/**
 * `POST /api/tasks/:id/resume`（と `POST /api/tasks/:id/recover`）の失敗を、
 * CEO が次に何をすべきか分かる文言へ写す。
 *
 * code が無い・未知のときの fallback として:
 * API の `error` 文字列を部分一致で引く。**先に書いた方が優先される**ので、
 * 具体的な理由ほど上に置く。
 */

export const RESUME_ERROR_MESSAGE_FALLBACK =
  '追加指示の送信に失敗しました。時間をおいて再度お試しください。'

/**
 * 追加指示の事前 Design Review が通らなかったとき（409）。
 *
 * API は「レビュー AI が使えなかった」と「指示が方針と合わないと判定された」を区別して返さない。
 * 前者を「入力内容を確認してください」と出すと、CEO は正しい指示を書き直してしまう
 * （2026-10-16、Gemini が使えない間に実際に起きた）。どちらの場合もあり得ると伝える。
 */
export const RESUME_DESIGN_REVIEW_FAILED_MESSAGE =
  '追加指示の事前の設計レビューを通過できませんでした。'
  + 'レビューAIが一時的に使えない場合もこの表示になるため、入力内容の誤りとは限りません。'
  + '時間をおいてもう一度送信してください。続く場合はAI開発チームに確認を依頼してください。'

const RESUME_ERROR_MESSAGE_BY_REASON: ReadonlyArray<readonly [string, string]> = [
  ['did not pass the pre-implementation design review', RESUME_DESIGN_REVIEW_FAILED_MESSAGE],
  ['already exists for this task', '既に実行中または待機中の作業があるため、追加指示を送れませんでした。'],
  ['missing AI CLI', 'AI実行設定が不足しているため、再開できませんでした。'],
  ['No jobs exist', '対象の作業履歴が見つからないため、再開できませんでした。'],
  ['not blocked', '現在は停止状態ではないため、追加指示を送れませんでした。'],
  ['instruction', '入力内容を確認してください。'],
  ['validation', '入力内容を確認してください。'],
  ['waiting for user review', '承認待ちの操作があるため、追加指示を送れませんでした。'],
]

/**
 * resume 拒否の `code` ごとの文言。code は共有 `ResumeAdmissionCode` と、API 固有の拒否 code
 * （`apps/api/src/routes/tasks.ts` の `POST /:id/resume`）。
 */
const RESUME_ERROR_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  TASK_DONE: 'このTaskは完了しているため、再開できません。',
  PROJECT_NOT_RUNNING: 'Projectが実行中ではないため、再開できませんでした。先にProjectを再開してください。',
  NO_JOBS: 'このTaskには作業履歴が無いため、追加指示では再開できません。「復旧（再開待ちに戻す）」を使ってください。',
  LATEST_JOB_NOT_BLOCKED: '現在は停止状態ではないため、追加指示を送れませんでした。',
  TASK_PARKED: 'このTaskは中止（保留）されているため、再開できません。',
  WORKSPACE_QUARANTINED: '安全のため停止しているため、追加指示では再開できません。AI開発チーム側で作業領域の復旧が必要です。',
  LIVE_JOB_EXISTS: '既に実行中または待機中の作業があるため、追加指示を送れませんでした。',
  REPAIR_REVIEW_IN_FLIGHT: '修正の設計レビューが進行中のため、追加指示を送れませんでした。レビューの結果を待ってください。',
  APPROVAL_WAITING: '承認待ちの操作があるため、追加指示を送れませんでした。',
  HUMAN_DECISION_PENDING: '承認画面で判断待ち・判断済みの操作（中止など）があるため、この操作では再開できませんでした。CEOの操作として再開してください。',
  AI_CLI_MODE_MISSING: 'AI実行設定が不足しているため、再開できませんでした。',
  AI_CLI_PROVIDER_MISSING: 'AI実行設定（使用するAI）が記録されていないため、再開できませんでした。AI開発チームに確認を依頼してください。',
  RESUME_DESIGN_REVIEW_FAILED: RESUME_DESIGN_REVIEW_FAILED_MESSAGE,
  REJECTED_COMMIT_SOURCE_UNRESOLVED:
    '却下されたコミットの元の作業を特定できないため、再開できませんでした。AI開発チームに確認を依頼してください。',
  GIT_COMMIT_RESUME_LINEAGE_INVALID:
    '却下されたコミットの元の作業を特定できないため、再開できませんでした。AI開発チームに確認を依頼してください。',
}

function messageForCode(table: Readonly<Record<string, string>>, code: string | null): string | undefined {
  if (code === null || !Object.prototype.hasOwnProperty.call(table, code)) return undefined
  return table[code]
}

/**
 * **stable な `code` を先に引く**（resume の 409 は必ず `{ error, code }` を返す）。
 * code が無い・未知のときだけ、従来どおり `error` 文字列を部分一致で引く。
 */
export function formatResumeErrorMessage(errorMessage: string | null, code: string | null = null): string {
  const byCode = messageForCode(RESUME_ERROR_MESSAGE_BY_CODE, code)
  if (byCode !== undefined) return byCode

  if (errorMessage === null || errorMessage.length === 0) {
    return RESUME_ERROR_MESSAGE_FALLBACK
  }

  const normalizedErrorMessage = errorMessage.toLowerCase()
  const matchingMessage = RESUME_ERROR_MESSAGE_BY_REASON.find(
    ([reason]) => normalizedErrorMessage.includes(reason.toLowerCase()),
  )

  return matchingMessage?.[1] ?? RESUME_ERROR_MESSAGE_FALLBACK
}

export const RECOVER_ERROR_MESSAGE_FALLBACK =
  '復旧に失敗しました。時間をおいて再度お試しください。'

/** `POST /api/tasks/:id/recover` の拒否 `code`（`RecoverBlockedTaskResult`）ごとの文言。 */
const RECOVER_ERROR_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  TASK_NOT_FOUND: '対象のTaskが見つかりませんでした。',
  PROJECT_UNAVAILABLE: 'Projectが見つからないかアーカイブ済みのため、復旧できませんでした。',
  PROJECT_NOT_RUNNING: 'Projectが実行中ではないため、復旧できませんでした。先にProjectを再開してください。',
  TASK_NOT_BLOCKED: '現在は停止状態ではないため、復旧の必要はありません。',
  TASK_HAS_JOBS: 'このTaskには作業履歴があるため、「追加指示を出す」から再開してください。',
  TASK_PARKED: 'このTaskは中止（保留）されているため、復旧できません。',
  APPROVAL_WAITING: '承認待ちの操作があるため、復旧できませんでした。先に承認画面で判断してください。',
  // 403: 人（CEO）だけの操作で、API の認証構成が人と自動を区別できない（`HUMAN_ONLY_ROUTES`）。
  HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS:
    'この操作はCEO専用です。現在のAPIの認証設定では実行できません。AI開発チームに確認を依頼してください。',
}

export function formatRecoverErrorMessage(code: string | null): string {
  return messageForCode(RECOVER_ERROR_MESSAGE_BY_CODE, code) ?? RECOVER_ERROR_MESSAGE_FALLBACK
}

export const APPROVAL_DECISION_ERROR_MESSAGE_FALLBACK = '操作に失敗しました'

/**
 * `PATCH /api/approval-requests/:id/status` の拒否 `code` ごとの文言。
 * この route も `HUMAN_ONLY_ROUTES`（C-02）なので、API の認証構成が人と自動を区別できないと 403 になる。
 */
const APPROVAL_DECISION_ERROR_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS:
    '承認・却下はCEO専用の操作です。現在のAPIの認証設定では実行できません。AI開発チームに確認を依頼してください。',
}

export function formatApprovalDecisionErrorMessage(code: string | null): string {
  return messageForCode(APPROVAL_DECISION_ERROR_MESSAGE_BY_CODE, code) ?? APPROVAL_DECISION_ERROR_MESSAGE_FALLBACK
}
