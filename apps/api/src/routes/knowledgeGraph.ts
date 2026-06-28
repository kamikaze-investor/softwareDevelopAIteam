import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import type { KGContextEntry, KGContextPack, ImpactAnalysisResult, DecisionRecord, IncidentRecord, RiskLookupResult, DecisionStatus, IncidentSeverity, PatternRecord, FeatureDNA, PatternLookupResult, PatternTrigger } from '@ai-team/shared'

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

const DecisionStatusSchema = z.enum(['active', 'superseded', 'under_review'])
const IncidentSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])

const CreateDecisionSchema = z.object({
  title: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  status: DecisionStatusSchema.default('active'),
  context: z.array(z.string()).default([]),
  relatedNodeIds: z.array(z.string()).default([]),
})

const UpdateDecisionSchema = z.object({
  title: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  decision: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
  status: DecisionStatusSchema.optional(),
  context: z.array(z.string()).optional(),
  relatedNodeIds: z.array(z.string()).optional(),
})

const CreateIncidentSchema = z.object({
  title: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  description: z.string().min(1),
  rootCause: z.string().min(1),
  prevention: z.string().min(1),
  severity: IncidentSeveritySchema.default('medium'),
  relatedNodeIds: z.array(z.string()).default([]),
  taskId: z.string().optional(),
})

const PatternTriggerSchema = z.enum(['same_feature_type', 'high_risk', 'manual'])

const CreatePatternSchema = z.object({
  title: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  description: z.string().min(1),
  steps: z.array(z.string()).min(1),
  featureType: z.string().min(1),
  trigger: PatternTriggerSchema.default('manual'),
  relatedNodeIds: z.array(z.string()).default([]),
  usageCount: z.number().int().min(0).default(0),
})

const UpdatePatternSchema = z.object({
  title: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  description: z.string().min(1).optional(),
  steps: z.array(z.string()).min(1).optional(),
  featureType: z.string().optional(),
  trigger: PatternTriggerSchema.optional(),
  relatedNodeIds: z.array(z.string()).optional(),
})

const PatternLookupBodySchema = z.object({
  keywords: z.array(z.string()).optional().default([]),
  featureType: z.string().optional(),
})

const CreateFeatureDNASchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  sourceTaskId: z.string().optional(),
  relatedTaskIds: z.array(z.string()).default([]),
  aiNotes: z.array(z.string()).default([]),
  history: z.array(z.object({ at: z.string(), note: z.string() })).default([]),
})

const UpdateFeatureDNASchema = z.object({
  reason: z.string().optional(),
  sourceTaskId: z.string().optional(),
  relatedTaskIds: z.array(z.string()).optional(),
  aiNotes: z.array(z.string()).optional(),
})

const AppendHistorySchema = z.object({
  note: z.string().min(1),
})

