import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import type { KGContextEntry, KGContextPack } from '@ai-team/shared'

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

  // ── Timeline Map ───────────────────────────────────────────

  // GET /api/kg/timeline — CEO向け集約ビュー
  app.get('/api/kg/timeline', async (_request, reply) => {
    const kg = getStorage().knowledgeGraph
    const allTypes = ['feature', 'phase', 'task', 'decision', 'incident', 'file', 'doc'] as const
    const allNodes = allTypes.flatMap((t) => kg.findNodesByType(t))
    const allEdgeTypes = ['depends_on', 'blocks', 'related_to', 'belongs_to', 'impacts'] as const
    const allEdges = allEdgeTypes.flatMap((t) => kg.findEdgesByType(t))

    // Phase ノード抽出 & 並び替え（high→medium→low, createdAt 昇順）
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
    const phaseNodes = allNodes
      .filter((n) => n.type === 'phase')
      .sort((a, b) => {
        const pd = priorityOrder[a.priority] - priorityOrder[b.priority]
        if (pd !== 0) return pd
        return a.createdAt.localeCompare(b.createdAt)
      })

    // Phase ID セット（存在するフェーズのみ）
    const phaseIdSet = new Set(phaseNodes.map((p) => p.id))

    // 各フェーズに所属するノード（phase フィールドが phaseNode.id に一致）
    const phases = phaseNodes.map((phaseNode) => {
      const phaseMembers = allNodes.filter(
        (n) => n.type !== 'phase' && n.phase === phaseNode.id,
      )
      const featureNodes = phaseMembers.filter((n) => n.type === 'feature')
      const nonFeatureMembers = phaseMembers.filter((n) => n.type !== 'feature')

      // belongs_to エッジで feature に紐づく子ノード
      const belongsToEdges = allEdges.filter((e) => e.edgeType === 'belongs_to')

      const features = featureNodes.map((featureNode) => {
        const childIds = new Set(
          belongsToEdges
            .filter((e) => e.toNodeId === featureNode.id)
            .map((e) => e.fromNodeId),
        )
        const children = allNodes.filter((n) => childIds.has(n.id))
        const edges = allEdges.filter(
          (e) =>
            e.fromNodeId === featureNode.id &&
            (e.edgeType === 'depends_on' || e.edgeType === 'blocks'),
        )
        return { node: featureNode, children, edges }
      })

      // stats: phase に所属する全ノード（feature + nonFeature + feature の children）
      // ただし children は phase フィールドを持たないケースがあるため featureMembers のみでカウント
      const allPhaseNodes = phaseMembers
      const total = allPhaseNodes.length
      const active = allPhaseNodes.filter((n) => n.status === 'active').length
      const archived = allPhaseNodes.filter((n) => n.status === 'archived').length
      const inbox = allPhaseNodes.filter((n) => n.status === 'inbox').length
      const highRiskCount = allPhaseNodes.filter((n) => n.risk === 'HIGH').length
      const criticalRiskCount = allPhaseNodes.filter((n) => n.risk === 'CRITICAL').length

      return {
        phaseNode,
        features,
        stats: { total, active, archived, inbox, highRiskCount, criticalRiskCount },
      }
    })

    // inbox: phase フィールドが未定義 or 対応する phase ノードが存在しない非 phase ノード
    const inboxNodes = allNodes.filter(
      (n) => n.type !== 'phase' && (n.phase === undefined || !phaseIdSet.has(n.phase)),
    )

    return reply.send({
      phases,
      inbox: inboxNodes,
      generatedAt: new Date().toISOString(),
    })
  })

  // ── Node Detail ────────────────────────────────────────────

  // GET /api/kg/nodes/:id/detail — ノード詳細 + 関連エッジ
  app.get('/api/kg/nodes/:id/detail', async (request, reply) => {
    const { id } = request.params as { id: string }
    const kg = getStorage().knowledgeGraph
    const node = kg.findNodeById(id)
    if (!node) {
      return reply.status(404).send({ error: `Node not found: ${id}` })
    }
    const outgoingEdges = kg.findEdgesByFromNode(id)
    const incomingEdges = kg.findEdgesByToNode(id)
    return reply.send({ node, outgoingEdges, incomingEdges })
  })

  // ── Context Engine ─────────────────────────────────────────

  const KGContextPackBodySchema = z.object({
    taskId: z.string().min(1),
    changedFiles: z.array(z.string()),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('LOW'),
    maxEntries: z.number().int().min(1).max(50).default(20),
  })

  // POST /api/kg/context-pack — Context Pack 生成
  app.post('/api/kg/context-pack', async (request, reply) => {
    const parseResult = KGContextPackBodySchema.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation error', details: parseResult.error.issues })
    }

    const { taskId, changedFiles, riskLevel, maxEntries } = parseResult.data

    // 1. riskLevel から executionLevel を決定
    const executionLevel: 1 | 2 | 3 | 4 =
      riskLevel === 'LOW' ? 1
      : riskLevel === 'MEDIUM' ? 2
      : riskLevel === 'HIGH' ? 3
      : 4

    const kg = getStorage().knowledgeGraph
    const allTypes = ['feature', 'phase', 'task', 'decision', 'incident', 'file', 'doc'] as const

    // 2. Knowledge Graph から関連ノードを収集（executionLevel に応じて）
    let candidateNodes = (() => {
      if (executionLevel === 1) {
        return kg.findNodesByType('feature').filter((n) => n.status === 'active')
      }
      if (executionLevel === 2) {
        return [
          ...kg.findNodesByType('feature').filter((n) => n.status === 'active'),
          ...kg.findNodesByType('decision').filter((n) => n.status === 'active'),
        ]
      }
      if (executionLevel === 3) {
        const fileNodes = kg.findNodesByType('file').filter((n) =>
          n.relatedFiles.some((f) => changedFiles.includes(f)),
        )
        return [
          ...kg.findNodesByType('feature').filter((n) => n.status === 'active'),
          ...kg.findNodesByType('decision').filter((n) => n.status === 'active'),
          ...kg.findNodesByType('incident').filter((n) => n.status === 'active'),
          ...fileNodes,
        ]
      }
      // Level 4: 全タイプ・全 status
      return allTypes.flatMap((t) => kg.findNodesByType(t))
    })()

    // 3. スコアリング
    const changedFilesSet = new Set(changedFiles)
    const scored = candidateNodes.map((node) => {
      let score = 0
      const reasons: string[] = []

      if (node.relatedFiles.some((f) => changedFilesSet.has(f))) {
        score += 10
        reasons.push('changedFiles に relatedFiles が一致')
      }
      if (node.type === 'feature' && node.status === 'active') {
        score += 5
        reasons.push('active feature')
      }
      if (node.risk === 'HIGH') {
        score += 3
        reasons.push('risk=HIGH')
      }
      if (node.risk === 'CRITICAL') {
        score += 5
        reasons.push('risk=CRITICAL')
      }
      if (node.type === 'decision') {
        score += 2
        reasons.push('type=decision')
      }

      return { node, score, reason: reasons.join(', ') || node.type }
    })

    // 4. 重複排除（同一 nodeId）
    const seen = new Set<string>()
    const deduped = scored.filter(({ node }) => {
      if (seen.has(node.id)) return false
      seen.add(node.id)
      return true
    })

    // 5. priority 降順でソート
    deduped.sort((a, b) => b.score - a.score)

    // 6. maxEntries で切り詰め
    const truncatedCount = Math.max(0, deduped.length - maxEntries)
    const limited = deduped.slice(0, maxEntries)

    // 7. KGContextPack を生成
    const entries: KGContextEntry[] = limited.map(({ node, score, reason }) => ({
      nodeId: node.id,
      title: node.title,
      type: node.type,
      priority: score,
      reason,
      relatedFiles: node.relatedFiles,
      relatedDocs: node.relatedDocs,
      summary: node.summary,
    }))

    const pack: KGContextPack = {
      taskId,
      executionLevel,
      entries,
      truncatedCount,
      generatedAt: new Date().toISOString(),
    }

    return reply.send(pack)
  })
}
