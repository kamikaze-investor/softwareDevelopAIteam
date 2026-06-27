import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

// ────────────────────────────────────────────────────────────
// Zod スキーマ
// ────────────────────────────────────────────────────────────

const KGNodeTypeSchema = z.enum(['feature', 'phase', 'task', 'decision', 'incident', 'file', 'doc'])
const KGNodeStatusSchema = z.enum(['active', 'archived', 'inbox'])
const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const PrioritySchema = z.enum(['low', 'medium', 'high'])
const KGEdgeTypeSchema = z.enum(['depends_on', 'blocks', 'related_to', 'belongs_to', 'impacts'])

const CreateNodeSchema = z.object({
  type: KGNodeTypeSchema,
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  phase: z.string().optional(),
  status: KGNodeStatusSchema.default('inbox'),
  risk: RiskLevelSchema.default('LOW'),
  priority: PrioritySchema.default('medium'),
  summary: z.string().optional(),
  relatedDocs: z.array(z.string()).default([]),
  relatedFiles: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]),
  relatedFeatures: z.array(z.string()).default([]),
  relatedIncidents: z.array(z.string()).default([]),
  relatedDecisions: z.array(z.string()).default([]),
  historyRefs: z.array(z.string()).default([]),
})

const UpdateNodeSchema = CreateNodeSchema.partial()

const CreateEdgeSchema = z.object({
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  edgeType: KGEdgeTypeSchema,
  label: z.string().optional(),
})

// ────────────────────────────────────────────────────────────
// Route plugin
// ────────────────────────────────────────────────────────────

export async function knowledgeGraphRoutes(app: FastifyInstance): Promise<void> {
  // ── Node CRUD ──────────────────────────────────────────────

  // POST /api/kg/nodes — Node 作成
  app.post('/api/kg/nodes', async (request, reply) => {
    const parseResult = CreateNodeSchema.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation error', details: parseResult.error.issues })
    }
    const storage = getStorage()
    const node = storage.knowledgeGraph.createNode(parseResult.data)
    return reply.status(201).send(node)
  })

  // GET /api/kg/nodes?type=&phase=&tag= — Node 一覧
  app.get('/api/kg/nodes', async (request, reply) => {
    const query = request.query as Record<string, string>
    const storage = getStorage()
    const kg = storage.knowledgeGraph

    if (query.type) {
      const typeResult = KGNodeTypeSchema.safeParse(query.type)
      if (!typeResult.success) {
        return reply.status(400).send({ error: 'Invalid type parameter' })
      }
      return reply.send(kg.findNodesByType(typeResult.data))
    }
    if (query.phase) {
      return reply.send(kg.findNodesByPhase(query.phase))
    }
    if (query.tag) {
      return reply.send(kg.findNodesByTag(query.tag))
    }

    // フィルタなし: 全件取得（findNodesByType を全 type 合算で代替）
    const allTypes = ['feature', 'phase', 'task', 'decision', 'incident', 'file', 'doc'] as const
    const all = allTypes.flatMap((t) => kg.findNodesByType(t))
    return reply.send(all)
  })

  // GET /api/kg/nodes/:id — 単体取得
  app.get('/api/kg/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const node = getStorage().knowledgeGraph.findNodeById(id)
    if (!node) {
      return reply.status(404).send({ error: `Node not found: ${id}` })
    }
    return reply.send(node)
  })

  // PATCH /api/kg/nodes/:id — Node 更新
  app.patch('/api/kg/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parseResult = UpdateNodeSchema.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation error', details: parseResult.error.issues })
    }
    const node = getStorage().knowledgeGraph.updateNode(id, parseResult.data)
    if (!node) {
      return reply.status(404).send({ error: `Node not found: ${id}` })
    }
    return reply.send(node)
  })

  // DELETE /api/kg/nodes/:id — Node 削除
  app.delete('/api/kg/nodes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const deleted = getStorage().knowledgeGraph.deleteNode(id)
    if (!deleted) {
      return reply.status(404).send({ error: `Node not found: ${id}` })
    }
    return reply.status(204).send()
  })

  // ── Edge CRUD ──────────────────────────────────────────────

  // POST /api/kg/edges — Edge 作成
  app.post('/api/kg/edges', async (request, reply) => {
    const parseResult = CreateEdgeSchema.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation error', details: parseResult.error.issues })
    }
    const { fromNodeId, toNodeId, edgeType, label } = parseResult.data
    const kg = getStorage().knowledgeGraph

    // 参照先 Node の存在確認
    if (!kg.findNodeById(fromNodeId)) {
      return reply.status(400).send({ error: `fromNodeId not found: ${fromNodeId}` })
    }
    if (!kg.findNodeById(toNodeId)) {
      return reply.status(400).send({ error: `toNodeId not found: ${toNodeId}` })
    }

    const edge = kg.createEdge({ fromNodeId, toNodeId, edgeType, label })
    return reply.status(201).send(edge)
  })

  // GET /api/kg/edges?fromNodeId=&toNodeId=&type= — Edge 一覧
  app.get('/api/kg/edges', async (request, reply) => {
    const query = request.query as Record<string, string>
    const kg = getStorage().knowledgeGraph

    if (query.fromNodeId) {
      return reply.send(kg.findEdgesByFromNode(query.fromNodeId))
    }
    if (query.toNodeId) {
      return reply.send(kg.findEdgesByToNode(query.toNodeId))
    }
    if (query.type) {
      const typeResult = KGEdgeTypeSchema.safeParse(query.type)
      if (!typeResult.success) {
        return reply.status(400).send({ error: 'Invalid type parameter' })
      }
      return reply.send(kg.findEdgesByType(typeResult.data))
    }

    // フィルタなし: 全件取得
    const allTypes = ['depends_on', 'blocks', 'related_to', 'belongs_to', 'impacts'] as const
    const all = allTypes.flatMap((t) => kg.findEdgesByType(t))
    return reply.send(all)
  })

  // GET /api/kg/edges/:id — 単体取得
  app.get('/api/kg/edges/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const edge = getStorage().knowledgeGraph.findEdgeById(id)
    if (!edge) {
      return reply.status(404).send({ error: `Edge not found: ${id}` })
    }
    return reply.send(edge)
  })

  // DELETE /api/kg/edges/:id — Edge 削除
  app.delete('/api/kg/edges/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const deleted = getStorage().knowledgeGraph.deleteEdge(id)
    if (!deleted) {
      return reply.status(404).send({ error: `Edge not found: ${id}` })
    }
    return reply.status(204).send()
  })
}
