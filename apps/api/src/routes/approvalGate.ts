import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { getStorage } from '../storage'
import type { ApprovalGateStatus, RiskLevel, ApprovalRequest, GateOutcome, RiskReviewResult } from '@ai-team/shared'
import {
  runRiskReview,
  decideGateOutcome,
  buildApprovalRequest,
  type ApprovalGateInput,
} from '@ai-team/shared'

function computeDiffHash(diffText: string): string {
  return createHash('sha256').update(diffText, 'utf-8').digest('hex')
}

// ────────────────────────────────────────────────────────────
// POST /api/gate/check — ローカル型定義
// ────────────────────────────────────────────────────────────

type SideEffectEvent =
  | { type: 'CREATED_APPROVAL_REQUEST';    requestId: string }
  | { type: 'SUPERSEDED_APPROVAL_REQUEST'; requestId: string }
  | { type: 'MARKED_STALE';               requestId: string }

type ContinuationPolicy =
  | 'continue'
  | 'continue_safe_work_only'
  | 'block_until_approved'

type NextActionKind =
  | 'proceed'
  | 'call_consume'
  | 'wait_for_approval'
  | 're_check'

interface NextAction {
  action: NextActionKind
  consumedRequestId?: string
  requestId?: string
  message: string
}

interface GateCheckResponse {
  outcome:            GateOutcome
  riskReview:         RiskReviewResult
  sideEffects:        SideEffectEvent[]
  continuationPolicy: ContinuationPolicy
  nextAction:         NextAction
  approvalRequest?:   ApprovalRequest
}

// Zod スキーマ
const GateCheckBody = z.object({
  taskId:          z.string().min(1),
  requestedAction: z.string().min(1),
  targetBranch:    z.string().min(1),
  targetCommit:    z.string().min(1),
  targetDiffHash:  z.string().min(1),
  changedFiles:    z.array(z.string()),
  diffText:        z.string().optional(),
  // TODO: 外部公開APIとして使う場合は diffText を必須化し、
  //       サーバー側でハッシュ照合すること（現在は trusted internal caller 専用）
  // Step D 実装済み: diffText 内容スキャン（シークレット検出）→ routes/approvalGate.ts の scanDiffForSecrets()
})

// ────────────────────────────────────────────────────────────
// ヘルパー関数
// ────────────────────────────────────────────────────────────

function computeContinuationPolicy(
  riskLevel: RiskLevel,
  decision: GateOutcome['decision'],
): ContinuationPolicy {
  if (decision === 'ALLOW') return 'continue'

  switch (riskLevel) {
    case 'CRITICAL':
      return 'block_until_approved'
    case 'HIGH':
      return 'continue_safe_work_only'
    case 'LOW':
    case 'MEDIUM':
      // LOW/MEDIUM で ALLOW 以外は内部不整合（decideGateOutcome の設計上発生しえない）
      console.warn(
        `[gate/check] Unexpected: riskLevel=${riskLevel} with decision=${decision}. ` +
        `decideGateOutcome should always return ALLOW for LOW/MEDIUM. Defaulting to continue.`
      )
      return 'continue'
  }
}

function computeNextAction(
  outcome: GateOutcome,
  riskLevel: RiskLevel,
  newRequestId?: string,
): NextAction {
  switch (outcome.decision) {
    case 'ALLOW':
      if (outcome.consumedRequestId) {
        return {
          action: 'call_consume',
          consumedRequestId: outcome.consumedRequestId,
          message: `承認済みです。POST /api/approval-requests/${outcome.consumedRequestId}/consume を呼び出して承認を使い切ってください。`,
        }
      }
      return {
        action: 'proceed',
        message: 'リスクレベルが低いため承認不要。処理を続けてください。',
      }

    case 'PENDING_APPROVAL':
      return {
        action: 'wait_for_approval',
        requestId: outcome.requestId,
        message: riskLevel === 'CRITICAL'
          ? '【CRITICAL】危険な変更を含むため、承認まですべての作業を停止してください。承認者に通知してください。'
          : '承認待ち中です。安全な作業は継続可能ですが、この変更の適用は承認後に行ってください。',
      }

    case 'BLOCKED':
      return {
        action: 'wait_for_approval',
        requestId: newRequestId,
        message: riskLevel === 'CRITICAL'
          ? '【CRITICAL】承認リクエストを作成しました。危険な変更を含むため、承認まですべての作業を停止してください。'
          : '承認リクエストを作成しました。HIGH リスク変更のため人間承認が必要です。安全な作業は継続可能です。',
      }

    case 'STALE':
      return {
        action: 're_check',
        message: '承認が無効化されました（commit/diff が変化）。再度 /api/gate/check を呼び出して新しい承認フローを開始してください。',
      }
  }
}

