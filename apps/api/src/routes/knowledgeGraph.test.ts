import Fastify, { type FastifyInstance } from 'fastify'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { KGNode, KGEdge } from '@ai-team/shared'

let decisionId: string
let incidentId: string
let patternId: string
let dnaNodeId: string
let reflectionId: string

async function buildApp(): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'

  const [{ knowledgeGraphRoutes }, { resetStorage }] = await Promise.all([
    import('./knowledgeGraph.js'),
    import('../storage/index.js'),
  ])

  resetStorage()

  const app = Fastify()
  app.register(knowledgeGraphRoutes)
  await app.ready()
  return app
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp()
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

function parseBody<T>(body: string): T {
  return JSON.parse(body) as T
}

const BASE_NODE_PAYLOAD = {
  type: 'feature',
  title: 'テスト機能',
  tags: ['tag1', 'tag2'],
  risk: 'MEDIUM',
  priority: 'high',
  relatedDocs: [],
  relatedFiles: ['src/foo.ts'],
  dependsOn: [],
  blocks: [],
  relatedFeatures: [],
  relatedIncidents: [],
  relatedDecisions: [],
  historyRefs: [],
}

async function createNode(app: FastifyInstance, overrides: Record<string, unknown> = {}): Promise<KGNode> {
  const res = await app.inject({
    method: 'POST',
    url: '/kg/nodes',
    payload: { ...BASE_NODE_PAYLOAD, ...overrides },
  })
  expect(res.statusCode).toBe(201)
  return parseBody<KGNode>(res.body)
}

// ────────────────────────────────────────────────────────────
// Node テスト
// ────────────────────────────────────────────────────────────

describe('Knowledge Graph Nodes', () => {
  // 1. POST /kg/nodes — feature ノード作成 → 201 + id が kg- で始まる
  it('POST /kg/nodes — feature ノード作成 → 201 + id が kg- で始まる', async () => {
    await withApp(async (app) => {
      const node = await createNode(app)
      expect(node.id).toMatch(/^kg-/)
      expect(node.type).toBe('feature')
      expect(node.title).toBe('テスト機能')
    })
  })

  // 2. POST /kg/nodes — phase 未指定 → status='inbox'
  it('POST /kg/nodes — phase 未指定 → status="inbox"', async () => {
    await withApp(async (app) => {
      const node = await createNode(app)
      expect(node.phase).toBeUndefined()
      expect(node.status).toBe('inbox')
    })
  })

  // 3. GET /kg/nodes?type=feature — type フィルタで絞り込める
  it('GET /kg/nodes?type=feature — type フィルタで絞り込める', async () => {
    await withApp(async (app) => {
      await createNode(app, { type: 'feature', title: 'Feature A' })
      await createNode(app, { type: 'phase', title: 'Phase 1' })

      const res = await app.inject({ method: 'GET', url: '/kg/nodes?type=feature' })
      expect(res.statusCode).toBe(200)
      const nodes = parseBody<KGNode[]>(res.body)
      expect(nodes.every((n) => n.type === 'feature')).toBe(true)
      expect(nodes.length).toBeGreaterThanOrEqual(1)
    })
  })

  // 4. GET /kg/nodes?phase=phase-1 — phase フィルタで絞り込める
  it('GET /kg/nodes?phase=phase-1 — phase フィルタで絞り込める', async () => {
    await withApp(async (app) => {
      await createNode(app, { phase: 'phase-1', title: 'In Phase 1' })
      await createNode(app, { phase: 'phase-2', title: 'In Phase 2' })

      const res = await app.inject({ method: 'GET', url: '/kg/nodes?phase=phase-1' })
      expect(res.statusCode).toBe(200)
      const nodes = parseBody<KGNode[]>(res.body)
      expect(nodes.every((n) => n.phase === 'phase-1')).toBe(true)
      expect(nodes.length).toBeGreaterThanOrEqual(1)
    })
  })

  // 5. GET /kg/nodes/:id — 単体取得
  it('GET /kg/nodes/:id — 単体取得', async () => {
    await withApp(async (app) => {
      const created = await createNode(app)
      const res = await app.inject({ method: 'GET', url: `/kg/nodes/${created.id}` })
      expect(res.statusCode).toBe(200)
      const node = parseBody<KGNode>(res.body)
      expect(node.id).toBe(created.id)
      expect(node.title).toBe(created.title)
    })
  })

  // 6. GET /kg/nodes/:id — 存在しない ID → 404
  it('GET /kg/nodes/:id — 存在しない ID → 404', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/kg/nodes/nonexistent-id' })
      expect(res.statusCode).toBe(404)
    })
  })

  // 7. PATCH /kg/nodes/:id — title 更新 → updatedAt が変わる
  it('PATCH /kg/nodes/:id — title 更新 → updatedAt が変わる', async () => {
    await withApp(async (app) => {
      const created = await createNode(app)
      // 時間差を確保
      await new Promise((resolve) => setTimeout(resolve, 10))

      const res = await app.inject({
        method: 'PATCH',
        url: `/kg/nodes/${created.id}`,
        payload: { title: '更新後タイトル' },
      })
      expect(res.statusCode).toBe(200)
      const updated = parseBody<KGNode>(res.body)
      expect(updated.title).toBe('更新後タイトル')
      expect(updated.updatedAt).not.toBe(created.updatedAt)
    })
  })

  // 8. DELETE /kg/nodes/:id → 204
  it('DELETE /kg/nodes/:id → 204', async () => {
    await withApp(async (app) => {
      const created = await createNode(app)
      const res = await app.inject({ method: 'DELETE', url: `/kg/nodes/${created.id}` })
      expect(res.statusCode).toBe(204)

      // 削除後は 404
      const getRes = await app.inject({ method: 'GET', url: `/kg/nodes/${created.id}` })
      expect(getRes.statusCode).toBe(404)
    })
  })

  // 9. tags / relatedFiles などの配列フィールドが正しくシリアライズ/デシリアライズされる
  it('配列フィールドが正しくシリアライズ/デシリアライズされる', async () => {
    await withApp(async (app) => {
      const payload = {
        ...BASE_NODE_PAYLOAD,
        tags: ['alpha', 'beta', 'gamma'],
        relatedFiles: ['src/a.ts', 'src/b.ts'],
        dependsOn: ['kg-20260101-001'],
        blocks: ['kg-20260101-002'],
        relatedFeatures: ['feat-1'],
        relatedIncidents: ['inc-1'],
        relatedDecisions: ['dec-1'],
        historyRefs: ['ref-1'],
      }
      const created = await createNode(app, payload)
      const res = await app.inject({ method: 'GET', url: `/kg/nodes/${created.id}` })
      const node = parseBody<KGNode>(res.body)
      expect(node.tags).toEqual(['alpha', 'beta', 'gamma'])
      expect(node.relatedFiles).toEqual(['src/a.ts', 'src/b.ts'])
      expect(node.dependsOn).toEqual(['kg-20260101-001'])
      expect(node.blocks).toEqual(['kg-20260101-002'])
      expect(node.relatedFeatures).toEqual(['feat-1'])
      expect(node.relatedIncidents).toEqual(['inc-1'])
      expect(node.relatedDecisions).toEqual(['dec-1'])
      expect(node.historyRefs).toEqual(['ref-1'])
    })
  })
})

