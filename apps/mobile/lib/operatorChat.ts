/**
 * Operator Chat（Mobile から PL への質問・依頼）の表示・送信ロジック。
 *
 * **使う route は共通 Operator Interface の route だけ**（`operator-chat-mobile`・CEO 方針 2026-09-29）:
 * - `GET /api/operator/state` … projection 済みの現在状態
 * - `POST /api/operator-requests` … 質問・依頼の作成（record の保存だけ）
 * - `GET /api/operator-requests` … 最近の依頼と結果（回答待ちの間はこれを polling する）
 *
 * Mobile は ADMIN credential を持っているが、この画面からそれ以外の route（resume・approval 等）は
 * 呼ばない。実際に何をするか（しないか）は PL が既存の Gate を通して決める。依頼本文で action の
 * 種類を指定する項目は無い（API 側も strict schema で拒否する）。
 *
 * React Native に依存させない（vitest でそのまま検証するため）。fetch は呼び出し側から渡す。
 */

import { OPERATOR_REQUEST_MESSAGE_MAX_LENGTH } from '@ai-team/shared'
import type {
  OperatorRequest,
  OperatorRequestDisposition,
  OperatorRequestKind,
  OperatorRequestPlAction,
} from '@ai-team/shared'

export const OPERATOR_STATE_PATH = '/api/operator/state'
export const OPERATOR_REQUESTS_PATH = '/api/operator-requests'
/** 「最近の依頼」に出す件数。 */
export const RECENT_REQUEST_LIMIT = 10

// ────────────────────────────────────────────────────────────
// 現在状態（`GET /api/operator/state` の projection のうち画面で使う部分）
// ────────────────────────────────────────────────────────────

export interface OperatorAttentionItem {
  kind: string
  projectId: string
  projectName?: string
  taskId?: string
  jobId?: string
  referenceId?: string
  detail?: string
  stuckForMs?: number
}