// ────────────────────────────────────────────────────────────
// Step D: diff内容スキャン（シークレット検出）
// ────────────────────────────────────────────────────────────

interface DiffScanHit {
  /** 検出されたシークレットの種類（値そのものは含まない） */
  label: string
  /** マスクされた行（値部分は *** に置換） */
  maskedLine: string
}

interface DiffScanResult {
  hits: DiffScanHit[]
}

/** 追加行（+始まり）のみを対象とする検出ルール */
const DIFF_SECRET_RULES: Array<{
  label: string
  /** 行全体にマッチ。キャプチャグループ1が値部分（マスク対象） */
  pattern: RegExp
}> = [
  { label: 'API_KEY',        pattern: /\bAPI_KEY\s*[:=]\s*(\S+)/i },
  { label: 'SECRET_KEY',     pattern: /\bSECRET(?:_KEY)?\s*[:=]\s*(\S+)/i },
  { label: 'PASSWORD',       pattern: /\bPASSWORD\s*[:=]\s*(\S+)/i },
  { label: 'ACCESS_TOKEN',   pattern: /\bACCESS_TOKEN\s*[:=]\s*(\S+)/i },
  { label: 'AUTH_TOKEN',     pattern: /\bAUTH_TOKEN\s*[:=]\s*(\S+)/i },
  { label: 'PRIVATE_KEY',    pattern: /\bPRIVATE_KEY\s*[:=]\s*(\S+)/i },
  { label: 'ACCESS_KEY_ID',  pattern: /\bACCESS_KEY(?:_ID)?\s*[:=]\s*(\S+)/i },
  { label: 'WEBHOOK_URL',    pattern: /\bWEBHOOK_URL\s*[:=]\s*(\S+)/i },
  { label: 'DATABASE_URL',   pattern: /\bDATABASE_URL\s*[:=]\s*(\S+)/i },
  { label: 'PEM private key', pattern: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/ },
  // .env 追加行に値付きの代入がある場合（KEY=VALUE 形式、値が16文字以上のランダム文字列）
  { label: 'env assignment (long value)', pattern: /^[A-Z][A-Z0-9_]{3,}=([A-Za-z0-9+/=_\-]{16,})$/ },
]

/**
 * diffText の追加行（+で始まる行）をスキャンしてシークレット疑いを検出する。
 * 値そのものはレスポンスに含めず、マスク済み行のみ返す。
 */
function scanDiffForSecrets(diffText: string): DiffScanResult {
  const hits: DiffScanHit[] = []
  const addedLines = diffText
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1)) // '+' を除いた実際の内容

  for (const line of addedLines) {
    for (const rule of DIFF_SECRET_RULES) {
      const m = rule.pattern.exec(line)
      if (!m) continue
      // キャプチャグループ1があれば値部分をマスク、なければ行全体をマスク
      const maskedLine = m[1]
        ? line.replace(m[1], '***')
        : line.replace(m[0], m[0].replace(/=.*/, '=***'))
      hits.push({ label: rule.label, maskedLine })
      break // 同一行で複数ルールがヒットしても1件にする
    }
  }

  return { hits }
}

const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

// Codex P2: expiresAt はサーバー側で riskLevel から計算する（呼び出し元に任せない）
const EXPIRY_MINUTES: Record<RiskLevel, number> = {
  LOW: 30,
  MEDIUM: 30,
  HIGH: 30,
  CRITICAL: 60,
}

function computeExpiresAt(riskLevel: RiskLevel): string {
  return new Date(Date.now() + EXPIRY_MINUTES[riskLevel] * 60 * 1000).toISOString()
}

const CreateApprovalRequestBody = z.object({
  taskId: z.string(),
  targetBranch: z.string(),
  targetCommit: z.string(),
  targetDiffHash: z.string(),
  riskLevel: RiskLevelSchema,
  requestedAction: z.string(),
  // expiresAt は受け付けない（サーバーが計算する）
  invalidIf: z.array(z.string()).default([]),
  reason: z.string().optional(),
})

const UpdateStatusBody = z.object({
  // EXPIRED / CONSUMED / SUPERSEDED / STALE: 内部遷移専用。PATCH /status では設定不可
  // - EXPIRED: /consume が expiresAt 超過時に自動設定
  // - CONSUMED: /consume エンドポイント経由のみ
  // - SUPERSEDED: /gate/check または POST /approval-requests が自動設定
  // - STALE: /gate/check または /consume が自動設定（commit/diff 不一致時）
  status: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().optional(),
})