// ────────────────────────────────────────────────────────────
// Edge テスト
// ────────────────────────────────────────────────────────────

describe('Knowledge Graph Edges', () => {
  // 10. POST /kg/edges — depends_on エッジ作成 → 201 + id が kge- で始まる
  it('POST /kg/edges — depends_on エッジ作成 → 201 + id が kge- で始まる', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      expect(res.statusCode).toBe(201)
      const edge = parseBody<KGEdge>(res.body)
      expect(edge.id).toMatch(/^kge-/)
      expect(edge.edgeType).toBe('depends_on')
      expect(edge.fromNodeId).toBe(nodeA.id)
      expect(edge.toNodeId).toBe(nodeB.id)
    })
  })

  // 11. GET /kg/edges?fromNodeId=xxx — fromNodeId フィルタ
  it('GET /kg/edges?fromNodeId=xxx — fromNodeId フィルタ', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })
      const nodeC = await createNode(app, { title: 'Node C' })

      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeC.id, toNodeId: nodeB.id, edgeType: 'blocks' },
      })

      const res = await app.inject({ method: 'GET', url: `/kg/edges?fromNodeId=${nodeA.id}` })
      expect(res.statusCode).toBe(200)
      const edges = parseBody<KGEdge[]>(res.body)
      expect(edges.every((e) => e.fromNodeId === nodeA.id)).toBe(true)
      expect(edges.length).toBe(1)
    })
  })

  // 12. GET /kg/edges?type=depends_on — type フィルタ
  it('GET /kg/edges?type=depends_on — type フィルタ', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })
      const nodeC = await createNode(app, { title: 'Node C' })

      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeC.id, edgeType: 'blocks' },
      })

      const res = await app.inject({ method: 'GET', url: '/kg/edges?type=depends_on' })
      expect(res.statusCode).toBe(200)
      const edges = parseBody<KGEdge[]>(res.body)
      expect(edges.every((e) => e.edgeType === 'depends_on')).toBe(true)
      expect(edges.length).toBeGreaterThanOrEqual(1)
    })
  })

  // 13. DELETE /kg/edges/:id → 204
  it('DELETE /kg/edges/:id → 204', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })

      const createRes = await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'related_to' },
      })
      const edge = parseBody<KGEdge>(createRes.body)

      const deleteRes = await app.inject({ method: 'DELETE', url: `/kg/edges/${edge.id}` })
      expect(deleteRes.statusCode).toBe(204)

      const getRes = await app.inject({ method: 'GET', url: `/kg/edges/${edge.id}` })
      expect(getRes.statusCode).toBe(404)
    })
  })

  // 14. 存在しない fromNodeId / toNodeId でエッジ作成 → 400
  it('存在しない fromNodeId でエッジ作成 → 400', async () => {
    await withApp(async (app) => {
      const nodeB = await createNode(app, { title: 'Node B' })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: 'nonexistent-node', toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  it('存在しない toNodeId でエッジ作成 → 400', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: 'nonexistent-node', edgeType: 'depends_on' },
      })
      expect(res.statusCode).toBe(400)
    })
  })
})