const RiskLookupBodySchema = z.object({
  keywords: z.array(z.string()).min(1),
  riskLevel: z.enum(['HIGH', 'CRITICAL']),
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

  // ── Impact Analyzer ────────────────────────────────────────

  const ImpactAnalysisBody = z.object({
    changedFiles: z.array(z.string()).min(1),
    targetFeatureId: z.string().optional(),
    taskId: z.string().optional(),
  })

  // POST /api/kg/impact — Impact Analysis
  app.post('/api/kg/impact', async (request, reply) => {
    const parseResult = ImpactAnalysisBody.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation error', details: parseResult.error.issues })
    }

    const { changedFiles, targetFeatureId } = parseResult.data
    const kg = getStorage().knowledgeGraph

    // 1. changedFiles に relatedFiles がマッチする KGNode を全ノードから検索
    const allTypes = ['feature', 'phase', 'task', 'decision', 'incident', 'file', 'doc'] as const
    const allNodes = allTypes.flatMap((t) => kg.findNodesByType(t))

    const matchedNodes = allNodes.filter((node) =>
      node.relatedFiles.some((rf) =>
        changedFiles.some((cf) => cf === rf || cf.includes(rf) || rf.includes(cf)),
      ),
    )

    const impactedSet = new Map(matchedNodes.map((n) => [n.id, n]))

    // 2. targetFeatureId が指定されている場合: 1ホップ edge 探索
    if (targetFeatureId) {
      const targetNode = kg.findNodeById(targetFeatureId)
      if (targetNode) {
        impactedSet.set(targetNode.id, targetNode)
        const outgoingEdges = kg.findEdgesByFromNode(targetFeatureId)
        for (const edge of outgoingEdges) {
          if (edge.edgeType === 'impacts' || edge.edgeType === 'depends_on' || edge.edgeType === 'blocks') {
            const reachable = kg.findNodeById(edge.toNodeId)
            if (reachable) {
              impactedSet.set(reachable.id, reachable)
            }
          }
        }
      }
    }

    const impactedFeatures = Array.from(impactedSet.values())

    // 3. riskLevel 算出
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW'
    if (impactedFeatures.some((n) => n.risk === 'CRITICAL')) {
      riskLevel = 'CRITICAL'
    } else if (impactedFeatures.some((n) => n.risk === 'HIGH')) {
      riskLevel = 'HIGH'
    } else if (impactedFeatures.some((n) => n.risk === 'MEDIUM')) {
      riskLevel = 'MEDIUM'
    }

    // 4. riskReasons 構築
    const riskReasons: string[] = []
    for (const node of impactedFeatures) {
      if (node.risk === 'CRITICAL') {
        riskReasons.push(`Feature '${node.title}' is CRITICAL risk`)
      } else if (node.risk === 'HIGH') {
        riskReasons.push(`Feature '${node.title}' is HIGH risk`)
      }
    }

    // 5. impactedDocs: relatedDocs を集約・重複排除
    const docsSet = new Set<string>()
    for (const node of impactedFeatures) {
      for (const doc of node.relatedDocs) {
        docsSet.add(doc)
      }
    }
    const impactedDocs = Array.from(docsSet)

    // 6. impactedTests: relatedFiles のうち .test. を含むもの
    const testsSet = new Set<string>()
    for (const node of impactedFeatures) {
      for (const f of node.relatedFiles) {
        if (f.includes('.test.')) {
          testsSet.add(f)
        }
      }
    }
    const impactedTests = Array.from(testsSet)

    const result: ImpactAnalysisResult = {
      impactedFeatures,
      impactedDocs,
      impactedTests,
      riskLevel,
      riskReasons,
      requiredReviewers: [],
      analyzedAt: new Date().toISOString(),
    }

    return reply.send(result)
  })

  // ─── Decision Cache ─────────────────────────────────────────

  // POST /api/kg/decisions
  app.post('/api/kg/decisions', async (req, reply) => {
    const parsed = CreateDecisionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const storage = getStorage()
    const record = storage.decisionCache.create(parsed.data)
    return reply.status(201).send(record)
  })

  // GET /api/kg/decisions
  app.get('/api/kg/decisions', async (_req, reply) => {
    return reply.send(getStorage().decisionCache.findAll())
  })

  // GET /api/kg/decisions/:id
  app.get<{ Params: { id: string } }>('/api/kg/decisions/:id', async (req, reply) => {
    const record = getStorage().decisionCache.findById(req.params.id)
    if (!record) return reply.status(404).send({ error: 'Decision record not found' })
    return reply.send(record)
  })

  // PATCH /api/kg/decisions/:id
  app.patch<{ Params: { id: string } }>('/api/kg/decisions/:id', async (req, reply) => {
    const parsed = UpdateDecisionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const updated = getStorage().decisionCache.update(req.params.id, parsed.data)
    if (!updated) return reply.status(404).send({ error: 'Decision record not found' })
    return reply.send(updated)
  })

  // DELETE /api/kg/decisions/:id
  app.delete<{ Params: { id: string } }>('/api/kg/decisions/:id', async (req, reply) => {
    const deleted = getStorage().decisionCache.delete(req.params.id)
    if (!deleted) return reply.status(404).send({ error: 'Decision record not found' })
    return reply.status(204).send()
  })

  // ─── Incident DB ─────────────────────────────────────────────

  // POST /api/kg/incidents
  app.post('/api/kg/incidents', async (req, reply) => {
    const parsed = CreateIncidentSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const record = getStorage().incidentDB.create(parsed.data)
    return reply.status(201).send(record)
  })

  // GET /api/kg/incidents?severity=xxx
  app.get<{ Querystring: { severity?: string } }>('/api/kg/incidents', async (req, reply) => {
    const { severity } = req.query
    if (severity) {
      const parsed = IncidentSeveritySchema.safeParse(severity)
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid severity value' })
      return reply.send(getStorage().incidentDB.findBySeverity(parsed.data))
    }
    return reply.send(getStorage().incidentDB.findAll())
  })

  // GET /api/kg/incidents/:id
  app.get<{ Params: { id: string } }>('/api/kg/incidents/:id', async (req, reply) => {
    const record = getStorage().incidentDB.findById(req.params.id)
    if (!record) return reply.status(404).send({ error: 'Incident record not found' })
    return reply.send(record)
  })

  // DELETE /api/kg/incidents/:id
  app.delete<{ Params: { id: string } }>('/api/kg/incidents/:id', async (req, reply) => {
    const deleted = getStorage().incidentDB.delete(req.params.id)
    if (!deleted) return reply.status(404).send({ error: 'Incident record not found' })
    return reply.status(204).send()
  })

  // ─── Risk Lookup (HIGH/CRITICAL のみ) ────────────────────

  // POST /api/kg/risk-lookup
  app.post('/api/kg/risk-lookup', async (req, reply) => {
    const parsed = RiskLookupBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const { keywords } = parsed.data
    const storage = getStorage()

    const decisions = storage.decisionCache.findByKeywords(keywords)
    const incidents = storage.incidentDB.findByKeywords(keywords)

    const matchedSet = new Set<string>()
    for (const kw of keywords) {
      const lcKw = kw.toLowerCase()
      const hitDecision = decisions.some(d => d.keywords.some(k => k.toLowerCase().includes(lcKw)))
      const hitIncident = incidents.some(i => i.keywords.some(k => k.toLowerCase().includes(lcKw)))
      if (hitDecision || hitIncident) matchedSet.add(kw)
    }

    const result: RiskLookupResult = {
      decisions,
      incidents,
      matchedKeywords: Array.from(matchedSet),
    }
    return reply.send(result)
  })

  // ─── Pattern Library ─────────────────────────────────────

  // POST /api/kg/patterns
  app.post('/api/kg/patterns', async (req, reply) => {
    const parsed = CreatePatternSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const record = getStorage().patternLibrary.create(parsed.data)
    return reply.status(201).send(record)
  })

  // GET /api/kg/patterns?featureType=xxx
  app.get<{ Querystring: { featureType?: string } }>('/api/kg/patterns', async (req, reply) => {
    const { featureType } = req.query
    if (featureType) return reply.send(getStorage().patternLibrary.findByFeatureType(featureType))
    return reply.send(getStorage().patternLibrary.findAll())
  })

  // GET /api/kg/patterns/:id
  app.get<{ Params: { id: string } }>('/api/kg/patterns/:id', async (req, reply) => {
    const record = getStorage().patternLibrary.findById(req.params.id)
    if (!record) return reply.status(404).send({ error: 'Pattern not found' })
    return reply.send(record)
  })

  // PATCH /api/kg/patterns/:id
  app.patch<{ Params: { id: string } }>('/api/kg/patterns/:id', async (req, reply) => {
    const parsed = UpdatePatternSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const updated = getStorage().patternLibrary.update(req.params.id, parsed.data)
    if (!updated) return reply.status(404).send({ error: 'Pattern not found' })
    return reply.send(updated)
  })

  // POST /api/kg/patterns/:id/use — usage_count +1
  app.post<{ Params: { id: string } }>('/api/kg/patterns/:id/use', async (req, reply) => {
    const updated = getStorage().patternLibrary.incrementUsage(req.params.id)
    if (!updated) return reply.status(404).send({ error: 'Pattern not found' })
    return reply.send(updated)
  })

  // DELETE /api/kg/patterns/:id
  app.delete<{ Params: { id: string } }>('/api/kg/patterns/:id', async (req, reply) => {
    if (!getStorage().patternLibrary.delete(req.params.id)) return reply.status(404).send({ error: 'Pattern not found' })
    return reply.status(204).send()
  })

  // POST /api/kg/pattern-lookup — キーワード or featureType でパターン検索
  app.post('/api/kg/pattern-lookup', async (req, reply) => {
    const parsed = PatternLookupBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const { keywords, featureType } = parsed.data
    const pl = getStorage().patternLibrary

    let patterns: PatternRecord[] = []
    const matchedKeywordsSet = new Set<string>()

    if (featureType) {
      patterns = pl.findByFeatureType(featureType)
    }
    if (keywords.length > 0) {
      const byKw = pl.findByKeywords(keywords)
      for (const p of byKw) {
        if (!patterns.find(existing => existing.id === p.id)) patterns.push(p)
        for (const kw of keywords) {
          if (p.keywords.some(k => k.toLowerCase().includes(kw.toLowerCase()))) matchedKeywordsSet.add(kw)
        }
      }
    }

    const result: PatternLookupResult = {
      patterns,
      matchedKeywords: Array.from(matchedKeywordsSet),
    }
    return reply.send(result)
  })

  // ─── Feature DNA ──────────────────────────────────────────

  // POST /api/kg/feature-dna
  app.post('/api/kg/feature-dna', async (req, reply) => {
    const parsed = CreateFeatureDNASchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const dna = getStorage().featureDNA
    const existing = dna.findByNodeId(parsed.data.nodeId)
    if (existing) return reply.status(409).send({ error: 'FeatureDNA for this nodeId already exists' })
    const record = dna.create(parsed.data)
    return reply.status(201).send(record)
  })

  // GET /api/kg/feature-dna/:nodeId
  app.get<{ Params: { nodeId: string } }>('/api/kg/feature-dna/:nodeId', async (req, reply) => {
    const record = getStorage().featureDNA.findByNodeId(req.params.nodeId)
    if (!record) return reply.status(404).send({ error: 'FeatureDNA not found' })
    return reply.send(record)
  })

  // PATCH /api/kg/feature-dna/:nodeId
  app.patch<{ Params: { nodeId: string } }>('/api/kg/feature-dna/:nodeId', async (req, reply) => {
    const parsed = UpdateFeatureDNASchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const updated = getStorage().featureDNA.update(req.params.nodeId, parsed.data)
    if (!updated) return reply.status(404).send({ error: 'FeatureDNA not found' })
    return reply.send(updated)
  })

  // POST /api/kg/feature-dna/:nodeId/history — 履歴追記
  app.post<{ Params: { nodeId: string } }>('/api/kg/feature-dna/:nodeId/history', async (req, reply) => {
    const parsed = AppendHistorySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    const updated = getStorage().featureDNA.appendHistory(req.params.nodeId, parsed.data.note)
    if (!updated) return reply.status(404).send({ error: 'FeatureDNA not found' })
    return reply.send(updated)
  })

  // DELETE /api/kg/feature-dna/:nodeId
  app.delete<{ Params: { nodeId: string } }>('/api/kg/feature-dna/:nodeId', async (req, reply) => {
    if (!getStorage().featureDNA.delete(req.params.nodeId)) return reply.status(404).send({ error: 'FeatureDNA not found' })
    return reply.status(204).send()
  })
}
