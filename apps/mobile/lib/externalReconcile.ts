/**
 * 外部成果の取り込み（external completion reconcile）を Mobile の 1 画面から辿るための判定と API 呼び出し。
 *
 * 経路そのものは既存で、ここでは新しい authority・Gate・status を作らない:
 *
 *   0. `POST /api/tasks/:id/reconcile-external-completion/preview` — 読むだけ。取り込みと同じ検査を状態を変えずに行い、
 *      server が git で確かめた変更ファイルと根拠の digest を返す
 *   1. `POST /api/approval-requests` — `reconcile_external_completion` の ApprovalRequest を起票する（WAITING_FOR_USER）。
 *      `targetCommit` = 取り込む commit、`targetDiffHash` = 根拠の digest。**承認をこの commit・この根拠に束縛する**
 *   2. 人（CEO）が承認する（`PATCH /api/approval-requests/:id/status`、human-only。approval_actor=human を記録）
 *   3. `POST /api/tasks/:id/reconcile-external-completion` — 確認した根拠そのものを送る。API が根拠・blocked Job・
 *      承認（Task / action / 期限 / human / commit）をすべて確かめ直してから既存の completion transition で done にする
 *
 * 根拠（PR・CI・Independent Review 等）は外部セッションの AI が「取り込みパッケージ」（JSON）として CEO に渡し、
 * CEO が Task 画面へ貼り付ける。**AI は ADMIN 認証情報を持たず、API も呼ばない**。起票・承認・実行はすべて
 * CEO の端末（ADMIN）から行う。ワンタップ中止（`lib/taskAbort.ts`）と同じく、1 回の確認ダイアログの後ろで 0→1→2→3 を順に呼ぶ。
 *
 * 承認状態は `TaskDetail.humanTaskDecisions`（API が期限・決定主体を確定した事実）から読み、
 * 束縛の照合（commit・digest）だけ ApprovalRequest の記述欄を見る。実行可否の正本は API である。
 */

import type { ApprovalRequest, TaskHumanDecisionFact } from '@ai-team/shared'

import { apiFetch } from './api'
import { approvalGateDecisionPath, buildApprovalGateDecisionBody } from './approvalGateDecision'
import { formatApprovalDecisionErrorMessage } from './resumeErrorMessage'
import { taskNumberLabel } from './taskNumber'
import { readApiRejection } from './taskRecovery'

/** backend の action 文字列（`requiredApprovalRequestAction('reconcile_external_completion')`）。 */
export const RECONCILE_ACTION = 'reconcile_external_completion'

/** 取り込みパッケージの形式名。AI が出す JSON の `kind`。 */
export const RECONCILE_PACKAGE_KIND = 'aiteamos.external_completion.v1'

/** 起票・承認の監査理由。「Mobile の 1 画面から CEO が実行した」こと自体を残す。 */
export const MOBILE_RECONCILE_APPROVE_REASON = 'CEO が Mobile の「外部成果を承認して完了登録」から承認'

export const RECONCILE_BUTTON_LABEL = '外部成果を承認して完了登録'

export interface ExternalCompletionEvidence {
  roadmapItemId: string
  commitSha: string
  pullRequestUrl: string
  independentReviewVerdict: string
  ciResult: string
  acceptanceEvidence: string
  approvedScope: string
}

/** AI が CEO に渡す取り込みパッケージ。 */
export interface ReconcilePackage {
  taskId: string
  sourceJobId: string
  evidence: ExternalCompletionEvidence
}

const EVIDENCE_KEYS: ReadonlyArray<keyof ExternalCompletionEvidence> = [
  'roadmapItemId',
  'commitSha',
  'pullRequestUrl',
  'independentReviewVerdict',
  'ciResult',
  'acceptanceEvidence',
  'approvedScope',
]

export type ParsePackageResult = { ok: true; value: ReconcilePackage } | { ok: false; message: string }