// ────────────────────────────────────────────────────────────
// Timeline Map テスト
// ────────────────────────────────────────────────────────────

import type { TimelineMap, KGContextPack, ImpactAnalysisResult } from '@ai-team/shared'

describe('GET /kg/timeline', () => {
  // 1. Phase ノードが1つ、feature ノードが2つ → phases[0].features が2つ返る
  it('Phase 1つ + feature 2つ → phases[0].features が2つ返る', async () => {
    await withApp(async (app) => {
      const phase = await createNode(app, { type: 'phase', title: 'Phase 1', status: 'active' })
      await createNode(app, { type: 'feature', title: 'Feature A', phase: phase.id, status: 'active' })
      await createNode(app, { type: 'feature', title: 'Feature B', phase: phase.id, status: 'active' })

      const res = await app.inject({ method: 'GET', url: '/kg/timeline' })
      expect(res.statusCode).toBe(200)
      const timeline = parseBody<TimelineMap>(res.body)
      expect(timeline.phases).toHaveLength(1)
      expect(timeline.phases[0].features).toHaveLength(2)
    })
  })

  // 2. inbox: phase 未所属のノードが inbox に入る
  it('phase 未所属のノードが inbox に入る', async () => {
    await withApp(async (app) => {
      const phase = await createNode(app, { type: 'phase', title: 'Phase 1', status: 'active' })
      await createNode(app, { type: 'feature', title: 'In Phase', phase: phase.id, status: 'active' })
      await createNode(app, { type: 'feature', title: 'No Phase', status: 'inbox' }) // phase 未指定

      const res = await app.inject({ method: 'GET', url: '/kg/timeline' })
      expect(res.statusCode).toBe(200)
      const timeline = parseBody<TimelineMap>(res.body)
      expect(timeline.inbox.some((n) => n.title === 'No Phase')).toBe(true)
      expect(timeline.inbox.every((n) => n.type !== 'phase')).toBe(true)
    })
  })

  // 3. stats: active/archived カウントが正しい
  it('stats: active/archived カウントが正しい', async () => {
    await withApp(async (app) => {
      const phase = await createNode(app, { type: 'phase', title: 'Phase S', status: 'active' })
      await createNode(app, { type: 'feature', title: 'F1', phase: phase.id, status: 'active' })
      await createNode(app, { type: 'feature', title: 'F2', phase: phase.id, status: 'archived' })
      await createNode(app, { type: 'task', title: 'T1', phase: phase.id, status: 'active' })

      const res = await app.inject({ method: 'GET', url: '/kg/timeline' })
      const timeline = parseBody<TimelineMap>(res.body)
      const stats = timeline.phases[0].stats
      expect(stats.total).toBe(3)
      expect(stats.active).toBe(2)
      expect(stats.archived).toBe(1)
    })
  })

  // 4. stats: highRiskCount が正しい
  it('stats: highRiskCount が正しい', async () => {
    await withApp(async (app) => {
      const phase = await createNode(app, { type: 'phase', title: 'Phase R', status: 'active' })
      await createNode(app, { type: 'feature', title: 'F-high', phase: phase.id, status: 'active', risk: 'HIGH' })
      await createNode(app, { type: 'feature', title: 'F-critical', phase: phase.id, status: 'active', risk: 'CRITICAL' })
      await createNode(app, { type: 'task', title: 'T-low', phase: phase.id, status: 'active', risk: 'LOW' })

      const res = await app.inject({ method: 'GET', url: '/kg/timeline' })
      const timeline = parseBody<TimelineMap>(res.body)
      const stats = timeline.phases[0].stats
      expect(stats.highRiskCount).toBe(1)
      expect(stats.criticalRiskCount).toBe(1)
    })
  })

  // 5. ノードが0件でも空の timeline が返る
  it('ノードが0件でも空の timeline が返る（phases=[], inbox=[]）', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/kg/timeline' })
      expect(res.statusCode).toBe(200)
      const timeline = parseBody<TimelineMap>(res.body)
      expect(timeline.phases).toEqual([])
      expect(timeline.inbox).toEqual([])
      expect(timeline.generatedAt).toBeTruthy()
    })
  })
})

// ────────────────────────────────────────────────────────────
// Node Detail テスト
// ────────────────────────────────────────────────────────────

describe('GET /kg/nodes/:id/detail', () => {
  // 6. outgoingEdges / incomingEdges が正しく返る
  it('outgoingEdges / incomingEdges が正しく返る', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })
      const nodeC = await createNode(app, { title: 'Node C' })

      // A → B (depends_on)
      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      // C → A (blocks)
      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeC.id, toNodeId: nodeA.id, edgeType: 'blocks' },
      })

      const res = await app.inject({ method: 'GET', url: `/kg/nodes/${nodeA.id}/detail` })
      expect(res.statusCode).toBe(200)
      const detail = parseBody<{ node: KGNode; outgoingEdges: KGEdge[]; incomingEdges: KGEdge[] }>(res.body)
      expect(detail.node.id).toBe(nodeA.id)
      expect(detail.outgoingEdges).toHaveLength(1)
      expect(detail.outgoingEdges[0].toNodeId).toBe(nodeB.id)
      expect(detail.incomingEdges).toHaveLength(1)
      expect(detail.incomingEdges[0].fromNodeId).toBe(nodeC.id)
    })
  })

  // 7. 存在しない ID → 404
  it('存在しない ID → 404', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/kg/nodes/nonexistent-id/detail' })
      expect(res.statusCode).toBe(404)
    })
  })
})