const ConsumeApprovalRequestBody = z.object({
  currentCommit: z.string(),
  currentDiffHash: z.string(),
})

export async function approvalGateRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  // POST /api/gate/check
  // ⚠️ trusted internal caller 専用。
  //    diffText 省略時は changedFiles / targetDiffHash / targetCommit / targetBranch を申告値として信頼する。
  app.post('/gate/check', async (req, reply) => {
    const parsed = GateCheckBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const {
      taskId, requestedAction, targetBranch, targetCommit,
      targetDiffHash, changedFiles, diffText,
    } = parsed.data

    // diffText が提供された場合のみハッシュ照合
    if (diffText !== undefined) {
      const computed = computeDiffHash(diffText)
      if (computed !== targetDiffHash) {
        return reply.status(400).send({
          error: 'targetDiffHash does not match computed hash of diffText',
        })
      }
    }

    const sideEffects: SideEffectEvent[] = []

    // Risk Review（changedFiles ベース）
    let riskReview = runRiskReview(changedFiles)

    // Step D: diffText 内容スキャン（シークレット検出）
    // diffText が提供された場合のみ実行。ハッシュ照合は上記で完了済み。
    if (diffText !== undefined) {
      const scanResult = scanDiffForSecrets(diffText)
      if (scanResult.hits.length > 0) {
        const LEVEL_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
        const labels = scanResult.hits.map(h => `diff:secret(${h.label})`)
        riskReview = {
          ...riskReview,
          riskLevel: LEVEL_ORDER[riskReview.riskLevel] >= LEVEL_ORDER['CRITICAL']
            ? riskReview.riskLevel
            : 'CRITICAL',
          triggeredRules: [...riskReview.triggeredRules, ...labels],
          requiresIndependentReview: true,
        }
        console.warn(
          `[gate/check][Step D] シークレット疑いを検出: taskId=${taskId}, hits=[${labels.join(', ')}]`
        )
      }
    }

    // アクティブな承認リクエストを取得
    let existingReq = storage.approvalRequests.findActiveByTaskId(taskId)

    // P2-followup: expired APPROVED cleanup
    // findActiveByTaskId は expiresAt を見ないため期限切れ APPROVED が返ることがある。
    // DB を EXPIRED に更新して次回以降も正しく扱えるようにする。
    if (existingReq?.status === 'APPROVED' && new Date(existingReq.expiresAt) < new Date()) {
      console.warn(`[gate/check] expired APPROVED detected: id=${existingReq.id}. Updating to EXPIRED.`)
      storage.approvalRequests.updateStatus(existingReq.id, 'EXPIRED', undefined, true)
      existingReq = undefined
    }

    // WAITING_FOR_USER + ref 変化 → SUPERSEDE（decideGateOutcome に渡す前に処理）
    if (existingReq?.status === 'WAITING_FOR_USER') {
      if (existingReq.targetCommit !== targetCommit || existingReq.targetDiffHash !== targetDiffHash) {
        storage.approvalRequests.updateStatus(existingReq.id, 'SUPERSEDED')
        sideEffects.push({ type: 'SUPERSEDED_APPROVAL_REQUEST', requestId: existingReq.id })
        existingReq = undefined
      }
    }

    // Gate 判定（純粋関数）
    const outcome = decideGateOutcome(riskReview, existingReq, targetCommit, targetDiffHash)

    // storage 副作用
    let approvalRequest: ApprovalRequest | undefined = existingReq
    let newRequestId: string | undefined

    if (outcome.decision === 'STALE') {
      storage.approvalRequests.updateStatus(existingReq!.id, 'STALE', undefined, true)
      sideEffects.push({ type: 'MARKED_STALE', requestId: existingReq!.id })
      approvalRequest = storage.approvalRequests.findById(existingReq!.id)
    } else if (outcome.decision === 'BLOCKED') {
      const input: ApprovalGateInput = {
        taskId, requestedAction, targetBranch, targetCommit, targetDiffHash, changedFiles,
      }
      approvalRequest = storage.approvalRequests.create(
        buildApprovalRequest(input, riskReview.riskLevel)
      )
      sideEffects.push({ type: 'CREATED_APPROVAL_REQUEST', requestId: approvalRequest.id })
      newRequestId = approvalRequest.id
    }

    const continuationPolicy = computeContinuationPolicy(riskReview.riskLevel, outcome.decision)
    const nextAction = computeNextAction(outcome, riskReview.riskLevel, newRequestId)

    const response: GateCheckResponse = {
      outcome,
      riskReview,
      sideEffects,
      continuationPolicy,
      nextAction,
      ...(approvalRequest ? { approvalRequest } : {}),
    }
    return reply.send(response)
  })

  // POST /api/approval-requests — 承認リクエスト作成
  app.post('/approval-requests', async (req, reply) => {
    const result = CreateApprovalRequestBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    // 同 taskId の既存アクティブリクエストを SUPERSEDED にする
    const existing = storage.approvalRequests.findActiveByTaskId(result.data.taskId)
    if (existing) {
      storage.approvalRequests.updateStatus(existing.id, 'SUPERSEDED')
    }

    const req_ = storage.approvalRequests.create({
      ...result.data,
      status: 'WAITING_FOR_USER',
      expiresAt: computeExpiresAt(result.data.riskLevel),  // Codex P2: サーバー計算
    })
    return reply.status(201).send(req_)
  })

  // GET /api/approval-requests?taskId=xxx — タスクの承認リクエスト一覧
  app.get<{ Querystring: { taskId?: string } }>('/approval-requests', async (req, reply) => {
    const { taskId } = req.query
    if (!taskId) {
      return reply.status(400).send({ error: 'taskId query parameter is required' })
    }
    const requests = storage.approvalRequests.findByTaskId(taskId)
    return reply.send(requests)
  })

  // GET /api/approval-requests/waiting
  app.get('/approval-requests/waiting', async (_req, reply) => {
    const requests = storage.approvalRequests.findWaiting()
    return reply.send(requests)
  })

  // GET /api/approval-requests/:id — 単体取得
  app.get<{ Params: { id: string } }>('/approval-requests/:id', async (req, reply) => {
    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }
    return reply.send(request)
  })

  // PATCH /api/approval-requests/:id/status — 状態更新（人間が承認/拒否する口）
  app.patch<{ Params: { id: string } }>('/approval-requests/:id/status', async (req, reply) => {
    const result = UpdateStatusBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }
    if (request.status !== 'WAITING_FOR_USER') {
      return reply.status(409).send({
        error: `Cannot update status: current status is '${request.status}'`,
      })
    }

    const updated = storage.approvalRequests.updateStatus(
      req.params.id,
      result.data.status as ApprovalGateStatus,
      result.data.reason,
    )
    return reply.send(updated)
  })

  // POST /api/approval-requests/:id/consume — APPROVED → CONSUMED に遷移（一回限りの承認を強制）
  // 検証順: 404 → 409(非APPROVED) → 409(期限切れ) → 409(commit/diff不一致) → 200(CONSUMED)
  app.post<{ Params: { id: string } }>('/approval-requests/:id/consume', async (req, reply) => {
    // 1. リクエストが存在しない → 404
    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }

    // 2. APPROVED 以外は consume 不可 → 409（状態遷移なし）
    //    CONSUMED を再 consume しようとした場合もここで 409 になる（二重consume防止）
    if (request.status !== 'APPROVED') {
      return reply.status(409).send({
        error: `Cannot consume: current status is '${request.status}' (must be APPROVED)`,
      })
    }

    // body をパース
    const bodyResult = ConsumeApprovalRequestBody.safeParse(req.body)
    if (!bodyResult.success) {
      return reply.status(400).send({ error: 'Validation failed', details: bodyResult.error.format() })
    }
    const { currentCommit, currentDiffHash } = bodyResult.data

    // 3. expiresAt 超過 → EXPIRED に遷移して 409
    if (new Date(request.expiresAt) <= new Date()) {
      storage.approvalRequests.updateStatus(req.params.id, 'EXPIRED', undefined, true)
      return reply.status(409).send({ error: 'Approval request has expired' })
    }

    // 4. commit または diffHash が不一致 → STALE に遷移して 409
    if (request.targetCommit !== currentCommit || request.targetDiffHash !== currentDiffHash) {
      storage.approvalRequests.updateStatus(req.params.id, 'STALE', undefined, true)
      return reply.status(409).send({ error: 'Approval request is stale: commit or diff has changed' })
    }

    // 5. すべてパス → APPROVED → CONSUMED に遷移（preserveReviewMeta=true で CEO メモ保持）
    const updated = storage.approvalRequests.updateStatus(req.params.id, 'CONSUMED', undefined, true)
    return reply.send(updated)
  })

  // GET /api/approval-requests/:id/active?taskId=xxx — アクティブな承認リクエストを取得
  app.get<{ Querystring: { taskId?: string } }>('/approval-requests/active', async (req, reply) => {
    const { taskId } = req.query
    if (!taskId) {
      return reply.status(400).send({ error: 'taskId query parameter is required' })
    }
    const request = storage.approvalRequests.findActiveByTaskId(taskId)
    return reply.send(request ?? null)
  })
}