/**
 * 貼り付けられた文字列を読む。**JSON そのもの**（前後の空白と ``` の囲みだけ許す）でなければ読まない ——
 * 文中から `{…}` を探して拾うと、別の JSON を取り違えるため（#409 と同じ理由）。
 * 余計な key も受け付けない（API の `.strict()` と同じ）。
 */
export function parseReconcilePackage(text: string, screenTaskId: string): ParsePackageResult {
  const unfenced = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1').trim()
  let raw: unknown
  try {
    raw = JSON.parse(unfenced)
  } catch {
    return { message: '取り込みパッケージを JSON として読めませんでした。AI から受け取った内容をそのまま貼り付けてください。', ok: false }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { message: '取り込みパッケージの形式が違います。', ok: false }
  }
  const record = raw as Record<string, unknown>
  const allowedTop = new Set(['kind', 'taskId', 'sourceJobId', 'evidence'])
  const extraTop = Object.keys(record).filter((key) => !allowedTop.has(key))
  if (record.kind !== RECONCILE_PACKAGE_KIND || extraTop.length > 0) {
    return { message: `取り込みパッケージの形式が違います（kind は "${RECONCILE_PACKAGE_KIND}"）。`, ok: false }
  }
  if (typeof record.taskId !== 'string' || record.taskId !== screenTaskId) {
    return { message: 'このパッケージは別の Task のものです。対象の Task 画面で貼り付けてください。', ok: false }
  }
  if (typeof record.sourceJobId !== 'string' || record.sourceJobId.trim() === '') {
    return { message: '取り込みパッケージに sourceJobId がありません。', ok: false }
  }
  const evidence = record.evidence
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return { message: '取り込みパッケージに evidence がありません。', ok: false }
  }
  const evidenceRecord = evidence as Record<string, unknown>
  const extraEvidence = Object.keys(evidenceRecord).filter((key) => !(EVIDENCE_KEYS as readonly string[]).includes(key))
  const missing = EVIDENCE_KEYS.filter((key) => typeof evidenceRecord[key] !== 'string' || (evidenceRecord[key] as string).trim() === '')
  if (extraEvidence.length > 0) {
    return { message: `evidence に想定外の項目があります: ${extraEvidence.join(', ')}`, ok: false }
  }
  if (missing.length > 0) {
    return { message: `evidence に足りない項目があります: ${missing.join(', ')}`, ok: false }
  }
  const picked = Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, (evidenceRecord[key] as string).trim()]))
  return {
    ok: true,
    value: {
      evidence: picked as unknown as ExternalCompletionEvidence,
      sourceJobId: record.sourceJobId.trim(),
      taskId: record.taskId,
    },
  }
}

/** `POST …/preview` の応答（API `ExternalCompletionPreview`）。 */
export interface ReconcilePreview {
  task: { id: string; title: string; status: string; parked: boolean; roadmapTaskKey: string | null }
  eligible: boolean
  problems: string[]
  verification:
    | { ok: true; changedFiles: string[]; codeOwnedFiles: string[] | null; stableHead: string }
    | { ok: false; reason: string }
  sourceJobValid: boolean
  blockingJobIds: string[]
  evidenceDigest: string
  approvalTargetDiffHash: string
}

function isPreview(value: unknown): value is ReconcilePreview {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ReconcilePreview>
  return typeof record.eligible === 'boolean'
    && Array.isArray(record.problems)
    && typeof record.approvalTargetDiffHash === 'string'
    && record.approvalTargetDiffHash.length > 0
    && typeof record.task === 'object' && record.task !== null
    && typeof record.verification === 'object' && record.verification !== null
}

export const RECONCILE_PREVIEW_FAILED_MESSAGE = '取り込み内容を確認できませんでした。通信状態を確認して、もう一度お試しください。'

export type FetchPreviewResult = { ok: true; preview: ReconcilePreview } | { ok: false; message: string }