// ────────────────────────────────────────────────────────────
// Context Pack テスト
// ────────────────────────────────────────────────────────────

describe('POST /kg/context-pack', () => {
  // 1. LOW riskLevel → executionLevel=1, type=feature のみ返る
  it('LOW riskLevel → executionLevel=1, type=feature のみ返る', async () => {
    await withApp(async (app) => {
      await createNode(app, { type: 'feature', title: 'Feature A', status: 'active' })
      await createNode(app, { type: 'decision', title: 'Decision A', status: 'active' })
      await createNode(app, { type: 'incident', title: 'Incident A', status: 'active' })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/context-pack',
        payload: { taskId: 'task-001', changedFiles: [], riskLevel: 'LOW' },
      })
      expect(res.statusCode).toBe(200)
      const pack = parseBody<KGContextPack>(res.body)
      expect(pack.taskId).toBe('task-001')
      expect(pack.executionLevel).toBe(1)
      expect(pack.entries.every((e) => e.type === 'feature')).toBe(true)
    })
  })

  // 2. changedFiles に relatedFiles が一致するノードが priority 高くなる
  it('changedFiles に relatedFiles が一致するノードが priority 高くなる', async () => {
    await withApp(async (app) => {
      await createNode(app, { type: 'feature', title: 'Feature Match', status: 'active', relatedFiles: ['src/foo.ts'] })
      await createNode(app, { type: 'feature', title: 'Feature NoMatch', status: 'active', relatedFiles: [] })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/context-pack',
        payload: { taskId: 'task-002', changedFiles: ['src/foo.ts'], riskLevel: 'LOW' },
      })
      expect(res.statusCode).toBe(200)
      const pack = parseBody<KGContextPack>(res.body)
      const matchEntry = pack.entries.find((e) => e.title === 'Feature Match')
      const noMatchEntry = pack.entries.find((e) => e.title === 'Feature NoMatch')
      expect(matchEntry).toBeDefined()
      expect(noMatchEntry).toBeDefined()
      expect(matchEntry!.priority).toBeGreaterThan(noMatchEntry!.priority)
    })
  })

  // 3. HIGH riskLevel → executionLevel=3, incident ノードも含まれる
  it('HIGH riskLevel → executionLevel=3, incident ノードも含まれる', async () => {
    await withApp(async (app) => {
      await createNode(app, { type: 'feature', title: 'Feature A', status: 'active' })
      await createNode(app, { type: 'incident', title: 'Incident A', status: 'active' })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/context-pack',
        payload: { taskId: 'task-003', changedFiles: [], riskLevel: 'HIGH' },
      })
      expect(res.statusCode).toBe(200)
      const pack = parseBody<KGContextPack>(res.body)
      expect(pack.executionLevel).toBe(3)
      expect(pack.entries.some((e) => e.type === 'incident')).toBe(true)
    })
  })

  // 4. maxEntries=2 で truncatedCount が正しい
  it('maxEntries=2 で truncatedCount が正しい', async () => {
    await withApp(async (app) => {
      await createNode(app, { type: 'feature', title: 'Feature A', status: 'active' })
      await createNode(app, { type: 'feature', title: 'Feature B', status: 'active' })
      await createNode(app, { type: 'feature', title: 'Feature C', status: 'active' })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/context-pack',
        payload: { taskId: 'task-004', changedFiles: [], riskLevel: 'LOW', maxEntries: 2 },
      })
      expect(res.statusCode).toBe(200)
      const pack = parseBody<KGContextPack>(res.body)
      expect(pack.entries).toHaveLength(2)
      expect(pack.truncatedCount).toBe(1)
    })
  })

  // 5. ノードが0件でも空の entries=[] が返る
  it('ノードが0件でも空の entries=[] が返る', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/kg/context-pack',
        payload: { taskId: 'task-005', changedFiles: [], riskLevel: 'LOW' },
      })
      expect(res.statusCode).toBe(200)
      const pack = parseBody<KGContextPack>(res.body)
      expect(pack.entries).toEqual([])
      expect(pack.truncatedCount).toBe(0)
      expect(pack.generatedAt).toBeTruthy()
    })
  })

  // 6. taskId が空文字列 → 400
  it('taskId が空文字列 → 400', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/kg/context-pack',
        payload: { taskId: '', changedFiles: [], riskLevel: 'LOW' },
      })
      expect(res.statusCode).toBe(400)
    })
  })
})

// ────────────────────────────────────────────────────────────
// Impact Analyzer テスト
// ────────────────────────────────────────────────────────────

