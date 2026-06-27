import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import type { KGNode, KGEdge } from '@ai-team/shared'

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
    url: '/api/kg/nodes',
    payload: { ...BASE_NODE_PAYLOAD, ...overrides },
  })
  expect(res.statusCode).toBe(201)
  return parseBody<KGNode>(res.body)
}

// ────────────────────────────────────────────────────────────
// Node テスト
// ────────────────────────────────────────────────────────────

describe('Knowledge Graph Nodes', () => {
  // 1. POST /api/kg/nodes — feature ノード作成 → 201 + id が kg- で始まる
  it('POST /api/kg/nodes — feature ノード作成 → 201 + id が kg- で始まる', async () => {
    await withApp(async (app) => {
      const node = await createNode(app)
      expect(node.id).toMatch(/^kg-/)
      expect(node.type).toBe('feature')
      expect(node.title).toBe('テスト機能')
    })
  })

  // 2. POST /api/kg/nodes — phase 未指定 → status='inbox'
  it('POST /api/kg/nodes — phase 未指定 → status="inbox"', async () => {
    await withApp(async (app) => {
      const node = await createNode(app)
      expect(node.phase).toBeUndefined()
      expect(node.status).toBe('inbox')
    })
  })

  // 3. GET /api/kg/nodes?type=feature — type フィルタで絞り込める
  it('GET /api/kg/nodes?type=feature — type フィルタで絞り込める', async () => {
    await withApp(async (app) => {
      await createNode(app, { type: 'feature', title: 'Feature A' })
      await createNode(app, { type: 'phase', title: 'Phase 1' })

      const res = await app.inject({ method: 'GET', url: '/api/kg/nodes?type=feature' })
      expect(res.statusCode).toBe(200)
      const nodes = parseBody<KGNode[]>(res.body)
      expect(nodes.every((n) => n.type === 'feature')).toBe(true)
      expect(nodes.length).toBeGreaterThanOrEqual(1)
    })
  })

  // 4. GET /api/kg/nodes?phase=phase-1 — phase フィルタで絞り込める
  it('GET /api/kg/nodes?phase=phase-1 — phase フィルタで絞り込める', async () => {
    await withApp(async (app) => {
      await createNode(app, { phase: 'phase-1', title: 'In Phase 1' })
      await createNode(app, { phase: 'phase-2', title: 'In Phase 2' })

      const res = await app.inject({ method: 'GET', url: '/api/kg/nodes?phase=phase-1' })
      expect(res.statusCode).toBe(200)
      const nodes = parseBody<KGNode[]>(res.body)
      expect(nodes.every((n) => n.phase === 'phase-1')).toBe(true)
      expect(nodes.length).toBeGreaterThanOrEqual(1)
    })
  })

  // 5. GET /api/kg/nodes/:id — 単体取得
  it('GET /api/kg/nodes/:id — 単体取得', async () => {
    await withApp(async (app) => {
      const created = await createNode(app)
      const res = await app.inject({ method: 'GET', url: `/api/kg/nodes/${created.id}` })
      expect(res.statusCode).toBe(200)
      const node = parseBody<KGNode>(res.body)
      expect(node.id).toBe(created.id)
      expect(node.title).toBe(created.title)
    })
  })

  // 6. GET /api/kg/nodes/:id — 存在しない ID → 404
  it('GET /api/kg/nodes/:id — 存在しない ID → 404', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/kg/nodes/nonexistent-id' })
      expect(res.statusCode).toBe(404)
    })
  })

  // 7. PATCH /api/kg/nodes/:id — title 更新 → updatedAt が変わる
  it('PATCH /api/kg/nodes/:id — title 更新 → updatedAt が変わる', async () => {
    await withApp(async (app) => {
      const created = await createNode(app)
      // 時間差を確保
      await new Promise((resolve) => setTimeout(resolve, 10))

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/kg/nodes/${created.id}`,
        payload: { title: '更新後タイトル' },
      })
      expect(res.statusCode).toBe(200)
      const updated = parseBody<KGNode>(res.body)
      expect(updated.title).toBe('更新後タイトル')
      expect(updated.updatedAt).not.toBe(created.updatedAt)
    })
  })

  // 8. DELETE /api/kg/nodes/:id → 204
  it('DELETE /api/kg/nodes/:id → 204', async () => {
    await withApp(async (app) => {
      const created = await createNode(app)
      const res = await app.inject({ method: 'DELETE', url: `/api/kg/nodes/${created.id}` })
      expect(res.statusCode).toBe(204)

      // 削除後は 404
      const getRes = await app.inject({ method: 'GET', url: `/api/kg/nodes/${created.id}` })
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
      const res = await app.inject({ method: 'GET', url: `/api/kg/nodes/${created.id}` })
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
  // 10. POST /api/kg/edges — depends_on エッジ作成 → 201 + id が kge- で始まる
  it('POST /api/kg/edges — depends_on エッジ作成 → 201 + id が kge- で始まる', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })

      const res = await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
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

  // 11. GET /api/kg/edges?fromNodeId=xxx — fromNodeId フィルタ
  it('GET /api/kg/edges?fromNodeId=xxx — fromNodeId フィルタ', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })
      const nodeC = await createNode(app, { title: 'Node C' })

      await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeC.id, toNodeId: nodeB.id, edgeType: 'blocks' },
      })

      const res = await app.inject({ method: 'GET', url: `/api/kg/edges?fromNodeId=${nodeA.id}` })
      expect(res.statusCode).toBe(200)
      const edges = parseBody<KGEdge[]>(res.body)
      expect(edges.every((e) => e.fromNodeId === nodeA.id)).toBe(true)
      expect(edges.length).toBe(1)
    })
  })

  // 12. GET /api/kg/edges?type=depends_on — type フィルタ
  it('GET /api/kg/edges?type=depends_on — type フィルタ', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })
      const nodeC = await createNode(app, { title: 'Node C' })

      await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeC.id, edgeType: 'blocks' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/kg/edges?type=depends_on' })
      expect(res.statusCode).toBe(200)
      const edges = parseBody<KGEdge[]>(res.body)
      expect(edges.every((e) => e.edgeType === 'depends_on')).toBe(true)
      expect(edges.length).toBeGreaterThanOrEqual(1)
    })
  })

  // 13. DELETE /api/kg/edges/:id → 204
  it('DELETE /api/kg/edges/:id → 204', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'related_to' },
      })
      const edge = parseBody<KGEdge>(createRes.body)

      const deleteRes = await app.inject({ method: 'DELETE', url: `/api/kg/edges/${edge.id}` })
      expect(deleteRes.statusCode).toBe(204)

      const getRes = await app.inject({ method: 'GET', url: `/api/kg/edges/${edge.id}` })
      expect(getRes.statusCode).toBe(404)
    })
  })

  // 14. 存在しない fromNodeId / toNodeId でエッジ作成 → 400
  it('存在しない fromNodeId でエッジ作成 → 400', async () => {
    await withApp(async (app) => {
      const nodeB = await createNode(app, { title: 'Node B' })

      const res = await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
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
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: 'nonexistent-node', edgeType: 'depends_on' },
      })
      expect(res.statusCode).toBe(400)
    })
  })
})

// ────────────────────────────────────────────────────────────
// Timeline Map テスト
// ────────────────────────────────────────────────────────────

import type { TimelineMap } from '@ai-team/shared'

describe('GET /api/kg/timeline', () => {
  // 1. Phase ノードが1つ、feature ノードが2つ → phases[0].features が2つ返る
  it('Phase 1つ + feature 2つ → phases[0].features が2つ返る', async () => {
    await withApp(async (app) => {
      const phase = await createNode(app, { type: 'phase', title: 'Phase 1', status: 'active' })
      await createNode(app, { type: 'feature', title: 'Feature A', phase: phase.id, status: 'active' })
      await createNode(app, { type: 'feature', title: 'Feature B', phase: phase.id, status: 'active' })

      const res = await app.inject({ method: 'GET', url: '/api/kg/timeline' })
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

      const res = await app.inject({ method: 'GET', url: '/api/kg/timeline' })
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

      const res = await app.inject({ method: 'GET', url: '/api/kg/timeline' })
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

      const res = await app.inject({ method: 'GET', url: '/api/kg/timeline' })
      const timeline = parseBody<TimelineMap>(res.body)
      const stats = timeline.phases[0].stats
      expect(stats.highRiskCount).toBe(1)
      expect(stats.criticalRiskCount).toBe(1)
    })
  })

  // 5. ノードが0件でも空の timeline が返る
  it('ノードが0件でも空の timeline が返る（phases=[], inbox=[]）', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/kg/timeline' })
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

describe('GET /api/kg/nodes/:id/detail', () => {
  // 6. outgoingEdges / incomingEdges が正しく返る
  it('outgoingEdges / incomingEdges が正しく返る', async () => {
    await withApp(async (app) => {
      const nodeA = await createNode(app, { title: 'Node A' })
      const nodeB = await createNode(app, { title: 'Node B' })
      const nodeC = await createNode(app, { title: 'Node C' })

      // A → B (depends_on)
      await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeA.id, toNodeId: nodeB.id, edgeType: 'depends_on' },
      })
      // C → A (blocks)
      await app.inject({
        method: 'POST',
        url: '/api/kg/edges',
        payload: { fromNodeId: nodeC.id, toNodeId: nodeA.id, edgeType: 'blocks' },
      })

      const res = await app.inject({ method: 'GET', url: `/api/kg/nodes/${nodeA.id}/detail` })
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
      const res = await app.inject({ method: 'GET', url: '/api/kg/nodes/nonexistent-id/detail' })
      expect(res.statusCode).toBe(404)
    })
  })
})