export interface OperatorStateView {
  running: number
  blocked: number
  approvalsWaiting: number
  attention: OperatorAttentionItem[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function parseOperatorState(json: unknown): OperatorStateView {
  const root = asRecord(json) ?? {}
  const totals = asRecord(root.totals) ?? {}
  const jobs = asRecord(totals.jobs) ?? {}
  const attention = Array.isArray(root.attention) ? root.attention : []

  return {
    running: asCount(jobs.running),
    blocked: asCount(jobs.blocked),
    approvalsWaiting: asCount(totals.approvalsWaiting),
    attention: attention.flatMap((raw): OperatorAttentionItem[] => {
      const item = asRecord(raw)
      const kind = asOptionalString(item?.kind)
      const projectId = asOptionalString(item?.projectId)
      if (item === undefined || kind === undefined || projectId === undefined) return []
      return [{
        kind,
        projectId,
        projectName: asOptionalString(item.projectName),
        taskId: asOptionalString(item.taskId),
        jobId: asOptionalString(item.jobId),
        referenceId: asOptionalString(item.referenceId),
        detail: asOptionalString(item.detail),
        stuckForMs: typeof item.stuckForMs === 'number' ? item.stuckForMs : undefined,
      }]
    }),
  }
}

const ATTENTION_KIND_LABEL: Record<string, string> = {
  job_blocked: 'Job 停止',
  job_failed: 'Job 失敗',
  workspace_quarantined: 'workspace 隔離',
  approval_waiting: '承認待ち',
  design_review_failed: 'Design Review 失敗',
  design_review_idle: 'Design Review 未実行',
  continuation_pending: '継続処理待ち',
  task_ready_without_job: 'Job 未作成',
  task_blocked_without_job: 'Task 停止（Job なし）',
  job_running_long: '長時間実行中',
}

export function attentionKindLabel(kind: string): string {
  return ATTENTION_KIND_LABEL[kind] ?? kind
}

/** attention を一意に指す画面用のキー（選択状態の保持に使う。API へは送らない）。 */
export function attentionItemKey(item: OperatorAttentionItem): string {
  return [item.kind, item.projectId, item.taskId ?? '', item.jobId ?? '', item.referenceId ?? ''].join('|')
}

// ────────────────────────────────────────────────────────────
// 送信 body
// ────────────────────────────────────────────────────────────

/**
 * 依頼の対象。attention を選んだときだけ設定する。
 *
 * targetKey は送らない。`projectId` / `taskId` で範囲を絞れば、PL がその範囲の現在の attention
 * 候補からだけ対象を選ぶ（任意の ID は作らない。候補が無ければ実行しない）。
 */
export interface OperatorRequestTarget {
  projectId: string
  taskId?: string
}

export function targetFromAttention(item: OperatorAttentionItem): OperatorRequestTarget {
  return item.taskId !== undefined
    ? { projectId: item.projectId, taskId: item.taskId }
    : { projectId: item.projectId }
}

export interface OperatorRequestDraft {
  /** 既定値を置かない。null のままでは送信できない。 */
  kind: OperatorRequestKind | null
  message: string
  target: OperatorRequestTarget | null
}

export interface OperatorRequestBody {
  kind: OperatorRequestKind
  message: string
  projectId?: string
  taskId?: string
}

export type BuildBodyResult =
  | { ok: true; body: OperatorRequestBody }
  | { ok: false; error: string }

export function buildOperatorRequestBody(draft: OperatorRequestDraft): BuildBodyResult {
  if (draft.kind !== 'question' && draft.kind !== 'request') {
    return { ok: false, error: '「質問」か「依頼」を選んでください' }
  }
  const message = draft.message.trim()
  if (message === '') {
    return { ok: false, error: '内容を入力してください' }
  }
  if (message.length > OPERATOR_REQUEST_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `${OPERATOR_REQUEST_MESSAGE_MAX_LENGTH}文字以内で入力してください` }
  }

  const body: OperatorRequestBody = { kind: draft.kind, message }
  if (draft.target !== null) {
    body.projectId = draft.target.projectId
    if (draft.target.taskId !== undefined) body.taskId = draft.target.taskId
  }
  return { ok: true, body }
}

// ────────────────────────────────────────────────────────────
// 結果の表示
// ────────────────────────────────────────────────────────────

/** PL の回答待ちの依頼が1件でもあるときだけ polling する。 */
export function hasPendingRequest(requests: readonly OperatorRequest[]): boolean {
  return requests.some((request) => request.status === 'pending')
}

const DISPOSITION_LABEL: Record<OperatorRequestDisposition, string> = {
  answered: '回答済み',
  acted: '実行済み',
  escalated: 'CEO判断へ回付',
  declined: '実行せず',
}

export function requestStatusLabel(request: Pick<OperatorRequest, 'status' | 'disposition'>): string {
  if (request.status === 'pending') return 'PL 回答待ち'
  if (request.status === 'failed') return '処理失敗'
  return request.disposition !== undefined ? DISPOSITION_LABEL[request.disposition] : '回答済み'
}

export function requestKindLabel(kind: OperatorRequestKind): string {
  return kind === 'question' ? '質問' : '依頼'
}

export function requesterLabel(requesterClass: OperatorRequest['requesterClass']): string {
  return requesterClass === 'operator_gateway' ? 'ChatGPT' : 'Mobile'
}

/** 実行の記録（`plAction`）を表示用の行にする。値はシステムの記録そのまま（PL の文章ではない）。 */
export function plActionLines(plAction: OperatorRequestPlAction): string[] {
  const lines = [
    `対象: ${plAction.targetKey}`,
    `実行: ${plAction.attempted ? 'あり' : 'なし'}（${plAction.status}）`,
  ]
  if (plAction.proposedKind !== undefined) lines.push(`操作: ${plAction.proposedKind}`)
  if (plAction.verification !== undefined) lines.push(`確認: ${plAction.verification}`)
  if (plAction.executionSummary !== undefined) lines.push(`結果: ${plAction.executionSummary}`)
  if (plAction.reason !== undefined) lines.push(`理由: ${plAction.reason}`)
  return lines
}

/** 送信失敗時に見せる文言。API のエラー本文は出さない（固定文だけ）。 */
export function sendErrorMessage(status: number): string {
  if (status === 429) return 'PL の回答待ちの依頼が上限に達しています。回答を待ってから送ってください'
  if (status === 400) return '送信内容が受け付けられませんでした'
  if (status === 401 || status === 403) return '認証に失敗しました（接続設定の token を確認してください）'
  return `送信に失敗しました（HTTP ${status}）`
}

// ────────────────────────────────────────────────────────────
// API 呼び出し（Operator Interface の route だけ）
// ────────────────────────────────────────────────────────────

export type OperatorFetch = (path: string, init?: RequestInit) => Promise<Response>

export class OperatorChatHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

export interface OperatorChatClient {
  getState(): Promise<OperatorStateView>
  listRecent(): Promise<OperatorRequest[]>
  create(body: OperatorRequestBody): Promise<OperatorRequest>
}

export function createOperatorChatClient(fetchFn: OperatorFetch): OperatorChatClient {
  async function readJson(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchFn(path, init)
    if (!response.ok) throw new OperatorChatHttpError(response.status)
    return response.json()
  }

  return {
    async getState() {
      return parseOperatorState(await readJson(OPERATOR_STATE_PATH))
    },
    async listRecent() {
      const json = await readJson(`${OPERATOR_REQUESTS_PATH}?limit=${RECENT_REQUEST_LIMIT}`)
      return Array.isArray(json) ? (json as OperatorRequest[]) : []
    },
    async create(body) {
      return (await readJson(OPERATOR_REQUESTS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })) as OperatorRequest
    },
  }
}