describe('POST /kg/impact', () => {
  // 1. changedFiles が relatedFiles に一致するノードが impactedFeatures に含まれる
  it('changedFiles が relatedFiles に一致するノードが impactedFeatures に含まれる', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Feature Match', relatedFiles: ['src/foo.ts'] })
      await createNode(app, { title: 'Feature NoMatch', relatedFiles: ['src/bar.ts'] })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: ['src/foo.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const result = parseBody<ImpactAnalysisResult>(res.body)
      expect(result.impactedFeatures.some((n) => n.id === nodeA.id)).toBe(true)
      expect(result.impactedFeatures.every((n) => n.title !== 'Feature NoMatch')).toBe(true)
    })
  })

  // 2. CRITICAL ノードが含まれると riskLevel='CRITICAL'
  it('CRITICAL ノードが含まれると riskLevel="CRITICAL"', async () => {
    await withApp(async (app) => {
      await createNode(app, { title: 'Critical Feature', risk: 'CRITICAL', relatedFiles: ['src/critical.ts'] })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: ['src/critical.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const result = parseBody<ImpactAnalysisResult>(res.body)
      expect(result.riskLevel).toBe('CRITICAL')
      expect(result.riskReasons.some((r) => r.includes('CRITICAL'))).toBe(true)
    })
  })

  // 3. HIGH ノードのみなら riskLevel='HIGH'
  it('HIGH ノードのみなら riskLevel="HIGH"', async () => {
    await withApp(async (app) => {
      await createNode(app, { title: 'High Feature', risk: 'HIGH', relatedFiles: ['src/high.ts'] })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: ['src/high.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const result = parseBody<ImpactAnalysisResult>(res.body)
      expect(result.riskLevel).toBe('HIGH')
      expect(result.riskReasons.some((r) => r.includes('HIGH'))).toBe(true)
    })
  })

  // 4. 一致するノードが0件でも 200 + riskLevel='LOW' + impactedFeatures=[]
  it('一致するノードが0件でも 200 + riskLevel="LOW" + impactedFeatures=[]', async () => {
    await withApp(async (app) => {
      await createNode(app, { title: 'Unrelated', relatedFiles: ['src/other.ts'] })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: ['src/nomatch.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const result = parseBody<ImpactAnalysisResult>(res.body)
      expect(result.riskLevel).toBe('LOW')
      expect(result.impactedFeatures).toEqual([])
    })
  })

  // 5. targetFeatureId を指定すると impacts エッジ先のノードも含まれる
  it('targetFeatureId を指定すると impacts エッジ先のノードも含まれる', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Target Feature', relatedFiles: ['src/target.ts'] })
      const nodeB = await createNode(app, { title: 'Impacted Feature', relatedFiles: [] })

      // A → B (impacts)
      await app.inject({
        method: 'POST',
        url: '/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'impacts' },
      })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: ['src/target.ts'], targetFeatureId: nodeA.id },
      })
      expect(res.statusCode).toBe(200)
      const result = parseBody<ImpactAnalysisResult>(res.body)
      expect(result.impactedFeatures.some((n) => n.id === nodeB.id)).toBe(true)
    })
  })

  // 6. impactedTests が .test. を含むファイルのみ返す
  it('impactedTests が .test. を含むファイルのみ返す', async () => {
    await withApp(async (app) => {
      await createNode(app, {
        title: 'Feature With Tests',
        relatedFiles: ['src/foo.ts', 'src/foo.test.ts', 'src/bar.spec.ts'],
      })

      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: ['src/foo.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const result = parseBody<ImpactAnalysisResult>(res.body)
      expect(result.impactedTests).toContain('src/foo.test.ts')
      expect(result.impactedTests.every((f) => f.includes('.test.'))).toBe(true)
    })
  })

  // 7. changedFiles が空配列 → 400
  it('changedFiles が空配列 → 400', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/kg/impact',
        payload: { changedFiles: [] },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  // 8. 部分一致ではなく完全一致でファイルをマッチする
  it('POST /kg/impact — 部分一致ではなく完全一致でファイルをマッチする', async () => {
    await withApp(async (app) => {
      // セットアップ: relatedFiles が "src/auth.ts.bak" のノードを作成
      const nodeRes = await app.inject({
        method: 'POST', url: '/kg/nodes',
        payload: { type: 'feature', title: '部分一致テスト用ノード', relatedFiles: ['src/auth.ts.bak'] },
      })
      const nodeId = JSON.parse(nodeRes.body).id

      const res = await app.inject({
        method: 'POST', url: '/kg/impact',
        payload: { changedFiles: ['src/auth.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      // "src/auth.ts" と "src/auth.ts.bak" は別ファイル
      expect(body.impactedFeatures.every((n: any) => n.id !== nodeId)).toBe(true)

      // クリーンアップ
      await app.inject({ method: 'DELETE', url: `/kg/nodes/${nodeId}` })
    })
  })

  // 9. 完全一致ならマッチする
  it('POST /kg/impact — 完全一致ならマッチする', async () => {
    await withApp(async (app) => {
      const nodeRes = await app.inject({
        method: 'POST', url: '/kg/nodes',
        payload: { type: 'feature', title: '完全一致テスト用ノード', relatedFiles: ['src/auth.ts'] },
      })
      const nodeId = JSON.parse(nodeRes.body).id

      const res = await app.inject({
        method: 'POST', url: '/kg/impact',
        payload: { changedFiles: ['src/auth.ts'] },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.impactedFeatures.some((n: any) => n.id === nodeId)).toBe(true)

      // クリーンアップ
      await app.inject({ method: 'DELETE', url: `/kg/nodes/${nodeId}` })
    })
  })
})

// ────────────────────────────────────────────────────────────
// Decision Cache テスト
// ────────────────────────────────────────────────────────────

describe('Decision Cache', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('POST /kg/decisions — 登録して201、id が dc- で始まる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/kg/decisions',
      payload: {
        title: 'CONTROL_ROOT は環境変数優先',
        keywords: ['CONTROL_ROOT', 'env', 'runner'],
        decision: '環境変数 CONTROL_ROOT が未指定の場合は /workspace/control を使う',
        rationale: 'コンテナ外から制御ルートを差し替え可能にするため',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toMatch(/^dc-\d{8}-/)
    decisionId = body.id
  })

  it('GET /kg/decisions/:id — 単体取得', async () => {
    const res = await app.inject({ method: 'GET', url: `/kg/decisions/${decisionId}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('CONTROL_ROOT は環境変数優先')
  })

  it('PATCH /kg/decisions/:id — status を superseded に更新', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/kg/decisions/${decisionId}`,
      payload: { status: 'superseded' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('superseded')
  })

  it('DELETE /kg/decisions/:id — 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/kg/decisions/${decisionId}` })
    expect(res.statusCode).toBe(204)
  })
})

// ────────────────────────────────────────────────────────────
// Incident DB テスト
// ────────────────────────────────────────────────────────────

describe('Incident DB', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('POST /kg/incidents — 登録して201、id が inc- で始まる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/kg/incidents',
      payload: {
        title: 'AV-001 Control Layer 迂回',
        keywords: ['control', 'bypass', 'runner', '直接呼び出す'],
        description: 'AI が approval gate をスキップして直接 runner を呼び出した',
        rootCause: 'gateProcessor のチェックが不完全だった',
        prevention: 'すべての runner 呼び出しは gate を経由すること',
        severity: 'critical',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toMatch(/^inc-\d{8}-/)
    incidentId = body.id
  })

  it('GET /kg/incidents?severity=critical — severity フィルタ', async () => {
    const res = await app.inject({ method: 'GET', url: '/kg/incidents?severity=critical' })
    expect(res.statusCode).toBe(200)
    const list = JSON.parse(res.body)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((i: any) => i.severity === 'critical')).toBe(true)
  })

  it('DELETE /kg/incidents/:id — 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/kg/incidents/${incidentId}` })
    expect(res.statusCode).toBe(204)
  })
})

// ────────────────────────────────────────────────────────────
// Risk Lookup テスト
// ────────────────────────────────────────────────────────────

describe('POST /kg/risk-lookup', () => {
  let app: FastifyInstance
  let dcId: string
  let incId: string

  beforeAll(async () => {
    app = await buildApp()

    const dc = await app.inject({
      method: 'POST', url: '/kg/decisions',
      payload: { title: 'Auth token 保存先', keywords: ['auth', 'token', 'storage'], decision: 'トークンは DB に保存しない', rationale: 'セキュリティ要件' },
    })
    dcId = JSON.parse(dc.body).id

    const inc = await app.inject({
      method: 'POST', url: '/kg/incidents',
      payload: { title: 'Token 漏洩事例', keywords: ['auth', 'token', 'leak'], description: 'トークンがログに出力された', rootCause: 'debug ログが本番で有効だった', prevention: 'debug ログは本番無効', severity: 'high' },
    })
    incId = JSON.parse(inc.body).id
  })

  afterAll(async () => {
    await app.inject({ method: 'DELETE', url: `/kg/decisions/${dcId}` })
    await app.inject({ method: 'DELETE', url: `/kg/incidents/${incId}` })
    await app.close()
  })

  it('keywords にマッチする Decision と Incident が返る', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/risk-lookup',
      payload: { keywords: ['auth', 'token'], riskLevel: 'HIGH' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.decisions.some((d: any) => d.id === dcId)).toBe(true)
    expect(body.incidents.some((i: any) => i.id === incId)).toBe(true)
    expect(body.matchedKeywords.length).toBeGreaterThan(0)
  })

  it('マッチなしでも 200 + 空配列', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/risk-lookup',
      payload: { keywords: ['xxxxunmatched'], riskLevel: 'CRITICAL' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.decisions).toEqual([])
    expect(body.incidents).toEqual([])
  })

  it('riskLevel=LOW → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/risk-lookup',
      payload: { keywords: ['auth'], riskLevel: 'LOW' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ────────────────────────────────────────────────────────────
// Pattern Library テスト
// ────────────────────────────────────────────────────────────

describe('Pattern Library', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('POST /kg/patterns — 登録して201、id が pat- で始まる', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/patterns',
      payload: {
        title: 'Permission Grant 作成パターン',
        keywords: ['permission', 'grant', 'approval'],
        description: 'Permission Grant を作る時の標準手順',
        steps: ['Approval Record を作成', 'Permission Guard を追加', 'Expiration Handling を追加', 'Audit Log を追加'],
        featureType: 'Permission Grant',
        trigger: 'high_risk',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toMatch(/^pat-\d{8}-/)
    expect(body.usageCount).toBe(0)
    patternId = body.id
  })

  it('GET /kg/patterns?featureType=Permission Grant — featureType フィルタ', async () => {
    const res = await app.inject({ method: 'GET', url: '/kg/patterns?featureType=Permission%20Grant' })
    expect(res.statusCode).toBe(200)
    const list = JSON.parse(res.body)
    expect(list.some((p: any) => p.id === patternId)).toBe(true)
  })

  it('POST /kg/patterns/:id/use — usage_count が増える', async () => {
    const res = await app.inject({ method: 'POST', url: `/kg/patterns/${patternId}/use` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).usageCount).toBe(1)
  })

  it('PATCH /kg/patterns/:id — title 更新', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/kg/patterns/${patternId}`,
      payload: { title: 'Permission Grant 作成パターン v2' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('Permission Grant 作成パターン v2')
  })

  it('DELETE /kg/patterns/:id — 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/kg/patterns/${patternId}` })
    expect(res.statusCode).toBe(204)
  })

  it('POST /kg/patterns — usageCount をクライアントが指定しても 0 に固定される', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/kg/patterns',
      payload: {
        title: 'usageCount 指定テスト',
        description: 'usageCount 上書きテスト用',
        steps: ['step1'],
        featureType: 'Test',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).usageCount).toBe(0)
    // クリーンアップ
    const id = JSON.parse(res.body).id
    await app.inject({ method: 'DELETE', url: `/kg/patterns/${id}` })
  })
})

