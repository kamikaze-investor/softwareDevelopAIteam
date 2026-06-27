import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import type { ApprovalGateStatus, RiskLevel } from '@ai-team/shared'

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
  // CONSUMED はシステム内部遷移専用（/consume エンドポイント経由のみ）— ここには追加しない
  status: z.enum(['APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'STALE']),
  reason: z.string().optional(),
})

const ConsumeApprovalRequestBody = z.object({
  currentCommit: z.string(),
  currentDiffHash: z.string(),
})

export async function approvalGateRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

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
