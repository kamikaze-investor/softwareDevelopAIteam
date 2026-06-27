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
  status: z.enum(['APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'STALE']),
  reason: z.string().optional(),
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