describe('POST /kg/pattern-lookup', () => {
  let app: FastifyInstance
  let pid: string

  beforeAll(async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/kg/patterns',
      payload: { title: 'Storage CRUD パターン', keywords: ['storage', 'crud', 'sqlite'], description: 'Storage CRUD 実装手順', steps: ['interface 定義', 'schema 追加', 'sqlite 実装', 'テスト'], featureType: 'Storage', trigger: 'same_feature_type' },
    })
    pid = JSON.parse(res.body).id
  })

  afterAll(async () => {
    await app.inject({ method: 'DELETE', url: `/kg/patterns/${pid}` })
    await app.close()
  })

  it('keywords でパターンが返る', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/pattern-lookup',
      payload: { keywords: ['storage', 'crud'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.patterns.some((p: any) => p.id === pid)).toBe(true)
    expect(body.matchedKeywords.length).toBeGreaterThan(0)
  })

  it('featureType でパターンが返る', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/pattern-lookup',
      payload: { featureType: 'Storage' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).patterns.some((p: any) => p.id === pid)).toBe(true)
  })

  it('マッチなしでも 200 + 空配列', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/pattern-lookup',
      payload: { keywords: ['xxxxunmatched'] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).patterns).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────
// Feature DNA テスト
// ────────────────────────────────────────────────────────────

