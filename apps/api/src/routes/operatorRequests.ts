import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  OPERATOR_REQUEST_MAX_PENDING,
  OPERATOR_REQUEST_MESSAGE_MAX_LENGTH,
  type OperatorRequestRequesterClass,
} from '@ai-team/shared'
import { getStorage } from '../storage'
import type { IStorage } from '../storage/interface'
import { getCredentialClass } from '../auth/credentialClass.js'

/**
 * 共通 Operator Interface — 外部（ChatGPT MCP / Mobile Operator Chat）から PL への依頼口。
 *
 * **MCP 用・Mobile 用に別の口を作らない。** 両方ともこの route を使う（CEO 方針・2026-09-28）。
 *
 * ## ここでできること（これ以外は無い）
 *
 * - `POST /api/operator-requests` … 依頼を保存する。**保存するだけ**で、Task / Job / Approval /
 *   Design Review 等の operational state は一切変えない。PL の起動（tick）もしない
 * - `GET /api/operator-requests/:id` … 依頼と PL の回答を読む
 * - `GET /api/operator-requests` … 依頼の一覧（新しい順）
 *
 * 依頼本文は untrusted input であり、PL は次の tick でこれを**データとして**読んで回答する
 * （`pl/operatorRequestStep.ts`）。本文が実装 prompt・resume instruction・Task description へ
 * 流れる経路は無い。
 */

const CreateBody = z.object({
  message: z.string().trim().min(1).max(OPERATOR_REQUEST_MESSAGE_MAX_LENGTH),
  projectId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
}).strict()

const ListQuery = z.object({
  status: z.enum(['pending', 'answered', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * 依頼者の種別を**認証結果から**決める。body / header からは作らない。
 *
 * 到達できる class は allowlist で決まっており、WORKER / ACTIONS_READONLY はここへ来ない。
 * 来た場合は設定の穴なので fail-closed で断る（`undefined` を返す）。
 */
function requesterClassOf(req: FastifyRequest): OperatorRequestRequesterClass | undefined {
  const credentialClass = getCredentialClass(req)
  switch (credentialClass) {
    case 'admin':
    case 'legacy':
      return credentialClass
    case undefined:
      // 認証 hook が class を載せないのは「認証を行わない構成」（API_TOKEN も split hash も未設定）だけ。
      return process.env.API_TOKEN || process.env.ADMIN_TOKEN_SHA256 ? undefined : 'unauthenticated'
    default:
      return undefined
  }
}

export async function operatorRequestRoutes(app: FastifyInstance): Promise<void> {
  const storage: IStorage = (app as unknown as { storageOverride?: IStorage }).storageOverride ?? getStorage()

  app.post('/operator-requests', async (req, reply) => {
    const requesterClass = requesterClassOf(req)
    if (requesterClass === undefined) {
      return reply.status(403).send({ error: 'Forbidden: this credential cannot create operator requests' })
    }

    const parsed = CreateBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }
    const { message, projectId, taskId } = parsed.data

    // 対象の絞り込みは存在確認だけ。Project / Task の状態は読むだけで変えない。
    if (projectId !== undefined && !storage.projects.findById(projectId)) {
      return reply.status(400).send({ error: 'projectId does not exist' })
    }
    if (taskId !== undefined) {
      const task = storage.tasks.findById(taskId)
      if (!task) {
        return reply.status(400).send({ error: 'taskId does not exist' })
      }
      if (projectId !== undefined && task.projectId !== projectId) {
        return reply.status(400).send({ error: 'taskId does not belong to projectId' })
      }
    }

    if (storage.operatorRequests.countPending() >= OPERATOR_REQUEST_MAX_PENDING) {
      return reply.status(429).send({
        error: `Too many pending operator requests (max ${OPERATOR_REQUEST_MAX_PENDING}). ` +
          'Wait for the PL to answer the pending ones.',
      })
    }

    const created = storage.operatorRequests.create({
      requesterClass,
      message,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    })
    return reply.status(201).send(created)
  })

  app.get<{ Params: { id: string } }>('/operator-requests/:id', async (req, reply) => {
    const found = storage.operatorRequests.findById(req.params.id)
    if (!found) return reply.status(404).send({ error: 'Operator request not found' })
    return reply.send(found)
  })

  app.get('/operator-requests', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }
    return reply.send(storage.operatorRequests.list(parsed.data))
  })
}