export async function fetchReconcilePreview(pkg: ReconcilePackage): Promise<FetchPreviewResult> {
  try {
    const response = await apiFetch(`/api/tasks/${encodeURIComponent(pkg.taskId)}/reconcile-external-completion/preview`, {
      body: JSON.stringify({ evidence: pkg.evidence, sourceJobId: pkg.sourceJobId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (response.status === 200) {
      const body: unknown = await response.json().catch(() => undefined)
      if (isPreview(body)) return { ok: true, preview: body }
    }
    if (response.status === 404) return { message: 'Task が見つかりませんでした。', ok: false }
    return { message: RECONCILE_PREVIEW_FAILED_MESSAGE, ok: false }
  } catch {
    return { message: RECONCILE_PREVIEW_FAILED_MESSAGE, ok: false }
  }
}

/** 画面に出す 1 行。`verified` = API が repository / DB で確かめた / `claimed` = AI の申告（機械照合なし）/ `problem` = 満たさない。 */
export interface ReconcileEvidenceLine {
  label: string
  value: string
  source: 'verified' | 'claimed' | 'problem'
}

/**
 * 確認画面の内容。何が API に確かめられ、何が AI の申告のままかを分けて見せる。
 * 「この画面で承認する」ことが CEO の判断そのものになるので、承認対象をここで言い切る。
 */
export function reconcileEvidenceLines(pkg: ReconcilePackage, preview: ReconcilePreview): ReconcileEvidenceLine[] {
  const number = taskNumberLabel(preview.task.id)
  const verified = preview.verification.ok ? preview.verification : null
  const lines: ReconcileEvidenceLine[] = [
    { label: 'Task', source: 'verified', value: `${preview.task.title}${number === null ? '' : `（${number}）`}` },
    { label: 'Roadmap item', source: verified ? 'verified' : 'problem', value: pkg.evidence.roadmapItemId },
    {
      label: 'commit',
      source: verified ? 'verified' : 'problem',
      value: verified ? `${pkg.evidence.commitSha}（本番に反映済みのコードに含まれることを確認）` : pkg.evidence.commitSha,
    },
    {
      label: '変更ファイル',
      source: verified ? 'verified' : 'problem',
      value: verified ? verified.changedFiles.join('\n') : '（確認できませんでした）',
    },
    {
      label: 'Code Owner 対象（保護範囲）',
      source: verified ? (verified.codeOwnedFiles === null ? 'problem' : 'verified') : 'problem',
      value: verified
        ? (verified.codeOwnedFiles === null
          ? '（CODEOWNERS を読めませんでした）'
          : (verified.codeOwnedFiles.length === 0 ? 'なし' : verified.codeOwnedFiles.join('\n')))
        : '（確認できませんでした）',
    },
    { label: 'PR', source: 'claimed', value: pkg.evidence.pullRequestUrl },
    { label: 'Independent Review', source: verified ? 'verified' : 'problem', value: pkg.evidence.independentReviewVerdict },
    { label: 'CI', source: 'claimed', value: pkg.evidence.ciResult },
    { label: '受入根拠', source: 'claimed', value: pkg.evidence.acceptanceEvidence },
    { label: '許可された範囲', source: 'claimed', value: pkg.evidence.approvedScope },
  ]
  for (const problem of preview.problems) lines.push({ label: '満たしていない条件', source: 'problem', value: problem })
  return lines
}

export const RECONCILE_SOURCE_LABEL: Readonly<Record<ReconcileEvidenceLine['source'], string>> = {
  claimed: 'AI申告（機械照合なし）',
  problem: '未確認・不備',
  verified: 'APIが確認',
}

/** 画面の状態から見た、この Task の取り込み承認。束縛（commit・digest）が一致するものだけ再利用する。 */
export type ReconcileApprovalState =
  | { kind: 'none' }
  | { kind: 'waiting'; approvalRequestId: string }
  | { kind: 'approved'; approvalRequestId: string }

/**
 * 再利用できる取り込み承認を探す。`humanTaskDecisions`（期限切れ・主体の記録の無い APPROVED は API が除いている）に
 * 載っていて、**同じ commit・同じ根拠の digest** で起票された依頼だけを使う。根拠が違う依頼は使わない
 * （新しく起票すると置き換えられる）。
 */
export function reconcileApprovalState(
  humanTaskDecisions: readonly TaskHumanDecisionFact[] | undefined,
  approvalRequests: readonly Pick<ApprovalRequest, 'id' | 'targetCommit' | 'targetDiffHash' | 'requestedAction'>[],
  commitSha: string,
  approvalTargetDiffHash: string,
): ReconcileApprovalState {
  const bound = new Set(
    approvalRequests
      .filter((request) => request.requestedAction === RECONCILE_ACTION
        && request.targetCommit === commitSha
        && request.targetDiffHash === approvalTargetDiffHash)
      .map((request) => request.id),
  )
  const related = (humanTaskDecisions ?? [])
    .filter((decision) => decision.requestedAction === RECONCILE_ACTION && bound.has(decision.approvalRequestId))
  const approved = related.find((decision) => decision.state === 'approved')
  if (approved !== undefined) return { approvalRequestId: approved.approvalRequestId, kind: 'approved' }
  const waiting = related.find((decision) => decision.state === 'waiting')
  if (waiting !== undefined) return { approvalRequestId: waiting.approvalRequestId, kind: 'waiting' }
  return { kind: 'none' }
}

export function buildReconcileApprovalRequestBody(pkg: ReconcilePackage, preview: ReconcilePreview): {
  taskId: string
  targetBranch: string
  targetCommit: string
  targetDiffHash: string
  riskLevel: 'HIGH'
  requestedAction: typeof RECONCILE_ACTION
  invalidIf: string[]
  reason: string
} {
  return {
    invalidIf: [],
    reason: `外部成果の完了登録: ${pkg.evidence.pullRequestUrl}（commit ${pkg.evidence.commitSha}）。CEO が Mobile で根拠を確認して起票`,
    requestedAction: RECONCILE_ACTION,
    riskLevel: 'HIGH',
    targetBranch: 'external-completion',
    targetCommit: pkg.evidence.commitSha,
    targetDiffHash: preview.approvalTargetDiffHash,
    taskId: pkg.taskId,
  }
}

export function buildReconcileBody(pkg: ReconcilePackage, approvalRequestId: string): {
  approvalRequestId: string
  sourceJobId: string
  evidence: ExternalCompletionEvidence
} {
  return { approvalRequestId, evidence: pkg.evidence, sourceJobId: pkg.sourceJobId }
}
export type ReconcileStage = 'check' | 'create' | 'approve' | 'execute'

export const RECONCILE_PROGRESS_TEXT: Readonly<Record<ReconcileStage, string>> = {
  approve: '承認を記録しています…',
  check: 'Task の状態を確認しています…',
  create: '取り込みの承認依頼を作成しています…',
  execute: '完了登録を実行しています…',
}

export const RECONCILE_NOT_EXECUTED_NOTE = '完了登録は実行されていません。'
export const RECONCILE_DONE_MESSAGE = '外部成果をこのTaskの完了として登録しました。'
export const RECONCILE_ALREADY_DONE_MESSAGE = 'このTaskは既に完了登録されています（二重には登録されません）。'
export const RECONCILE_UNKNOWN_RESULT_MESSAGE =
  '完了登録の結果を受け取れませんでした。画面を更新して、Task が「完了」になったか確認してください。'
  + '完了になっていなければ、もう一度このボタンを押してください（同じ承認を使い、二重には登録されません）。'
export const RECONCILE_CHANGED_MESSAGE =
  '確認した時から内容が変わりました。更新した内容をもう一度確認してから、ボタンを押してください。'
export const RECONCILE_STALE_MESSAGE =
  '確認した時から承認依頼の状況が変わったため、完了登録を止めました。もう一度ボタンを押して内容を確認してください。'

export type CreateResult = { ok: true; approvalRequestId: string } | { ok: false; message: string }
export type ApproveResult = { ok: true } | { ok: false; code?: string | null; message: string }
export type ExecuteResult =
  | { ok: true; message: string }
  | { ok: false; outcome: 'refused' | 'unknown'; message: string }

export async function createReconcileApprovalRequest(pkg: ReconcilePackage, preview: ReconcilePreview): Promise<CreateResult> {
  const failed = `取り込みの承認依頼を作成できませんでした。${RECONCILE_NOT_EXECUTED_NOTE}`
  try {
    const response = await apiFetch('/api/approval-requests', {
      body: JSON.stringify(buildReconcileApprovalRequestBody(pkg, preview)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (response.status === 201) {
      const id = ((await response.json().catch(() => ({}))) as { id?: unknown }).id
      if (typeof id === 'string' && id.length > 0) return { approvalRequestId: id, ok: true }
      // 201 = 作成済み。id が読めなくても、もう一度押せば同じ commit・digest の依頼を見つけて再利用する。
      return { message: `承認依頼は作成されましたが、応答を読み取れませんでした。画面を更新してもう一度押してください。${RECONCILE_NOT_EXECUTED_NOTE}`, ok: false }
    }
    return { message: failed, ok: false }
  } catch {
    return { message: failed, ok: false }
  }
}

export async function approveReconcileApprovalRequest(approvalRequestId: string): Promise<ApproveResult> {
  const prefix = '取り込みの承認を記録できませんでした。'
  try {
    const response = await apiFetch(approvalGateDecisionPath(approvalRequestId), {
      body: JSON.stringify(buildApprovalGateDecisionBody('APPROVED', MOBILE_RECONCILE_APPROVE_REASON)),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    })
    if (response.ok) return { ok: true }
    const { code } = await readApiRejection(response)
    return { code, message: `${prefix}${formatApprovalDecisionErrorMessage(code)}`, ok: false }
  } catch {
    return { message: `${prefix}${formatApprovalDecisionErrorMessage(null)}`, ok: false }
  }
}

/**
 * 取り込みを実行する。**二重登録の防止は API にある**（done の Task は route と storage の transaction の
 * 両方が断る）。拒否・不明のときに「既に done か」を決めるのは応答の文面ではなく、runner が Task を読み直した結果である。
 */
export async function submitReconcile(pkg: ReconcilePackage, approvalRequestId: string): Promise<ExecuteResult> {
  try {
    const response = await apiFetch(`/api/tasks/${encodeURIComponent(pkg.taskId)}/reconcile-external-completion`, {
      body: JSON.stringify(buildReconcileBody(pkg, approvalRequestId)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (response.status === 200) return { message: RECONCILE_DONE_MESSAGE, ok: true }
    if (response.status >= 500) return { message: RECONCILE_UNKNOWN_RESULT_MESSAGE, ok: false, outcome: 'unknown' }
    const { error } = await readApiRejection(response)
    const detail = error === null ? '' : `\n理由: ${error}`
    return { message: `完了登録は拒否されました。${RECONCILE_NOT_EXECUTED_NOTE}${detail}`, ok: false, outcome: 'refused' }
  } catch {
    return { message: RECONCILE_UNKNOWN_RESULT_MESSAGE, ok: false, outcome: 'unknown' }
  }
}

/** 読み直した Task の状態（画面の古い表示で判断しない）。 */
export interface ReconcileFreshState {
  taskStatus: string
  humanTaskDecisions: readonly TaskHumanDecisionFact[] | undefined
  approvalRequests: readonly ApprovalRequest[]
}

/**
 * 新しく起票すると置き換えられる（SUPERSEDED になる）承認依頼。API の `replaceActiveAndCreate()` の規則
 * —— その Task の承認待ち（action を問わない）と、同じ action の承認済み —— をそのまま写す。
 * 再利用できる依頼があるとき（起票しない）は何も置き換えない。
 */
export function approvalRequestsReplacedByCreate(
  state: Pick<ReconcileFreshState, 'approvalRequests'>,
  approval: ReconcileApprovalState,
): string[] {
  if (approval.kind !== 'none') return []
  return state.approvalRequests
    .filter((request) => request.status === 'WAITING_FOR_USER'
      || (request.status === 'APPROVED' && request.requestedAction === RECONCILE_ACTION))
    .map((request) => `${request.id}（${request.requestedAction}）`)
}

/** 確認ダイアログの題。 */
export const RECONCILE_CONFIRM_TITLE = '外部成果を承認して完了登録しますか？'

/** 確認ダイアログの本文。何を承認するか（Task・commit・PR・効果・置き換える依頼）を言い切る。 */
export function reconcileConfirmMessage(
  pkg: ReconcilePackage,
  preview: ReconcilePreview,
  approval: ReconcileApprovalState,
  replaced: readonly string[],
): string {
  const number = taskNumberLabel(preview.task.id)
  const files = preview.verification.ok ? preview.verification.changedFiles.length : 0
  const lines = [
    `「${preview.task.title}」${number === null ? '' : `（${number}）`}`,
    '',
    `・commit ${pkg.evidence.commitSha}（${files} ファイル）と PR ${pkg.evidence.pullRequestUrl} を、このTaskの完了として登録します。`,
    '・この成果は AI 開発チームの外で実装・レビュー・本番反映されたものです。この操作は実装もファイル変更も行いません。',
    '・登録後このTaskは「完了」になり、元に戻す操作はありません。Roadmap は次の作業へ進みます。',
  ]
  if (approval.kind === 'approved') {
    lines.push(`・この内容に対して承認済みの依頼 ${approval.approvalRequestId} を使って実行します。`)
  } else if (approval.kind === 'waiting') {
    lines.push(`・この内容の承認待ちの依頼 ${approval.approvalRequestId} を、あなた（CEO）の承認として承認してから実行します。`)
  } else {
    lines.push('・この内容に対する承認依頼を作成し、あなた（CEO）の承認として記録してから実行します。')
    if (replaced.length > 0) {
      lines.push(`・そのため次の依頼は置き換えられ、使えなくなります: ${replaced.join('、')}`)
    }
  }
  return lines.join('\n')
}

/** 表示した確認内容と、いまの preview が同じか（違えば確認し直してもらう）。 */
function previewSnapshot(preview: ReconcilePreview): string {
  return JSON.stringify([preview.approvalTargetDiffHash, preview.eligible, preview.problems, preview.verification])
}

export interface ReconcileDeps {
  preview: (pkg: ReconcilePackage) => Promise<FetchPreviewResult>
  loadState: (taskId: string) => Promise<ReconcileFreshState | null>
  createRequest: (pkg: ReconcilePackage, preview: ReconcilePreview) => Promise<CreateResult>
  approveRequest: (approvalRequestId: string) => Promise<ApproveResult>
  execute: (pkg: ReconcilePackage, approvalRequestId: string) => Promise<ExecuteResult>
  onProgress?: (stage: ReconcileStage) => void
}

/** CEO が確認ダイアログで承認する内容（この内容だけを実行する）。 */
export interface ReconcileConfirmation {
  pkg: ReconcilePackage
  preview: ReconcilePreview
  approval: ReconcileApprovalState
  replaced: string[]
  message: string
}

export type PrepareResult =
  | { kind: 'confirm'; confirmation: ReconcileConfirmation }
  | { kind: 'changed'; preview: ReconcilePreview; message: string }
  | { kind: 'already_done'; message: string }
  | { kind: 'error'; message: string }

/**
 * ボタンを押した時点で preview と Task を**読み直し、その結果から**確認ダイアログを作る。
 * 表示中の内容（変更ファイル・Code Owner 対象・Stable HEAD・不備・digest）と違えば、ダイアログを出さずに
 * 画面を更新して確認し直してもらう（Codex design review: 古い表示のまま承認させない）。
 */
export async function prepareReconcileConfirmation(
  pkg: ReconcilePackage,
  displayed: ReconcilePreview,
  deps: Pick<ReconcileDeps, 'preview' | 'loadState'>,
): Promise<PrepareResult> {
  try {
    const state = await deps.loadState(pkg.taskId)
    if (state === null) return { kind: 'error', message: `Task の状態を読めませんでした。${RECONCILE_NOT_EXECUTED_NOTE}` }
    if (state.taskStatus === 'done') return { kind: 'already_done', message: RECONCILE_ALREADY_DONE_MESSAGE }
    const fresh = await deps.preview(pkg)
    if (!fresh.ok) return { kind: 'error', message: `${fresh.message}\n${RECONCILE_NOT_EXECUTED_NOTE}` }
    if (previewSnapshot(fresh.preview) !== previewSnapshot(displayed)) {
      return { kind: 'changed', message: RECONCILE_CHANGED_MESSAGE, preview: fresh.preview }
    }
    if (!fresh.preview.eligible) return { kind: 'error', message: `条件を満たしていません。${RECONCILE_NOT_EXECUTED_NOTE}` }
    const approval = reconcileApprovalState(
      state.humanTaskDecisions, state.approvalRequests, pkg.evidence.commitSha, fresh.preview.approvalTargetDiffHash,
    )
    const replaced = approvalRequestsReplacedByCreate(state, approval)
    return {
      confirmation: {
        approval,
        message: reconcileConfirmMessage(pkg, fresh.preview, approval, replaced),
        pkg,
        preview: fresh.preview,
        replaced,
      },
      kind: 'confirm',
    }
  } catch {
    return { kind: 'error', message: `通信に失敗しました。${RECONCILE_NOT_EXECUTED_NOTE}` }
  }
}

export type ReconcileRunResult =
  | { ok: true; approvalRequestId?: string; message: string; outcome: 'done' | 'already_done' }
  | { ok: false; stage: ReconcileStage; approvalRequestId?: string; message: string }

/**
 * CEO が確認した内容（`ReconcileConfirmation`）で (起票) → (承認) → 実行を順に呼び、最初の失敗で止める。
 *
 * - **既に done なら何もしない**（成功として返す。前回の実行が通信断の後ろで成立していた場合）
 * - 同じ commit・digest の承認があれば再利用する（承認済みなら実行だけ・承認待ちなら承認して実行）。もう 1 件作らない
 * - **確認ダイアログを作った時と承認の状況が違えば止める**（使う依頼が変わった・却下された・期限切れになった等。
 *   黙って起票し直すと、CEO が見ていない承認で実行することになる）。確認時に示さなかった依頼を置き換えることになる場合も止める
 * - 実行が拒否・不明に終わったら Task を読み直し、done なら成功（二重には登録されない）として返す
 */
export async function runOneScreenReconcile(
  confirmation: Pick<ReconcileConfirmation, 'pkg' | 'preview' | 'approval' | 'replaced'>,
  deps: Omit<ReconcileDeps, 'preview'>,
): Promise<ReconcileRunResult> {
  const { pkg, preview } = confirmation
  let stage: ReconcileStage = 'check'
  let approvalRequestId: string | undefined
  try {
    deps.onProgress?.('check')
    const state = await deps.loadState(pkg.taskId)
    if (state === null) {
      return { message: `Task の状態を読めませんでした。${RECONCILE_NOT_EXECUTED_NOTE}`, ok: false, stage }
    }
    if (state.taskStatus === 'done') return { message: RECONCILE_ALREADY_DONE_MESSAGE, ok: true, outcome: 'already_done' }

    const approval = reconcileApprovalState(
      state.humanTaskDecisions, state.approvalRequests, pkg.evidence.commitSha, preview.approvalTargetDiffHash,
    )
    if (!sameApprovalState(approval, confirmation.approval)) {
      return { message: RECONCILE_STALE_MESSAGE, ok: false, stage }
    }
    if (approval.kind === 'none') {
      const disclosed = new Set(confirmation.replaced)
      if (approvalRequestsReplacedByCreate(state, approval).some((id) => !disclosed.has(id))) {
        return { message: RECONCILE_STALE_MESSAGE, ok: false, stage }
      }
      stage = 'create'
      deps.onProgress?.('create')
      const created = await deps.createRequest(pkg, preview)
      if (!created.ok) return { message: created.message, ok: false, stage }
      approvalRequestId = created.approvalRequestId
    } else {
      approvalRequestId = approval.approvalRequestId
    }

    if (approval.kind !== 'approved') {
      stage = 'approve'
      deps.onProgress?.('approve')
      const approved = await deps.approveRequest(approvalRequestId)
      if (!approved.ok) {
        return {
          approvalRequestId,
          message: `${approved.message}\n${RECONCILE_NOT_EXECUTED_NOTE}画面を更新して、もう一度このボタンを押してください。`,
          ok: false,
          stage,
        }
      }
    }

    stage = 'execute'
    deps.onProgress?.('execute')
    let result: ExecuteResult
    try {
      result = await deps.execute(pkg, approvalRequestId)
    } catch {
      result = { message: RECONCILE_UNKNOWN_RESULT_MESSAGE, ok: false, outcome: 'unknown' }
    }
    if (result.ok) return { approvalRequestId, message: result.message, ok: true, outcome: 'done' }
    // 拒否・不明でも、前回（または今回）の実行で既に done になっていれば成功として扱う（二重には登録されていない）。
    const after = await deps.loadState(pkg.taskId).catch(() => null)
    if (after?.taskStatus === 'done') {
      return { approvalRequestId, message: RECONCILE_ALREADY_DONE_MESSAGE, ok: true, outcome: 'already_done' }
    }
    return { approvalRequestId, message: result.message, ok: false, stage }
  } catch {
    const message = stage === 'execute' ? RECONCILE_UNKNOWN_RESULT_MESSAGE : `通信に失敗しました。${RECONCILE_NOT_EXECUTED_NOTE}`
    return { ...(approvalRequestId === undefined ? {} : { approvalRequestId }), message, ok: false, stage }
  }
}

function sameApprovalState(a: ReconcileApprovalState, b: ReconcileApprovalState): boolean {
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind
  return a.kind === b.kind && a.approvalRequestId === b.approvalRequestId
}

/** 二重送信を防ぐ runner（描画の反映前の 2 回押し対策。`createOneTapAbortRunner` と同じ）。 */
export function createOneScreenReconcileRunner(deps: Omit<ReconcileDeps, 'preview'>): {
  isRunning: () => boolean
  run: (confirmation: Pick<ReconcileConfirmation, 'pkg' | 'preview' | 'approval' | 'replaced'>) => Promise<ReconcileRunResult | null>
} {
  let running = false
  return {
    isRunning: () => running,
    run: async (confirmation) => {
      if (running) return null
      running = true
      try {
        return await runOneScreenReconcile(confirmation, deps)
      } finally {
        running = false
      }
    },
  }
}

/**
 * 取り込み欄を出すか。**park された未完了の Task だけ**（外部完了は abort_task で park してから取り込む既存手順。
 * blocked Job が残る Task は API が `TASK_HAS_BLOCKED_JOBS` で断る）。`parked` が読めない（古い API）なら出さない。
 * park されていない Task の取り込みは、これまでどおり API の多段手順で行える（この画面の対象外）。
 */
export function canShowReconcileUI(task: { status: string; parked?: boolean }): boolean {
  return task.status !== 'done' && task.parked === true
}