describe('Feature DNA', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    // Fix 2 対応: 実在する KGNode を先に作成
    const nodeRes = await app.inject({
      method: 'POST', url: '/kg/nodes',
      payload: { type: 'feature', title: 'Feature DNA テスト用ノード' },
    })
    dnaNodeId = JSON.parse(nodeRes.body).id
  })

  afterAll(async () => {
    await app.inject({ method: 'DELETE', url: `/kg/nodes/${dnaNodeId}` })
    await app.close()
  })

  it('POST /kg/feature-dna — 201', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/feature-dna',
      payload: { nodeId: dnaNodeId, reason: 'Approval Gate の一回限り消費を保証するため', relatedTaskIds: ['task-001'] },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).nodeId).toBe(dnaNodeId)
  })

  it('POST /kg/feature-dna (同nodeId) — 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/feature-dna',
      payload: { nodeId: dnaNodeId, reason: 'duplicate' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('POST /kg/feature-dna/:nodeId/history — 履歴追記', async () => {
    const res = await app.inject({
      method: 'POST', url: `/kg/feature-dna/${dnaNodeId}/history`,
      payload: { note: 'CONSUMED 状態を追加' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).history.length).toBe(1)
  })

  it('PATCH /kg/feature-dna/:nodeId — reason 更新', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/kg/feature-dna/${dnaNodeId}`,
      payload: { reason: '更新後の理由' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).reason).toBe('更新後の理由')
  })

  it('DELETE /kg/feature-dna/:nodeId — 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/kg/feature-dna/${dnaNodeId}` })
    expect(res.statusCode).toBe(204)
  })

  it('POST /kg/feature-dna — 存在しない nodeId では 400 になる', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/feature-dna',
      payload: { nodeId: 'kg-99999999-nonexistent', reason: '存在しないノード' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/KGNode not found/)
  })

  it('POST /kg/feature-dna — 実在する KGNode なら成功する', async () => {
    // まず KGNode を作成
    const nodeRes = await app.inject({
      method: 'POST', url: '/kg/nodes',
      payload: { type: 'feature', title: 'FeatureDNA 存在チェックテスト用ノード' },
    })
    const validNodeId = JSON.parse(nodeRes.body).id

    // DNA を作成
    const res = await app.inject({
      method: 'POST', url: '/kg/feature-dna',
      payload: { nodeId: validNodeId, reason: '実在ノードへのDNA登録テスト' },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).nodeId).toBe(validNodeId)

    // クリーンアップ
    await app.inject({ method: 'DELETE', url: `/kg/feature-dna/${validNodeId}` })
    await app.inject({ method: 'DELETE', url: `/kg/nodes/${validNodeId}` })
  })
})

describe('Node削除時の orphan edge 対策', () => {
  it('Node削除時に接続 edge も削除される', async () => {
    await withApp(async (app) => {
      // Node A, Node B を作成
      const resA = await app.inject({
        method: 'POST', url: '/kg/nodes',
        payload: { type: 'feature', title: 'Node A (orphan test)' },
      })
      const resB = await app.inject({
        method: 'POST', url: '/kg/nodes',
        payload: { type: 'feature', title: 'Node B (orphan test)' },
      })
      const nodeAId = JSON.parse(resA.body).id
      const nodeBId = JSON.parse(resB.body).id

      // A → B の edge を作成
      const edgeRes = await app.inject({
        method: 'POST', url: '/kg/edges',
        payload: { fromNodeId: nodeAId, toNodeId: nodeBId, edgeType: 'depends_on' },
      })
      const edgeId = JSON.parse(edgeRes.body).id

      // Node A を削除
      await app.inject({ method: 'DELETE', url: `/kg/nodes/${nodeAId}` })

      // A に関連する edge が削除されていること
      const edgeCheck = await app.inject({ method: 'GET', url: `/kg/edges/${edgeId}` })
      expect(edgeCheck.statusCode).toBe(404)

      // Node B は残っていること
      const nodeBCheck = await app.inject({ method: 'GET', url: `/kg/nodes/${nodeBId}` })
      expect(nodeBCheck.statusCode).toBe(200)

      // クリーンアップ
      await app.inject({ method: 'DELETE', url: `/kg/nodes/${nodeBId}` })
    })
  })

  it('Node B 削除時も、A→B edge が削除される', async () => {
    await withApp(async (app) => {
      // Node A, Node B を作成
      const resA = await app.inject({
        method: 'POST', url: '/kg/nodes',
        payload: { type: 'feature', title: 'Node A (to-node orphan test)' },
      })
      const resB = await app.inject({
        method: 'POST', url: '/kg/nodes',
        payload: { type: 'feature', title: 'Node B (to-node orphan test)' },
      })
      const nodeAId = JSON.parse(resA.body).id
      const nodeBId = JSON.parse(resB.body).id

      // A → B の edge を作成
      const edgeRes = await app.inject({
        method: 'POST', url: '/kg/edges',
        payload: { fromNodeId: nodeAId, toNodeId: nodeBId, edgeType: 'blocks' },
      })
      const edgeId = JSON.parse(edgeRes.body).id

      // Node B を削除（to_node_id 側）
      await app.inject({ method: 'DELETE', url: `/kg/nodes/${nodeBId}` })

      // edge が削除されていること
      const edgeCheck = await app.inject({ method: 'GET', url: `/kg/edges/${edgeId}` })
      expect(edgeCheck.statusCode).toBe(404)

      // クリーンアップ
      await app.inject({ method: 'DELETE', url: `/kg/nodes/${nodeAId}` })
    })
  })
})

describe('Self Reflection', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('POST /kg/reflections — 201、id が ref- で始まる', async () => {
    const res = await app.inject({
      method: 'POST', url: '/kg/reflections',
      payload: {
        trigger: 'failure',
        summary: 'Codex が index.ts を直接編集しようとした',
        rootCause: 'AI編集禁止ファイルの認識不足',
        improvement: '実装前に禁止ファイルリストを確認する',
        relatedNodeIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.id).toMatch(/^ref-\d{8}-/)
    reflectionId = body.id
  })

  it('GET /kg/reflections?trigger=failure — trigger フィルタ', async () => {
    const res = await app.inject({ method: 'GET', url: '/kg/reflections?trigger=failure' })
    expect(res.statusCode).toBe(200)
    const list = JSON.parse(res.body)
    expect(list.some((r: any) => r.id === reflectionId)).toBe(true)
  })

  it('GET /kg/reflections/:id — 単体取得', async () => {
    const res = await app.inject({ method: 'GET', url: `/kg/reflections/${reflectionId}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).trigger).toBe('failure')
  })

  it('DELETE /kg/reflections/:id — 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/kg/reflections/${reflectionId}` })
    expect(res.statusCode).toBe(204)
  })
})

describe('GET /kg/health-score', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('200 でスコアオブジェクトが返る', async () => {
    const res = await app.inject({ method: 'GET', url: '/kg/health-score' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(typeof body.progress).toBe('number')
    expect(typeof body.safety).toBe('number')
    expect(typeof body.contextQuality).toBe('number')
    expect(typeof body.memoryHealth).toBe('number')
    expect(typeof body.openRisks).toBe('number')
    expect(typeof body.blockedTasks).toBe('number')
    expect(body.approvalWaiting).toBeNull()
    expect(body.approvalWaitingAvailable).toBe(false)
    expect(body.calculatedAt).toBeTruthy()
  })

  it('progress は 0-100 の範囲', async () => {
    const res = await app.inject({ method: 'GET', url: '/kg/health-score' })
    const body = JSON.parse(res.body)
    expect(body.progress).toBeGreaterThanOrEqual(0)
    expect(body.progress).toBeLessThanOrEqual(100)
  })
})
